"use strict";

const { validateNormalizedActivity } = require("../activity-validation");

const DEFAULT_ENDPOINT = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records";

function text(value) { const v = value == null ? "" : String(value).trim(); return v || null; }
function htmlToText(value) {
  const v = text(value);
  if (!v) return null;
  return v.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/[ \t]+/g, " ")
    .replace(/ +([.,;:!?])/g, "$1").replace(/ *\n+ */g, "\n").trim() || null;
}
function tags(value) { return text(value) ? value.split(";").map(text).filter(Boolean) : []; }
function coordinates(record, location) {
  if (record.lat_lon && Number.isFinite(record.lat_lon.lat) && Number.isFinite(record.lat_lon.lon)) return { latitude: record.lat_lon.lat, longitude: record.lat_lon.lon };
  const match = text(location && location.address_lat_lon)?.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  return match ? { latitude: Number(match[1]), longitude: Number(match[2]) } : { latitude: null, longitude: null };
}
function occurrenceCount(value) { return text(value) ? value.split(";").filter(Boolean).length : 0; }
function mapAdmissionType(value) {
  const sourceValue = text(value)?.toLocaleLowerCase("fr-FR") || null;
  return ({ gratuit: "free", payant: "paid", "gratuit sous condition": "mixed" })[sourceValue] || "unknown";
}

function mapParisEvent(record, options = {}) {
  record = record && typeof record === "object" ? record : {};
  const locations = Array.isArray(record.locations) ? record.locations : [];
  const location = locations[0] || {};
  const geo = coordinates(record, location);
  const count = occurrenceCount(record.occurrences);
  const multipleLocations = locations.length > 1;
  const fieldConfidence = {};
  if (count > 1) { fieldConfidence.startsAt = 0.5; fieldConfidence.endsAt = 0.5; }
  if (multipleLocations) fieldConfidence.venueName = 0.5;
  const evidence = [];
  if (text(record.occurrences)) evidence.push({ field: "startsAt", sourceValue: record.occurrences, provenanceIndex: 0 });
  if (multipleLocations) evidence.push({ field: "venueName", sourceValue: JSON.stringify(locations), provenanceIndex: 0 });
  if (text(record.price_type)) evidence.push({ field: "admissionType", sourceValue: record.price_type, provenanceIndex: 0 });
  if (text(record.access_link)) evidence.push({ field: "bookingUrl", sourceValue: record.access_link, provenanceIndex: 0 });
  const organizerName = text(record.contact_organisation_name);
  const organizerUrl = text(record.contact_url);
  return {
    title: text(record.title),
    description: htmlToText(record.description) || text(record.lead_text),
    startsAt: text(record.date_start),
    endsAt: text(record.date_end),
    timezone: options.timezone || "Europe/Paris",
    lifecycleStatus: "scheduled",
    locationType: "physical",
    venueName: text(location.address_name) || text(record.address_name),
    address: text(location.address_street) || text(record.address_street),
    postalCode: text(location.address_zipCode) || text(record.address_zipcode),
    city: text(location.address_city) || text(record.address_city),
    country: options.country || "FR",
    latitude: geo.latitude,
    longitude: geo.longitude,
    onlineUrl: null,
    organizers: organizerName || organizerUrl ? [{ name: organizerName, url: organizerUrl }] : [],
    category: null,
    subcategory: null,
    tags: tags(record.qfap_tags),
    provenances: [{
      sourceType: "api",
      sourceName: options.sourceName || "Que Faire à Paris ?",
      sourceUrl: options.endpoint || DEFAULT_ENDPOINT,
      originalEventUrl: text(record.url),
      externalId: text(record.id),
      fetchedAt: options.fetchedAt || new Date().toISOString()
    }],
    externalIds: [
      ...(text(record.id) ? [{ system: "paris-que-faire", value: text(record.id) }] : []),
      ...(record.event_id != null ? [{ system: "paris-que-faire-event", value: String(record.event_id) }] : [])
    ],
    imageUrl: text(record.cover_url),
    bookingUrl: text(record.access_link),
    admissionType: mapAdmissionType(record.price_type),
    confidence: 0.95,
    fieldConfidence,
    evidence
  };
}

