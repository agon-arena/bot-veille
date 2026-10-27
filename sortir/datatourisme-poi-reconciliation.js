"use strict";

const { calculatePoiStateBatch, fingerprintCalculatedPoi, processPoiStateBatch, STATE_BATCH_SIZE } = require("./datatourisme-poi-state");
const { persistSortirIngestion, createSupabaseSortirStore } = require("./supabase-persistence");
const { sameInterval, matchesLegacyOccurrence } = require("./datatourisme-occurrence-identity");
const { TemporalCandidateCache } = require("./temporal-candidate-cache");
const { evaluateQuarantine } = require("./datatourisme-review-quarantine");
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function requireUuid(id) { if (typeof id !== "string" || !UUID_RE.test(id)) throw new Error("UUID canonique obligatoire"); }
function batches(rows) { return Array.from({ length: Math.ceil(rows.length / STATE_BATCH_SIZE) }, (_, i) => rows.slice(i * STATE_BATCH_SIZE, (i + 1) * STATE_BATCH_SIZE)); }

async function reconcileReceivedPoiOccurrences({ states, store, sourceId, now, candidateCache }) {
  requireUuid(sourceId);
  const updatedAt = new Date(now).toISOString();
  if (now == null) throw new Error("Instant explicite obligatoire");
  const selections = new Map();
  for (const state of states) {
    requireUuid(state.uuid);
    if (!["NEW", "CHANGED"].includes(state.classification) || selections.has(state.uuid)) throw new Error("POI NEW/CHANGED reçu et unique obligatoire");
    // Refuse a malformed/mutated calculated state BEFORE touching historical rows.
    if (fingerprintCalculatedPoi(state, state.algorithm_version).fingerprint !== state.fingerprint) throw new Error("État calculé modifié avant réconciliation");
    const items = state.editorial === "DENY" ? [] : state.results;
    if (items.some(i => !i.sourceRecordId?.startsWith(`datatourisme:${state.uuid}:`) || !i.sourceOccurrenceKey)) throw new Error("Identité d'occurrence DATAtourisme incohérente");
    selections.set(state.uuid, items);
  }
  const retired = [], history = [];
  for (const batch of batches([...selections.keys()])) history.push(...await store.loadPoiProvenancesBatch(sourceId, batch));
  // Read persisted activities in batches; fail CLOSED before any deactivation.
  // Never accept the input fingerprint or a pipeline completion flag as proof of coverage.
  const candidates = history.filter(row => (selections.get(row.poi_uuid) || []).some(item =>
    row.source_record_id === item.sourceRecordId && (row.source_occurrence_key === item.sourceOccurrenceKey || row.source_occurrence_key === item.legacySourceOccurrenceKey)));
  const activities = new Map();
  for (const ids of batches([...new Set(candidates.map(p => p.activity_id))])) {
    for (const row of await store.getActivitiesBatch(ids)) {
      if (!ids.includes(row.id) || activities.has(row.id)) throw new Error("Couverture DATAtourisme : activités incohérentes");
      activities.set(row.id, row);
    }
  }
  // The existing RPC intentionally returns compact identities, without payload.
  // Hydrated activities carry the exact provenance payloads; reuse this batch read.
  for (const row of candidates) {
    const persisted = activities.get(row.activity_id)?.provenances?.find(p => p.id === row.id && p.source_id === row.source_id);
    if (persisted && row.source_payload == null) row.source_payload = persisted.source_payload;
  }
  const selectedRows = candidates.filter(row => (selections.get(row.poi_uuid) || []).some(item =>
    row.source_record_id === item.sourceRecordId && (row.source_occurrence_key === item.sourceOccurrenceKey || matchesLegacyOccurrence(row, item))));
  for (const row of selectedRows.filter(p => p.active)) {
    const activity = activities.get(row.activity_id);
    const expected = selections.get(row.poi_uuid).find(i => i.sourceRecordId === row.source_record_id &&
      (i.sourceOccurrenceKey === row.source_occurrence_key || matchesLegacyOccurrence(row, i)));
    if (!activity || !sameInterval({ startsAt: activity.starts_at, endsAt: activity.ends_at }, expected.activity)) {
      throw new Error(`Couverture DATAtourisme incohérente : provenance ${row.id} mal rattachée`);
    }
  }
  // A review activity counts as coverage only if it is not a partial REVIEW quarantine.
  const reviewIds = [...new Set(selectedRows.filter(p => p.active && activities.get(p.activity_id)?.record_status === "review").map(p => p.activity_id))];
  const quarantines = new Map();
  if (reviewIds.length) {
    if (typeof store.loadReviewDecisionsBatch !== "function") throw new Error("Couverture DATAtourisme : décisions REVIEW illisibles");
    const decisions = [];
    for (const ids of batches(reviewIds)) decisions.push(...await store.loadReviewDecisionsBatch(ids));
    for (const activityId of reviewIds) quarantines.set(activityId, evaluateQuarantine(activities.get(activityId), decisions));
  }
  for (const [id, items] of selections) for (const item of items) {
    const covered = selectedRows.some(row => {
      const activity = activities.get(row.activity_id);
      return row.poi_uuid === id && row.source_id === sourceId && row.active === true &&
        row.source_record_id === item.sourceRecordId &&
        (row.source_occurrence_key === item.sourceOccurrenceKey || matchesLegacyOccurrence(row, item)) &&
        activity && ["active", "review"].includes(activity.record_status) &&
        !(quarantines.get(activity.id)?.quarantined && !quarantines.get(activity.id).complete) &&
        sameInterval({ startsAt: activity.starts_at, endsAt: activity.ends_at }, item.activity);
    });
    if (!covered) throw new Error(`Couverture DATAtourisme incomplète : ${id} / ${item.sourceOccurrenceKey}`);
  }
  for (const row of history) {
    const items = selections.get(row.poi_uuid);
    if (!items || row.source_id !== sourceId || !row.source_record_id.startsWith(`datatourisme:${row.poi_uuid}:`)) throw new Error("Provenance hors du périmètre reçu");
    const retained = items.some(item => {
      if (row.source_record_id !== item.sourceRecordId) return false;
      if (row.source_occurrence_key === item.sourceOccurrenceKey) return true;
      // Retire a legacy alias only with an ACTIVE, interval-compatible canonical
      // replacement. An inactive or wrongly linked row is not coverage.
      return matchesLegacyOccurrence(row, item) &&
        !history.some(p => p.active && p.source_id === sourceId && p.source_record_id === item.sourceRecordId && p.source_occurrence_key === item.sourceOccurrenceKey &&
          activities.has(p.activity_id) && sameInterval({ startsAt: activities.get(p.activity_id).starts_at, endsAt: activities.get(p.activity_id).ends_at }, item.activity));
    });
    if (!retained) retired.push(row);
  }
  const activeIds = [...new Set(retired.filter(p => p.active).map(p => p.id))];
  candidateCache?.invalidate([...new Set(retired.map(p => p.activity_id))]);
  let deactivated = 0;
  for (const batch of batches(activeIds)) deactivated += await store.deactivateProvenancesBatch(sourceId, batch);
  // Include INACTIVE historical rows: replay must finish stale after an earlier crash.
  const activityIds = [...new Set(retired.map(p => p.activity_id))];
  const supported = [];
  for (const batch of batches(activityIds)) supported.push(...await store.loadActivitySupportsBatch(batch));
  const expectedActivities = new Set(activityIds);
  if (supported.length !== activityIds.length || new Set(supported.map(a => a.id)).size !== activityIds.length || supported.some(a => !expectedActivities.has(a.id) || typeof a.has_active_provenance !== "boolean")) throw new Error("Soutiens d'activités incomplets");
  const staleIds = supported.filter(a => ["active", "review"].includes(a.record_status) && a.has_active_provenance === false).map(a => a.id);
  let staled = 0;
  for (const batch of batches(staleIds)) staled += await store.staleUnsupportedActivitiesBatch(batch, updatedAt);
  return { pois: states.length, provenancesRead: history.length, retired: retired.length, deactivated, activitiesChecked: activityIds.length, staled };
}

