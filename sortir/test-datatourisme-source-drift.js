"use strict";
// Fin de snapshot avec dérive de source : seule une fin de curseur PROUVÉE peut précéder le
// meta.total initial ; erreurs, troncatures et trous de pagination restent bloquants, et
// aucune absence ne progresse pour un snapshot en dérive.
const assert = require("assert/strict"), fs = require("fs"), path = require("path");
const { harness, poi, NOW, SOURCE } = require("./test-datatourisme-poi-reconciliation");
const N = require("./datatourisme-national-scan"), R = require("./datatourisme-poi-reconciliation"), S = require("./datatourisme-activity-safety"), Q = require("./datatourisme-review-quarantine");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };
let passed = 0, failed = 0, seq = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }
const scanId = () => `77777777-2222-3333-4444-${String(++seq).padStart(12, "0")}`;

// Reference model of the SQL protocol (observe v2 / terminal drift / finish / finalize).
class DriftStore {
  constructor(h) { this.h = h; this.c = null; this.calls = []; }
  get rows() { return this.h.stateStore.rows; }
  async beginBatchScan(s) { this.c = { id: s.scanId, started_at: s.now, initial_url: s.initialUrl, next_url: s.initialUrl, batch_size: s.checkpointSize, status: "running", pages: 0, received: 0, total: null, invalid: 0, error_codes: {}, pending: null, last_finalized_id: null }; }
  async resumeBatchScan(s) { if (this.c?.id !== s.scanId || !["running", "complete"].includes(this.c.status)) throw new Error("Scan non reprenable"); return structuredClone(this.c); }
  guard(s) { const c = this.c; if (c?.id !== s.scanId || c.status !== "running" || c.next_url !== s.url || s.now !== c.started_at) throw new Error("Lot/horloge invalide"); }
  observeStates(s) {
    if (s.ids.some(id => this.rows.get(id)?.last_observed_scan_id === s.scanId)) throw new Error("POI déjà reçu dans ce scan");
    for (const id of s.ids) { const row = this.rows.get(id) || { poi_uuid: id, fingerprint: null, algorithm_version: null, needs_reprocess: false }; Object.assign(row, { last_observed_at: s.now, last_observed_scan_id: s.scanId, absence_count: 0, last_absence_scan_id: null }); this.rows.set(id, row); }
  }
  async observeBatch(s) {
    this.calls.push("observe"); this.guard(s); const c = this.c, expected = { url: s.url, next: s.nextUrl, total: s.total, count: s.ids.length, page_count: s.pages, ids: s.ids };
    if (c.pending) { const { selection_now, ...rest } = c.pending; assert.deepEqual(rest, expected, "Reprise différente"); assert.equal(selection_now, s.selectionNow); return; }
    const n = s.ids.length;
    if ((c.total !== null && c.total !== s.total) || c.received + n > s.total || (s.nextUrl === null && c.received + n !== s.total) || (s.nextUrl !== null && (n === 0 || c.received + n >= s.total))) throw new Error("Pagination nationale incomplète");
    this.observeStates(s); c.pending = { ...expected, selection_now: s.selectionNow };
  }
  async observeTerminalDriftBatch(s) {
    this.calls.push("observe-drift"); this.guard(s); const c = this.c, expected = { url: s.url, next: null, total: s.total, count: s.ids.length, page_count: s.pages, ids: s.ids };
    if (c.pending) { const { selection_now, source_drift, ...rest } = c.pending; assert.deepEqual(rest, expected); assert.equal(selection_now, s.selectionNow); assert.equal(source_drift.terminal_page, s.terminalPage); assert.equal(source_drift.terminal_count, s.terminalCount); return; }
    const n = s.ids.length, rec = c.received + n;
    if (n < 1 || (c.total !== null && c.total !== s.total) || c.received !== c.pages * 100 || rec >= s.total || s.pageSize !== 100 || s.terminalCount < 1 || s.terminalCount > 100 ||
      s.terminalPage !== c.pages + s.pages || rec !== (s.terminalPage - 1) * 100 + s.terminalCount || !(s.controlTotal > 0) || s.controlTotal > rec || !s.controlAt) throw new Error("Fin de curseur non démontrée : dérive refusée");
    this.observeStates(s);
    c.pending = { ...expected, selection_now: s.selectionNow, source_drift: { initial_total: s.total, received_total: rec, missing: s.total - rec, terminal_page: s.terminalPage, page_size: 100, terminal_count: s.terminalCount, terminal_url: s.url, control_total: s.controlTotal, control_at: s.controlAt, scan_started_at: c.started_at } };
  }
  async finishBatch(s) {
    this.calls.push("finish"); const c = this.c, p = c.pending; if (c.last_acked_batch_url === s.url) return;
    if (c.status !== "running" || p?.url !== s.url) throw new Error("Aucun chunk en attente à certifier");
    const received = c.received + p.count; let drift = null;
    if (p.next === null && received !== p.total) {
      drift = p.source_drift; if (!drift || drift.received_total !== received || drift.initial_total !== p.total || received >= p.total || !(drift.control_total <= received)) throw new Error("Total incomplet");
    }
    Object.assign(c, { received, pages: c.pages + p.page_count, total: p.total, next_url: p.next, pending: null, status: p.next === null ? "complete" : "running", invalid: c.invalid + s.invalid, last_acked_batch_url: s.url }, drift ? { source_drift: drift } : {});
  }
  async finalizeScan(s) {
    const c = this.c; if (c.last_finalized_id === s.scanId) return structuredClone(c.last_result);
    const drift = c.source_drift, driftOk = drift && drift.received_total === c.received && drift.initial_total === c.total && c.received < c.total && drift.control_total <= c.received;
    if (c.id !== s.scanId || c.status !== "complete" || c.pending || c.next_url !== null || c.pages < 1 || !(c.total > 0) || (c.received !== c.total && !driftOk)) throw new Error("Scan national non complet : aucune absence ne peut progresser");
    let result;
    if (c.received !== c.total) result = { scan_id: s.scanId, completion: "completed_with_source_drift", observed: c.received, first_absences: 0, confirmed_absences: 0, deactivated: 0, staled: 0, unobserved_states_not_counted: [...this.rows.values()].filter(r => r.last_observed_scan_id !== s.scanId).length, source_drift: drift };
    else {
      const confirmed = new Set(); let first = 0;
      for (const row of this.rows.values()) if (row.last_observed_scan_id !== s.scanId && (row.absence_count || 0) < 2) { row.absence_count = (row.absence_count || 0) + 1; row.last_absence_scan_id = s.scanId; if (row.absence_count === 1) first++; else confirmed.add(row.poi_uuid); }
      let deactivated = 0, staled = 0; const affected = new Set(), a = this.h.activityStore;
      for (const p of a.provenances) if (confirmed.has(p.source_record_id?.split(":")[1])) { affected.add(p.activity_id); if (p.active) { p.active = false; deactivated++; } }
      for (const x of a.activities) if (affected.has(x.id) && ["active", "review"].includes(x.record_status) && !a.provenances.some(p => p.activity_id === x.id && p.active)) { x.record_status = "stale"; staled++; }
      result = { scan_id: s.scanId, observed: c.received, first_absences: first, confirmed_absences: confirmed.size, deactivated, staled };
    }
    Object.assign(c, { status: "finalized", last_finalized_id: s.scanId, last_result: result }); return structuredClone(result);
  }
}
// DATAtourisme cursor shape: meta.page sequential, meta.next ABSENT on the terminal page.
function catalogue(pois, { total = pois.length, pageSize = 100, mutate = () => {} } = {}) {
  const pages = [];
  for (let i = 0; i * pageSize < pois.length; i++) pages.push({ objects: pois.slice(i * pageSize, (i + 1) * pageSize), meta: { total, page: i + 1, page_size: pageSize, total_pages: Math.ceil(total / pageSize) } });
  pages.forEach((p, i) => { if (i < pages.length - 1) p.meta.next = `${N.nationalUrl(NOW)}&crs=${i + 2}`; });
  mutate(pages);
  const byUrl = new Map(pages.map((p, i) => [i ? `${N.nationalUrl(NOW)}&crs=${i + 1}` : N.nationalUrl(NOW), p]));
  return async url => { const p = byUrl.get(url); if (!p) throw new Error("page inconnue " + url); return structuredClone(p); };
}
const pois = (count, from = 1) => Array.from({ length: count }, (_, i) => poi("B", from + i));
function setup(options = {}) {
  const h = harness(), store = new DriftStore(h), id = scanId();
  const processPage = N.receivedPoiProcessor({ stateStore: h.stateStore, activityStore: h.activityStore,
    persistOccurrences: options.persist || ((states, context) => R.createDatatourismePoiPersister({ store: h.activityStore, now: context.now, beforeCreateActivity: S.guardExactSignatureReview })(states)) });
  const run = (fetchPage, extra = {}) => N.runNationalScanBatched({ store, sourceId: SOURCE, scanId: id, now: NOW, fetchPage, processPage, checkpointSize: 1000, ...extra });
  const finalize = () => N.finalizeNationalScan({ store, sourceId: SOURCE, scanId: id, now: NOW });
  return { h, store, id, run, finalize };
}
const drift = control => ({ controlTotal: async () => control });
const covered = (h, list) => list.every(p => h.activityStore.provenances.some(x => x.active && x.source_record_id.startsWith(`datatourisme:${p.uuid}:`)) && h.stateStore.rows.get(p.uuid)?.fingerprint);

