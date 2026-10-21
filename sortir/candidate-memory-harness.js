"use strict";
// Offline fixture only. Indexed storage avoids attributing O(N²) mock hydration
// to the candidate algorithm itself. Counts approximate PostgREST pages of 500.
const { harness } = require("./test-datatourisme-poi-reconciliation");
const { activityToRow, payloadHash, canonicalActivityPayload } = require("./supabase-persistence");
const { normalizeActivity } = require("./activity-validation");
const NOW = new Date("2026-10-21T08:00:00Z");
function activity(n = 0, extra = {}) {
  return normalizeActivity({ title: `Manifestation ${n}`, startsAt: "2026-11-01T12:00:00Z", endsAt: "2026-11-01T14:00:00Z", timezone: "UTC", city: "Paris", address: "1 rue du test",
    latitude: 48, longitude: 2, locationType: "physical", country: "FR", confidence: 0.9,
    organizers: [{ name: "Association des arts", url: "https://example.org/organizer" }],
    provenances: [{ sourceType: "api", sourceName: "DATAtourisme", originalEventUrl: `https://example.org/event/${n}`, fetchedAt: NOW.toISOString() }], ...extra, provenances: (extra.provenances || [{ originalEventUrl: `https://example.org/event/${n}` }]).map(p => ({ sourceType: "api", sourceName: "DATAtourisme", fetchedAt: NOW.toISOString(), ...p })) });
}
function item(n, extra) { return { sourceRecordId: `record-${n}`, sourceOccurrenceKey: `occurrence-${n}`, activity: activity(n, extra) }; }
function descriptor(results, key = "datatourisme-national") { return { key, connectorType: "datatourisme", baseUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent", results }; }
function store() {
  const s = harness().activityStore, byId = new Map(), byActivity = new Map(), external = new Map(), provenance = new Map();
  s.metrics = { candidateRows: 0, candidatePages: 0, candidateBytes: 0, activityReads: 0, activityBytes: 0 };
  s.decisions = [];
  s.ensureSource = async d => {
    let row = s.sources.find(x => x.key === d.key);
    if (!row) { row = { id: `source-${s.sources.length}`, key: d.key, connector_type: d.connectorType, base_url: d.baseUrl }; s.sources.push(row); }
    return row;
  };
  s.hydrate = row => ({ ...row, provenances: (byActivity.get(row.id) || []).map(p => ({ ...p, source: s.sources.find(x => x.id === p.source_id) })), external_ids: (external.get(row.id) || []).map(e => ({ ...e })) });
  s.getActivity = async id => s.hydrate(byId.get(id));
  s.getActivitiesBatch = async ids => { s.metrics.activityReads += Math.ceil(ids.length / 500); const rows = ids.map(id => byId.get(id)).filter(Boolean).map(s.hydrate); s.metrics.activityBytes += Buffer.byteLength(JSON.stringify(rows)); return rows; };
  s.findProvenance = async (sid, record, key) => provenance.get(JSON.stringify([sid, record, key]));
  s.findProvenancesBatch = async (sid, keys) => { const set = new Set(keys); return s.provenances.filter(p => p.source_id === sid && set.has(p.source_occurrence_key)).map(p => ({ ...p })); };
  s.createActivity = async row => { const a = { id: s.id("activity"), ...row }; s.activities.push(a); byId.set(a.id, a); return { ...a }; };
  s.updateActivity = async (id, patch) => { const a = byId.get(id); Object.assign(a, patch); return { ...a }; };
  s.createProvenanceIdempotent = async row => {
    const key = JSON.stringify([row.source_id, row.source_record_id, row.source_occurrence_key]);
    if (provenance.has(key)) return { ...provenance.get(key) };
    const p = { id: s.id("provenance"), ...row }; s.provenances.push(p); provenance.set(key, p);
    if (!byActivity.has(p.activity_id)) byActivity.set(p.activity_id, []); byActivity.get(p.activity_id).push(p); return { ...p };
  };
  s.upsertExternalIds = async (aid, sid, ids) => {
    if (!external.has(aid)) external.set(aid, []); const rows = external.get(aid);
    for (const e of ids) if (!rows.some(x => x.source_id === sid && x.system === e.system && x.value === e.value)) { const row = { activity_id: aid, source_id: sid, ...e }; rows.push(row); s.externalIds.push(row); }
  };
  s.insertDedupDecision = async row => { if (row.left_activity_id !== row.right_activity_id) s.decisions.push(row); };
  const collect = rows => { rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); const hydrated = rows.map(s.hydrate); s.metrics.candidateRows += rows.length; s.metrics.candidatePages += Math.floor(rows.length / 500) + 1; s.metrics.candidateBytes += Buffer.byteLength(JSON.stringify(hydrated)); return hydrated; };
  s.listCandidateActivitiesInRange = async (a, b) => collect(s.activities.filter(r => ["active", "review"].includes(r.record_status) && Date.parse(r.starts_at) >= Date.parse(a) && Date.parse(r.starts_at) <= Date.parse(b)));
  s.listCandidateActivitiesInWindows = async windows => collect(s.activities.filter(r => ["active", "review"].includes(r.record_status) && windows.some(w => Date.parse(r.starts_at) >= w.start && Date.parse(r.starts_at) < w.end)));
  s.seed = async (input, id, { recordStatus = "active", recordId = `seed-${id}`, key = `seed-${id}`, sourceKey = "datatourisme-national" } = {}) => {
    const d = descriptor([], sourceKey), source = await s.ensureSource(d), a = { ...activityToRow(input, recordStatus), id };
    s.activities.push(a); byId.set(id, a);
    await s.createProvenanceIdempotent({ activity_id: id, source_id: source.id, source_record_id: recordId, source_occurrence_key: key, payload_hash: payloadHash(canonicalActivityPayload(input)), active: true,
      last_seen_at: "2026-10-20T08:00:00Z", original_event_url: input.provenances[0]?.originalEventUrl });
    await s.upsertExternalIds(id, source.id, input.externalIds);
  };
  return s;
}
function businessSnapshot(s) {
  const ignore = new Set(["updated_at", "last_seen_at", "first_seen_at"]);
  return JSON.parse(JSON.stringify({ activities: s.activities, provenances: s.provenances, externalIds: s.externalIds, items: s.items, decisions: s.decisions }, (key, value) => ignore.has(key) ? undefined : value));
}
module.exports = { NOW, activity, item, descriptor, store, businessSnapshot };
