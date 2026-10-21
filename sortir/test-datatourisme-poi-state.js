"use strict";

const assert = require("assert/strict");
const { createClient } = require("@supabase/supabase-js");
const S = require("./datatourisme-poi-state");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };
const NOW = new Date("2026-10-21T08:00:00Z");
const SCAN = "99999999-2222-3333-4444-555555555555";
const id = n => `11111111-2222-3333-4444-${String(n).padStart(12, "0")}`;
const period = date => ({ startDate: date, startTime: "10:00", endDate: date, endTime: "12:00" });
function poi(n = 1) {
  return { uuid: id(n), uri: `https://example.org/poi/${n}`, label: { "@fr": "Concert de test" }, type: ["Concert"],
    hasDescription: [{ description: { "@fr": "Description initiale" } }],
    hasContact: [{ legalName: "Association", homepage: ["https://example.org/contact"] }],
    hasMainRepresentation: [{ hasRelatedResource: [{ locator: ["https://example.org/image.jpg"] }] }],
    isLocatedAt: [{ geo: { latitude: 48.86, longitude: 2.35 }, address: [{ streetAddress: ["1 rue de Rivoli"], postalCode: "75001", hasAddressCity: { label: { "@fr": "Paris" }, insee: "75056", isPartOfDepartment: { insee: "75" } } }] }],
    takesPlaceAt: [period("2026-11-01"), period("2026-12-01")] };
}
const calc = (p = poi(), extra = {}) => S.calculatePoiState(p, { now: NOW, ...extra });
const row = s => ({ poi_uuid: s.uuid, fingerprint: s.fingerprint, algorithm_version: s.algorithm_version, last_observed_at: NOW.toISOString(), last_observed_scan_id: SCAN });
class MemoryStore {
  constructor(rows = []) { this.rows = new Map(rows.map(r => [r.poi_uuid, structuredClone(r)])); this.reads = []; this.commits = []; this.observations = []; }
  async loadBatch(ids) { this.reads.push(ids); return ids.flatMap(id => this.rows.has(id) ? [structuredClone(this.rows.get(id))] : []); }
  async commitBatch(rows) { this.commits.push(rows); for (const r of rows) this.rows.set(r.poi_uuid, structuredClone(r)); }
  async observeBatch(ids, at, scanId) { this.observations.push(ids); for (const id of ids) Object.assign(this.rows.get(id), { last_observed_at: at, last_observed_scan_id: scanId }); }
}
const success = states => states.map(s => ({ uuid: s.uuid, persistence: "completed", reconciliation: "completed" }));
async function classification(before, after) {
  return (await S.comparePoiStates({ states: [after], store: new MemoryStore([row(before)]) })).classified[0].classification;
}
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (error) { failed++; console.error(`✗ ${name}: ${error.stack}`); } }

