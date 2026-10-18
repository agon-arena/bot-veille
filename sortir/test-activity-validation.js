"use strict";

const assert = require("assert");
const { VALIDATION_STATUSES } = require("./activity-schema");
const { validateNormalizedActivity } = require("./activity-validation");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}: ${error.message}`);
  }
}

function baseActivity(overrides = {}) {
  return {
    title: "Concert au théâtre de Saint-Denis",
    description: "Une soirée musicale.",
    startsAt: "2026-10-24T20:00:00+04:00",
    endsAt: "2026-10-24T22:00:00+04:00",
    timezone: "Indian/Reunion",
    locationType: "physical",
    venueName: "Théâtre de Saint-Denis",
    city: "Saint-Denis",
    country: "FR",
    organizers: [{ name: "Association Musique", url: "https://example.org/association" }],
    category: "culture",
    subcategory: "concert",
    tags: ["musique"],
    provenances: [{
      sourceType: "rss",
      sourceName: "Agenda culturel",
      sourceUrl: "https://example.org/feed.xml",
      originalEventUrl: "https://example.org/events/concert",
      externalId: "concert-24",
      fetchedAt: "2026-10-16T06:00:00Z"
    }],
    confidence: 0.95,
    ...overrides
  };
}

function validate(overrides = {}) {
  return validateNormalizedActivity(baseActivity(overrides));
}

function hasCode(result, code) {
  return [...result.errors, ...result.warnings].some((entry) => entry.code === code);
}

test("concert physique valide", () => assert.strictEqual(validate().status, VALIDATION_STATUSES.VALID));

test("lifecycleStatus vaut scheduled par défaut", () => {
  const result = validate({ lifecycleStatus: undefined });
  assert.strictEqual(result.activity.lifecycleStatus, "scheduled");
  assert.strictEqual(result.status, VALIDATION_STATUSES.VALID);
});

test("les quatre lifecycleStatus autorisés sont valides", () => {
  for (const lifecycleStatus of ["scheduled", "tentative", "cancelled", "postponed"]) {
    assert.strictEqual(validate({ lifecycleStatus }).status, VALIDATION_STATUSES.VALID);
  }
});

test("lifecycleStatus inconnu rend l'activité INVALID", () => {
  const result = validate({ lifecycleStatus: "deleted" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "lifecycle_status_invalid"));
});

test("admissionType vaut unknown par défaut", () => {
  const result = validate({ admissionType: undefined });
  assert.strictEqual(result.activity.admissionType, "unknown");
  assert.strictEqual(result.status, VALIDATION_STATUSES.VALID);
});

test("les quatre admissionType autorisés sont valides", () => {
  for (const admissionType of ["free", "paid", "mixed", "unknown"]) {
    assert.strictEqual(validate({ admissionType }).status, VALIDATION_STATUSES.VALID);
  }
});

test("admissionType inconnu rend l'activité INVALID", () => {
  const result = validate({ admissionType: "donation" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "admission_type_invalid"));
});

test("bookingUrl HTTP(S) est normalisée", () => {
  const result = validate({ bookingUrl: " HTTPS://BOOKING.EXAMPLE/places#form " });
  assert.strictEqual(result.activity.bookingUrl, "https://booking.example/places");
  assert.strictEqual(result.status, VALIDATION_STATUSES.VALID);
});

test("bookingUrl dangereuse rend l'activité INVALID", () => {
  const result = validate({ bookingUrl: "javascript:alert(1)" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "url_invalid"));
});

test("conférence uniquement en ligne", () => {
  const result = validate({ locationType: "online", venueName: null, city: null, onlineUrl: "https://meet.example.org/conference" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.VALID);
});

test("événement hybride avec lieu et URL", () => {
  const result = validate({ locationType: "hybrid", onlineUrl: "https://video.example.org/live" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.VALID);
});

test("un organisateur normalisé malgré plusieurs organisateurs dans le texte", () => {
  const result = validate({
    description: "Organisé par le collectif A avec les associations B et C.",
    organizers: [{ name: "Collectif A" }]
  });
  assert.deepStrictEqual(result.activity.organizers, [{ name: "Collectif A", url: null }]);
  assert.strictEqual(result.status, VALIDATION_STATUSES.VALID);
});

test("plusieurs provenances sont conservées", () => {
  const first = baseActivity().provenances[0];
  const result = validate({ provenances: [first, { sourceType: "api", sourceName: "Mobilizon", originalEventUrl: "https://mobilizon.example/events/42", externalId: "42", fetchedAt: "2026-10-16T07:00:00Z" }] });
  assert.strictEqual(result.activity.provenances.length, 2);
  assert.strictEqual(result.status, VALIDATION_STATUSES.VALID);
});

test("image facultative", () => assert.strictEqual(validate({ imageUrl: null }).status, VALIDATION_STATUSES.VALID));
test("endsAt facultatif", () => assert.strictEqual(validate({ endsAt: null }).status, VALIDATION_STATUSES.VALID));
test("coordonnées facultatives", () => assert.strictEqual(validate({ latitude: null, longitude: null }).status, VALIDATION_STATUSES.VALID));

test("latitude invalide", () => {
  const result = validate({ latitude: 91 });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "latitude_out_of_range"));
});

test("longitude invalide", () => {
  const result = validate({ longitude: -181 });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "longitude_out_of_range"));
});

test("coordonnée non numérique refusée", () => {
  const result = validate({ latitude: "-20.88" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "coordinate_not_numeric"));
});

test("URL javascript refusée", () => {
  const result = validate({ imageUrl: "javascript:alert(1)" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "url_invalid"));
});

test("endsAt antérieur à startsAt", () => {
  const result = validate({ endsAt: "2026-10-24T19:00:00+04:00" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "ends_before_start"));
});

test("titre vide", () => {
  const result = validate({ title: "   " });
  assert.strictEqual(result.activity.title, null);
  assert(hasCode(result, "title_required"));
});

test("titre trop long", () => {
  const result = validate({ title: "x".repeat(201) });
  assert(hasCode(result, "title_too_long"));
});

test("provenance absente", () => {
  const result = validate({ provenances: [] });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "provenance_required"));
});

test("événement passé mais structurellement valide", () => {
  const result = validate({ startsAt: "2020-01-01T10:00:00Z", endsAt: "2020-01-01T12:00:00Z" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.VALID);
});

test("timezone invalide", () => {
  const result = validate({ timezone: "Mars/Olympus_Mons" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "timezone_invalid"));
});

test("tags trimés et dédupliqués sans modifier la première casse", () => {
  const result = validate({ tags: [" Musique ", "musique", "Concert", ""] });
  assert.deepStrictEqual(result.activity.tags, ["Musique", "Concert"]);
});

test("sourceCategories et sourceTags normalisés indépendamment de tags, jamais mélangés", () => {
  const result = validate({ tags: ["Musique"], sourceCategories: [" Atelier ", "atelier"], sourceTags: ["petite_enfance", ""] });
  assert.deepStrictEqual(result.activity.sourceCategories, ["Atelier"]);
  assert.deepStrictEqual(result.activity.sourceTags, ["petite_enfance"]);
  assert.deepStrictEqual(result.activity.tags, ["Musique"]);
});

test("sourceCategories et sourceTags absents retombent sur des tableaux vides", () => {
  const result = validate({});
  assert.deepStrictEqual(result.activity.sourceCategories, []);
  assert.deepStrictEqual(result.activity.sourceTags, []);
});

test("confidence supérieure à 1", () => {
  const result = validate({ confidence: 1.1 });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "confidence_out_of_range"));
});

test("activité physique insuffisamment localisée", () => {
  const result = validate({ venueName: null, address: null, city: null, postalCode: "97400", country: "FR" });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "physical_location_insufficient"));
});

test("activité en ligne sans URL", () => {
  const result = validate({ locationType: "online", venueName: null, city: null, onlineUrl: null });
  assert.strictEqual(result.status, VALIDATION_STATUSES.INVALID);
  assert(hasCode(result, "online_url_required"));
});

test("preuve associée à startsAt", () => {
  const result = validate({ evidence: [{ field: "startsAt", excerpt: "Samedi 24 octobre à 20 h", provenanceIndex: 0 }] });
  assert.strictEqual(result.status, VALIDATION_STATUSES.VALID);
  assert.strictEqual(result.activity.evidence[0].field, "startsAt");
});

test("preuve pointant vers une provenance inexistante", () => {
  const result = validate({ evidence: [{ field: "startsAt", sourceValue: "2026-10-24 20:00", provenanceIndex: 3 }] });
  assert(hasCode(result, "evidence_provenance_invalid"));
});

test("identifiants externes de plusieurs fournisseurs", () => {
  const result = validate({ externalIds: [{ system: "ical", value: "uid-123" }, { system: "openagenda", value: "oa-456" }, { system: "mobilizon", value: "mz-789" }] });
  assert.strictEqual(result.activity.externalIds.length, 3);
  assert.strictEqual(result.status, VALIDATION_STATUSES.VALID);
});

test("faible confiance globale conduit à NEEDS_REVIEW", () => {
  const result = validate({ confidence: 0.4 });
  assert.strictEqual(result.status, VALIDATION_STATUSES.NEEDS_REVIEW);
  assert(hasCode(result, "confidence_low"));
});

test("faible confiance d'un champ conduit à NEEDS_REVIEW", () => {
  const result = validate({ fieldConfidence: { startsAt: 0.55 } });
  assert.strictEqual(result.status, VALIDATION_STATUSES.NEEDS_REVIEW);
  assert(hasCode(result, "field_confidence_low"));
});

test("URL HTTP normalisée prudemment et fragment retiré", () => {
  const result = validate({ onlineUrl: null, imageUrl: " HTTPS://EXAMPLE.ORG/image.jpg#preview " });
  assert.strictEqual(result.activity.imageUrl, "https://example.org/image.jpg");
});

test("date ISO normalisée en UTC", () => {
  const result = validate();
  assert.strictEqual(result.activity.startsAt, "2026-10-24T16:00:00.000Z");
});

test("provenance sans moyen de retrouver la source", () => {
  const result = validate({ provenances: [{ sourceType: "rss", sourceName: "Flux inconnu", fetchedAt: "2026-10-16T06:00:00Z" }] });
  assert(hasCode(result, "provenance_locator_required"));
});

test("schéma URL dangereux refusé dans une provenance", () => {
  const result = validate({ provenances: [{ sourceType: "rss", sourceName: "Flux", sourceUrl: "file:///etc/passwd", fetchedAt: "2026-10-16T06:00:00Z" }] });
  assert(hasCode(result, "url_invalid"));
});

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
if (failed) process.exitCode = 1;
