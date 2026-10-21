"use strict";

const { createHash } = require("crypto");
const { performance } = require("perf_hooks");
const { convertDatatourismeEvent, isRelevantForMnoria } = require("./connectors/datatourisme");
const { validateNormalizedActivity } = require("./activity-validation");
const { canonicalActivityPayload, stableJson } = require("./supabase-persistence");
const { canonicalUrl } = require("./activity-deduplication");

const FINGERPRINT_VERSION = "datatourisme-mnoria-v1";
const STATE_BATCH_SIZE = 500;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function uuid(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error("UUID DATAtourisme invalide");
  return value.toLowerCase();
}
function instant(value) {
  const date = new Date(value);
  if (value == null || !Number.isFinite(+date)) throw new Error("Instant explicite obligatoire");
  return date.toISOString();
}
function batches(rows) {
  return Array.from({ length: Math.ceil(rows.length / STATE_BATCH_SIZE) }, (_, i) => rows.slice(i * STATE_BATCH_SIZE, (i + 1) * STATE_BATCH_SIZE));
}
// Full serialized values provide deterministic tie-breaking, including equal sort keys.
function asSet(values) { return [...new Set(values.map(stableJson))].sort().map(value => JSON.parse(value)); }

function usefulOccurrence(item) {
  if (item.error || !item.activity) throw new Error("Occurrence inexploitable : référence interdite");
  // Connector outputs already carry the validation of this exact normalized object.
  // Revalidating it would rebuild Intl timezone formatters for every occurrence.
  const validation = item.validation?.activity === item.activity ? item.validation : validateNormalizedActivity(item.activity);
  if (validation.status === "INVALID") {
    const error = new Error("Occurrence INVALID : référence interdite");
    error.validationCodes = validation.errors.map(issue => issue.code);
    throw error;
  }
  const activity = validation.activity;
  const payload = canonicalActivityPayload(activity);
  payload.organizers = asSet(payload.organizers);
  payload.externalIds = asSet(payload.externalIds);
  payload.tags = asSet(payload.tags);
  // Raw sourceValue/provenanceIndex are audit context, not current Mnoria behavior.
  // Keep the semantic evidence and confidence used by validation/persistence.
  payload.evidence = asSet(activity.evidence.map(({ field, excerpt }) => ({ field, excerpt })));
  return {
    sourceRecordId: item.sourceRecordId || null,
    sourceOccurrenceKey: item.sourceOccurrenceKey || null,
    validationStatus: validation.status,
    originalEventUrls: asSet(activity.provenances.map(p => canonicalUrl(p.originalEventUrl)).filter(Boolean)),
    activity: payload
  };
}

// Input is already calculated by the connector with the caller's fixed `now`.
// DENY has no occurrence payload: changes to rejected text cannot affect Mnoria.
function fingerprintCalculatedPoi({ uuid: id, editorial, results = [] }, version = FINGERPRINT_VERSION) {
  id = uuid(id);
  if (!["KEEP", "DENY"].includes(editorial)) throw new Error("Décision éditoriale KEEP/DENY obligatoire");
  if (typeof version !== "string" || !version.length || version.length > 80) throw new Error("Version invalide");
  if (!Array.isArray(results)) throw new Error("Résultats calculés obligatoires");
  const document = { version, uuid: id, editorial, occurrences: editorial === "DENY" ? [] : asSet(results.map(usefulOccurrence)) };
  return { uuid: id, fingerprint: createHash("sha256").update(stableJson(document)).digest("hex"), algorithm_version: version, editorial, results };
}

function calculatePoiState(poi, { now, version = FINGERPRINT_VERSION, onFingerprintTiming, ...connectorOptions } = {}) {
  const observedAt = instant(now);
  const id = uuid(poi?.uuid);
  const types = Array.isArray(poi.type) ? poi.type.filter(t => typeof t === "string") : typeof poi.type === "string" ? [poi.type] : [];
  const editorial = isRelevantForMnoria({ sourceCategories: types.map(t => t.trim()).filter(Boolean) }) ? "KEEP" : "DENY";
  const results = editorial === "KEEP" ? convertDatatourismeEvent({ ...poi, uuid: id }, { ...connectorOptions, now: new Date(observedAt) }) : [];
  const start = performance.now();
  const state = fingerprintCalculatedPoi({ uuid: id, editorial, results }, version);
  if (onFingerprintTiming) onFingerprintTiming(performance.now() - start);
  return state;
}

