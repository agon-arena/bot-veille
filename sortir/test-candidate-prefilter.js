"use strict";
// Préfiltre des candidats (candidate-prefilter.js) : aucun candidat non-DISTINCT perdu, état
// d'ingestion identique à l'ancien chargement complet, repli inter-POI, pagination allégée.
// Aucun réseau, aucune base réelle.
const test = require("node:test"), assert = require("node:assert/strict");
const { createCandidatePrefilter } = require("./candidate-prefilter");
const { compareActivities, DECISIONS } = require("./activity-deduplication");
const { validateNormalizedActivity } = require("./activity-validation");
const { activityToRow, rowToActivity, persistSortirIngestion, createSupabaseSortirStore, CANDIDATE_RANGE_PAGE_SIZE } = require("./supabase-persistence");
const { MemoryStore } = require("./test-helpers/memory-store");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };

// Générateur déterministe (mulberry32) : corpus reproductible.
function prng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const BASE = Date.parse("2026-11-20T18:00:00.000Z");
const SOURCES = [{ key: "oa", connector_type: "openagenda_json", base_url: "https://oa.example/api" }, { key: "mz", connector_type: "mobilizon", base_url: "https://mz.example/api" }];
const POINTS = [[49.2071, 2.5866], [48.9362, 2.3574], [-20.8823, 55.4504], [45.764, 4.8357]];

function randomActivity(r) {
  const pick = list => list[Math.floor(r() * list.length)];
  const start = BASE + Math.round((r() * 28 - 14) * 3600000);
  const point = r() < 0.7 ? pick(POINTS) : null;
  const jitter = () => (r() - 0.5) * 0.006; // jusqu'à ~300 m
  const source = pick(SOURCES);
  return {
    title: pick(["Rencontre littéraire", "Rencontre litteraire", "Ciné-débat", "Exposition Monet", "Conférence climat"]),
    description: pick([null, "Une soirée de lecture et d'échanges autour du dernier roman de l'autrice invitée, suivie d'une dédicace en librairie."]),
    startsAt: new Date(start).toISOString(), endsAt: r() < 0.8 ? new Date(start + 7200000).toISOString() : null,
    timezone: pick(["Europe/Paris", "Indian/Reunion"]), lifecycleStatus: "scheduled", locationType: "physical",
    venueName: pick([null, "Médiathèque", "Mediatheque", "Salle des fêtes"]),
    address: pick([null, "1 place du Parvis", "1, Place du Parvis", "12 rue de la Paix", "12 Rue de la Paix "]),
    postalCode: pick([null, "60300", "93200", "97400", "69001"]),
    city: pick([null, "Senlis", "SENLIS", " Sénlis ", "Saint-Denis", "Saint Denis", "Lyon", "Paris"]),
    country: pick(["FR", null]), latitude: point && point[0] + jitter(), longitude: point && point[1] + jitter(),
    organizers: r() < 0.5 ? [{ name: pick(["Ville de Senlis", "Librairie du Parvis", "Association X"]), url: pick([null, "https://senlis.example"]) }] : [],
    confidence: 0.9, fieldConfidence: {}, evidence: [], tags: [],
    provenances: [{ sourceType: "api", sourceName: source.key, sourceUrl: source.base_url,
      originalEventUrl: pick([null, "https://oa.example/e/1", "https://OA.example/e/1/", "https://oa.example/e/1?utm_source=x", "https://oa.example/e/2", "https://other.example/x"]),
      externalId: "rec", fetchedAt: new Date(BASE).toISOString() }],
    externalIds: r() < 0.6 ? [{ system: pick(["openagenda-event", "openagenda-occurrence", "mobilizon-event"]), value: pick(["e1", " e1 ", "e2", "e3"]) }] : [],
    _source: source
  };
}
// Ligne complète telle que relue en base, et projection allégée du balayage.
function fullRow(activity, id) {
  const { _source, ...clean } = activity;
  return { id, ...activityToRow(clean, "active"),
    provenances: clean.provenances.map((p, i) => ({ id: `${id}-p${i}`, activity_id: id, source_id: _source.key, source_record_id: p.externalId,
      original_event_url: p.originalEventUrl, last_seen_at: p.fetchedAt, active: true, source_payload: { version: "x" }, source: _source })),
    external_ids: clean.externalIds.map(e => ({ activity_id: id, source_id: _source.key, system: e.system, value: e.value })) };
}
function lightRow(row) {
  return { id: row.id, starts_at: row.starts_at, city: row.city, address: row.address, latitude: row.latitude, longitude: row.longitude,
    provenances: row.provenances.map(p => ({ original_event_url: p.original_event_url })), external_ids: row.external_ids.map(e => ({ system: e.system, value: e.value })) };
}

