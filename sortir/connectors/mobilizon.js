"use strict";

const { validateNormalizedActivity } = require("../activity-validation");

const DEFAULT_TIMEOUT_MS = 15000;

const SEARCH_EVENTS_QUERY = `
query SortirPilot($limit: Int, $beginsOn: DateTime) {
  searchEvents(limit: $limit, beginsOn: $beginsOn) {
    total
    elements {
      id uuid url title beginsOn endsOn status category
      picture { url }
      tags { slug title }
      physicalAddress {
        description street locality postalCode region country geom timezone url
      }
      organizerActor { name preferredUsername url }
      attributedTo { name preferredUsername url }
      options { timezone isOnline }
      ... on Event { description onlineAddress }
    }
  }
}`;

const HTML_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "
};

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match);
}

function htmlToText(value) {
  if (value === null || value === undefined) return null;
  const text = decodeHtmlEntities(String(value)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
  return text || null;
}

function validString(value) {
  const trimmed = value === null || value === undefined ? "" : String(value).trim();
  return trimmed || null;
}

function parseDescriptionAddress(description) {
  const value = validString(description);
  if (!value) return { venueName: null, address: null, postalCode: null, city: null };
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  const postalMatch = value.match(/\b(\d{5})\s+([^,]+)(?:,|$)/i);
  const firstLooksLikeStreet = /^\d+[\s,]/.test(parts[0] || "");
  return {
    venueName: parts.length >= 3 && !firstLooksLikeStreet ? parts[0] : null,
    address: value,
    postalCode: postalMatch ? postalMatch[1] : null,
    city: postalMatch ? postalMatch[2].trim() : null
  };
}

// Mobilizon documente Address.geom sous la forme "longitude;latitude".
function parseMobilizonGeom(value) {
  const match = String(value || "").match(/^\s*(-?\d+(?:\.\d+)?)\s*[;,]\s*(-?\d+(?:\.\d+)?)\s*$/);
  return match ? { longitude: Number(match[1]), latitude: Number(match[2]) } : { longitude: null, latitude: null };
}

function organizerFromEvent(event) {
  const actor = event.attributedTo || event.organizerActor;
  if (!actor) return [];
  const name = validString(actor.name) || validString(actor.preferredUsername);
  const url = validString(actor.url);
  return name || url ? [{ name, url }] : [];
}

function mapMobilizonLifecycleStatus(value) {
  const sourceStatus = validString(value)?.toUpperCase() || null;
  const statuses = {
    CONFIRMED: "scheduled",
    TENTATIVE: "tentative",
    CANCELLED: "cancelled",
    POSTPONED: "postponed"
  };
  return { lifecycleStatus: statuses[sourceStatus] || "scheduled", sourceStatus, recognized: !sourceStatus || Boolean(statuses[sourceStatus]) };
}

function mapMobilizonEvent(event, options = {}) {
  const address = event && event.physicalAddress ? event.physicalAddress : null;
  const fallbackAddress = parseDescriptionAddress(address && address.description);
  const geo = parseMobilizonGeom(address && address.geom);
  const venueName = validString(address && address.description) && validString(address && address.street)
    ? validString(address.description)
    : fallbackAddress.venueName;
  const street = validString(address && address.street);
  const city = validString(address && address.locality) || fallbackAddress.city;
  const physicalAddress = street || fallbackAddress.address;
  const onlineUrl = validString(event && event.onlineAddress);
  const hasPhysical = Boolean(venueName || physicalAddress || city);
  const hasOnline = Boolean(onlineUrl || (event && event.options && event.options.isOnline));
  const locationType = hasPhysical && hasOnline ? "hybrid" : hasOnline ? "online" : hasPhysical ? "physical" : null;
  const uuid = validString(event && event.uuid);
  const internalId = validString(event && event.id);
  const originalEventUrl = validString(event && event.url);
  const tags = Array.isArray(event && event.tags)
    ? event.tags.map((tag) => validString(tag && (tag.title || tag.slug))).filter(Boolean)
    : [];
  const locationWasParsed = Boolean(address && address.description && (!address.locality || !address.postalCode || !address.street));
  const lifecycle = mapMobilizonLifecycleStatus(event && event.status);
  const fieldConfidence = {};
  if (locationWasParsed && venueName) fieldConfidence.venueName = 0.75;
  if (locationWasParsed && city) fieldConfidence.city = 0.75;
  if (locationWasParsed && physicalAddress) fieldConfidence.address = 0.8;
  if (!lifecycle.recognized) fieldConfidence.lifecycleStatus = 0.5;
  const evidence = [];
  if (locationWasParsed) evidence.push({ field: "address", sourceValue: address.description, provenanceIndex: 0 });
  if (lifecycle.sourceStatus) evidence.push({ field: "lifecycleStatus", sourceValue: lifecycle.sourceStatus, provenanceIndex: 0 });

  return {
    title: validString(event && event.title),
    description: htmlToText(event && event.description),
    startsAt: validString(event && event.beginsOn),
    endsAt: validString(event && event.endsOn),
    timezone: validString(event && event.options && event.options.timezone) || validString(address && address.timezone),
    lifecycleStatus: lifecycle.lifecycleStatus,
    locationType,
    venueName,
    address: physicalAddress,
    postalCode: validString(address && address.postalCode) || fallbackAddress.postalCode,
    city,
    country: validString(address && address.country),
    latitude: geo.latitude,
    longitude: geo.longitude,
    onlineUrl,
    organizers: organizerFromEvent(event || {}),
    category: validString(event && event.category)?.toLocaleLowerCase("fr-FR") || null,
    subcategory: null,
    tags,
    provenances: [{
      sourceType: "api",
      sourceName: options.sourceName || "Mobilizon",
      sourceUrl: options.endpoint || null,
      originalEventUrl,
      externalId: uuid,
      fetchedAt: options.fetchedAt || new Date().toISOString()
    }],
    externalIds: [
      ...(uuid ? [{ system: "mobilizon", value: uuid }] : []),
      ...(internalId ? [{ system: "mobilizon-internal", value: internalId }] : [])
    ],
    imageUrl: validString(event && event.picture && event.picture.url),
    bookingUrl: null,
    admissionType: "unknown",
    confidence: 0.95,
    fieldConfidence,
    evidence
  };
}

function convertMobilizonEvents(events, options = {}) {
  if (!Array.isArray(events)) return [];
  return events.map((event, index) => {
    try {
      const activity = mapMobilizonEvent(event, options);
      return { index, activity, validation: validateNormalizedActivity(activity), error: null };
    } catch (error) {
      return { index, activity: null, validation: null, error: error.message };
    }
  });
}

async function fetchMobilizonEvents(options = {}) {
  const endpoint = options.endpoint;
  if (!endpoint) throw new Error("endpoint est obligatoire");
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : 5;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": options.userAgent || "MnoriaBotSortir/1.0" },
      body: JSON.stringify({ query: SEARCH_EVENTS_QUERY, variables: { limit, beginsOn: options.beginsOn || null } }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Mobilizon a répondu HTTP ${response.status}`);
    const payload = await response.json();
    if (Array.isArray(payload.errors) && payload.errors.length) {
      throw new Error(`Mobilizon GraphQL: ${payload.errors.map((item) => item.message).join("; ")}`);
    }
    const events = payload && payload.data && payload.data.searchEvents && payload.data.searchEvents.elements;
    if (!Array.isArray(events)) throw new Error("Réponse Mobilizon invalide: elements absent");
    return {
      total: Number(payload.data.searchEvents.total) || events.length,
      results: convertMobilizonEvents(events.slice(0, limit), {
        ...options,
        endpoint,
        fetchedAt: options.fetchedAt || new Date().toISOString()
      })
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  SEARCH_EVENTS_QUERY,
  htmlToText,
  parseDescriptionAddress,
  parseMobilizonGeom,
  mapMobilizonLifecycleStatus,
  mapMobilizonEvent,
  convertMobilizonEvents,
  fetchMobilizonEvents
};
