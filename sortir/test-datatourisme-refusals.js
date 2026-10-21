"use strict";

// Tests exclusivement locaux : vrai connecteur/pipeline, MemoryStore et faux PostgREST.
const assert = require("assert");
const { fetchDatatourismeEvents, convertDatatourismeEvent } = require("./connectors/datatourisme");
const { persistSortirIngestion, reconcileDatatourismeRefusals, createSupabaseSortirStore } = require("./supabase-persistence");
const { runDatatourismeChunks, DATATOURISME_SOURCE_KEY, DATATOURISME_STALE_AFTER_MS } = require("../sortir-auto-ingest");
global.fetch = async () => { throw new Error("Réseau interdit dans ces tests"); };
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }
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

const uuid = (n) => `00000000-0000-3000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-21T00:00:00Z");
function poi(n, type = ["Concert"], periods = [{ startDate: "2026-11-20", startTime: "14:00", endDate: "2026-11-20", endTime: "16:00" }]) {
  return { uuid: uuid(n), type, label: `Événement ${n}`, uri: `https://data.datatourisme.fr/1/${uuid(n)}`,
    isLocatedAt: [{ geo: { latitude: 48, longitude: 2 }, address: [{ streetAddress: ["1 rue de Paris"], postalCode: "75001", hasAddressCity: { label: "Paris" } }] }], takesPlaceAt: periods };
}
const descriptor = (results = [], refusedPoiUuids = []) => ({ key: DATATOURISME_SOURCE_KEY, connectorType: "datatourisme", results, refusedPoiUuids });
const items = (p) => convertDatatourismeEvent(p, { fetchedAt: now.toISOString() });
const persist = (store, results = [], refused = []) => persistSortirIngestion({ store, sources: [descriptor(results, refused)], now, staleAfterMs: DATATOURISME_STALE_AFTER_MS });
class RefusalMemoryStore extends MemoryStore {
  constructor() { super(); this.cursor = "old-cursor"; this.cursorWrites = []; this.reconciliationCalls = []; }
  async getSourceCursor() { return this.cursor; }
  async saveSourceCursor(key, value) { this.cursor = value; this.cursorWrites.push(value); }
  async findDatatourismeProvenancesByPoiUuids(sourceId, uuids) {
    this.reconciliationCalls.push("find");
    return this.provenances.filter(p => p.source_id === sourceId && uuids.some(id => p.source_record_id?.startsWith(`datatourisme:${id}:`))).map(p => ({ ...p }));
  }
  async getActivitySupportBatch(ids) {
    this.reconciliationCalls.push("support");
    return this.activities.filter(a => ids.includes(a.id)).map(a => ({ ...a, provenances: this.provenances.filter(p => p.activity_id === a.id && p.active) }));
  }
  async markActivitiesStaleBatch(ids, updatedAt) {
    this.reconciliationCalls.push("stale");
    for (const a of this.activities) if (ids.includes(a.id) && ["active", "review"].includes(a.record_status)) Object.assign(a, { record_status: "stale", updated_at: updatedAt });
  }
}
async function fetchFixture(objects, next = null) {
  const previous = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ objects, meta: { total: objects.length, next } }) });
  try { return await fetchDatatourismeEvents({ apiKey: "fake", maxEvents: objects.length || 1, now }); }
  finally { global.fetch = previous; }
}
async function runChunk(store, chunk) {
  return runDatatourismeChunks({ apiKey: "fake", maxTotalPois: 100, chunkSize: 100, store, now, persist: persistSortirIngestion, fetchChunk: async () => chunk });
}

