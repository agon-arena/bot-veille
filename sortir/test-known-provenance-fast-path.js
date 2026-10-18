"use strict";

// Teste le fast-path des occurrences connues et inchangées (provenance.payload_hash ===
// hash canonique). N'ajoute aucun préchargement/batching : findProvenance reste individuel.

const assert = require("assert");
const { persistSortirIngestion, payloadHash } = require("./supabase-persistence");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error.message}`); } }

function baseActivity(source, overrides = {}) {
  const id = overrides.id || `${source}-1`;
  return {
    title: "Concert commun", description: "Description", startsAt: "2026-11-01T19:00:00.000Z", endsAt: "2026-11-01T21:00:00.000Z",
    timezone: "Europe/Paris", lifecycleStatus: "scheduled", locationType: "physical", venueName: "Théâtre municipal",
    address: "1 rue de Paris", postalCode: "75001", city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522,
    onlineUrl: null, bookingUrl: null, admissionType: "unknown", organizers: [{ name: "Jazz Paris", url: "https://jazz.example" }],
    category: "culture", subcategory: "concert", tags: ["jazz"], imageUrl: null, confidence: 0.95, fieldConfidence: {}, evidence: [],
    provenances: [{ sourceType: "api", sourceName: source, sourceUrl: `https://${source}.example/api`, originalEventUrl: `https://${source}.example/events/${id}`, externalId: id, fetchedAt: "2026-10-16T10:00:00Z" }],
    externalIds: [{ system: source, value: id }], ...overrides
  };
}
function item(source, overrides = {}, metadata = {}) {
  const activity = baseActivity(source, overrides);
  return { activity, sourceRecordId: metadata.sourceRecordId || activity.provenances[0].externalId, sourceOccurrenceKey: metadata.sourceOccurrenceKey || `${activity.provenances[0].externalId}@${activity.startsAt}` };
}
function sourceDescriptor(key, results) { return { key, connectorType: key === "oa" ? "openagenda_json" : key === "mz" ? "mobilizon" : "paris_data", baseUrl: `https://${key}.example/api`, results }; }
const day = (n) => new Date(`2026-11-${String(n).padStart(2, "0")}T12:00:00Z`);

