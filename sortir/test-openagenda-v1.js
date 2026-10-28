"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { convertOpenAgendaJsonEvent, fetchOpenAgendaJsonEvents } = require("./connectors/openagenda-json");
const { persistSortirIngestion } = require("./supabase-persistence");
const { MemoryStore } = require("./test-helpers/memory-store");
const { PRODUCERS, decisionForEvent, prepareItemForV1 } = require("./openagenda-reunion-v1");
const NOW = "2026-10-28T09:28:12Z";
const timing = (begin, end) => ({ begin, end });
function event(changes = {}) {
  return { uid: 42, title: "Exposition", description: "Photographies", timezone: "Indian/Reunion",
    canonicalUrl: "https://openagenda.com/expo/events/42", status: 1, attendanceMode: 1,
    location: { name: "Musée", city: "Saint-Denis", postalCode: "97400", countryCode: "RE", latitude: -20.88, longitude: 55.45 },
    timings: [timing("2026-11-01T09:00:00+04:00", "2026-11-01T17:00:00+04:00")], ...changes };
}
const options = { now: NOW, fetchedAt: NOW, agendaUid: 1, sourceName: "Expo", sourceUrl: "https://api.openagenda.com/v2/agendas/1/events" };
function source(key, results) { return { key, connectorType: "openagenda_json", baseUrl: `https://api.openagenda.com/v2/agendas/${key}/events`, results }; }
async function ingest(db, sources) { return persistSortirIngestion({ store: db, sources, now: new Date(NOW), reconcileDisappearances: false }); }
test("futur, mono-créneau en cours, passé, fin exacte et passé sans fin", () => {
  assert.equal(convertOpenAgendaJsonEvent(event(), options).length, 1);
  for (const [t, count] of [
    [timing("2026-10-28T09:00:00+04:00", "2026-10-28T17:00:00+04:00"), 1],
    [timing("2026-10-27T09:00:00+04:00", "2026-10-27T17:00:00+04:00"), 0],
    [timing("2026-10-28T09:00:00Z", NOW), 0],
    [{ begin: "2026-10-27T09:00:00+04:00" }, 0]
  ]) assert.equal(convertOpenAgendaJsonEvent(event({ timings: [t] }), options).length, count);
});
test("événement multi-créneaux : passé exclu, en cours et futur conservés sans synthèse", () => {
  const timings = [timing("2026-10-27T09:00:00+04:00", "2026-10-27T17:00:00+04:00"), timing("2026-10-28T09:00:00+04:00", "2026-10-28T17:00:00+04:00"), ...event().timings];
  const rows = convertOpenAgendaJsonEvent(event({ timings }), options);
  assert.deepEqual(rows.map(r => r.index), [1, 2]);
  assert.deepEqual(rows.map(r => r.activity.startsAt), timings.slice(1).map(t => new Date(t.begin).toISOString()));
});
test("600 occurrences : aucune limite implicite et métadonnées communes sans répétition des timings", () => {
  const timings = Array.from({ length: 600 }, (_, i) => {
    const begin = new Date(Date.parse("2026-11-01T00:00:00Z") + i * 86400000);
    return timing(begin.toISOString(), new Date(+begin + 3600000).toISOString());
  });
  const rows = convertOpenAgendaJsonEvent(event({ timings }), options);
  assert.equal(rows.length, 600);
  assert.equal(new Set(rows.map(r => r.activity.startsAt)).size, 600);
  assert.equal(rows[0].sourcePayload.eventMetadata, rows[599].sourcePayload.eventMetadata);
  assert.equal(rows[0].sourcePayload.eventMetadata.timings, undefined);
  assert.equal(rows.some(r => r.validation.warnings.some(w => w.code === "occurrences_truncated")), false);
});
test("plafond explicite après sélection temporelle seulement, signalé", () => {
  const timings = Array.from({ length: 40 }, (_, i) => timing(new Date(Date.parse("2026-10-01T00:00:00Z") + i * 86400000).toISOString(), new Date(Date.parse("2026-10-01T01:00:00Z") + i * 86400000).toISOString()));
  const rows = convertOpenAgendaJsonEvent(event({ timings }), { ...options, maxOccurrencesPerEvent: 3 });
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => Date.parse(r.activity.startsAt) > Date.parse(NOW)));
  assert.ok(rows[2].validation.warnings.some(w => w.code === "occurrences_truncated"));
});
test("codes postaux conservés ; absence non inventée malgré coordonnées exploitables", () => {
  assert.equal(convertOpenAgendaJsonEvent(event(), options)[0].activity.postalCode, "97400");
  const e = event({ location: { ...event().location, postalCode: null } });
  const r = convertOpenAgendaJsonEvent(e, options)[0];
  assert.equal(r.activity.postalCode, null);
  assert.equal(r.activity.latitude, -20.88);
  assert.equal(r.sourcePayload.eventMetadata.location.city, "Saint-Denis");
});
test("status/attendanceMode labellisés lus sans perte du mode en ligne", () => {
  const e = event({ status: { id: 6, label: "Annulé" }, attendanceMode: { id: 2, label: "En ligne" }, onlineAccessLink: "https://example.org/live" });
  const r = convertOpenAgendaJsonEvent(e, options)[0];
  assert.equal(r.activity.lifecycleStatus, "cancelled");
  assert.equal(r.activity.locationType, "online");
});
test("métadonnées structurées persistées et actualisées même si le hash métier est inchangé", async () => {
  const db = new MemoryStore();
  const e = event({ "types-devenement": { id: 4, label: "Exposition" }, keywords: ["photo"], conditions: "Gratuit", longDescription: "Texte complet", rights: { license: { id: "etalab-2.0" } }, imageCredits: "Auteur" });
  const rows = () => convertOpenAgendaJsonEvent(e, options);
  await ingest(db, [source("a", rows())]);
  const payload = db.provenances[0].source_payload;
  assert.equal(payload.eventMetadata["types-devenement"].label, "Exposition");
  assert.equal(payload.eventMetadata.shortDescription, "Photographies");
  assert.equal(payload.eventMetadata.longDescription, "Texte complet");
  assert.equal(payload.eventMetadata.conditions, "Gratuit");
  assert.equal(payload.eventMetadata.rights.license.id, "etalab-2.0");
  const hash = db.provenances[0].payload_hash;
  e["types-devenement"] = { id: 7, label: "Projection" };
  await ingest(db, [source("a", rows())]);
  assert.equal(db.activities.length, 1);
  assert.equal(db.provenances[0].payload_hash, hash);
  assert.equal(db.provenances[0].source_payload.eventMetadata["types-devenement"].label, "Projection");
});
test("relais de deux agendas et replay : une activité, deux provenances, mêmes identifiants", async () => {
  const db = new MemoryStore();
  const sources = [source("a", convertOpenAgendaJsonEvent(event(), options)), source("b", convertOpenAgendaJsonEvent(event(), { ...options, sourceName: "Relais", sourceUrl: "https://api.openagenda.com/v2/agendas/2/events" }))];
  await ingest(db, sources);
  const before = { id: db.activities[0].id, prov: db.provenances.length, ids: db.externalIds.length };
  assert.equal(db.activities.length, 1);
  assert.equal(before.prov, 2);
  await ingest(db, sources);
  assert.equal(db.activities.length, 1);
  assert.equal(db.activities[0].id, before.id);
  assert.equal(db.provenances.length, before.prov);
  assert.equal(db.externalIds.length, before.ids);
  assert.equal(db.activities.filter(a => a.record_status === "active").length, 1);
});
test("périmètre V1 fermé : cinq producteurs, pas d'activation d'événement inconnu", () => {
  assert.equal(PRODUCERS.length, 5);
  assert.equal(decisionForEvent(68013649).retain, true);
  assert.ok(decisionForEvent(43961004).review);
  assert.equal(decisionForEvent(59485599).retain, false);
  assert.equal(decisionForEvent(999999).retain, false);
});
test("lecture réelle simulée : current + upcoming, emprise, pagination et lots bornés", async () => {
  const originalFetch = global.fetch;
  const calls = [], batchSizes = [];
  const timings = Array.from({ length: 305 }, (_, i) => {
    const begin = new Date(Date.parse("2026-11-01T00:00:00Z") + i * 86400000);
    return timing(begin.toISOString(), new Date(+begin + 3600000).toISOString());
  });
  global.fetch = async url => {
    calls.push(new URL(url));
    const page = calls.length === 1 ? { total: 2, events: [event({ timings })], after: ["next", "42"] } : { total: 2, events: [event({ uid: 43 })], after: null };
    return { ok: true, text: async () => JSON.stringify(page) };
  };
  try {
    const result = await fetchOpenAgendaJsonEvents({ ...options, apiKey: "test", pageSize: 1, maxEvents: 2, occurrenceBatchSize: 40,
      geoBounding: { northEast: { lat: -20.6, lng: 56 }, southWest: { lat: -21.5, lng: 55 } },
      onBatch: async batch => { batchSizes.push(batch.length); } });
    assert.deepEqual(calls[0].searchParams.getAll("relative[]"), ["current", "upcoming"]);
    assert.equal(calls[0].searchParams.get("geo[northEast][lat]"), "-20.6");
    assert.deepEqual(calls[1].searchParams.getAll("after[]"), ["next", "42"]);
    assert.equal(result.occurrencesProduced, 306);
    assert.equal(result.results.length, 0);
    assert.ok(batchSizes.every(n => n <= 40));
    assert.equal(batchSizes.reduce((a,b) => a+b, 0), 306);
    assert.equal(result.truncated, false);
  } finally { global.fetch = originalFetch; }
});

