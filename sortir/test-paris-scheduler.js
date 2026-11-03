"use strict";
// Producteur « Que faire à Paris » : filtre éditorial, lecture paginée complète avant écriture,
// branchement dans le cycle quotidien et continuité avec l'essai du 18/10/2026. Aucun réseau réel.
const test = require("node:test"), assert = require("node:assert/strict");
const { isEditorialParisRecord, fetchAllParisEvents, PARIS_PAGE_SIZE, DEFAULT_ENDPOINT } = require("./connectors/paris-events");
const { MemoryStore } = require("./test-helpers/memory-store"), { schedulerClient } = require("./test-helpers/scheduler-client");
const { createSchedulerState } = require("./scheduler-state"), { readCycleStatus } = require("./scheduler-cycle-status");
const { runSortirIngestTickIfDue, PARIS_SOURCES } = require("../sortir-auto-ingest");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };

const base = require("./fixtures/paris-events.json").results[0];
const record = (id, tags, extra = {}) => ({ ...base, id: String(id), event_id: 1000 + id, url: `https://quefaire.paris.fr/${id}/evenement`, qfap_tags: tags,
  date_start: "2026-11-20T18:00:00+00:00", date_end: "2026-11-20T20:00:00+00:00", title: `Rencontre ${id}`, ...extra });
function fakeApi(records, { failAtOffset = null, totalDrift = false } = {}) {
  const calls = [];
  const fetchImpl = async input => {
    const url = new URL(input), offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
    calls.push({ offset, limit, where: url.searchParams.get("where"), orderBy: url.searchParams.get("order_by") });
    if (offset === failAtOffset) return new Response("erreur", { status: 503 });
    const total = records.length + (totalDrift && offset > 0 ? 1 : 0);
    return new Response(JSON.stringify({ total_count: total, results: records.slice(offset, offset + limit) }), { status: 200 });
  };
  return { calls, fetchImpl };
}
async function withFetch(fetchImpl, fn) { const old = global.fetch; global.fetch = fetchImpl; try { return await fn(); } finally { global.fetch = old; } }

test("filtre éditorial : thèmes retenus gardés, sport, concert seul et loisirs écartés", () => {
  for (const tags of ["Théâtre", "Expo;Photo", "Enfants;Théâtre", "Conférence;Histoire", "Atelier;Littérature", "Ecrans", "Atelier;Solidarité"]) assert.equal(isEditorialParisRecord({ qfap_tags: tags }), true, tags);
  for (const tags of ["Concert", "Concert;Festival", "Sport", "Expo;Sport", "Loisirs", "Atelier;Enfants;Santé", "", null]) assert.equal(isEditorialParisRecord({ qfap_tags: tags }), false, String(tags));
});

test("lecture paginée complète : toutes les pages, tri stable, en cours compris, puis filtre", async () => {
  const records = Array.from({ length: 250 }, (_, i) => record(i + 1, i % 2 ? "Théâtre" : "Concert"));
  const api = fakeApi(records);
  const out = await withFetch(api.fetchImpl, () => fetchAllParisEvents({ fetchedAt: "2026-11-03T00:00:00Z" }));
  assert.deepEqual(api.calls.map(c => c.offset), [0, 100, 200]);
  assert.ok(api.calls.every(c => c.limit === PARIS_PAGE_SIZE && c.where === "date_end >= now()" && c.orderBy === "id"));
  assert.equal(out.total, 250); assert.equal(out.scanned, 250); assert.equal(out.retained, 125); assert.equal(out.results.length, 125);
  assert.ok(out.results.every(r => r.activity.provenances[0].sourceUrl === DEFAULT_ENDPOINT));
});

test("lecture incomplète : page en échec, total modifié, plafond, doublons → erreur, rien de rendu", async () => {
  const records = Array.from({ length: 250 }, (_, i) => record(i + 1, "Théâtre"));
  await assert.rejects(withFetch(fakeApi(records, { failAtOffset: 100 }).fetchImpl, () => fetchAllParisEvents()), /HTTP 503/);
  await assert.rejects(withFetch(fakeApi(records, { totalDrift: true }).fetchImpl, () => fetchAllParisEvents()), /total modifié/);
  const big = fakeApi(records);
  await assert.rejects(withFetch(big.fetchImpl, () => fetchAllParisEvents({ maxRecords: 200 })), /plafond/);
  assert.equal(big.calls.length, 1, "plafond détecté dès la première page");
  await assert.rejects(withFetch(fakeApi([...records.slice(0, 50), ...records.slice(0, 50)]).fetchImpl, () => fetchAllParisEvents()), /doublonnée/);
});

