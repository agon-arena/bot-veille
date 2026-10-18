"use strict";

// Teste le préchargement par lot des LECTURES (findProvenance/getActivity) pour les
// occurrences connues. Les ÉCRITURES restent volontairement individuelles à cette étape
// (updateProvenance/upsertExternalIds/updateActivity/insertCollectionItem/créations) — ce
// n'est pas une régression, c'est le périmètre explicite de ce commit.

const assert = require("assert");
const { persistSortirIngestion, createSupabaseSortirStore, PRELOAD_CHUNK_SIZE, OCCURRENCE_KEY_CHUNK_SIZE } = require("./supabase-persistence");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error.message}`); } }

function baseActivity(source, overrides = {}) {
  const id = overrides.id || `${source}-${overrides.suffix || "1"}`;
  return {
    title: "Concert commun", description: "Description", startsAt: overrides.startsAt || "2026-11-01T19:00:00.000Z", endsAt: overrides.endsAt || "2026-11-01T21:00:00.000Z",
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
  return { activity, sourceRecordId: metadata.sourceRecordId === undefined ? activity.provenances[0].externalId : metadata.sourceRecordId, sourceOccurrenceKey: metadata.sourceOccurrenceKey || `${activity.provenances[0].externalId}@${activity.startsAt}` };
}
function sourceDescriptor(key, results) { return { key, connectorType: key === "oa" ? "openagenda_json" : key === "mz" ? "mobilizon" : "paris_data", baseUrl: `https://${key}.example/api`, results }; }
const day = (n) => new Date(`2026-11-${String(n).padStart(2, "0")}T12:00:00Z`);

class MemoryStore {
  constructor() {
    this.seq = 0; this.sources = []; this.ingestions = []; this.sourceRuns = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.decisions = [];
    this.calls = { findProvenance: 0, findProvenancesBatch: 0, getActivity: 0, getActivitiesBatch: 0, updateProvenance: 0, upsertExternalIds: 0, updateActivity: 0, insertCollectionItem: 0, listCandidateActivities: 0, createActivity: 0, createProvenanceIdempotent: 0, touchProvenancesBatch: 0, insertCollectionItemsBatch: 0 };
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
  async findProvenancesBatch(sourceId, occurrenceKeys) { this.calls.findProvenancesBatch += 1; const keys = new Set(occurrenceKeys); return this.provenances.filter((x) => x.source_id === sourceId && keys.has(x.source_occurrence_key)); }
  hydrate(row) { return { ...row, provenances: this.provenances.filter((p) => p.activity_id === row.id).map((p) => ({ ...p, source: this.sources.find((s) => s.id === p.source_id) })), external_ids: this.externalIds.filter((id) => id.activity_id === row.id) }; }
  async getActivity(id) { this.calls.getActivity += 1; const row = this.activities.find((x) => x.id === id); if (!row) throw new Error("activité absente"); return this.hydrate(row); }
  async getActivitiesBatch(ids) { this.calls.getActivitiesBatch += 1; const set = new Set(ids); return this.activities.filter((x) => set.has(x.id)).map((x) => this.hydrate(x)); }
  async listCandidateActivities(activity) { this.calls.listCandidateActivities += 1; const time = Date.parse(activity.startsAt); return this.activities.filter((x) => ["active", "review"].includes(x.record_status) && Math.abs(Date.parse(x.starts_at) - time) <= 12 * 3600000).map((x) => this.hydrate(x)); }
  async createActivity(row) { this.calls.createActivity += 1; const value = { id: this.id("act"), merged_into_id: null, ...row }; this.activities.push(value); return value; }
  async updateActivity(id, row) { this.calls.updateActivity += 1; const value = this.activities.find((x) => x.id === id); Object.assign(value, row); return value; }
  async markActivityMerged(id, canonicalId) { return this.updateActivity(id, { record_status: "merged", merged_into_id: canonicalId }); }
  async updateProvenance(id, row) { this.calls.updateProvenance += 1; const value = this.provenances.find((x) => x.id === id); Object.assign(value, row); return value; }
  async touchProvenancesBatch(ids, touch) { this.calls.touchProvenancesBatch += 1; const set = new Set(ids); for (const p of this.provenances) if (set.has(p.id)) Object.assign(p, touch); }
  async moveProvenances() {} async moveExternalIds() {}
  async createProvenanceIdempotent(row) { this.calls.createProvenanceIdempotent += 1; const existing = await this.findProvenance(row.source_id, row.source_record_id, row.source_occurrence_key); if (existing) return existing; const value = { id: this.id("prov"), ...row }; this.provenances.push(value); return value; }
  async upsertExternalIds(activityId, sourceId, ids) { this.calls.upsertExternalIds += 1; for (const id of ids) if (!this.externalIds.some((x) => x.activity_id === activityId && x.source_id === sourceId && x.system === id.system && x.value === id.value)) this.externalIds.push({ activity_id: activityId, source_id: sourceId, system: id.system, value: id.value }); }
  async insertCollectionItem(row) { this.calls.insertCollectionItem += 1; const value = { id: this.id("item"), ...row }; this.items.push(value); return value; }
  async insertCollectionItemsBatch(rows) { this.calls.insertCollectionItemsBatch += 1; for (const row of rows) this.items.push({ id: this.id("item"), ...row }); }
  async insertDedupDecision(row) { if (row.left_activity_id === row.right_activity_id) return null; if (!this.decisions.some((x) => x.left_activity_id === row.left_activity_id && x.right_activity_id === row.right_activity_id && x.algorithm_version === row.algorithm_version)) this.decisions.push({ id: this.id("decision"), ...row }); }
  async applyDisappearances() {}
  async countFinalActivities() { return this.activities.filter((x) => x.record_status === "active").length; }
}
async function ingest(store, sources, date = day(1)) { return persistSortirIngestion({ store, sources, now: date, staleAfterMs: 0 }); }

// Chaque item à plus de 12h du précédent (listCandidateActivities ne considère jamais deux
// items à plus de 12h l'un de l'autre comme candidats) : garantit 0 MATCH/REVIEW accidentel
// entre les N items malgré un title/venue identique, sans dépendre de leur contenu.
const BASE_INSTANT = Date.parse("2026-11-01T19:00:00.000Z");
function manyKnownItems(n, { offsetDays = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const startsAt = new Date(BASE_INSTANT + (offsetDays + i) * 86400000).toISOString();
    const endsAt = new Date(BASE_INSTANT + (offsetDays + i) * 86400000 + 7200000).toISOString();
    return item("oa", { suffix: String(offsetDays + i), startsAt, endsAt });
  });
}