// Faux client : exécute les opérateurs PostgREST réellement utilisés par le store,
// plafonne les réponses à 500 lignes et compte SELECT/UPDATE (aucun accès distant).
class FakeClient {
  constructor(activities, provenances) { this.tables = { sortir_activities: activities, sortir_provenances: provenances }; this.calls = []; }
  from(table) {
    const call = { table, op: "select", filters: [] }; this.calls.push(call);
    let patch, selected = false, countRequested = false, from = 0, to = 499, embeddedLimit = Infinity;
    const b = {
      select: (columns, options) => { selected = true; countRequested = options?.count === "exact"; call.columns = columns; return b; },
      update: (value) => { patch = value; call.op = "update"; return b; },
      eq: (col, value) => { call.filters.push({ col, value }); return b; },
      in: (col, values) => { call.filters.push({ col, values }); return b; },
      or: (expression) => { call.expression = expression; return b; },
      order: () => b,
      range: (a, z) => { from = a; to = z; return b; },
      limit: (n, options) => { assert.strictEqual(options.referencedTable, "provenances"); embeddedLimit = n; return b; },
      then: (resolve, reject) => {
        try {
          const matches = this.tables[table].filter(r => call.filters.every(f => f.col.includes(".") || (f.values ? f.values.includes(r[f.col]) : r[f.col] === f.value)) &&
            (!call.expression || call.expression.split(",").some(c => {
              const prefix = "source_record_id.like."; assert(c.startsWith(prefix));
              return r.source_record_id?.startsWith(c.slice(prefix.length, -1));
            })));
          if (patch) for (const r of matches) Object.assign(r, patch);
          const data = selected ? matches.slice(from, to + 1).map(r => table === "sortir_activities" ? {
            ...r, provenances: this.tables.sortir_provenances.filter(p => p.activity_id === r.id && p.active).slice(0, embeddedLimit)
          } : { ...r }) : null;
          resolve({ data, count: countRequested ? matches.length : null, error: null });
        } catch(e) { reject(e); }
      }
    };
    return b;
  }
}
function fakeFixture(n, { other = false, inactive = false, status = "active" } = {}) {
  const activities = [], provenances = [];
  for (let i = 0; i < n; i++) {
    activities.push({ id: `a-${i}`, record_status: status });
    provenances.push({ id: `p-${i}`, activity_id: `a-${i}`, source_id: "dt", source_record_id: `datatourisme:${uuid(i % 100)}:2026-11-20T14:00:00Z`, active: !inactive });
    if (other) provenances.push({ id: `oa-${i}`, activity_id: `a-${i}`, source_id: "oa", active: true });
  }
  const client = new FakeClient(activities, provenances);
  return { client, store: createSupabaseSortirStore(client), activities, provenances };
}
const reconcileFake = (f, ids) => reconcileDatatourismeRefusals({ store: f.store, sourceId: "dt", refusedPoiUuids: ids, now });

