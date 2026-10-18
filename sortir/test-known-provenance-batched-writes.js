"use strict";

// Teste le batching des ÉCRITURES du cas ultra-fréquent (occurrence connue, hash identique,
// activité non-stale) : touchProvenancesBatch + insertCollectionItemsBatch, en plus des
// lectures déjà groupées (étape précédente). Les cas stale/hash différent/nouvelle occurrence
// restent individuels, inchangés — ce fichier le vérifie explicitement (C, D, E).

const assert = require("assert");
const { persistSortirIngestion, createSupabaseSortirStore, PRELOAD_CHUNK_SIZE, OCCURRENCE_KEY_CHUNK_SIZE } = require("./supabase-persistence");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error.message}`); } }

function baseActivity(source, overrides = {}) {
  const id = overrides.id || `${source}-${overrides.suffix || "1"}`;
  return {
    title: "Concert commun", description: "Description", startsAt: overrides.startsAt || "2026-11-01T19:00:00.000Z", endsAt: overrides.endsAt || "2026-11-01T21:00:00.000Z",
    timezone: "Europe/Paris", lifecycleStatus: "scheduled", locationType: "physical", venueName: "Théâtre municipal",
    address: "1 rue de Paris", postalCode: "75001", city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522,
    onlineUrl: null, bookingUrl: null, admissionType: "unknown", organizers: [{ name: "Jazz Paris", url: "https://jazz.example" }],
    category: "culture", subcategory: "concert", tags: ["jazz"], imageUrl: null, confidence: 0.95, fieldConfidence: {}, evidence: [],
    provenances: [{ sourceType: "api", sourceName: source, sourceUrl: `https://${source}.example/api`, originalEventUrl: `https://${source}.example/events/${id}`, externalId: id, fetchedAt: "2026-10-16T10:00:00Z" }],
    externalIds: [{ system: source, value: id }], ...overrides
  };
}
function item(source, overrides = {}, metadata = {}) {
  const activity = baseActivity(source, overrides);
  return { activity, sourceRecordId: metadata.sourceRecordId === undefined ? activity.provenances[0].externalId : metadata.sourceRecordId, sourceOccurrenceKey: metadata.sourceOccurrenceKey || `${activity.provenances[0].externalId}@${activity.startsAt}` };
}
function sourceDescriptor(key, results) { return { key, connectorType: key === "oa" ? "openagenda_json" : key === "mz" ? "mobilizon" : "paris_data", baseUrl: `https://${key}.example/api`, results }; }
const day = (n) => new Date(`2026-11-${String(n).padStart(2, "0")}T12:00:00Z`);
const BASE_INSTANT = Date.parse("2026-11-01T19:00:00.000Z");
// Chaque item à plus de 12h du précédent : garantit 0 MATCH/REVIEW accidentel entre les N
// items malgré un title/venue identique (cf. piège rencontré à l'étape du préchargement).
function manyKnownItems(n, { offsetDays = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const startsAt = new Date(BASE_INSTANT + (offsetDays + i) * 86400000).toISOString();
    const endsAt = new Date(BASE_INSTANT + (offsetDays + i) * 86400000 + 7200000).toISOString();
    return item("oa", { suffix: String(offsetDays + i), startsAt, endsAt });
  });
}

