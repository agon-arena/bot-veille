"use strict";

const assert = require("assert");
const { VALIDATION_STATUSES } = require("./activity-schema");
const {
  inferTimezoneFromPoi,
  combineDateAndTime,
  canonicalPoiUrl,
  mapDescription,
  mapOrganizers,
  buildDatatourismeOccurrenceKey,
  mapDatatourismeOccurrence,
  convertDatatourismeEvent,
  convertDatatourismeEvents,
  stripApiKeyFromUrl,
  fetchDatatourismeEvents,
  monolingualText,
  firstOfArrayOrString,
  REQUIRED_FIELDS,
  isRelevantForMnoria,
  DATATOURISME_ALLOW_TYPES,
  DATATOURISME_DENY_TYPES,
  stripHtml
} = require("./connectors/datatourisme");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error.message}`); }
}

const BASE_OPTIONS = { sourceName: "DATAtourisme — La Réunion", sourceUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent", fetchedAt: "2026-10-19T10:00:00.000Z" };

// Fixtures construites à partir de PAYLOADS RÉELS récupérés sur l'API DATAtourisme le
// 19/10/2026 (département 35, requête fields=uuid,uri,label,type,isLocatedAt,hasDescription,
// hasContact,hasTheme,hasMainRepresentation,takesPlaceAt,identifier,isObsolete) — pas du schéma
// OpenAPI simplifié, qui s'est avéré trompeur sur plusieurs champs (label/description/hasTheme
// en réalité multilingues {"@fr":...,"@en":...}, streetAddress/homepage/locator en réalité des
// tableaux). Aucun appel réseau dans ce fichier de test.
const SIMPLE_POI = {
  uuid: "c9308386-8fb9-308a-bb1e-fa9c080b7b58",
  uri: "https://data.datatourisme.fr/13/c9308386-8fb9-308a-bb1e-fa9c080b7b58",
  identifier: "EVT-974-001",
  label: { "@fr": "Fête du Volcan" },
  type: ["Event", "PointOfInterest", "EntertainmentAndEvent"],
  isObsolete: false,
  hasTheme: [{ label: { "@en": "Music", "@fr": "Musique" }, key: "Music" }, { label: { "@en": "Family", "@fr": "Famille" }, key: "Family" }],
  hasDescription: [{ description: { "@fr": "Grande fête populaire au pied du volcan." } }],
  isLocatedAt: [{
    geo: { latitude: -21.2, longitude: 55.6 },
    address: [{ streetAddress: ["Route du Volcan"], postalCode: "97418", addressLocality: "Plaine des Cafres", hasAddressCity: { label: { "@fr": "La Plaine-des-Palmistes" }, insee: "97410", isPartOfDepartment: { label: { "@fr": "La Réunion" }, insee: "974" } } }]
  }],
  hasContact: [{ legalName: "Mairie de La Plaine-des-Palmistes", homepage: ["https://example.re"] }],
  hasMainRepresentation: [{ hasRelatedResource: [{ locator: ["https://example.re/img.jpg"] }] }],
  takesPlaceAt: [{ startDate: "2026-11-20", endDate: "2026-11-20", startTime: "14:00", endTime: "22:00" }]
};

const MULTI_OCCURRENCE_POI = {
  uuid: "aaaa1111-0000-0000-0000-000000000000",
  uri: "https://data.datatourisme.fr/75/aaaa1111",
  label: { "@fr": "Marché de Noël itinérant" },
  type: ["Event", "EntertainmentAndEvent", "ChristmasMarket"],
  hasDescription: [{ shortDescription: { "@fr": "Marché saisonnier." } }],
  isLocatedAt: [{ geo: { latitude: 48.85, longitude: 2.35 }, address: [{ streetAddress: ["Place de la Mairie"], postalCode: "75001", hasAddressCity: { label: { "@fr": "Paris" } } }] }],
  takesPlaceAt: [
    { startDate: "2026-12-01", endDate: "2026-12-01", startTime: "10:00", endTime: "19:00" },
    { startDate: "2026-12-02", endDate: "2026-12-02", startTime: "10:00", endTime: "19:00" },
    { startDate: "2026-12-03", endDate: "2026-12-03", startTime: "10:00", endTime: "19:00" }
  ]
};

// Horaire récurrent (appliesOnDay) — forme réelle confirmée sur 24/500 POI réels échantillonnés
// (département non filtré, 19/10/2026), jamais vu chez OpenAgenda, propre au schéma DATAtourisme.
const RECURRING_POI = {
  uuid: "bbbb2222-0000-0000-0000-000000000000",
  uri: "https://data.datatourisme.fr/35/bbbb2222",
  label: { "@fr": "Marché hebdomadaire" },
  type: ["Event", "EntertainmentAndEvent", "Market"],
  isLocatedAt: [{ geo: { latitude: 48.1, longitude: -1.6 }, address: [{ hasAddressCity: { label: { "@fr": "Rennes" } } }] }],
  takesPlaceAt: [{ startDate: "2026-01-01", endDate: "2026-12-31", startTime: "08:00", endTime: "13:00", appliesOnDay: [{ label: { "@en": "Saturday", "@fr": "Samedi" }, key: "Saturday" }] }]
};

const simpleResults = convertDatatourismeEvent(SIMPLE_POI, BASE_OPTIONS);
const multiResults = convertDatatourismeEvent(MULTI_OCCURRENCE_POI, BASE_OPTIONS);
const recurringResults = convertDatatourismeEvent(RECURRING_POI, BASE_OPTIONS);

test("POI simple produit une activité VALID", () => {
  assert.strictEqual(simpleResults.length, 1);
  assert.strictEqual(simpleResults[0].validation.status, VALIDATION_STATUSES.VALID);
});

test("mapping complet : titre, description, localisation, thème, contact, image", () => {
  const a = simpleResults[0].activity;
  assert.strictEqual(a.title, "Fête du Volcan");
  assert.strictEqual(a.description, "Grande fête populaire au pied du volcan.");
  assert.strictEqual(a.city, "La Plaine-des-Palmistes");
  assert.strictEqual(a.postalCode, "97418");
  assert.strictEqual(a.address, "Route du Volcan");
  assert.strictEqual(a.latitude, -21.2);
  assert.strictEqual(a.longitude, 55.6);
  assert.strictEqual(a.country, "FR");
  assert.deepStrictEqual(a.sourceCategories, ["Event", "PointOfInterest", "EntertainmentAndEvent"]);
  assert.deepStrictEqual(a.sourceTags, ["Musique", "Famille"]);
  assert.strictEqual(a.organizers[0].name, "Mairie de La Plaine-des-Palmistes");
  assert.strictEqual(a.imageUrl, "https://example.re/img.jpg");
  assert.strictEqual(a.tags.length, 0, "tags[] reste réservé à la future taxonomie Mnoria");
  assert.strictEqual(a.category, null);
});

test("monolingualText : objet multilingue réel {'@fr','@en'} (bug réel rencontré, label/description/hasTheme.label)", () => {
  assert.strictEqual(monolingualText({ "@fr": "Bonjour", "@en": "Hello" }), "Bonjour", "@fr doit être préféré");
  assert.strictEqual(monolingualText({ "@en": "Hello" }), "Hello", "repli sur la première langue disponible si @fr absent");
  assert.strictEqual(monolingualText("Chaîne nue"), "Chaîne nue", "une vraie chaîne reste acceptée telle quelle");
  assert.strictEqual(monolingualText(null), null);
  assert.strictEqual(monolingualText({}), null);
});

test("firstOfArrayOrString : champ documenté chaîne mais réellement tableau (bug réel rencontré, streetAddress/homepage/locator)", () => {
  assert.strictEqual(firstOfArrayOrString(["Les Halles"]), "Les Halles");
  assert.strictEqual(firstOfArrayOrString(["3 Rue Lapins", "Maison du Terroir"]), "3 Rue Lapins", "premier élément seulement, jamais concaténé");
  assert.strictEqual(firstOfArrayOrString("Chaîne nue"), "Chaîne nue");
  assert.strictEqual(firstOfArrayOrString(null), null);
  assert.strictEqual(firstOfArrayOrString([]), null);
});

test("fetchDatatourismeEvents demande explicitement `fields` (bug réel : sans lui, takesPlaceAt est absent de la réponse par défaut)", () => {
  assert.ok(REQUIRED_FIELDS.includes("takesPlaceAt"), "takesPlaceAt doit obligatoirement faire partie des champs demandés");
});

test("géolocalisation : fuseau horaire dérivé du département (974 -> Indian/Reunion, fixe UTC+4)", () => {
  const a = simpleResults[0].activity;
  assert.strictEqual(a.timezone, "Indian/Reunion");
  assert.strictEqual(a.startsAt, "2026-11-20T10:00:00.000Z", "14h locale Réunion (UTC+4) = 10h UTC");
  assert.strictEqual(a.endsAt, "2026-11-20T18:00:00.000Z");
});

test("fuseau par défaut Europe/Paris hors DOM-TOM, DST correctement appliquée (hiver vs été)", () => {
  assert.strictEqual(inferTimezoneFromPoi({ isLocatedAt: [{ address: [{}] }] }), "Europe/Paris");
  // Hiver (UTC+1) : 14h locale = 13h UTC.
  assert.strictEqual(combineDateAndTime("2026-01-15", "14:00", "Europe/Paris"), "2026-01-15T13:00:00.000Z");
  // Été (UTC+2, DST) : 14h locale = 12h UTC.
  assert.strictEqual(combineDateAndTime("2026-07-15", "14:00", "Europe/Paris"), "2026-07-15T12:00:00.000Z");
});

test("startTime/endTime au format date-time complet (date factice) est aussi supporté", () => {
  assert.strictEqual(combineDateAndTime("2026-07-15", "1970-01-01T14:00:00", "Europe/Paris"), "2026-07-15T12:00:00.000Z");
});

test("URL canonique : uri valide retenu, sinon null (jamais fabriqué)", () => {
  assert.strictEqual(canonicalPoiUrl(SIMPLE_POI), "https://data.datatourisme.fr/13/c9308386-8fb9-308a-bb1e-fa9c080b7b58");
  assert.strictEqual(canonicalPoiUrl({ uri: "pas-une-url" }), null);
  assert.strictEqual(canonicalPoiUrl({}), null);
});

test("identité : identifiant stable de l'événement (uuid), clé d'occurrence stable et déterministe au rejeu", () => {
  const first = mapDatatourismeOccurrence(SIMPLE_POI, SIMPLE_POI.takesPlaceAt[0], BASE_OPTIONS);
  const second = mapDatatourismeOccurrence(SIMPLE_POI, SIMPLE_POI.takesPlaceAt[0], BASE_OPTIONS);
  assert.strictEqual(first.occurrenceKey, second.occurrenceKey);
  assert.strictEqual(first.occurrenceKey, buildDatatourismeOccurrenceKey(SIMPLE_POI.uuid, "2026-11-20T10:00:00.000Z"));
  assert.strictEqual(first.poiUuid, SIMPLE_POI.uuid);
});

test("externalIds distinguent identité du POI et identité de l'occurrence", () => {
  const a = simpleResults[0].activity;
  const poiId = a.externalIds.find((e) => e.system === "datatourisme-poi");
  const occId = a.externalIds.find((e) => e.system === "datatourisme-occurrence");
  assert.strictEqual(poiId.value, SIMPLE_POI.uuid);
  assert.notStrictEqual(occId.value, poiId.value);
  assert.ok(occId.value.startsWith(`datatourisme:${SIMPLE_POI.uuid}:`));
  assert.strictEqual(a.externalIds.find((e) => e.system === "datatourisme-producer-id").value, "EVT-974-001");
});

test("événement avec plusieurs occurrences (takesPlaceAt multiple) produit une activité par période", () => {
  assert.strictEqual(multiResults.length, 3);
  assert.strictEqual(multiResults.every((r) => r.validation.status === VALIDATION_STATUSES.VALID), true);
  const starts = multiResults.map((r) => r.activity.startsAt);
  assert.deepStrictEqual(starts, ["2026-12-01T09:00:00.000Z", "2026-12-02T09:00:00.000Z", "2026-12-03T09:00:00.000Z"]);
  const keys = new Set(multiResults.map((r) => r.activity.externalIds.find((e) => e.system === "datatourisme-occurrence").value));
  assert.strictEqual(keys.size, 3, "chaque occurrence doit avoir une clé distincte");
});

test("horaire récurrent (appliesOnDay) : une seule occurrence représentative, jamais d'expansion fabriquée, confiance réduite signalée", () => {
  assert.strictEqual(recurringResults.length, 1);
  const a = recurringResults[0].activity;
  assert.strictEqual(a.fieldConfidence.startsAt, 0.5);
  assert.ok(a.evidence.some((e) => e.field === "startsAt"));
  assert.strictEqual(a.startsAt, "2026-01-01T07:00:00.000Z"); // 08h Europe/Paris hiver = 07h UTC
});

test("champs optionnels absents (contact/image/description/thème) ne font pas échouer la conversion", () => {
  const minimal = { uuid: "cccc3333", uri: "https://data.datatourisme.fr/x/cccc3333", label: "Minimal", isLocatedAt: [{ address: [{ hasAddressCity: { label: "Ville" } }] }], takesPlaceAt: [{ startDate: "2026-05-01", startTime: "10:00" }] };
  const result = convertDatatourismeEvent(minimal, BASE_OPTIONS);
  assert.strictEqual(result[0].validation.status, VALIDATION_STATUSES.VALID);
  assert.strictEqual(result[0].activity.description, null);
  assert.strictEqual(result[0].activity.imageUrl, null);
  assert.deepStrictEqual(result[0].activity.organizers, []);
  assert.deepStrictEqual(result[0].activity.sourceTags, []);
});

test("description : préfère l'audience générale (grand public) à une description ciblée", () => {
  assert.strictEqual(mapDescription({ hasDescription: [{ description: "Pour les écoles.", isDedicatedTo: [{ label: "Scolaires" }] }, { description: "Pour tous." }] }), "Pour tous.");
});

test("organizers : legalName préféré, givenName+familyName en repli, rien si absent", () => {
  assert.deepStrictEqual(mapOrganizers({ hasContact: [{ legalName: "Office de tourisme" }] }), [{ name: "Office de tourisme", url: null }]);
  assert.deepStrictEqual(mapOrganizers({ hasContact: [{ givenName: "Jean", familyName: "Dupont" }] }), [{ name: "Jean Dupont", url: null }]);
  assert.deepStrictEqual(mapOrganizers({ hasContact: [{}] }), []);
  assert.deepStrictEqual(mapOrganizers({}), []);
});

test("POI sans takesPlaceAt devient une erreur isolée, pas un crash", () => {
  const result = convertDatatourismeEvent({ uuid: "x", label: "Sans date" }, BASE_OPTIONS);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].activity, null);
  assert.ok(result[0].error);
});

test("période incomplète (sans startDate) isolée sans bloquer les autres périodes", () => {
  const poi = { ...MULTI_OCCURRENCE_POI, takesPlaceAt: [{ endTime: "19:00" }, MULTI_OCCURRENCE_POI.takesPlaceAt[0]] };
  const result = convertDatatourismeEvent(poi, BASE_OPTIONS);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].activity, null);
  assert.ok(result[0].error);
  assert.ok(result[1].activity.startsAt);
});

test("données incomplètes/invalides (titre absent) donnent INVALID, jamais un crash", () => {
  const poi = { uuid: "ddd", isLocatedAt: [{ address: [{ hasAddressCity: { label: "Ville" } }] }], takesPlaceAt: [{ startDate: "2026-05-01", startTime: "10:00" }] };
  const result = convertDatatourismeEvent(poi, BASE_OPTIONS);
  assert.strictEqual(result[0].validation.status, VALIDATION_STATUSES.INVALID);
});

test("garde-fou : un POI à de nombreuses périodes réelles est tronqué, pas explosé intégralement", () => {
  const manyPeriods = Array.from({ length: 150 }, (_, i) => ({ startDate: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, startTime: "10:00", endTime: "12:00" }));
  const poi = { ...SIMPLE_POI, takesPlaceAt: manyPeriods };
  const result = convertDatatourismeEvent(poi, { ...BASE_OPTIONS, maxOccurrencesPerEvent: 10 });
  assert.strictEqual(result.length, 10);
  assert.ok(result[9].validation.warnings.some((w) => w.code === "occurrences_truncated"));
});

test("plusieurs conversions de POIs se concatènent correctement", () => {
  const all = convertDatatourismeEvents([SIMPLE_POI, MULTI_OCCURRENCE_POI], BASE_OPTIONS);
  assert.strictEqual(all.length, 1 + 3);
});

test("absence de secret : stripApiKeyFromUrl retire systématiquement api_key, même si l'API l'y réintègre (meta.next)", () => {
  const stripped = stripApiKeyFromUrl("https://api.datatourisme.fr/v1/entertainmentAndEvent?api_key=SECRET-DO-NOT-LEAK&page=2");
  assert.strictEqual(stripped.toString().includes("SECRET-DO-NOT-LEAK"), false);
  assert.strictEqual(stripped.searchParams.get("page"), "2");
});

// --- Filtrage par taxonomie DATAtourisme (isRelevantForMnoria) : version conservatrice validée
// par simulation réelle le 21/10/2026 (voir commentaire dans connectors/datatourisme.js). ---
test("filtrage taxonomie : ALLOW seul -> conservé", () => {
  assert.strictEqual(isRelevantForMnoria({ sourceCategories: ["Event", "EntertainmentAndEvent", "Concert"] }), true);
});
test("filtrage taxonomie : DENY seul -> exclu", () => {
  assert.strictEqual(isRelevantForMnoria({ sourceCategories: ["Event", "EntertainmentAndEvent", "Market"] }), false);
});
test("filtrage taxonomie : ALLOW + DENY -> conservé (ALLOW gagne toujours, cas réels « Ça capte ! »/« La villa en perspective(s) » tagués FairOrShow+SaleEvent+culturel)", () => {
  assert.strictEqual(isRelevantForMnoria({ sourceCategories: ["Event", "FairOrShow", "SaleEvent", "ExhibitionEvent"] }), true);
});
test("filtrage taxonomie : MIXED (ni ALLOW ni DENY) -> conservé par prudence", () => {
  assert.strictEqual(isRelevantForMnoria({ sourceCategories: ["Event", "EntertainmentAndEvent", "SportsEvent", "SocialEvent"] }), true);
});
test("filtrage taxonomie : plusieurs types DENY -> exclu", () => {
  assert.strictEqual(isRelevantForMnoria({ sourceCategories: ["Event", "Market", "SaleEvent", "GarageSale", "BricABrac"] }), false);
});
test("filtrage taxonomie : absence de sourceCategories ou type inattendu -> conservé par prudence", () => {
  assert.strictEqual(isRelevantForMnoria({ sourceCategories: [] }), true);
  assert.strictEqual(isRelevantForMnoria({ sourceCategories: ["UnknownFutureType"] }), true);
  assert.strictEqual(isRelevantForMnoria({}), true);
  assert.strictEqual(isRelevantForMnoria(null), true);
});
test("filtrage taxonomie : SaleEvent/FairOrShow/Game explicitement absents du DENY (retirés après simulation réelle, faux négatifs démontrés sur « Ça capte ! »/« La villa en perspective(s) »/« Atelier d'écriture créative »)", () => {
  for (const removed of ["SaleEvent", "FairOrShow", "Game"]) assert.strictEqual(DATATOURISME_DENY_TYPES.includes(removed), false, removed);
  assert.deepStrictEqual([...DATATOURISME_DENY_TYPES].sort(), ["BricABrac", "GarageSale", "Market", "SportsCompetition"]);
});

// --- Nettoyage HTML des descriptions DATAtourisme (stripHtml) ---
test("stripHtml : balises de bloc retirées, paragraphes séparés par un saut de ligne (jamais collés)", () => {
  assert.strictEqual(stripHtml("<p>Premier paragraphe.</p><p>Second paragraphe.</p>"), "Premier paragraphe.\nSecond paragraphe.");
});
test("stripHtml : <br> devient un saut de ligne", () => {
  assert.strictEqual(stripHtml("Ligne un<br>Ligne deux"), "Ligne un\nLigne deux");
});
test("stripHtml : balises inline retirées sans laisser de trace ni coller les mots", () => {
  assert.strictEqual(stripHtml("Un <strong>mot important</strong> et un <em>autre</em>."), "Un mot important et un autre.");
});
test("stripHtml : entités HTML usuelles décodées (numériques et nommées)", () => {
  assert.strictEqual(stripHtml("Chef-d&#39;&#339;uvre"), "Chef-d'œuvre");
  assert.strictEqual(stripHtml("Tom &amp; Jerry"), "Tom & Jerry");
  assert.strictEqual(stripHtml("Dit &quot;bonjour&quot;"), "Dit \"bonjour\"");
  assert.strictEqual(stripHtml("a&nbsp;b"), "a b");
});
test("stripHtml : jamais interprété ni exécuté -- une balise <script> est retirée comme du texte inerte", () => {
  assert.strictEqual(stripHtml("Avant<script>alert(1)</script>Après"), "Avantalert(1)Après");
});
test("stripHtml : texte déjà propre jamais modifié", () => {
  const clean = "Un texte parfaitement normal, sans rien à nettoyer.";
  assert.strictEqual(stripHtml(clean), clean);
});
test("stripHtml : valeur null/undefined renvoyée telle quelle, jamais fabriquée", () => {
  assert.strictEqual(stripHtml(null), null);
  assert.strictEqual(stripHtml(undefined), undefined);
});
test("stripHtml : sauts de ligne superflus réduits sans fusionner deux paragraphes distincts", () => {
  assert.strictEqual(stripHtml("<p>A</p>\n\n\n<p>B</p>"), "A\n\nB");
});
test("mapDescription : nettoie réellement un payload DATAtourisme réel avec balises HTML (cas observé en production, dept 46)", () => {
  const poi = { ...SIMPLE_POI, hasDescription: [{ description: { "@fr": "<p>Platée, chef-d'œuvre de Jean-Philippe Rameau, mêle humour, danse et opéra baroque.</p>" } }] };
  const description = mapDescription(poi);
  assert.strictEqual(description.includes("<p>"), false);
  assert.strictEqual(description, "Platée, chef-d'œuvre de Jean-Philippe Rameau, mêle humour, danse et opéra baroque.");
});

// --- Tests réseau mockés (pagination + erreurs + garde-fous), aucun appel réel ---
const originalFetch = global.fetch;
function mockFetchSequence(responses) {
  let call = 0;
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: response.status >= 200 && response.status < 300, status: response.status, text: async () => JSON.stringify(response.body) };
  };
  return requestedUrls;
}

function poiStub(n) { return { uuid: `poi-${n}`, uri: `https://data.datatourisme.fr/x/poi-${n}`, label: `Événement ${n}`, isLocatedAt: [{ address: [{ hasAddressCity: { label: "Ville" } }] }], takesPlaceAt: [{ startDate: "2026-06-01", startTime: "10:00" }] }; }

