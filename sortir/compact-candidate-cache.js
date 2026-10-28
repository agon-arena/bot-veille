"use strict";
// Candidate cache of the DATAtourisme persister (drop-in for TemporalCandidateCache: same index,
// same decisions). Network/memory changes only:
// 1 exact windows: only [t-12h, t+12h] around the NEW occurrences of a call, merged; covered
//   intervals are tracked (the index never matches beyond 12 h).
// 2 compact rows: every column read by compareActivities, the index and the INSERT guard, without
//   description / field_confidence / tags; provenance sources resolved locally (no join).
// 3 on-demand hydration BEFORE the sequential loop: a compact candidate is fully loaded when, for
//   a NEW occurrence of the call, its comparison depends on the description (two sentinels give
//   different results) or is not DISTINCT (a MATCH merges full content, REVIEW keeps signals).
// 4 no post-call re-read: the loop already injects every row it creates or modifies.
// 5 bounded: least-recently-loaded day groups are evicted at the START of a call (nothing is
//   pending then; the DB is the source of truth), and purge() clears everything between runs.
const { TemporalCandidateIndex } = require("./temporal-candidate-cache");
const { compareActivities } = require("./activity-deduplication");

const DAY = 864e5, HALF = DAY / 2;
const DROPPED_COLUMNS = ["description", "field_confidence", "tags"];
const DEFAULT_MAX_ROWS = 100000; // measured working set: ~60-71k compact rows for 1 000 cold POI
const SENTINEL_A = "\u0000sentinelle-a";
const SENTINEL_B = "zz sentinelle b différente de toute description réelle zz";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const mergeIntervals = list => { const out = []; for (const w of [...list].sort((a, b) => a.start - b.start)) { const last = out.at(-1); if (last && w.start <= last.end) last.end = Math.max(last.end, w.end); else out.push({ ...w }); } return out; };
const subtract = (w, c) => w.end <= c.start || w.start >= c.end ? [w] : [w.start < c.start ? { start: w.start, end: c.start } : null, w.end > c.end ? { start: c.end, end: w.end } : null].filter(Boolean);

