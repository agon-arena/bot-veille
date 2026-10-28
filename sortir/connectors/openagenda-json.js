"use strict";

const { validateNormalizedActivity } = require("../activity-validation");

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 300;
// Les créneaux source sont la seule autorité temporelle. Aucun plafond implicite :
// iterateOpenAgendaJsonEvent et onBatch permettent de traiter les longues séries par lots.
const DEFAULT_OCCURRENCE_BATCH_SIZE = 100;

const STATUS_LABELS = {
  1: "scheduled", // Programmé
  2: "rescheduled", // Reprogrammé — pas de statut équivalent, voir mapLifecycleStatus
  3: "moved_online", // Déplacé en ligne — idem
  4: "postponed", // Reporté
  5: "sold_out", // Complet — idem
  6: "cancelled" // Annulé
};

function text(value) { const v = value === null || value === undefined ? "" : String(value).trim(); return v || null; }

// L'API renvoie des champs multilingues par défaut ({fr, en, ...}); on force `monolingual`
// à la lecture pour recevoir directement des chaînes, cohérent avec le reste du pipeline (FR).
function monolingualText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return text(value);
  if (typeof value === "object") {
    const candidate = value.fr || Object.values(value).find(Boolean);
    return text(candidate);
  }
  return null;
}

function enumId(value) { return value && typeof value === "object" ? value.id : value; }

function mapLifecycleStatus(statusCode) {
  statusCode = enumId(statusCode);
  const mapped = STATUS_LABELS[statusCode];
  switch (mapped) {
    case "scheduled": return { lifecycleStatus: "scheduled", lossy: false };
    case "postponed": return { lifecycleStatus: "postponed", lossy: false };
    case "cancelled": return { lifecycleStatus: "cancelled", lossy: false };
    // Ces trois statuts OpenAgenda n'ont pas d'équivalent dans LIFECYCLE_STATUSES actuel.
    // On choisit "scheduled" (l'événement a toujours lieu) tout en signalant la perte
    // d'information via fieldConfidence + evidence plutôt que d'inventer une valeur.
    case "rescheduled": case "moved_online": case "sold_out":
      return { lifecycleStatus: "scheduled", lossy: true };
    default:
      return { lifecycleStatus: "scheduled", lossy: statusCode !== undefined && statusCode !== null, unrecognized: true };
  }
}

function mapAttendanceMode(mode) {
  mode = enumId(mode);
  // 1=offline(physique) 2=online 3=mixed — mapping direct, documenté.
  if (mode === 2) return "online";
  if (mode === 3) return "hybrid";
  return "physical";
}

function mapLocation(location) {
  if (!location) return { venueName: null, address: null, postalCode: null, city: null, country: null, latitude: null, longitude: null };
  return {
    venueName: text(location.name),
    address: text(location.address),
    postalCode: text(location.postalCode),
    city: text(location.city) || text(location.adminLevel4),
    country: text(location.countryCode),
    latitude: typeof location.latitude === "number" ? location.latitude : null,
    longitude: typeof location.longitude === "number" ? location.longitude : null
  };
}

function mapImage(image) {
  if (!image || !image.base || !image.filename) return null;
  return `${image.base}${image.filename}`;
}

function mapBookingUrl(registration) {
  if (!Array.isArray(registration)) return null;
  const link = registration.find((item) => item && item.type === "link" && item.value);
  return link ? link.value : null;
}

const PRICE_PATTERN = /\d+(?:[.,]\d+)?\s*(?:€|eur\b)/i;
const FREE_PATTERN = /\bgratuit/i;

// Heuristique déterministe bornée au champ existant `admissionType` (free/paid/mixed/unknown) —
// ce n'est PAS un moteur de classification Explorer, juste une lecture best-effort du texte
// libre `conditions` déjà prévu par le schéma pour cet usage précis.
function inferAdmissionType(conditions) {
  const value = text(conditions);
  if (!value) return { admissionType: "unknown", confidence: null };
  const isFree = FREE_PATTERN.test(value);
  const hasPrice = PRICE_PATTERN.test(value);
  if (isFree && hasPrice) return { admissionType: "mixed", confidence: 0.6 };
  if (hasPrice) return { admissionType: "paid", confidence: 0.6 };
  if (isFree) return { admissionType: "free", confidence: 0.6 };
  return { admissionType: "unknown", confidence: null };
}

