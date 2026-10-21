"use strict";
const assert = require("assert/strict");
const { persistSortirIngestion } = require("./supabase-persistence");
const { compareActivities } = require("./activity-deduplication");
const { TemporalCandidateCache, TemporalCandidateIndex } = require("./temporal-candidate-cache");
const H = require("./candidate-memory-harness");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }
async function differential(setup, batches) {
  const a = H.store(), b = H.store(), cache = new TemporalCandidateCache(); await setup(a); await setup(b);
  for (const sources of batches) {
    for (const [store, candidateCache] of [[a, undefined], [b, cache]]) {
      const r = await persistSortirIngestion({ store, candidateCache, sources: structuredClone(sources), now: H.NOW, reconcileDisappearances: false }); assert.equal(r.status, "completed"); assert.equal(r.stats.INVALID, 0);
    }
    assert.deepEqual(H.businessSnapshot(b), H.businessSnapshot(a), "MATCH/REVIEW/DISTINCT, cibles, provenances, external IDs et contenus doivent rester identiques");
  }
  return { a, b, cache };
}
(async () => {
  await test("différentiel : titres identiques/proches, villes, ±5 min, hors ±12h, longs/fallback", async () => {
    const base = H.activity(1, { title: "Festival international des arts et musique", externalIds: [{ system: "shared", value: "id1" }] });
    const at = minutes => new Date(Date.parse(base.startsAt) + minutes * 60000).toISOString();
    const rows = [H.item("first", base), H.item("match", { ...base, startsAt: at(5), endsAt: at(125) }),
      H.item("review", { title: "Festival international des arts et musiques", startsAt: at(20), endsAt: at(140) }),
      H.item("city", { ...base, city: "Lyon", latitude: 45, longitude: 4 }),
      H.item("outside", { ...base, startsAt: at(721), endsAt: at(841) }),
      H.item("long", { startsAt: "2026-10-01T10:00Z", endsAt: "2026-12-31T10:00Z" }),
      H.item("fallback", { startsAt: "2038-10-01T10:00Z", endsAt: "2038-10-01T12:00Z" })];
    const { a } = await differential(async () => {}, [[H.descriptor(rows)]]);
    assert.ok(a.activities.length < rows.length); assert.ok(a.decisions.some(d => d.decision === "REVIEW"));
  });
  await test("différentiel : 501 candidats, premier MATCH par ID, merged exclu", async () => {
    const input = H.activity(1, { title: "Même concert", externalIds: [{ system: "shared", value: "x" }] });
    const { b } = await differential(async s => {
      for (let i = 0; i < 501; i++) await s.seed(input, `seed-${String(i).padStart(5, "0")}`);
      await s.seed(input, "000-merged", { recordStatus: "merged" });
    }, [[H.descriptor([H.item("new", input)])]]);
    assert.equal(b.items.at(-1).activity_id, "seed-00000");
  });
  await test("différentiel inter-sources entre appels et plusieurs sources dans un appel", async () => {
    const input = H.activity(1, { title: "Concert commun" });
    const { b } = await differential(async () => {}, [[H.descriptor([H.item("a", input)], "source-a")], [H.descriptor([H.item("b", input)], "source-b")],
      [H.descriptor([H.item("c", input)], "source-c"), H.descriptor([H.item("d", input)], "source-d")]]);
    assert.equal(b.activities.length, 1); assert.equal(b.provenances.length, 4);
  });
  await test("différentiel : activité connue dans un trou d'enveloppe puis déplacée", async () => {
    const origin = Date.parse("2026-11-01T00:00Z"), at = h => new Date(origin + h * 3600000).toISOString();
    const common = { title: "Identité commune", provenances: [{ originalEventUrl: "https://example.org/identity", fetchedAt: H.NOW.toISOString() }] };
    await differential(async s => {
      await s.seed(H.activity(1, { ...common, startsAt: at(37), endsAt: at(38) }), "a-001", { recordId: "known", key: "known" });
      await s.seed(H.activity(2, { ...common, startsAt: at(60), endsAt: at(61) }), "a-010");
    }, [[H.descriptor([H.item("early", { startsAt: at(0), endsAt: at(1) }), { sourceRecordId: "known", sourceOccurrenceKey: "known", activity: H.activity(1, { ...common, startsAt: at(48), endsAt: at(49) }) }, H.item("late", { ...common, startsAt: at(60), endsAt: at(61) })])]]);
  });
  await test("différentiel périodes DATAtourisme : même début mais fins différentes", async () => {
    const shared = { externalIds: [{ system: "datatourisme-poi", value: "same" }], provenances: [{ originalEventUrl: "https://example.org/same" }] };
    const { b } = await differential(async () => {}, [[H.descriptor([H.item(1, shared), H.item(2, { ...shared, endsAt: "2026-11-01T15:00Z" })])]]);
    assert.equal(b.activities.length, 2);
  });
  await test("écriture intercalée sans cache : invalidation avant réutilisation", async () => {
    const s = H.store(), cache = new TemporalCandidateCache(); s.candidateCacheNamespace = {};
    const options = { store: s, now: H.NOW, reconcileDisappearances: false };
    await persistSortirIngestion({ ...options, candidateCache: cache, sources: [H.descriptor([H.item(1)])] });
    await persistSortirIngestion({ ...options, store: new Proxy(s, { get: (target, key) => typeof target[key] === "function" ? target[key].bind(target) : target[key] }), sources: [H.descriptor([H.item(2, { city: "Lyon" })], "source-b")] });
    await persistSortirIngestion({ ...options, candidateCache: cache, sources: [H.descriptor([H.item(3, { city: "Lyon", provenances: [{ originalEventUrl: "https://example.org/event/2" }] })])] });
    assert.equal(s.activities.length, 2);
  });
  await test("index : toute paire MATCH/REVIEW reste candidate (2400 comparaisons)", async () => {
    const { activityToRow } = require("./supabase-persistence");
    for (let n = 0; n < 40; n++) {
      const input = H.activity(n, { title: n % 2 ? "Arts musique festival" : "Spectacle théâtre", city: ["Paris", "Lyon", ""][n % 3] });
      const index = new TemporalCandidateIndex();
      const rows = [];
      for (let k = 0; k < 60; k++) {
        const candidate = H.activity(k, { title: ["Arts et musique", "Spectacle théâtre", "Autre"][k % 3], city: ["Lyon", "Paris", ""][k % 3], startsAt: new Date(Date.parse(input.startsAt) + (k % 5 - 2) * 4 * 3600000).toISOString(), externalIds: k % 7 ? [] : input.externalIds, provenances: [{ originalEventUrl: k % 11 ? `https://example.org/other/${k}` : input.provenances[0].originalEventUrl }] });
        const row = activityToRow(candidate, "active"); index.set(String(k), { ...row, id: String(k), provenances: [{ original_event_url: candidate.provenances[0].originalEventUrl }], external_ids: candidate.externalIds }); rows.push(candidate);
      }
      const present = new Set(index.matches(input).map(r => r.id));
      rows.forEach((row, k) => { if (compareActivities(row, input).decision !== "DISTINCT") assert.ok(present.has(String(k))); });
    }
  });
  await test("cache borné : dépassement explicite, jamais troncature silencieuse", async () => {
    const cache = new TemporalCandidateCache({ maxRows: 1 }); const s = H.store();
    const result = await persistSortirIngestion({ store: s, candidateCache: cache, now: H.NOW, reconcileDisappearances: false, sources: [H.descriptor([H.item(1), H.item(2, { city: "Lyon" })])] });
    assert.equal(result.status, "partial"); assert.equal(cache.rows.size, 0);
  });
  await test("invalidation après retrait : un candidat stale ne doit plus fusionner", async () => {
    const cache = new TemporalCandidateCache(), s = H.store(), input = H.activity(1);
    await persistSortirIngestion({ store: s, candidateCache: cache, now: H.NOW, reconcileDisappearances: false, sources: [H.descriptor([H.item(1, input)])] });
    s.activities[0].record_status = "stale"; cache.invalidate([s.activities[0].id]);
    await persistSortirIngestion({ store: s, candidateCache: cache, now: H.NOW, reconcileDisappearances: false, sources: [H.descriptor([H.item(2, input)])] });
    assert.equal(s.activities.length, 2);
  });
  await test("transport candidats : fenêtres groupées et arrêt sur budget", async () => {
    const { createClient } = require("@supabase/supabase-js");
    const { createSupabaseSortirStore } = require("./supabase-persistence");
    let calls = 0;
    const client = createClient("https://example.supabase.co", "fake", { auth: { persistSession: false }, global: { fetch: async (url) => {
      calls++; assert.ok(String(url).length < 16000); assert.ok(new URL(url).searchParams.get("or"));
      return new Response(JSON.stringify([{ id: "a" }, { id: "b" }]), { status: 200, headers: { "Content-Type": "application/json" } });
    } } });
    const windows = [{ start: Date.parse("2026-10-21"), end: Date.parse("2026-10-22") }];
    await assert.rejects(createSupabaseSortirStore(client).listCandidateActivitiesInWindows(windows, { maxRows: 1 }), /Budget/);
    assert.equal(calls, 1);
  });
  console.log(`\n${passed} réussis, ${failed} échoués`); if (failed) process.exitCode = 1;
})();
