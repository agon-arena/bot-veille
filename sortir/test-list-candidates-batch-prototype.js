"use strict";

// Test de RÉGRESSION réel (plus un prototype) : vérifie que le pipeline réel
// (persistSortirIngestionUnlocked + createSupabaseSortirStore via la Map applicative
// candidateIndex, désormais implémentée) produit les décisions MATCH/REVIEW/DISTINCT
// attendues sur un lot volontairement piégeux. Ce fichier a d'abord servi de prototype
// isolé (comparant deux implémentations factices de listCandidateActivities côte à côte,
// AVANT l'implémentation réelle) : cette comparaison A/B n'a plus de sens une fois
// l'index intégré directement dans l'orchestrateur — il n'y a plus qu'UN seul chemin.
// Conservé (et adapté, pas supprimé) comme demandé, avec le même lot/mêmes scénarios
// piégeux, plus : décompte exact des appels à listCandidateActivitiesInRange, exclusion
// d'une activité déjà "merged", et idempotence sur un second passage complet.

const assert = require("assert");
const { persistSortirIngestion } = require("./supabase-persistence");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error.message}`); } }

// ---------------------------------------------------------------------------------------
// Store de référence, aligné sur l'interface RÉELLE (listCandidateActivitiesInRange, pas
// l'ancien listCandidateActivities par occurrence) : un seul chemin, celui réellement
// exécuté par persistSortirIngestionUnlocked.
// ---------------------------------------------------------------------------------------
class MemoryStore {
  constructor() {
    this.seq = 0; this.sources = []; this.ingestions = []; this.sourceRuns = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.decisions = [];
    this.calls = { listCandidateActivitiesInRange: 0 };
  }
  id(p) { this.seq += 1; return `${p}-${this.seq}`; }
  async ensureSource(row) { let f = this.sources.find(x => x.key === row.key); if (!f) { f = { id: this.id("src"), key: row.key, connector_type: row.connectorType, base_url: row.baseUrl }; this.sources.push(f); } return f; }
  async createIngestionRun(row) { const v = { id: this.id("ing"), ...row }; this.ingestions.push(v); return v; }
  async updateIngestionRun(id, row) { Object.assign(this.ingestions.find(x => x.id === id), row); }
  async createSourceRun(row) { const v = { id: this.id("run"), ...row }; this.sourceRuns.push(v); return v; }
  async updateSourceRun(id, row) { Object.assign(this.sourceRuns.find(x => x.id === id), row); }
  async findProvenance(sourceId, recordId, key) { return this.provenances.find(x => x.source_id === sourceId && (x.source_record_id || "") === (recordId || "") && x.source_occurrence_key === key) || null; }
  async findProvenancesBatch(sourceId, keys) { const s = new Set(keys); return this.provenances.filter(x => x.source_id === sourceId && s.has(x.source_occurrence_key)); }
  hydrate(row) { return { ...row, provenances: this.provenances.filter(p => p.activity_id === row.id).map(p => ({ ...p, source: this.sources.find(s => s.id === p.source_id) })), external_ids: this.externalIds.filter(id => id.activity_id === row.id) }; }
  async getActivity(id) { const row = this.activities.find(x => x.id === id); if (!row) throw new Error("absente"); return this.hydrate(row); }
  async getActivitiesBatch(ids) { const s = new Set(ids); return this.activities.filter(x => s.has(x.id)).map(x => this.hydrate(x)); }
  // Même filtre/colonnes que l'ancien listCandidateActivities(activity), mais sur une PLAGE
  // [startIso, endIso] au lieu d'un ±12h autour d'une seule activité -- exactement
  // l'interface réellement appelée par persistSortirIngestionUnlocked (candidateIndex).
  async listCandidateActivitiesInRange(startIso, endIso) {
    this.calls.listCandidateActivitiesInRange += 1;
    const start = Date.parse(startIso), end = Date.parse(endIso);
    return this.activities.filter(x => ["active", "review"].includes(x.record_status) && Date.parse(x.starts_at) >= start && Date.parse(x.starts_at) <= end).map(x => this.hydrate(x));
  }
  async createActivity(row) { const v = { id: this.id("act"), merged_into_id: null, ...row }; this.activities.push(v); return v; }
  async updateActivity(id, row) { const v = this.activities.find(x => x.id === id); Object.assign(v, row); return v; }
  async markActivityMerged(id, cid) { return this.updateActivity(id, { record_status: "merged", merged_into_id: cid }); }
  async updateProvenance(id, row) { const v = this.provenances.find(x => x.id === id); Object.assign(v, row); return v; }
  async touchProvenancesBatch(ids, touch) { const s = new Set(ids); for (const p of this.provenances) if (s.has(p.id)) Object.assign(p, touch); }
  async moveProvenances() {} async moveExternalIds() {}
  async createProvenanceIdempotent(row) { const conflict = this.provenances.find(x => x.source_id === row.source_id && (x.source_record_id || "") === (row.source_record_id || "") && x.source_occurrence_key === row.source_occurrence_key); if (conflict) return conflict; const v = { id: this.id("prov"), ...row }; this.provenances.push(v); return v; }
  async upsertExternalIds(aid, sid, ids) { for (const id of ids) if (!this.externalIds.some(x => x.activity_id === aid && x.source_id === sid && x.system === id.system && x.value === id.value)) this.externalIds.push({ activity_id: aid, source_id: sid, system: id.system, value: id.value }); }
  async insertCollectionItem(row) { const v = { id: this.id("item"), ...row }; this.items.push(v); return v; }
  async insertCollectionItemsBatch(rows) { for (const row of rows) this.items.push({ id: this.id("item"), ...row }); }
  async insertDedupDecision(row) { if (row.left_activity_id === row.right_activity_id) return null; if (!this.decisions.some(x => x.left_activity_id === row.left_activity_id && x.right_activity_id === row.right_activity_id && x.algorithm_version === row.algorithm_version)) this.decisions.push({ id: this.id("decision"), ...row }); }
  async applyDisappearances() {}
  async countFinalActivities() { return this.activities.filter(x => x.record_status === "active").length; }
}

function sourceDescriptor(key, baseUrl, connectorType, results) { return { key, connectorType, baseUrl, results }; }
function item(activity, sourceRecordId, sourceOccurrenceKey) { return { activity, sourceRecordId, sourceOccurrenceKey: sourceOccurrenceKey || `${sourceRecordId}@${activity.startsAt}` }; }
function a(overrides) {
  return {
    title: "Événement", description: null, startsAt: null, endsAt: null, timezone: "Europe/Paris",
    lifecycleStatus: "scheduled", locationType: "physical", venueName: null, address: null, postalCode: null,
    city: null, country: "FR", latitude: null, longitude: null, onlineUrl: null, organizers: [],
    category: null, subcategory: null, tags: [], imageUrl: null, bookingUrl: null, admissionType: "unknown",
    confidence: 0.9, fieldConfidence: {}, evidence: [], provenances: [], externalIds: [],
    ...overrides
  };
}
const NOW = new Date("2026-11-25T00:00:00.000Z");

// --- Composition du lot (déterministe) ---

// Préexistant (setup, source "oa") : candidat déjà en base avant le lot mesuré.
const existing1 = a({
  title: "Festival des Lumières", startsAt: "2026-11-10T18:00:00.000Z", endsAt: "2026-11-10T20:00:00.000Z",
  city: "Senlis", venueName: "Place du marché", latitude: 49.2, longitude: 2.58,
  organizers: [{ name: "Mairie de Senlis" }],
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/existing1", externalId: "festival-lumieres", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "festival-lumieres" }]
});
const existingForInterSource = a({
  title: "Concert Symphonique", startsAt: "2026-12-10T20:00:00.000Z", endsAt: "2026-12-10T22:00:00.000Z",
  city: "Senlis", venueName: "Cathédrale", latitude: 49.21, longitude: 2.59,
  organizers: [{ name: "Orchestre de Senlis" }],
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/concert-symph", externalId: "concert-symphonique", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "concert-symphonique" }]
});
const boundaryCandidate = a({
  title: "Salon du Livre", startsAt: "2026-12-01T12:00:00.000Z", endsAt: "2026-12-01T18:00:00.000Z",
  city: "Nantes", venueName: "Parc des expositions", latitude: 47.22, longitude: -1.55,
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/salon-livre", externalId: "salon-livre-nantes", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "salon-livre-nantes" }]
});
const SETUP_ITEMS = [
  item(existing1, "existing1"),
  item(existingForInterSource, "existingForInterSource"),
  item(boundaryCandidate, "boundaryCandidate")
];

// --- Lot mesuré (ordre déterministe) ---

// 1) MATCH avec un candidat PRÉEXISTANT (même source, même externalId, 30 min plus tard).
const item1_matchExisting = item(a({
  title: "Festival des Lumières", startsAt: "2026-11-10T18:30:00.000Z", endsAt: "2026-11-10T20:30:00.000Z",
  city: "Senlis", venueName: "Place du marché", latitude: 49.2, longitude: 2.58,
  organizers: [{ name: "Mairie de Senlis" }],
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/item1", externalId: "festival-lumieres", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "festival-lumieres" }]
}), "item1");

// 2) + 3) MATCH INTRA-LOT (ville Lyon) : item3 doit matcher l'activité que item2 vient de créer
//    PLUS TÔT dans ce même lot — jamais vue en base avant le lot.
const item2_newDistinctForNow = item(a({
  title: "Marché de Noël", startsAt: "2026-11-15T10:00:00.000Z", endsAt: "2026-11-15T20:00:00.000Z",
  city: "Lyon", venueName: "Place Bellecour", latitude: 45.76, longitude: 4.83,
  organizers: [{ name: "Ville de Lyon" }],
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/item2", externalId: "marche-noel-lyon", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "marche-noel-lyon" }]
}), "item2");
const item3_matchesItem2 = item(a({
  title: "Marché de Noël", startsAt: "2026-11-15T10:15:00.000Z", endsAt: "2026-11-15T20:15:00.000Z",
  city: "Lyon", venueName: "Place Bellecour", latitude: 45.76, longitude: 4.83,
  organizers: [{ name: "Ville de Lyon" }],
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/item3", externalId: "marche-noel-lyon", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "marche-noel-lyon" }]
}), "item3");

// 4) + 5) REVIEW INTRA-LOT (ville Marseille), aucun externalId partagé, similarité de
//    contenu probable (titre ≥0.82 <0.92, même lieu, organisateurs différents pour éviter
//    un vrai MATCH composite) : item5 doit produire REVIEW avec l'activité créée par item4
//    plus tôt dans ce même lot.
const item4_reviewBase = item(a({
  title: "Fête de la Mer", startsAt: "2026-11-20T15:00:00.000Z", endsAt: "2026-11-20T23:00:00.000Z",
  city: "Marseille", venueName: "Vieux-Port", latitude: 43.30, longitude: 5.37,
  organizers: [{ name: "Office du tourisme" }],
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/item4", externalId: "fete-mer-A", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "fete-mer-A" }]
}), "item4");
const item5_reviewsAgainstItem4 = item(a({
  title: "Fête de la Mer - édition", startsAt: "2026-11-20T16:00:00.000Z", endsAt: "2026-11-21T00:00:00.000Z",
  city: "Marseille", venueName: "Vieux-Port", latitude: 43.30, longitude: 5.37,
  organizers: [{ name: "Comité des fêtes" }],
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/item5", externalId: "fete-mer-B", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "fete-mer-B" }]
}), "item5");

// 6) DISTINCT réelle (ville Bordeaux, créneau isolé).
const item6_distinct = item(a({
  title: "Exposition unique", startsAt: "2027-03-01T09:00:00.000Z", endsAt: "2027-03-01T18:00:00.000Z",
  city: "Bordeaux", venueName: "Musée d'Aquitaine", latitude: 44.84, longitude: -0.58,
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/item6", externalId: "expo-unique-bordeaux", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "expo-unique-bordeaux" }]
}), "item6");

// 7) Frontière ±12h — À L'INTÉRIEUR (11h59 après boundaryCandidate, même externalId/source) :
//    doit toujours être trouvée candidate → MATCH.
const item7_boundaryInside = item(a({
  title: "Salon du Livre", startsAt: "2026-12-01T23:59:00.000Z", endsAt: "2026-12-02T05:59:00.000Z",
  city: "Nantes", venueName: "Parc des expositions", latitude: 47.22, longitude: -1.55,
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/item7", externalId: "salon-livre-nantes", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "salon-livre-nantes" }]
}), "item7");
// 8) Frontière ±12h — À L'EXTÉRIEUR (12h01 après boundaryCandidate) : ne doit PLUS jamais être
//    trouvée candidate (exclusion au niveau de la fenêtre elle-même) → DISTINCT.
const item8_boundaryOutside = item(a({
  title: "Salon du Livre", startsAt: "2026-12-02T00:01:00.000Z", endsAt: "2026-12-02T06:01:00.000Z",
  city: "Nantes", venueName: "Parc des expositions", latitude: 47.22, longitude: -1.55,
  provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/item8", externalId: "salon-livre-nantes", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "openagenda-event", value: "salon-livre-nantes" }]
}), "item8");

// 9) INTER-SOURCES : source Mobilizon ("mz"), MÊME événement que existingForInterSource, mais
//    AUCUNE identité partagée possible (sourceUrl/sourceName différents -> provenanceCompatible
//    structurellement faux) : seule l'heuristique de contenu (titre quasi-identique, créneau
//    ≤5min, même lieu, organisateur identique) peut produire un MATCH.
const item9_interSourceMatch = item(a({
  title: "Concert Symphonique", startsAt: "2026-12-10T20:02:00.000Z", endsAt: "2026-12-10T22:02:00.000Z",
  city: "Senlis", venueName: "Cathédrale", latitude: 49.21, longitude: 2.59,
  organizers: [{ name: "Orchestre de Senlis" }],
  provenances: [{ sourceType: "api", sourceName: "mz", sourceUrl: "https://mz.example/api", originalEventUrl: "https://mz.example/e/item9", externalId: "mz-event-1", fetchedAt: NOW.toISOString() }],
  externalIds: [{ system: "mobilizon", value: "mz-event-1" }]
}), "item9");

const OA_RESULTS = [item1_matchExisting, item2_newDistinctForNow, item3_matchesItem2, item4_reviewBase, item5_reviewsAgainstItem4, item6_distinct, item7_boundaryInside, item8_boundaryOutside];
const MZ_RESULTS = [item9_interSourceMatch];

async function runSetup(store) {
  await persistSortirIngestion({ store, sources: [sourceDescriptor("oa", "https://oa.example/api", "openagenda_json", SETUP_ITEMS)], now: NOW });
}
async function runMeasuredLot(store, now = NOW) {
  return persistSortirIngestion({
    store,
    sources: [
      sourceDescriptor("oa", "https://oa.example/api", "openagenda_json", OA_RESULTS),
      sourceDescriptor("mz", "https://mz.example/api", "mobilizon", MZ_RESULTS)
    ],
    now
  });
}

function activitySnapshot(store) {
  return store.activities.map(a2 => ({ title: a2.title, starts_at: a2.starts_at, city: a2.city, record_status: a2.record_status, merged_into_id: a2.merged_into_id })).sort((x, y) => (x.title + x.starts_at).localeCompare(y.title + y.starts_at));
}
function decisionsSnapshot(store) {
  // Ordre préservé volontairement (pas de tri) : l'ordre fait partie de ce qu'on compare.
  return store.decisions.map(d => {
    const left = store.activities.find(a2 => a2.id === d.left_activity_id);
    const right = store.activities.find(a2 => a2.id === d.right_activity_id);
    return { decision: d.decision, left_title: left && left.title, right_title: right && right.title };
  });
}

(async () => {
  const store = new MemoryStore();

  await runSetup(store);
  const result = await runMeasuredLot(store);

  await test("Décisions attendues sur le lot piégeux (MATCH préexistant, intra-lot, frontières, inter-sources)", async () => {
    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.stats.merged, 4, "item1->existing1, item3->item2(intra-lot), item7->boundaryCandidate(frontière ±12h), item9->existingForInterSource(inter-sources) : 4 MATCH attendus");
    assert(store.decisions.some(d => d.decision === "REVIEW"), "item5 doit produire une décision REVIEW contre item4");
  });

  await test("MATCH intra-lot (item2 puis item3, jamais vus en base avant ce lot)", async () => {
    const lyon = store.activities.filter(a2 => a2.city === "Lyon");
    assert.strictEqual(lyon.filter(a2 => a2.record_status === "active").length, 1, "item2+item3 fusionnés en une seule activité active");
  });

  await test("REVIEW intra-lot (item4/item5) : deux activités séparées, une décision REVIEW les relie", async () => {
    const marseille = store.activities.filter(a2 => a2.city === "Marseille");
    assert.strictEqual(marseille.length, 2, "REVIEW ne fusionne jamais : item4 et item5 restent deux activités distinctes");
    assert(decisionsSnapshot(store).some(d => d.decision === "REVIEW" && d.left_title === "Fête de la Mer" && d.right_title === "Fête de la Mer - édition"));
  });

  await test("DISTINCT réelle (item6, Bordeaux, créneau isolé)", async () => {
    const bordeaux = store.activities.filter(a2 => a2.city === "Bordeaux");
    assert.strictEqual(bordeaux.length, 1);
    assert.strictEqual(bordeaux[0].record_status, "active");
  });

  await test("Frontières ±12h — à l'intérieur (11h59) matche, à l'extérieur (12h01) reste DISTINCT", async () => {
    const salon = store.activities.filter(a2 => a2.title === "Salon du Livre");
    const actives = salon.filter(a2 => a2.record_status === "active");
    assert.strictEqual(actives.length, 2, "boundaryCandidate+item7 fusionnés (1 activité active) + item8 resté séparé (1 activité active) = 2 activités 'Salon du Livre' actives");
  });

  await test("Inter-sources — le MATCH mz/oa (via contenu, pas via identité partagée) relie bien les deux provenances à UNE activité", async () => {
    const act = store.activities.find(a2 => a2.title === "Concert Symphonique");
    assert(act, "l'activité cible doit exister");
    assert.strictEqual(act.record_status, "active");
    const linked = store.provenances.filter(p => p.activity_id === act.id);
    assert(linked.some(p => p.source_id === store.sources.find(s => s.key === "oa").id));
    assert(linked.some(p => p.source_id === store.sources.find(s => s.key === "mz").id), "la provenance mz (item9) doit avoir rejoint la MÊME activité, trouvée via candidateIndex malgré l'absence d'identité partagée");
  });

  await test("Index des candidats : exactement 1 préchargement groupé par source ayant au moins une nouvelle occurrence (jamais un par occurrence)", async () => {
    // setup (1 source "oa", 3 nouvelles) + lot mesuré (1 source "oa" 8 nouvelles + 1 source
    // "mz" 1 nouvelle) = 3 préchargements groupés, jamais 3+8+1=12 comme l'aurait fait
    // l'ancien listCandidateActivities appelé une fois par occurrence.
    assert.strictEqual(store.calls.listCandidateActivitiesInRange, 3);
  });

  await test("Idempotence — second passage complet du même lot : aucune nouvelle activité/provenance, aucun nouveau préchargement de candidats", async () => {
    const activityIdsBefore = store.activities.map(a2 => a2.id).sort();
    const provenanceIdsBefore = store.provenances.map(p => p.id).sort();
    const callsBefore = store.calls.listCandidateActivitiesInRange;
    const second = await runMeasuredLot(store, new Date(NOW.getTime() + 1000));
    assert.strictEqual(second.status, "completed");
    assert.deepStrictEqual(store.activities.map(a2 => a2.id).sort(), activityIdsBefore, "aucune activité créée ou perdue au second passage");
    assert.deepStrictEqual(store.provenances.map(p => p.id).sort(), provenanceIdsBefore, "aucune provenance créée ou perdue au second passage");
    assert.strictEqual(store.calls.listCandidateActivitiesInRange, callsBefore, "toutes les occurrences sont désormais connues : aucun préchargement de candidats déclenché");
  });

  console.log("\n=== Résumé (pour le compte rendu) ===");
  console.log("stats (lot mesuré, 1er passage):", JSON.stringify(result.stats));
  console.log("appels listCandidateActivitiesInRange (setup + lot mesuré) :", 3);
  console.log("décisions de dédoublonnage, dans l'ordre :", JSON.stringify(decisionsSnapshot(store)));

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
