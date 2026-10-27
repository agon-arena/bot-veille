"use strict";
const assert = require("assert/strict");
const { harness, poi, NOW, SOURCE, id } = require("./test-datatourisme-poi-reconciliation");
const P = require("./datatourisme-poi-state"), S = require("./supabase-persistence"), R = require("./datatourisme-poi-repair");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };
const slot = (start, end) => ({ startDate: "2026-11-01", endDate: "2026-11-01", startTime: start, endTime: end });
const sessions = () => ({ ...poi("A"), takesPlaceAt: [slot("09:30", "10:30"), slot("14:30", "15:30")] });
function memoryRelocation(store) {
  store.relocateDatatourismeOccurrenceExternalIds = async ({ sourceId, fromActivityId, toActivityId, values }) => {
    if (store.failRelocateOnce) { store.failRelocateOnce = false; throw new Error("panne déplacement identifiants"); }
    const rows = store.externalIds.filter(e => e.activity_id === fromActivityId && e.source_id === sourceId && e.system === "datatourisme-occurrence" && values.includes(e.value));
    for (const row of rows) {
      assert.ok(!store.externalIds.some(e => e !== row && e.activity_id === toActivityId && e.source_id === row.source_id && e.system === row.system && e.value === row.value));
      row.activity_id = toActivityId;
    }
    return rows;
  };
}
async function corrupted({ legacy = false, inactive = false, onlyMorning = false } = {}) {
  const h = harness(), input = sessions(), afternoon = { ...input, takesPlaceAt: [input.takesPlaceAt[1]] };
  await h.run([afternoon]); const store = h.activityStore; memoryRelocation(store);
  const expected = P.calculatePoiState(input, { now: NOW }), morning = expected.results[0], old = store.activities[0];
  const prov = { id: "bad-morning", activity_id: old.id, source_id: SOURCE, source_record_id: morning.sourceRecordId,
    source_occurrence_key: legacy ? morning.legacySourceOccurrenceKey : morning.sourceOccurrenceKey, source_payload: morning.sourcePayload,
    payload_hash: S.payloadHash(S.canonicalActivityPayload(morning.activity)), active: !inactive };
  store.provenances.push(prov); await store.upsertExternalIds(old.id, SOURCE, morning.activity.externalIds);
  if (onlyMorning) input.takesPlaceAt = [input.takesPlaceAt[0]];
  const state = P.calculatePoiState(input, { now: NOW });
  h.stateStore.rows.set(input.uuid, { ...h.stateStore.rows.get(input.uuid), fingerprint: state.fingerprint, algorithm_version: state.algorithm_version, needs_reprocess: true });
  const plan = [{ uuid: input.uuid, fingerprint: state.fingerprint, activityIds: [old.id], provenances: store.provenances.map(p => ({ ...p })) }];
  const persist = R.createDatatourismePoiRepairPersister({ store, activityStore: store, sourceId: SOURCE, plan, now: NOW });
  return { ...h, input, store, prov, old, plan, persist, async repair() { return h.run([input], NOW, persist); } };
}
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }
(async () => {
  await test("repair mode : deux séances fusionnées, provenance et identifiants déplacés sans doublon", async () => {
    const h = await corrupted(), originalId = h.prov.id, oldKey = h.prov.source_occurrence_key;
    const r = await h.repair(); assert.equal(r.committed.length, 1); assert.equal(h.store.activities.length, 2);
    assert.equal(h.store.provenances.length, 2); assert.equal(h.prov.id, originalId); assert.equal(h.prov.source_occurrence_key, oldKey);
    assert.notEqual(h.prov.activity_id, h.old.id); assert.equal(h.prov.active, true);
    const item = P.calculatePoiState(h.input, { now: NOW }).results[0];
    assert.equal(h.store.externalIds.find(e => e.value === item.sourceOccurrenceKey).activity_id, h.prov.activity_id);
    assert.equal(h.stateStore.rows.get(h.input.uuid).needs_reprocess, false);
    const snapshot = JSON.stringify([h.store.activities, h.store.provenances, h.store.externalIds, h.store.items]);
    const replay = await h.run([h.input]); assert.equal(replay.unchanged.length, 1);
    assert.equal(JSON.stringify([h.store.activities, h.store.provenances, h.store.externalIds, h.store.items]), snapshot);
  });
  await test("mode normal reste strict devant la même corruption", async () => {
    const h = await corrupted(), before = JSON.stringify([h.store.activities, h.store.provenances]);
    const result = await h.run([h.input]); assert.equal(result.committed.length, 0);
    assert.equal(JSON.stringify([h.store.activities, h.store.provenances]), before); assert.equal(h.stateStore.rows.get(h.input.uuid).needs_reprocess, true);
  });
  await test("matin legacy inactif sans remplacement : réactivation et rattachement sans nouvelle provenance", async () => {
    const h = await corrupted({ legacy: true, inactive: true }); await h.repair();
    assert.equal(h.prov.active, true); assert.notEqual(h.prov.activity_id, h.old.id); assert.equal(h.store.provenances.length, 2);
    h.stateStore.rows.get(h.input.uuid).needs_reprocess = true; await h.repair();
    assert.equal(h.store.activities.length, 2); assert.equal(h.store.provenances.length, 2);
  });
  await test("soutien multisource préservé lorsque l'ancienne occurrence est retirée", async () => {
    const h = await corrupted({ onlyMorning: true }); h.old.record_status = "review";
    const support = { id: "other", source_id: id(99), activity_id: h.old.id, active: true }; h.store.provenances.push(support);
    const before = { ...support }; await h.repair(); assert.deepEqual(support, before); assert.equal(h.old.record_status, "review");
    assert.equal(h.store.provenances.find(p => p.id !== "other" && p.id !== h.prov.id).active, false);
  });
  await test("ancienne activité sans aucun soutien devient stale sans DELETE", async () => {
    const h = await corrupted({ onlyMorning: true }); await h.repair(); assert.equal(h.old.record_status, "stale");
    assert.equal(h.store.activities.length, 2); assert.equal(h.store.provenances.length, 2);
  });
  await test("panne après rattachement avant déplacement external IDs : rejeu retrouve la même activité", async () => {
    const h = await corrupted(); h.store.failRelocateOnce = true;
    const first = await h.repair(); assert.equal(first.committed.length, 0); assert.equal(h.stateStore.rows.get(h.input.uuid).needs_reprocess, true);
    const target = h.prov.activity_id; const replay = await h.repair(); assert.equal(replay.committed.length, 1);
    assert.equal(h.prov.activity_id, target); assert.equal(h.store.activities.length, 2); assert.equal(h.store.provenances.length, 2);
    const key = P.calculatePoiState(h.input, { now: NOW }).results[0].sourceOccurrenceKey;
    assert.equal(h.store.externalIds.find(e => e.value === key).activity_id, target);
  });
  await test("panne avant stale : plan original permet au rejeu de terminer le nettoyage", async () => {
    const h = await corrupted({ onlyMorning: true }); h.store.failStaleOnce = true;
    await assert.rejects(h.repair(), /stale échoué/); assert.equal(h.stateStore.rows.get(h.input.uuid).needs_reprocess, true);
    await h.repair(); assert.equal(h.old.record_status, "stale"); assert.equal(h.store.activities.length, 2);
  });
  await test("source différente du plan : refus avant persistance", async () => {
    const h = await corrupted(); h.input.label["@fr"] += " modifié";
    const before = JSON.stringify(h.store.activities); await assert.rejects(h.repair(), /Source de réparation/);
    assert.equal(JSON.stringify(h.store.activities), before);
  });
  await test("plan hors périmètre et fausse capacité refusés", async () => {
    assert.throws(() => R.createDatatourismeRepairContext({ sourceId: SOURCE, plan: [] }), /borné/);
    await assert.rejects(S.persistSortirIngestion({ store: {}, sources: [], now: NOW, datatourismeRepair: {} }), /Capacité/);
  });
  await test("SQL SDK : déplacement borné aux external IDs d'occurrence, aucune suppression", async () => {
    const calls = []; const client = require("@supabase/supabase-js").createClient("https://example.supabase.co", "fake", { global: { fetch: async (url, init) => {
      calls.push({ url: new URL(url), method: init.method, body: JSON.parse(init.body) }); return new Response("[]", { headers: { "Content-Type": "application/json" } });
    } } });
    await S.createSupabaseSortirStore(client).relocateDatatourismeOccurrenceExternalIds({ sourceId: SOURCE, fromActivityId: id(2), toActivityId: id(3), values: ["datatourisme:one"] });
    assert.equal(calls.length, 1); assert.equal(calls[0].method, "PATCH"); assert.equal(calls[0].url.searchParams.get("source_id"), `eq.${SOURCE}`);
    assert.equal(calls[0].url.searchParams.get("system"), "eq.datatourisme-occurrence"); assert.deepEqual(calls[0].body, { activity_id: id(3) });
  });
  for (const [uuid, date, start, end] of [["013a9d7d-900b-31a7-b736-93073a931ce2", "2026-12-05", "10:00", "11:30"], ["0220712b-c7bc-3196-aa3a-cc2c75b76c42", "2026-11-07", "10:00", "18:30"]]) {
    await test(`décision humaine ${uuid} : date seule redondante, source inchangée`, async () => {
      const p = { ...poi("A"), uuid, takesPlaceAt: [{ startDate: date, endDate: date }, { startDate: date, endDate: date, startTime: start, endTime: end }] };
      const raw = JSON.stringify(p); assert.equal(P.calculatePoiState(p, { now: NOW }).results.length, 1); assert.equal(JSON.stringify(p), raw);
      p.takesPlaceAt.reverse(); assert.equal(P.calculatePoiState(p, { now: NOW }).results.length, 1);
      p.takesPlaceAt[0].endTime = "19:00"; assert.equal(P.calculatePoiState(p, { now: NOW }).results.length, 2);
      p.uuid = id(99); assert.equal(P.calculatePoiState(p, { now: NOW }).results.length, 2);
    });
  }
  console.log(`\n${passed} réussis, ${failed} échoués`); if (failed) process.exitCode = 1;
})();
