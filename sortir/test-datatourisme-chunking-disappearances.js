"use strict";

// Point CRITIQUE vérifié explicitement avant de brancher DATAtourisme au scheduler (voir audit
// du 19/10/2026) : plusieurs CHUNKS successifs d'une même source (même source.key) appellent
// chacun leur propre applyDisappearances() -- ce test prouve, avec le VRAI pipeline
// (persistSortirIngestionUnlocked, MemoryStore, zéro mock de la logique métier), que :
//  1) avec le staleAfterMs très large retenu pour DATAtourisme (DATATOURISME_STALE_AFTER_MS,
//     365 jours), un chunk traité plus tard ne marque JAMAIS par erreur "disparues" les
//     activités d'un chunk précédent de la même source, même à plusieurs semaines d'écart ;
//  2) ce risque est RÉEL avec le staleAfterMs par défaut (7 jours, DEFAULT_STALE_AFTER_MS) dans
//     le même scénario -- ce qui justifie le choix d'un staleAfterMs dédié pour cette source,
//     documenté dans sortir-auto-ingest.js, plutôt qu'un bricolage de applyDisappearances
//     lui-même (jamais modifié par cette étape).
// Aucune écriture Supabase réelle : MemoryStore uniquement.

const assert = require("assert");
const { persistSortirIngestion, DEFAULT_STALE_AFTER_MS } = require("./supabase-persistence");
const { DATATOURISME_STALE_AFTER_MS, DATATOURISME_SOURCE_KEY } = require("../sortir-auto-ingest");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.message}`); } }
async function asyncTest(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error.message}`); } }