test("réserves éditoriales réellement review après revalidation et au replay", async () => {
  const db = new MemoryStore();
  const item = prepareItemForV1(convertOpenAgendaJsonEvent(event({ uid: 43961004 }), options)[0]);
  await ingest(db, [source("review", [item])]);
  assert.equal(db.activities[0].record_status, "review");
  await ingest(db, [source("review", [item])]);
  assert.equal(db.activities[0].record_status, "review");
  assert.equal(db.activities.length, 1);
});
test("longue série persistée avec l'enveloppe existante en lots, sans écritures unitaires de création", async () => {
  const { createOpenAgendaBatchPersister } = require("./openagenda-batch-persister");
  const db = new MemoryStore();
  const begin = Date.parse("2026-11-01T00:00:00Z");
  const timings = Array.from({ length: 250 }, (_, i) => timing(new Date(begin+i*86400000).toISOString(), new Date(begin+i*86400000+3600000).toISOString()));
  const results = convertOpenAgendaJsonEvent(event({ timings }), options);
  const persist = createOpenAgendaBatchPersister({ store: db, now: NOW });
  await persist(source("series", results));
  assert.equal(db.activities.length, 250);
  assert.equal(db.provenances.length, 250);
  assert.equal(persist.stats.requests["1_activities"], 3);
  assert.equal(persist.stats.requests["3_provenances"], 3);
  assert.ok(persist.stats.maxRows <= 100);
  await persist(source("series", results));
  assert.equal(db.activities.length, 250);
  assert.equal(db.provenances.length, 250);
  assert.equal(persist.stats.requests["1_activities"], 3);
});
test("échec de lot : arrêt avant la tranche suivante et aucune publication du staging", async () => {
  const { createOpenAgendaBatchPersister } = require("./openagenda-batch-persister");
  const db = new MemoryStore();
  let calls = 0;
  db.createProvenancesBatch = async () => { calls++; throw new Error("panne simulée"); };
  const begin = Date.parse("2026-11-01T00:00:00Z");
  const timings = Array.from({length:101},(_,i)=>timing(new Date(begin+i*86400000).toISOString(),new Date(begin+i*86400000+3600000).toISOString()));
  const persist = createOpenAgendaBatchPersister({store:db,now:NOW});
  await assert.rejects(persist(source("fail",convertOpenAgendaJsonEvent(event({timings}),options))),/incomplète/);
  assert.equal(calls,1);
  assert.equal(db.activities.length,100);
  assert.equal(db.activities.some(a=>a.record_status==="active"),false);
});
test("un même événement garde ses séances du matin/après-midi malgré UID et URL partagés", async () => {
  const timings=[timing("2026-11-01T10:00:00+04:00","2026-11-01T10:45:00+04:00"),timing("2026-11-01T14:30:00+04:00","2026-11-01T15:15:00+04:00")];
  const rows=convertOpenAgendaJsonEvent(event({timings}),options);
  const comparison=require("./activity-deduplication").compareActivities(rows[0].activity,rows[1].activity);
  assert.equal(comparison.decision,"DISTINCT");
  const db=new MemoryStore();
  const sources=[source("a",rows),source("b",convertOpenAgendaJsonEvent(event({timings}),{...options,sourceName:"Relais",sourceUrl:"https://api.openagenda.com/v2/agendas/2/events"}))];
  await ingest(db,sources);await ingest(db,sources);
  assert.equal(db.activities.length,2);
  assert.equal(db.provenances.length,4);
});
