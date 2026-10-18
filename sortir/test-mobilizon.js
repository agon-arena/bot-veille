"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { VALIDATION_STATUSES } = require("./activity-schema");
const { validateNormalizedActivity } = require("./activity-validation");
const { htmlToText, parseMobilizonGeom, mapMobilizonLifecycleStatus, mapMobilizonEvent, convertMobilizonEvents } = require("./connectors/mobilizon");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "mobilizon-events.json"), "utf8"));
const events = fixture.data.searchEvents.elements;
const options = { endpoint: "https://mobilizon.picasoft.net/api", sourceName: "Mobilizon Picasoft", fetchedAt: "2026-10-16T15:30:00Z" };
const results = convertMobilizonEvents(events, options);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error.message}`); }
}

test("fixture JSON représentative traitée hors ligne", () => assert.strictEqual(results.length, 6));

test("événement physique réel avec repli sur description d'adresse", () => {
  const { activity, validation } = results[0];
  assert.strictEqual(validation.status, VALIDATION_STATUSES.VALID);
  assert.strictEqual(activity.locationType, "physical");
  assert.strictEqual(activity.venueName, "Le P’tit Sas");
  assert.strictEqual(activity.postalCode, "76600");
  assert.strictEqual(activity.city, "Le Havre");
  assert.strictEqual(activity.longitude, 2.49);
  assert.strictEqual(activity.latitude, 49.49);
  assert.deepStrictEqual(activity.organizers, [{ name: "Agend'Havre", url: "https://mobilizon.fr/@agendhavre" }]);
  assert.strictEqual(activity.category, "meeting");
  assert.deepStrictEqual(activity.tags, ["Jeux"]);
});

test("description HTML convertie en texte sans IA", () => {
  assert.strictEqual(htmlToText("<p>Bonjour&nbsp;<strong>ici</strong></p><p>Suite</p>"), "Bonjour ici\nSuite");
  assert.strictEqual(results[0].activity.description, "Je vous propose un peu de détente en jouant !");
});

test("événement uniquement en ligne", () => {
  const { activity, validation } = results[1];
  assert.strictEqual(activity.locationType, "online");
  assert.strictEqual(activity.onlineUrl, "https://video.example.org/room");
  assert.strictEqual(activity.endsAt, null);
  assert.strictEqual(validation.status, VALIDATION_STATUSES.VALID);
});

test("événement hybride", () => {
  const { activity, validation } = results[2];
  assert.strictEqual(activity.locationType, "hybrid");
  assert.strictEqual(activity.address, "10 rue Victor Hugo");
  assert.strictEqual(activity.city, "Lyon");
  assert.strictEqual(validation.status, VALIDATION_STATUSES.VALID);
});

test("date avec décalage et timezone conservés", () => {
  assert.strictEqual(results[1].activity.startsAt, "2026-11-01T09:00:00+01:00");
  assert.strictEqual(results[1].activity.timezone, "Europe/Paris");
  assert.strictEqual(results[1].validation.activity.startsAt, "2026-11-01T08:00:00.000Z");
});

test("statuts Mobilizon mappés vers le cycle de vie", () => {
  assert.strictEqual(mapMobilizonLifecycleStatus("CONFIRMED").lifecycleStatus, "scheduled");
  assert.strictEqual(mapMobilizonLifecycleStatus("TENTATIVE").lifecycleStatus, "tentative");
  assert.strictEqual(mapMobilizonLifecycleStatus("CANCELLED").lifecycleStatus, "cancelled");
  assert.strictEqual(mapMobilizonLifecycleStatus("POSTPONED").lifecycleStatus, "postponed");
  assert.strictEqual(mapMobilizonLifecycleStatus(null).lifecycleStatus, "scheduled");
});

test("statut Mobilizon brut conservé comme preuve", () => {
  assert.strictEqual(results[0].activity.lifecycleStatus, "scheduled");
  assert(results[0].activity.evidence.some((entry) => entry.field === "lifecycleStatus" && entry.sourceValue === "CONFIRMED"));
});

test("statut Mobilizon inconnu impose une revue", () => {
  const activity = mapMobilizonEvent({ ...events[0], status: "UNKNOWN" }, options);
  assert.strictEqual(activity.lifecycleStatus, "scheduled");
  assert.strictEqual(validateNormalizedActivity(activity).status, VALIDATION_STATUSES.NEEDS_REVIEW);
});

test("événement sans date devient INVALID", () => {
  assert.strictEqual(results[3].validation.status, VALIDATION_STATUSES.INVALID);
  assert(results[3].validation.errors.some((entry) => entry.code === "starts_at_invalid"));
});

test("événement sans titre devient INVALID", () => {
  const activity = mapMobilizonEvent({ ...events[0], title: " " }, options);
  assert.strictEqual(validateNormalizedActivity(activity).status, VALIDATION_STATUSES.INVALID);
});

test("URL dangereuse devient INVALID", () => {
  const activity = mapMobilizonEvent({ ...events[1], onlineAddress: "javascript:alert(1)" }, options);
  assert(validateNormalizedActivity(activity).errors.some((entry) => entry.code === "online_url_required"));
});

test("identifiants et provenance Mobilizon conservés précisément", () => {
  const activity = results[0].activity;
  assert.deepStrictEqual(activity.externalIds, [
    { system: "mobilizon", value: "1da5fb64-79e7-4ae0-993f-7909b8eff9bf" },
    { system: "mobilizon-internal", value: "212744" }
  ]);
  assert.strictEqual(activity.provenances[0].sourceUrl, "https://mobilizon.picasoft.net/api");
  assert.strictEqual(activity.provenances[0].originalEventUrl, "https://mobilizon.fr/events/1da5fb64-79e7-4ae0-993f-7909b8eff9bf");
  assert.strictEqual(activity.provenances[0].externalId, activity.externalIds[0].value);
});

test("coordonnées Mobilizon longitude;latitude", () => assert.deepStrictEqual(parseMobilizonGeom("2.35;48.86"), { longitude: 2.35, latitude: 48.86 }));

test("données facultatives absentes restent nulles ou vides", () => {
  assert.strictEqual(results[2].activity.description, null);
  assert.strictEqual(results[2].activity.imageUrl, null);
  assert.deepStrictEqual(results[2].activity.tags, []);
});

test("Mobilizon sans signal commercial garde les valeurs V2 par défaut", () => {
  assert.strictEqual(results[0].activity.bookingUrl, null);
  assert.strictEqual(results[0].activity.admissionType, "unknown");
});

test("événement passé reste VALID", () => {
  const activity = mapMobilizonEvent({ ...events[0], beginsOn: "2020-01-01T10:00:00Z", endsOn: "2020-01-01T12:00:00Z" }, options);
  assert.strictEqual(validateNormalizedActivity(activity).status, VALIDATION_STATUSES.VALID);
});

test("NEEDS_REVIEW traverse le chemin du connecteur", () => {
  const activity = results[4].activity;
  activity.confidence = 0.4;
  assert.strictEqual(validateNormalizedActivity(activity).status, VALIDATION_STATUSES.NEEDS_REVIEW);
});

test("entrée malformée isolée sans bloquer la collection", () => {
  assert.strictEqual(results[5].error, null);
  assert.strictEqual(results[5].validation.status, VALIDATION_STATUSES.INVALID);
  assert.strictEqual(results[0].validation.status, VALIDATION_STATUSES.VALID);
});

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
if (failed) process.exitCode = 1;