(async () => {
  await test("premier passage NEW, référence seulement après succès, deuxième UNCHANGED", async () => {
    const state = calc(), store = new MemoryStore();
    const result = await S.processPoiStateBatch({ states: [state], store, now: NOW, scanId: SCAN, applyChanges: async states => {
      assert.equal(store.rows.size, 0); assert.equal(states[0].classification, "NEW"); return success(states);
    } });
    assert.deepEqual(result.committed, [state.uuid]);
    const second = await S.processPoiStateBatch({ states: [calc()], store, now: NOW, scanId: SCAN, applyChanges: () => { throw new Error("UNCHANGED transmis au pipeline"); } });
    assert.equal(second.classified[0].classification, "UNCHANGED"); assert.equal(store.commits.length, 1); assert.equal(store.observations.length, 1);
  });
  for (const [name, mutate] of [
    ["description", p => { p.hasDescription[0].description["@fr"] = "Description différente"; }],
    ["lieu", p => { p.isLocatedAt[0].address[0].streetAddress = ["2 rue de Rivoli"]; }],
    ["coordonnées", p => { p.isLocatedAt[0].geo.latitude = 49; }],
    ["organisateur", p => { p.hasContact[0].legalName = "Autre association"; }],
    ["URL", p => { p.uri = "https://example.org/autre"; }],
    ["image", p => { p.hasMainRepresentation[0].hasRelatedResource[0].locator = ["https://example.org/autre.jpg"]; }],
    ["période ajoutée", p => { p.takesPlaceAt.push(period("2026-11-15")); }],
    ["période retirée", p => { p.takesPlaceAt.pop(); }],
    ["heure", p => { p.takesPlaceAt[0].startTime = "11:00"; }],
    ["fuseau", p => { p.takesPlaceAt[0].timezone = "Indian/Reunion"; }],
    ["annulation", p => { p.isObsolete = true; }],
    ["KEEP → DENY", p => { p.type = ["Market"]; }]
  ]) await test(`${name} → CHANGED`, async () => { const p = poi(); mutate(p); assert.equal(await classification(calc(), calc(p)), "CHANGED"); });

  await test("DENY → KEEP → CHANGED ; DENY sans période est calculable", async () => {
    const p = poi(); p.type = ["Market"]; p.takesPlaceAt = [];
    const denied = calc(p); assert.equal(denied.editorial, "DENY");
    assert.equal(await classification(denied, calc()), "CHANGED");
    p.label = { "@fr": "Changement sans effet sur un refus" }; assert.equal(await classification(denied, calc(p)), "UNCHANGED");
  });
  await test("ordre des périodes/propriétés JSON, doublons et fetchedAt exclus", async () => {
    const p = poi(); p.takesPlaceAt.reverse(); p.takesPlaceAt.push(structuredClone(p.takesPlaceAt[0]));
    const reordered = JSON.parse(JSON.stringify(p, function (_k, v) { return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v; }));
    assert.equal(await classification(calc(), calc(reordered, { fetchedAt: "2027-01-01T00:00:00Z" })), "UNCHANGED");
  });
  await test("métadonnées API, catégories/tags source sans effet, période non sélectionnée exclus", async () => {
    const p = poi(); p.lastUpdate = "2030-01-01"; p.lastUpdateDatatourisme = "2030-02-01"; p.unused = { x: 3 };
    p.type = ["PointOfInterest", "Concert", "UnmappedType"]; p.hasTheme = [{ label: { "@fr": "Thème non mappé" } }]; p.takesPlaceAt.push(period("2030-01-01"));
    assert.equal(await classification(calc(), calc(p)), "UNCHANGED");
  });
  await test("preuve de récurrence : ordre des propriétés brutes et trace sans effet ignorés", async () => {
    const p = poi(); p.takesPlaceAt[0].appliesOnDay = ["Monday", "Tuesday"];
    const first = calc(p);
    p.takesPlaceAt[0] = { ignoredMetadata: "nouveau", ...Object.fromEntries(Object.entries(p.takesPlaceAt[0]).reverse()) };
    p.takesPlaceAt[0].appliesOnDay.reverse();
    assert.equal(await classification(first, calc(p)), "UNCHANGED");
    delete p.takesPlaceAt[0].appliesOnDay;
    assert.equal(await classification(first, calc(p)), "CHANGED", "confiance et preuve de récurrence ont un effet utile");
  });
  await test("catégorie et tag normalisés utiles → CHANGED", async () => {
    const first = calc(); const results = structuredClone(first.results); results[0].activity.category = "culture"; results[0].activity.tags = ["musique"];
    const next = S.fingerprintCalculatedPoi({ uuid: first.uuid, editorial: "KEEP", results });
    assert.equal(await classification(first, next), "CHANGED");
  });
  await test("ordre des organisateurs/tags/preuves normalisées n'affecte pas l'empreinte", () => {
    const first = calc(); first.results[0].activity.organizers.push({ name: "B", url: null }); first.results[0].activity.tags = ["b", "a"];
    const a = S.fingerprintCalculatedPoi(first); first.results[0].activity.organizers.reverse(); first.results[0].activity.tags.reverse();
    assert.equal(a.fingerprint, S.fingerprintCalculatedPoi(first).fingerprint);
  });
  await test("J+1 : sortie d'occurrence sans changement source → CHANGED", async () => {
    const p = poi(); p.takesPlaceAt = [period("2026-10-21"), period("2026-11-01")];
    assert.equal(await classification(calc(p), calc(p, { now: new Date(+NOW + 86400000) })), "CHANGED");
  });
  await test("J+1 : entrée à J+90 et glissement du plafond 30 → CHANGED", async () => {
    const p = poi(); p.takesPlaceAt = [period("2026-11-01"), { ...period("2027-01-20"), startTime: "09:00" }];
    assert.equal(await classification(calc(p), calc(p, { now: new Date(+NOW + 86400000) })), "CHANGED");
    p.takesPlaceAt = Array.from({ length: 31 }, (_, i) => period(new Date(Date.parse("2026-10-21T12:00Z") + i * 86400000).toISOString().slice(0, 10)));
    assert.equal(calc(p).results.length, 30); assert.equal(await classification(calc(p), calc(p, { now: new Date(+NOW + 86400000) })), "CHANGED");
  });
  await test("J+1 sans changement de sélection → UNCHANGED ; version → CHANGED", async () => {
    assert.equal(await classification(calc(), calc(poi(), { now: new Date(+NOW + 86400000) })), "UNCHANGED");
    assert.equal(await classification(calc(), calc(poi(), { version: "datatourisme-mnoria-v2" })), "CHANGED");
  });
  await test("changement de version durable seul force CHANGED", async () => {
    const s = calc(), old = row(s); old.algorithm_version = "ancienne-version";
    assert.equal((await S.comparePoiStates({ states: [s], store: new MemoryStore([old]) })).classified[0].classification, "CHANGED");
  });
  await test("500 POI : une lecture, une écriture, jamais d'appel individuel", async () => {
    const store = new MemoryStore(); const states = Array.from({ length: 500 }, (_, i) => calc(poi(i + 1)));
    const r = await S.processPoiStateBatch({ states, store, now: NOW, scanId: SCAN, applyChanges: async s => success(s) });
    assert.equal(r.committed.length, 500); assert.equal(store.reads.length, 1); assert.equal(store.reads[0].length, 500); assert.equal(store.commits.length, 1);
    await S.processPoiStateBatch({ states, store, now: NOW, scanId: SCAN, applyChanges: () => { throw new Error("interdit"); } });
    assert.equal(store.observations.length, 1); assert.equal(store.commits.length, 1);
  });
  await test("501 POI découpés 500+1 et lot vide sans lecture", async () => {
    const store = new MemoryStore(), states = Array.from({ length: 501 }, (_, i) => calc(poi(i + 1)));
    await S.comparePoiStates({ states, store }); assert.deepEqual(store.reads.map(a => a.length), [500, 1]);
    await S.comparePoiStates({ states: [], store }); assert.equal(store.reads.length, 2);
  });
  await test("RPC réelle du SDK : 500 UUID dans POST JSON, pas dans l'URL", async () => {
    const requests = [];
    const client = createClient("https://example.supabase.co", "fake-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url, init) => {
      requests.push({ url: String(url), ...init }); return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    } } });
    const states = Array.from({ length: 500 }, (_, i) => calc(poi(i + 1)));
    await S.comparePoiStates({ states, store: S.createSupabasePoiStateStore(client) });
    assert.equal(requests.length, 1); assert.equal(requests[0].method, "POST"); assert.equal(JSON.parse(requests[0].body).p_uuids.length, 500); assert.ok(requests[0].url.length < 200);
  });
  await test("échec persistance/réconciliation : aucune nouvelle référence, rejeu NEW", async () => {
    for (const outcome of [{ persistence: "failed", reconciliation: "completed" }, { persistence: "completed", reconciliation: "failed" }, { persistence: "completed" }]) {
      const store = new MemoryStore();
      await S.processPoiStateBatch({ states: [calc()], store, now: NOW, scanId: SCAN, applyChanges: async s => [{ uuid: s[0].uuid, ...outcome }] });
      assert.equal(store.rows.size, 0); assert.equal((await S.comparePoiStates({ states: [calc()], store })).classified[0].classification, "NEW");
    }
  });
  await test("exception et écriture de référence échouée conservent CHANGED", async () => {
    const first = calc(), p = poi(); p.hasDescription[0].description["@fr"] = "Autre"; const next = calc(p);
    const store = new MemoryStore([row(first)]);
    await assert.rejects(S.processPoiStateBatch({ states: [next], store, now: NOW, scanId: SCAN, applyChanges: async () => { throw new Error("panne"); } }), /panne/);
    store.commitBatch = async () => { throw new Error("état indisponible"); };
    await assert.rejects(S.processPoiStateBatch({ states: [next], store, now: NOW, scanId: SCAN, applyChanges: async s => success(s) }), /état indisponible/);
    assert.equal((await S.comparePoiStates({ states: [next], store })).classified[0].classification, "CHANGED");
  });
  await test("succès partiel par POI : seul le succès complet est enregistré", async () => {
    const store = new MemoryStore(); const states = [calc(poi(1)), calc(poi(2))];
    await S.processPoiStateBatch({ states, store, now: NOW, scanId: SCAN, applyChanges: async s => [success(s)[0], { uuid: s[1].uuid, persistence: "failed", reconciliation: "failed" }] });
    assert.equal(store.rows.size, 1); assert.ok(store.rows.has(id(1)));
  });
  await test("panne de lecture durable : aucun appel de persistance et aucune écriture", async () => {
    const store = new MemoryStore(); store.loadBatch = async () => { throw new Error("lecture échouée"); };
    await assert.rejects(S.processPoiStateBatch({ states: [calc()], store, now: NOW, scanId: SCAN, applyChanges: async () => { throw new Error("ne doit pas être appelé"); } }), /lecture échouée/);
    assert.equal(store.commits.length, 0); assert.equal(store.observations.length, 0);
  });
  await test("DENY/KEEP vide nécessitent aussi le succès explicite de réconciliation", async () => {
    for (const p of [Object.assign(poi(), { type: ["Market"] }), Object.assign(poi(), { takesPlaceAt: [period("2020-01-01")] })]) {
      const state = calc(p), store = new MemoryStore(); assert.equal(state.results.length, 0);
      await S.processPoiStateBatch({ states: [state], store, now: NOW, scanId: SCAN, applyChanges: async () => [] }); assert.equal(store.rows.size, 0);
    }
  });
  await test("entrées invalides, doublons, état incohérent et faux accusés refusés", async () => {
    assert.throws(() => calc(poi(), { now: null }), /Instant/);
    assert.throws(() => calc({ ...poi(), uuid: "invalide" }), /UUID/);
    assert.throws(() => calc({ ...poi(), takesPlaceAt: [] }), /inexploitable/);
    const store = new MemoryStore();
    await assert.rejects(S.comparePoiStates({ states: [calc(), calc()], store }), /dupliqué/); assert.equal(store.reads.length, 0);
    await assert.rejects(S.processPoiStateBatch({ states: [calc()], store, now: NOW, scanId: SCAN, applyChanges: async () => [{ uuid: id(999), persistence: "completed", reconciliation: "completed" }] }), /incohérent/); assert.equal(store.commits.length, 0);
  });
  console.log(`\n${passed} réussis, ${failed} échoués`); if (failed) process.exitCode = 1;
})();