test("fuzz : toute paire non-DISTINCT à ±12 h est conservée par le préfiltre", () => {
  const r = prng(20261102);
  const targets = Array.from({ length: 120 }, () => validateNormalizedActivity((({ _source, ...a }) => a)(randomActivity(r))).activity);
  const rows = Array.from({ length: 3000 }, (_, i) => fullRow(randomActivity(r), `act-${i}`));
  const mayMatch = createCandidatePrefilter(targets, rowToActivity);
  let compared = 0, nonDistinct = 0;
  const decisions = {};
  for (const row of rows) {
    const kept = mayMatch(lightRow(row));
    for (const target of targets) {
      if (Math.abs(Date.parse(row.starts_at) - Date.parse(target.startsAt)) > 12 * 3600000) continue;
      compared++;
      const decision = compareActivities(rowToActivity(row), target).decision;
      decisions[decision] = (decisions[decision] || 0) + 1;
      if (decision !== DECISIONS.DISTINCT) { nonDistinct++; assert.ok(kept, `candidat ${row.id} perdu (${decision})`); }
    }
  }
  const kept = rows.filter(row => mayMatch(lightRow(row))).length;
  assert.ok(compared > 100000 && decisions.MATCH > 50 && decisions.REVIEW > 50, `corpus représentatif : ${JSON.stringify(decisions)}`);
  console.log(`# ${compared} paires comparées, ${JSON.stringify(decisions)}, ${nonDistinct} non-DISTINCT toutes conservées ; ${kept}/${rows.length} lignes retenues`);
});

test("ville homonyme d'un autre département, URL et identifiant partagés : conservés ; ailleurs : écartés", () => {
  const target = validateNormalizedActivity({ title: "Rencontre", startsAt: "2026-11-20T18:00:00.000Z", city: "Saint-Denis", postalCode: "97400",
    provenances: [{ originalEventUrl: "https://oa.example/e/9" }], externalIds: [{ system: "openagenda-event", value: "e9" }] }).activity;
  const mayMatch = createCandidatePrefilter([target], rowToActivity);
  const row = over => ({ id: "x", starts_at: "2026-11-20T19:00:00.000Z", city: "Lyon", address: null, latitude: null, longitude: null, provenances: [], external_ids: [], ...over });
  assert.equal(mayMatch(row({ city: "SAINT DENIS" })), true, "homonyme 93 conservé comme le ferait le comparateur");
  assert.equal(mayMatch(row({ provenances: [{ original_event_url: "https://OA.example/e/9/?utm_campaign=z" }] })), true);
  assert.equal(mayMatch(row({ external_ids: [{ system: "OpenAgenda-Event", value: " e9 " }] })), true);
  assert.equal(mayMatch(row({})), false);
  assert.equal(mayMatch(row({ city: "Saint-Denis", starts_at: "2026-11-21T06:00:01.000Z" })), false, "au-delà de ±12 h");
});

test("cible DATAtourisme inter-POI : aucun préfiltre (repli sur le chargement complet)", () => {
  const target = validateNormalizedActivity({ title: "Visite", startsAt: "2026-11-20T18:00:00.000Z", externalIds: [{ system: "datatourisme-poi", value: "p1" }] }).activity;
  assert.equal(createCandidatePrefilter([target], rowToActivity), null);
});