async function run() {
  await (async () => {
    mockFetchSequence([{ status: 200, body: { objects: [poiStub(1), poiStub(2), poiStub(3)], meta: { total: 3, next: null } } }]);
    const result = await fetchDatatourismeEvents({ apiKey: "test-key", maxEvents: 10 });
    test("une seule page : tout récupéré en un appel", () => {
      assert.strictEqual(result.fetchedCount, 3);
      assert.strictEqual(result.pagesFetched, 1);
      assert.strictEqual(result.results.length, 3);
      assert.strictEqual(result.nextPageUrl, null, "pas de page suivante : nextPageUrl doit être null");
      assert.strictEqual(result.exhausted, true);
      assert.strictEqual(result.truncated, false);
    });
  })();

  await (async () => {
    // Filtrage appliqué de bout en bout DANS fetchDatatourismeEvents, avant tout retour à
    // l'appelant : un POI DENY ne doit jamais apparaître dans `results`, mais `fetchedCount`
    // (basé sur les POI bruts de l'API, jamais sur `results`) ne doit PAS changer -- la
    // pagination/le budget restent inchangés par ce filtre éditorial.
    const allowPoi = { ...poiStub(1), type: ["Event", "EntertainmentAndEvent", "Concert"] };
    const denyPoi = { ...poiStub(2), type: ["Event", "EntertainmentAndEvent", "Market"] };
    const mixedPoi = { ...poiStub(3), type: ["Event", "EntertainmentAndEvent", "SocialEvent"] };
    mockFetchSequence([{ status: 200, body: { objects: [allowPoi, denyPoi, mixedPoi], meta: { total: 3, next: null } } }]);
    const result = await fetchDatatourismeEvents({ apiKey: "test-key", maxEvents: 10 });
    test("filtrage de bout en bout : un POI DENY ne produit aucune activité dans `results`, fetchedCount inchangé", () => {
      assert.strictEqual(result.fetchedCount, 3, "fetchedCount reste basé sur les POI bruts, jamais sur le résultat filtré");
      assert.strictEqual(result.results.length, 2, "seuls le POI ALLOW et le POI MIXED restent");
      const titles = result.results.map((r) => r.activity && r.activity.title);
      assert.ok(titles.includes("Événement 1"));
      assert.ok(titles.includes("Événement 3"));
      assert.ok(!titles.includes("Événement 2"), "le POI Market (DENY) ne doit jamais apparaître");
    });
  })();

  await (async () => {
    // Chunk borné : page_size=2, maxEvents=2 -> s'arrête après EXACTEMENT 1 page, sans la couper.
    mockFetchSequence([{ status: 200, body: { objects: [poiStub(1), poiStub(2)], meta: { total: 10, next: "https://api.datatourisme.fr/v1/entertainmentAndEvent?api_key=SECRET&page=2" } } }]);
    const chunk1 = await fetchDatatourismeEvents({ apiKey: "test-key", pageSize: 2, maxEvents: 2 });
    test("pagination bornée (chunk) : nextPageUrl renvoyé, jamais tronqué au milieu d'une page, jamais la clé dans l'URL de reprise", () => {
      assert.strictEqual(chunk1.fetchedCount, 2, "page entière conservée, rien perdu à la frontière du chunk");
      assert.strictEqual(chunk1.exhausted, false);
      assert.ok(chunk1.nextPageUrl);
      assert.ok(!chunk1.nextPageUrl.includes("SECRET"), "l'URL de reprise ne doit jamais contenir la clé");
    });

    // Reprise EXACTE à partir du curseur renvoyé par le chunk précédent (resumeUrl) : doit
    // continuer sans reconstruire de filtres, et sans jamais redemander les 2 premiers POI.
    const requestedUrls2 = mockFetchSequence([{ status: 200, body: { objects: [poiStub(3), poiStub(4)], meta: { total: 10, next: null } } }]);
    const chunk2 = await fetchDatatourismeEvents({ apiKey: "test-key", resumeUrl: chunk1.nextPageUrl, maxEvents: 2 });
    test("reprise via resumeUrl : continue exactement où le chunk précédent s'est arrêté, aucune duplication cumulée", () => {
      assert.strictEqual(chunk2.fetchedCount, 2);
      assert.strictEqual(chunk2.exhausted, true);
      const allUuids = [...chunk1.results, ...chunk2.results].map((r) => r.activity.externalIds.find((e) => e.system === "datatourisme-poi").value);
      assert.strictEqual(new Set(allUuids).size, 4, "les 4 POI des 2 chunks successifs sont tous distincts, aucun revu ni sauté");
      assert.strictEqual(requestedUrls2[0], chunk1.nextPageUrl, "la requête de reprise doit utiliser EXACTEMENT l'URL de reprise fournie");
    });
  })();

  await (async () => {
    mockFetchSequence([
      { status: 200, body: { objects: [poiStub(1), poiStub(2)], meta: { total: 5, next: "https://api.datatourisme.fr/v1/entertainmentAndEvent?api_key=SECRET&page=2" } } },
      { status: 200, body: { objects: [poiStub(3), poiStub(4)], meta: { total: 5, next: "https://api.datatourisme.fr/v1/entertainmentAndEvent?api_key=SECRET&page=3" } } },
      { status: 200, body: { objects: [poiStub(5)], meta: { total: 5, next: null } } }
    ]);
    const result = await fetchDatatourismeEvents({ apiKey: "test-key", pageSize: 2, maxEvents: 10 });
    test("plusieurs pages : suit meta.next jusqu'à épuisement, aucune duplication entre pages", () => {
      assert.strictEqual(result.fetchedCount, 5);
      assert.strictEqual(result.pagesFetched, 3);
      const uuids = result.results.map((r) => r.poiUuid || (r.activity && r.activity.externalIds.find((e) => e.system === "datatourisme-poi").value));
      assert.strictEqual(new Set(uuids).size, 5, "aucune occurrence dupliquée entre pages");
    });
  })();

  await (async () => {
    const requestedUrls = mockFetchSequence([
      { status: 200, body: { objects: [poiStub(1)], meta: { total: 2, next: "https://api.datatourisme.fr/v1/entertainmentAndEvent?api_key=SECRET-LEAK-TEST&page=2" } } },
      { status: 200, body: { objects: [poiStub(2)], meta: { total: 2, next: null } } }
    ]);
    await fetchDatatourismeEvents({ apiKey: "SECRET-LEAK-TEST", maxEvents: 10 });
    test("absence de secret dans les requêtes effectuées : jamais api_key dans l'URL réellement appelée (toujours X-API-Key)", () => {
      assert.ok(requestedUrls.every((u) => !u.includes("SECRET-LEAK-TEST")), "la clé ne doit jamais apparaître dans l'URL appelée, même si meta.next l'y réintègre");
    });
    test("la requête réelle inclut bien `fields` avec takesPlaceAt (régression du bug réel)", () => {
      assert.ok(requestedUrls[0].includes("fields=") && requestedUrls[0].includes("takesPlaceAt"), "la 1ère requête doit demander explicitement takesPlaceAt");
    });
  })();

  await (async () => {
    mockFetchSequence([{ status: 200, body: { objects: [poiStub(1), poiStub(2), poiStub(3)], meta: { total: 100, next: "https://api.datatourisme.fr/v1/entertainmentAndEvent?page=2" } } }]);
    const result = await fetchDatatourismeEvents({ apiKey: "test-key", pageSize: 3, maxEvents: 3 });
    test("maxEvents borne la collecte même si l'API indique plus de résultats disponibles", () => {
      assert.strictEqual(result.fetchedCount, 3);
      assert.strictEqual(result.truncated, true);
    });
  })();

  await (async () => {
    mockFetchSequence([{ status: 200, body: { objects: [], meta: { total: 0, next: null } } }]);
    const result = await fetchDatatourismeEvents({ apiKey: "test-key", maxEvents: 10 });
    test("réponse vide : aucun résultat, aucune erreur", () => {
      assert.strictEqual(result.fetchedCount, 0);
      assert.deepStrictEqual(result.results, []);
    });
  })();

  await (async () => {
    mockFetchSequence([{ status: 401, body: { message: "Invalid API key" } }]);
    let threw = false;
    let message = "";
    try { await fetchDatatourismeEvents({ apiKey: "bad-key", maxEvents: 5 }); }
    catch (error) { threw = true; message = error.message; }
    test("erreur API (ex. clé invalide) rejette proprement sans crasher le process, et sans jamais exposer la clé dans le message", () => {
      assert.strictEqual(threw, true);
      assert.ok(!message.includes("bad-key"));
    });
  })();

  await (async () => {
    mockFetchSequence([{ status: 200, body: { total: 1 } }]); // objects absent
    let threw = false;
    try { await fetchDatatourismeEvents({ apiKey: "test-key", maxEvents: 5 }); }
    catch (_) { threw = true; }
    test("réponse invalide (objects absent) rejette proprement", () => assert.strictEqual(threw, true));
  })();

  await (async () => {
    global.fetch = async () => { throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); };
    let threw = false;
    try { await fetchDatatourismeEvents({ apiKey: "test-key", maxEvents: 5, timeoutMs: 1 }); }
    catch (_) { threw = true; }
    test("timeout réseau rejette proprement (AbortController, même mécanisme que les autres connecteurs)", () => assert.strictEqual(threw, true));
  })();

  await (async () => {
    // `next` ne progresse jamais : le garde-fou MAX_PAGES_SAFETY doit arrêter la boucle.
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ objects: [poiStub(1)], meta: { total: 999999, next: "https://api.datatourisme.fr/v1/entertainmentAndEvent?page=2" } }) });
    let threw = false;
    try { await fetchDatatourismeEvents({ apiKey: "test-key", maxEvents: 999999 }); }
    catch (_) { threw = true; }
    test("garde-fou anti boucle infinie : une pagination qui ne progresse jamais s'arrête explicitement", () => assert.strictEqual(threw, true));
  })();

  global.fetch = originalFetch;

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed > 0) process.exitCode = 1;
}

run();
