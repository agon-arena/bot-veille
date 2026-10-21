"use strict";

// Deux scénarios du préchargement des candidats (listCandidateActivitiesInRange /
// candidateIndex) non couverts par test-list-candidates-batch-prototype.js :
// A) pagination au niveau du store réel — plus de CANDIDATE_RANGE_PAGE_SIZE candidats actifs
//    sur la fenêtre demandée, aucun perdu (l'ancien listCandidateActivities(activity) était
//    borné par .limit(500), silencieusement tronquant au-delà) ;
// B) exclusion d'une activité déjà "merged" : jamais proposée comme candidate, même si elle
//    partage un externalId et tombe dans la fenêtre ±12h d'une nouvelle occurrence.

const assert = require("assert");
const { persistSortirIngestion, createSupabaseSortirStore, CANDIDATE_RANGE_PAGE_SIZE } = require("./supabase-persistence");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error.message}`); } }

// --- A) pagination (store réel, faux client Supabase simulant .range()/.order()) ---

class FakeSupabaseClient {
  constructor(tables) { this.tables = tables; this.calls = []; }
  from(table) {
    const callRecord = { table, range: null };
    this.calls.push(callRecord);
    const state = { filters: [], orderCol: null, rangeFrom: null, rangeTo: null };
    const builder = {
      select() { return builder; },
      in(col, arr) { state.filters.push({ type: "in", col, arr }); return builder; },
      gte(col, val) { state.filters.push({ type: "gte", col, val }); return builder; },
      lte(col, val) { state.filters.push({ type: "lte", col, val }); return builder; },
      order(col) { state.orderCol = col; return builder; },
      range(from, to) { state.rangeFrom = from; state.rangeTo = to; callRecord.range = [from, to]; return builder; }
    };
    builder.then = (resolve, reject) => {
      try {
        let rows = this.tables[table].filter((row) => state.filters.every((f) => {
          if (f.type === "in") return f.arr.includes(row[f.col]);
          if (f.type === "gte") return row[f.col] >= f.val;
          if (f.type === "lte") return row[f.col] <= f.val;
          return true;
        }));
        if (state.orderCol) rows = [...rows].sort((x, y) => (x[state.orderCol] < y[state.orderCol] ? -1 : x[state.orderCol] > y[state.orderCol] ? 1 : 0));
        if (state.rangeFrom !== null) rows = rows.slice(state.rangeFrom, state.rangeTo + 1);
        resolve({ data: rows, error: null });
      } catch (error) { reject(error); }
    };
    return builder;
  }
}

(async () => {
  await test("A — listCandidateActivitiesInRange (store réel) : plus de CANDIDATE_RANGE_PAGE_SIZE candidats actifs, aucun perdu, pagination par .range()", async () => {
    const total = CANDIDATE_RANGE_PAGE_SIZE * 2 + 137; // force 3 pages
    const rows = Array.from({ length: total }, (_, i) => ({ id: `act-${String(i).padStart(6, "0")}`, record_status: "active", starts_at: "2026-11-15T10:00:00.000Z" }));
    const client = new FakeSupabaseClient({ sortir_activities: rows });
    const store = createSupabaseSortirStore(client);
    const found = await store.listCandidateActivitiesInRange("2026-11-14T22:00:00.000Z", "2026-11-15T22:00:00.000Z");
    assert.strictEqual(found.length, total, "aucun candidat perdu au-delà de CANDIDATE_RANGE_PAGE_SIZE (contrairement à l'ancien .limit(500))");
    const expectedPages = Math.ceil(total / CANDIDATE_RANGE_PAGE_SIZE);
    assert.strictEqual(client.calls.filter((c) => c.table === "sortir_activities").length, expectedPages, "une requête par page, pas plus");
    assert(client.calls.every((c) => (c.range[1] - c.range[0] + 1) <= CANDIDATE_RANGE_PAGE_SIZE), "aucune page ne dépasse CANDIDATE_RANGE_PAGE_SIZE lignes");
  });

  await test("A2 — fenêtre vide : une seule requête (page partielle), jamais de boucle infinie", async () => {
    const client = new FakeSupabaseClient({ sortir_activities: [] });
    const store = createSupabaseSortirStore(client);
    const found = await store.listCandidateActivitiesInRange("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    assert.deepStrictEqual(found, []);
    assert.strictEqual(client.calls.length, 1);
  });

  // --- B) exclusion d'une activité déjà "merged" (orchestrateur, MemoryStore) ---

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
  function item(activity, sourceRecordId, sourceOccurrenceKey) { return { activity, sourceRecordId, sourceOccurrenceKey: sourceOccurrenceKey || `${sourceRecordId}@${activity.startsAt}` }; }
  function sourceDescriptor(key, baseUrl, connectorType, results) { return { key, connectorType, baseUrl, results }; }

  class MemoryStore {
    constructor() { this.seq = 0; this.sources = []; this.ingestions = []; this.sourceRuns = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.decisions = []; this.calls = { listCandidateActivitiesInRange: 0 }; }
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
    async listCandidateActivitiesInRange(startIso, endIso) { this.calls.listCandidateActivitiesInRange += 1; const start = Date.parse(startIso), end = Date.parse(endIso); return this.activities.filter(x => ["active", "review"].includes(x.record_status) && Date.parse(x.starts_at) >= start && Date.parse(x.starts_at) <= end).map(x => this.hydrate(x)); }
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

  await test("B — une activité déjà \"merged\" n'est jamais proposée comme candidate, même identité + créneau compatibles", async () => {
    const store = new MemoryStore();
    const source = await store.ensureSource({ key: "oa", connectorType: "openagenda_json", baseUrl: "https://oa.example/api" });
    // Activité canonique (le "survivant") et une activité déjà fusionnée dans celle-ci (déjà
    // "merged" avant même ce lot -- simule l'état après une fusion antérieure, réelle ou issue
    // d'une course gagnée/perdue).
    const canonical = await store.createActivity({ title: "Festival des Lumières", starts_at: "2026-11-10T18:00:00.000Z", ends_at: "2026-11-10T20:00:00.000Z", timezone: "Europe/Paris", lifecycle_status: "scheduled", location_type: "physical", venue_name: "Place du marché", address: null, postal_code: null, city: "Senlis", country: "FR", latitude: 49.2, longitude: 2.58, online_url: null, booking_url: null, admission_type: "unknown", organizers: [], category: null, subcategory: null, tags: [], image_url: null, confidence: 0.9, field_confidence: {}, evidence: [], record_status: "active" });
    const alreadyMerged = await store.createActivity({ title: "Festival des Lumières", starts_at: "2026-11-10T18:05:00.000Z", ends_at: "2026-11-10T20:05:00.000Z", timezone: "Europe/Paris", lifecycle_status: "scheduled", location_type: "physical", venue_name: "Place du marché", address: null, postal_code: null, city: "Senlis", country: "FR", latitude: 49.2, longitude: 2.58, online_url: null, booking_url: null, admission_type: "unknown", organizers: [], category: null, subcategory: null, tags: [], image_url: null, confidence: 0.9, field_confidence: {}, evidence: [], record_status: "merged", merged_into_id: canonical.id });
    // provenanceCompatible() exige une ligne sortir_provenances des DEUX côtés (sourceUrl) :
    // sans elle, compatibleExternalId serait structurellement faux quel que soit l'externalId
    // partagé -- ne pas en ajouter ferait échouer ce test pour une raison étrangère à ce qu'il
    // vérifie.
    store.provenances.push({ id: store.id("prov"), activity_id: canonical.id, source_id: source.id, source_record_id: "existing-canonique", source_occurrence_key: "existing-canonique@2026-11-10T18:00:00.000Z", original_event_url: "https://oa.example/e/existing", payload_hash: "hash-canonique", source_payload: {}, last_seen_at: "2026-11-24T00:00:00.000Z", active: true });
    store.externalIds.push({ activity_id: canonical.id, source_id: source.id, system: "openagenda-event", value: "festival-lumieres" });
    // L'activité déjà "merged" partage pourtant exactement le même externalId ET la même
    // compatibilité de provenance : si elle était malgré tout proposée comme candidate,
    // compareActivities la MATCHerait aussi (même identité) -- ce test vérifie qu'elle n'est
    // simplement jamais dans la liste des candidats (filtrée par record_status).
    store.provenances.push({ id: store.id("prov"), activity_id: alreadyMerged.id, source_id: source.id, source_record_id: "existing-merged", source_occurrence_key: "existing-merged@2026-11-10T18:05:00.000Z", original_event_url: "https://oa.example/e/existing-merged", payload_hash: "hash-merged", source_payload: {}, last_seen_at: "2026-11-24T00:00:00.000Z", active: true });
    store.externalIds.push({ activity_id: alreadyMerged.id, source_id: source.id, system: "openagenda-event", value: "festival-lumieres" });

    const newOccurrence = item(a({
      title: "Festival des Lumières", startsAt: "2026-11-10T18:10:00.000Z", endsAt: "2026-11-10T20:10:00.000Z",
      city: "Senlis", venueName: "Place du marché", latitude: 49.2, longitude: 2.58,
      provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/e/nouvelle", externalId: "festival-lumieres", fetchedAt: "2026-11-25T00:00:00.000Z" }],
      externalIds: [{ system: "openagenda-event", value: "festival-lumieres" }]
    }), "nouvelle-occurrence");

    const result = await persistSortirIngestion({ store, sources: [sourceDescriptor("oa", "https://oa.example/api", "openagenda_json", [newOccurrence])], now: new Date("2026-11-25T00:00:00.000Z") });
    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.stats.merged, 1, "doit matcher le CANONIQUE (seul candidat valide), jamais l'activité déjà merged");
    const linkedActivityId = store.provenances.find(p => p.source_record_id === "nouvelle-occurrence").activity_id;
    assert.strictEqual(linkedActivityId, canonical.id, "la nouvelle occurrence doit rejoindre l'activité canonique, pas celle déjà merged");
    assert.strictEqual(store.activities.find(x => x.id === alreadyMerged.id).record_status, "merged", "l'activité déjà merged reste merged, jamais touchée");
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
