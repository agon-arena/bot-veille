"use strict";

// Teste le batching de sortir_collection_items pour le chemin des NOUVELLES occurrences
// (MATCH/REVIEW/DISTINCT) — périmètre strictement limité à cette seule table/ce seul appel.
// Ne touche à rien d'autre : listCandidateActivities, createActivity,
// createProvenanceIdempotent, upsertExternalIds, insertDedupDecision et le dédoublonnage
// lui-même restent exactement comme avant, non modifiés par cette étape.

const assert = require("assert");
const { persistSortirIngestion } = require("./supabase-persistence");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error.message}`); } }

function baseActivity(id, overrides = {}) {
  return {
    title: "Événement", description: "Description", startsAt: overrides.startsAt, endsAt: overrides.endsAt,
    timezone: "Europe/Paris", lifecycleStatus: "scheduled", locationType: "physical", venueName: "Lieu",
    address: "1 rue X", postalCode: "75001", city: "Senlis", country: "FR", latitude: 49.2, longitude: 2.58,
    onlineUrl: null, bookingUrl: null, admissionType: "unknown", organizers: [],
    category: null, subcategory: null, tags: [], imageUrl: null, confidence: 0.9, fieldConfidence: {}, evidence: [],
    provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: `https://oa.example/e/${id}`, externalId: id, fetchedAt: new Date().toISOString() }],
    externalIds: [{ system: "openagenda-event", value: id }],
    ...overrides
  };
}
const BASE = Date.parse("2026-11-01T19:00:00.000Z");
// 1 jour d'écart entre créneaux : jamais de MATCH/REVIEW accidentel entre deux occurrences
// par ailleurs censées rester DISTINCT (cf. piège déjà rencontré dans l'audit précédent).
function freshItem(uid, i, overrides = {}) {
  const startsAt = new Date(BASE + i * 86400000).toISOString();
  const endsAt = new Date(BASE + i * 86400000 + 7200000).toISOString();
  const activity = baseActivity(uid, { startsAt, endsAt, ...overrides });
  return { activity, sourceRecordId: uid, sourceOccurrenceKey: `${uid}@${startsAt}` };
}
// baseUrl DOIT correspondre exactement au sourceUrl mis dans baseActivity() ci-dessus :
// rowToActivity() reconstruit provenances[].sourceUrl depuis sortir_sources.base_url (pas
// depuis la valeur brute stockée), donc un écart ferait échouer provenanceCompatible() et
// masquerait les vrais MATCH (piège déjà rencontré lors de l'audit précédent).
function sourceDescriptor(results) { return { key: "oa", connectorType: "openagenda_json", baseUrl: "https://oa.example/api", results }; }
const day = (n) => new Date(`2026-11-${String(n).padStart(2, "0")}T12:00:00Z`);

