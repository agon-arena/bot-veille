"use strict";

const { UNSPECIFIED_START } = require("../datatourisme-occurrence-identity");

const { Temporal } = require("@js-temporal/polyfill");

const { normalizeActivity, validateNormalizedActivity } = require("../activity-validation");

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PAGE_SIZE = 50;
// Documenté (api.datatourisme.fr/v1/docs, changelog 2026-07-15) : page_size était plafonné à
// 250, réduit à 100 depuis cette date — toute requête demandant plus reçoit une erreur 400.
const MAX_PAGE_SIZE = 100;
// Sélection des périodes d'un POI (audit du 21/10/2026, stratégie F) : takesPlaceAt n'est PAS
// trié par l'API (0 POI trié sur 935 dépassant 20 périodes, jusqu'à 3 868 périodes jusqu'en
// 2100). On ne garde que les occurrences encore visibles dans Explorer, triées
// chronologiquement, dans une fenêtre glissante de 90 jours, plafonnées à 30 par POI ; à défaut,
// la seule prochaine occurrence future. Les ingestions suivantes font avancer la fenêtre.
const DEFAULT_MAX_OCCURRENCES_PER_EVENT = 30;
const DEFAULT_OCCURRENCE_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// CRITIQUE (bug réel rencontré le 19/10/2026) : la sélection de champs par défaut de l'API
// EXCLUT takesPlaceAt (vérifié sur la doc officielle ET en conditions réelles : sans ce
// paramètre, takesPlaceAt est systématiquement absent, donc CHAQUE POI échoue avec "sans
// période exploitable", quel que soit le département). `fields` REMPLACE entièrement la
// sélection par défaut (comportement documenté) : la liste ci-dessous doit donc inclure tout ce
// que ce connecteur lit réellement, pas seulement takesPlaceAt.
const REQUIRED_FIELDS = "uuid,uri,label,type,isLocatedAt,hasDescription,hasContact,hasTheme,hasMainRepresentation,takesPlaceAt,identifier,isObsolete";
// Filet de sécurité absolu contre toute boucle de pagination infinie (ex. si l'API renvoyait
// un `next` qui ne progresse jamais) — indépendant de maxEvents, qui borne déjà le volume
// collecté mais pas nécessairement le nombre d'itérations si pageSize était mal configuré.
const MAX_PAGES_SAFETY = 2000;

// IANA zone.tab : https://data.iana.org/time-zones/tzdb/zone.tab
// 987 est multi-fuseaux : résolution par commune ci-dessous, jamais Tahiti par défaut.
const DEPARTMENT_TIMEZONES = {
  971: "America/Guadeloupe",
  972: "America/Martinique",
  973: "America/Cayenne",
  974: "Indian/Reunion",
  975: "America/Miquelon",
  976: "Indian/Mayotte",
  977: "America/St_Barthelemy",
  978: "America/Marigot",
  986: "Pacific/Wallis",
  988: "Pacific/Noumea"
};
// Codes COG INSEE (pas codes postaux), six communes des Marquises et Gambier.
// https://www.insee.fr/fr/information/7929495
const POLYNESIA_TIMEZONES = {
  98718: "Pacific/Marquesas", 98723: "Pacific/Marquesas", 98731: "Pacific/Marquesas",
  98746: "Pacific/Marquesas", 98756: "Pacific/Marquesas", 98757: "Pacific/Marquesas",
  98719: "Pacific/Gambier"
};
const DEFAULT_TIMEZONE = "Europe/Paris";

function text(value) { const v = value === null || value === undefined ? "" : String(value).trim(); return v || null; }

function firstNonEmpty(...values) { for (const v of values) { const t = text(v); if (t) return t; } return null; }

// Certains champs DATAtourisme (streetAddress, hasContact[].homepage,
// hasMainRepresentation[].hasRelatedResource[].locator) sont documentés comme "string" mais
// renvoyés en RÉALITÉ comme un tableau de chaînes par l'API (vérifié sur de vrais POI le
// 19/10/2026, ex. "streetAddress": ["Les Halles"]) — jamais fabriqué, on prend juste le premier
// élément s'il y en a plusieurs (rare) sans les concaténer.
function firstOfArrayOrString(value) {
  if (Array.isArray(value)) return text(value[0]);
  return text(value);
}

// label/hasDescription[].description/.shortDescription/hasAddressCity.label/hasTheme[].label
// sont documentés "string" mais renvoyés en RÉALITÉ comme un objet multilingue
// {"@fr": "...", "@en": "..."} (vérifié sur de vrais POI le 19/10/2026) — @fr préféré, sinon la
// première langue disponible, jamais une chaîne fabriquée si l'objet est vide. legalName/
// givenName/familyName restent de VRAIES chaînes (vérifié séparément), donc jamais passés ici.
function monolingualText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return text(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const candidate = value["@fr"] || Object.values(value).find(Boolean);
    return text(candidate);
  }
  return null;
}

// Extrait uniquement AAAA-MM-JJ, quelle que soit la forme exacte renvoyée par l'API pour un
// champ typé "date-time" mais décrit comme une simple date (startDate/endDate).
function extractDatePart(value) {
  const match = text(value)?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}