(async () => {
  await test("A — total stable + fin normale → completed normal, absences normales", async () => {
    const s = setup(), list = pois(250); const r = await s.run(catalogue(list), { sourceDrift: drift(250) });
    assert.equal(r.status, "complete"); assert.equal(r.received, 250); assert.equal(r.sourceDrift, undefined); assert.ok(!s.store.calls.includes("observe-drift"));
    const f = await s.finalize(); assert.equal(f.completion, undefined); assert.equal(f.observed, 250); assert.ok(covered(s.h, list));
  });
  await test("B — total initial > retourné + fin explicite → completed_with_source_drift tracé", async () => {
    const s = setup(), list = pois(250); const r = await s.run(catalogue(list, { total: 284 }), { sourceDrift: drift(240) });
    assert.equal(r.received, 250); assert.deepEqual({ ...r.sourceDrift, controlAt: undefined }, { terminalPage: 3, pageSize: 100, terminalCount: 50, initialTotal: 284, receivedTotal: 250, controlTotal: 240, controlAt: undefined });
    assert.equal(s.store.c.source_drift.missing, 34); assert.ok(covered(s.h, list));
    const f = await s.finalize(); assert.equal(f.completion, "completed_with_source_drift"); assert.equal(f.source_drift.initial_total, 284); assert.equal(f.source_drift.received_total, 250);
    assert.equal(f.deactivated, 0); assert.equal(f.staled, 0); assert.equal(f.first_absences, 0);
  });
  await test("B — dérive non opt-in, ou contrôle frais supérieur au reçu → bloquant, rien observé", async () => {
    for (const extra of [{}, { sourceDrift: drift(260) }, { sourceDrift: drift(0) }]) {
      const s = setup(), list = pois(250);
      await assert.rejects(s.run(catalogue(list, { total: 284 }), extra), /Pagination incomplète|non expliquée/);
      assert.equal(s.store.c.pending, null); assert.equal(s.store.c.received, 0); assert.equal(s.h.stateStore.rows.size, 0); await assert.rejects(s.finalize(), /non complet/);
    }
  });
  for (const [name, error] of [["C — timeout", new Error("The operation was aborted due to timeout")], ["D — HTTP 502", new Error("API DATAtourisme HTTP 502")]]) await test(`${name} sur la dernière page → jamais une fin, bloquant`, async () => {
    const s = setup(), list = pois(250), fetch = catalogue(list, { total: 284 });
    await assert.rejects(s.run(async url => { if (url.endsWith("crs=3")) throw error; return fetch(url); }, { sourceDrift: drift(240) }), new RegExp(error.message));
    assert.equal(s.store.c.status, "running"); assert.equal(s.store.c.pending, null); await assert.rejects(s.finalize(), /non complet/);
  });
  await test("D/E — transport réel : 502 et JSON tronqué lèvent une erreur, jamais une page terminale", async () => {
    for (const [status, body] of [[502, "<html>502 Bad Gateway</html>"], [200, '{"objects":[{"uuid":"11111111-2222-3333-4444-0000']]) {
      const fetchPage = N.createNationalPageFetcher({ apiKey: "k", request: async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }) });
      const s = setup(); await assert.rejects(s.run(fetchPage, { sourceDrift: drift(1) })); assert.equal(s.store.c.pending, null); assert.equal(s.store.c.received, 0);
    }
  });
  await test("F — chaîne cassée (next hors catalogue, cycle) → bloquant", async () => {
    for (const mutate of [pages => { pages[0].meta.next = "https://evil.example/v1/entertainmentAndEvent"; }, pages => { pages[1].meta.next = `${N.nationalUrl(NOW)}&crs=2`; }]) {
      const s = setup(); await assert.rejects(s.run(catalogue(pois(250), { total: 284, mutate }), { sourceDrift: drift(240) }), /catalogue|cyclique/); assert.equal(s.store.c.received, 0);
    }
  });
  await test("G — page intermédiaire manquante ou incomplète → preuve refusée, bloquant", async () => {
    for (const mutate of [pages => { pages[2].meta.page = 4; }, pages => { pages[1].objects.pop(); }, pages => { pages[2].meta.page_size = 50; }]) {
      const s = setup(); await assert.rejects(s.run(catalogue(pois(250), { total: 284, mutate }), { sourceDrift: drift(200) }), /Pagination incomplète/); assert.equal(s.store.c.received, 0);
    }
    assert.equal(N.terminalDriftProof([{ meta: { page: 1, page_size: 100, next: "x" }, count: 40 }], { pagesBefore: 0, receivedBefore: 0, received: 40, total: 50 }), null);
  });
  await test("H — occurrence reçue non couverte → lot non acquitté, finalisation impossible", async () => {
    const s = setup({ persist: async states => states.map(x => ({ uuid: x.uuid, status: "completed" })) });
    await assert.rejects(s.run(catalogue(pois(150), { total: 170 }), { sourceDrift: drift(150) }), /Couverture/);
    assert.ok(s.store.c.pending); assert.equal(s.store.c.received, 0); await assert.rejects(s.finalize(), /non complet/);
  });
  await test("I — REVIEW complète dans le lot terminal : couverture valide, dérive finalisée", async () => {
    const s = setup(), list = pois(150); list[1].label = list[0].label; list[1].takesPlaceAt = list[0].takesPlaceAt;
    await s.run(catalogue(list, { total: 170 }), { sourceDrift: drift(150) });
    const q = s.h.activityStore.activities.filter(a => Q.evaluateQuarantine({ ...a, provenances: s.h.activityStore.provenances.filter(p => p.activity_id === a.id), external_ids: s.h.activityStore.externalIds.filter(e => e.activity_id === a.id) }, s.h.activityStore.decisions).complete);
    assert.equal(q.length, 1); assert.equal(q[0].record_status, "review"); assert.equal((await s.finalize()).completion, "completed_with_source_drift");
  });
  await test("J — REVIEW incomplète (bascule interrompue) → lot terminal non acquitté", async () => {
    const s = setup(), list = pois(150); list[1].label = list[0].label; list[1].takesPlaceAt = list[0].takesPlaceAt;
    const st = s.h.activityStore, update = st.updateActivity.bind(st); st.updateActivity = async (id, row) => { if (row.record_status === "review") throw new Error("bascule échouée"); return update(id, row); };
    await assert.rejects(s.run(catalogue(list, { total: 170 }), { sourceDrift: drift(150) }), /Lot non terminé/);
    assert.ok(s.store.c.pending); await assert.rejects(s.finalize(), /non complet/);
    st.updateActivity = update; await s.run(catalogue(list, { total: 170 }), { sourceDrift: drift(149), resume: true });
    assert.equal((await s.finalize()).completion, "completed_with_source_drift");
  });
  await test("K — POI non observé dans un snapshot en dérive : aucune absence, aucune désactivation", async () => {
    const s = setup(), old = poi("B", 9999); await s.h.run([old]);
    const mine = () => { const ps = s.h.activityStore.provenances.filter(p => p.source_record_id.includes(old.uuid)); return JSON.stringify([ps, s.h.activityStore.activities.filter(a => ps.some(p => p.activity_id === a.id)), s.h.stateStore.rows.get(old.uuid)]); };
    const before = mine();
    await s.run(catalogue(pois(150), { total: 170 }), { sourceDrift: drift(150) }); const f = await s.finalize();
    assert.equal(f.unobserved_states_not_counted, 1); assert.equal(f.deactivated, 0);
    assert.equal(mine(), before); assert.equal(s.h.stateStore.rows.get(old.uuid).absence_count || 0, 0);
  });
  await test("L — premier constat d'absence (scan normal) : compteur seulement, aucune désactivation", async () => {
    const s = setup(), old = poi("B", 9999); await s.h.run([old]);
    await s.run(catalogue(pois(150)), {}); const f = await s.finalize();
    assert.equal(f.first_absences, 1); assert.equal(f.deactivated, 0); assert.equal(f.staled, 0);
    assert.ok(s.h.activityStore.provenances.filter(p => p.source_record_id.includes(old.uuid)).every(p => p.active));
  });
  await test("M — rejeu idempotent : crash après observation terminale, reprise (contrôle remesuré), finalisation répétée", async () => {
    let crash = true; const s0 = setup(), list = pois(250), fetch = catalogue(list, { total: 284 });
    const processPage = N.receivedPoiProcessor({ stateStore: s0.h.stateStore, activityStore: s0.h.activityStore, persistOccurrences: (states, context) => { if (crash) { crash = false; throw new Error("crash"); } return R.createDatatourismePoiPersister({ store: s0.h.activityStore, now: context.now })(states); } });
    const run = extra => N.runNationalScanBatched({ store: s0.store, sourceId: SOURCE, scanId: s0.id, now: NOW, fetchPage: fetch, processPage, checkpointSize: 500, ...extra });
    await assert.rejects(run({ sourceDrift: drift(240) }), /crash/); assert.ok(s0.store.c.pending.source_drift);
    const r = await run({ sourceDrift: drift(230), resume: true }); assert.equal(r.status, "complete"); assert.equal(s0.store.c.source_drift.control_total, 240, "preuve d'origine conservée");
    const counts = [s0.h.activityStore.activities.length, s0.h.activityStore.provenances.length]; const f1 = await s0.finalize(), f2 = await s0.finalize();
    assert.deepEqual(f1, f2); assert.deepEqual(counts, [250, 250]);
    const again = await run({ sourceDrift: drift(240), resume: true }).catch(e => e); assert.ok(again instanceof Error || again.status === "complete");
  });
  await test("N — dernier lot partiel de 656 POI traité normalement (sélection, persistance, couverture, empreintes)", async () => {
    const s = setup(), list = pois(656); const r = await s.run(catalogue(list, { total: 940 }), { sourceDrift: drift(600) });
    assert.equal(r.received, 656); assert.equal(r.sourceDrift.terminalPage, 7); assert.equal(r.sourceDrift.terminalCount, 56);
    assert.ok(covered(s.h, list)); assert.equal(s.h.activityStore.activities.length, 656); assert.equal((await s.finalize()).completion, "completed_with_source_drift");
  });
  await test("O — meta.total qui baisse ou monte en cours de scan → arrêt sans corruption du checkpoint", async () => {
    for (const delta of [-5, +5]) {
      const s = setup(), list = pois(250); const before = structuredClone(s.store.c);
      await assert.rejects(s.run(catalogue(list, { total: 284, mutate: pages => { pages[1].meta.total += delta; } }), { sourceDrift: drift(240) }), /Total national instable/);
      assert.equal(s.store.c.received, 0); assert.equal(s.store.c.pending, null); assert.equal(s.store.c.total, null); assert.equal(before, null);
    }
  });
  await test("migration SQL : transaction unique, invoker, droits service, chemins normal et dérive", () => {
    const sql = fs.readFileSync(path.join(__dirname, "../migrations/2026-10-27-sortir-datatourisme-terminal-source-drift.sql"), "utf8");
    const top = sql.replace(/--[^\n]*/g, "").split("$$").filter((_, i) => i % 2 === 0).join("BODY");
    assert.equal((top.match(/\bbegin\s*;/gi) || []).length, 1); assert.equal((top.match(/\bcommit\s*;/gi) || []).length, 1);
    assert.equal((sql.match(/security invoker/gi) || []).length, 3); assert.equal((sql.match(/set search_path = public/gi) || []).length, 3); assert.doesNotMatch(sql, /security definer|alter table|create table|drop /i);
    assert.match(sql, /sortir_dt_observe_terminal_drift_batch\([^)]*\) from public,anon,authenticated/); assert.match(sql, /to service_role/);
    for (const re of [/p_control_total > received \+ n/, /p_terminal_page is distinct from pages \+ p_pages/, /received <> pages \* 100/, /received \+ n >= p_total/, /'completed_with_source_drift'/, /'first_absences', 0/, /raise exception 'Total incomplet'/])
      assert.match(sql, re);
    // The drift branch never touches absences, provenances or activities.
    const branch = sql.split("'completed_with_source_drift'")[0].split("Snapshot ended before its initial total")[1];
    assert.doesNotMatch(branch, /update public\.(sortir_datatourisme_poi_states|sortir_provenances|sortir_activities)/);
  });
  console.log(`${passed} réussis, ${failed} échoués`); if (failed) process.exitCode = 1;
})();