class MemoryStore {
  constructor() {
    this.seq = 0; this.sources = []; this.ingestions = []; this.sourceRuns = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.decisions = [];
    this.calls = { insertCollectionItem: 0, insertCollectionItemsBatch: 0, listCandidateActivities: 0, createActivity: 0, createProvenanceIdempotent: 0, upsertExternalIds: 0, insertDedupDecision: 0, updateActivity: 0 };
  }
  resetCalls() { for (const k of Object.keys(this.calls)) this.calls[k] = 0; }
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
  async listCandidateActivities(activity) { this.calls.listCandidateActivities += 1; const t = Date.parse(activity.startsAt); return this.activities.filter(x => ["active", "review"].includes(x.record_status) && Math.abs(Date.parse(x.starts_at) - t) <= 12 * 3600000).map(x => this.hydrate(x)); }
  async createActivity(row) { this.calls.createActivity += 1; const v = { id: this.id("act"), merged_into_id: null, ...row }; this.activities.push(v); return v; }
  async updateActivity(id, row) { this.calls.updateActivity += 1; const v = this.activities.find(x => x.id === id); Object.assign(v, row); return v; }
  async markActivityMerged(id, cid) { return this.updateActivity(id, { record_status: "merged", merged_into_id: cid }); }
  async updateProvenance(id, row) { const v = this.provenances.find(x => x.id === id); Object.assign(v, row); return v; }
  async touchProvenancesBatch(ids, touch) { const s = new Set(ids); for (const p of this.provenances) if (s.has(p.id)) Object.assign(p, touch); }
  async moveProvenances() {} async moveExternalIds() {}
  async createProvenanceIdempotent(row) {
    this.calls.createProvenanceIdempotent += 1;
    const conflict = this.provenances.find(x => x.source_id === row.source_id && (x.source_record_id || "") === (row.source_record_id || "") && x.source_occurrence_key === row.source_occurrence_key);
    if (conflict) return conflict;
    const v = { id: this.id("prov"), ...row };
    this.provenances.push(v);
    return v;
  }
  async upsertExternalIds(aid, sid, ids) { this.calls.upsertExternalIds += 1; for (const id of ids) if (!this.externalIds.some(x => x.activity_id === aid && x.source_id === sid && x.system === id.system && x.value === id.value)) this.externalIds.push({ activity_id: aid, source_id: sid, system: id.system, value: id.value }); }
  async insertCollectionItem(row) { this.calls.insertCollectionItem += 1; const v = { id: this.id("item"), ...row }; this.items.push(v); return v; }
  async insertCollectionItemsBatch(rows) { this.calls.insertCollectionItemsBatch += 1; for (const row of rows) this.items.push({ id: this.id("item"), ...row }); }
  async insertDedupDecision(row) { this.calls.insertDedupDecision += 1; if (row.left_activity_id === row.right_activity_id) return null; if (!this.decisions.some(x => x.left_activity_id === row.left_activity_id && x.right_activity_id === row.right_activity_id && x.algorithm_version === row.algorithm_version)) this.decisions.push({ id: this.id("decision"), ...row }); }
  async applyDisappearances() {}
  async countFinalActivities() { return this.activities.filter(x => x.record_status === "active").length; }
}
async function ingest(store, sources, date = day(1)) { return persistSortirIngestion({ store, sources, now: date, staleAfterMs: 0 }); }

