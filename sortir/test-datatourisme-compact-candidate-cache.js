"use strict";
// A/B differential: reference TemporalCandidateCache vs CompactCandidateCache, same pipeline
// (write-behind persister), same inputs, full canonical state. Plus hydration, eviction, purge,
// local source resolution, no post-call re-read and the compact Supabase read.
const assert = require("assert/strict");
const { createClient } = require("@supabase/supabase-js");
const { harness, poi, NOW, SOURCE } = require("./test-datatourisme-poi-reconciliation");
const R = require("./datatourisme-poi-reconciliation"), P = require("./datatourisme-poi-state"), Safety = require("./datatourisme-activity-safety"), Q = require("./datatourisme-review-quarantine");
const { persistSortirIngestion, stableJson, createSupabaseSortirStore } = require("./supabase-persistence");
const { TemporalCandidateCache } = require("./temporal-candidate-cache"), { CompactCandidateCache, DROPPED_COLUMNS } = require("./compact-candidate-cache");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }
const fixture = n => require(`./fixtures/${n}`), sample = fixture("datatourisme-national-sample-archived.json"), SAMPLE_NOW = new Date(sample.now);
const slot = (day, s, e2) => ({ startDate: day, startTime: s, endDate: day, endTime: e2 });

function env(mode, cacheOptions = {}) {
  const h = harness(), inner = h.activityStore, runOrd = new Map(), reads = { getActivitiesBatch: 0, candidates: 0 };
  for (const name of ["createIngestionRun", "createSourceRun"]) { const f = inner[name].bind(inner); inner[name] = async row => { const r = await f(row); runOrd.set(r.id, `${name}#${runOrd.size}`); return r; }; }
  const gab = inner.getActivitiesBatch.bind(inner); inner.getActivitiesBatch = async ids => { reads.getActivitiesBatch++; return gab(ids); };
  const range = inner.listCandidateActivitiesInRange.bind(inner); inner.listCandidateActivitiesInRange = async (a, b) => { reads.candidates++; return range(a, b); };
  const cache = mode === "A" ? new TemporalCandidateCache() : new CompactCandidateCache(cacheOptions);
  return { mode, h, inner, cache, runOrd, reads, results: [] };
}
async function step(e, pois, now, { sourceId = SOURCE } = {}) {
  const persist = R.createDatatourismePoiPersister({ store: e.inner, now, beforeCreateActivity: Safety.guardExactSignatureReview, candidateCache: e.cache });
  const r = await R.processReceivedPoiBatch({ pois, stateStore: e.h.stateStore, activityStore: e.inner, sourceId, scanId: "88888888-2222-3333-4444-555555555555", now, catalogObserved: true, persistOccurrences: persist });
  // No silent partial: an equivalence between two failing runs would prove nothing.
  assert.equal(r.committed.length, r.toPersist.length, `étape non validée (${e.mode}) : ${r.committed.length}/${r.toPersist.length}`);
  e.results.push({ classified: r.classified.map(s => [s.uuid, s.classification, s.fingerprint]), committed: [...r.committed].sort(), errors: r.errors.map(x => [x.uuid, x.codes]), reconciliation: r.reconciliation });
  return r;
}
function fingerprint(e, seeds = new Set()) {
  const s = e.inner, provKey = p => `${p.source_id}|${p.source_record_id ?? ""}|${p.source_occurrence_key}`, akey = new Map();
  for (const a of s.activities) akey.set(a.id, seeds.has(a.id) ? "seed:" + a.id : "prov:" + s.provenances.filter(p => p.activity_id === a.id).map(provKey).sort().join("+"));
  const K = id => akey.get(id) || "missing:" + id, run = id => e.runOrd.get(id) || id, swap = v => JSON.parse(JSON.stringify(v), (k, x) => typeof x === "string" && akey.has(x) ? K(x) : x);
  const hyd = a => ({ ...a, provenances: s.provenances.filter(p => p.activity_id === a.id), external_ids: s.externalIds.filter(x => x.activity_id === a.id) });
  return {
    activities: s.activities.map(({ id, last_seen_at, updated_at, merged_into_id, ...rest }) => stableJson([K(id), { ...rest, merged_into: merged_into_id ? K(merged_into_id) : null }])).sort(),
    provenances: s.provenances.map(({ id, activity_id, last_seen_run_id, ...rest }) => stableJson([provKey(rest), { ...rest, activity: K(activity_id), run: run(last_seen_run_id) }])).sort(),
    externalIds: s.externalIds.map(x => `${K(x.activity_id)}|${x.source_id}|${x.system}|${x.value}`).sort(),
    decisions: s.decisions.map(d => stableJson({ pair: [K(d.left_activity_id), K(d.right_activity_id)].sort(), decision: d.decision, review_status: d.review_status, run: run(d.ingestion_run_id), signals: swap(d.signals) })).sort(),
    items: s.items.map(i => stableJson({ run: run(i.source_run_id), activity: i.activity_id ? K(i.activity_id) : null, validation_status: i.validation_status, diagnostics: i.diagnostics })).sort(),
    states: [...e.h.stateStore.rows.values()].map(r => stableJson(r)).sort(),
    quarantines: s.activities.map(a => [K(a.id), Q.evaluateQuarantine(hyd(a), s.decisions)]).filter(([, q]) => q.quarantined).map(([k, q]) => `${k}:${q.complete}`).sort(),
    published: s.activities.filter(a => a.record_status === "active").map(a => K(a.id)).sort(),
    results: e.results
  };
}
function diff(a, b, at = "") {
  if (stableJson(a) === stableJson(b)) return [];
  if (a && b && typeof a === "object") { const out = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { out.push(...diff(a[k], b[k], `${at}.${k}`)); if (out.length > 5) break; } return out; }
  return [`${at}: ${JSON.stringify(a)?.slice(0, 140)} ≠ ${JSON.stringify(b)?.slice(0, 140)}`];
}
const shifted = (p, n, days) => { const q = structuredClone(p); q.uuid = "dddddddd-0000-4000-8000-" + String(n).padStart(12, "0");
  for (const t of q.takesPlaceAt || []) for (const k of ["startDate", "endDate"]) if (t[k]) t[k] = new Date(Date.parse(t[k]) + days * 864e5).toISOString().slice(0, 10); return q; };