// Conversion errors belong to one received POI, never to its neighbours. No empty
// replacement state is produced on failure: old occurrences/reference stay untouched.
function calculatePoiStateBatch(pois, options = {}) {
  instant(options.now); // A missing scan clock is a configuration error, not N invalid POIs.
  if (!Array.isArray(pois)) throw new Error("Lot de POI reçus obligatoire");
  const states = [], errors = [], errorCodes = {};
  for (const poi of pois) {
    try { states.push(calculatePoiState(poi, options)); }
    catch (error) {
      const codes = error.validationCodes || ["conversion_error"];
      errors.push({ uuid: poi?.uuid || null, message: error.message, codes });
      for (const code of codes) errorCodes[code] = (errorCodes[code] || 0) + 1;
    }
  }
  return { states, errors, stats: { received: pois.length, calculated: states.length, invalid: errors.length, errorCodes } };
}

async function comparePoiStates({ states, store }) {
  const seen = new Set();
  for (const state of states) {
    const id = uuid(state.uuid);
    if (id !== state.uuid || seen.has(id)) throw new Error("UUID non canonique ou dupliqué dans le lot");
    if (!/^[a-f0-9]{64}$/.test(state.fingerprint) || !state.algorithm_version) throw new Error("Empreinte invalide");
    seen.add(id);
  }
  const previous = new Map();
  for (const batch of batches(states)) {
    const ids = batch.map(s => s.uuid);
    const rows = await store.loadBatch(ids);
    for (const row of rows) {
      if (!seen.has(row.poi_uuid) || previous.has(row.poi_uuid)) throw new Error("État durable incohérent");
      previous.set(row.poi_uuid, row);
    }
  }
  const classified = states.map(state => {
    const old = previous.get(state.uuid);
    const classification = !old || old.fingerprint == null ? "NEW" : !old.needs_reprocess && old.fingerprint === state.fingerprint && old.algorithm_version === state.algorithm_version ? "UNCHANGED" : "CHANGED";
    return { ...state, classification };
  });
  return { classified, toPersist: classified.filter(s => s.classification !== "UNCHANGED"), unchanged: classified.filter(s => s.classification === "UNCHANGED") };
}

// No default callback and no import/call of persistSortirIngestion. The future caller
// must certify both operations per POI, including DENY and KEEP with zero occurrences.
async function processPoiStateBatch({ states, store, now, scanId, applyChanges, catalogObserved = false }) {
  const observedAt = instant(now);
  scanId = uuid(scanId);
  const comparison = await comparePoiStates({ states, store });
  if (comparison.unchanged.length && !catalogObserved) {
    for (const batch of batches(comparison.unchanged)) await store.observeBatch(batch.map(s => s.uuid), observedAt, scanId);
  }
  if (!comparison.toPersist.length) return { ...comparison, committed: [] };
  if (typeof applyChanges !== "function") throw new Error("Callback explicite persistance/réconciliation obligatoire");
  const outcomes = await applyChanges(comparison.toPersist);
  if (!Array.isArray(outcomes)) throw new Error("Résultats par POI obligatoires");
  const eligible = new Map(comparison.toPersist.map(s => [s.uuid, s]));
  const acknowledged = new Set();
  const successful = [];
  for (const outcome of outcomes) {
    if (!eligible.has(outcome.uuid) || acknowledged.has(outcome.uuid)) throw new Error("Accusé de succès incohérent");
    acknowledged.add(outcome.uuid);
    if (outcome.persistence === "completed" && outcome.reconciliation === "completed") successful.push(eligible.get(outcome.uuid));
  }
  const rows = successful.map(s => ({ poi_uuid: s.uuid, fingerprint: s.fingerprint, algorithm_version: s.algorithm_version, last_observed_at: observedAt, last_observed_scan_id: scanId, absence_count: 0, last_absence_scan_id: null, needs_reprocess: false }));
  for (const batch of batches(rows)) await store.commitBatch(batch);
  return { ...comparison, committed: successful.map(s => s.uuid) };
}

function createSupabasePoiStateStore(client) {
  const execute = async query => { const { data, error } = await query; if (error) throw new Error(error.message); return data; };
  return {
    // POST body avoids the >16KB URL produced by 500 UUIDs in GET .in().
    loadBatch: ids => execute(client.rpc("sortir_load_datatourisme_poi_states", { p_uuids: ids })),
    observeBatch: (ids, observedAt, scanId) => execute(client.rpc("sortir_observe_datatourisme_poi_states", { p_uuids: ids, p_observed_at: observedAt, p_scan_id: scanId })),
    commitBatch: rows => execute(client.from("sortir_datatourisme_poi_states").upsert(rows, { onConflict: "poi_uuid" }))
  };
}

module.exports = { FINGERPRINT_VERSION, STATE_BATCH_SIZE, fingerprintCalculatedPoi, calculatePoiState, calculatePoiStateBatch, comparePoiStates, processPoiStateBatch, createSupabasePoiStateStore };
