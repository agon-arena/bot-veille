"use strict";

const assert = require("assert/strict");
const { createClient } = require("@supabase/supabase-js");
const N = require("./datatourisme-national-scan");
const R = require("./datatourisme-poi-reconciliation");
const { harness, poi, NOW, SOURCE, id } = require("./test-datatourisme-poi-reconciliation");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };
let sequence = 0;
const freshScan = () => `77777777-2222-3333-4444-${String(++sequence).padStart(12, "0")}`;

// Transactional reference model of the proposed SQL, on the real pipeline's MemoryStore.
class MemoryScanStore {
  constructor(h) { this.h = h; this.control = null; this.calls = []; }
  async beginScan(s) {
    this.calls.push("begin");
    if (["running", "complete"].includes(this.control?.status)) throw new Error("scan actif");
    if ([this.control?.id, this.control?.last_finalized_id].includes(s.scanId)) throw new Error("scan réutilisé");
    this.control = { id: s.scanId, status: "running", next_url: s.initialUrl, total: null, pages: 0, received: 0, pending: null, last_finalized_id: this.control?.last_finalized_id, last_result: this.control?.last_result };
  }
  async observePage(s) {
    this.calls.push("observe"); const c = this.control, rows = this.h.stateStore.rows;
    if (c?.id !== s.scanId || c.status !== "running" || c.next_url !== s.url || c.pending) throw new Error("page hors scan");
    if (s.ids.some(id => rows.get(id)?.last_observed_scan_id === s.scanId)) throw new Error("POI déjà reçu");
    for (const id of s.ids) {
      const row = rows.get(id) || { poi_uuid: id, fingerprint: null, algorithm_version: null, needs_reprocess: false };
      Object.assign(row, { last_observed_at: s.now, last_observed_scan_id: s.scanId, absence_count: 0, last_absence_scan_id: null }); rows.set(id, row);
    }
    c.pending = s;
  }
  async finishPage(s) {
    this.calls.push("finish"); const c = this.control, p = c.pending;
    if (c.id !== s.scanId || c.status !== "running" || p?.url !== s.url) throw new Error("chunk non certifié");
    c.pages++; c.received += p.ids.length; c.next_url = p.nextUrl; c.total = p.total; c.pending = null;
    c.status = c.next_url === null ? "complete" : "running";
  }
  async failScan(s) { this.calls.push("fail"); if (this.control?.id === s.scanId && ["running", "complete"].includes(this.control.status)) this.control.status = "failed"; }
  async finalizeScan(s) {
    this.calls.push("finalize"); const c = this.control;
    if (c?.last_finalized_id === s.scanId) return structuredClone(c.last_result);
    if (c?.id !== s.scanId || c.status !== "complete" || c.pending || c.next_url !== null || !c.pages || c.total <= 0 || c.received !== c.total) throw new Error("scan non complet");
    const rows = this.h.stateStore.rows, activities = this.h.activityStore.activities, provenances = this.h.activityStore.provenances;
    const snapshot = structuredClone({ rows, activities, provenances, control: c });
    try {
      const confirmed = new Set(); let first = 0;
      for (const row of rows.values()) if (row.last_observed_scan_id !== s.scanId && (row.absence_count || 0) < 2) {
        row.absence_count = (row.absence_count || 0) + 1; row.last_absence_scan_id = s.scanId;
        if (row.absence_count === 1) first++; else { confirmed.add(row.poi_uuid); row.needs_reprocess = true; }
      }
      const affected = new Set(); let deactivated = 0, staled = 0;
      for (const p of provenances) if (p.source_id === SOURCE && p.source_record_id?.startsWith("datatourisme:") && confirmed.has(p.source_record_id.split(":")[1])) {
        affected.add(p.activity_id); if (p.active) { p.active = false; deactivated++; }
      }
      if (this.failAfterDeactivation) { this.failAfterDeactivation = false; throw new Error("panne transactionnelle"); }
      for (const a of activities) if (affected.has(a.id) && ["active", "review"].includes(a.record_status) && !provenances.some(p => p.activity_id === a.id && p.active)) { a.record_status = "stale"; staled++; }
      const result = { scan_id: s.scanId, observed: c.received, first_absences: first, confirmed_absences: confirmed.size, deactivated, staled };
      c.status = "finalized"; c.last_finalized_id = s.scanId; c.last_result = result;
      return structuredClone(result);
    } catch (error) {
      this.h.stateStore.rows = snapshot.rows; this.h.activityStore.activities = snapshot.activities; this.h.activityStore.provenances = snapshot.provenances; this.control = snapshot.control;
      throw error;
    }
  }
}
function setup() {
  const h = harness(), store = new MemoryScanStore(h);
  const processor = N.receivedPoiProcessor({ stateStore: h.stateStore, activityStore: h.activityStore,
    persistOccurrences: (states, context) => R.createDatatourismePoiPersister({ store: h.activityStore, now: context.now })(states) });
  const sentinel = poi("D", 99999);
  return { h, store, sentinel, async scan(pois, options = {}) {
    const objects = [...pois, sentinel], scanId = options.scanId || freshScan();
    const fetchPage = async url => {
      const page = Number(new URL(url).searchParams.get("page") || 1), from = (page - 1) * 100;
      const next = new URL(url); next.searchParams.set("page", String(page + 1));
      return { objects: objects.slice(from, from + 100), meta: { total: objects.length, next: from + 100 < objects.length ? next.toString() : null } };
    };
    return N.runNationalScan({ store, sourceId: SOURCE, scanId, now: NOW, fetchPage, processPage: processor, ...options });
  }, finalize(scanId) { return N.finalizeNationalScan({ store, sourceId: SOURCE, scanId, now: NOW }); } };
}
const snapshot = s => JSON.stringify({ rows: [...s.h.stateStore.rows], activities: s.h.activityStore.activities, provenances: s.h.activityStore.provenances, control: s.store.control });
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }
(async () => {
  await test("J1 présent / J2 absent / J3 présent : absence annulée sans désactivation", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId);
    const j2 = await s.scan([]); const r = await s.finalize(j2.scanId); assert.equal(r.first_absences, 1); assert.equal(r.deactivated, 0);
    assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 1);
    await s.scan([poi()]); assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0); assert.equal(s.h.stateStore.rows.get(id(1)).last_absence_scan_id, null);
    await s.finalize(s.store.control.id); assert.ok(s.h.activityStore.provenances.every(p => p.active));
  });
  await test("observation catalogue déjà durable : pas de deuxième écriture UNCHANGED", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId);
    s.h.stateStore.observeBatch = async () => { throw new Error("observation redondante"); };
    const second = await s.scan([poi()]); await s.finalize(second.scanId);
    assert.equal(s.h.stateStore.rows.get(id(1)).last_observed_scan_id, second.scanId);
  });
  await test("deux absences puis réapparition identique : CHANGED forcé, réactivation sans doublon", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId);
    await s.finalize((await s.scan([])).scanId); const result = await s.finalize((await s.scan([])).scanId);
    assert.equal(result.confirmed_absences, 1); assert.equal(result.deactivated, 3); assert.equal(result.staled, 3);
    assert.equal(s.h.stateStore.rows.get(id(1)).needs_reprocess, true);
    const count = [s.h.activityStore.activities.length, s.h.activityStore.provenances.length];
    await s.scan([poi()]); assert.equal(s.h.stateStore.rows.get(id(1)).needs_reprocess, false);
    assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0); assert.deepEqual([s.h.activityStore.activities.length, s.h.activityStore.provenances.length], count);
    assert.ok(s.h.activityStore.provenances.every(p => p.active));
  });
  await test("POI invalide reçu : observé avant conversion, ancienne empreinte et occurrences conservées", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId); const hash = s.h.stateStore.rows.get(id(1)).fingerprint;
    await s.finalize((await s.scan([])).scanId);
    const bad = poi(); bad.takesPlaceAt[0].endTime = "09:00";
    const received = await s.scan([bad]); assert.equal(received.invalid, 1); assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0);
    assert.equal(s.h.stateStore.rows.get(id(1)).fingerprint, hash);
    const finalized = await s.finalize(received.scanId); assert.equal(finalized.confirmed_absences, 0); assert.equal(finalized.first_absences, 0); assert.ok(s.h.activityStore.provenances.every(p => p.active));
    await s.finalize((await s.scan([bad])).scanId); assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0);
  });
  await test("335 nouveaux invalides : placeholders observés, aucune empreinte validée ni absence", async () => {
    const s = setup(); const bad = Array.from({ length: 335 }, (_, i) => { const p = poi("A", i + 1); p.takesPlaceAt[0].endTime = "09:00"; return p; });
    const r = await s.scan(bad); assert.equal(r.invalid, 335); assert.equal(r.errorCodes.ends_before_start, 335); assert.equal(r.pages, 4);
    const f = await s.finalize(r.scanId); assert.equal(f.first_absences, 0);
    for (const p of bad) { const row = s.h.stateStore.rows.get(p.uuid); assert.equal(row.fingerprint, null); assert.equal(row.algorithm_version, null); assert.equal(row.absence_count, 0); }
  });
  await test("multisource active/review et autre POI fusionné restent soutenus", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId);
    const p = s.h.activityStore.provenances.find(p => p.source_record_id.startsWith(`datatourisme:${id(1)}:`));
    s.h.activityStore.activities.find(a => a.id === p.activity_id).record_status = "review";
    s.h.activityStore.provenances.push({ id: "other", activity_id: p.activity_id, source_id: id(5555), active: true });
    await s.finalize((await s.scan([])).scanId); await s.finalize((await s.scan([])).scanId);
    assert.equal(s.h.activityStore.activities.find(a => a.id === p.activity_id).record_status, "review"); assert.equal(s.h.activityStore.provenances.at(-1).active, true);
  });
  await test("finalisation rejouée : résultat identique, zéro deuxième incrément/désactivation", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId);
    const firstScan = await s.scan([]); const first = await s.finalize(firstScan.scanId), before = snapshot(s);
    assert.deepEqual(await s.finalize(firstScan.scanId), first); assert.equal(snapshot(s), before);
    const secondScan = await s.scan([]); const second = await s.finalize(secondScan.scanId), after = snapshot(s);
    assert.deepEqual(await s.finalize(secondScan.scanId), second); assert.equal(snapshot(s), after);
    const third = await s.finalize((await s.scan([])).scanId); assert.equal(third.confirmed_absences, 0); assert.equal(third.deactivated, 0);
    await assert.rejects(s.finalize(firstScan.scanId), /non complet/);
  });
  await test("scan interrompu après 10 pages : aucune progression d'absence", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId); const hash = s.h.stateStore.rows.get(id(1)).fingerprint;
    await assert.rejects(s.scan(Array.from({ length: 1001 }, (_, i) => poi("A", 1000 + i)), { maxPages: 10 }), /tronqué/);
    assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0); assert.equal(s.h.stateStore.rows.get(id(1)).fingerprint, hash);
    await assert.rejects(s.finalize(s.store.control.id), /non complet/); assert.ok(s.h.activityStore.provenances.filter(p => p.source_record_id.includes(id(1))).every(p => p.active));
  });
  await test("erreur API page N et erreur de chunk : finalisation interdite", async () => {
    for (const kind of ["api", "chunk"]) {
      const s = setup(); await s.finalize((await s.scan([poi()])).scanId);
      const options = kind === "api" ? { fetchPage: async () => { throw new Error("API page N"); } } : { processPage: async () => { throw new Error("chunk échoué"); } };
      await assert.rejects(s.scan([poi("A", 2)], options), /API|chunk/);
      await assert.rejects(s.finalize(s.store.control.id), /non complet/); assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0);
    }
  });
  await test("erreur API page 3 après deux pages réussies : zéro progression", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId); let page = 0;
    await assert.rejects(s.scan([], { fetchPage: async url => {
      page++; if (page === 3) throw new Error("API page 3");
      const next = new URL(url); next.searchParams.set("page", String(page + 1));
      const objects = Array.from({ length: 100 }, (_, i) => { const p = poi("A", 2000 + page * 100 + i); p.takesPlaceAt[0].endTime = "09:00"; return p; });
      return { objects, meta: { total: 301, next: next.toString() } };
    } }), /page 3/);
    assert.equal(s.store.control.pages, 2); assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0);
    await assert.rejects(s.finalize(s.store.control.id), /non complet/);
  });
  await test("quota HTTP 429 / réponse partielle 206 : échec de scan, aucune absence", async () => {
    for (const status of [429, 206]) {
      const s = setup(); await s.finalize((await s.scan([poi()])).scanId);
      const fetchPage = N.createNationalPageFetcher({ apiKey: "fake", request: async () => new Response(JSON.stringify({ objects: [s.sentinel], meta: { total: 1, next: null } }), { status }) });
      await assert.rejects(s.scan([], { fetchPage }), /HTTP/); assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0);
      await assert.rejects(s.finalize(s.store.control.id), /non complet/);
    }
  });
  await test("chunk retourné partiel sans exception : aucune certification de page", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId);
    await assert.rejects(s.scan([poi()], { processPage: async pois => ({ classified: pois.map(p => ({ uuid: p.uuid, classification: "CHANGED" })), committed: [], errors: [] }) }), /Chunk non terminé/);
    assert.equal(s.store.control.pages, 0); await assert.rejects(s.finalize(s.store.control.id), /non complet/);
  });
  await test("scan complet sans appel de finalisation : aucune absence ne progresse", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId); await s.scan([]);
    assert.equal(s.store.control.status, "complete"); assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0); assert.ok(s.h.activityStore.provenances.every(p => p.active));
  });
  await test("crash après observation avant acquittement : durable running, jamais finalisable", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId);
    const scanId = freshScan(), url = N.nationalUrl(NOW);
    await s.store.beginScan({ scanId, initialUrl: url }); await s.store.observePage({ scanId, url, nextUrl: null, ids: [s.sentinel.uuid], total: 1, now: NOW.toISOString() });
    await assert.rejects(s.finalize(scanId), /non complet/); assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0);
    await assert.rejects(s.scan([]), /actif/);
    await s.store.failScan({ scanId }); await s.finalize((await s.scan([poi()])).scanId);
  });
  await test("pagination terminée trop tôt, total instable, doublons, filtre modifié ou catalogue vide refusés", async () => {
    for (const kind of ["early", "total", "duplicate", "scope", "empty"]) {
      const s = setup(); await s.finalize((await s.scan([poi()])).scanId); let page = 0;
      await assert.rejects(s.scan([], { fetchPage: async url => {
        page++; const next = new URL(url); next.searchParams.set("page", "2"); if (kind === "scope") next.searchParams.set("search", "Paris");
        if (kind === "empty") return { objects: [], meta: { total: 0, next: null } };
        return { objects: [s.sentinel], meta: { total: kind === "total" && page > 1 ? 3 : 2, next: kind === "early" || page > 1 ? null : next.toString() } };
      } }));
      assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0); await assert.rejects(s.finalize(s.store.control.id), /non complet/);
    }
  });
  await test("échec transactionnel après désactivation : rollback total puis rejeu sûr", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId); await s.finalize((await s.scan([])).scanId);
    const j3 = await s.scan([]), before = snapshot(s); s.store.failAfterDeactivation = true;
    await assert.rejects(s.finalize(j3.scanId), /transactionnelle/); assert.equal(snapshot(s), before);
    const result = await s.finalize(j3.scanId); assert.equal(result.deactivated, 3); assert.equal(result.confirmed_absences, 1);
  });
  await test("réapparition invalide après désactivation conserve le retry forcé jusqu'au succès", async () => {
    const s = setup(); await s.finalize((await s.scan([poi()])).scanId); await s.finalize((await s.scan([])).scanId); await s.finalize((await s.scan([])).scanId);
    const bad = poi(); bad.takesPlaceAt = []; await s.finalize((await s.scan([bad])).scanId);
    assert.equal(s.h.stateStore.rows.get(id(1)).absence_count, 0); assert.equal(s.h.stateStore.rows.get(id(1)).needs_reprocess, true);
    await s.scan([poi()]); assert.equal(s.h.stateStore.rows.get(id(1)).needs_reprocess, false); assert.ok(s.h.activityStore.provenances.every(p => p.active));
  });
  await test("RPC finale : une seule requête POST quel que soit le nombre de POI", async () => {
    const requests = [];
    const client = createClient("https://example.supabase.co", "fake", { auth: { persistSession: false }, global: { fetch: async (url, init) => {
      requests.push({ url: String(url), ...init }); return new Response(JSON.stringify({ confirmed_absences: 1000 }), { status: 200, headers: { "Content-Type": "application/json" } });
    } } });
    const store = N.createSupabaseNationalScanStore(client); await N.finalizeNationalScan({ store, sourceId: SOURCE, scanId: freshScan(), now: NOW });
    assert.equal(requests.length, 1); assert.equal(requests[0].method, "POST"); assert.equal(Object.keys(JSON.parse(requests[0].body)).length, 3);
  });
  for (const [absent, previous, label] of [[0, 0, "aucun absent"], [100, 0, "premières absences"], [100, 1, "confirmées"], [1000, 1, "confirmées"]]) await test(`61 289 états, ${absent} ${label} : 1 RPC finale`, async () => {
    const s = setup(), scanId = freshScan(), oldId = freshScan();
    for (let i = 1; i <= 61289; i++) {
      const missing = i <= absent;
      s.h.stateStore.rows.set(id(i), { poi_uuid: id(i), fingerprint: "0".repeat(64), algorithm_version: "test", last_observed_scan_id: missing ? oldId : scanId, absence_count: missing ? previous : 0, last_absence_scan_id: missing && previous ? oldId : null, needs_reprocess: false });
      if (missing) for (let k = 0; k < 3; k++) {
        const aid = `a-${i}-${k}`; s.h.activityStore.activities.push({ id: aid, record_status: "active" });
        s.h.activityStore.provenances.push({ id: `p-${i}-${k}`, activity_id: aid, source_id: SOURCE, source_record_id: `datatourisme:${id(i)}:old-${k}`, active: true });
      }
    }
    s.store.control = { id: scanId, status: "complete", next_url: null, pending: null, pages: 613, total: 61289 - absent, received: 61289 - absent };
    let requests = 0;
    const client = createClient("https://example.supabase.co", "fake", { auth: { persistSession: false }, global: { fetch: async (_url, init) => {
      requests++; assert.equal(init.method, "POST"); const args = JSON.parse(init.body);
      const result = await s.store.finalizeScan({ scanId: args.p_scan_id });
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    } } });
    const before = performance.now(); const result = await N.finalizeNationalScan({ store: N.createSupabaseNationalScanStore(client), sourceId: SOURCE, scanId, now: NOW });
    assert.equal(requests, 1); assert.equal(result.first_absences, previous ? 0 : absent); assert.equal(result.confirmed_absences, previous ? absent : 0);
    assert.equal(result.deactivated, previous ? absent * 3 : 0); assert.equal(result.staled, previous ? absent * 3 : 0);
    console.log(`  modèle mémoire + transport SDK : ${(performance.now() - before).toFixed(1)} ms (aucune mesure SQL réelle)`);
  });
  console.log(`\n${passed} réussis, ${failed} échoués`); if (failed) process.exitCode = 1;
})();
