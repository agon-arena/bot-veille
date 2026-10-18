"use strict";

// Teste canonicalActivityPayload() (fiabilité de payload_hash) : AUCUN fast-path n'existe
// encore — ces tests vérifient uniquement que le hash représente fidèlement l'état métier,
// et que le pipeline complet (merge/update/upsert) continue de s'exécuter intégralement.

const assert = require("assert");
const { payloadHash, canonicalActivityPayload, persistSortirIngestion } = require("./supabase-persistence");
const { normalizeActivity } = require("./activity-validation");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error.message}`); } }
function hashOf(activity) { return payloadHash(canonicalActivityPayload(activity)); }

function baseActivity(overrides = {}) {
  return {
    title: "Concert commun", description: "Description initiale", startsAt: "2026-11-01T19:00:00.000Z", endsAt: "2026-11-01T21:00:00.000Z",
    timezone: "Europe/Paris", lifecycleStatus: "scheduled", locationType: "physical", venueName: "Théâtre municipal",
    address: "1 rue de Paris", postalCode: "75001", city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522,
    onlineUrl: null, organizers: [{ name: "Jazz Paris", url: "https://jazz.example" }], category: "culture", subcategory: "concert",
    tags: ["jazz", "concert"], imageUrl: "https://img.example/1.jpg", bookingUrl: "https://billet.example/1", admissionType: "paid",
    externalIds: [{ system: "oa", value: "oa-1" }, { system: "oa-timing", value: "t-1" }],
    confidence: 0.9, fieldConfidence: { venueName: 0.75 }, evidence: [{ field: "venueName", sourceValue: "brut", provenanceIndex: 0 }],
    provenances: [{ sourceType: "api", sourceName: "oa", sourceUrl: "https://oa.example/api", originalEventUrl: "https://oa.example/events/1", externalId: "oa-1", fetchedAt: "2026-10-16T10:00:00.000Z" }],
    ...overrides
  };
}

(async () => {
  await test("identité — deux activités métier identiques (construites dans un ordre de clés différent) → même hash", async () => {
    const a = baseActivity();
    const b = { organizers: a.organizers, title: a.title, tags: a.tags, ...baseActivity({}) }; // ordre de clés JS différent, contenu identique
    assert.strictEqual(hashOf(a), hashOf(b));
  });

  const champsOublies = [
    ["description", { description: "Description totalement réécrite" }],
    ["imageUrl", { imageUrl: "https://img.example/COMPLETEMENT-DIFFERENT.jpg" }],
    ["externalIds", { externalIds: [...baseActivity().externalIds, { system: "oa-timing", value: "t-2-nouveau" }] }],
    ["organizers", { organizers: [{ name: "Nouvel organisateur", url: "https://autre.example" }] }],
    ["un champ géographique (latitude)", { latitude: 45.764 }],
    ["fieldConfidence", { fieldConfidence: { venueName: 0.75, city: 0.4 } }]
  ];
  for (const [label, mutation] of champsOublies) {
    await test(`champ auparavant oublié — ${label} change le hash`, async () => {
      const reference = hashOf(baseActivity());
      assert.notStrictEqual(hashOf(baseActivity(mutation)), reference, `${label} ne modifie pas le hash`);
    });
  }

  await test("lifecycleStatus scheduled → cancelled change le hash", async () => {
    assert.notStrictEqual(hashOf(baseActivity({ lifecycleStatus: "cancelled" })), hashOf(baseActivity()));
  });

  await test("collections — tags dans un ordre différent produisent le même hash", async () => {
    assert.strictEqual(hashOf(baseActivity({ tags: ["concert", "jazz"] })), hashOf(baseActivity({ tags: ["jazz", "concert"] })));
  });
  await test("collections — mais un ensemble de tags différent change bien le hash", async () => {
    assert.notStrictEqual(hashOf(baseActivity({ tags: ["jazz", "concert"] })), hashOf(baseActivity({ tags: ["jazz", "exposition"] })));
  });
  await test("collections — externalIds dans un ordre différent produisent le même hash", async () => {
    const [first, second] = baseActivity().externalIds;
    assert.strictEqual(hashOf(baseActivity({ externalIds: [first, second] })), hashOf(baseActivity({ externalIds: [second, first] })));
  });
  await test("collections — organizers dans un ordre différent produisent le même hash", async () => {
    const orgs = [{ name: "Jazz Paris", url: "https://jazz.example" }, { name: "Mairie", url: "https://mairie.example" }];
    assert.strictEqual(hashOf(baseActivity({ organizers: orgs })), hashOf(baseActivity({ organizers: [...orgs].reverse() })));
  });
  await test("collections — evidence dans un ordre différent produisent le même hash", async () => {
    const evidence = [{ field: "venueName", sourceValue: "brut", provenanceIndex: 0 }, { field: "admissionType", sourceValue: "gratuit", provenanceIndex: 0 }];
    assert.strictEqual(hashOf(baseActivity({ evidence })), hashOf(baseActivity({ evidence: [...evidence].reverse() })));
  });
  await test("collections — fieldConfidence : ordre d'insertion des clés sans effet sur le hash", async () => {
    const un = { venueName: 0.75, city: 0.4 };
    const deux = {}; deux.city = 0.4; deux.venueName = 0.75; // mêmes clés, ordre d'insertion inverse
    assert.strictEqual(hashOf(baseActivity({ fieldConfidence: un })), hashOf(baseActivity({ fieldConfidence: deux })));
  });

  // --- Migration naturelle d'un ancien hash compact (sans aucun fast-path) ---
  class MemoryStore {
    constructor() { this.seq = 0; this.sources = []; this.ingestions = []; this.sourceRuns = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.decisions = []; this.payloadWrites = 0; }
    id(prefix) { this.seq += 1; return `${prefix}-${this.seq}`; }
    async ensureSource(row) { let found = this.sources.find((x) => x.key === row.key); if (!found) { found = { id: this.id("src"), key: row.key, connector_type: row.connectorType, base_url: row.baseUrl }; this.sources.push(found); } return found; }
    async createIngestionRun(row) { const value = { id: this.id("ing"), ...row }; this.ingestions.push(value); return value; }
    async updateIngestionRun(id, row) { Object.assign(this.ingestions.find((x) => x.id === id), row); }
    async createSourceRun(row) { const value = { id: this.id("run"), ...row }; this.sourceRuns.push(value); return value; }
    async updateSourceRun(id, row) { Object.assign(this.sourceRuns.find((x) => x.id === id), row); }
    async findProvenance(sourceId, recordId, occurrenceKey) { return this.provenances.find((x) => x.source_id === sourceId && (x.source_record_id || "") === (recordId || "") && x.source_occurrence_key === occurrenceKey) || null; }
    hydrate(row) { return { ...row, provenances: this.provenances.filter((p) => p.activity_id === row.id).map((p) => ({ ...p, source: this.sources.find((s) => s.id === p.source_id) })), external_ids: this.externalIds.filter((id) => id.activity_id === row.id) }; }
    async getActivity(id) { const row = this.activities.find((x) => x.id === id); if (!row) throw new Error("activité absente"); return this.hydrate(row); }
    async listCandidateActivities() { return []; }
    async createActivity(row) { const value = { id: this.id("act"), merged_into_id: null, ...row }; this.activities.push(value); return value; }
    async updateActivity(id, row) { const value = this.activities.find((x) => x.id === id); Object.assign(value, row); return value; }
    async markActivityMerged(id, canonicalId) { return this.updateActivity(id, { record_status: "merged", merged_into_id: canonicalId }); }
    async updateProvenance(id, row) { if (Object.prototype.hasOwnProperty.call(row, "source_payload")) this.payloadWrites += 1; const value = this.provenances.find((x) => x.id === id); Object.assign(value, row); return value; }
    async moveProvenances() {} async moveExternalIds() {}
    async createProvenanceIdempotent(row) { const existing = await this.findProvenance(row.source_id, row.source_record_id, row.source_occurrence_key); if (existing) return existing; const value = { id: this.id("prov"), ...row }; this.provenances.push(value); this.payloadWrites += 1; return value; }
    async upsertExternalIds(activityId, sourceId, ids) { for (const id of ids) if (!this.externalIds.some((x) => x.activity_id === activityId && x.source_id === sourceId && x.system === id.system && x.value === id.value)) this.externalIds.push({ activity_id: activityId, source_id: sourceId, system: id.system, value: id.value }); }
    async insertCollectionItem(row) { const value = { id: this.id("item"), ...row }; this.items.push(value); return value; }
    async insertDedupDecision() { return null; }
    async applyDisappearances() {}
    async countFinalActivities() { return this.activities.filter((x) => x.record_status === "active").length; }
  }

  function sourceDescriptor(results) { return { key: "oa-1", connectorType: "openagenda_json", baseUrl: "https://oa.example/api", results }; }

  await test("ancien hash — provenance seedée avec le hash compact AVANT ce correctif, premier passage sans doublon", async () => {
    const db = new MemoryStore();
    const activity = baseActivity();
    const source = await db.ensureSource({ key: "oa-1", connectorType: "openagenda_json", baseUrl: "https://oa.example/api" });
    const seededActivity = await db.createActivity({ title: activity.title, description: activity.description, starts_at: activity.startsAt, ends_at: activity.endsAt, timezone: activity.timezone, lifecycle_status: activity.lifecycleStatus, location_type: activity.locationType, venue_name: activity.venueName, address: activity.address, postal_code: activity.postalCode, city: activity.city, country: activity.country, latitude: activity.latitude, longitude: activity.longitude, online_url: activity.onlineUrl, booking_url: activity.bookingUrl, admission_type: activity.admissionType, organizers: activity.organizers, category: activity.category, subcategory: activity.subcategory, tags: activity.tags, image_url: activity.imageUrl, confidence: activity.confidence, field_confidence: activity.fieldConfidence, evidence: activity.evidence, record_status: "active" });
    // Hash "ancien format" : calculé comme avant ce correctif, sur compactPayload (8 champs), pas canonicalActivityPayload.
    const ancienHashCompact = payloadHash({ title: activity.title, startsAt: activity.startsAt, endsAt: activity.endsAt, lifecycleStatus: activity.lifecycleStatus, venueName: activity.venueName, city: activity.city, bookingUrl: activity.bookingUrl, admissionType: activity.admissionType });
    const seededProvenance = { id: db.id("prov"), activity_id: seededActivity.id, source_id: source.id, source_record_id: "oa-1", source_occurrence_key: "oa-1@2026-11-01T19:00:00.000Z", original_event_url: "https://oa.example/events/1", payload_hash: ancienHashCompact, source_payload: { title: activity.title, version: 1 }, first_seen_at: "2026-10-01T00:00:00.000Z", last_seen_at: "2026-10-01T00:00:00.000Z", active: true };
    db.provenances.push(seededProvenance);
    // La comparaison se fait contre la forme NORMALISÉE : c'est elle que persistSortirIngestion
    // hache réellement (validation.activity), jamais l'objet brut tel que construit par le test.
    const hashAttendu = hashOf(normalizeActivity(activity));
    assert.notStrictEqual(ancienHashCompact, hashAttendu, "l'ancien hash doit différer du nouveau pour que ce test soit probant");

    const item = { activity, sourceRecordId: "oa-1", sourceOccurrenceKey: "oa-1@2026-11-01T19:00:00.000Z" };
    const first = await persistSortirIngestion({ store: db, sources: [sourceDescriptor([item])], now: new Date("2026-11-02T00:00:00Z") });
    assert.strictEqual(first.status, "completed");
    assert.strictEqual(db.activities.length, 1, "aucun doublon d'activité ne doit être créé lors de la migration");
    assert.strictEqual(db.provenances.length, 1, "aucun doublon de provenance ne doit être créé lors de la migration");
    const nouveauHash = db.provenances[0].payload_hash;
    assert.notStrictEqual(nouveauHash, ancienHashCompact, "la provenance doit recevoir le nouveau hash dès ce premier passage");
    assert.strictEqual(nouveauHash, hashAttendu);

    const writesAvantDeuxiemePassage = db.payloadWrites;
    const second = await persistSortirIngestion({ store: db, sources: [sourceDescriptor([{ activity, sourceRecordId: "oa-1", sourceOccurrenceKey: "oa-1@2026-11-01T19:00:00.000Z" }])], now: new Date("2026-11-03T00:00:00Z") });
    assert.strictEqual(second.status, "completed");
    assert.strictEqual(db.activities.length, 1);
    assert.strictEqual(db.provenances.length, 1);
    assert.strictEqual(db.provenances[0].payload_hash, nouveauHash, "le deuxième passage doit produire exactement le même hash (stabilité)");
    assert.strictEqual(db.payloadWrites, writesAvantDeuxiemePassage, "le deuxième passage ne doit plus réécrire le payload (hash désormais stable)");
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