// Optional standalone entry point, deliberately absent from the production scheduler.
// The callback persists ONLY successfully calculated NEW/CHANGED POIs; per-POI
// completion must reflect the actual pipeline outcome, never just a successful fetch.
async function processReceivedPoiBatch({ pois, stateStore, activityStore, sourceId, now, scanId, persistOccurrences, catalogObserved = false, candidateCache = persistOccurrences?.candidateCache, ...calculationOptions }) {
  const calculated = calculatePoiStateBatch(pois, { ...calculationOptions, now });
  let reconciliation = null;
  const result = await processPoiStateBatch({ states: calculated.states, store: stateStore, now, scanId, catalogObserved, applyChanges: async changed => {
    if (typeof persistOccurrences !== "function") throw new Error("Callback de persistance explicite obligatoire");
    const outcomes = await persistOccurrences(changed);
    if (!Array.isArray(outcomes)) throw new Error("Résultats de persistance par POI obligatoires");
    const byId = new Map(changed.map(s => [s.uuid, s]));
    const seen = new Set(), successful = [];
    for (const outcome of outcomes) {
      if (!byId.has(outcome.uuid) || seen.has(outcome.uuid)) throw new Error("Résultat de persistance incohérent");
      seen.add(outcome.uuid);
      if (outcome.status === "completed") successful.push(byId.get(outcome.uuid));
    }
    reconciliation = await reconcileReceivedPoiOccurrences({ states: successful, store: activityStore, sourceId, now, candidateCache });
    return successful.map(s => ({ uuid: s.uuid, persistence: "completed", reconciliation: "completed" }));
  } });
  return { ...result, errors: calculated.errors, stats: calculated.stats, reconciliation };
}