(async () => {
  await test("A — 206 occurrences connues : aucun findProvenance/getActivity individuel, préchargement en 1 lecture chacun", async () => {
    const db = new MemoryStore();
    const items = manyKnownItems(206);
    await ingest(db, [sourceDescriptor("oa", items)]); // création initiale, non mesurée
    assert.strictEqual(db.activities.length, 206);
    db.resetCalls();
    const result = await ingest(db, [sourceDescriptor("oa", items)], day(2));
    assert.strictEqual(result.status, "completed");
    assert.strictEqual(db.calls.findProvenance, 0, "aucune lecture individuelle de provenance");
    assert.strictEqual(db.calls.getActivity, 0, "aucune lecture individuelle d'activité");
    assert.strictEqual(db.calls.findProvenancesBatch, 1, "206 clés tiennent dans un seul chunk de 500");
    assert.strictEqual(db.calls.getActivitiesBatch, 1);
    // Depuis le batching des écritures du cas A (étape suivante à celle-ci), ces 206 écritures
    // sont elles aussi groupées — assertions tenues à jour avec le pipeline actuel.
    assert.strictEqual(db.calls.updateProvenance, 0);
    assert.strictEqual(db.calls.touchProvenancesBatch, 1);
    assert.strictEqual(db.calls.insertCollectionItem, 0);
    assert.strictEqual(db.calls.insertCollectionItemsBatch, 1);
    assert.strictEqual(db.calls.updateActivity, 0);
    assert.strictEqual(db.calls.upsertExternalIds, 0);
    assert.strictEqual(db.activities.length, 206, "aucune activité perdue ou dupliquée");
  });

  await test("B — lot mixte (connues + nouvelles) : les connues utilisent les Maps, les nouvelles suivent le chemin actuel", async () => {
    const db = new MemoryStore();
    const known = manyKnownItems(10, { offsetDays: 1 });
    await ingest(db, [sourceDescriptor("oa", known)]);
    db.resetCalls();
    const fresh = manyKnownItems(5, { offsetDays: 20 }).map((it, i) => ({ ...it, activity: { ...it.activity, title: `Nouvel événement ${i}` }, sourceOccurrenceKey: `nouveau-${i}@2026-11-20T19:00:00.000Z` }));
    await ingest(db, [sourceDescriptor("oa", [...known, ...fresh])], day(2));
    // findProvenance individuel reste à 5 : c'est createProvenanceIdempotent (chemin des
    // NOUVELLES occurrences, non touché à cette étape) qui l'appelle en interne pour chacune
    // des 5 nouvelles — rien à voir avec le préchargement des 10 connues.
    assert.strictEqual(db.calls.findProvenance, 5);
    assert.strictEqual(db.calls.getActivity, 0, "même les 5 nouvelles ne déclenchent pas de getActivity individuel hors cas de course");
    assert.strictEqual(db.calls.findProvenancesBatch, 1);
    assert.strictEqual(db.calls.getActivitiesBatch, 1, "seules les activités des provenances CONNUES sont préchargées");
    assert.strictEqual(db.calls.listCandidateActivities, 5, "les 5 nouvelles suivent le chemin actuel, inchangé");
    assert.strictEqual(db.calls.createActivity, 5);
    assert.strictEqual(db.calls.createProvenanceIdempotent, 5);
    assert.strictEqual(db.activities.length, 15);
  });

  await test("C — activité partagée, deux occurrences du même lot : la seconde voit l'état mis à jour par la première, pas la photo de début de run", async () => {
    const db = new MemoryStore();
    const source = await db.ensureSource({ key: "oa", connectorType: "openagenda_json", baseUrl: "https://oa.example/api" });
    const activity = await db.createActivity({ title: "Ancien titre", description: "Ancienne description", starts_at: "2026-11-01T19:00:00.000Z", ends_at: "2026-11-01T21:00:00.000Z", timezone: "Europe/Paris", lifecycle_status: "scheduled", location_type: "physical", venue_name: "Théâtre municipal", address: "1 rue de Paris", postal_code: "75001", city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522, online_url: null, booking_url: null, admission_type: "unknown", organizers: [], category: null, subcategory: null, tags: [], image_url: null, confidence: 0.9, field_confidence: {}, evidence: [], record_status: "active" });
    // Deux occurrences distinctes (clés différentes) de la même source, déjà liées à LA MÊME activité.
    db.provenances.push({ id: db.id("prov"), activity_id: activity.id, source_id: source.id, source_record_id: "oa-A", source_occurrence_key: "oa-A@2026-11-01T19:00:00.000Z", original_event_url: "https://oa.example/events/oa-A", payload_hash: "hash-perime-A", source_payload: {}, last_seen_at: day(1).toISOString(), active: true });
    db.provenances.push({ id: db.id("prov"), activity_id: activity.id, source_id: source.id, source_record_id: "oa-B", source_occurrence_key: "oa-B@2026-11-01T19:00:00.000Z", original_event_url: "https://oa.example/events/oa-B", payload_hash: "hash-perime-B", source_payload: {}, last_seen_at: day(1).toISOString(), active: true });
    // Identifiants externes déjà connus pour A et B : sans eux, compareActivities() (appelé par
    // mergeActivities) ne trouve aucun signal d'identité et refuse la fusion (DISTINCT) — ce
    // n'est pas ce que ce test veut exercer (il veut la fraîcheur du cache, pas le dédoublonnage).
    db.externalIds.push({ activity_id: activity.id, source_id: source.id, system: "oa", value: "oa-A" });
    db.externalIds.push({ activity_id: activity.id, source_id: source.id, system: "oa", value: "oa-B" });

    const itemA = item("oa", { id: "oa-A", title: "Ancien titre", description: "Ancienne description", startsAt: "2026-11-01T19:00:00.000Z", endsAt: "2026-11-01T21:00:00.000Z" }, { sourceRecordId: "oa-A", sourceOccurrenceKey: "oa-A@2026-11-01T19:00:00.000Z" });
    itemA.activity.title = "Titre corrigé par l'occurrence A"; // seul le titre change pour A
    const itemB = item("oa", { id: "oa-B", title: "Ancien titre", description: "Ancienne description", startsAt: "2026-11-01T19:00:00.000Z", endsAt: "2026-11-01T21:00:00.000Z" }, { sourceRecordId: "oa-B", sourceOccurrenceKey: "oa-B@2026-11-01T19:00:00.000Z" });
    itemB.activity.description = "Description corrigée par l'occurrence B"; // seule la description change pour B

    await ingest(db, [sourceDescriptor("oa", [itemA, itemB])], day(2));

    const finalActivity = db.activities.find((x) => x.id === activity.id);
    assert.strictEqual(finalActivity.title, "Titre corrigé par l'occurrence A", "le changement apporté par A doit être présent");
    assert.strictEqual(finalActivity.description, "Description corrigée par l'occurrence B", "le changement de B ne doit pas effacer celui de A : B doit avoir fusionné contre l'état déjà mis à jour par A, pas contre la photo de début de run");
  });

  await test("D — occurrence connue, hash identique, activité stale : réactivation correcte après préchargement", async () => {
    const db = new MemoryStore();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])]);
    db.activities[0].record_status = "stale";
    db.provenances[0].active = false;
    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])], day(2));
    assert.strictEqual(db.activities[0].record_status, "active");
    assert.strictEqual(db.provenances[0].active, true);
    assert.strictEqual(db.calls.getActivity, 0);
    assert.strictEqual(db.calls.findProvenance, 0);
  });

  await test("E — hash différent avec activité préchargée : chemin complet toujours correct", async () => {
    const db = new MemoryStore();
    await ingest(db, [sourceDescriptor("oa", [item("oa")])]);
    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", [item("oa", { admissionType: "paid" })])], day(2));
    assert.strictEqual(db.activities[0].admission_type, "paid");
    assert.strictEqual(db.calls.updateActivity, 1);
    assert.strictEqual(db.calls.upsertExternalIds, 1);
    assert.strictEqual(db.calls.getActivity, 0);
  });

  await test("F — multisource : le fast-path préchargé d'oa ne perd aucune donnée apportée par mz", async () => {
    const db = new MemoryStore();
    await ingest(db, [sourceDescriptor("oa", [item("oa", { title: "Concert commun" })]), sourceDescriptor("mz", [item("mz", { startsAt: "2026-11-01T19:03:00.000Z", description: "Vue par Mobilizon", imageUrl: "https://mz.example/affiche.jpg" })])]);
    assert.strictEqual(db.activities.length, 1);
    const descriptionAvant = db.activities[0].description;
    const imageAvant = db.activities[0].image_url;
    db.resetCalls();
    await ingest(db, [sourceDescriptor("oa", [item("oa", { title: "Concert commun" })])], day(2));
    assert.strictEqual(db.activities[0].description, descriptionAvant);
    assert.strictEqual(db.activities[0].image_url, imageAvant);
    assert.strictEqual(db.calls.getActivity, 0);
    assert.strictEqual(db.calls.getActivitiesBatch, 1);
  });

  await test("H — contrainte source_record_id : deux provenances partageant la même clé d'occurrence mais un source_record_id différent ne sont jamais confondues", async () => {
    const db = new MemoryStore();
    const source = await db.ensureSource({ key: "oa", connectorType: "openagenda_json", baseUrl: "https://oa.example/api" });
    const activityX = await db.createActivity({ title: "Activité X", starts_at: "2026-11-01T19:00:00.000Z", ends_at: null, timezone: null, lifecycle_status: "scheduled", location_type: "physical", venue_name: null, address: null, postal_code: null, city: null, country: null, latitude: null, longitude: null, online_url: null, booking_url: null, admission_type: "unknown", organizers: [], category: null, subcategory: null, tags: [], image_url: null, confidence: 0.9, field_confidence: {}, evidence: [], record_status: "active" });
    const activityY = await db.createActivity({ title: "Activité Y", starts_at: "2026-11-01T19:00:00.000Z", ends_at: null, timezone: null, lifecycle_status: "scheduled", location_type: "physical", venue_name: null, address: null, postal_code: null, city: null, country: null, latitude: null, longitude: null, online_url: null, booking_url: null, admission_type: "unknown", organizers: [], category: null, subcategory: null, tags: [], image_url: null, confidence: 0.9, field_confidence: {}, evidence: [], record_status: "active" });
    const SHARED_KEY = "cle-partagee@2026-11-01T19:00:00.000Z";
    db.provenances.push({ id: db.id("prov"), activity_id: activityX.id, source_id: source.id, source_record_id: "record-X", source_occurrence_key: SHARED_KEY, original_event_url: "https://oa.example/events/record-X", payload_hash: "hash-X", source_payload: {}, last_seen_at: day(1).toISOString(), active: true });
    db.provenances.push({ id: db.id("prov"), activity_id: activityY.id, source_id: source.id, source_record_id: "record-Y", source_occurrence_key: SHARED_KEY, original_event_url: "https://oa.example/events/record-Y", payload_hash: "hash-Y", source_payload: {}, last_seen_at: day(1).toISOString(), active: true });
    db.externalIds.push({ activity_id: activityX.id, source_id: source.id, system: "oa", value: "record-X" });
    db.externalIds.push({ activity_id: activityY.id, source_id: source.id, system: "oa", value: "record-Y" });

    const itemX = item("oa", { id: "record-X", title: "Activité X" }, { sourceRecordId: "record-X", sourceOccurrenceKey: SHARED_KEY });
    const itemY = item("oa", { id: "record-Y", title: "Activité Y" }, { sourceRecordId: "record-Y", sourceOccurrenceKey: SHARED_KEY });

    await ingest(db, [sourceDescriptor("oa", [itemX, itemY])], day(2));

    assert.strictEqual(db.activities.length, 2, "aucune fusion accidentelle entre X et Y");
    assert.strictEqual(db.provenances.find((p) => p.source_record_id === "record-X").last_seen_at, day(2).toISOString());
    assert.strictEqual(db.provenances.find((p) => p.source_record_id === "record-Y").last_seen_at, day(2).toISOString());
    assert.strictEqual(db.activities.find((x) => x.id === activityX.id).title, "Activité X", "X ne doit jamais recevoir le contenu de Y");
    assert.strictEqual(db.activities.find((x) => x.id === activityY.id).title, "Activité Y", "Y ne doit jamais recevoir le contenu de X");
  });

  // --- G — chunking : vérifié au niveau du store réel (createSupabaseSortirStore), pas de la
  // Map applicative, avec un faux client Supabase qui compte les appels .from(...) émis. ---
  class FakeSupabaseClient {
    constructor(tables) { this.tables = tables; this.calls = []; }
    from(table) {
      const callRecord = { table, inSize: null };
      this.calls.push(callRecord);
      const state = { filters: [] };
      const builder = {
        eq(col, val) { state.filters.push({ type: "eq", col, val }); return builder; },
        in(col, arr) { state.filters.push({ type: "in", col, arr }); callRecord.inSize = arr.length; return builder; },
        select() { return builder; }
      };
      builder.then = (resolve, reject) => {
        try { resolve({ data: this.tables[table].filter((row) => state.filters.every((f) => f.type === "eq" ? row[f.col] === f.val : f.arr.includes(row[f.col]))), error: null }); }
        catch (error) { reject(error); }
      };
      return builder;
    }
  }

  await test("G — chunking getActivitiesBatch : plus de clés que PRELOAD_CHUNK_SIZE (UUID courts), aucune activité perdue", async () => {
    const total = PRELOAD_CHUNK_SIZE * 2 + 137; // force 3 chunks
    const activityRows = Array.from({ length: total }, (_, i) => ({ id: `act-${i}`, title: `Activité ${i}` }));
    const client = new FakeSupabaseClient({ sortir_activities: activityRows });
    const store = createSupabaseSortirStore(client);
    const foundActivities = await store.getActivitiesBatch(activityRows.map((a) => a.id));
    assert.strictEqual(foundActivities.length, total, "aucune activité perdue pendant le chunking");
    const expectedChunks = Math.ceil(total / PRELOAD_CHUNK_SIZE);
    assert.strictEqual(client.calls.filter((c) => c.table === "sortir_activities").length, expectedChunks);
    assert(client.calls.every((c) => c.inSize <= PRELOAD_CHUNK_SIZE), "aucune requête ne doit dépasser PRELOAD_CHUNK_SIZE ids");
  });

  function realisticOpenAgendaKey(i) {
    // Format réel produit par connectors/openagenda-json.js (buildOccurrenceKey) :
    // openagenda:{uid}:{begin ISO complet} — ~70-85 caractères, pas un UUID court.
    const uid = 80000000 + i;
    const begin = new Date(Date.parse("2026-11-01T19:00:00.000Z") + i * 3_600_000).toISOString();
    return `openagenda:${uid}:${begin}`;
  }

  await test("I — chunking findProvenancesBatch avec 206 VRAIES clés longues OpenAgenda : 3 requêtes (100/100/6), aucune perte, aucune requête > 100 clés", async () => {
    const keys = Array.from({ length: 206 }, (_, i) => realisticOpenAgendaKey(i));
    assert(keys[0].length >= 40, "les clés de test doivent être réalistes (format openagenda:<uid>:<ISO complet>), pas des UUID courts");
    const provenanceRows = keys.map((key, i) => ({ id: `prov-${i}`, source_id: "src-1", source_record_id: `rec-${i}`, source_occurrence_key: key }));
    const client = new FakeSupabaseClient({ sortir_provenances: provenanceRows });
    const store = createSupabaseSortirStore(client);

    const found = await store.findProvenancesBatch("src-1", keys);
    assert.strictEqual(found.length, 206, "les 206 provenances doivent toutes être retrouvées");
    assert.deepStrictEqual(new Set(found.map((p) => p.source_occurrence_key)).size, 206, "aucune clé perdue ni confondue");
    assert.strictEqual(client.calls.length, 3, "206 clés à 100/chunk doivent produire exactement 3 requêtes (100 + 100 + 6)");
    assert.deepStrictEqual(client.calls.map((c) => c.inSize), [100, 100, 6], "répartition exacte attendue des tailles de chunk");
    assert(client.calls.every((c) => c.inSize <= OCCURRENCE_KEY_CHUNK_SIZE), "aucune requête de préchargement ne doit contenir plus de 100 occurrence keys");
  });

  await test("chunking findProvenancesBatch avec > 500 clés longues : plusieurs chunks de 100, aucune perte", async () => {
    const total = 537;
    const keys = Array.from({ length: total }, (_, i) => realisticOpenAgendaKey(i));
    const provenanceRows = keys.map((key, i) => ({ id: `prov-${i}`, source_id: "src-1", source_record_id: `rec-${i}`, source_occurrence_key: key }));
    const client = new FakeSupabaseClient({ sortir_provenances: provenanceRows });
    const store = createSupabaseSortirStore(client);
    const found = await store.findProvenancesBatch("src-1", keys);
    assert.strictEqual(found.length, total, "aucune provenance perdue au-delà de 5 chunks");
    const expectedChunks = Math.ceil(total / OCCURRENCE_KEY_CHUNK_SIZE);
    assert.strictEqual(client.calls.length, expectedChunks);
    assert(client.calls.every((c) => c.inSize <= OCCURRENCE_KEY_CHUNK_SIZE));
  });

  console.log("\nMesure — SELECT Supabase pour une réingestion de N occurrences connues, actives, inchangées (1 seule source) :");
  console.log("(findProvenancesBatch chunke à 100 — clés textuelles longues ; getActivitiesBatch chunke à 500 — UUID courts)");
  for (const n of [206, 1000, 10000]) {
    const keyChunks = Math.ceil(n / OCCURRENCE_KEY_CHUNK_SIZE);
    const idChunks = Math.ceil(n / PRELOAD_CHUNK_SIZE);
    console.log(`  N=${String(n).padStart(6, " ")} → avant : ${2 * n} SELECT individuels (findProvenance+getActivity) → après : ${keyChunks + idChunks} SELECT groupés (provenances: ${keyChunks} chunk(s) de ${OCCURRENCE_KEY_CHUNK_SIZE}, activités: ${idChunks} chunk(s) de ${PRELOAD_CHUNK_SIZE})`);
  }
  // Le total d'appels TOUT compris (écritures incluses) est désormais mesuré dans
  // test-known-provenance-batched-writes.js, une fois les écritures du cas A elles-mêmes
  // groupées — cette mesure-ci ne portait que sur les lectures et reste correcte telle quelle.

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
