"use strict";

const assert = require("assert");
const { VALIDATION_STATUSES } = require("./activity-schema");
const { compareActivities } = require("./activity-deduplication");
const {
  mapAttendanceMode,
  buildOccurrenceKey,
  canonicalEventUrl,
  mapOpenAgendaJsonOccurrence,
  convertOpenAgendaJsonEvent,
  convertOpenAgendaJsonEvents,
  fetchOpenAgendaJsonEvents
} = require("./connectors/openagenda-json");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error.message}`); }
}

const BASE_OPTIONS = { now: "2025-01-01T00:00:00Z", sourceName: "Senlis — Agenda officiel de la ville", fetchedAt: "2026-10-18T10:00:00.000Z" };

// Fixtures construites à partir de la forme réelle observée via l'API v2 (champs et
// conventions vérifiés en direct le 18/10/2026), pas de réseau dans ce fichier de test.
const SIMPLE_EVENT = {
  uid: 11816083,
  slug: "conference-participative-avec-claire-tauty",
  title: "Conférence participative avec Claire Tauty",
  description: "Une conférence participative.",
  canonicalUrl: "https://openagenda.com/senlis/events/11816083_conference-participative-avec-claire-tauty",
  categorie: ["atelier", "rencontre"],
  keywords: ["sommeil", "sante"],
  extIds: null,
  attendanceMode: 1,
  status: 1,
  age: { min: null, max: null },
  accessibility: { hi: false, vi: false, pi: false, mi: false, ii: false },
  registration: [{ type: "phone", value: "06 87 03 25 64" }, { type: "link", value: "https://www.ville-senlis.fr/sism/" }],
  conditions: "Entrée libre",
  timezone: "Europe/Paris",
  location: { uid: 91626880, name: "Au Tiers Lieu Quartier Ordener", address: "6-8 rue des Jardiniers, 60300 SENLIS", city: "Senlis", postalCode: "60300", countryCode: "FR", latitude: 49.199682, longitude: 2.580176 },
  image: { filename: "abc.base.image.jpg", base: "https://img.openagenda.com/main/" },
  timings: [{ begin: "2026-10-16T19:00:00+02:00", end: "2026-10-16T21:00:00+02:00", id: "W40D7F" }]
};

const RECURRING_EVENT = {
  uid: 53560405,
  slug: "chaalis-hors-les-murs-au-musee-dart-et-darcheologie",
  title: "Chaalis hors-les-murs - au Musée d'Art et d'Archéologie",
  description: "Des œuvres du musée de Chaalis entrent en résonance avec le parcours permanent.",
  canonicalUrl: "https://openagenda.com/musees-de-senlis/events/53560405_chaalis-hors-les-murs-au-musee-dart-et-darcheologie",
  categorie: ["exposition"],
  attendanceMode: 1,
  status: 1,
  conditions: "Tarif : 7€ | Tarif réduit : 4€ | Gratuit -25 ans",
  timezone: "Europe/Paris",
  location: { uid: 12010013, name: "Musée d'Art et d'Archéologie", address: "Place Notre-Dame, 60300 SENLIS", city: "Senlis", postalCode: "60300", countryCode: "FR", latitude: 49.206495, longitude: 2.586358 },
  registration: [{ type: "email", value: "musees@ville-senlis.fr" }],
  // 3 occurrences sans `id` (comportement réel observé sur ce même événement) + 1 avec `id`.
  timings: [
    { begin: "2025-11-05T10:00:00+01:00", end: "2025-11-05T13:00:00+01:00" },
    { begin: "2025-11-05T14:00:00+01:00", end: "2025-11-05T18:00:00+01:00" },
    { begin: "2025-11-06T10:00:00+01:00", end: "2025-11-06T13:00:00+01:00" },
    { begin: "2025-11-06T14:00:00+01:00", end: "2025-11-06T18:00:00+01:00", id: "AB12CD" }
  ]
};

const simpleResults = convertOpenAgendaJsonEvent(SIMPLE_EVENT, BASE_OPTIONS);
const recurringResults = convertOpenAgendaJsonEvent(RECURRING_EVENT, BASE_OPTIONS);

test("événement simple à une occurrence produit un seul résultat VALID", () => {
  assert.strictEqual(simpleResults.length, 1);
  assert.strictEqual(simpleResults[0].validation.status, VALIDATION_STATUSES.VALID);
});

test("événement récurrent produit une activité par occurrence", () => {
  assert.strictEqual(recurringResults.length, 4);
  assert.strictEqual(recurringResults.every((r) => r.validation.status === VALIDATION_STATUSES.VALID), true);
});

test("timing sans id n'empêche pas la conversion", () => {
  const { activity } = recurringResults[0];
  assert.strictEqual(activity.externalIds.some((e) => e.system === "openagenda-timing"), false);
  assert.strictEqual(activity.externalIds.some((e) => e.system === "openagenda-event" && e.value === "53560405"), true);
});

test("timing avec id le conserve comme identifiant externe supplémentaire", () => {
  const { activity } = recurringResults[3];
  const timingId = activity.externalIds.find((e) => e.system === "openagenda-timing");
  assert.ok(timingId);
  assert.strictEqual(timingId.value, "AB12CD");
});

test("plusieurs timings produisent des startsAt distincts et corrects", () => {
  const starts = recurringResults.map((r) => r.activity.startsAt);
  assert.deepStrictEqual(starts, ["2025-11-05T09:00:00.000Z", "2025-11-05T13:00:00.000Z", "2025-11-06T09:00:00.000Z", "2025-11-06T13:00:00.000Z"]);
});

test("champs optionnels absents (accessibility/age/image/registration) ne font pas échouer la conversion", () => {
  const minimal = { uid: 1, title: "Minimal", canonicalUrl: "https://openagenda.com/events/1", attendanceMode: 1, status: 1, timezone: "Europe/Paris", location: { name: "Lieu", city: "Ville", countryCode: "FR" }, timings: [{ begin: "2026-01-01T10:00:00+01:00", end: "2026-01-01T11:00:00+01:00" }] };
  const result = convertOpenAgendaJsonEvent(minimal, BASE_OPTIONS);
  assert.strictEqual(result[0].validation.status, VALIDATION_STATUSES.VALID);
  assert.strictEqual(result[0].activity.imageUrl, null);
  assert.strictEqual(result[0].activity.bookingUrl, null);
});

test("localisation structurée mappée directement, sans heuristique regex", () => {
  const { activity } = simpleResults[0];
  assert.strictEqual(activity.venueName, "Au Tiers Lieu Quartier Ordener");
  assert.strictEqual(activity.postalCode, "60300");
  assert.strictEqual(activity.city, "Senlis");
  assert.strictEqual(activity.country, "FR");
  assert.strictEqual(activity.latitude, 49.199682);
});

test("categorie multi-valuée conservée telle quelle dans sourceCategories[], séparée de tags[]", () => {
  const { activity } = simpleResults[0];
  assert.deepStrictEqual(activity.sourceCategories, ["atelier", "rencontre"]);
  assert.strictEqual(activity.category, null, "category ne doit pas être déduit depuis categorie à ce stade");
  assert.strictEqual(activity.tags.length, 0, "tags[] reste réservé à la future taxonomie Mnoria, pas aux valeurs brutes source");
});

test("keywords conservés tels quels dans sourceTags[], jamais mélangés avec sourceCategories", () => {
  const { activity } = simpleResults[0];
  assert.deepStrictEqual(activity.sourceTags, ["sommeil", "sante"]);
  assert.ok(!activity.sourceTags.includes("atelier"));
  assert.ok(!activity.sourceCategories.includes("sommeil"));
});

test("clé d'occurrence stable et déterministe au rejeu", () => {
  const first = mapOpenAgendaJsonOccurrence(SIMPLE_EVENT, SIMPLE_EVENT.timings[0], BASE_OPTIONS);
  const second = mapOpenAgendaJsonOccurrence(SIMPLE_EVENT, SIMPLE_EVENT.timings[0], BASE_OPTIONS);
  assert.strictEqual(first.occurrenceKey, second.occurrenceKey);
  assert.strictEqual(first.occurrenceKey, buildOccurrenceKey(11816083, "2026-10-16T17:00:00.000Z"));
});

test("clé d'occurrence distingue uid événement et occurrence (ne les mélange pas)", () => {
  const { activity } = simpleResults[0];
  const eventId = activity.externalIds.find((e) => e.system === "openagenda-event");
  const occurrenceId = activity.externalIds.find((e) => e.system === "openagenda-occurrence");
  assert.strictEqual(eventId.value, "11816083");
  assert.notStrictEqual(occurrenceId.value, eventId.value);
  assert.ok(occurrenceId.value.startsWith("openagenda:11816083:"));
});

test("deux agendas relayant le même uid sont reconnus MATCH via canonicalUrl, sans modifier la dédup", () => {
  const fromSenlis = mapOpenAgendaJsonOccurrence(RECURRING_EVENT, RECURRING_EVENT.timings[0], { sourceName: "Senlis — Agenda officiel de la ville", sourceUrl: "https://api.openagenda.com/v2/agendas/56170473/events", fetchedAt: BASE_OPTIONS.fetchedAt });
  const fromMusees = mapOpenAgendaJsonOccurrence(RECURRING_EVENT, RECURRING_EVENT.timings[0], { sourceName: "Musées de Senlis", sourceUrl: "https://api.openagenda.com/v2/agendas/26110493/events", fetchedAt: BASE_OPTIONS.fetchedAt });
  const comparison = compareActivities(fromSenlis.activity, fromMusees.activity);
  assert.strictEqual(comparison.decision, "MATCH");
  assert.ok(comparison.signals.some((s) => s.type === "same_original_url"));
});

test("canonicalEventUrl retombe sur l'URL générique /events/{uid} si canonicalUrl absent", () => {
  assert.strictEqual(canonicalEventUrl({ uid: 42 }), "https://openagenda.com/events/42");
});

test("mapAttendanceMode couvre les 3 valeurs documentées", () => {
  assert.strictEqual(mapAttendanceMode(1), "physical");
  assert.strictEqual(mapAttendanceMode(2), "online");
  assert.strictEqual(mapAttendanceMode(3), "hybrid");
});

test("événement sans timings devient une erreur isolée, pas un crash", () => {
  const result = convertOpenAgendaJsonEvent({ uid: 9, title: "Sans horaire", timings: [] }, BASE_OPTIONS);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].activity, null);
  assert.ok(result[0].error);
});

test("timing incomplet (sans begin) isolé sans bloquer les autres occurrences", () => {
  const event = { ...RECURRING_EVENT, timings: [{ end: "2026-01-01T12:00:00+01:00" }, RECURRING_EVENT.timings[0]] };
  const result = convertOpenAgendaJsonEvent(event, BASE_OPTIONS);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].activity, null);
  assert.ok(result[0].error);
  assert.strictEqual(result[1].activity.startsAt, "2025-11-05T09:00:00.000Z");
});

test("garde-fou: un événement à 787 occurrences réelles est tronqué, pas explosé intégralement", () => {
  const manyTimings = Array.from({ length: 787 }, (_, i) => ({ begin: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T10:00:00+01:00`, end: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T12:00:00+01:00` }));
  const event = { ...RECURRING_EVENT, timings: manyTimings };
  const result = convertOpenAgendaJsonEvent(event, { ...BASE_OPTIONS, maxOccurrencesPerEvent: 10 });
  assert.strictEqual(result.length, 10);
  assert.ok(result[9].validation.warnings.some((w) => w.code === "occurrences_truncated"));
});

test("plusieurs conversions d'événements se concatènent correctement", () => {
  const all = convertOpenAgendaJsonEvents([SIMPLE_EVENT, RECURRING_EVENT], BASE_OPTIONS);
  assert.strictEqual(all.length, 1 + 4);
});

// --- Tests réseau mockés (pagination + erreurs), aucun appel réel ---
const originalFetch = global.fetch;
function mockFetchSequence(responses) {
  let call = 0;
  global.fetch = async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: response.status >= 200 && response.status < 300, status: response.status, text: async () => JSON.stringify(response.body) };
  };
}

async function run() {
  await (async () => {
    mockFetchSequence([
      { status: 200, body: { total: 3, events: [{ ...SIMPLE_EVENT, uid: 1 }, { ...SIMPLE_EVENT, uid: 2 }], after: "cursor-2" } },
      { status: 200, body: { total: 3, events: [{ ...SIMPLE_EVENT, uid: 3 }], after: null } }
    ]);
    const result = await fetchOpenAgendaJsonEvents({ now: BASE_OPTIONS.now, agendaUid: 1, apiKey: "test-key", pageSize: 2, maxEvents: 10 });
    test("pagination: parcourt plusieurs pages via `after` jusqu'à épuisement", () => {
      assert.strictEqual(result.fetchedCount, 3);
      assert.strictEqual(result.results.length, 3);
    });
  })();

  await (async () => {
    mockFetchSequence([{ status: 200, body: { total: 100, events: [{ ...SIMPLE_EVENT, uid: 1 }], after: "more" } }]);
    const result = await fetchOpenAgendaJsonEvents({ now: BASE_OPTIONS.now, agendaUid: 1, apiKey: "test-key", pageSize: 1, maxEvents: 1 });
    test("maxEvents borne la collecte même si l'API indique plus de résultats", () => {
      assert.strictEqual(result.fetchedCount, 1);
      assert.strictEqual(result.truncated, true);
    });
  })();

  await (async () => {
    mockFetchSequence([{ status: 403, body: { message: "could not find user or agenda matching key" } }]);
    let threw = false;
    try { await fetchOpenAgendaJsonEvents({ now: BASE_OPTIONS.now, agendaUid: 1, apiKey: "bad-key", maxEvents: 5 }); }
    catch (_) { threw = true; }
    test("erreur HTTP (ex. clé invalide) rejette proprement sans crasher le process", () => assert.strictEqual(threw, true));
  })();

  await (async () => {
    mockFetchSequence([{ status: 200, body: { total: 1 } }]); // events absent
    let threw = false;
    try { await fetchOpenAgendaJsonEvents({ now: BASE_OPTIONS.now, agendaUid: 1, apiKey: "test-key", maxEvents: 5 }); }
    catch (_) { threw = true; }
    test("réponse invalide (events absent) rejette proprement", () => assert.strictEqual(threw, true));
  })();

  global.fetch = originalFetch;

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed > 0) process.exitCode = 1;
}

run();