function convertParisEvents(records, options = {}) {
  if (!Array.isArray(records)) return [];
  return records.map((record, index) => {
    try {
      const activity = mapParisEvent(record, options);
      return { index, activity, validation: validateNormalizedActivity(activity), error: null };
    } catch (error) { return { index, activity: null, validation: null, error: error.message }; }
  });
}

async function fetchParisEvents(options = {}) {
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : 5;
  const url = new URL(endpoint);
  url.searchParams.set("where", options.where || "date_start >= now()");
  url.searchParams.set("order_by", options.orderBy || "date_start asc");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("timezone", "UTC");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": options.userAgent || "MnoriaBotSortir/1.0" }, signal: controller.signal });
    if (!response.ok) throw new Error(`Paris Data a répondu HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.results)) throw new Error("Réponse Paris Data invalide: results absent");
    return { total: Number(payload.total_count) || payload.results.length, results: convertParisEvents(payload.results.slice(0, limit), { ...options, endpoint, fetchedAt: options.fetchedAt || new Date().toISOString() }) };
  } finally { clearTimeout(timeout); }
}

// Ligne éditoriale Explorer appliquée aux thèmes de la source (qfap_tags) : un enregistrement est
// retenu s'il porte au moins un thème retenu et aucun thème exclu. Concerts seuls, loisirs,
// ateliers bien-être, santé et sport ne sont pas repris.
const PARIS_EDITORIAL_TAGS = Object.freeze(["Théâtre", "Conférence", "Débat", "Expo", "Art contemporain", "Photo", "Peinture",
  "Littérature", "Ecrans", "Histoire", "Sciences", "Solidarité"]);
const PARIS_EXCLUDED_TAGS = Object.freeze(["Sport"]);
function isEditorialParisRecord(record) {
  const recordTags = new Set(tags(record && record.qfap_tags));
  return PARIS_EDITORIAL_TAGS.some(tag => recordTags.has(tag)) && !PARIS_EXCLUDED_TAGS.some(tag => recordTags.has(tag));
}

const PARIS_PAGE_SIZE = 100; // maximum de l'API Explore v2.1
const PARIS_MAX_RECORDS = 5000; // l'API refuse offset + limit > 10 000

// Lecture complète des événements à venir ou en cours, page par page, AVANT toute écriture :
// une page en échec, un total qui change en cours de lecture ou un dépassement du plafond font
// échouer le producteur au lieu de persister un jeu partiel.
async function fetchAllParisEvents(options = {}) {
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const maxRecords = options.maxRecords || PARIS_MAX_RECORDS;
  const records = [];
  let total = null;
  for (let offset = 0; total === null || offset < total; offset += PARIS_PAGE_SIZE) {
    const url = new URL(endpoint);
    url.searchParams.set("where", "date_end >= now()");
    url.searchParams.set("order_by", "id");
    url.searchParams.set("limit", String(PARIS_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("timezone", "UTC");
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": options.userAgent || "MnoriaBotSortir/1.0" }, signal: AbortSignal.timeout(options.timeoutMs || 30000) });
    if (!response.ok) throw new Error(`Paris Data a répondu HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.results) || !Number.isInteger(payload.total_count)) throw new Error("Réponse Paris Data invalide");
    if (total === null) {
      total = payload.total_count;
      if (total > maxRecords) throw new Error(`Paris Data : ${total} enregistrements, au-delà du plafond de ${maxRecords}`);
    } else if (payload.total_count !== total) throw new Error("Paris Data : total modifié pendant la lecture");
    records.push(...payload.results);
    if (!payload.results.length) break;
  }
  if (records.length !== total || new Set(records.map(r => r && r.id)).size !== records.length) throw new Error("Paris Data : lecture incomplète ou doublonnée");
  const retained = records.filter(isEditorialParisRecord);
  return { total, scanned: records.length, retained: retained.length, results: convertParisEvents(retained, { ...options, endpoint, fetchedAt }) };
}

module.exports = { DEFAULT_ENDPOINT, PARIS_EDITORIAL_TAGS, PARIS_EXCLUDED_TAGS, PARIS_PAGE_SIZE, PARIS_MAX_RECORDS,
  htmlToText, mapAdmissionType, mapParisEvent, convertParisEvents, isEditorialParisRecord, fetchParisEvents, fetchAllParisEvents };