function createSupabasePoiReconciliationStore(client) {
  const execute = async query => { const { data, error } = await query; if (error) throw new Error(error.message); return data; };
  return {
    getActivitiesBatch: createSupabaseSortirStore(client).getActivitiesBatch,
    loadReviewDecisionsBatch: createSupabaseSortirStore(client).loadReviewDecisionsBatch,
    async loadPoiProvenancesBatch(sourceId, ids) {
      const rows = [], seen = new Set();
      let total = null;
      for (let from = 0; ; from += STATE_BATCH_SIZE) {
        const { data, count, error } = await client.rpc("sortir_load_datatourisme_poi_provenances", { p_source_id: sourceId, p_uuids: ids }, { count: "exact" }).range(from, from + STATE_BATCH_SIZE - 1);
        if (error) throw new Error(error.message);
        if (!Array.isArray(data) || !Number.isInteger(count) || count < 0 || (total !== null && count !== total) ||
          (from + data.length < count && data.length !== STATE_BATCH_SIZE)) throw new Error("Pagination des provenances incomplète");
        total = count;
        for (const row of data) { if (seen.has(row.id)) throw new Error("Pagination des provenances dupliquée"); seen.add(row.id); }
        rows.push(...data);
        if (from + data.length >= count) {
          if (rows.length !== count) throw new Error("Pagination des provenances incomplète");
          break;
        }
      }
      return rows;
    },
    deactivateProvenancesBatch: (sourceId, ids) => execute(client.rpc("sortir_deactivate_datatourisme_provenances", { p_source_id: sourceId, p_ids: ids })),
    loadActivitySupportsBatch: ids => execute(client.rpc("sortir_load_activity_supports", { p_ids: ids })),
    staleUnsupportedActivitiesBatch: (ids, now) => execute(client.rpc("sortir_stale_unsupported_activities", { p_ids: ids, p_updated_at: now }))
  };
}

// Reuse the normal occurrence pipeline, explicitly disabling its GLOBAL age-based
// disappearance sweep: this batch cannot decide anything about invalid/absent POIs.
// Constructed only by a future explicit caller, never by the scheduler.
function createDatatourismePoiPersister({ store, now, candidateCache = new TemporalCandidateCache(), beforeCreateActivity = null }) {
  if (now == null || !Number.isFinite(+new Date(now))) throw new Error("Instant explicite obligatoire");
  // Fail closed: reactivation must be able to recognise a REVIEW quarantine.
  if (typeof store?.loadReviewDecisionsBatch !== "function") throw new Error("Lecture des décisions REVIEW obligatoire");
  const persist = async states => {
    const outcomes = [];
    for (let from = 0; from < states.length; from += 100) {
      const chunk = states.slice(from, from + 100);
      const result = await persistSortirIngestion({ store, now: new Date(now), reconcileDisappearances: false, candidateCache, beforeCreateActivity, sources: [{
        key: "datatourisme-national", connectorType: "datatourisme", baseUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent",
        results: chunk.flatMap(s => s.editorial === "KEEP" ? s.results : [])
      }] });
      // A partial chunk is replayed in full; don't guess per-item success from counts.
      outcomes.push(...chunk.map(s => ({ uuid: s.uuid, status: result.status === "completed" ? "completed" : "failed" })));
    }
    return outcomes;
  };
  persist.candidateCache = candidateCache;
  return persist;
}

module.exports = { reconcileReceivedPoiOccurrences, processReceivedPoiBatch, createSupabasePoiReconciliationStore, createDatatourismePoiPersister };
