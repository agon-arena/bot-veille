"use strict";

const { sameInterval, hasUnspecifiedStart } = require("./datatourisme-occurrence-identity");
const contexts = new WeakSet();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const pair = (record, key) => JSON.stringify([record, key]);

// Explicit finite repair capability, never enabled by a scheduler or a normal run.
// Keep this audited plan on replay: original activity IDs also recover orphan/stale
// work after a crash between relinking a provenance and checking its old supports.
function createDatatourismeRepairContext({ sourceId, plan }) {
  if (!UUID.test(sourceId) || !Array.isArray(plan) || !plan.length || plan.length > 21) throw new Error("Plan de réparation explicite borné obligatoire");
  const approved = new Map(), historical = new Map();
  for (const row of structuredClone(plan)) {
    if (!UUID.test(row.uuid) || approved.has(row.uuid) || !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
      !Array.isArray(row.activityIds) || !Array.isArray(row.provenances)) throw new Error("Plan de réparation invalide");
    approved.set(row.uuid, row);
    for (const p of row.provenances) {
      if (!p.id || historical.has(p.id) || !row.activityIds.includes(p.activity_id) || !p.source_record_id?.startsWith(`datatourisme:${row.uuid}:`)) throw new Error("Provenance du plan hors périmètre");
      historical.set(p.id, { ...p, uuid: row.uuid });
    }
  }
  let expected = new Map(), currentIds = [];
  const context = {
    sourceId,
    bind(states) {
      expected = new Map(); currentIds = [];
      for (const state of states) {
        const row = approved.get(state.uuid);
        if (!row || currentIds.includes(state.uuid) || row.fingerprint !== state.fingerprint || state.editorial !== "KEEP" ||
          require("./datatourisme-poi-state").fingerprintCalculatedPoi(state, state.algorithm_version).fingerprint !== row.fingerprint ||
          state.results.some(i => hasUnspecifiedStart(i.activity))) throw new Error("Source de réparation modifiée, ambiguë ou hors plan");
        currentIds.push(state.uuid);
        for (const item of state.results) expected.set(pair(item.sourceRecordId, item.sourceOccurrenceKey), item);
      }
    },
    validateSource(id, descriptor) {
      if (id !== sourceId || descriptor.connectorType !== "datatourisme" || descriptor.key !== "datatourisme-national" ||
        descriptor.results.length !== expected.size || descriptor.results.some(i => !expected.has(pair(i.sourceRecordId, i.sourceOccurrenceKey)))) throw new Error("Source de réparation hors périmètre");
    },
    authorize(provenance, metadata) {
      const p = historical.get(provenance.id), item = expected.get(pair(metadata.sourceRecordId, metadata.sourceOccurrenceKey));
      if (!p || !item || provenance.source_id !== sourceId || provenance.activity_id !== p.activity_id ||
        provenance.source_record_id !== p.source_record_id || provenance.source_occurrence_key !== p.source_occurrence_key ||
        !sameInterval(metadata.canonicalActivityPayload, item.activity)) throw new Error("Rattachement de réparation non approuvé ou concurrent");
    },
    async relink(store, provenance, activityId, metadata, patch) {
      context.authorize(provenance, metadata);
      // Keep the provenance ID as the durable link to its new target FIRST. If
      // identifier relocation fails, replay finds that target instead of creating
      // another activity. finishIdentifiers retries the remaining moves from plan.
      const updated = await store.updateProvenance(provenance.id, { activity_id: activityId, original_event_url: metadata.originalEventUrl,
        payload_hash: patch.payload_hash, source_payload: metadata.sourcePayload, active: true,
        last_seen_at: patch.last_seen_at, last_seen_run_id: patch.last_seen_run_id });
      await store.relocateDatatourismeOccurrenceExternalIds({ sourceId, fromActivityId: provenance.activity_id, toActivityId: activityId,
        values: [...new Set([metadata.sourceRecordId, metadata.sourceOccurrenceKey, metadata.legacySourceOccurrenceKey].filter(Boolean))] });
      return updated;
    },
    async finishIdentifiers(store) {
      const items = [...expected.values()];
      if (!items.length) return;
      const rows = await store.findProvenancesBatch(sourceId, [...new Set(items.flatMap(i => [i.sourceOccurrenceKey, i.legacySourceOccurrenceKey].filter(Boolean)))]);
      for (const item of items) {
        const row = rows.find(p => p.source_record_id === item.sourceRecordId && p.source_occurrence_key === item.sourceOccurrenceKey) ||
          rows.find(p => require("./datatourisme-occurrence-identity").matchesLegacyOccurrence(p, item));
        if (!row || !row.active) throw new Error("Identité de réparation sans provenance active");
        const original = historical.get(row.id);
        if (original && original.activity_id !== row.activity_id) {
          await store.relocateDatatourismeOccurrenceExternalIds({ sourceId, fromActivityId: original.activity_id, toActivityId: row.activity_id,
            values: [...new Set([item.sourceRecordId, item.sourceOccurrenceKey, item.legacySourceOccurrenceKey].filter(Boolean))] });
        }
        await store.upsertExternalIds(row.activity_id, sourceId, item.activity.externalIds);
      }
    },
    activityIds() { return [...new Set(currentIds.flatMap(id => approved.get(id).activityIds))]; }
  };
  contexts.add(context);
  return context;
}
function isDatatourismeRepairContext(value) { return contexts.has(value); }

function createDatatourismePoiRepairPersister({ store, activityStore, sourceId, plan, now }) {
  if (now == null || !Number.isFinite(+new Date(now))) throw new Error("Instant explicite obligatoire");
  const context = createDatatourismeRepairContext({ sourceId, plan });
  return async states => {
    context.bind(states);
    const { persistSortirIngestion } = require("./supabase-persistence");
    const run = await persistSortirIngestion({ store, now: new Date(now), reconcileDisappearances: false, datatourismeRepair: context,
      sources: [{ key: "datatourisme-national", connectorType: "datatourisme", baseUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent", results: states.flatMap(s => s.results) }] });
    if (run.status === "completed") {
      await context.finishIdentifiers(store);
      const ids = context.activityIds();
      for (let from = 0; from < ids.length; from += 500) {
        const batch = ids.slice(from, from + 500), supports = await activityStore.loadActivitySupportsBatch(batch);
        if (supports.length !== batch.length || new Set(supports.map(s => s.id)).size !== batch.length || supports.some(s => !batch.includes(s.id) || typeof s.has_active_provenance !== "boolean")) throw new Error("Soutiens de réparation incomplets");
        const stale = supports.filter(s => ["active", "review"].includes(s.record_status) && !s.has_active_provenance).map(s => s.id);
        if (stale.length) await activityStore.staleUnsupportedActivitiesBatch(stale, new Date(now).toISOString());
      }
    }
    return states.map(s => ({ uuid: s.uuid, status: run.status === "completed" ? "completed" : "failed" }));
  };
}
module.exports = { createDatatourismeRepairContext, isDatatourismeRepairContext, createDatatourismePoiRepairPersister };