// --- Ingestion complète : même état final que l'ancien chargement complet ---
function seedStore(r) {
  const store = new MemoryStore();
  const ids = { oa: "src-oa", mz: "src-mz" };
  store.sources.push({ id: ids.oa, key: "oa", connector_type: "openagenda_json", base_url: "https://oa.example/api" }, { id: ids.mz, key: "mz", connector_type: "mobilizon", base_url: "https://mz.example/api" });
  for (let i = 0; i < 2500; i++) {
    // 2 000 activités « ailleurs en France » (bruit national) et 500 du même voisinage.
    const a = randomActivity(r), id = `seed-${String(i).padStart(5, "0")}`;
    if (i < 2000) Object.assign(a, { city: `Commune ${i}`, address: `${i} rue ailleurs`, latitude: 43 + i % 70 / 10, longitude: -1 + i % 90 / 10,
      externalIds: [{ system: "openagenda-event", value: `autre-${i}` }], provenances: [{ ...a.provenances[0], originalEventUrl: `https://ailleurs.example/${i}` }] });
    const { _source, ...clean } = a;
    store.activities.push({ id, merged_into_id: null, ...activityToRow(clean, r() < 0.5 ? "active" : "review") });
    store.provenances.push({ id: `${id}-p`, activity_id: id, source_id: ids[_source.key], source_record_id: `seed-${i}`, source_occurrence_key: `seed-${i}@${a.startsAt}`,
      original_event_url: a.provenances[0].originalEventUrl, last_seen_at: a.provenances[0].fetchedAt, active: true });
    for (const e of a.externalIds) store.externalIds.push({ activity_id: id, source_id: ids[_source.key], system: e.system, value: e.value });
  }
  return store;
}
function batch(r) {
  return [{ key: "oa", connectorType: "openagenda_json", baseUrl: "https://oa.example/api",
    results: Array.from({ length: 80 }, (_, i) => { const { _source, ...a } = randomActivity(r); return { activity: { ...a, provenances: [{ ...a.provenances[0], sourceName: "oa", sourceUrl: "https://oa.example/api" }] }, sourceRecordId: `new-${i}`, sourceOccurrenceKey: `new-${i}@${a.startsAt}` }; }) }];
}
const snapshot = store => JSON.stringify({
  activities: store.activities.map(a => [a.id, a.title, a.record_status, a.starts_at, a.city, a.merged_into_id || null]),
  provenances: store.provenances.map(p => [p.id, p.activity_id, p.source_occurrence_key, p.active]),
  externalIds: store.externalIds.map(e => [e.activity_id, e.system, e.value]),
  decisions: store.decisions.map(d => [d.left_activity_id, d.right_activity_id, d.decision]),
  items: store.items.map(i => [i.activity_id, i.validation_status])
});

test("ingestion OpenAgenda : état final identique, candidats relus en entier réduits", async () => {
  const run = async withScan => {
    const store = seedStore(prng(7)), loaded = { full: 0, range: 0 };
    if (!withScan) store.scanCandidateKeysInRange = undefined;
    const batchGet = store.getActivitiesBatch.bind(store), rangeGet = store.listCandidateActivitiesInRange.bind(store);
    store.getActivitiesBatch = async ids => { loaded.full += ids.length; return batchGet(ids); };
    store.listCandidateActivitiesInRange = async (a, b) => { const rows = await rangeGet(a, b); loaded.range += rows.length; return rows; };
    const result = await persistSortirIngestion({ sources: batch(prng(11)), store, now: new Date("2026-11-19T00:00:00.000Z"), reconcileDisappearances: false });
    return { store, loaded, result };
  };
  const before = await run(false), after = await run(true);
  assert.equal(snapshot(after.store), snapshot(before.store));
  assert.deepEqual(after.result.stats, before.result.stats);
  assert.ok(before.result.stats.merged > 0 && before.result.stats.toReview > 0, `scénario avec MATCH et REVIEW : ${JSON.stringify(before.result.stats)}`);
  assert.ok(before.loaded.range > 1500, "l'ancien chemin relit toute la plage");
  assert.equal(after.loaded.range, 0, "le nouveau chemin ne relit jamais toute la plage en entier");
  assert.ok(after.loaded.full < before.loaded.range / 2, `relectures complètes : ${after.loaded.full} contre ${before.loaded.range}`);
  console.log(`# lignes complètes chargées : ancien ${before.loaded.range}, nouveau ${after.loaded.full} ; stats ${JSON.stringify(after.result.stats)}`);
});

test("store Supabase : balayage paginé, colonnes réduites, chaque page remise puis abandonnée", async () => {
  const rows = Array.from({ length: CANDIDATE_RANGE_PAGE_SIZE * 2 + 3 }, (_, i) => ({ id: `a-${String(i).padStart(5, "0")}`, record_status: "active", starts_at: "2026-11-20T18:00:00.000Z" }));
  const selects = [];
  const client = { from() { const s = {}; const q = {
    select(cols) { selects.push(cols); return q; }, in() { return q; }, gte() { return q; }, lte() { return q; }, order() { return q; },
    range(from, to) { s.from = from; s.to = to; return q; }, then(resolve) { resolve({ data: rows.slice(s.from, s.to + 1), error: null }); } }; return q; } };
  const pages = [];
  await createSupabaseSortirStore(client).scanCandidateKeysInRange("2026-11-20T00:00:00Z", "2026-11-21T00:00:00Z", page => pages.push(page.length));
  assert.deepEqual(pages, [CANDIDATE_RANGE_PAGE_SIZE, CANDIDATE_RANGE_PAGE_SIZE, 3]);
  assert.ok(selects.every(c => !c.includes("*") && !c.includes("source_payload") && !c.includes("description")));
});
