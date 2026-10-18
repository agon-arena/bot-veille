"use strict";

const assert = require("assert");
const { DECISIONS, compareActivities, mergeActivities } = require("./activity-deduplication");
const { validateNormalizedActivity } = require("./activity-validation");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.message}`); } }
function activity(overrides = {}) {
  return {
    title: "Concert de jazz au théâtre", startsAt: "2026-10-24T18:00:00Z", endsAt: "2026-10-24T20:00:00Z",
    timezone: "Europe/Paris", lifecycleStatus: "scheduled", locationType: "physical", venueName: "Théâtre municipal",
    address: "1 rue de Paris", postalCode: "75001", city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522,
    onlineUrl: null, organizers: [{ name: "Jazz Paris", url: "https://jazz.example.org" }], category: "culture", subcategory: "concert",
    tags: ["Jazz"], provenances: [{ sourceType: "api", sourceName: "Source A", sourceUrl: "https://a.example/api/events", originalEventUrl: "https://a.example/events/42", externalId: "42", fetchedAt: "2026-10-16T10:00:00Z" }],
    externalIds: [{ system: "source-a", value: "42" }], imageUrl: null, bookingUrl: null, admissionType: "unknown", confidence: 0.9, fieldConfidence: {}, evidence: [], ...overrides
  };
}

test("identifiant partagé dans une source compatible donne MATCH", () => {
  assert.strictEqual(compareActivities(activity(), activity({ title: "Concert jazz au théâtre" })).decision, DECISIONS.MATCH);
});
test("URL d'origine canonique identique donne MATCH", () => {
  const b = activity({ externalIds: [], provenances: [{ sourceType: "api", sourceName: "Autre", sourceUrl: "https://b.example/api", originalEventUrl: "https://a.example/events/42?utm_source=x#top", fetchedAt: "2026-10-16T11:00:00Z" }] });
  assert.strictEqual(compareActivities(activity({ externalIds: [] }), b).decision, DECISIONS.MATCH);
});
test("correspondance composite forte donne MATCH", () => {
  const b = activity({ externalIds: [{ system: "mobilizon", value: "xyz" }], provenances: [{ sourceType: "api", sourceName: "Mobilizon", sourceUrl: "https://m.example/api", originalEventUrl: "https://m.example/e/xyz", fetchedAt: "2026-10-16T11:00:00Z" }], startsAt: "2026-10-24T18:04:00Z", latitude: 48.8567, longitude: 2.3522 });
  assert.strictEqual(compareActivities(activity(), b).decision, DECISIONS.MATCH);
});
test("même titre à des dates différentes reste DISTINCT", () => {
  const b = activity({ startsAt: "2026-10-25T18:00:00Z", endsAt: "2026-10-25T20:00:00Z", externalIds: [{ system: "source-a", value: "43" }], provenances: [{ sourceType: "api", sourceName: "Source A", sourceUrl: "https://a.example/api/events", originalEventUrl: "https://a.example/events/43", externalId: "43", fetchedAt: "2026-10-16T10:00:00Z" }] });
  assert.strictEqual(compareActivities(activity(), b).decision, DECISIONS.DISTINCT);
});
test("même identifiant mais occurrences différentes impose REVIEW", () => {
  assert.strictEqual(compareActivities(activity(), activity({ startsAt: "2026-10-25T18:00:00Z", endsAt: "2026-10-25T20:00:00Z" })).decision, DECISIONS.REVIEW);
});
test("homonymes dans une ville sans lieu commun ne sont pas fusionnés", () => {
  const b = activity({ venueName: "Autre salle", address: "50 avenue de Lyon", latitude: null, longitude: null, externalIds: [], provenances: [{ sourceType: "api", sourceName: "B", sourceUrl: "https://b.example/api", originalEventUrl: "https://b.example/9", fetchedAt: "2026-10-16T11:00:00Z" }] });
  assert.strictEqual(compareActivities(activity({ externalIds: [] }), b).decision, DECISIONS.REVIEW);
});
test("UID iCalendar identiques de flux indépendants ne donnent pas MATCH", () => {
  const a = activity({ externalIds: [{ system: "ical", value: "uid-1" }] });
  const b = activity({ title: "Salon du livre", address: "8 rue B", latitude: 48.87, longitude: 2.38, organizers: [{ name: "Livres France" }], externalIds: [{ system: "ical", value: "uid-1" }], provenances: [{ sourceType: "ical", sourceName: "Flux B", sourceUrl: "https://b.example/calendar.ics", originalEventUrl: "https://b.example/event", fetchedAt: "2026-10-16T11:00:00Z" }] });
  const result = compareActivities(a, b); assert.strictEqual(result.decision, DECISIONS.DISTINCT); assert(result.signals.some((item) => item.type === "external_id_namespace_collision"));
});
test("lieux proches mais événements différents restent DISTINCT", () => {
  const b = activity({ title: "Atelier de poterie", latitude: 48.85665, longitude: 2.35225, organizers: [{ name: "Maison des arts" }], externalIds: [], provenances: [{ sourceType: "api", sourceName: "B", sourceUrl: "https://b.example/api", originalEventUrl: "https://b.example/10", fetchedAt: "2026-10-16T11:00:00Z" }] });
  assert.strictEqual(compareActivities(activity({ externalIds: [] }), b).decision, DECISIONS.DISTINCT);
});
test("match probable retourne REVIEW avec ses signaux", () => {
  const b = activity({ venueName: "Salle voisine", address: "2 rue de Paris", latitude: null, longitude: null, externalIds: [], provenances: [{ sourceType: "api", sourceName: "B", sourceUrl: "https://b.example/api", originalEventUrl: "https://b.example/11", fetchedAt: "2026-10-16T11:00:00Z" }] });
  const result = compareActivities(activity({ externalIds: [] }), b); assert.strictEqual(result.decision, DECISIONS.REVIEW); assert(result.algorithmVersion); assert(result.signals.length);
});
test("fusion refusée hors MATCH", () => {
  const b = activity({ title: "Autre événement", externalIds: [], provenances: [{ sourceType: "api", sourceName: "B", sourceUrl: "https://b.example/api", originalEventUrl: "https://b.example/99", fetchedAt: "2026-10-16T11:00:00Z" }] });
  assert.throws(() => mergeActivities(activity(), b), /Fusion refusée/);
});
test("fusion MATCH agrège provenance, identifiants et choisit le statut prudent", () => {
  const b = activity({ lifecycleStatus: "cancelled", description: "Description beaucoup plus complète de ce concert.", admissionType: "free", bookingUrl: "https://tickets.example/42", externalIds: [{ system: "source-a", value: "42" }, { system: "mobilizon", value: "uuid" }], provenances: [{ sourceType: "api", sourceName: "Source A", sourceUrl: "https://a.example/api/events", originalEventUrl: "https://a.example/events/42", externalId: "42", fetchedAt: "2026-10-17T10:00:00Z" }], confidence: 0.95 });
  const merged = mergeActivities(activity(), b); assert.strictEqual(merged.activity.lifecycleStatus, "cancelled"); assert.strictEqual(merged.activity.admissionType, "free"); assert.strictEqual(merged.activity.bookingUrl, "https://tickets.example/42"); assert.strictEqual(merged.activity.externalIds.length, 2); assert.strictEqual(merged.decision, DECISIONS.MATCH); assert.notStrictEqual(validateNormalizedActivity(merged.activity).status, "INVALID");
});

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`); if (failed) process.exitCode = 1;
