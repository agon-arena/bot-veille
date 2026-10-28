"use strict";
// Write-behind persistence envelope for the DATAtourisme persister (not a second deduplication
// engine). persistSortirIngestion keeps deciding each occurrence SEQUENTIALLY on its own
// in-memory overlay (candidate index, activity and provenance maps); this envelope only changes
// WHEN its writes reach the store. Deferred writes return synthetic results honouring the store
// contracts (client-generated ids), then are flushed in grouped phases at the first read or
// non-deferrable call (read barrier), in program order per row:
//   1 staging activities (stale, final content)   2 REVIEW/MATCH decisions
//   3 new provenances   4 patches of known provenances   5 external IDs
//   6 patches of pre-existing activities   7 status flip of staging rows (publication barrier)
// A failed flush poisons the persist call: no further business write, the call ends partial,
// nothing is fingerprinted or acknowledged, and replay converges (known-provenance path).
const { randomUUID } = require("crypto");

const DEFERRED = new Set(["createActivity", "updateActivity", "insertDedupDecision", "createProvenanceIdempotent", "updateProvenance", "upsertExternalIds"]);
const DEFAULT_ROWS_PER_REQUEST = 100;
const DEFAULT_IDS_PER_PATCH = 100; // measured URL bound for in.(uuid,...) filters

class WriteBehindConflictError extends Error {}