function setup() { const db = new MemoryStore(), client = schedulerClient(db); return { db, client, state: createSchedulerState(client) }; }
const tick = (h, now, fetchParis) => runSortirIngestTickIfDue({ now: new Date(now), store: h.db, state: h.state, client: h.client, datatourismeMaxTotalPois: 0,
  openAgendaSources: [], reunionSources: [], fetchParis });

test("cycle quotidien : Paris persisté sous sa clé, rejoué le lendemain sans doublon", async () => {
  const records = [record(1, "Théâtre"), record(2, "Expo;Photo"), record(3, "Concert"), record(4, "Conférence", { date_start: "2026-11-21T18:00:00+00:00", date_end: "2026-11-21T20:00:00+00:00" })];
  const fetchParis = options => withFetch(fakeApi(records).fetchImpl, () => fetchAllParisEvents(options));
  const h = setup();
  const first = await tick(h, "2026-11-03T02:00:00Z", fetchParis), s1 = await first.workPromise;
  assert.equal(s1.status, "completed"); assert.deepEqual(s1.expectedSources, [PARIS_SOURCES[0].key]);
  assert.equal(s1.sources[0].eventsCollected, 4); assert.equal(s1.sources[0].eventsRetained, 3);
  assert.equal((await readCycleStatus(h.client, first.cycleId)).successConfirmed, true);
  const source = h.db.sources.find(s => s.key === "paris-data-que-faire");
  assert.equal(source.connector_type, "paris_data");
  const keys = h.db.provenances.filter(p => p.source_id === source.id).map(p => p.source_occurrence_key).sort();
  assert.deepEqual(keys, ["1@2026-11-20T18:00:00.000Z", "2@2026-11-20T18:00:00.000Z", "4@2026-11-21T18:00:00.000Z"]);
  const activities = h.db.activities.length;
  const second = await tick(h, "2026-11-04T02:00:00Z", fetchParis), s2 = await second.workPromise;
  assert.equal(s2.status, "completed"); assert.equal(h.db.activities.length, activities, "aucune activité dupliquée");
  assert.equal(h.db.provenances.filter(p => p.source_id === source.id).length, 3);
});

test("continuité avec l'essai du 18/10 : occurrence déjà connue reconnue, pas recréée", async () => {
  const h = setup();
  const fetchParis = options => withFetch(fakeApi([record(7, "Théâtre")]).fetchImpl, () => fetchAllParisEvents(options));
  await (await tick(h, "2026-11-03T02:00:00Z", fetchParis)).workPromise;
  const [activity] = h.db.activities, [provenance] = h.db.provenances;
  assert.equal(provenance.source_occurrence_key, "7@2026-11-20T18:00:00.000Z", "même forme de clé que l'essai du 18/10 (id@date)");
  const h2 = setup();
  h2.db.sources.push({ id: "src-ancien", key: "paris-data-que-faire", connector_type: "paris_data", base_url: DEFAULT_ENDPOINT });
  h2.db.activities.push({ ...activity, id: "act-ancien" });
  h2.db.provenances.push({ ...provenance, id: "prov-ancien", activity_id: "act-ancien", source_id: "src-ancien" });
  for (const e of h.db.externalIds) h2.db.externalIds.push({ ...e, activity_id: "act-ancien", source_id: "src-ancien" });
  const s = await (await tick(h2, "2026-11-04T02:00:00Z", fetchParis)).workPromise;
  assert.equal(s.status, "completed"); assert.equal(h2.db.activities.length, 1); assert.equal(h2.db.provenances.length, 1);
});

test("source Paris en panne : producteur en échec, rien persisté, journal explicite", async () => {
  const h = setup();
  const s = await (await tick(h, "2026-11-03T02:00:00Z", options => withFetch(fakeApi([record(1, "Théâtre")], { failAtOffset: 0 }).fetchImpl, () => fetchAllParisEvents(options)))).workPromise;
  assert.equal(s.status, "failed"); assert.match(s.sources[0].error, /HTTP 503/);
  assert.equal(h.db.activities.length, 0); assert.equal(h.db.provenances.length, 0);
});
