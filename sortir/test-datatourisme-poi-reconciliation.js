"use strict";

const assert = require("assert/strict");
const { createClient } = require("@supabase/supabase-js");
const S = require("./datatourisme-poi-state");
const R = require("./datatourisme-poi-reconciliation");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };
const NOW = new Date("2026-10-21T08:00:00Z");
const SOURCE = "99999999-2222-3333-4444-555555555555";
const SCAN = "88888888-2222-3333-4444-555555555555";
const id = n => `11111111-2222-3333-4444-${String(n).padStart(12, "0")}`;
const period = day => ({ startDate: day, startTime: "10:00", endDate: day, endTime: "12:00" });
const dates = { A: "2026-11-01", B: "2026-11-02", C: "2026-11-03", D: "2026-11-04" };
function poi(keys = "ABC", n = 1) {
  return { uuid: id(n), uri: `https://example.org/poi/${n}`, label: { "@fr": `Concert ${n}` }, type: ["Concert"],
    isLocatedAt: [{ geo: { latitude: 48, longitude: 2 }, address: [{ postalCode: "75001", hasAddressCity: { label: { "@fr": "Paris" } } }] }],
    takesPlaceAt: [...keys].map(k => period(dates[k])) };
}
class Ledger {
  constructor() { this.rows = new Map(); this.reads = 0; this.writes = 0; }
  async loadBatch(ids) { this.reads++; return ids.flatMap(id => this.rows.has(id) ? [{ ...this.rows.get(id) }] : []); }
  async observeBatch() {}
  async commitBatch(rows) { this.writes++; for (const row of rows) this.rows.set(row.poi_uuid, { ...row }); }
}
// The NORMAL persistence/deduplication pipeline executes against this in-memory store.
class MemoryStore {
  constructor() { this.seq = 0; this.sources = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.calls = { load: 0, deactivate: 0, support: 0, stale: 0 }; }
  id(p) { return `${p}-${++this.seq}`; }
  async ensureSource(row) { let s = this.sources.find(s => s.key === row.key); if (!s) { s = { id: SOURCE, key: row.key, connector_type: row.connectorType, base_url: row.baseUrl }; this.sources.push(s); } return s; }
  async createIngestionRun(row) { return { id: this.id("run"), ...row }; }
  async updateIngestionRun() {}
  async createSourceRun(row) { return { id: this.id("source-run"), ...row }; }
  async updateSourceRun() {}
  hydrate(row) { return { ...row, provenances: this.provenances.filter(p => p.activity_id === row.id).map(p => ({ ...p, source: this.sources.find(s => s.id === p.source_id) })), external_ids: this.externalIds.filter(e => e.activity_id === row.id) }; }
  async findProvenance(sid, record, key) { return this.provenances.find(p => p.source_id === sid && p.source_record_id === record && p.source_occurrence_key === key); }
  async findProvenancesBatch(sid, keys) { const set = new Set(keys); return this.provenances.filter(p => p.source_id === sid && set.has(p.source_occurrence_key)).map(p => ({ ...p })); }
  async getActivity(id) { return this.hydrate(this.activities.find(a => a.id === id)); }
  async getActivitiesBatch(ids) { return this.activities.filter(a => ids.includes(a.id)).map(a => this.hydrate(a)); }
  async listCandidateActivitiesInRange(start, end) { return this.activities.filter(a => ["active", "review"].includes(a.record_status) && Date.parse(a.starts_at) >= Date.parse(start) && Date.parse(a.starts_at) <= Date.parse(end)).map(a => this.hydrate(a)); }
  async createActivity(row) { if (this.failPersistence) throw new Error("persistance échouée"); const a = { id: this.id("activity"), ...row }; this.activities.push(a); return { ...a }; }
  async updateActivity(id, row) { const a = this.activities.find(a => a.id === id); Object.assign(a, row); return { ...a }; }
  async markActivityMerged(id, target) { return this.updateActivity(id, { record_status: "merged", merged_into_id: target }); }
  async createProvenanceIdempotent(row) { const existing = await this.findProvenance(row.source_id, row.source_record_id, row.source_occurrence_key); if (existing) return { ...existing }; const p = { id: this.id("provenance"), ...row }; this.provenances.push(p); return { ...p }; }
  async updateProvenance(id, row) { const p = this.provenances.find(p => p.id === id); Object.assign(p, row); return { ...p }; }
  async touchProvenancesBatch(ids, patch) { for (const p of this.provenances) if (ids.includes(p.id)) Object.assign(p, patch); }
  async upsertExternalIds(aid, sid, ids) { for (const e of ids) if (!this.externalIds.some(x => x.activity_id === aid && x.source_id === sid && x.system === e.system && x.value === e.value)) this.externalIds.push({ activity_id: aid, source_id: sid, ...e }); }
  async insertCollectionItem(row) { this.items.push(row); }
  async insertCollectionItemsBatch(rows) { this.items.push(...rows); }
  async insertDedupDecision() {}
  async countFinalActivities() { return this.activities.filter(a => a.record_status === "active").length; }
  async applyDisappearances() { throw new Error("Balayage global interdit dans la réconciliation par POI"); }
  async loadPoiProvenancesBatch(sourceId, ids) {
    this.calls.load++; assert.ok(ids.length <= 500);
    return this.provenances.filter(p => p.source_id === sourceId && ids.some(id => p.source_record_id?.startsWith(`datatourisme:${id}:`))).map(p => ({ ...p, poi_uuid: p.source_record_id.split(":")[1], activity_ends_at: this.activities.find(a => a.id === p.activity_id).ends_at }));
  }
  async deactivateProvenancesBatch(sourceId, ids) { this.calls.deactivate++; assert.ok(ids.length <= 500); let n = 0; for (const p of this.provenances) if (p.source_id === sourceId && ids.includes(p.id) && p.active) { p.active = false; n++; } return n; }
  async loadActivitySupportsBatch(ids) { this.calls.support++; assert.ok(ids.length <= 500); if (this.failSupportOnce) { this.failSupportOnce = false; throw new Error("panne après désactivation"); } return this.activities.filter(a => ids.includes(a.id)).map(a => ({ id: a.id, record_status: a.record_status, has_active_provenance: this.provenances.some(p => p.activity_id === a.id && p.active) })); }
  async staleUnsupportedActivitiesBatch(ids) { this.calls.stale++; assert.ok(ids.length <= 500); if (this.failStaleOnce) { this.failStaleOnce = false; throw new Error("stale échoué"); } let n = 0; for (const a of this.activities) if (ids.includes(a.id) && ["active", "review"].includes(a.record_status) && !this.provenances.some(p => p.activity_id === a.id && p.active)) { a.record_status = "stale"; n++; } return n; }
}
function harness() {
  const activityStore = new MemoryStore(), stateStore = new Ledger();
  return { activityStore, stateStore, async run(pois, now = NOW, callback) { return R.processReceivedPoiBatch({ pois, stateStore, activityStore, sourceId: SOURCE, scanId: SCAN, now, persistOccurrences: callback || R.createDatatourismePoiPersister({ store: activityStore, now }) }); } };
}
function find(store, key, n = 1) { return store.provenances.find(p => p.source_id === SOURCE && p.source_record_id.startsWith(`datatourisme:${id(n)}:${dates[key]}`)); }
function activity(store, provenance) { return store.activities.find(a => a.id === provenance.activity_id); }
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }
if (require.main === module) (async () => {
  await test("A/B/C → B/C/D : ajout normal, retrait immédiat, puis rejeu UNCHANGED sans modifications", async () => {
    const h = harness(), s = h.activityStore;
    await h.run([poi()]); const result = await h.run([poi("BCD")]);
    assert.equal(result.classified[0].classification, "CHANGED"); assert.equal(result.reconciliation.deactivated, 1); assert.equal(result.reconciliation.staled, 1);
    assert.equal(find(s, "A").active, false); assert.equal(activity(s, find(s, "A")).record_status, "stale");
    for (const key of "BCD") assert.equal(find(s, key).active, true);
    const before = JSON.stringify([s.activities, s.provenances, s.calls, s.items]);
    const second = await h.run([poi("BCD")]); assert.equal(second.toPersist.length, 0); assert.equal(second.reconciliation, null);
    assert.equal(JSON.stringify([s.activities, s.provenances, s.calls, s.items]), before);
  });
  await test("ajout seul et retrait seul", async () => {
    const h = harness(); await h.run([poi("AB")]); assert.equal((await h.run([poi("ABC")])).reconciliation.deactivated, 0);
    assert.equal((await h.run([poi("BC")])).reconciliation.deactivated, 1); assert.equal(h.activityStore.activities.length, 3);
  });
  await test("J1 ABC / J2 BCD / J3 ABCD : réactivation sans doublon", async () => {
    const h = harness(), s = h.activityStore; await h.run([poi()]); const old = find(s, "A"); const oldActivity = old.activity_id;
    await h.run([poi("BCD")]); await h.run([poi("ABCD")]);
    assert.equal(old.active, true); assert.equal(old.activity_id, oldActivity); assert.equal(activity(s, old).record_status, "active");
    assert.equal(s.activities.length, 4); assert.equal(s.provenances.length, 4);
  });
  await test("occurrence devenue passée : sélection temporelle réconciliée, POI toujours présent", async () => {
    const h = harness(), p = poi("B"); p.takesPlaceAt.unshift(period("2026-10-21"));
    await h.run([p]); const first = h.activityStore.provenances.find(p => p.source_record_id.includes("2026-10-21"));
    const r = await h.run([p], new Date(+NOW + 86400000)); assert.equal(r.reconciliation.deactivated, 1); assert.equal(first.active, false);
    assert.equal(activity(h.activityStore, first).record_status, "stale");
  });
  await test("KEEP valide sans sélection et DENY explicite retirent les anciennes provenances", async () => {
    const h = harness(); const p = poi(); await h.run([p]); p.type = ["Market"];
    assert.equal((await h.run([p])).reconciliation.deactivated, 3);
    p.type = ["Concert"]; p.takesPlaceAt = [period("2020-01-01")];
    const r = await h.run([p]); assert.equal(r.errors.length, 0); assert.equal(r.committed.length, 1);
  });
  for (const status of ["active", "review"]) await test(`soutien d'une autre source conserve le statut ${status}`, async () => {
    const h = harness(), s = h.activityStore; await h.run([poi()]); const a = find(s, "A"); activity(s, a).record_status = status;
    s.provenances.push({ id: "other-source", activity_id: a.activity_id, source_id: id(999), source_record_id: "other", source_occurrence_key: "other", active: true });
    await h.run([poi("BC")]); assert.equal(a.active, false); assert.equal(activity(s, a).record_status, status); assert.equal(s.provenances.at(-1).active, true);
  });
  await test("autre POI DATAtourisme fusionné : soutien conservé sans désactiver cet autre POI", async () => {
    const h = harness(), s = h.activityStore; await h.run([poi()]); const a = find(s, "A");
    s.provenances.push({ ...a, id: "another-poi", source_record_id: `datatourisme:${id(99)}:2026-11-01`, source_occurrence_key: "other-poi", active: true });
    await h.run([poi("BC")]); assert.equal(activity(s, a).record_status, "active"); assert.equal(s.provenances.at(-1).active, true);
  });
  await test("335 POI invalides isolés : zéro empreinte, voisins traités et erreurs observables", async () => {
    const h = harness(); const invalid = Array.from({ length: 335 }, (_, i) => { const p = poi("A", i + 2); p.takesPlaceAt[0].endTime = "09:00"; return p; });
    const r = await h.run([...invalid, poi()]); assert.equal(r.stats.invalid, 335); assert.equal(r.stats.calculated, 1); assert.equal(r.stats.errorCodes.ends_before_start, 335);
    assert.equal(h.stateStore.rows.size, 1); assert.equal(h.activityStore.activities.length, 3);
    const again = await h.run([...invalid, poi()]); assert.equal(again.stats.invalid, 335); assert.equal(again.toPersist.length, 0);
  });
  await test("POI déjà connu invalide : anciennes occurrences et empreinte intactes, voisin CHANGED traité", async () => {
    const h = harness(); await h.run([poi(), poi("ABC", 2)]); const old = { ...h.stateStore.rows.get(id(1)) };
    const bad = poi("BC"); bad.takesPlaceAt[0].endTime = "09:00";
    await h.run([bad, poi("BCD", 2)]);
    assert.deepEqual(h.stateStore.rows.get(id(1)), old); assert.equal(find(h.activityStore, "A").active, true); assert.equal(find(h.activityStore, "A", 2).active, false);
    const repaired = await h.run([poi("BC")]); assert.equal(repaired.classified[0].classification, "CHANGED"); assert.equal(find(h.activityStore, "A").active, false);
  });
  await test("erreur de conversion (périodes absentes) ne retire aucune ancienne occurrence", async () => {
    const h = harness(); await h.run([poi()]); const before = JSON.stringify([h.activityStore.provenances, [...h.stateStore.rows]]);
    const r = await h.run([{ ...poi(), takesPlaceAt: [] }]); assert.equal(r.errors.length, 1); assert.equal(r.stats.invalid, 1);
    assert.equal(JSON.stringify([h.activityStore.provenances, [...h.stateStore.rows]]), before);
  });
  await test("POI absent / erreur API : aucune réconciliation, aucun balayage global", async () => {
    const h = harness(); await h.run([poi()]); const before = JSON.stringify([h.activityStore.activities, h.activityStore.provenances, h.activityStore.calls]);
    await h.run([]); await assert.rejects(h.run(undefined), /Lot/);
    assert.equal(JSON.stringify([h.activityStore.activities, h.activityStore.provenances, h.activityStore.calls]), before);
  });
  await test("erreur de persistance : pas de retrait, ancienne empreinte conservée", async () => {
    const h = harness(); await h.run([poi()]); const old = { ...h.stateStore.rows.get(id(1)) }; h.activityStore.failPersistence = true;
    const r = await h.run([poi("BCD")]); assert.equal(r.committed.length, 0); assert.equal(find(h.activityStore, "A").active, true); assert.deepEqual(h.stateStore.rows.get(id(1)), old);
    h.activityStore.failPersistence = false; await h.run([poi("BCD")]); assert.equal(find(h.activityStore, "A").active, false);
  });
  await test("succès partiel par POI : ne réconcilier/enregistrer que le succès explicite", async () => {
    const h = harness(); await h.run([poi(), poi("ABC", 2)]);
    const persist = R.createDatatourismePoiPersister({ store: h.activityStore, now: NOW });
    await h.run([poi("BC"), poi("BC", 2)], NOW, async states => [...await persist([states[0]]), { uuid: states[1].uuid, status: "failed" }]);
    assert.equal(find(h.activityStore, "A").active, false); assert.equal(find(h.activityStore, "A", 2).active, true);
  });
  for (const boundary of ["failSupportOnce", "failStaleOnce"]) await test(`${boundary} : échec après désactivation puis rejeu termine stale sans doublon`, async () => {
    const h = harness(), s = h.activityStore; await h.run([poi()]); const old = { ...h.stateStore.rows.get(id(1)) }; s[boundary] = true;
    await assert.rejects(h.run([poi("BCD")]), /panne|stale échoué/);
    assert.equal(find(s, "A").active, false); assert.equal(activity(s, find(s, "A")).record_status, "active"); assert.deepEqual(h.stateStore.rows.get(id(1)), old);
    const replay = await h.run([poi("BCD")]); assert.equal(replay.reconciliation.deactivated, 0); assert.equal(replay.reconciliation.staled, 1);
    assert.equal(activity(s, find(s, "A")).record_status, "stale"); assert.equal(s.activities.length, 4); assert.equal(s.provenances.length, 4);
    assert.notEqual(h.stateStore.rows.get(id(1)).fingerprint, old.fingerprint);
  });
  await test("panne d'enregistrement d'état après réconciliation : rejeu idempotent", async () => {
    const h = harness(); await h.run([poi()]); const commit = h.stateStore.commitBatch.bind(h.stateStore); h.stateStore.commitBatch = async () => { throw new Error("état indisponible"); };
    await assert.rejects(h.run([poi("BCD")]), /état indisponible/); h.stateStore.commitBatch = commit;
    const replay = await h.run([poi("BCD")]); assert.equal(replay.reconciliation.deactivated, 0); assert.equal(replay.reconciliation.staled, 0); assert.equal(replay.committed.length, 1);
  });
  await test("plusieurs occurrences historiques inactives : rattrapage de tous les stale en attente", async () => {
    const h = harness(), s = h.activityStore; await h.run([poi()]); find(s, "A").active = false; find(s, "B").active = false;
    const r = await h.run([poi("C")]); assert.equal(r.reconciliation.deactivated, 0); assert.equal(r.reconciliation.staled, 2);
    assert.equal(activity(s, find(s, "A")).record_status, "stale"); assert.equal(activity(s, find(s, "B")).record_status, "stale");
  });
  await test("clé legacy reconnue par le pipeline : conservation puis réactivation sans doublon", async () => {
    const h = harness(), s = h.activityStore; await h.run([poi()]); const item = S.calculatePoiState(poi(), { now: NOW }).results[0]; const a = find(s, "A");
    a.source_occurrence_key = item.legacySourceOccurrenceKey;
    h.stateStore.rows.clear(); await h.run([poi()]); assert.equal(a.active, true); assert.equal(s.provenances.length, 3);
    await h.run([poi("BC")]); await h.run([poi()]); assert.equal(a.active, true); assert.equal(s.provenances.length, 3); assert.equal(s.activities.length, 3);
  });
  await test("500 POI / 1500 historiques : opérations groupées, aucune requête par occurrence", async () => {
    const states = [], store = new MemoryStore();
    for (let n = 1; n <= 500; n++) {
      const previous = S.calculatePoiState(poi("ABC", n), { now: NOW });
      for (const item of previous.results) { const aid = `act-${n}-${item.sourceOccurrenceKey}`; store.activities.push({ id: aid, ends_at: item.activity.endsAt, record_status: "active" }); store.provenances.push({ id: `prov-${aid}`, activity_id: aid, source_id: SOURCE, source_record_id: item.sourceRecordId, source_occurrence_key: item.sourceOccurrenceKey, active: true }); }
      states.push({ ...S.calculatePoiState(poi("BC", n), { now: NOW }), classification: "CHANGED" });
    }
    const r = await R.reconcileReceivedPoiOccurrences({ states, store, sourceId: SOURCE, now: NOW }); assert.equal(r.deactivated, 500); assert.equal(r.staled, 500); assert.equal(r.provenancesRead, 1500);
    assert.deepEqual(store.calls, { load: 1, deactivate: 1, support: 1, stale: 1 });
  });
  await test("RPC SDK : pagination exacte >1000 historiques et corps POST bornés", async () => {
    const requests = [], rows = Array.from({ length: 1501 }, (_, i) => ({ id: id(i + 1) }));
    const client = createClient("https://example.supabase.co", "fake", { auth: { persistSession: false }, global: { fetch: async (url, init) => {
      const body = JSON.parse(init.body); requests.push({ url: String(url), ...init, body });
      const start = Number(new Headers(init.headers).get("range")?.split("-")[0] || new URL(String(url)).searchParams.get("offset") || 0);
      return new Response(JSON.stringify(rows.slice(start, start + 500)), { status: 206, headers: { "Content-Type": "application/json", "Content-Range": `${start}-${Math.min(start + 499, 1500)}/1501` } });
    } } });
    const store = R.createSupabasePoiReconciliationStore(client); const result = await store.loadPoiProvenancesBatch(SOURCE, Array.from({ length: 500 }, (_, i) => id(i + 1)));
    assert.equal(result.length, 1501); assert.equal(requests.length, 4); assert.ok(requests.every(r => r.method === "POST" && r.body.p_uuids.length === 500 && r.url.length < 250));
  });
  await test("RPC en échec / total absent : ne pas conclure une liste historique incomplète", async () => {
    const broken = R.createSupabasePoiReconciliationStore({ rpc: () => ({ range: async () => ({ data: [], count: null, error: null }) }) });
    await assert.rejects(broken.loadPoiProvenancesBatch(SOURCE, [id(1)]), /incomplète/);
    const truncated = R.createSupabasePoiReconciliationStore({ rpc: () => ({ range: async () => ({ data: [{ id: id(1) }], count: 600, error: null }) }) });
    await assert.rejects(truncated.loadPoiProvenancesBatch(SOURCE, [id(1)]), /incomplète/);
  });
  await test("échec de lecture historique : aucune désactivation, ancienne empreinte intacte", async () => {
    const h = harness(); await h.run([poi()]); const old = { ...h.stateStore.rows.get(id(1)) };
    h.activityStore.loadPoiProvenancesBatch = async () => { throw new Error("API indisponible"); };
    await assert.rejects(h.run([poi("BC")]), /API indisponible/); assert.equal(find(h.activityStore, "A").active, true); assert.deepEqual(h.stateStore.rows.get(id(1)), old);
  });
  await test("soutien ajouté entre lecture et écriture : garde finale conserve l'activité", async () => {
    const h = harness(), s = h.activityStore; await h.run([poi()]); const a = find(s, "A");
    const stale = s.staleUnsupportedActivitiesBatch.bind(s);
    s.staleUnsupportedActivitiesBatch = async ids => {
      s.provenances.push({ id: "concurrent-support", activity_id: a.activity_id, source_id: id(99), active: true }); return stale(ids);
    };
    const r = await h.run([poi("BC")]); assert.equal(r.reconciliation.staled, 0); assert.equal(activity(s, a).record_status, "active");
  });
  for (const [size, expected] of [[100, 4], [500, 7], [2300, 34]]) await test(`${size} POI changed : ${expected} requêtes RPC (4 historiques, 1 retirée/POI)`, async () => {
    const history = [], states = [], requests = [];
    for (let n = 1; n <= size; n++) {
      const previous = S.calculatePoiState(poi("ABCD", n), { now: NOW });
      states.push({ ...S.calculatePoiState(poi("BCD", n), { now: NOW }), classification: "CHANGED" });
      previous.results.forEach((item, i) => history.push({ poi_uuid: id(n), id: id(n * 10 + i), activity_id: id(n * 10 + i), source_id: SOURCE, source_record_id: item.sourceRecordId, source_occurrence_key: item.sourceOccurrenceKey, active: true, activity_ends_at: item.activity.endsAt }));
    }
    const client = createClient("https://example.supabase.co", "fake", { auth: { persistSession: false }, global: { fetch: async (url, init) => {
      const body = JSON.parse(init.body), name = String(url).split("/").at(-1).split("?")[0]; requests.push({ name, body, method: init.method });
      let data, headers = { "Content-Type": "application/json" };
      if (name === "sortir_load_datatourisme_poi_provenances") {
        const ids = new Set(body.p_uuids), filtered = history.filter(r => ids.has(r.poi_uuid));
        const from = Number(new URL(String(url)).searchParams.get("offset") || 0); data = filtered.slice(from, from + 500);
        headers["Content-Range"] = `${from}-${from + data.length - 1}/${filtered.length}`;
      } else if (name === "sortir_load_activity_supports") data = body.p_ids.map(id => ({ id, record_status: "active", has_active_provenance: false }));
      else data = body.p_ids.length;
      return new Response(JSON.stringify(data), { status: 200, headers });
    } } });
    const r = await R.reconcileReceivedPoiOccurrences({ states, store: R.createSupabasePoiReconciliationStore(client), sourceId: SOURCE, now: NOW });
    assert.equal(r.deactivated, size); assert.equal(r.staled, size); assert.equal(requests.length, expected);
    assert.ok(requests.every(r => r.method === "POST" && (r.body.p_ids || r.body.p_uuids).length <= 500));
  });
  await test("état invalide ou UNCHANGED refusé avant toute désactivation", async () => {
    const store = new MemoryStore(), s = S.calculatePoiState(poi(), { now: NOW });
    await assert.rejects(R.reconcileReceivedPoiOccurrences({ states: [{ ...s, classification: "UNCHANGED" }], store, sourceId: SOURCE, now: NOW }), /NEW\/CHANGED/);
    s.results[0].error = "conversion ratée";
    await assert.rejects(R.reconcileReceivedPoiOccurrences({ states: [{ ...s, classification: "CHANGED" }], store, sourceId: SOURCE, now: NOW }), /inexploitable/);
    assert.deepEqual(store.calls, { load: 0, deactivate: 0, support: 0, stale: 0 });
  });
  console.log(`\n${passed} réussis, ${failed} échoués`); if (failed) process.exitCode = 1;
})();

module.exports = { harness, poi, NOW, SOURCE, SCAN, id };