const SCENARIOS = {
  "échantillon réel NEW puis seconde tranche (candidats de la tranche précédente)": async e => { await step(e, sample.pois.slice(0, 150), SAMPLE_NOW); await step(e, sample.pois.slice(150), SAMPLE_NOW); },
  "cas réels archivés, multisource et rejeu": async e => {
    const s = fixture("datatourisme-silver-friday-archived.json"); await step(e, s.pois, new Date(s.now)); e.h.stateStore.rows.delete(s.pois[1].uuid); await step(e, s.pois, new Date(s.now));
    await step(e, fixture("datatourisme-inter-poi-archived.json"), new Date("2026-10-22T17:53:41.312Z"));
    await step(e, fixture("datatourisme-geographic-identity-archived.json"), new Date("2026-10-25T04:25:51.603Z"));
    await step(e, fixture("datatourisme-programme-visits-archived.json"), new Date("2026-10-25T09:56:37.240Z"));
    await step(e, Object.values(fixture("datatourisme-temporal.json")), new Date("2026-10-21T08:00:00Z"));
    const p = poi("B", 701); p.takesPlaceAt = [slot("2026-11-01", "09:30", "10:30")]; const item = P.calculatePoiState(p, { now: NOW }).results[0]; await step(e, [p], NOW);
    const other = { ...item.activity, externalIds: [{ system: "other", value: "session" }], provenances: [{ ...item.activity.provenances[0], sourceName: "Other" }] };
    await persistSortirIngestion({ store: e.inner, now: NOW, reconcileDisappearances: false, candidateCache: e.cache, sources: [{ key: "other-source", connectorType: "other", results: [{ activity: other, sourceRecordId: "other", sourceOccurrenceKey: "other-session" }] }] });
    const q = poi("B", 702); q.label = p.label; q.takesPlaceAt = p.takesPlaceAt; await step(e, [q], NOW);
  },
  "frontières ±12 h, tranche précédente et même lot": async e => {
    const base = poi("B", 801); base.label = { "@fr": "Concert de jazz au kiosque" }; base.takesPlaceAt = [slot("2026-11-10", "20:00", "22:00")]; await step(e, [base], NOW);
    const dup = structuredClone(base); dup.uuid = "11111111-2222-3333-4444-000000000802"; await step(e, [dup], NOW);
    const edge = structuredClone(base); edge.uuid = "11111111-2222-3333-4444-000000000803"; edge.takesPlaceAt = [slot("2026-11-11", "08:00", "10:00")];
    const out = structuredClone(base); out.uuid = "11111111-2222-3333-4444-000000000804"; out.takesPlaceAt = [slot("2026-11-11", "08:01", "10:00")];
    const s1 = structuredClone(base); s1.uuid = "11111111-2222-3333-4444-000000000805"; s1.takesPlaceAt = [slot("2026-11-12", "18:00", "19:00")];
    const s2 = structuredClone(s1); s2.uuid = "11111111-2222-3333-4444-000000000806"; await step(e, [edge, out, s1, s2], NOW);
  },
  "intra-tranche (fusions et revues dans le même lot)": async e => { const out = []; let n = 0;
    for (const p of sample.pois.slice(150, 210)) { const dup = structuredClone(p); dup.uuid = "eeeeeeee-0000-4000-8000-" + String(++n).padStart(12, "0"); const rev = structuredClone(p); rev.uuid = "eeeeeeee-1111-4000-8000-" + String(++n).padStart(12, "0"); rev.hasDescription = [{ description: { "@fr": "Programme différent annoncé pour cette édition, sans précision." } }]; out.push(p, dup, rev); }
    await step(e, out, SAMPLE_NOW); },
  "cycle de vie (connu, modifié, retrait, réapparition)": async e => { const base = sample.pois.slice(0, 120);
    await step(e, base, SAMPLE_NOW); e.h.stateStore.rows.clear(); await step(e, base, SAMPLE_NOW); const changed = structuredClone(base); for (let i = 0; i < changed.length; i += 10) changed[i].hasDescription = [{ description: { "@fr": "Description modifiée " + i } }];
    for (let i = 5; i < changed.length; i += 30) if ((changed[i].takesPlaceAt || []).length > 1) changed[i].takesPlaceAt = changed[i].takesPlaceAt.slice(1); await step(e, changed, SAMPLE_NOW); await step(e, base, SAMPLE_NOW); }
};
async function pair(name, cacheOptions = {}) { const A = env("A"), B = env("B", cacheOptions); await SCENARIOS[name](A); await SCENARIOS[name](B); return { A, B, fa: fingerprint(A), fb: fingerprint(B) }; }