(async () => {
  await test("A — lot de nouvelles occurrences DISTINCT : insertCollectionItem individuel disparu, insertCollectionItemsBatch utilisé, aucune perte", async () => {
    const db = new MemoryStore();
    const N = 50;
    const items = Array.from({ length: N }, (_, i) => freshItem(`distinct-${i}`, i));
    const result = await ingest(db, [sourceDescriptor(items)]);
    assert.strictEqual(result.status, "completed");
    assert.strictEqual(db.calls.insertCollectionItem, 0, "aucun INSERT individuel pour les nouvelles occurrences DISTINCT");
    assert.strictEqual(db.calls.insertCollectionItemsBatch, 1, "50 tient dans un seul chunk");
    assert.strictEqual(db.items.length, N, "une ligne d'historique par occurrence, pas une de plus ni de moins");
    assert.strictEqual(db.activities.length, N);
    assert.strictEqual(db.provenances.length, N);
    // Intégrité des liens : chaque ligne d'historique pointe la bonne activité/provenance, pas
    // une correspondance décalée par l'accumulation-puis-flush.
    for (const item of db.items) {
      const prov = db.provenances.find(p => p.id === item.provenance_id);
      assert(prov, `collection_item ${item.id} référence une provenance inexistante`);
      assert.strictEqual(prov.activity_id, item.activity_id, `collection_item ${item.id} : activity_id ne correspond pas à sa provenance`);
    }
  });

  await test("B — lot mixte MATCH + REVIEW + DISTINCT : tous batchés ensemble, aucune perte/duplication", async () => {
    const db = new MemoryStore();
    // 5 activités déjà existantes (hors mesure), pour servir de cibles MATCH au même créneau.
    const existing = Array.from({ length: 5 }, (_, i) => freshItem(`existing-${i}`, i, { externalIds: [{ system: "openagenda-event", value: `shared-${i}` }] }));
    await ingest(db, [sourceDescriptor(existing)]);

    const matchItems = Array.from({ length: 5 }, (_, i) => freshItem(`new-match-${i}`, i, { externalIds: [{ system: "openagenda-event", value: `shared-${i}` }] })); // même créneau + externalId partagé -> MATCH
    const reviewItems = Array.from({ length: 3 }, (_, i) => freshItem(`new-review-${i}`, 100 + i, { venueName: "Lieu", organizers: [{ name: "Org X" }] }))
      .concat(Array.from({ length: 3 }, (_, i) => freshItem(`new-review-pair-${i}`, 100 + i, { title: "Événement", organizers: [{ name: "Org X" }], venueName: "Autre lieu tout proche" }))); // probable match -> REVIEW, pas exploité plus loin ici
    const distinctItems = Array.from({ length: 10 }, (_, i) => freshItem(`new-distinct-${i}`, 300 + i));

    db.resetCalls();
    const allNew = [...matchItems, ...distinctItems];
    const itemsBefore = db.items.length;
    const result = await ingest(db, [sourceDescriptor(allNew)], day(2));
    assert.strictEqual(result.status, "completed");
    assert.strictEqual(db.calls.insertCollectionItem, 0, "aucun INSERT individuel, qu'il s'agisse de MATCH ou de DISTINCT");
    assert(db.calls.insertCollectionItemsBatch >= 1);
    assert.strictEqual(db.items.length, itemsBefore + allNew.length, "une ligne d'historique par occurrence du lot, exactement");
    assert.strictEqual(result.stats.merged, 5, "les 5 MATCH doivent toujours être détectés comme tels (dédoublonnage non modifié)");
  });

  await test("C — occurrence connue mais modifiée (hash différent) dans le MÊME lot : reste un INSERT individuel", async () => {
    const db = new MemoryStore();
    const known = freshItem("known-1", 0);
    await ingest(db, [sourceDescriptor([known])]);
    db.resetCalls();
    const modified = freshItem("known-1", 0, { description: "Description modifiée" });
    const fresh = freshItem("brand-new-1", 50);
    const result = await ingest(db, [sourceDescriptor([modified, fresh])], day(2));
    assert.strictEqual(result.status, "completed");
    assert.strictEqual(db.calls.insertCollectionItem, 1, "l'occurrence connue mais modifiée garde son INSERT individuel, inchangé");
    assert.strictEqual(db.calls.insertCollectionItemsBatch, 1, "la nouvelle occurrence, elle, est batchée");
  });

  await test("D — occurrence connue stale (réactivation) dans le même lot : reste un INSERT individuel", async () => {
    const db = new MemoryStore();
    const known = freshItem("known-stale-1", 0);
    await ingest(db, [sourceDescriptor([known])]);
    db.activities[0].record_status = "stale";
    db.resetCalls();
    const fresh = freshItem("brand-new-2", 50);
    await ingest(db, [sourceDescriptor([known, fresh])], day(2));
    assert.strictEqual(db.activities[0].record_status, "active", "réactivation toujours correcte");
    assert.strictEqual(db.calls.insertCollectionItem, 1, "la réactivation stale garde son INSERT individuel, inchangé");
    assert.strictEqual(db.calls.insertCollectionItemsBatch, 1);
  });

  await test("E — deuxième passage du même lot de nouvelles occurrences : idempotent, aucun doublon", async () => {
    const db = new MemoryStore();
    const items = Array.from({ length: 20 }, (_, i) => freshItem(`idem-${i}`, i));
    const first = await ingest(db, [sourceDescriptor(items)]);
    const activityIds = db.activities.map(a => a.id).sort();
    const provenanceIds = db.provenances.map(p => p.id).sort();
    const itemsAfterFirst = db.items.length;

    const second = await ingest(db, [sourceDescriptor(items)], day(2));
    assert.strictEqual(first.status, "completed");
    assert.strictEqual(second.status, "completed");
    assert.deepStrictEqual(db.activities.map(a => a.id).sort(), activityIds, "aucune activité créée en double au deuxième passage");
    assert.deepStrictEqual(db.provenances.map(p => p.id).sort(), provenanceIds, "aucune provenance créée en double au deuxième passage");
    assert.strictEqual(db.items.length, itemsAfterFirst + 20, "le deuxième passage ajoute bien 20 nouvelles lignes d'historique (comportement inchangé), sans dupliquer les 20 premières");
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