class MemoryStore {
  constructor() {
    this.seq = 0; this.sources = []; this.ingestions = []; this.sourceRuns = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.decisions = [];
    this.calls = { createIngestionRun: 0, updateIngestionRun: 0, ensureSource: 0, createSourceRun: 0, updateSourceRun: 0, countFinalActivities: 0, applyDisappearances: 0, findProvenance: 0, findProvenancesBatch: 0, getActivity: 0, getActivitiesBatch: 0, updateProvenance: 0, touchProvenancesBatch: 0, upsertExternalIds: 0, updateActivity: 0, insertCollectionItem: 0, insertCollectionItemsBatch: 0, listCandidateActivities: 0, createActivity: 0, createProvenanceIdempotent: 0 };
    this.failNextTouchBatch = false;
  }
  resetCalls() { for (const key of Object.keys(this.calls)) this.calls[key] = 0; }
  totalCalls() { return Object.values(this.calls).reduce((a, b) => a + b, 0); }
  id(prefix) { this.seq += 1; return `${prefix}-${this.seq}`; }
  async ensureSource(row) { this.calls.ensureSource += 1; let found = this.sources.find((x) => x.key === row.key); if (!found) { found = { id: this.id("src"), key: row.key, connector_type: row.connectorType, base_url: row.baseUrl }; this.sources.push(found); } return found; }
  async createIngestionRun(row) { this.calls.createIngestionRun += 1; const value = { id: this.id("ing"), ...row }; this.ingestions.push(value); return value; }
  async updateIngestionRun(id, row) { this.calls.updateIngestionRun += 1; Object.assign(this.ingestions.find((x) => x.id === id), row); }
  async createSourceRun(row) { this.calls.createSourceRun += 1; const value = { id: this.id("run"), ...row }; this.sourceRuns.push(value); return value; }
  async updateSourceRun(id, row) { this.calls.updateSourceRun += 1; Object.assign(this.sourceRuns.find((x) => x.id === id), row); }
  async findProvenance(sourceId, recordId, occurrenceKey) { this.calls.findProvenance += 1; return this.provenances.find((x) => x.source_id === sourceId && (x.source_record_id || "") === (recordId || "") && x.source_occurrence_key === occurrenceKey) || null; }
  async findProvenancesBatch(sourceId, occurrenceKeys) { this.calls.findProvenancesBatch += 1; const keys = new Set(occurrenceKeys); return this.provenances.filter((x) => x.source_id === sourceId && keys.has(x.source_occurrence_key)); }
  hydrate(row) { return { ...row, provenances: this.provenances.filter((p) => p.activity_id === row.id).map((p) => ({ ...p, source: this.sources.find((s) => s.id === p.source_id) })), external_ids: this.externalIds.filter((id) => id.activity_id === row.id) }; }
  async getActivity(id) { this.calls.getActivity += 1; const row = this.activities.find((x) => x.id === id); if (!row) throw new Error("activité absente"); return this.hydrate(row); }
  async getActivitiesBatch(ids) { this.calls.getActivitiesBatch += 1; const set = new Set(ids); return this.activities.filter((x) => set.has(x.id)).map((x) => this.hydrate(x)); }
  async listCandidateActivities(activity) { this.calls.listCandidateActivities += 1; const t = Date.parse(activity.startsAt); return this.activities.filter((x) => ["active", "review"].includes(x.record_status) && Math.abs(Date.parse(x.starts_at) - t) <= 12 * 3600000).map((x) => this.hydrate(x)); }
  async createActivity(row) { this.calls.createActivity += 1; const value = { id: this.id("act"), merged_into_id: null, ...row }; this.activities.push(value); return value; }
  async updateActivity(id, row) { this.calls.updateActivity += 1; const value = this.activities.find((x) => x.id === id); Object.assign(value, row); return value; }
  async markActivityMerged(id, canonicalId) { return this.updateActivity(id, { record_status: "merged", merged_into_id: canonicalId }); }
  async updateProvenance(id, row) { this.calls.updateProvenance += 1; const value = this.provenances.find((x) => x.id === id); Object.assign(value, row); return value; }
  async touchProvenancesBatch(ids, touch) {
    this.calls.touchProvenancesBatch += 1;
    if (this.failNextTouchBatch) { this.failNextTouchBatch = false; throw new Error("panne simulée du batch de revue des provenances"); }
    const set = new Set(ids);
    for (const p of this.provenances) if (set.has(p.id)) Object.assign(p, touch);
  }
  async moveProvenances() {} async moveExternalIds() {}
  async createProvenanceIdempotent(row) { this.calls.createProvenanceIdempotent += 1; const existing = await this.findProvenance(row.source_id, row.source_record_id, row.source_occurrence_key); if (existing) return existing; const value = { id: this.id("prov"), ...row }; this.provenances.push(value); return value; }
  async upsertExternalIds(activityId, sourceId, ids) { this.calls.upsertExternalIds += 1; for (const id of ids) if (!this.externalIds.some((x) => x.activity_id === activityId && x.source_id === sourceId && x.system === id.system && x.value === id.value)) this.externalIds.push({ activity_id: activityId, source_id: sourceId, system: id.system, value: id.value }); }
  async insertCollectionItem(row) { this.calls.insertCollectionItem += 1; const value = { id: this.id("item"), ...row }; this.items.push(value); return value; }
  async insertCollectionItemsBatch(rows) { this.calls.insertCollectionItemsBatch += 1; for (const row of rows) this.items.push({ id: this.id("item"), ...row }); }
  async insertDedupDecision(row) { if (row.left_activity_id === row.right_activity_id) return null; if (!this.decisions.some((x) => x.left_activity_id === row.left_activity_id && x.right_activity_id === row.right_activity_id && x.algorithm_version === row.algorithm_version)) this.decisions.push({ id: this.id("decision"), ...row }); }
  async applyDisappearances() { this.calls.applyDisappearances += 1; }
  async countFinalActivities() { this.calls.countFinalActivities += 1; return this.activities.filter((x) => x.record_status === "active").length; }
}
async function ingest(store, sources, date = day(1)) { return persistSortirIngestion({ store, sources, now: date, staleAfterMs: 0 }); }