function normalizeBegin(begin) {
  const timestamp = Date.parse(begin);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

// Clé d'occurrence stable et déterministe: openagenda:{eventUid}:{begin normalisé}.
// Rejouer la même entrée JSON produit exactement la même clé (pas de dépendance à timing.id,
// qui est absent sur une partie des occurrences réelles observées, ex. Chaalis).
function buildOccurrenceKey(eventUid, beginIso) {
  return `openagenda:${eventUid}:${beginIso}`;
}

// canonicalUrl est un champ réel renvoyé par l'API (confirmé en direct, identique quelle que
// soit l'agenda interrogée pour un même événement relayé) — c'est le signal qui permet au
// MATCH inter-agendas existant (sharedOriginalUrl) de fonctionner sans aucune modification de
// activity-deduplication.js. On ne le recalcule jamais nous-mêmes pour ne pas risquer un URL
// dépendant de l'agenda interrogée.
function canonicalEventUrl(event) {
  return text(event && event.canonicalUrl) || `https://openagenda.com/events/${event && event.uid}`;
}

function mapOpenAgendaJsonOccurrence(event, timing, options = {}) {
  const sourceName = options.sourceName || "OpenAgenda";
  const sourceUrl = options.sourceUrl || null;
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const beginIso = normalizeBegin(timing.begin);
  const endIso = timing.end ? normalizeBegin(timing.end) : null;
  const occurrenceKey = beginIso ? buildOccurrenceKey(event.uid, beginIso) : null;
  const location = mapLocation(event.location);
  const hasPhysical = Boolean(location.venueName || location.address || location.city);
  const onlineUrl = text(event.onlineAccessLink);
  const locationType = mapAttendanceMode(event.attendanceMode) === "hybrid" ? (hasPhysical || onlineUrl ? "hybrid" : null)
    : mapAttendanceMode(event.attendanceMode) === "online" ? "online"
      : hasPhysical ? "physical" : null;
  const lifecycle = mapLifecycleStatus(event.status);
  const admission = inferAdmissionType(event.conditions);
  const categorieValues = Array.isArray(event.categorie) ? event.categorie.filter((v) => typeof v === "string") : [];
  const keywordValues = Array.isArray(event.keywords) ? event.keywords.filter((v) => typeof v === "string") : [];

  const evidence = [];
  if (beginIso) evidence.push({ field: "startsAt", sourceValue: timing.begin, provenanceIndex: 0 });
  if (lifecycle.lossy || lifecycle.unrecognized) evidence.push({ field: "lifecycleStatus", sourceValue: `status=${event.status}`, provenanceIndex: 0 });
  if (admission.confidence !== null) evidence.push({ field: "admissionType", sourceValue: text(event.conditions), provenanceIndex: 0 });

  const externalIds = [];
  if (event.uid !== undefined && event.uid !== null) externalIds.push({ system: "openagenda-event", value: String(event.uid) });
  if (occurrenceKey) externalIds.push({ system: "openagenda-occurrence", value: occurrenceKey });
  if (timing.id) externalIds.push({ system: "openagenda-timing", value: String(timing.id) });

  const fieldConfidence = {};
  if (lifecycle.lossy) fieldConfidence.lifecycleStatus = 0.5;
  if (lifecycle.unrecognized) fieldConfidence.lifecycleStatus = 0.3;
  if (admission.confidence !== null) fieldConfidence.admissionType = admission.confidence;

  const activity = {
    title: monolingualText(event.title),
    description: monolingualText(event.description),
    startsAt: beginIso,
    endsAt: endIso,
    timezone: text(event.timezone),
    lifecycleStatus: lifecycle.lifecycleStatus,
    locationType,
    venueName: location.venueName,
    address: location.address,
    postalCode: location.postalCode,
    city: location.city,
    country: location.country,
    latitude: location.latitude,
    longitude: location.longitude,
    onlineUrl,
    organizers: [], // Les organisateurs additionnels restent dans sourcePayload, sans mapping universel.
    category: null, // Volontairement non peuplé — réservé à la future taxonomie Mnoria.
    subcategory: null,
    tags: [], // Idem : réservé aux thématiques normalisées Mnoria, pas encore alimenté.
    sourceCategories: categorieValues, // `categorie` OpenAgenda, brut, non transformé.
    sourceTags: keywordValues, // `keywords` OpenAgenda, brut, non transformé.
    provenances: [{
      sourceType: "api",
      sourceName,
      sourceUrl,
      originalEventUrl: canonicalEventUrl(event),
      externalId: occurrenceKey,
      fetchedAt
    }],
    externalIds,
    imageUrl: mapImage(event.image),
    bookingUrl: mapBookingUrl(event.registration),
    admissionType: admission.admissionType,
    confidence: 0.9,
    fieldConfidence,
    evidence
  };

  return { eventUid: event.uid, occurrenceKey, timingId: timing.id || null, activity };
}

// Instant commun à toute la lecture, injectable pour les replays/tests.
function selectionNow(options) {
  const value = options.now ?? options.fetchedAt ?? new Date();
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error("Instant de sélection OpenAgenda invalide");
  return time;
}
function relevantTiming(timing, now) {
  const begin = Date.parse(timing?.begin), end = Date.parse(timing?.end);
  // Les créneaux mal formés passent à la validation au lieu de disparaître silencieusement.
  if (!Number.isFinite(begin) || (timing?.end && !Number.isFinite(end))) return true;
  return begin >= now || end > now;
}

// Métadonnées publiques complètes hors liste timings[] : cette dernière ne doit pas être
// recopiée des centaines de fois. Les descriptions portent des noms explicites pour ne pas
// être retirées par le sanitizer de persistance. Aucun secret/en-tête/réponse HTTP ici.
function eventSourceMetadata(event, options) {
  const { timings, description, ...fields } = event;
  return {
    agendaUid: options.agendaUid || null,
    shortDescription: description || null,
    ...fields,
    ...(options.agendaSchema ? { agendaSchema: {
      fields: (options.agendaSchema.fields || []).filter(field => field.schemaType !== "event").map(field => ({
        field: field.field, fieldType: field.fieldType, schemaType: field.schemaType,
        ...(field.options ? { options: field.options.map(({ id, value, label }) => ({ id, value, label })) } : {})
      }))
    } } : {})
  };
}

function* iterateOpenAgendaJsonEvent(event, options = {}) {
  const timings = Array.isArray(event?.timings) ? event.timings : [];
  if (!timings.length) {
    yield { index: 0, activity: null, validation: null, error: "Événement sans occurrence exploitable (timings vide ou absent)." };
    return;
  }
  const now = selectionNow(options);
  const keep = timing => options.onlyFutureOrOngoing === false || relevantTiming(timing, now);
  const max = Number.isInteger(options.maxOccurrencesPerEvent) && options.maxOccurrencesPerEvent > 0
    ? options.maxOccurrencesPerEvent : Infinity;
  const relevantCount = timings.reduce((count, timing) => count + Number(keep(timing)), 0);
  const metadata = eventSourceMetadata(event, options);
  let emitted = 0;
  for (let index = 0; index < timings.length; index += 1) {
    const timing = timings[index];
    if (!keep(timing) || emitted >= max) continue;
    emitted += 1;
    try {
      if (!timing?.begin) throw new Error("Occurrence sans horaire de début exploitable.");
      const { activity } = mapOpenAgendaJsonOccurrence(event, timing, options);
      const validation = validateNormalizedActivity(activity);
      if (relevantCount > max && emitted === max) {
        validation.warnings.push({ code: "occurrences_truncated", field: "startsAt", message: `Événement tronqué explicitement à ${max} occurrences sur ${relevantCount} pertinentes.` });
      }
      yield {
        index, activity: validation.activity, validation, error: null,
        sourcePayload: {
          version: "openagenda-occurrence-v1", eventUid: event.uid,
          eventMetadata: metadata, timing: { ...timing }
        }
      };
    } catch (error) {
      yield { index, activity: null, validation: null, error: error.message };
    }
  }
}

// Compatibilité avec le moteur actuel : tableau d'items, une activité par créneau.
function convertOpenAgendaJsonEvent(event, options = {}) {
  return [...iterateOpenAgendaJsonEvent(event, options)];
}

function convertOpenAgendaJsonEvents(events, options = {}) {
  if (!Array.isArray(events)) return [];
  return events.flatMap((event) => convertOpenAgendaJsonEvent(event, options));
}

async function requestPage({ agendaUid, apiKey, params, timeoutMs, userAgent }) {
  const url = new URL(`https://api.openagenda.com/v2/agendas/${agendaUid}/events`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(`${key}[]`, item));
    else url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    // La clé est transmise en en-tête HTTP, jamais dans l'URL/la query string.
    const response = await fetch(url, { headers: { key: apiKey, "User-Agent": userAgent || "MnoriaBotSortir/1.0" }, signal: controller.signal });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { throw new Error(`Réponse OpenAgenda non-JSON (HTTP ${response.status})`); }
    if (!response.ok) throw new Error(`OpenAgenda API a répondu HTTP ${response.status}: ${json && json.message || text.slice(0, 200)}`);
    if (!Array.isArray(json.events)) throw new Error("Réponse OpenAgenda invalide: events absent");
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

// Récupère les événements d'un agenda OpenAgenda via l'API v2, avec pagination et un
// plafond strict sur le nombre d'événements récupérés (jamais une collecte illimitée).
function geographicParams(bounds) {
  if (!bounds) return {};
  const params = {};
  for (const corner of ["northEast", "southWest"]) {
    for (const axis of ["lat", "lng"]) {
      const value = bounds[corner]?.[axis];
      const limit = axis === "lat" ? 90 : 180;
      if (!Number.isFinite(value) || Math.abs(value) > limit) throw new Error("Emprise OpenAgenda invalide");
      params[`geo[${corner}][${axis}]`] = value;
    }
  }
  if (bounds.northEast.lat < bounds.southWest.lat || bounds.northEast.lng < bounds.southWest.lng) throw new Error("Emprise OpenAgenda inversée");
  return params;
}

async function fetchOpenAgendaJsonEvents(options = {}) {
  if (!options.agendaUid) throw new Error("agendaUid est obligatoire");
  if (!options.apiKey) throw new Error("apiKey est obligatoire (clé publique OpenAgenda, jamais hardcodée)");
  const maxEvents = Number.isInteger(options.maxEvents) && options.maxEvents > 0 ? options.maxEvents : 20;
  const pageSize = Math.min(options.pageSize || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, maxEvents);
  const sourceUrl = `https://api.openagenda.com/v2/agendas/${options.agendaUid}/events`;
  const fetchedAt = options.fetchedAt || new Date().toISOString();

  const now = new Date(selectionNow({ ...options, fetchedAt }));
  const geo = geographicParams(options.geoBounding);
  const results = [];
  const batchSize = Number.isInteger(options.occurrenceBatchSize) && options.occurrenceBatchSize > 0
    ? options.occurrenceBatchSize : DEFAULT_OCCURRENCE_BATCH_SIZE;
  let batch = [], after = options.after, total = null, fetchedCount = 0, pagesFetched = 0;
  let occurrencesProduced = 0, occurrencesTruncated = false;
  const seenCursors = new Set();
  do {
    const cursorKey = JSON.stringify(after ?? null);
    if (seenCursors.has(cursorKey)) throw new Error("Curseur OpenAgenda répété : lecture incomplète");
    seenCursors.add(cursorKey);
    const page = await requestPage({
      agendaUid: options.agendaUid, apiKey: options.apiKey,
      timeoutMs: options.timeoutMs, userAgent: options.userAgent,
      params: {
        ...geo, size: Math.min(pageSize, maxEvents - fetchedCount), detailed: 1,
        monolingual: "fr", includeLabels: 1,
        relative: options.relative || ["current", "upcoming"], after
      }
    });
    pagesFetched += 1;
    total = page.total;
    for (const event of page.events) {
      fetchedCount += 1;
      for (const item of iterateOpenAgendaJsonEvent(event, { ...options, now, sourceUrl, fetchedAt })) {
        occurrencesProduced += 1;
        if (item.validation?.warnings.some(w => w.code === "occurrences_truncated")) occurrencesTruncated = true;
        if (options.onBatch) {
          batch.push(item);
          if (batch.length >= batchSize) { await options.onBatch(batch); batch = []; }
        } else results.push(item);
      }
    }
    after = page.after;
    if (!page.events.length && after) throw new Error("Page OpenAgenda vide avec curseur : lecture incomplète");
  } while (after && fetchedCount < maxEvents);
  if (batch.length) await options.onBatch(batch);
  return {
    total, fetchedCount, pagesFetched, occurrencesProduced,
    truncated: Boolean(after) || fetchedCount < total || occurrencesTruncated,
    nextAfter: after || null, streamed: Boolean(options.onBatch), results
  };
}

module.exports = {
  STATUS_LABELS,
  mapLifecycleStatus,
  mapAttendanceMode,
  mapLocation,
  mapImage,
  mapBookingUrl,
  inferAdmissionType,
  buildOccurrenceKey,
  canonicalEventUrl,
  mapOpenAgendaJsonOccurrence,
  iterateOpenAgendaJsonEvent,
  convertOpenAgendaJsonEvent,
  convertOpenAgendaJsonEvents,
  fetchOpenAgendaJsonEvents
};