class MemoryStore {
  constructor() { this.seq = 0; this.sources = []; this.ingestions = []; this.sourceRuns = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.decisions = []; }
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
  async listCandidateActivitiesInRange(startIso, endIso) { const start = Date.parse(startIso), end = Date.parse(endIso); return this.activities.filter(x => ["active", "review"].includes(x.record_status) && Date.parse(x.starts_at) >= start && Date.parse(x.starts_at) <= end).map(x => this.hydrate(x)); }
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
  async applyDisappearances({ sourceId, sourceRunId, cutoff }) {
    const stale = this.provenances.filter(p => p.source_id === sourceId && p.active === true && (p.last_seen_run_id == null || p.last_seen_run_id !== sourceRunId) && Date.parse(p.last_seen_at) < Date.parse(cutoff));
    for (const p of stale) p.active = false;
    const touchedIds = [...new Set(stale.map(p => p.activity_id))];
    for (const activityId of touchedIds) {
      const stillActive = this.provenances.some(p => p.activity_id === activityId && p.active === true);
      if (!stillActive) {
        const activity = this.activities.find(a => a.id === activityId);
        if (activity) activity.record_status = "stale";
      }
    }
  }
  async countFinalActivities() { return this.activities.filter(x => x.record_status === "active").length; }
}

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
function item(activity, sourceRecordId) { return { activity, sourceRecordId, sourceOccurrenceKey: `${sourceRecordId}@${activity.startsAt}` }; }
function descriptor(results) { return { key: DATATOURISME_SOURCE_KEY, connectorType: "datatourisme", baseUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent", results }; }

// Chunk A (jour 1) : 3 POI "chunk A". Chunk B (jour 1, lot suivant) : 3 AUTRES POI "chunk B".
// Scénario volontairement réaliste : chunk A et chunk B ne sont PLUS jamais revisités ensemble
// avant +30 jours (le prochain cycle ne retombe PAS forcément sur les mêmes chunks -- c'est
// exactement le risque identifié dans l'audit : rien ne garantit encore qu'un cycle futur
// retraverse l'intégralité du catalogue nationale en moins de staleAfterMs).
function chunkAItems() {
  return [0, 1, 2].map((i) => item(a({
    title: `Chunk A item ${i}`, startsAt: `2026-11-0${i + 1}T10:00:00.000Z`, endsAt: `2026-11-0${i + 1}T12:00:00.000Z`,
    city: "Ville A", venueName: "Lieu A", latitude: 10 + i, longitude: 10 + i,
    provenances: [{ sourceType: "api", sourceName: "DATAtourisme", sourceUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent", originalEventUrl: `https://data.datatourisme.fr/x/a-${i}`, externalId: `a-${i}`, fetchedAt: new Date().toISOString() }],
    externalIds: [{ system: "datatourisme-poi", value: `a-${i}` }]
  }), `a-${i}`));
}
function chunkBItems() {
  return [0, 1, 2].map((i) => item(a({
    title: `Chunk B item ${i}`, startsAt: `2026-12-0${i + 1}T10:00:00.000Z`, endsAt: `2026-12-0${i + 1}T12:00:00.000Z`,
    city: "Ville B", venueName: "Lieu B", latitude: 20 + i, longitude: 20 + i,
    provenances: [{ sourceType: "api", sourceName: "DATAtourisme", sourceUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent", originalEventUrl: `https://data.datatourisme.fr/x/b-${i}`, externalId: `b-${i}`, fetchedAt: new Date().toISOString() }],
    externalIds: [{ system: "datatourisme-poi", value: `b-${i}` }]
  }), `b-${i}`));
}

(async () => {
  await asyncTest("Avec le staleAfterMs par défaut (7 jours) : un chunk non revisité après 30 jours est INCORRECTEMENT marqué disparu (risque démontré, pas un bug de ce code -- justifie le choix d'un staleAfterMs dédié)", async () => {
    const store = new MemoryStore();
    const day1 = new Date("2026-11-01T06:00:00.000Z");
    await persistSortirIngestion({ store, sources: [descriptor(chunkAItems())], now: day1, staleAfterMs: DEFAULT_STALE_AFTER_MS });
    await persistSortirIngestion({ store, sources: [descriptor(chunkBItems())], now: day1, staleAfterMs: DEFAULT_STALE_AFTER_MS });
    // +30 jours : chunk B est revisité (toujours là), mais chunk A ne l'est PAS (scénario
    // "la pagination n'est pas revenue dessus à temps").
    const day31 = new Date("2026-12-01T06:00:00.000Z");
    await persistSortirIngestion({ store, sources: [descriptor(chunkBItems())], now: day31, staleAfterMs: DEFAULT_STALE_AFTER_MS });
    const chunkAActivities = store.activities.filter((act) => act.title.startsWith("Chunk A"));
    assert.ok(chunkAActivities.some((act) => act.record_status === "stale"), "DÉMONTRÉ : avec 7 jours, un chunk non revisité à temps est faussement marqué disparu");
  });

  await asyncTest("Avec DATATOURISME_STALE_AFTER_MS (365 jours) : le même scénario à +30 jours NE marque PAS chunk A comme disparu", async () => {
    const store = new MemoryStore();
    const day1 = new Date("2026-11-01T06:00:00.000Z");
    await persistSortirIngestion({ store, sources: [descriptor(chunkAItems())], now: day1, staleAfterMs: DATATOURISME_STALE_AFTER_MS });
    await persistSortirIngestion({ store, sources: [descriptor(chunkBItems())], now: day1, staleAfterMs: DATATOURISME_STALE_AFTER_MS });
    const day31 = new Date("2026-12-01T06:00:00.000Z");
    await persistSortirIngestion({ store, sources: [descriptor(chunkBItems())], now: day31, staleAfterMs: DATATOURISME_STALE_AFTER_MS });
    const chunkAActivities = store.activities.filter((act) => act.title.startsWith("Chunk A"));
    assert.strictEqual(chunkAActivities.length, 3);
    assert.ok(chunkAActivities.every((act) => act.record_status === "active"), "chunk A doit rester actif : non revisité, mais pas encore disparu au sens métier (365 jours)");
  });

  await asyncTest("Idempotence : rejouer EXACTEMENT le même chunk deux fois ne crée aucun doublon et ne marque rien disparu", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-11-01T06:00:00.000Z");
    const first = await persistSortirIngestion({ store, sources: [descriptor(chunkAItems())], now, staleAfterMs: DATATOURISME_STALE_AFTER_MS });
    const activityIdsBefore = store.activities.map((a2) => a2.id).sort();
    const second = await persistSortirIngestion({ store, sources: [descriptor(chunkAItems())], now: new Date(now.getTime() + 1000), staleAfterMs: DATATOURISME_STALE_AFTER_MS });
    assert.strictEqual(first.status, "completed");
    assert.strictEqual(second.status, "completed");
    assert.strictEqual(second.stats.merged, 0, "rien de nouveau : tout était déjà connu");
    assert.deepStrictEqual(store.activities.map((a2) => a2.id).sort(), activityIdsBefore, "aucune activité créée ni perdue au second passage");
    assert.ok(store.activities.every((act) => act.record_status === "active"), "rien ne doit devenir stale en rejouant le même chunk");
  });

  await asyncTest("Absence de régression MATCH/REVIEW/DISTINCT across chunks : un POI du chunk B qui correspond à un POI du chunk A fusionne correctement", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-11-01T06:00:00.000Z");
    await persistSortirIngestion({ store, sources: [descriptor(chunkAItems())], now, staleAfterMs: DATATOURISME_STALE_AFTER_MS });
    // Nouveau chunk contenant un POI qui doit MATCHer "Chunk A item 0" (même externalId partagé
    // dans un external ID commun), pour vérifier le dédoublonnage inter-chunks (via relecture
    // live de candidateIndex au chunk suivant, mécanisme déjà validé, inchangé ici).
    const matchItem = item(a({
      title: "Chunk A item 0", startsAt: "2026-11-01T10:05:00.000Z", endsAt: "2026-11-01T12:05:00.000Z",
      city: "Ville A", venueName: "Lieu A", latitude: 10, longitude: 10,
      provenances: [{ sourceType: "api", sourceName: "DATAtourisme", sourceUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent", originalEventUrl: "https://data.datatourisme.fr/x/a-0-bis", externalId: "a-0-bis", fetchedAt: new Date().toISOString() }],
      externalIds: [{ system: "datatourisme-poi", value: "a-0" }]
    }), "a-0-bis");
    const result = await persistSortirIngestion({ store, sources: [descriptor([matchItem])], now: new Date(now.getTime() + 1000), staleAfterMs: DATATOURISME_STALE_AFTER_MS });
    assert.strictEqual(result.stats.merged, 1, "le chunk suivant doit retrouver et fusionner avec l'activité du chunk précédent");
    const chunkAItem0Activities = store.activities.filter((act) => act.title === "Chunk A item 0");
    assert.strictEqual(chunkAItem0Activities.length, 1, "une seule activité, pas de doublon entre chunks");
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