(async () => {
  await test("A — 206 occurrences connues, actives, inchangées : écritures groupées en 1 UPDATE + 1 INSERT", async () => {
    const db = new MemoryStore();
    const items = manyKnownItems(206);
    await ingest(db, [sourceDescriptor("oa", items)]);
    const itemsBefore = db.items.length;
    db.resetCalls();
    const result = await ingest(db, [sourceDescriptor("oa", items)], day(2));
    assert.strictEqual(result.status, "completed");
    assert.strictEqual(db.calls.findProvenancesBatch, 1);
    assert.strictEqual(db.calls.getActivitiesBatch, 1);
    assert.strictEqual(db.calls.updateProvenance, 0, "aucun UPDATE provenance individuel");
    assert.strictEqual(db.calls.touchProvenancesBatch, 1, "206 ids tiennent dans un seul chunk de 500");
    assert.strictEqual(db.calls.insertCollectionItem, 0, "aucun INSERT collection_item individuel");
    assert.strictEqual(db.calls.insertCollectionItemsBatch, 1);
    assert.strictEqual(db.calls.updateActivity, 0);
    assert.strictEqual(db.calls.upsertExternalIds, 0);
    assert.strictEqual(db.calls.findProvenancesBatch + db.calls.getActivitiesBatch + db.calls.touchProvenancesBatch + db.calls.insertCollectionItemsBatch, 4, "4 appels logiques dépendant du lot, quel que soit N (le reste est un coût fixe par run/source)");
    assert.strictEqual(db.items.length, itemsBefore + 206, "exactement 206 nouvelles lignes d'historique, ni plus ni moins");
    assert(db.provenances.every((p) => p.last_seen_at === day(2).toISOString()), "toutes les provenances doivent être marquées revues");
  });

  await test("B — 1000 occurrences inchangées : chunking vérifié (2 chunks de 500)", async () => {
    const db = new MemoryStore();
    const items = manyKnownItems(1000);
    await ingest(db, [sourceDescriptor("oa", items)]);
    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", items)], day(2));
    // La Map applicative (store.touchProvenancesBatch) n'est appelée qu'UNE fois par
    // l'orchestrateur ; le chunking à 500 est vérifié séparément au niveau du store réel
    // (voir le test dédié au faux client Supabase, plus bas).
    assert.strictEqual(db.calls.touchProvenancesBatch, 1);
    assert.strictEqual(db.calls.insertCollectionItemsBatch, 1);
    assert.strictEqual(db.provenances.length, 1000);
    assert(db.provenances.every((p) => p.active === true));
  });

  await test("C — occurrence stale parmi un lot inchangé : réactivée individuellement, les autres restent batchées", async () => {
    const db = new MemoryStore();
    const items = manyKnownItems(50);
    await ingest(db, [sourceDescriptor("oa", items)]);
    db.activities[10].record_status = "stale"; // une seule activité, parmi les 50, tombée stale
    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", items)], day(2));
    assert.strictEqual(db.activities[10].record_status, "active", "l'activité stale doit être réactivée");
    assert.strictEqual(db.calls.updateActivity, 1, "un seul updateActivity individuel, pour la seule activité stale");
    assert.strictEqual(db.calls.updateProvenance, 1, "la provenance de l'occurrence stale suit le chemin individuel, pas le batch");
    assert.strictEqual(db.calls.touchProvenancesBatch, 1, "les 49 autres restent batchées");
    assert.strictEqual(db.calls.insertCollectionItem, 1);
    assert.strictEqual(db.calls.insertCollectionItemsBatch, 1);
    assert.strictEqual(db.items.filter((it) => it.source_run_id === db.sourceRuns[db.sourceRuns.length - 1].id).length, 50, "toujours 50 lignes d'historique au total pour ce run");
  });

  await test("D — occurrence modifiée parmi un lot inchangé : chemin complet pour elle, batching conservé pour les autres", async () => {
    const db = new MemoryStore();
    const items = manyKnownItems(50);
    await ingest(db, [sourceDescriptor("oa", items)]);
    db.resetCalls();
    const modified = items.map((it, i) => i === 20 ? item("oa", { suffix: String(i), startsAt: it.activity.startsAt, endsAt: it.activity.endsAt, description: "Description modifiée" }) : it);
    await ingest(db, [sourceDescriptor("oa", modified)], day(2));
    assert.strictEqual(db.activities.find((a) => a.id === db.provenances.find((p) => p.source_record_id === "oa-20").activity_id).description, "Description modifiée");
    assert.strictEqual(db.calls.updateActivity, 1, "un seul merge complet, pour la seule occurrence modifiée");
    assert.strictEqual(db.calls.upsertExternalIds, 1);
    assert.strictEqual(db.calls.touchProvenancesBatch, 1, "les 49 occurrences inchangées restent batchées malgré la présence d'une occurrence modifiée dans le même lot");
    assert.strictEqual(db.calls.insertCollectionItemsBatch, 1);
  });

  await test("E — multisource : le batching du cas A n'altère aucune donnée apportée par une provenance sœur", async () => {
    const db = new MemoryStore();
    await ingest(db, [sourceDescriptor("oa", [item("oa", { title: "Concert commun" })]), sourceDescriptor("mz", [item("mz", { startsAt: "2026-11-01T19:03:00.000Z", description: "Vue par Mobilizon", imageUrl: "https://mz.example/affiche.jpg" })])]);
    assert.strictEqual(db.activities.length, 1);
    const descriptionAvant = db.activities[0].description, imageAvant = db.activities[0].image_url;
    const mzProvenanceAvant = { ...db.provenances.find((p) => p.source_id === db.sources.find((s) => s.key === "mz").id) };
    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", [item("oa", { title: "Concert commun" })])], day(2));
    assert.strictEqual(db.calls.touchProvenancesBatch, 1);
    assert.strictEqual(db.activities[0].description, descriptionAvant);
    assert.strictEqual(db.activities[0].image_url, imageAvant);
    const mzProvenanceApres = db.provenances.find((p) => p.source_id === db.sources.find((s) => s.key === "mz").id);
    assert.strictEqual(mzProvenanceApres.last_seen_at, mzProvenanceAvant.last_seen_at, "la provenance mz n'est pas dans le lot d'oa : jamais touchée par son batch");
  });

  await test("F — collection items : exactement le même nombre logique qu'avant l'optimisation", async () => {
    const db = new MemoryStore();
    const items = manyKnownItems(37);
    await ingest(db, [sourceDescriptor("oa", items)]);
    const avant = db.items.length;
    await ingest(db, [sourceDescriptor("oa", items)], day(2));
    assert.strictEqual(db.items.length, avant + 37, "une ligne d'historique par occurrence collectée, ni plus ni moins, qu'elle soit batchée ou individuelle");
  });

  await test("G — second passage identique : aucun doublon d'activité/provenance", async () => {
    const db = new MemoryStore();
    const items = manyKnownItems(206);
    await ingest(db, [sourceDescriptor("oa", items)]);
    const activityIds = db.activities.map((a) => a.id).sort();
    const provenanceIds = db.provenances.map((p) => p.id).sort();
    await ingest(db, [sourceDescriptor("oa", items)], day(2));
    assert.deepStrictEqual(db.activities.map((a) => a.id).sort(), activityIds);
    assert.deepStrictEqual(db.provenances.map((p) => p.id).sort(), provenanceIds);
    assert.strictEqual(db.activities.length, 206);
    assert.strictEqual(db.provenances.length, 206);
  });

  await test("H — échec simulé du batch de provenances : l'erreur remonte, n'est pas silencieusement ignorée, le batch de collection items est quand même tenté", async () => {
    const db = new MemoryStore();
    const items = manyKnownItems(10);
    await ingest(db, [sourceDescriptor("oa", items)]);
    const before = db.items.length;
    db.failNextTouchBatch = true;
    const result = await ingest(db, [sourceDescriptor("oa", items)], day(2));
    assert.strictEqual(result.status, "partial", "l'échec doit se refléter dans le statut du run, jamais masqué");
    assert.strictEqual(result.sources[0].status, "partial");
    assert(result.sources[0].errors.some((e) => e.includes("panne simulée du batch de revue des provenances")), "le message d'erreur doit être porté par le résultat");
    assert(db.provenances.every((p) => p.last_seen_at === day(1).toISOString()), "aucune provenance ne doit paraître revue si le batch a échoué");
    assert.strictEqual(db.items.length, before + 10, "le batch de collection items est indépendant : il est quand même tenté et réussit malgré l'échec du batch de provenances");
  });

  // --- Chunking vérifié au niveau du store réel (createSupabaseSortirStore), pas de
  // l'orchestrateur, avec un faux client Supabase qui compte les appels .from(...) émis. ---
  class FakeSupabaseClient {
    constructor(tables) { this.tables = tables; this.calls = []; }
    from(table) {
      this.calls.push({ table });
      const state = { filters: [], updatePayload: null, insertRows: null };
      const builder = {
        update(payload) { state.updatePayload = payload; return builder; },
        insert(rows) { state.insertRows = rows; return builder; },
        in(col, arr) { state.filters.push({ col, arr }); return builder; }
      };
      builder.then = (resolve, reject) => {
        try {
          if (state.insertRows) { this.tables[table].push(...state.insertRows); resolve({ data: null, error: null }); return; }
          const matching = this.tables[table].filter((row) => state.filters.every((f) => f.arr.includes(row[f.col])));
          if (state.updatePayload) for (const row of matching) Object.assign(row, state.updatePayload);
          resolve({ data: null, error: null });
        } catch (error) { reject(error); }
      };
      return builder;
    }
  }
  await test("chunking (store réel) — plus de clés que PRELOAD_CHUNK_SIZE, aucun id perdu, nombre d'appels attendu", async () => {
    const total = PRELOAD_CHUNK_SIZE * 2 + 137;
    const provenanceRows = Array.from({ length: total }, (_, i) => ({ id: `prov-${i}`, active: false, last_seen_at: null }));
    const client = new FakeSupabaseClient({ sortir_provenances: provenanceRows, sortir_collection_items: [] });
    const store = createSupabaseSortirStore(client);
    await store.touchProvenancesBatch(provenanceRows.map((p) => p.id), { active: true, last_seen_at: "2026-11-02T12:00:00.000Z" });
    const expectedChunks = Math.ceil(total / PRELOAD_CHUNK_SIZE);
    assert.strictEqual(client.calls.filter((c) => c.table === "sortir_provenances").length, expectedChunks);
    assert(provenanceRows.every((p) => p.active === true && p.last_seen_at === "2026-11-02T12:00:00.000Z"), "aucune provenance oubliée par le chunking");

    client.calls.length = 0;
    const rows = Array.from({ length: total }, (_, i) => ({ source_run_id: "run-1", activity_id: `act-${i}`, validation_status: "VALID", diagnostics: {} }));
    await store.insertCollectionItemsBatch(rows);
    assert.strictEqual(client.calls.filter((c) => c.table === "sortir_collection_items").length, expectedChunks);
    assert.strictEqual(client.tables.sortir_collection_items.length, total, "aucune ligne d'historique perdue par le chunking");
  });

  console.log("\nMesure décomposée — réingestion de N occurrences connues, actives, inchangées (1 source) :");
  console.log("(\"logique\" = appels à l'interface store depuis l'orchestrateur, mesurés ici avec des clés synthétiques courtes ; \"réel\" = appels HTTP Supabase une fois le chunking appliqué côté store réel AVEC DE VRAIES clés OpenAgenda longues — findProvenancesBatch chunke à 100 (OCCURRENCE_KEY_CHUNK_SIZE), getActivitiesBatch/touchProvenancesBatch/insertCollectionItemsBatch chunkent à 500, voir test-known-provenance-batch-preload.js pour la preuve avec de vraies clés)");
  for (const n of [206, 1000, 10000]) {
    const db = new MemoryStore();
    const items = manyKnownItems(n);
    await ingest(db, [sourceDescriptor("oa", items)]);
    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", items)], day(2));
    const keyChunks = Math.ceil(n / OCCURRENCE_KEY_CHUNK_SIZE);
    const idChunks = Math.ceil(n / PRELOAD_CHUNK_SIZE);
    const fixedRun = db.calls.createIngestionRun + db.calls.updateIngestionRun + db.calls.countFinalActivities;
    const fixedSource = db.calls.ensureSource + db.calls.createSourceRun + db.calls.updateSourceRun;
    const preloadLogique = db.calls.findProvenancesBatch + db.calls.getActivitiesBatch;
    const writesLogique = db.calls.touchProvenancesBatch + db.calls.insertCollectionItemsBatch;
    const disappearances = db.calls.applyDisappearances;
    const totalLogique = db.totalCalls();
    // findProvenancesBatch → keyChunks appels réels ; getActivitiesBatch/touchProvenancesBatch/
    // insertCollectionItemsBatch → idChunks chacun (UUID courts ou payload, pas d'impact de la
    // longueur des clés d'occurrence).
    const preloadReel = keyChunks + idChunks;
    const writesReel = idChunks * 2;
    const totalReel = fixedRun + fixedSource + disappearances + preloadReel + writesReel;
    console.log(`  N=${String(n).padStart(6, " ")} → fixe run=${fixedRun}, fixe source=${fixedSource}, applyDisappearances=${disappearances}, préchargement=${preloadLogique} logique / ${preloadReel} réel (provenances: ${keyChunks} chunk(s) de 100, activités: ${idChunks} chunk(s) de 500), écritures groupées=${writesLogique} logique / ${writesReel} réel (${idChunks} chunk(s) de 500) → total logique=${totalLogique}, total réel≈${totalReel}`);
  }

  console.log("\nComparaison avec les étapes historiques (lot réel de 206 occurrences inchangées, total réel incluant les coûts fixes, avec de vraies clés OpenAgenda) :");
  console.log("  Pipeline initial          : ≈ 1 240 appels");
  console.log("  Après fast-path           : ≈   828 appels");
  console.log("  Après préchargement A/B   : ≈   418 appels (mesuré à l'étape précédente, avant la découverte du bug de longueur de clé)");
  console.log("  Après cette étape         :     13 appels réels pour 206 (7 fixes + 3 chunks provenances/100 + 1 chunk activités/500 + 2 chunks écritures/500)");

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