// Extrait HH:MM, que la valeur soit une heure nue ("14:00") ou un date-time complet avec une
// date factice ("1970-01-01T14:00:00+02:00") — la doc décrit startTime/endTime comme "hh:mm"
// tout en les typant date-time, donc les deux formes sont possibles en pratique.
function extractTimePart(value) {
  const v = text(value);
  if (!v) return null;
  const isoMatch = v.match(/T(\d{2}):(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}:${isoMatch[2]}`;
  const bareMatch = v.match(/^(\d{2}):(\d{2})/);
  return bareMatch ? `${bareMatch[1]}:${bareMatch[2]}` : null;
}

// Combine une date (AAAA-MM-JJ) et une heure (HH:MM) dans le fuseau donné pour produire un
// instant ISO UTC correct, DST compris (ex. Europe/Paris change d'écart selon la saison ;
// Indian/Reunion reste fixe toute l'année, cf. getReunionTimeHHMM dans server.js).
function combineDateAndTime(dateValue, timeValue, timezone, fallbackTime) {
  const datePart = extractDatePart(dateValue);
  if (!datePart) return null;
  const timePart = extractTimePart(timeValue) || fallbackTime || "00:00";
  // Temporal résout l'offset à l'heure civile demandée, sans dépendre de la date
  // d'exécution. Une heure inexistante OU ambiguë est signalée, jamais déplacée.
  return Temporal.PlainDateTime.from(`${datePart}T${timePart}:00`, { overflow: "reject" })
    .toZonedDateTime(timezone, { disambiguation: "reject" })
    .toInstant().toString({ fractionalSecondDigits: 3 });
}

function inferTimezoneFromPoi(poi, period = {}) {
  const location = poi?.isLocatedAt?.[0];
  for (const value of [period.timezone, period.timeZone, poi?.timezone, poi?.timeZone, location?.timezone, location?.timeZone]) {
    if (typeof value !== "string" || !value.trim()) continue;
    try { new Intl.DateTimeFormat("fr-FR", { timeZone: value.trim() }); return value.trim(); } catch (_) { /* pas un fuseau fiable */ }
  }
  const city = location?.address?.[0]?.hasAddressCity;
  const commune = text(city?.insee);
  const insee = text(city?.isPartOfDepartment?.insee) || commune?.slice(0, 3);
  if (!insee) return DEFAULT_TIMEZONE;
  const deptCode = Number(insee.slice(0, 3));
  if (deptCode === 987) {
    if (!/^987\d{2}$/.test(commune || "")) throw new Error("Fuseau 987 indéterminé : commune INSEE ou timezone explicite nécessaire");
    if (Number(commune.slice(3)) < 11 || Number(commune.slice(3)) > 58) throw new Error("Commune 987 inconnue : fuseau non déterminé");
    return POLYNESIA_TIMEZONES[commune] || "Pacific/Tahiti";
  }
  return DEPARTMENT_TIMEZONES[deptCode] || DEFAULT_TIMEZONE;
}

// uri est un identifiant RDF dérérençable (pas garanti être une page lisible pour un humain,
// contrairement à canonicalUrl côté OpenAgenda) : utilisé seulement s'il s'agit réellement
// d'une URL http(s) valide, jamais fabriqué si absent ou invalide.
function canonicalPoiUrl(poi) {
  const uri = text(poi?.uri);
  if (!uri) return null;
  try { const u = new URL(uri); return (u.protocol === "http:" || u.protocol === "https:") ? uri : null; } catch (_) { return null; }
}

function mapLocation(poi) {
  const location = Array.isArray(poi?.isLocatedAt) ? poi.isLocatedAt[0] : null;
  const address = Array.isArray(location?.address) ? location.address[0] : null;
  const geo = location?.geo;
  // DATAtourisme est une plateforme exclusivement France (métropole + DOM-TOM) : pas de champ
  // code pays ISO dans le schéma (seul isPartOfCountry.label existe, un NOM, pas un code) —
  // "FR" en dur ici est la même convention que le connecteur Paris, pas une donnée fabriquée.
  return {
    address: firstOfArrayOrString(address?.streetAddress),
    postalCode: text(address?.postalCode),
    city: monolingualText(address?.hasAddressCity?.label) || text(address?.addressLocality),
    country: "FR",
    latitude: typeof geo?.latitude === "number" ? geo.latitude : null,
    longitude: typeof geo?.longitude === "number" ? geo.longitude : null,
    multipleLocations: Array.isArray(poi?.isLocatedAt) && poi.isLocatedAt.length > 1
  };
}

// hasDescription contient par endroits du HTML brut saisi par le producteur de données en amont
// (vérifié sur de vrais POI : balises <p>/<strong>, entités &#39;/&amp;...) — jamais interprété
// ni exécuté ici (aucun parseur DOM, seulement des remplacements de texte) : les balises de bloc
// (paragraphe, saut de ligne, liste, titre) deviennent un saut de ligne pour ne jamais coller
// deux phrases ensemble, toute autre balise est simplement retirée, puis les entités HTML
// usuelles sont décodées et les espaces superflus réduits.
const HTML_BLOCK_BREAK_RE = /<\/(p|div|li|h[1-6]|tr)\s*>|<br\s*\/?>/gi;
const HTML_ANY_TAG_RE = /<[^>]*>/g;
const HTML_HAS_MARKUP_RE = /<[a-zA-Z/][^>]*>|&[a-zA-Z#][a-zA-Z0-9]*;/;
const HTML_NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };
function decodeHtmlEntities(value) {
  return value
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name) => HTML_NAMED_ENTITIES[name])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}
function stripHtml(value) {
  if (typeof value !== "string" || !value) return value;
  if (!HTML_HAS_MARKUP_RE.test(value)) return value; // rien à nettoyer : ne jamais toucher un texte déjà propre.
  const withBreaks = value.replace(HTML_BLOCK_BREAK_RE, "\n");
  const withoutTags = withBreaks.replace(HTML_ANY_TAG_RE, "");
  const decoded = decodeHtmlEntities(withoutTags);
  return decoded.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// hasDescription est une liste de descriptions potentiellement dédiées à des audiences
// différentes (voir isDedicatedTo dans le schéma) : on prend la première SANS audience
// restreinte (destinée au grand public selon la doc), sinon la première disponible — jamais de
// fusion/concaténation qui fabriquerait un texte qui n'existe pas tel quel dans la source.
function mapDescription(poi) {
  const descriptions = Array.isArray(poi?.hasDescription) ? poi.hasDescription : [];
  const generalAudience = descriptions.find((d) => !Array.isArray(d?.isDedicatedTo) || d.isDedicatedTo.length === 0);
  const chosen = generalAudience || descriptions[0];
  return stripHtml(monolingualText(chosen?.description) || monolingualText(chosen?.shortDescription));
}

// Aucun champ "organisateur" dédié dans le schéma POI DATAtourisme (vérifié : pas de
// hasOrganizer) — hasContact (le contact général) est le candidat le plus proche. legalName
// est préféré ; à défaut, givenName+familyName (personne physique), jamais fabriqué si les deux
// sont absents.
function mapOrganizers(poi) {
  const contacts = Array.isArray(poi?.hasContact) ? poi.hasContact : [];
  return contacts.map((contact) => {
    // givenName/familyName peuvent eux aussi être renvoyés en tableau par l'API (vérifié :
    // mêmes conventions que streetAddress), jamais garanti être une chaîne nue.
    const given = firstOfArrayOrString(contact?.givenName);
    const family = firstOfArrayOrString(contact?.familyName);
    const name = firstNonEmpty(contact?.legalName, [given, family].filter(Boolean).join(" ") || null);
    const url = firstOfArrayOrString(contact?.homepage);
    return name || url ? { name, url } : null;
  }).filter(Boolean);
}

function mapImage(poi) {
  const representation = Array.isArray(poi?.hasMainRepresentation) ? poi.hasMainRepresentation[0] : null;
  const resource = Array.isArray(representation?.hasRelatedResource) ? representation.hasRelatedResource[0] : null;
  return firstOfArrayOrString(resource?.locator);
}

// Identité minimale : UUID + début UTC + fin UTC (ou fin inconnue explicite).
// Deux arguments restent disponibles pour retrouver l'identité historique.
function buildDatatourismeOccurrenceKey(uuid, startsAtIso, endsAtIso) {
  const legacy = `datatourisme:${uuid}:${startsAtIso}`;
  return arguments.length < 3 ? legacy : `${legacy}:end=${endsAtIso || "unknown"}`;
}

function mapDatatourismeOccurrence(poi, period, options = {}) {
  const sourceName = options.sourceName || "DATAtourisme";
  const sourceUrl = options.sourceUrl || null;
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const timezone = inferTimezoneFromPoi(poi, period);
  const startsAt = combineDateAndTime(period?.startDate, period?.startTime, timezone, "00:00");
  // Ni endDate ni endTime fournis : endsAt reste null (une heure de fin à "00:00" du jour de
  // début serait ANTÉRIEURE à startsAt dès que startTime est après minuit — bug réel rencontré
  // et corrigé en test). endDate présente mais sans endTime : on suppose fin de journée (23:59),
  // interprétation raisonnable d'une date de fin sans heure, jamais une heure arbitraire avant
  // le début.
  const hasEndInfo = Boolean(period?.endDate) || Boolean(period?.endTime);
  const endsAt = hasEndInfo ? combineDateAndTime(period?.endDate || period?.startDate, period?.endTime, timezone, "23:59") : null;
  const occurrenceKey = startsAt ? buildDatatourismeOccurrenceKey(poi?.uuid, startsAt, endsAt) : null;
  const location = mapLocation(poi);
  const originalEventUrl = canonicalPoiUrl(poi);
  // type est documenté "string" mais renvoyé en RÉALITÉ comme un tableau de valeurs de
  // thésaurus (ex. ["Event","PointOfInterest","EntertainmentAndEvent"], parfois des sous-types
  // plus précis comme "ScreeningEvent"/"SportsCompetition") — toutes conservées brutes, sans
  // tenter de choisir "la bonne", conformément à la consigne de ne pas construire de filtre
  // éditorial à cette étape.
  const sourceCategories = Array.isArray(poi?.type) ? poi.type.filter((t) => typeof t === "string") : (text(poi?.type) ? [poi.type] : []);
  const sourceTags = (Array.isArray(poi?.hasTheme) ? poi.hasTheme : []).map((t) => monolingualText(t?.label)).filter(Boolean);

  // takesPlaceAt peut décrire un HORAIRE RÉCURRENT (appliesOnDay/weekOfMonth renseignés) plutôt
  // qu'une occurrence précise et unique — contrairement aux timings[] OpenAgenda, qui sont
  // toujours des instances discrètes. On ne tente JAMAIS d'expliciter la récurrence en plusieurs
  // dates (ce serait fabriquer des occurrences non fournies telles quelles par la source) : on
  // produit une seule NormalizedActivity portant la période donnée telle quelle, avec une
  // confiance réduite et une preuve explicite sur startsAt/endsAt pour signaler le cas.
  const isRecurring = (Array.isArray(period?.appliesOnDay) && period.appliesOnDay.length > 0) || (Array.isArray(period?.weekOfMonth) && period.weekOfMonth.length > 0);
  const evidence = [];
  if (!period?.startTime) evidence.push({ field: "startsAt", excerpt: UNSPECIFIED_START });
  const fieldConfidence = {};
  if (isRecurring) {
    fieldConfidence.startsAt = 0.5; fieldConfidence.endsAt = 0.5;
    evidence.push({ field: "startsAt", sourceValue: JSON.stringify(period), excerpt: "Période récurrente (appliesOnDay/weekOfMonth) : une seule occurrence représentative produite, pas d'expansion de la récurrence." });
  }
  if (location.multipleLocations) { fieldConfidence.venueName = 0.5; evidence.push({ field: "venueName", sourceValue: JSON.stringify(poi.isLocatedAt), excerpt: "Plusieurs localisations pour ce POI : seule la première est retenue." }); }

  const activity = {
    title: monolingualText(poi?.label),
    description: mapDescription(poi),
    startsAt,
    endsAt,
    timezone,
    lifecycleStatus: poi?.isObsolete === true ? "cancelled" : "scheduled",
    locationType: "physical",
    venueName: null, // Aucun champ "nom du lieu" distinct du POI lui-même dans le schéma événement DATAtourisme — jamais fabriqué depuis l'adresse.
    address: location.address,
    postalCode: location.postalCode,
    city: location.city,
    country: location.country,
    latitude: location.latitude,
    longitude: location.longitude,
    onlineUrl: null, // DATAtourisme ne documente aucun champ d'accès en ligne pour les événements.
    organizers: mapOrganizers(poi),
    category: null, // Réservé à la future taxonomie Mnoria, comme les autres connecteurs.
    subcategory: null,
    tags: [],
    sourceCategories,
    sourceTags,
    provenances: [{
      sourceType: "api",
      sourceName,
      sourceUrl,
      originalEventUrl,
      externalId: occurrenceKey,
      fetchedAt
    }],
    externalIds: [
      ...(poi?.uuid ? [{ system: "datatourisme-poi", value: String(poi.uuid) }] : []),
      ...(occurrenceKey ? [{ system: "datatourisme-occurrence", value: occurrenceKey }] : []),
      ...(poi?.identifier ? [{ system: "datatourisme-producer-id", value: String(poi.identifier) }] : [])
    ],
    imageUrl: mapImage(poi),
    bookingUrl: null, // Aucun champ URL de réservation dans le schéma (vérifié : seuls des rôles de contact "booking" existent, pas une URL dédiée).
    admissionType: "unknown", // Aucun champ tarifaire fiable et univoque pour en déduire free/paid/mixed sans heuristique non vérifiée.
    confidence: 0.85,
    fieldConfidence,
    evidence
  };

  return { poiUuid: poi?.uuid, occurrenceKey, activity };
}

// Une période → un item du connecteur (activité validée ou erreur isolée), sans sélection.
// index = position dans takesPlaceAt brut, jamais dans la sélection.
function convertDatatourismePeriod(poi, period, index, options) {
  try {
    const { activity, occurrenceKey } = mapDatatourismeOccurrence(poi, period, options);
    const validation = validateNormalizedActivity(activity);
    const legacyId = buildDatatourismeOccurrenceKey(poi.uuid, validation.activity.startsAt);
    return {
      index, activity: validation.activity, validation, error: null,
      // Garder source_record_id historique préserve également le rapprochement des refus.
      sourceRecordId: legacyId, sourceOccurrenceKey: occurrenceKey,
      legacySourceOccurrenceKey: `${legacyId}@${validation.activity.startsAt}`,
      sourcePayload: {
        version: "datatourisme-period-v2", poiUuid: poi.uuid, poiUri: poi.uri || null,
        producerIdentifier: poi.identifier || null,
        timezoneContext: {
          poi: poi.timezone || poi.timeZone || null,
          location: poi.isLocatedAt?.[0]?.timezone || poi.isLocatedAt?.[0]?.timeZone || null,
          communeInsee: poi.isLocatedAt?.[0]?.address?.[0]?.hasAddressCity?.insee || null,
          departmentInsee: poi.isLocatedAt?.[0]?.address?.[0]?.hasAddressCity?.isPartOfDepartment?.insee || null
        },
        // Un seul fragment, sans descriptions/images/autres périodes du POI.
        period: JSON.parse(JSON.stringify(period)),
        normalized: { startsAt: validation.activity.startsAt, endsAt: validation.activity.endsAt, timezone: validation.activity.timezone },
        occurrenceKey
      }
    };
  } catch (error) {
    return { index, activity: null, validation: null, error: error.message };
  }
}

// Compteurs de sélection, en périodes BRUTES de takesPlaceAt. Invariant vérifié par les tests :
// periodsTotal = past + outOfWindow + duplicates + invalid + cappedDropped + occurrencesProduced.
// Portés par la valeur de retour (jamais par un warning, que la persistance recalcule).
function emptyOccurrenceSelectionStats() {
  return {
    poisConverted: 0, periodsTotal: 0, pastPeriodsSkipped: 0, outOfWindowPeriodsSkipped: 0,
    duplicatePeriodsRemoved: 0, invalidPeriods: 0, poisCapped: 0, cappedOccurrencesDropped: 0,
    poisWithFallback: 0, occurrencesProduced: 0
  };
}
function addOccurrenceSelectionStats(total, stats) {
  for (const key of Object.keys(total)) total[key] += stats[key] || 0;
  return total;
}

// Instant de référence déterministe : options.now, sinon l'instant de collecte (fetchedAt).
// Jamais l'ordre ni le contenu du POI.
function referenceInstantMs(options) {
  const raw = options.now !== undefined && options.now !== null ? options.now : options.fetchedAt;
  const ms = raw === undefined || raw === null ? Date.now() : raw instanceof Date ? raw.getTime() : Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error("Instant de référence DATAtourisme invalide (options.now/fetchedAt).");
  return ms;
}
function utcDateString(ms) { return new Date(ms).toISOString().slice(0, 10); }

// Préfiltre BRUT, avant toute conversion Temporal : seules les dates civiles AAAA-MM-JJ de la
// période sont lues. Les fuseaux DATAtourisme sont tous à moins d'un jour d'UTC (Tahiti −10 h,
// Nouméa +11 h, Wallis +12 h) : une marge d'un jour civil de chaque côté garantit qu'aucune
// période potentiellement visible ou dans la fenêtre n'est écartée ici. Le classement exact
// est refait sur les instants convertis. Une date illisible est laissée à la conversion, qui
// applique la sémantique existante.
function classifyRawPeriod(period, bounds) {
  const start = extractDatePart(period.startDate);
  if (!start) return "convert";
  const end = extractDatePart(period.endDate);
  const effectiveEnd = end && end > start ? end : start;
  if (effectiveEnd < bounds.pastBefore) return "past";
  if (start > bounds.windowAfter) return "beyond";
  return "convert";
}
function rawStartKey(period) {
  return `${extractDatePart(period.startDate)}T${extractTimePart(period.startTime) || "00:00"}`;
}

// Même règle que la requête Explorer : à venir, ou commencé et pas encore terminé.
function isVisibleAt(item, nowMs) {
  const start = Date.parse(item.activity.startsAt);
  const end = item.activity.endsAt ? Date.parse(item.activity.endsAt) : null;
  return start >= nowMs || (start <= nowMs && end !== null && end > nowMs);
}
// Ordre total déterministe : début, puis fin (fin inconnue en dernier), puis clé d'occurrence.
function compareOccurrences(a, b) {
  const startDiff = Date.parse(a.activity.startsAt) - Date.parse(b.activity.startsAt);
  if (startDiff) return startDiff;
  const endA = a.activity.endsAt ? Date.parse(a.activity.endsAt) : Infinity;
  const endB = b.activity.endsAt ? Date.parse(b.activity.endsAt) : Infinity;
  if (endA !== endB) return endA < endB ? -1 : 1;
  return a.sourceOccurrenceKey < b.sourceOccurrenceKey ? -1 : a.sourceOccurrenceKey > b.sourceOccurrenceKey ? 1 : 0;
}

// Explose un POI (uuid + takesPlaceAt[]) en une NormalizedActivity par occurrence retenue
// (modèle "une ligne = une occurrence", même contrat que convertOpenAgendaJsonEvent).
// Étapes : préfiltre brut → conversion Temporal → erreurs isolées → déduplication par clé
// temporelle → occurrences visibles → tri → fenêtre → plafond, sinon prochaine occurrence.
function convertDatatourismeEventWithStats(poi, options = {}) {
  const stats = emptyOccurrenceSelectionStats();
  stats.poisConverted = 1;
  const rawPeriods = Array.isArray(poi && poi.takesPlaceAt) ? poi.takesPlaceAt : [];
  const periods = require("../datatourisme-period-resolutions").resolvedDatatourismePeriods(poi?.uuid, rawPeriods);
  if (!periods.length) {
    return { results: [{ index: 0, activity: null, validation: null, error: "Événement sans période exploitable (takesPlaceAt vide ou absent)." }], stats };
  }
  stats.periodsTotal = rawPeriods.length;
  stats.duplicatePeriodsRemoved += rawPeriods.length - periods.length;
  const maxOccurrences = Number.isInteger(options.maxOccurrencesPerEvent) && options.maxOccurrencesPerEvent > 0 ? options.maxOccurrencesPerEvent : DEFAULT_MAX_OCCURRENCES_PER_EVENT;
  const windowDays = Number.isInteger(options.occurrenceWindowDays) && options.occurrenceWindowDays > 0 ? options.occurrenceWindowDays : DEFAULT_OCCURRENCE_WINDOW_DAYS;
  const nowMs = referenceInstantMs(options);
  const windowEndMs = nowMs + windowDays * DAY_MS;
  const bounds = { pastBefore: utcDateString(nowMs - DAY_MS), windowAfter: utcDateString(windowEndMs + DAY_MS) };

  const invalid = [];
  const unique = new Map();
  const convertInto = (period, index) => {
    const item = convertDatatourismePeriod(poi, period, index, options);
    // Sans instant de début exploitable, l'item reste émis tel quel (INVALID ou erreur), comme avant.
    if (!item.activity || !Number.isFinite(Date.parse(item.activity.startsAt))) { invalid.push(item); stats.invalidPeriods += 1; return; }
    if (unique.has(item.sourceOccurrenceKey)) { stats.duplicatePeriodsRemoved += 1; return; }
    unique.set(item.sourceOccurrenceKey, item);
  };

  const beyondRaw = [];
  periods.forEach((period, index) => {
    if (!period || !period.startDate) {
      invalid.push({ index, activity: null, validation: null, error: "Période sans date de début exploitable." });
      stats.invalidPeriods += 1;
      return;
    }
    const rawClass = classifyRawPeriod(period, bounds);
    if (rawClass === "past") stats.pastPeriodsSkipped += 1;
    else if (rawClass === "beyond") beyondRaw.push({ period, index, key: rawStartKey(period) });
    else convertInto(period, index);
  });

  const inWindow = [];
  const beyondWindow = [];
  const classifyConverted = (items) => {
    for (const item of items) {
      if (!isVisibleAt(item, nowMs)) stats.pastPeriodsSkipped += 1;
      else if (Date.parse(item.activity.startsAt) > windowEndMs) beyondWindow.push(item);
      else inWindow.push(item);
    }
  };
  classifyConverted([...unique.values()]);

  let selected;
  let unconvertedBeyond = beyondRaw.length;
  if (inWindow.length) {
    inWindow.sort(compareOccurrences);
    selected = inWindow.slice(0, maxOccurrences);
    stats.cappedOccurrencesDropped = inWindow.length - selected.length;
    if (stats.cappedOccurrencesDropped) {
      stats.poisCapped = 1;
      selected[selected.length - 1].validation.warnings.push({ code: "occurrences_truncated", field: "startsAt", message: `Plafond de ${maxOccurrences} occurrences atteint sur ${inWindow.length} visibles dans les ${windowDays} prochains jours.` });
    }
  } else {
    // Repli : la VRAIE prochaine occurrence future. Les périodes brutes au-delà de la fenêtre
    // sont converties seulement pour le premier jour civil (+1 jour de marge de fuseau) ; les
    // suivantes ne peuvent pas commencer plus tôt.
    if (beyondRaw.length) {
      beyondRaw.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
      const firstDate = extractDatePart(beyondRaw[0].period.startDate);
      const limitDate = utcDateString(Date.parse(`${firstDate}T00:00:00Z`) + DAY_MS);
      const group = beyondRaw.filter((entry) => extractDatePart(entry.period.startDate) <= limitDate);
      unconvertedBeyond -= group.length;
      const before = new Set(unique.keys());
      for (const entry of group) convertInto(entry.period, entry.index);
      classifyConverted([...unique.entries()].filter(([key]) => !before.has(key)).map(([, item]) => item));
    }
    beyondWindow.sort(compareOccurrences);
    selected = beyondWindow.length ? [beyondWindow[0]] : [];
    if (selected.length) stats.poisWithFallback = 1;
  }
  stats.outOfWindowPeriodsSkipped = unconvertedBeyond + beyondWindow.length - (inWindow.length ? 0 : selected.length);
  stats.occurrencesProduced = selected.length;
  invalid.sort((a, b) => a.index - b.index);
  return { results: [...invalid, ...selected], stats };
}

function convertDatatourismeEvent(poi, options = {}) {
  return convertDatatourismeEventWithStats(poi, options).results;
}

function convertDatatourismeEventsWithStats(pois, options = {}) {
  const stats = emptyOccurrenceSelectionStats();
  const results = [];
  for (const poi of Array.isArray(pois) ? pois : []) {
    const converted = convertDatatourismeEventWithStats(poi, options);
    results.push(...converted.results);
    addOccurrenceSelectionStats(stats, converted.stats);
  }
  return { results, stats };
}

function convertDatatourismeEvents(pois, options = {}) {
  return convertDatatourismeEventsWithStats(pois, options).results;
}

// Filtrage par taxonomie DATAtourisme (positionnement éditorial Mnoria : culture, intellectuel,
// citoyen, militant -- jamais un agenda touristique généraliste). Version VOLONTAIREMENT
// CONSERVATRICE, validée par une simulation réelle sur 539 activités le 21/10/2026 (lecture
// seule, aucune écriture Supabase) : ALLOW gagne toujours sur DENY (un type ALLOW présent suffit
// à conserver, même si un type DENY co-existe) -- motivé par deux cas réels observés, "Ça capte !"
// (exposition histoire des télécommunications) et "Visite guidée La villa en perspective(s)"
// (visite patrimoniale), tous deux tagués à la fois FairOrShow/SaleEvent ET un type culturel.
// SaleEvent/FairOrShow/Game ont été explicitement RETIRÉS d'un DENY plus large initialement
// envisagé : la simulation a démontré de vrais faux négatifs culturels sous ces trois types (ex.
// "Atelier d'écriture créative" tagué Game, "Ça capte !"/"La villa en perspective(s)" tagués
// FairOrShow) -- jamais forcé un filtre démenti par les données réelles. Un type absent de ces
// deux listes (MIXED) ou une taxonomie inattendue est TOUJOURS conservé : ne jamais exclure sur
// un simple silence de la taxonomie.
const DATATOURISME_ALLOW_TYPES = ["Concert", "MusicEvent", "TheaterEvent", "ExhibitionEvent", "Conference", "Reading", "ScreeningEvent", "VisualArtsEvent", "Festival", "ShowEvent"];
const DATATOURISME_DENY_TYPES = ["Market", "GarageSale", "BricABrac", "SportsCompetition"];

function isRelevantForMnoria(activity) {
  const types = Array.isArray(activity?.sourceCategories) ? activity.sourceCategories : [];
  if (DATATOURISME_ALLOW_TYPES.some((t) => types.includes(t))) return true;
  if (DATATOURISME_DENY_TYPES.some((t) => types.includes(t))) return false;
  return true;
}

// Retire api_key de l'URL si jamais présent (l'API peut l'y intégrer elle-même dans meta.next,
// voir sa documentation) : l'authentification de CE connecteur passe systématiquement par l'en-
// tête X-API-Key, jamais par la query string, pour qu'aucune URL manipulée ou loguée par ce
// code ne puisse jamais exposer la clé.
function stripApiKeyFromUrl(url) {
  const u = new URL(url);
  u.searchParams.delete("api_key");
  return u;
}

async function requestPage({ url, apiKey, timeoutMs, userAgent }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { "X-API-Key": apiKey, Accept: "application/json", "User-Agent": userAgent || "MnoriaBotSortir/1.0" }, signal: controller.signal });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { throw new Error(`Réponse DATAtourisme non-JSON (HTTP ${response.status})`); }
    if (!response.ok) throw new Error(`DATAtourisme API a répondu HTTP ${response.status}: ${(json && json.message) || text.slice(0, 200)}`);
    if (!Array.isArray(json.objects)) throw new Error("Réponse DATAtourisme invalide: objects absent");
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

// Récupère les POIs "Fêtes et Manifestations" via /entertainmentAndEvent, avec pagination par
// meta.next (méthode recommandée par la documentation officielle : garantit de ne manquer aucun
// résultat, contrairement à l'accès direct par page[] qui est borné aux 10 000 premiers
// résultats) et un plafond strict sur le nombre de POIs récupérés (jamais une collecte
// illimitée, même si l'API signale davantage de résultats disponibles).
async function fetchDatatourismeEvents(options = {}) {
  if (!options.apiKey) throw new Error("apiKey est obligatoire (clé DATATOURISME_API_KEY, jamais hardcodée)");
  const baseUrl = options.endpoint || "https://api.datatourisme.fr/v1/entertainmentAndEvent";
  const maxEvents = Number.isInteger(options.maxEvents) && options.maxEvents > 0 ? options.maxEvents : 20;
  const pageSize = Math.min(options.pageSize || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, maxEvents);
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  // Même instant pour le filtre API et la sélection des occurrences (fenêtre, passé, en cours).
  const now = options.now || new Date();

  const filters = [];
  if (options.departmentInsee) filters.push(`isLocatedAt.address.hasAddressCity.isPartOfDepartment.insee[eq]=${options.departmentInsee}`);
  if (options.filters) filters.push(options.filters);
  // Ne récupère que les événements futurs ou en cours, quand demandé (comportement par défaut :
  // voir onlyFutureOrOngoing ci-dessous) : la doc confirme le filtre [gte] sur un champ imbriqué
  // (même principe que l'exemple isPartOfDepartment.insee[in]=...).
  const onlyFutureOrOngoing = options.onlyFutureOrOngoing !== false;
  if (onlyFutureOrOngoing) {
    const today = now.toISOString().slice(0, 10);
    filters.push(`takesPlaceAt.endDate[gte]=${today}`);
  }

  // Reprise : si resumeUrl est fourni (typiquement le nextPageUrl renvoyé par un appel
  // précédent), on reprend EXACTEMENT là où le curseur s'est arrêté -- l'URL de reprise porte
  // déjà tous les filtres/fields/page_size d'origine (comportement documenté de meta.next),
  // jamais reconstruite depuis les options de CET appel. api_key en est toujours retiré avant
  // toute utilisation (voir stripApiKeyFromUrl), qu'elle vienne de l'appelant ou de l'API.
  const firstUrl = options.resumeUrl ? stripApiKeyFromUrl(options.resumeUrl) : new URL(baseUrl);
  if (!options.resumeUrl) {
    firstUrl.searchParams.set("page_size", String(pageSize));
    firstUrl.searchParams.set("lang", options.lang || "fr");
    firstUrl.searchParams.set("fields", options.fields || REQUIRED_FIELDS);
    if (filters.length) firstUrl.searchParams.set("filters", filters.join(" AND "));
    if (options.geoDistance) firstUrl.searchParams.set("geo_distance", options.geoDistance);
    if (options.geoBounding) firstUrl.searchParams.set("geo_bounding", options.geoBounding);
  }

  const collected = [];
  let nextUrl = firstUrl;
  let total = null;
  let pages = 0;
  while (nextUrl && collected.length < maxEvents) {
    pages += 1;
    if (pages > MAX_PAGES_SAFETY) throw new Error(`Garde-fou pagination: ${MAX_PAGES_SAFETY} pages dépassées sans atteindre maxEvents — arrêt pour éviter une boucle infinie.`);
    const page = await requestPage({ url: stripApiKeyFromUrl(nextUrl), apiKey: options.apiKey, timeoutMs: options.timeoutMs, userAgent: options.userAgent });
    total = page.meta && typeof page.meta.total === "number" ? page.meta.total : total;
    collected.push(...page.objects);
    nextUrl = page.meta && page.meta.next ? new URL(page.meta.next, baseUrl) : null;
  }

  // IMPORTANT (nécessaire pour une reprise sans perte) : on ne tronque JAMAIS une page déjà
  // récupérée. maxEvents borne le nombre de PAGES fetchées (on s'arrête dès que le total
  // collecté l'atteint ou le dépasse), mais on ne coupe jamais une page en deux -- un ancien
  // `.slice(0, maxEvents)` aurait silencieusement perdu les derniers éléments d'une page
  // tronquée, puisque nextPageUrl pointe déjà sur la page SUIVANTE : ces éléments n'auraient
  // plus jamais été re-récupérés par un appel de reprise ultérieur.
  const nextPageUrl = nextUrl ? stripApiKeyFromUrl(nextUrl).toString() : null;
  // Décision au niveau du POI brut : un refus reste explicite même si ses périodes
  // ont disparu ou sont invalides. Ne pas le transformer en erreur de mapping.
  const refusedPoiUuids = new Set();
  const acceptedPois = collected.filter((poi) => {
    const sourceCategories = Array.isArray(poi?.type) ? poi.type.filter((t) => typeof t === "string") : (text(poi?.type) ? [poi.type] : []);
    // Même normalisation que les activités acceptées (espaces/doublons), sans
    // dépendre de la validité d'une période pour prendre la décision éditoriale.
    if (isRelevantForMnoria(normalizeActivity({ sourceCategories }))) return true;
    if (!text(poi?.uuid)) throw new Error("POI DATAtourisme refusé sans UUID : réconciliation impossible");
    refusedPoiUuids.add(String(poi.uuid));
    return false;
  });
  const { results, stats: occurrenceStats } = convertDatatourismeEventsWithStats(acceptedPois, { ...options, now, sourceUrl: stripApiKeyFromUrl(firstUrl).toString(), fetchedAt });
  return {
    total,
    fetchedCount: collected.length,
    pagesFetched: pages,
    refusedPoiUuids: [...refusedPoiUuids],
    truncated: Boolean(nextPageUrl),
    nextPageUrl,
    exhausted: !nextPageUrl,
    occurrenceStats,
    results
  };
}

module.exports = {
  DEPARTMENT_TIMEZONES,
  POLYNESIA_TIMEZONES,
  DEFAULT_TIMEZONE,
  REQUIRED_FIELDS,
  monolingualText,
  firstOfArrayOrString,
  inferTimezoneFromPoi,
  combineDateAndTime,
  canonicalPoiUrl,
  mapLocation,
  mapDescription,
  mapOrganizers,
  mapImage,
  buildDatatourismeOccurrenceKey,
  mapDatatourismeOccurrence,
  DEFAULT_MAX_OCCURRENCES_PER_EVENT,
  DEFAULT_OCCURRENCE_WINDOW_DAYS,
  emptyOccurrenceSelectionStats,
  convertDatatourismeEvent,
  convertDatatourismeEventWithStats,
  convertDatatourismeEvents,
  convertDatatourismeEventsWithStats,
  stripApiKeyFromUrl,
  fetchDatatourismeEvents,
  stripHtml,
  DATATOURISME_ALLOW_TYPES,
  DATATOURISME_DENY_TYPES,
  isRelevantForMnoria
};
