"use strict";
// Reactivation of a stale activity: an activity never supported by anything but its own
// provenance gets its CREATION status back; multi-supported activities keep the existing rule.
const assert = require("assert/strict");
const { harness, poi, NOW } = require("./test-datatourisme-poi-reconciliation");
const P = require("./datatourisme-poi-state"), R = require("./datatourisme-poi-reconciliation");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }
const slot = day => ({ startDate: day, startTime: "10:00", endDate: day, endTime: "12:00" });
// Organizer without a name: diagnostic retained, DISTINCT publication now non-blocking.
function editorial(n = 801) { const p = poi("B", n); p.hasContact = [{ homepage: ["https://museum.example"] }]; return p; }
const statusOf = (s, p) => s.activities.find(a => s.provenances.some(x => x.activity_id === a.id && x.source_record_id.startsWith(`datatourisme:${p.uuid}:`)))?.record_status;
const elsewhere = p => ({ ...p, takesPlaceAt: [slot("2026-11-09")] });

(async () => {
  await test("NEEDS_REVIEW éditorial confirmé par la validation", () => {
    assert.equal(P.calculatePoiState(editorial(), { now: NOW }).results[0].validation.status, "NEEDS_REVIEW");
  });
  await test("DISTINCT nom manquant : disparition → réapparition reste active", async () => {
    const h = harness(), s = h.activityStore, p = editorial(); await h.run([p]); assert.equal(statusOf(s, p), "active");
    await h.run([elsewhere(p)]); assert.equal(s.activities[0].record_status, "stale");
    await h.run([p]); assert.equal(s.activities[0].record_status, "active"); assert.equal(s.activities.length, 2);
  });
  await test("panne entre provenance et bascule → rejeu : DISTINCT active restauré", async () => {
    const h = harness(), s = h.activityStore, update = s.updateActivity.bind(s); let crash = true;
    s.updateActivity = async (id, row) => { if (crash && row.record_status === "active") { crash = false; throw new Error("crash"); } return update(id, row); };
    const p = editorial(), first = await h.run([p], NOW, R.createDatatourismePoiPersister({ store: s, now: NOW, writeBehind: false }));
    assert.equal(first.committed.length, 0); assert.equal(s.activities[0].record_status, "stale");
    await h.run([p], NOW, R.createDatatourismePoiPersister({ store: s, now: NOW, writeBehind: false })); assert.equal(s.activities[0].record_status, "active"); assert.equal(s.activities.length, 1);
  });
  await test("activité ACTIVE normale : disparition → réapparition redevient active", async () => {
    const h = harness(), s = h.activityStore, p = poi("B", 802); await h.run([p]); assert.equal(statusOf(s, p), "active");
    await h.run([elsewhere(p)]); assert.equal(s.activities[0].record_status, "stale"); await h.run([p]); assert.equal(s.activities[0].record_status, "active");
  });
  await test("activité multisource : autre soutien historique, règle existante conservée (pas de généralisation)", async () => {
    const h = harness(), s = h.activityStore, p = editorial(803); await h.run([p]); const a = s.activities[0];
    s.provenances.push({ id: "other-support", activity_id: a.id, source_id: "99999999-0000-0000-0000-000000000099", source_record_id: "other", source_occurrence_key: "other", active: false });
    await h.run([elsewhere(p)]); assert.equal(a.record_status, "stale"); await h.run([p]); assert.equal(a.record_status, "active", "règle historique inchangée hors activité mono-provenance");
  });
  await test("deux POI DATAtourisme fusionnés (VALID) : réapparition active", async () => {
    const h = harness(), s = h.activityStore, a = poi("B", 804), b = poi("B", 805); b.label = a.label;
    a.hasDescription = b.hasDescription = [{ description: { "@fr": "Cette exposition présente une collection exceptionnelle de peintures et sculptures réalisées par des artistes internationaux dans les salles du musée municipal." } }];
    for (const p of [a, b]) p.isLocatedAt[0].address[0].streetAddress = ["1 rue du Musée"];
    await h.run([a, b]); assert.equal(s.activities.length, 1);
    await h.run([elsewhere(a), elsewhere(b)]); assert.equal(s.activities[0].record_status, "stale"); await h.run([a, b]); assert.equal(s.activities[0].record_status, "active");
  });
  await test("idempotence : second rejeu sans changement", async () => {
    const h = harness(), s = h.activityStore, p = editorial(806); await h.run([p]); await h.run([elsewhere(p)]); await h.run([p]);
    const before = JSON.stringify([s.activities.map(({ last_seen_at, updated_at, ...x }) => x), s.provenances, s.externalIds]);
    assert.equal((await h.run([p])).unchanged.length, 1); h.stateStore.rows.clear(); await h.run([p]);
    assert.equal(JSON.stringify([s.activities.map(({ last_seen_at, updated_at, ...x }) => x), s.provenances.map(({ last_seen_at, last_seen_run_id, ...x }) => x), s.externalIds]),
      JSON.stringify(JSON.parse(before).map((x, i) => i === 1 ? x.map(({ last_seen_at, last_seen_run_id, ...y }) => y) : x)));
    assert.equal(s.activities.find(a => a.record_status !== "stale").record_status, "active");
  });
  console.log(`${passed} réussis, ${failed} échoués`); if (failed) process.exitCode = 1;
})();