class MemoryStore {
  constructor() {
    this.seq = 0; this.sources = []; this.ingestions = []; this.sourceRuns = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.decisions = [];
    this.calls = { findProvenance: 0, getActivity: 0, updateProvenance: 0, upsertExternalIds: 0, updateActivity: 0, insertCollectionItem: 0, listCandidateActivities: 0, createActivity: 0, createProvenanceIdempotent: 0 };
  }
  resetCalls() { for (const key of Object.keys(this.calls)) this.calls[key] = 0; }
  totalCalls() { return Object.values(this.calls).reduce((a, b) => a + b, 0); }
  id(prefix) { this.seq += 1; return `${prefix}-${this.seq}`; }
  async ensureSource(row) { let found = this.sources.find((x) => x.key === row.key); if (!found) { found = { id: this.id("src"), key: row.key, connector_type: row.connectorType, base_url: row.baseUrl }; this.sources.push(found); } return found; }
  async createIngestionRun(row) { const value = { id: this.id("ing"), ...row }; this.ingestions.push(value); return value; }
  async updateIngestionRun(id, row) { Object.assign(this.ingestions.find((x) => x.id === id), row); }
  async createSourceRun(row) { const value = { id: this.id("run"), ...row }; this.sourceRuns.push(value); return value; }
  async updateSourceRun(id, row) { Object.assign(this.sourceRuns.find((x) => x.id === id), row); }
  async findProvenance(sourceId, recordId, occurrenceKey) { this.calls.findProvenance += 1; return this.provenances.find((x) => x.source_id === sourceId && (x.source_record_id || "") === (recordId || "") && x.source_occurrence_key === occurrenceKey) || null; }
  hydrate(row) { return { ...row, provenances: this.provenances.filter((p) => p.activity_id === row.id).map((p) => ({ ...p, source: this.sources.find((s) => s.id === p.source_id) })), external_ids: this.externalIds.filter((id) => id.activity_id === row.id) }; }
  async getActivity(id) { this.calls.getActivity += 1; const row = this.activities.find((x) => x.id === id); if (!row) throw new Error("activité absente"); return this.hydrate(row); }
  async listCandidateActivities(activity) { this.calls.listCandidateActivities += 1; const time = Date.parse(activity.startsAt); return this.activities.filter((x) => ["active", "review"].includes(x.record_status) && Math.abs(Date.parse(x.starts_at) - time) <= 12 * 3600000).map((x) => this.hydrate(x)); }
  async createActivity(row) { this.calls.createActivity += 1; const value = { id: this.id("act"), merged_into_id: null, ...row }; this.activities.push(value); return value; }
  async updateActivity(id, row) { this.calls.updateActivity += 1; const value = this.activities.find((x) => x.id === id); Object.assign(value, row); return value; }
  async markActivityMerged(id, canonicalId) { return this.updateActivity(id, { record_status: "merged", merged_into_id: canonicalId }); }
  async updateProvenance(id, row) { this.calls.updateProvenance += 1; const value = this.provenances.find((x) => x.id === id); Object.assign(value, row); return value; }
  async moveProvenances() {} async moveExternalIds() {}
  async createProvenanceIdempotent(row) { this.calls.createProvenanceIdempotent += 1; const existing = await this.findProvenance(row.source_id, row.source_record_id, row.source_occurrence_key); if (existing) return existing; const value = { id: this.id("prov"), ...row }; this.provenances.push(value); return value; }
  async upsertExternalIds(activityId, sourceId, ids) { this.calls.upsertExternalIds += 1; for (const id of ids) if (!this.externalIds.some((x) => x.activity_id === activityId && x.source_id === sourceId && x.system === id.system && x.value === id.value)) this.externalIds.push({ activity_id: activityId, source_id: sourceId, system: id.system, value: id.value }); }
  async insertCollectionItem(row) { this.calls.insertCollectionItem += 1; const value = { id: this.id("item"), ...row }; this.items.push(value); return value; }
  async insertDedupDecision(row) { if (row.left_activity_id === row.right_activity_id) return null; if (!this.decisions.some((x) => x.left_activity_id === row.left_activity_id && x.right_activity_id === row.right_activity_id && x.algorithm_version === row.algorithm_version)) this.decisions.push({ id: this.id("decision"), ...row }); }
  async applyDisappearances() {}
  async countFinalActivities() { return this.activities.filter((x) => x.record_status === "active").length; }
}
async function ingest(store, sources, date = day(1)) { return persistSortirIngestion({ store, sources, now: date, staleAfterMs: 0 }); }