function createWriteBehindStore(inner, { rowsPerRequest = DEFAULT_ROWS_PER_REQUEST, idsPerPatch = DEFAULT_IDS_PER_PATCH, onFlushRequest = null, failAt = null } = {}) {
  if (!inner) throw new Error("store est obligatoire");
  if (!(rowsPerRequest >= 1 && rowsPerRequest <= 200) || !(idsPerPatch >= 1 && idsPerPatch <= 100)) throw new Error("Tailles de lots hors bornes validées");
  let queue, poisoned = null;
  const stats = { flushes: 0, requests: {}, rows: {}, maxRows: 0, maxBodyBytes: 0, barriers: 0, conflicts: 0, poisoned: 0 };
  const empty = () => ({ created: new Map(), status: new Map(), updates: new Map(), decisions: [], decisionKeys: new Set(), provenances: new Map(), provPatches: new Map(), ext: new Map() });
  queue = empty();
  const chunks = (rows, n) => Array.from({ length: Math.ceil(rows.length / n) }, (_, i) => rows.slice(i * n, (i + 1) * n));
  function request(phase, rows) {
    stats.requests[phase] = (stats.requests[phase] || 0) + 1; stats.rows[phase] = (stats.rows[phase] || 0) + rows.length;
    stats.maxRows = Math.max(stats.maxRows, rows.length); stats.maxBodyBytes = Math.max(stats.maxBodyBytes, Buffer.byteLength(JSON.stringify(rows)));
    if (onFlushRequest) onFlushRequest(phase, rows.length);
    if (failAt === phase) { failAt = null; throw new Error(`panne injectée (test) phase ${phase}`); }
  }
  const has = name => typeof inner[name] === "function";
  const isEmpty = q => !q.created.size && !q.updates.size && !q.decisions.length && !q.provenances.size && !q.provPatches.size && !q.ext.size && !q.status.size;

  async function flushPhases(q) {
    // 1 — staging rows carry their final content but stay stale: never publishable, never coverage.
    for (const part of chunks([...q.created.values()].map(row => ({ ...row, record_status: "stale" })), rowsPerRequest)) {
      request("1_activities", part);
      if (has("createActivitiesBatch")) await inner.createActivitiesBatch(part); else for (const row of part) await inner.createActivity(row);
    }
    // 2 — decisions: duplicates of (pair, algorithm_version) stay ignored exactly as today.
    for (const part of chunks(q.decisions, rowsPerRequest)) {
      request("2_decisions", part);
      if (has("insertDedupDecisionsBatch")) await inner.insertDedupDecisionsBatch(part); else for (const row of part) await inner.insertDedupDecision(row);
    }
    // 3 — new provenances. Any row stored with another id/activity means a concurrent writer or a
    // decision invalidated after the fact: fail closed, the call is replayed (no guessed decision).
    for (const part of chunks([...q.provenances.values()], rowsPerRequest)) {
      request("3_provenances", part);
      let saved; if (has("createProvenancesBatch")) saved = await inner.createProvenancesBatch(part); else { saved = []; for (const row of part) saved.push(await inner.createProvenanceIdempotent(row)); }
      const byKey = new Map(saved.map(p => [p.id, p]));
      for (const row of part) { const s = byKey.get(row.id); if (!s || s.activity_id !== row.activity_id) { stats.conflicts++; throw new WriteBehindConflictError("Conflit de provenance au flush groupé : tranche à rejouer"); } }
    }
    // 4 — patches of known provenances (distinct payloads: one PATCH each, as today).
    for (const [id, patch] of q.provPatches) { request("4_provenance_patch", [patch]); await inner.updateProvenance(id, patch); }
    // 5 — external IDs, ON CONFLICT DO NOTHING (idempotent as today).
    for (const part of chunks([...q.ext.values()], rowsPerRequest)) {
      request("5_external_ids", part);
      if (has("upsertExternalIdsBatch")) await inner.upsertExternalIdsBatch(part);
      else { const by = new Map(); for (const e of part) { const k = `${e.activity_id}\0${e.source_id}`; if (!by.has(k)) by.set(k, []); by.get(k).push({ system: e.system, value: e.value }); } for (const [k, ids] of by) { const [a, s] = k.split("\0"); await inner.upsertExternalIds(a, s, ids); } }
    }
    // 6 — pre-existing activities (MATCH merges, reactivations): merged patch per row, program order.
    for (const [id, patch] of q.updates) { request("6_activity_patch", [patch]); await inner.updateActivity(id, patch); }
    // 7 — publication barrier: staging rows leave 'stale' only now, grouped by final status.
    const byStatus = new Map();
    for (const [id, s] of q.status) { const key = `${s.record_status}\0${s.updated_at}`; if (!byStatus.has(key)) byStatus.set(key, { patch: { record_status: s.record_status, updated_at: s.updated_at }, ids: [] }); byStatus.get(key).ids.push(id); }
    for (const { patch, ids } of byStatus.values()) for (const part of chunks(ids, idsPerPatch)) {
      request("7_flip", part);
      if (has("flipActivitiesBatch")) await inner.flipActivitiesBatch(part, patch); else for (const id of part) await inner.updateActivity(id, patch);
    }
  }
  async function flush() {
    if (poisoned) return; // queue stays empty: business writes are refused at enqueue
    const q = queue; if (isEmpty(q)) return;
    queue = empty(); stats.flushes++;
    try { await flushPhases(q); } catch (error) { poisoned = error.message; stats.poisoned++; throw error; }
  }
  const refuse = () => { throw new Error(`Flush groupé en échec dans cette tranche : écriture refusée, tranche à rejouer (${poisoned})`); };
  const deferred = {
    async createActivity(row) { const id = randomUUID(); const full = { merged_into_id: null, ...row, id }; queue.created.set(id, full); return { ...full }; },
    async updateActivity(id, patch) {
      // Barrier: a later write (MATCH merge) onto a staging row already flipped logically commits
      // the queue first, so the target is fully supported before another provenance attaches.
      if (queue.created.has(id) && queue.status.has(id)) { stats.barriers++; await flush(); if (poisoned) refuse(); }
      if (queue.created.has(id)) {
        const { record_status, ...rest } = patch; Object.assign(queue.created.get(id), rest);
        if (record_status === "stale") queue.status.delete(id);
        else if (record_status) queue.status.set(id, { record_status, updated_at: patch.updated_at });
        return { id, ...patch };
      }
      queue.updates.set(id, Object.assign(queue.updates.get(id) || {}, patch)); return { id, ...patch };
    },
    async insertDedupDecision(row) {
      if (row.left_activity_id === row.right_activity_id) return null;
      const [l, r] = [row.left_activity_id, row.right_activity_id].sort(), key = `${l}\0${r}\0${row.algorithm_version}`;
      if (!queue.decisionKeys.has(key)) { queue.decisionKeys.add(key); queue.decisions.push(row); }
      return null;
    },
    async createProvenanceIdempotent(row) { const full = { ...row, id: randomUUID() }; queue.provenances.set(full.id, full); return { ...full }; },
    async updateProvenance(id, patch) {
      const created = queue.provenances.get(id); if (created) { Object.assign(created, patch); return { ...created }; }
      queue.provPatches.set(id, Object.assign(queue.provPatches.get(id) || {}, patch)); return { id, ...patch };
    },
    async upsertExternalIds(activityId, sourceId, ids) { for (const e of ids) queue.ext.set(`${activityId}\0${sourceId}\0${e.system}\0${e.value}`, { activity_id: activityId, source_id: sourceId, system: e.system, value: e.value }); }
  };
  return new Proxy(inner, { get(target, key) {
    if (key === "flush") return flush;
    if (key === "writeBehindStats") return stats;
    if (key === "candidateCacheNamespace") return target.candidateCacheNamespace || target;
    const value = target[key];
    if (typeof value !== "function") return value;
    if (DEFERRED.has(key)) return async (...args) => { if (poisoned) refuse(); return deferred[key](...args); };
    // A new persist call starts with its run: only the previous call's poison is cleared.
    if (key === "createIngestionRun") return async (...args) => { if (poisoned) { poisoned = null; queue = empty(); } await flush(); return value.apply(target, args); };
    // Read barrier / non-deferrable call: everything queued before it reaches the store first.
    return async (...args) => { await flush(); return value.apply(target, args); };
  } });
}

module.exports = { createWriteBehindStore, WriteBehindConflictError, DEFAULT_ROWS_PER_REQUEST, DEFAULT_IDS_PER_PATCH };