(async () => {
  for (const name of Object.keys(SCENARIOS)) await test(`A/B équivalents : ${name}`, async () => { const { fa, fb } = await pair(name); assert.deepEqual(diff(fa, fb), []); });
  await test("Anne de Bretagne : MATCH sur une candidate compacte → réhydratée avant fusion, contenu complet conservé", async () => {
    const out = {};
    for (const mode of ["A", "B"]) { const e = env(mode), f = fixture("datatourisme-editorial-match-archived.json"), c = structuredClone(f.candidate), s = e.inner;
      s.sources = [structuredClone(f.source)]; s.provenances = c.provenances.map(p => { const q = { ...p }; delete q.source; return q; }); s.externalIds = c.external_ids; delete c.provenances; delete c.external_ids; s.activities = [c];
      await step(e, [f.poi], new Date("2026-10-24T05:25:41.028Z"), { sourceId: f.source.id }); out[mode] = { fp: fingerprint(e, new Set([c.id])), e }; }
    assert.deepEqual(diff(out.A.fp, out.B.fp), []); assert.ok(out.B.e.cache.stats.hydratedRows >= 1, "candidate MATCH non réhydratée"); assert.ok(out.B.e.inner.activities[0].description);
  });
  await test("Singulières : paires inter-POI à intervalle identique réhydratées (la description compte)", async () => {
    const [first, second] = fixture("datatourisme-inter-poi-archived.json"), now = new Date("2026-10-22T17:53:41.312Z"), out = {};
    for (const mode of ["A", "B"]) { const e = env(mode); await step(e, [first], now); e.cache.clear(); await step(e, [second], now); out[mode] = e; } // caches vidés des deux côtés : candidates relues
    assert.ok(out.B.cache.stats.hydratedRows >= 30, `${out.B.cache.stats.hydratedRows} réhydratées`); assert.deepEqual(diff(fingerprint(out.A), fingerprint(out.B)), []);
    assert.equal(out.B.inner.activities.length, 30);
  });
  await test("régression P0 : un cache partagé par deux persisters successifs (enveloppes write-behind distinctes)", async () => {
    for (const Cache of [TemporalCandidateCache, CompactCandidateCache]) {
      const h = harness(), cache = new Cache(), [a, b] = fixture("datatourisme-inter-poi-archived.json"), now = new Date("2026-10-22T17:53:41.312Z");
      for (const p of [a, b]) { const r = await h.run([p], now, R.createDatatourismePoiPersister({ store: h.activityStore, now, candidateCache: cache })); assert.equal(r.committed.length, 1, `${Cache.name} : tranche non validée`); }
      assert.equal(h.activityStore.activities.length, 30); assert.equal(h.activityStore.provenances.length, 60);
      const other = harness(); await assert.rejects(cache.load([Date.now()], other.activityStore), /un seul store/);
    }
  });
  await test("pas de relecture après tranche : moins de lectures, même résultat", async () => {
    const { A, B, fa, fb } = await pair("échantillon réel NEW puis seconde tranche (candidats de la tranche précédente)"); assert.deepEqual(diff(fa, fb), []);
    assert.ok(B.reads.getActivitiesBatch < A.reads.getActivitiesBatch, `${B.reads.getActivitiesBatch} ≥ ${A.reads.getActivitiesBatch}`); assert.equal(B.cache.dirty.size, 0);
  });
  await test("éviction forcée (plafond 1 000, ~1 600 lignes réparties) : équivalence conservée", async () => {
    const big = Array.from({ length: 1400 }, (_, i) => shifted(sample.pois[i % 300], i, Math.floor(i / 300) * 9));
    const run = async e => { for (let i = 0; i < big.length; i += 350) await step(e, big.slice(i, i + 350), SAMPLE_NOW); };
    const A = env("A"), B = env("B", { maxRows: 1000 }); await run(A); await run(B);
    assert.ok(B.cache.stats.evictedRows > 0, "aucune éviction"); assert.deepEqual(diff(fingerprint(A), fingerprint(B)), []);
  });
  await test("fenêtres exactes : seule la plage [t-12 h, t+12 h] est demandée, couverture fusionnée et non relue", async () => {
    const c = new CompactCandidateCache(), t = Date.parse("2026-11-10T20:00:00Z"); const calls = [];
    const store = { sources: [], listCandidateActivitiesCompact: async w => { calls.push(w); return []; }, getActivitiesBatch: async () => [] };
    await c.load([t, t + 3600e3], store); await c.load([t + 1800e3], store);
    assert.equal(calls.length, 1); assert.deepEqual(calls[0], [{ start: t - 43200e3, end: t + 3600e3 + 43200e3 + 1 }]);
  });
  await test("source résolue localement et colonnes retirées ; une ligne complète n'est jamais rétrogradée", async () => {
    const c = new CompactCandidateCache(), row = { id: "a1", title: "x", description: "longue", tags: ["t"], field_confidence: {}, starts_at: "2026-11-10T10:00:00Z", record_status: "active", provenances: [{ id: "p", source_id: "s1", original_event_url: null }], external_ids: [] };
    const store = { listSources: async () => [{ id: "s1", key: "datatourisme-national", connector_type: "datatourisme", base_url: "https://x.example" }], listCandidateActivitiesCompact: async () => [row], getActivitiesBatch: async () => [] };
    await c.load([Date.parse(row.starts_at)], store); const cached = c.rows.get("a1").row;
    for (const k of DROPPED_COLUMNS) assert.equal(cached[k], undefined); assert.equal(cached.provenances[0].source.key, "datatourisme-national");
    c.set({ ...row, description: "complète" }, false); c.covered = []; await c.load([Date.parse(row.starts_at)], store); assert.equal(c.rows.get("a1").row.description, "complète");
  });
  await test("purge entre les runs et plafond minimal", async () => {
    const h = harness(), persist = R.createDatatourismePoiPersister({ store: h.activityStore, now: NOW }); await h.run([poi("B", 901)], NOW, persist);
    assert.ok(persist.candidateCache instanceof CompactCandidateCache); persist.purgeCandidateCache(); assert.equal(persist.candidateCache.rows.size, 0); assert.equal(persist.candidateCache.stats.purges, 1);
    assert.throws(() => new CompactCandidateCache({ maxRows: 10 }), /trop bas/);
  });
  await test("Supabase : lecture compacte (colonnes sans description, 1 000 lignes/page, 40 fenêtres/GET), budget refusé", async () => {
    const calls = []; let pages = 0; const client = createClient("https://example.supabase.co", "fake", { auth: { persistSession: false }, global: { fetch: async url => { calls.push(new URL(String(url))); pages++;
      const data = pages === 1 ? Array.from({ length: 1000 }, (_, i) => ({ id: "a" + i })) : [{ id: "z" }]; return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }); } } });
    const store = createSupabaseSortirStore(client), windows = Array.from({ length: 41 }, (_, i) => ({ start: Date.UTC(2026, 10, 1 + i), end: Date.UTC(2026, 10, 1 + i) + 36e5 }));
    const rows = await store.listCandidateActivitiesCompact(windows); assert.equal(rows.length, 1002); assert.equal(calls.length, 3);
    const select = calls[0].searchParams.get("select"); assert.ok(!/description|field_confidence|tags|source:/.test(select)); assert.match(select, /evidence/); assert.equal(calls[0].searchParams.get("limit"), "1000");
    pages = 0; await assert.rejects(store.listCandidateActivitiesCompact(windows.slice(0, 1), { maxRows: 500 }), /Budget/);
  });
  console.log(`${passed} réussis, ${failed} échoués`); if (failed) process.exitCode = 1;
})();