class CompactCandidateCache {
  constructor({ maxRows = DEFAULT_MAX_ROWS, sources = null } = {}) {
    if (!(maxRows >= 1000)) throw new Error("Plafond du cache candidats trop bas pour le jeu de travail");
    this.maxRows = maxRows; this.sources = sources ? new Map(sources.map(s => [s.id, { key: s.key, connector_type: s.connector_type, base_url: s.base_url }])) : null;
    this.stats = { loads: 0, windows: 0, loadedRows: 0, hydratedRows: 0, sentinelPairs: 0, evictedRows: 0, peakRows: 0, peakBytes: 0, purges: 0 };
    this.clear();
  }
  clear() { this.rows = new Map(); this.days = new Map(); this.index = new TemporalCandidateIndex(); this.covered = []; this.loadOrder = []; this.dirty = new Set(); this.bytes = 0; this.store = null; }
  purge() { this.clear(); this.stats.purges++; }
  async resolveSources(store) {
    if (this.sources) return;
    const rows = typeof store.listSources === "function" ? await store.listSources() : Array.isArray(store.sources) ? store.sources : [];
    this.sources = new Map(rows.map(s => [s.id, { key: s.key, connector_type: s.connector_type, base_url: s.base_url }]));
  }
  shape(row, compact) {
    const r = { ...row };
    if (compact) { for (const k of DROPPED_COLUMNS) delete r[k]; r._compact = true; } else delete r._compact;
    r.provenances = (row.provenances || []).map(p => ({ id: p.id, source_id: p.source_id, source_record_id: p.source_record_id, original_event_url: p.original_event_url, last_seen_at: p.last_seen_at, source: p.source ? { key: p.source.key, connector_type: p.source.connector_type, base_url: p.source.base_url } : this.sources?.get(p.source_id) }));
    r.external_ids = (row.external_ids || []).map(({ system, value }) => ({ system, value }));
    return r;
  }
  set(row, dirty = true) {
    const shaped = this.shape(row, row._compact === true), old = this.rows.get(row.id), day = Math.floor(Date.parse(shaped.starts_at) / DAY), bytes = Buffer.byteLength(JSON.stringify(shaped));
    if (this.rows.size + (old ? 0 : 1) > this.maxRows * 2) throw new Error("Budget du cache candidats dépassé : arrêt sûr");
    if (old) { this.bytes -= old.bytes; this.days.get(old.day)?.delete(row.id); }
    this.rows.set(row.id, { row: shaped, day, bytes }); this.bytes += bytes; this.index.set(row.id, shaped);
    if (!this.days.has(day)) this.days.set(day, new Set()); this.days.get(day).add(row.id);
    if (dirty) this.dirty.add(row.id);
    this.stats.peakRows = Math.max(this.stats.peakRows, this.rows.size); this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes);
  }
  invalidate(ids) {
    const days = new Set(ids.map(id => this.rows.get(id)?.day).filter(d => d !== undefined));
    for (const day of days) {
      for (const id of this.days.get(day) || []) { this.bytes -= this.rows.get(id).bytes; this.rows.delete(id); this.index.delete(id); this.dirty.delete(id); }
      this.days.delete(day); this.covered = this.covered.flatMap(w => subtract(w, { start: day * DAY, end: (day + 1) * DAY }));
    }
  }
  evict() {
    if (this.rows.size <= this.maxRows) return;
    const order = new Map(this.loadOrder.map((d, i) => [d, i]));
    for (const day of [...this.days.keys()].sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1))) {
      if (this.rows.size <= this.maxRows * 0.8) break;
      const ids = [...this.days.get(day)]; this.stats.evictedRows += ids.length;
      if (ids.length) this.invalidate([ids[0]]); else { this.days.delete(day); this.covered = this.covered.flatMap(w => subtract(w, { start: day * DAY, end: (day + 1) * DAY })); }
    }
  }
  missingWindows(times) {
    let out = mergeIntervals(times.map(t => ({ start: t - HALF, end: t + HALF + 1 })));
    for (const c of this.covered) out = out.flatMap(w => subtract(w, c));
    return out;
  }
  async load(times, store, newActivities = []) {
    // Ownership = the underlying store (a write-behind envelope per persister shares it): the same
    // cache may serve successive persisters of one run, never two different stores/writers.
    const owner = store.candidateCacheNamespace || store;
    if (this.store && this.store !== owner) throw new Error("Un cache candidat appartient à un seul store/writer");
    this.store = owner; this.evict(); await this.resolveSources(store);
    const windows = this.missingWindows(times);
    if (windows.length) {
      const rows = typeof store.listCandidateActivitiesCompact === "function" ? await store.listCandidateActivitiesCompact(windows, { maxRows: this.maxRows * 2 })
        : typeof store.listCandidateActivitiesInWindows === "function" ? await store.listCandidateActivitiesInWindows(windows)
        : (await Promise.all(windows.map(w => store.listCandidateActivitiesInRange(new Date(w.start).toISOString(), new Date(w.end - 1).toISOString())))).flat();
      const seen = new Set();
      for (const row of rows) {
        if (seen.has(row.id)) continue; seen.add(row.id);
        if (this.rows.has(row.id) && !this.rows.get(row.id).row._compact) continue; // never downgrade a full row
        this.set({ ...row, _compact: true }, false);
      }
      for (const w of windows) { this.covered.push(w); for (let d = Math.floor(w.start / DAY); d <= Math.floor((w.end - 1) / DAY); d++) if (!this.loadOrder.includes(d)) this.loadOrder.push(d); }
      this.covered = mergeIntervals(this.covered); this.stats.loads++; this.stats.windows += windows.length; this.stats.loadedRows += seen.size;
    }
    await this.hydrate(store, newActivities);
  }
  async hydrate(store, newActivities) {
    if (!newActivities.length) return;
    const { rowToActivity } = require("./supabase-persistence"), needed = new Set();
    for (const activity of newActivities) for (const row of this.index.matches(activity)) {
      if (!row._compact || needed.has(row.id)) continue;
      this.stats.sentinelPairs++;
      const a = compareActivities(rowToActivity({ ...row, description: SENTINEL_A }), activity), b = compareActivities(rowToActivity({ ...row, description: SENTINEL_B }), activity);
      if (a.decision !== "DISTINCT" || stableJson(a) !== stableJson(b)) needed.add(row.id);
    }
    const ids = [...needed];
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100), full = await store.getActivitiesBatch(part);
      if (full.length !== part.length) throw new Error("Hydratation des candidats incomplète");
      for (const row of full) { this.set(row, false); this.stats.hydratedRows++; }
    }
  }
  // Called after a completed persist call: rows written in the call are already in memory.
  async refresh() { this.dirty.clear(); }
}

module.exports = { CompactCandidateCache, DROPPED_COLUMNS, DEFAULT_MAX_ROWS };
