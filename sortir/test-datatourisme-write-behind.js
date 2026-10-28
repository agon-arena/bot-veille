"use strict";
// Durable A/B differential harness: sequential reference persister (writeBehind: false) vs the
// write-behind persister, on archived real cases and synthetic stress. Full canonical state is
// compared, plus partial failures on every phase, provenance conflict, forced barrier,
// negative controls (harness sensitivity) and the grouped Supabase primitives.
const assert = require("assert/strict");
const { createClient } = require("@supabase/supabase-js");
const { harness, poi, NOW, SOURCE } = require("./test-datatourisme-poi-reconciliation");
const R = require("./datatourisme-poi-reconciliation"), P = require("./datatourisme-poi-state"), Safety = require("./datatourisme-activity-safety"), Q = require("./datatourisme-review-quarantine");
const { persistSortirIngestion, stableJson, createSupabaseSortirStore } = require("./supabase-persistence");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }
const fixture = n => require(`./fixtures/${n}`), sample = fixture("datatourisme-national-sample-archived.json");
const SAMPLE_NOW = new Date(sample.now), PHASES = ["1_activities", "2_decisions", "3_provenances", "4_provenance_patch", "5_external_ids", "6_activity_patch", "7_flip"];

// ---------- environment, request accounting ----------
const ceil = (n, k) => Math.max(1, Math.ceil(n / k));
const COST = { findProvenancesBatch: a => ceil(new Set(a[1]).size, 100), getActivitiesBatch: a => a[0].length ? ceil(new Set(a[0]).size, 100) : 0, loadPoiProvenancesBatch: a => ceil(a[1].length, 500),
  loadReviewDecisionsBatch: a => ceil(a[0].length, 50), insertCollectionItemsBatch: a => a[0].length ? ceil(a[0].length, 500) : 0, touchProvenancesBatch: a => a[0].length ? ceil(a[0].length, 100) : 0,
  upsertExternalIds: a => a[2].length ? 1 : 0, insertDedupDecision: a => a[0].left_activity_id === a[0].right_activity_id ? 0 : 1 };
