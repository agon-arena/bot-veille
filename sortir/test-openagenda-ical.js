"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { VALIDATION_STATUSES } = require("./activity-schema");
const { parseIcsCalendar, parseIcsDate, mapIcalLifecycleStatus, convertOpenAgendaIcal } = require("./connectors/openagenda-ical");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "openagenda-senlis.ics"), "utf8");
const options = {
  sourceName: "Senlis — Agenda officiel de la ville",
  sourceUrl: "https://openagenda.com/agendas/56170473/events.v2.ics",
  defaultTimezone: "Europe/Paris",
  country: "FR",
  fetchedAt: "2026-10-16T15:24:47Z"
};

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error.message}`); }
}

const parsed = parseIcsCalendar(fixture);
const results = convertOpenAgendaIcal(fixture, options);

test("fixture représentative parsée hors ligne", () => assert.strictEqual(parsed.events.length, 9));
test("un résultat isolé est produit pour chaque VEVENT", () => assert.strictEqual(results.length, 9));

test("événement physique complet", () => {
  const { activity, validation } = results[0];
  assert.strictEqual(validation.status, VALIDATION_STATUSES.VALID);
  assert.strictEqual(activity.locationType, "physical");
  assert.strictEqual(activity.venueName, "Au Tiers Lieu Quartier Ordener");
  assert.strictEqual(activity.postalCode, "60300");
  assert.strictEqual(activity.city, "SENLIS");
  assert.strictEqual(activity.latitude, 49.199682);
  assert.strictEqual(activity.longitude, 2.580176);
  assert.deepStrictEqual(activity.organizers, [{ name: "Ville de Senlis", url: "https://www.ville-senlis.fr/" }]);
  assert.strictEqual(activity.externalIds[0].value, "63204225//20261016T150000Z");
  assert.strictEqual(activity.provenances[0].sourceType, "ical");
});

test("événement avec ville seule", () => {
  assert.strictEqual(results[1].activity.city, "Senlis");
  assert.strictEqual(results[1].validation.status, VALIDATION_STATUSES.VALID);
});

test("événement uniquement en ligne", () => {
  assert.strictEqual(results[2].activity.locationType, "online");
  assert.strictEqual(results[2].activity.onlineUrl, "https://video.example.org/conference");
  assert.strictEqual(results[2].validation.status, VALIDATION_STATUSES.VALID);
});

test("événement hybride", () => {
  assert.strictEqual(results[3].activity.locationType, "hybrid");
  assert.strictEqual(results[3].activity.city, "Senlis");
  assert.strictEqual(results[3].validation.status, VALIDATION_STATUSES.VALID);
});

test("date UTC avec fuseau de présentation conservé", () => {
  assert.strictEqual(results[0].activity.startsAt, "2026-10-16T15:00:00.000Z");
  assert.strictEqual(results[0].activity.timezone, "Europe/Paris");
});

test("statuts iCalendar mappés vers le cycle de vie", () => {
  assert.strictEqual(mapIcalLifecycleStatus("CONFIRMED").lifecycleStatus, "scheduled");
  assert.strictEqual(mapIcalLifecycleStatus("TENTATIVE").lifecycleStatus, "tentative");
  assert.strictEqual(mapIcalLifecycleStatus("CANCELLED").lifecycleStatus, "cancelled");
  assert.strictEqual(mapIcalLifecycleStatus("POSTPONED").lifecycleStatus, "postponed");
  assert.strictEqual(mapIcalLifecycleStatus(null).lifecycleStatus, "scheduled");
});

test("STATUS iCalendar est conservé comme preuve", () => {
  assert.strictEqual(results[0].activity.lifecycleStatus, "scheduled");
  assert(results[0].activity.evidence.some((entry) => entry.field === "lifecycleStatus" && entry.sourceValue === "CONFIRMED"));
});

test("STATUS iCalendar inconnu impose une revue", () => {
  const calendar = fixture.replace("STATUS:CONFIRMED", "STATUS:UNKNOWN");
  const result = convertOpenAgendaIcal(calendar, options)[0];
  assert.strictEqual(result.activity.lifecycleStatus, "scheduled");
  assert.strictEqual(result.validation.status, VALIDATION_STATUSES.NEEDS_REVIEW);
});

test("date locale convertie sans dépendre du fuseau du serveur", () => {
  assert.strictEqual(results[1].activity.startsAt, "2026-10-24T08:00:00.000Z");
  assert.strictEqual(results[1].activity.endsAt, "2026-10-24T10:00:00.000Z");
});

test("conversion de date locale DST déterministe", () => {
  const property = { value: "20260714T120000", params: { TZID: "Europe/Paris" } };
  assert.strictEqual(parseIcsDate(property).iso, "2026-07-14T10:00:00.000Z");
});

test("événement sans date exploitable devient INVALID", () => {
  assert.strictEqual(results[4].validation.status, VALIDATION_STATUSES.INVALID);
  assert(results[4].validation.errors.some((entry) => entry.code === "starts_at_invalid"));
});

test("événement sans titre devient INVALID", () => {
  assert.strictEqual(results[5].validation.status, VALIDATION_STATUSES.INVALID);
  assert(results[5].validation.errors.some((entry) => entry.code === "title_required"));
});

test("URL invalide isolée par la validation", () => {
  assert.strictEqual(results[6].validation.status, VALIDATION_STATUSES.INVALID);
  assert(results[6].validation.errors.some((entry) => entry.code === "url_invalid"));
});

test("données facultatives absentes restent nulles ou vides", () => {
  assert.strictEqual(results[1].activity.imageUrl, null);
  assert.deepStrictEqual(results[1].activity.organizers, []);
  assert.strictEqual(results[1].activity.endsAt !== null, true);
});

test("ICS sans signal commercial garde les valeurs V2 par défaut", () => {
  assert.strictEqual(results[0].activity.bookingUrl, null);
  assert.strictEqual(results[0].activity.admissionType, "unknown");
});

test("événement passé reste structurellement VALID", () => assert.strictEqual(results[7].validation.status, VALIDATION_STATUSES.VALID));

test("preuve utile conservée pour date et adresse", () => {
  assert(results[0].activity.evidence.some((entry) => entry.field === "startsAt"));
  assert(results[0].activity.evidence.some((entry) => entry.field === "address"));
});

test("les événements malformés n'empêchent pas les suivants", () => {
  assert.strictEqual(results[4].validation.status, VALIDATION_STATUSES.INVALID);
  assert.strictEqual(results[7].validation.status, VALIDATION_STATUSES.VALID);
});

test("NEEDS_REVIEW est transmis par le chemin connecteur", () => {
  results[8].activity.confidence = 0.4;
  const { validateNormalizedActivity } = require("./activity-validation");
  assert.strictEqual(validateNormalizedActivity(results[8].activity).status, VALIDATION_STATUSES.NEEDS_REVIEW);
});

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
if (failed) process.exitCode = 1;