(async () => {
  await test("chunk KEEP : résultats acceptés, aucun refus, curseur sauvegardé", async () => {
    const chunk = await fetchFixture([poi(1)], "https://api.datatourisme.fr/v1/catalog?page=2");
    assert.strictEqual(chunk.results.length, 1); assert.deepStrictEqual(chunk.refusedPoiUuids, []);
    const store = new RefusalMemoryStore(); const outcome = await runChunk(store, chunk);
    assert.strictEqual(outcome.summaries[0].status, "completed"); assert.strictEqual(store.cursor, chunk.nextPageUrl);
    assert.strictEqual(store.activities.length, 1); assert.strictEqual(store.reconciliationCalls.length, 0);
  });
  await test("chunk DENY sans période : refus explicite, aucune erreur de mapping, budget brut", async () => {
    const chunk = await fetchFixture([poi(2, ["Market"], [])], "https://api.datatourisme.fr/v1/catalog?page=2");
    assert.deepStrictEqual(chunk.results, []); assert.deepStrictEqual(chunk.refusedPoiUuids, [uuid(2)]); assert.strictEqual(chunk.fetchedCount, 1);
    const store = new RefusalMemoryStore(); await persist(store, items(poi(2)));
    const outcome = await runChunk(store, chunk);
    assert.strictEqual(outcome.summaries[0].status, "completed"); assert.strictEqual(outcome.summaries[0].cursorAdvanced, true);
    assert.strictEqual(store.cursor, chunk.nextPageUrl); assert.strictEqual(store.activities[0].record_status, "stale"); assert.strictEqual(store.provenances[0].active, false);
    assert.strictEqual(store.items.length, 1, "le refus n'est pas une activité ni un item invalide");
  });
  await test("chunk mixte : KEEP persiste, DENY réconcilie, ALLOW gagne", async () => {
    const chunk = await fetchFixture([poi(1), poi(2, ["Market"]), poi(3, ["Market", "Concert"])]);
    assert.strictEqual(chunk.fetchedCount, 3); assert.strictEqual(chunk.results.length, 2); assert.deepStrictEqual(chunk.refusedPoiUuids, [uuid(2)]);
    const store = new RefusalMemoryStore(); await persist(store, items(poi(2)));
    const result = await runChunk(store, chunk);
    assert.strictEqual(result.summaries[0].status, "completed"); assert.strictEqual(store.activities.filter(a => a.record_status === "stale").length, 1);
    assert.strictEqual(store.activities.filter(a => a.record_status !== "stale").length, 2); assert.strictEqual(store.cursor, null);
  });
  await test("POI DENY : toutes les occurrences historiques, même hors des dates actuelles", async () => {
    const store = new RefusalMemoryStore();
    await persist(store, items(poi(1, ["Concert"], [1, 2, 3].map(d => ({ startDate: `2026-11-0${d}`, endDate: `2026-11-0${d}`, startTime: "14:00", endTime: "16:00" })))));
    assert.strictEqual(store.provenances.length, 3);
    await persist(store, [], [uuid(1)]);
    assert(store.provenances.every(p => !p.active)); assert(store.activities.every(a => a.record_status === "stale"));
  });
  await test("multisource DATAtourisme + OpenAgenda : seule DATAtourisme est désactivée", async () => {
    const store = new RefusalMemoryStore(); await persist(store, items(poi(1)));
    const activity = store.activities[0]; const before = activity.record_status;
    const oa = await store.ensureSource({ key: "openagenda", connectorType: "openagenda_json" });
    store.provenances.push({ id: "oa", activity_id: activity.id, source_id: oa.id, active: true });
    await persist(store, [], [uuid(1)]);
    assert.strictEqual(store.provenances[0].active, false); assert.strictEqual(store.provenances[1].active, true); assert.strictEqual(activity.record_status, before);
  });
  await test("DENY sans provenance existante : aucune activité ni provenance créée", async () => {
    const store = new RefusalMemoryStore(); const result = await persist(store, [], [uuid(1)]);
    assert.strictEqual(result.status, "completed"); assert.strictEqual(store.activities.length, 0); assert.strictEqual(store.provenances.length, 0);
  });
  await test("DENY déjà inactif : rejeu idempotent, dates et hash conservés", async () => {
    const store = new RefusalMemoryStore(); await persist(store, items(poi(1))); await persist(store, [], [uuid(1)]);
    const before = JSON.stringify({ activities: store.activities, provenances: store.provenances });
    await persist(store, [], [uuid(1)]);
    assert.strictEqual(JSON.stringify({ activities: store.activities, provenances: store.provenances }), before);
  });
  await test("DENY → KEEP : provenance et activité réactivées, sans doublon", async () => {
    const store = new RefusalMemoryStore(); const accepted = items(poi(1)); await persist(store, accepted);
    await persist(store, [], [uuid(1)]); assert.strictEqual(store.activities[0].record_status, "stale");
    await persist(store, accepted);
    assert.strictEqual(store.activities.length, 1); assert.strictEqual(store.provenances.length, 1);
    assert.strictEqual(store.provenances[0].active, true); assert.strictEqual(store.activities[0].record_status, "active");
  });
  await test("DENY → KEEP multisource : provenance réactivée même si activité déjà active", async () => {
    const store = new RefusalMemoryStore(); const accepted = items(poi(1)); await persist(store, accepted);
    store.provenances.push({ id: "oa", activity_id: store.activities[0].id, source_id: "oa", active: true });
    await persist(store, [], [uuid(1)]); await persist(store, accepted); assert.strictEqual(store.provenances[0].active, true);
  });
  for (const method of ["findDatatourismeProvenancesByPoiUuids", "touchProvenancesBatch", "getActivitySupportBatch", "markActivitiesStaleBatch"]) {
    await test(`échec ${method} : curseur inchangé, rejeu répare l'état partiel`, async () => {
      const store = new RefusalMemoryStore(); await persist(store, items(poi(1)));
      const original = store[method].bind(store); store[method] = async () => { throw new Error("panne simulée"); };
      const chunk = { results: [], refusedPoiUuids: [uuid(1)], fetchedCount: 1, nextPageUrl: "new-cursor", exhausted: false };
      const outcome = await runChunk(store, chunk);
      assert.notStrictEqual(outcome.summaries[0].status, "completed"); assert.strictEqual(store.cursor, "old-cursor"); assert.strictEqual(store.cursorWrites.length, 0);
      store[method] = original; const retry = await runChunk(store, chunk);
      assert.strictEqual(retry.summaries[0].status, "completed"); assert.strictEqual(store.cursor, "new-cursor"); assert.strictEqual(store.activities[0].record_status, "stale");
    });
  }
  await test("budget 300 POI bruts : trois chunks 100 % DENY, curseur avance trois fois", async () => {
    const store = new RefusalMemoryStore(); let calls = 0;
    const outcome = await runDatatourismeChunks({ apiKey: "fake", maxTotalPois: 300, chunkSize: 100, now, store, persist: persistSortirIngestion,
      fetchChunk: async ({ maxEvents, resumeUrl }) => {
        assert.strictEqual(maxEvents, 100); assert.strictEqual(resumeUrl, calls ? `cursor-${calls}` : "old-cursor"); calls++;
        return { results: [], refusedPoiUuids: Array.from({ length: 100 }, (_, i) => uuid(i)), fetchedCount: 100, nextPageUrl: `cursor-${calls}`, exhausted: false };
      } });
    assert.strictEqual(calls, 3); assert.strictEqual(store.cursorWrites.length, 3); assert.strictEqual(store.cursor, "cursor-3");
    assert.strictEqual(outcome.summaries.reduce((n, s) => n + s.poisFetched, 0), 300);
  });
  await test("budget brut mixte : beaucoup de refus ne déclenchent aucun chunk supplémentaire", async () => {
    const store = new RefusalMemoryStore(); let calls = 0;
    const outcome = await runDatatourismeChunks({ apiKey: "fake", maxTotalPois: 300, chunkSize: 100, now, store, persist: persistSortirIngestion,
      fetchChunk: async () => { calls++; return { results: items(poi(calls)), refusedPoiUuids: [uuid(999)], fetchedCount: 100, nextPageUrl: `cursor-${calls}`, exhausted: false }; } });
    assert.strictEqual(calls, 3); assert.strictEqual(outcome.summaries.reduce((n, s) => n + s.activitiesProduced, 0), 3);
  });
  await test("fin de catalogue vide : curseur remis à null après succès", async () => {
    const store = new RefusalMemoryStore(); await runChunk(store, { results: [], refusedPoiUuids: [], fetchedCount: 0, exhausted: true, nextPageUrl: null });
    assert.deepStrictEqual(store.cursorWrites, [null]);
  });
  await test("store Supabase : 100 POI / 300 occurrences = 2 SELECT + 2 UPDATE", async () => {
    const f = fakeFixture(300); await reconcileFake(f, Array.from({ length: 100 }, (_, i) => uuid(i)));
    assert(f.activities.every(a => a.record_status === "stale")); assert(f.provenances.every(p => !p.active));
    assert.deepStrictEqual(f.client.calls.map(c => c.op), ["select", "update", "select", "update"]);
  });
  await test("store Supabase : multisource = 2 SELECT + 1 UPDATE", async () => {
    const f = fakeFixture(300, { other: true }); await reconcileFake(f, Array.from({ length: 100 }, (_, i) => uuid(i)));
    assert(f.activities.every(a => a.record_status === "active")); assert(f.provenances.filter(p => p.source_id === "oa").every(p => p.active));
    assert.deepStrictEqual(f.client.calls.map(c => c.op), ["select", "update", "select"]);
  });
  await test("store Supabase : DENY inconnu = 1 SELECT, aucun UPDATE", async () => {
    const f = fakeFixture(1); await reconcileFake(f, [uuid(999)]); assert.deepStrictEqual(f.client.calls.map(c => c.op), ["select"]);
  });
  await test("store Supabase : DENY déjà réconcilié = 2 SELECT, aucun UPDATE", async () => {
    const f = fakeFixture(10, { inactive: true, status: "stale" }); await reconcileFake(f, Array.from({ length: 10 }, (_, i) => uuid(i)));
    assert.deepStrictEqual(f.client.calls.map(c => c.op), ["select", "select"]);
  });
  await test("store Supabase : 1 200 occurrences historiques, pagination sans perte", async () => {
    const f = fakeFixture(1200); await reconcileFake(f, Array.from({ length: 100 }, (_, i) => uuid(i)));
    assert.strictEqual(f.activities.filter(a => a.record_status === "stale").length, 1200);
    assert.strictEqual(f.client.calls.filter(c => c.op === "select").length, 6); // 3 pages + 3 lots de soutien
    assert.strictEqual(f.client.calls.filter(c => c.op === "update").length, 6);
  });
  await test("store Supabase : deux POI fusionnés, le KEEP et les autres sources restent actifs", async () => {
    const f = fakeFixture(1); f.provenances.push({ id: "keep", activity_id: "a-0", source_id: "dt", source_record_id: `datatourisme:${uuid(2)}:2026-11-20`, active: true });
    f.provenances.push({ id: "other", activity_id: "a-0", source_id: "other-source", source_record_id: `datatourisme:${uuid(0)}:2026-11-20`, active: true });
    await reconcileFake(f, [uuid(0)]);
    assert.strictEqual(f.provenances[0].active, false); assert.strictEqual(f.provenances[1].active, true); assert.strictEqual(f.provenances[2].active, true); assert.strictEqual(f.activities[0].record_status, "active");
  });
  await test("store Supabase : merged ne devient jamais stale", async () => {
    const f = fakeFixture(1, { status: "merged" }); await reconcileFake(f, [uuid(0)]); assert.strictEqual(f.activities[0].record_status, "merged");
  });
  await test("UUID invalide refusé avant toute requête", async () => {
    const f = fakeFixture(1); await assert.rejects(reconcileFake(f, ["x),active.eq.true"]), /UUID/); assert.strictEqual(f.client.calls.length, 0);
  });
  await test("normalisation des types conservée, UUID refusés dédupliqués", async () => {
    const chunk = await fetchFixture([poi(1, [" Market "]), poi(1, ["Market"]), poi(2, ["Market", " Concert "])]);
    assert.deepStrictEqual(chunk.refusedPoiUuids, [uuid(1)]); assert.strictEqual(chunk.results.length, 1);
  });
  await test("vraie erreur de mapping KEEP conservée, sans refus artificiel", async () => {
    const chunk = await fetchFixture([poi(1, ["Concert"], [])]);
    assert.deepStrictEqual(chunk.refusedPoiUuids, []); assert(chunk.results[0].error);
  });
  await test("échec de persistance KEEP dans un lot mixte : curseur et refus non validés", async () => {
    const store = new RefusalMemoryStore(); await persist(store, items(poi(1)));
    store.createActivity = async () => { throw new Error("panne création"); };
    const result = await runChunk(store, { results: items(poi(2)), refusedPoiUuids: [uuid(1)], fetchedCount: 2, exhausted: false, nextPageUrl: "new-cursor" });
    assert.notStrictEqual(result.summaries[0].status, "completed"); assert.strictEqual(store.cursorWrites.length, 0);
    assert.strictEqual(store.provenances[0].active, true);
  });
  await test("client Supabase réel, transport simulé : filtres sérialisés et URL bornée", async () => {
    const { createClient } = require("@supabase/supabase-js");
    const requests = [];
    const client = createClient("https://local-audit.invalid", "fake-key", { auth: { persistSession: false, autoRefreshToken: false }, global: {
      fetch: async (input, options) => {
        const url = new URL(typeof input === "string" ? input : input.url); const method = options?.method || "GET";
        requests.push({ url, method });
        let data = null; let headers = {};
        if (method === "GET" && url.pathname.endsWith("sortir_provenances")) {
          assert(url.href.length < 14000); assert.strictEqual(url.searchParams.get("source_id"), "eq.dt");
          assert(url.searchParams.get("or").includes(`source_record_id.like.datatourisme:${uuid(0)}:*`));
          data = [{ id: "p", activity_id: "a", active: true }]; headers["content-range"] = "0-0/1";
        } else if (method === "GET") {
          assert.strictEqual(url.searchParams.get("provenances.active"), "eq.true");
          assert.strictEqual(url.searchParams.get("provenances.limit"), "1");
          data = [{ id: "a", record_status: "active", provenances: [] }];
        } else { assert.strictEqual(method, "PATCH"); }
        return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...headers } });
      }
    } });
    await reconcileDatatourismeRefusals({ store: createSupabaseSortirStore(client), sourceId: "dt", refusedPoiUuids: Array.from({ length: 100 }, (_, i) => uuid(i)), now });
    assert.deepStrictEqual(requests.map(r => r.method), ["GET", "PATCH", "GET", "PATCH"]);
  });
  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
