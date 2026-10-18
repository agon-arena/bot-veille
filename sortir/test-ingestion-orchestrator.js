"use strict";

const assert = require("assert");
const { convertOpenAgendaJsonEvent } = require("./connectors/openagenda-json");
const { convertMobilizonEvents } = require("./connectors/mobilizon");
const { convertParisEvents } = require("./connectors/paris-events");
const { ingestSortir } = require("./ingestion-orchestrator");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.message}`); } }
const fetchedAt = "2026-10-16T10:00:00Z";
// Événement OpenAgenda JSON équivalent à l'ancienne fixture ICS (même titre/horaire/lieu),
// pour conserver le même scénario de doublon inter-sources avec Mobilizon.
const jazzEvent = {
  uid: 778899,
  title: "Festival Jazz au théâtre",
  canonicalUrl: "https://openagenda.example/events/jazz",
  categorie: [],
  attendanceMode: 1,
  status: 1,
  timezone: "Europe/Paris",
  location: { name: "Théâtre municipal", address: "1 rue de Paris, 75001 Paris", city: "Paris", postalCode: "75001", countryCode: "FR", latitude: 48.8566, longitude: 2.3522 },
  timings: [{ begin: "2026-11-01T19:00:00Z", end: "2026-11-01T21:00:00Z", id: "JAZZ01" }]
};
const openAgenda = convertOpenAgendaJsonEvent(jazzEvent, { sourceName: "OpenAgenda Test", sourceUrl: "https://api.openagenda.example/v2/agendas/0/events", fetchedAt });
const mobilizon = convertMobilizonEvents([{ id: "11", uuid: "mz-jazz", url: "https://mobilizon.example/events/mz-jazz", title: "Festival Jazz au théâtre", beginsOn: "2026-11-01T19:03:00Z", endsOn: "2026-11-01T21:00:00Z", status: "CONFIRMED", category: "MUSIC", description: "<p>Le festival.</p>", physicalAddress: { description: "Théâtre municipal", street: "1 rue de Paris", locality: "Paris", postalCode: "75001", country: "FR", geom: "2.3522;48.8566", timezone: "Europe/Paris" }, organizerActor: { name: "Jazz Paris", url: "https://jazz.example.org" }, tags: [] }], { endpoint: "https://mobilizon.example/api", fetchedAt });
const paris = convertParisEvents([
  { id: "paris-homonyme", event_id: 21, url: "https://paris.example/homonyme", title: "Festival Jazz au théâtre", date_start: "2026-11-01T19:00:00Z", date_end: "2026-11-01T21:00:00Z", locations: [{ address_name: "Autre théâtre", address_street: "50 avenue de Lyon", address_zipCode: "75012", address_city: "Paris" }] },
  { id: "paris-unique", event_id: 22, url: "https://paris.example/poterie", title: "Atelier de poterie", date_start: "2026-11-02T10:00:00Z", date_end: "2026-11-02T12:00:00Z", locations: [{ address_name: "Maison des arts", address_street: "3 rue Verte", address_zipCode: "75011", address_city: "Paris" }] },
  { id: "paris-invalid", event_id: 23, url: "https://paris.example/invalide", title: "Sans date", locations: [{ address_city: "Paris" }] }
], { endpoint: "https://opendata.paris.fr/api", fetchedAt });

function run() { return ingestSortir([{ source: "OpenAgenda", results: openAgenda }, { source: "Mobilizon", results: mobilizon }, { source: "Paris Data", results: paris }, { source: "Source cassée", error: new Error("HTTP 503") }]); }

test("run multi-sources déterministe avec statistiques", () => {
  const result = run();
  // OpenAgenda JSON ne fournit aucun organisateur (confirmé sur données réelles) : le signal
  // "correspondance composite forte" (qui exige organizerScore>=0.9) ne peut plus se déclencher
  // entre OpenAgenda et Mobilizon pour ce même titre/horaire/lieu sans identifiant partagé —
  // les 3 candidats très proches (OpenAgenda, Mobilizon, Paris "homonyme") restent donc 3 paires
  // distinctes en REVIEW plutôt qu'une fusion suivie d'une seule revue. Comportement réel vérifié.
  assert.deepStrictEqual(result.stats, { collected: 5, VALID: 4, NEEDS_REVIEW: 0, INVALID: 1, merged: 0, toReview: 3, final: 1 });
  assert.strictEqual(result.finalActivities[0].title, "Atelier de poterie");
  assert.strictEqual(result.reviewQueue.length, 3);
  assert(result.reviewQueue.every((entry) => entry.type === "deduplication"));
  assert.strictEqual(result.diagnostics.sourceErrors[0].error, "HTTP 503");
});
test("doublon OpenAgenda/Mobilizon mis en revue, pas fusionné automatiquement (pas d'organisateur côté OpenAgenda JSON)", () => {
  const result = run();
  const oaVsMz = result.reviewQueue.find((entry) => entry.members.length === 2 && entry.members.some((m) => m.source === "OpenAgenda") && entry.members.some((m) => m.source === "Mobilizon"));
  assert(oaVsMz, "aucune paire OpenAgenda/Mobilizon trouvée dans la file de revue");
  assert.strictEqual(oaVsMz.candidates.length, 2);
  assert(oaVsMz.candidates.every((c) => c.title === "Festival Jazz au théâtre"));
  assert(oaVsMz.diagnostics.some((comparison) => comparison.signals.some((signal) => signal.type === "probable_composite_match")));
  assert.strictEqual(result.stats.merged, 0, "aucune fusion automatique ne doit avoir eu lieu pour cette paire");
});
test("activité invalide isolée avec diagnostic", () => {
  const result = run(); assert.strictEqual(result.invalidActivities.length, 1); assert(result.invalidActivities[0].validation.errors.some((error) => error.code === "starts_at_invalid"));
});
test("erreur d'activité connecteur isolée", () => {
  const result = ingestSortir([{ source: "A", results: [{ activity: null, error: "JSON cassé" }, ...openAgenda] }]);
  assert.strictEqual(result.stats.INVALID, 1); assert.strictEqual(result.stats.final, 1); assert.strictEqual(result.diagnostics.activityErrors.length, 1);
});
test("NEEDS_REVIEW de validation va directement dans la file", () => {
  const uncertain = { ...openAgenda[0].activity, confidence: 0.4, externalIds: [{ system: "ical", value: "uncertain" }], provenances: [{ ...openAgenda[0].activity.provenances[0], originalEventUrl: "https://openagenda.example/events/uncertain", externalId: "uncertain" }] };
  const result = ingestSortir([{ source: "OpenAgenda", results: [uncertain] }]);
  assert.strictEqual(result.stats.NEEDS_REVIEW, 1); assert.strictEqual(result.stats.toReview, 1); assert.strictEqual(result.stats.final, 0);
});
test("ordre des sources sans effet sur sorties et statistiques", () => {
  const forward = run();
  const reverse = ingestSortir([{ source: "Paris Data", results: paris }, { source: "Mobilizon", results: mobilizon }, { source: "OpenAgenda", results: openAgenda }, { source: "Source cassée", error: "HTTP 503" }]);
  assert.deepStrictEqual(reverse.stats, forward.stats); assert.deepStrictEqual(reverse.finalActivities, forward.finalActivities);
});

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`); if (failed) process.exitCode = 1;