(async () => {
  await test("A — occurrence connue, active, hash identique : 4 appels, aucun merge/upsert/update", async () => {
    const db = new MemoryStore();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])]);
    const activityId = db.activities[0].id;
    const provenanceId = db.provenances[0].id;
    db.resetCalls();
    const itemsBefore = db.items.length;
    const result = await ingest(db, [sourceDescriptor("oa", [item("oa")])], day(2));
    assert.strictEqual(result.status, "completed");
    assert.deepStrictEqual(db.calls, { findProvenance: 1, getActivity: 1, updateProvenance: 1, upsertExternalIds: 0, updateActivity: 0, insertCollectionItem: 1, listCandidateActivities: 0, createActivity: 0, createProvenanceIdempotent: 0 });
    assert.strictEqual(db.totalCalls(), 4);
    assert.strictEqual(db.activities.length, 1);
    assert.strictEqual(db.activities[0].id, activityId);
    assert.strictEqual(db.activities[0].record_status, "active");
    assert.strictEqual(db.provenances[0].id, provenanceId);
    assert.strictEqual(db.provenances[0].last_seen_at, day(2).toISOString());
    assert.strictEqual(db.items.length, itemsBefore + 1, "sortir_collection_items doit recevoir une ligne à chaque collecte");
  });

  await test("B — occurrence connue, hash différent : chemin complet inchangé (6 appels)", async () => {
    const db = new MemoryStore();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])]);
    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", [item("oa", { description: "Nouvelle description" })])], day(2));
    assert.strictEqual(db.calls.getActivity, 1);
    assert.strictEqual(db.calls.updateProvenance, 1);
    assert.strictEqual(db.calls.upsertExternalIds, 1);
    assert.strictEqual(db.calls.updateActivity, 1);
    assert.strictEqual(db.calls.insertCollectionItem, 1);
    assert.strictEqual(db.totalCalls(), 6);
    assert.strictEqual(db.activities[0].description, "Nouvelle description");
  });

  await test("C — provenance inactive (active=false), hash identique, activité déjà active : réactivation provenance sans toucher l'activité (4 appels)", async () => {
    const db = new MemoryStore();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])]);
    db.provenances[0].active = false; // simule une disparition déjà appliquée, sans toucher l'activité (ex. gardée active par une autre provenance)
    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])], day(2));
    assert.strictEqual(db.provenances[0].active, true, "la provenance doit redevenir active");
    assert.strictEqual(db.activities[0].record_status, "active");
    assert.strictEqual(db.totalCalls(), 4, "la réactivation de la seule provenance ne doit pas coûter plus que le fast-path normal");
    assert.strictEqual(db.calls.updateActivity, 0);
  });

  await test("D — activité stale, hash identique : réactivation activité (5 appels), le fast-path ne bloque pas la transition", async () => {
    const db = new MemoryStore();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])]);
    db.provenances[0].active = false;
    db.activities[0].record_status = "stale"; // simule applyDisappearances déjà passé
    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])], day(2));
    assert.strictEqual(db.activities[0].record_status, "active", "une activité stale doit redevenir active au retour de son occurrence");
    assert.strictEqual(db.provenances[0].active, true);
    assert.deepStrictEqual({ getActivity: db.calls.getActivity, updateProvenance: db.calls.updateProvenance, updateActivity: db.calls.updateActivity, upsertExternalIds: db.calls.upsertExternalIds, insertCollectionItem: db.calls.insertCollectionItem }, { getActivity: 1, updateProvenance: 1, updateActivity: 1, upsertExternalIds: 0, insertCollectionItem: 1 });
    assert.strictEqual(db.totalCalls(), 5);
  });

  await test("E — lifecycleStatus modifié (scheduled → cancelled) : hash différent, chemin complet persiste la modification", async () => {
    const db = new MemoryStore();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])]);
    await ingest(db, [sourceDescriptor("oa", [item("oa", { lifecycleStatus: "cancelled" })])], day(2));
    assert.strictEqual(db.activities[0].lifecycle_status, "cancelled");
  });

  await test("F — ancien hash compact : premier passage complet puis fast-path dès le deuxième passage", async () => {
    const db = new MemoryStore();
    const activity = baseActivity("oa");
    const source = await db.ensureSource({ key: "oa", connectorType: "openagenda_json", baseUrl: "https://oa.example/api" });
    const seededActivity = await db.createActivity({ title: activity.title, description: activity.description, starts_at: activity.startsAt, ends_at: activity.endsAt, timezone: activity.timezone, lifecycle_status: activity.lifecycleStatus, location_type: activity.locationType, venue_name: activity.venueName, address: activity.address, postal_code: activity.postalCode, city: activity.city, country: activity.country, latitude: activity.latitude, longitude: activity.longitude, online_url: activity.onlineUrl, booking_url: activity.bookingUrl, admission_type: activity.admissionType, organizers: activity.organizers, category: activity.category, subcategory: activity.subcategory, tags: activity.tags, image_url: activity.imageUrl, confidence: activity.confidence, field_confidence: activity.fieldConfidence, evidence: activity.evidence, record_status: "active" });
    const ancienHashCompact = payloadHash({ title: activity.title, startsAt: activity.startsAt, endsAt: activity.endsAt, lifecycleStatus: activity.lifecycleStatus, venueName: activity.venueName, city: activity.city, bookingUrl: activity.bookingUrl, admissionType: activity.admissionType });
    db.provenances.push({ id: db.id("prov"), activity_id: seededActivity.id, source_id: source.id, source_record_id: "oa-1", source_occurrence_key: "oa-1@2026-11-01T19:00:00.000Z", original_event_url: "https://oa.example/events/oa-1", payload_hash: ancienHashCompact, source_payload: { title: activity.title, version: 1 }, first_seen_at: day(1).toISOString(), last_seen_at: day(1).toISOString(), active: true });

    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])], day(2));
    assert.strictEqual(db.activities.length, 1, "aucun doublon au premier passage avec ancien hash");
    assert.strictEqual(db.provenances.length, 1);
    assert.notStrictEqual(db.provenances[0].payload_hash, ancienHashCompact, "le nouveau hash canonique doit remplacer l'ancien dès ce premier passage");
    assert.strictEqual(db.calls.updateActivity, 1, "le premier passage avec ancien hash doit prendre le chemin complet");

    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])], day(3));
    assert.strictEqual(db.totalCalls(), 4, "le deuxième passage doit désormais prendre le fast-path");
    assert.strictEqual(db.calls.updateActivity, 0);
    assert.strictEqual(db.calls.upsertExternalIds, 0);
  });

  await test("G — multisource : une activité fusionnée garde les données de l'autre provenance intactes quand une provenance revient inchangée", async () => {
    const db = new MemoryStore();
    await ingest(db, [sourceDescriptor("oa", [item("oa", { title: "Concert commun", organizers: [{ name: "Jazz Paris", url: "https://jazz.example" }] })]), sourceDescriptor("mz", [item("mz", { startsAt: "2026-11-01T19:03:00.000Z", description: "Description vue par Mobilizon", imageUrl: "https://mz.example/affiche.jpg" })])]);
    assert.strictEqual(db.activities.length, 1, "les deux sources doivent avoir fusionné sur une seule activité");
    const mergedDescriptionAvant = db.activities[0].description;
    const mergedImageAvant = db.activities[0].image_url;
    const mzProvenanceAvant = { ...db.provenances.find((p) => p.source_id === db.sources.find((s) => s.key === "mz").id) };

    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", [item("oa", { title: "Concert commun", organizers: [{ name: "Jazz Paris", url: "https://jazz.example" }] })])], day(2));
    assert.strictEqual(db.totalCalls(), 4, "oa revient inchangé : fast-path attendu");
    assert.strictEqual(db.activities.length, 1);
    assert.strictEqual(db.activities[0].description, mergedDescriptionAvant, "le fast-path d'oa ne doit pas altérer la description apportée par mz");
    assert.strictEqual(db.activities[0].image_url, mergedImageAvant, "le fast-path d'oa ne doit pas altérer l'image apportée par mz");
    const mzProvenanceApres = db.provenances.find((p) => p.source_id === db.sources.find((s) => s.key === "mz").id);
    assert.strictEqual(mzProvenanceApres.last_seen_at, mzProvenanceAvant.last_seen_at, "la provenance mz ne doit pas être touchée par l'ingestion d'oa");
  });

  console.log("\nMesure — appels Supabase par occurrence connue, active, inchangée (fast-path cas A) :");
  console.log(`  avant ce correctif : ≈ 6 appels/occurrence`);
  console.log(`  après ce correctif :   4 appels/occurrence`);
  for (const n of [206, 1000, 10000]) {
    console.log(`  N=${String(n).padStart(6, " ")} occurrences inchangées → ancien ≈ ${n * 6} appels, nouveau ≈ ${n * 4} appels`);
  }
  console.log(`  Comparaison lot réel de 206 activités (réingestion complète) : ancien ≈ 1 240 appels → nouveau ≈ ${206 * 4 + 4} appels (hors coût fixe de run/source, inchangé).`);

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