const WRITE = /^(create|update|insert|upsert|touch|mark|flip|ensure)/;
function env(mode) {
  const h = harness(), inner = h.activityStore, runOrd = new Map(), counts = { requests: 0, writes: 0 };
  for (const name of ["createIngestionRun", "createSourceRun"]) { const f = inner[name].bind(inner); inner[name] = async row => { const r = await f(row); runOrd.set(r.id, `${name}#${runOrd.size}`); return r; }; }
  const store = new Proxy(inner, { get(t, k) { const v = t[k]; if (typeof v !== "function" || ["constructor", "id", "hydrate"].includes(k)) return v;
    return async (...a) => { const n = (COST[k] || (() => 1))(a); counts.requests += n; if (WRITE.test(k)) counts.writes += n; return v.apply(t, a); }; } });
  return { mode, h, inner, store, runOrd, counts, stats: [], results: [], failAt: null };
}
async function step(e, pois, now, { sourceId = SOURCE } = {}) {
  const options = e.failAt ? { failAt: e.failAt } : {}; e.failAt = null;
  const persist = R.createDatatourismePoiPersister({ store: e.store, now, beforeCreateActivity: Safety.guardExactSignatureReview, writeBehind: e.mode === "B", writeBehindOptions: options });
  const r = await R.processReceivedPoiBatch({ pois, stateStore: e.h.stateStore, activityStore: e.store, sourceId, scanId: "88888888-2222-3333-4444-555555555555", now, catalogObserved: true, persistOccurrences: persist });
  if (persist.store.writeBehindStats) e.stats.push(persist.store.writeBehindStats);
  e.results.push({ classified: r.classified.map(s => [s.uuid, s.classification, s.fingerprint, s.editorial]), committed: [...r.committed].sort(), errors: r.errors.map(x => [x.uuid, x.codes]), reconciliation: r.reconciliation });
  return r;
}
// ---------- canonical fingerprint (ids/runs mapped, wall-clock timestamps ignored) ----------
function fingerprint(e, seeds = new Set()) {
  const s = e.inner, provKey = p => `${p.source_id}|${p.source_record_id ?? ""}|${p.source_occurrence_key}`, akey = new Map();
  for (const a of s.activities) { if (seeds.has(a.id)) { akey.set(a.id, "seed:" + a.id); continue; } const ps = s.provenances.filter(p => p.activity_id === a.id).map(provKey).sort(); akey.set(a.id, ps.length ? "prov:" + ps.join("+") : "orphan:" + stableJson([a.title, a.starts_at, a.ends_at, a.record_status])); }
  const K = id => akey.get(id) || "missing:" + id, run = id => e.runOrd.get(id) || id, swap = v => JSON.parse(JSON.stringify(v), (k, x) => typeof x === "string" && akey.has(x) ? K(x) : x);
  const hyd = a => ({ ...a, provenances: s.provenances.filter(p => p.activity_id === a.id), external_ids: s.externalIds.filter(x => x.activity_id === a.id) });
  const pmap = new Map(s.provenances.map(p => [p.id, provKey(p)])), byKey = (x, y) => x[0] < y[0] ? -1 : 1;
  return {
    activities: s.activities.map(({ id, last_seen_at, updated_at, merged_into_id, ...rest }) => [K(id), { ...rest, merged_into: merged_into_id ? K(merged_into_id) : null }]).sort(byKey),
    provenances: s.provenances.map(({ id, activity_id, last_seen_run_id, ...rest }) => [provKey({ ...rest }), { ...rest, activity: K(activity_id), run: run(last_seen_run_id) }]).sort(byKey),
    externalIds: s.externalIds.map(x => `${K(x.activity_id)}|${x.source_id}|${x.system}|${x.value}`).sort(),
    decisions: s.decisions.map(d => stableJson({ pair: [K(d.left_activity_id), K(d.right_activity_id)].sort(), decision: d.decision, review_status: d.review_status, algorithm_version: d.algorithm_version, run: run(d.ingestion_run_id), signals: swap(d.signals) })).sort(),
    items: s.items.map(i => stableJson({ run: run(i.source_run_id), provenance: i.provenance_id ? pmap.get(i.provenance_id) : null, activity: i.activity_id ? K(i.activity_id) : null, validation_status: i.validation_status, diagnostics: i.diagnostics })).sort(),
    states: [...e.h.stateStore.rows.values()].map(r => stableJson(r)).sort(),
    quarantines: s.activities.map(a => [K(a.id), Q.evaluateQuarantine(hyd(a), s.decisions)]).filter(([, q]) => q.quarantined).map(([k, q]) => `${k}:${q.complete}`).sort(),
    published: s.activities.filter(a => a.record_status === "active").map(a => K(a.id)).sort(),
    multisource: s.activities.filter(a => new Set(s.provenances.filter(p => p.activity_id === a.id && p.active).map(p => p.source_record_id?.split(":")[1] || p.source_id)).size > 1).map(a => K(a.id)).sort(),
    safety: Safety.auditActivitySafety(s.activities.map(hyd), { decisions: s.decisions }).issues.map(i => i.code).sort(),
    results: e.results
  };
}
function diff(a, b, at = "") {
  if (stableJson(a) === stableJson(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object") { const out = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { out.push(...diff(a[k], b[k], `${at}.${k}`)); if (out.length > 6) break; } return out; }
  return [`${at}: ${JSON.stringify(a)?.slice(0, 140)} ≠ ${JSON.stringify(b)?.slice(0, 140)}`];
}
// ---------- corpus ----------
const slot = (day, s, e2) => ({ startDate: day, startTime: s, endDate: day, endTime: e2 });
const uuidN = (prefix, n) => prefix + String(n).padStart(12, "0");
function intraChunk(real) {
  const out = []; let n = 0;
  for (const p of real) {
    const dup = structuredClone(p); dup.uuid = uuidN("eeeeeeee-0000-4000-8000-", ++n);
    const rev = structuredClone(p); rev.uuid = uuidN("eeeeeeee-1111-4000-8000-", ++n); rev.hasDescription = [{ description: { "@fr": "Programme différent annoncé pour cette édition, sans précision." } }];
    const shift = structuredClone(p); shift.uuid = uuidN("eeeeeeee-2222-4000-8000-", ++n); for (const t of shift.takesPlaceAt || []) if (t.startTime) { t.startTime = "06:" + t.startTime.slice(3); t.endTime = t.endTime && "23:" + t.endTime.slice(3); }
    out.push(p, dup, rev, shift);
  }
  return out;
}
const SCENARIOS = {
  "échantillon réel (300 POI, NEW)": async e => { await step(e, sample.pois, SAMPLE_NOW); },
  "cas réels archivés (Silver Friday, Singulières, Noël, Lanvénégen, fuseaux/DST)": async e => {
    const s = fixture("datatourisme-silver-friday-archived.json"); await step(e, s.pois, new Date(s.now));
    await step(e, fixture("datatourisme-inter-poi-archived.json"), new Date("2026-10-22T17:53:41.312Z"));
    await step(e, fixture("datatourisme-geographic-identity-archived.json"), new Date("2026-10-25T04:25:51.603Z"));
    await step(e, fixture("datatourisme-programme-visits-archived.json"), new Date("2026-10-25T09:56:37.240Z"));
    await step(e, Object.values(fixture("datatourisme-temporal.json")), new Date("2026-10-21T08:00:00Z"));
  },
  "Anne de Bretagne (MATCH malgré avertissement éditorial)": async e => { const f = fixture("datatourisme-editorial-match-archived.json"); await step(e, [f.poi], new Date("2026-10-24T05:25:41.028Z"), { sourceId: f.source.id }); },
  "séances, mêmes débuts/fins différentes, invalides, DST": async e => {
    const a = poi("B", 501); a.takesPlaceAt = [slot("2026-11-01", "09:30", "10:30"), slot("2026-11-01", "14:30", "15:30"), slot("2026-11-01", "09:30", "12:00"), slot("2026-11-01", "09:30", "10:30")];
    const b = poi("B", 502); b.takesPlaceAt = [slot("2026-11-02", "10:00", "09:00")]; const c = poi("B", 503); c.takesPlaceAt = [];
    const d = poi("B", 504); d.takesPlaceAt = [{ startDate: "2026-11-03", endDate: "2026-11-03" }]; const dst = poi("B", 505); dst.takesPlaceAt = [slot("2027-03-28", "02:30", "03:30"), slot("2026-10-25", "02:30", "03:30")];
    await step(e, [a, b, c, d, dst], NOW);
  },
  "multisource": async e => {
    const p = poi("B", 701); p.takesPlaceAt = [slot("2026-11-01", "09:30", "10:30")]; const item = P.calculatePoiState(p, { now: NOW }).results[0]; await step(e, [p], NOW);
    const other = { ...item.activity, externalIds: [{ system: "other", value: "session" }], provenances: [{ ...item.activity.provenances[0], sourceName: "Other" }] };
    await persistSortirIngestion({ store: e.store, now: NOW, reconcileDisappearances: false, sources: [{ key: "other-source", connectorType: "other", results: [{ activity: other, sourceRecordId: "other", sourceOccurrenceKey: "other-session" }] }] });
    const q = poi("B", 702); q.label = p.label; q.takesPlaceAt = p.takesPlaceAt; await step(e, [q], NOW);
  },
  "cycle de vie (inchangé, connu, modifié, retrait, réapparition)": async e => {
    const base = sample.pois.slice(0, 150); await step(e, base, SAMPLE_NOW); await step(e, base, SAMPLE_NOW); e.h.stateStore.rows.clear(); await step(e, base, SAMPLE_NOW);
    const changed = structuredClone(base); for (let i = 0; i < changed.length; i += 10) changed[i].hasDescription = [{ description: { "@fr": "Description modifiée " + i } }];
    for (let i = 5; i < changed.length; i += 30) if ((changed[i].takesPlaceAt || []).length > 1) changed[i].takesPlaceAt = changed[i].takesPlaceAt.slice(1);
    await step(e, changed, SAMPLE_NOW); await step(e, base, SAMPLE_NOW);
  },
  "intra-tranche synthétique (fusions/revues dans la même tranche)": async e => { await step(e, intraChunk(sample.pois.slice(150, 225)), SAMPLE_NOW); },
  "rejeu Silver Friday (quarantaines)": async e => { const s = fixture("datatourisme-silver-friday-archived.json"); await step(e, s.pois, new Date(s.now)); e.h.stateStore.rows.clear(); await step(e, s.pois, new Date(s.now)); }
};
function prepare(name, e) {
  if (name.startsWith("Anne")) { const f = fixture("datatourisme-editorial-match-archived.json"), c = structuredClone(f.candidate), s = e.inner;
    s.sources = [structuredClone(f.source)]; s.provenances = c.provenances.map(p => { const q = { ...p }; delete q.source; return q; }); s.externalIds = c.external_ids; delete c.provenances; delete c.external_ids; s.activities = [c]; return new Set([c.id]); }
  if (name === "multisource") { const ensure = e.inner.ensureSource.bind(e.inner); e.inner.ensureSource = async row => row.key === "other-source" ? { id: "99999999-0000-0000-0000-000000000099", key: row.key, connector_type: "api" } : ensure(row); }
  return new Set();
}
async function pair(name) { const A = env("A"), B = env("B"), sa = prepare(name, A), sb = prepare(name, B); await SCENARIOS[name](A); await SCENARIOS[name](B); return { A, B, fa: fingerprint(A, sa), fb: fingerprint(B, sb) }; }
// Business projection for failure/replay convergence (abandoned staging excluded).
function projection(e) {
  const s = e.inner, provKey = p => `${p.source_id}|${p.source_record_id ?? ""}|${p.source_occurrence_key}`, live = s.activities.filter(a => s.provenances.some(p => p.activity_id === a.id));
  const key = new Map(live.map(a => [a.id, s.provenances.filter(p => p.activity_id === a.id).map(provKey).sort().join("+")])), K = id => key.get(id);
  return { activities: live.map(a => [K(a.id), a.record_status, a.title, a.starts_at, a.ends_at, a.timezone, a.description]).sort(), provenances: s.provenances.map(p => [provKey(p), K(p.activity_id) || "abandoned", p.active, p.payload_hash]).sort(),
    externalIds: s.externalIds.filter(x => key.has(x.activity_id)).map(x => [K(x.activity_id), x.system, x.value]).sort(),
    decisions: s.decisions.filter(d => key.has(d.left_activity_id) && key.has(d.right_activity_id)).map(d => [[K(d.left_activity_id), K(d.right_activity_id)].sort(), d.decision, d.review_status]).sort(),
    states: [...e.h.stateStore.rows.values()].map(r => [r.poi_uuid, r.fingerprint]).sort() };
}
function invariants(e) {
  const s = e.inner, hyd = a => ({ ...a, provenances: s.provenances.filter(p => p.activity_id === a.id), external_ids: s.externalIds.filter(x => x.activity_id === a.id) });
  const live = s.activities.filter(a => ["active", "review"].includes(a.record_status));
  return { unsupported: live.filter(a => !s.provenances.some(p => p.activity_id === a.id && p.active)).length,
    incompleteLiveQuarantines: live.map(a => Q.evaluateQuarantine(hyd(a), s.decisions)).filter(q => q.quarantined && !q.complete).length,
    safetyReady: Safety.auditActivitySafety(s.activities.map(hyd), { decisions: s.decisions }).ready };
}

(async () => {
  for (const name of Object.keys(SCENARIOS)) await test(`A/B équivalents : ${name}`, async () => {
    const { A, B, fa, fb } = await pair(name), d = diff(fa, fb); assert.deepEqual(d, [], d.join("\n"));
    assert.ok(B.counts.requests <= A.counts.requests, `requêtes B ${B.counts.requests} > A ${A.counts.requests}`);
    assert.ok(B.stats.every(s => s.poisoned === 0 && s.conflicts === 0));
  });
  await test("gain : échantillon réel NEW, requêtes et écritures fortement réduites", async () => {
    const { A, B } = await pair("échantillon réel (300 POI, NEW)");
    assert.ok(A.counts.requests / B.counts.requests > 8, `${A.counts.requests} → ${B.counts.requests}`); assert.ok(A.counts.writes / B.counts.writes > 20, `${A.counts.writes} → ${B.counts.writes}`);
    assert.ok(B.stats.every(s => s.maxRows <= 100));
  });
  await test("barrière intra-tranche : forcée par une fusion vers un staging de la file, équivalence conservée", async () => {
    const { B, fa, fb } = await pair("intra-tranche synthétique (fusions/revues dans la même tranche)");
    assert.ok(B.stats.reduce((n, s) => n + s.barriers, 0) > 0, "barrière jamais déclenchée"); assert.deepEqual(diff(fa, fb), []);
  });
  for (const scenario of ["échantillon réel (300 POI, NEW)", "cycle de vie (inchangé, connu, modifié, retrait, réapparition)", "intra-tranche synthétique (fusions/revues dans la même tranche)"]) {
    const clean = env("A"); prepare(scenario, clean); await SCENARIOS[scenario](clean); const reference = projection(clean);
    for (const phase of PHASES) await test(`panne phase ${phase} — ${scenario.split(" (")[0]} : rien de publié à tort, rejeu convergent`, async () => {
      const B = env("B"); prepare(scenario, B); B.failAt = phase; await SCENARIOS[scenario](B);
      const fired = B.stats.some(s => s.poisoned > 0), inv = invariants(B), refPublished = new Set(reference.activities.filter(a => a[1] === "active").map(a => a[0]));
      assert.equal(inv.unsupported, 0); assert.equal(inv.incompleteLiveQuarantines, 0); assert.equal(inv.safetyReady, true);
      assert.deepEqual(projection(B).activities.filter(a => a[1] === "active" && !refPublished.has(a[0])), [], "publication à tort");
      if (fired) assert.ok([...B.h.stateStore.rows.values()].length < reference.states.length || reference.states.length === 0 || scenario.startsWith("cycle"), "empreintes validées malgré la panne");
      B.h.stateStore.rows = new Map([...B.h.stateStore.rows].filter(([, r]) => r.fingerprint)); B.results = [];
      await SCENARIOS[scenario](B); assert.deepEqual(diff(reference, projection(B)), []);
    });
  }
  await test("conflit de provenance concurrente : échec fermé de la tranche, aucune empreinte, rien de publiable", async () => {
    const B = env("B"), inner = B.inner, create = inner.createProvenanceIdempotent.bind(inner); let injected = false;
    inner.createProvenanceIdempotent = async row => { if (!injected) { injected = true; inner.activities.push({ id: "concurrent-activity", title: "x", starts_at: row.first_seen_at, record_status: "stale" }); inner.provenances.push({ ...row, id: "concurrent", activity_id: "concurrent-activity" }); } return create(row); };
    const r = await step(B, sample.pois.slice(0, 200), SAMPLE_NOW);
    assert.equal(B.stats[0].conflicts, 1); assert.equal(r.committed.length, 100); assert.equal(invariants(B).unsupported, 0);
    const failedPois = sample.pois.slice(0, 100).map(p => p.uuid); assert.ok(failedPois.every(u => !B.h.stateStore.rows.get(u)?.fingerprint));
  });
  await test("contrôles négatifs : le comparateur détecte toute altération", async () => {
    const { B, fa } = await pair("rejeu Silver Friday (quarantaines)"), s = B.inner, seeds = new Set();
    const mutations = [() => s.decisions.pop(), () => { s.activities.find(a => a.record_status === "review").record_status = "active"; }, () => s.externalIds.pop(), () => { s.activities[0].description += " "; }, () => { s.provenances[0].active = false; }];
    for (const mutate of mutations) { const snapshot = structuredClone([s.decisions, s.activities, s.externalIds, s.provenances]); mutate(); assert.notDeepEqual(diff(fa, fingerprint(B, seeds)), []); [s.decisions, s.activities, s.externalIds, s.provenances] = snapshot; }
    assert.deepEqual(diff(fa, fingerprint(B, seeds)), []);
  });
  await test("chemin séquentiel de référence disponible et distinct (writeBehind: false)", async () => {
    const h = harness(), persist = R.createDatatourismePoiPersister({ store: h.activityStore, now: NOW, writeBehind: false }); assert.equal(persist.store, h.activityStore);
    assert.ok(R.createDatatourismePoiPersister({ store: h.activityStore, now: NOW }).store.writeBehindStats);
  });
  // ---------- grouped Supabase primitives (fake HTTP client) ----------
  function fake(handler) { const calls = []; const client = createClient("https://example.supabase.co", "fake", { auth: { persistSession: false }, global: { fetch: async (url, init = {}) => {
    const u = new URL(String(url)), call = { method: init.method || "GET", table: u.pathname.split("/").at(-1), url: String(url), body: init.body ? JSON.parse(init.body) : null }; calls.push(call);
    const { status = 200, data = [] } = handler(call) || {}; return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }); } } }); return { store: createSupabaseSortirStore(client), calls }; }
  const uuid = n => `11111111-2222-3333-4444-${String(n).padStart(12, "0")}`;
  await test("Supabase : insertion groupée d'activités et de provenances, un POST par lot, compte vérifié", async () => {
    const f = fake(c => ({ data: c.body.map(r => ({ id: r.id, activity_id: r.activity_id })) }));
    await f.store.createActivitiesBatch([{ id: uuid(1) }, { id: uuid(2) }]); const saved = await f.store.createProvenancesBatch([{ id: uuid(3), activity_id: uuid(1) }]);
    assert.deepEqual(f.calls.map(c => [c.method, c.table, c.body.length]), [["POST", "sortir_activities", 2], ["POST", "sortir_provenances", 1]]); assert.equal(saved[0].activity_id, uuid(1));
    const short = fake(() => ({ data: [] })); await assert.rejects(short.store.createActivitiesBatch([{ id: uuid(1) }]), /incomplète/);
  });
  await test("Supabase : décisions groupées, doublon (23505) ignoré ligne à ligne comme aujourd'hui, autre erreur propagée", async () => {
    let n = 0; const f = fake(c => (++n === 1 ? { status: 409, data: { code: "23505", message: "duplicate" } } : n === 2 ? { status: 409, data: { code: "23505", message: "duplicate" } } : { status: 201, data: c.body }));
    await f.store.insertDedupDecisionsBatch([{ left_activity_id: uuid(2), right_activity_id: uuid(1), decision: "REVIEW" }, { left_activity_id: uuid(3), right_activity_id: uuid(4), decision: "REVIEW" }]);
    assert.equal(f.calls.length, 3); assert.equal(f.calls[0].body[0].left_activity_id, uuid(1), "paire ordonnée");
    const bad = fake(() => ({ status: 400, data: { code: "23503", message: "fk" } })); await assert.rejects(bad.store.insertDedupDecisionsBatch([{ left_activity_id: uuid(1), right_activity_id: uuid(2) }]), /fk/);
  });
  await test("Supabase : provenance déjà présente (23505) → ligne stockée renvoyée, jamais un succès silencieux", async () => {
    const f = fake(c => c.method === "POST" ? { status: 409, data: { code: "23505", message: "duplicate" } } : { data: [{ id: "existing", activity_id: "other" }] });
    const saved = await f.store.createProvenancesBatch([{ id: uuid(9), activity_id: uuid(1), source_id: uuid(5), source_record_id: "r", source_occurrence_key: "k" }]);
    assert.equal(saved[0].id, "existing"); assert.equal(saved[0].activity_id, "other");
  });
  await test("Supabase : bascule groupée bornée à 100 UUID par URL, compte vérifié ; IDs externes en upsert idempotent", async () => {
    const f = fake(c => c.method === "PATCH" ? { data: new URL(c.url).searchParams.get("id").slice(4, -1).split(",").map(id => ({ id })) } : { data: [] });
    await f.store.flipActivitiesBatch(Array.from({ length: 250 }, (_, i) => uuid(i)), { record_status: "active" });
    assert.deepEqual(f.calls.map(c => new URL(c.url).searchParams.get("id").slice(4, -1).split(",").length), [100, 100, 50]);
    const short = fake(() => ({ data: [] })); await assert.rejects(short.store.flipActivitiesBatch([uuid(1)], { record_status: "review" }), /incomplète/);
    const e = fake(() => ({ status: 201, data: [] })); await e.store.upsertExternalIdsBatch([{ activity_id: uuid(1), source_id: uuid(2), system: "s", value: "v" }]);
    assert.match(e.calls[0].url, /on_conflict=activity_id%2Csource_id%2Csystem%2Cvalue/);
  });
  console.log(`${passed} réussis, ${failed} échoués`); if (failed) process.exitCode = 1;
})();
