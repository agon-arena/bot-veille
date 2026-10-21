"use strict";

const { normalizeActivity, isValidHttpUrl } = require("./activity-validation");

const ALGORITHM_VERSION = "sortir-dedup-v1";
const DECISIONS = Object.freeze({ MATCH: "MATCH", REVIEW: "REVIEW", DISTINCT: "DISTINCT" });
const FIVE_MINUTES = 5 * 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

function normalizedText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function tokenSimilarity(left, right) {
  const a = new Set(normalizedText(left).split(" ").filter(Boolean));
  const b = new Set(normalizedText(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

function canonicalUrl(value, options = {}) {
  if (!isValidHttpUrl(value)) return null;
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|mc_[ce]id)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.hostname = url.hostname.toLocaleLowerCase("en-US");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (options.source) {
    url.search = "";
  }
  return url.toString();
}

function instant(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function distanceMeters(a, b) {
  if (![a.latitude, a.longitude, b.latitude, b.longitude].every(Number.isFinite)) return null;
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function provenanceCompatible(a, b) {
  for (const left of a.provenances) for (const right of b.provenances) {
    const leftUrl = canonicalUrl(left.sourceUrl, { source: true });
    const rightUrl = canonicalUrl(right.sourceUrl, { source: true });
    if (leftUrl && rightUrl && leftUrl === rightUrl) return true;
    if (!leftUrl && !rightUrl && normalizedText(left.sourceType) === normalizedText(right.sourceType)
      && normalizedText(left.sourceName) && normalizedText(left.sourceName) === normalizedText(right.sourceName)) return true;
  }
  return false;
}

function sharedExternalId(a, b) {
  const right = new Set(b.externalIds.map((item) => `${normalizedText(item.system)}\u0000${String(item.value || "").trim()}`));
  return a.externalIds.find((item) => right.has(`${normalizedText(item.system)}\u0000${String(item.value || "").trim()}`)) || null;
}

function sharedOriginalUrl(a, b) {
  const right = new Set(b.provenances.map((item) => canonicalUrl(item.originalEventUrl)).filter(Boolean));
  return a.provenances.map((item) => canonicalUrl(item.originalEventUrl)).find((url) => url && right.has(url)) || null;
}

function organizerSimilarity(a, b) {
  let best = 0;
  for (const left of a.organizers) for (const right of b.organizers) best = Math.max(best, tokenSimilarity(left.name, right.name));
  return best;
}

function compareActivities(leftInput, rightInput) {
  const a = normalizeActivity(leftInput);
  const b = normalizeActivity(rightInput);
  const signals = [];
  const titleSimilarity = tokenSimilarity(a.title, b.title);
  const organizerScore = organizerSimilarity(a, b);
  const aStart = instant(a.startsAt);
  const bStart = instant(b.startsAt);
  const startDeltaMs = aStart === null || bStart === null ? null : Math.abs(aStart - bStart);
  const distance = distanceMeters(a, b);
  const sameAddress = Boolean(normalizedText(a.address) && normalizedText(a.address) === normalizedText(b.address)
    && (!normalizedText(a.city) || !normalizedText(b.city) || normalizedText(a.city) === normalizedText(b.city)));
  const sameCity = Boolean(normalizedText(a.city) && normalizedText(a.city) === normalizedText(b.city));
  const cityConflict = Boolean(normalizedText(a.city) && normalizedText(b.city) && !sameCity);
  const strongLocation = sameAddress || (distance !== null && distance <= 100);
  const locationConflict = cityConflict || (distance !== null && distance > 5000);
  const externalId = sharedExternalId(a, b);
  const compatibleExternalId = Boolean(externalId && provenanceCompatible(a, b));
  const originalUrl = sharedOriginalUrl(a, b);
  const identitySignal = compatibleExternalId || Boolean(originalUrl);

  signals.push({ type: "title_similarity", value: Number(titleSimilarity.toFixed(3)) });
  if (startDeltaMs !== null) signals.push({ type: "start_delta_ms", value: startDeltaMs });
  if (distance !== null) signals.push({ type: "location_distance_m", value: Math.round(distance) });
  if (sameAddress) signals.push({ type: "same_normalized_address", value: true });
  if (sameCity) signals.push({ type: "same_city", value: true });
  if (organizerScore) signals.push({ type: "organizer_similarity", value: Number(organizerScore.toFixed(3)) });
  if (externalId) signals.push({ type: compatibleExternalId ? "compatible_external_id" : "external_id_namespace_collision", system: externalId.system, value: externalId.value });
  if (originalUrl) signals.push({ type: "same_original_url", value: originalUrl });
  if (locationConflict) signals.push({ type: "location_conflict", value: true });

  const datatourismePoiIds = new Set(a.externalIds.filter(id => id.system === "datatourisme-poi").map(id => id.value));
  const sameDatatourismePoi = b.externalIds.some(id => id.system === "datatourisme-poi" && datatourismePoiIds.has(id.value));
  if (sameDatatourismePoi && startDeltaMs === 0 && instant(a.endsAt) !== instant(b.endsAt)) {
    signals.push({ type: "datatourisme_period_end_conflict", value: true });
    return { algorithmVersion: ALGORITHM_VERSION, decision: DECISIONS.DISTINCT, signals };
  }

  const occurrenceConflict = startDeltaMs !== null && startDeltaMs > TWELVE_HOURS;
  if (occurrenceConflict) signals.push({ type: "occurrence_conflict", value: true });
  if (occurrenceConflict) return { algorithmVersion: ALGORITHM_VERSION, decision: identitySignal ? DECISIONS.REVIEW : DECISIONS.DISTINCT, signals };
  if (locationConflict) return { algorithmVersion: ALGORITHM_VERSION, decision: identitySignal ? DECISIONS.REVIEW : DECISIONS.DISTINCT, signals };
  if (identitySignal) return { algorithmVersion: ALGORITHM_VERSION, decision: DECISIONS.MATCH, signals };

  const compositeMatch = titleSimilarity >= 0.92 && startDeltaMs !== null && startDeltaMs <= FIVE_MINUTES
    && strongLocation && organizerScore >= 0.9;
  if (compositeMatch) {
    signals.push({ type: "strong_composite_match", value: true });
    return { algorithmVersion: ALGORITHM_VERSION, decision: DECISIONS.MATCH, signals };
  }

  const probable = (titleSimilarity >= 0.82 && startDeltaMs !== null && startDeltaMs <= TWO_HOURS && sameCity)
    || (titleSimilarity >= 0.82 && strongLocation && startDeltaMs !== null && startDeltaMs <= TWELVE_HOURS)
    || (startDeltaMs !== null && startDeltaMs <= FIVE_MINUTES && strongLocation && titleSimilarity >= 0.5);
  if (probable) {
    signals.push({ type: "probable_composite_match", value: true });
    return { algorithmVersion: ALGORITHM_VERSION, decision: DECISIONS.REVIEW, signals };
  }
  return { algorithmVersion: ALGORITHM_VERSION, decision: DECISIONS.DISTINCT, signals };
}

function valueScore(activity, field) {
  const confidence = Number.isFinite(activity.fieldConfidence[field]) ? activity.fieldConfidence[field]
    : Number.isFinite(activity.confidence) ? activity.confidence : 0;
  const value = activity[field];
  const completeness = typeof value === "string" ? Math.min(value.length / 500, 0.2) : 0;
  const freshness = Math.max(0, ...activity.provenances.map((item) => instant(item.fetchedAt) || 0)) / 1e16;
  return confidence + completeness + freshness;
}

function chooseValue(a, b, field) {
  const candidates = [a, b].filter((item) => item[field] !== null && item[field] !== undefined && item[field] !== "");
  if (!candidates.length) return null;
  return candidates.sort((left, right) => valueScore(right, field) - valueScore(left, field)
    || JSON.stringify(left[field]).localeCompare(JSON.stringify(right[field])))[0][field];
}

function uniqueObjects(values, key) {
  const seen = new Set();
  return values.filter((value) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true; });
}

function mergeProvenances(a, b) {
  const provenances = [];
  const indexes = [[], []];
  [a.provenances, b.provenances].forEach((items, side) => items.forEach((item, index) => {
    const key = JSON.stringify(item);
    let mergedIndex = provenances.findIndex((candidate) => JSON.stringify(candidate) === key);
    if (mergedIndex < 0) { mergedIndex = provenances.length; provenances.push(item); }
    indexes[side][index] = mergedIndex;
  }));
  return { provenances, indexes };
}

function mergeActivities(leftInput, rightInput) {
  const comparison = compareActivities(leftInput, rightInput);
  if (comparison.decision !== DECISIONS.MATCH) throw new Error(`Fusion refusée: décision ${comparison.decision}`);
  const a = normalizeActivity(leftInput);
  const b = normalizeActivity(rightInput);
  const mergedProvenances = mergeProvenances(a, b);
  const externalIds = uniqueObjects([...a.externalIds, ...b.externalIds], (item) => `${normalizedText(item.system)}\u0000${item.value}`);
  const scalarFields = ["title", "description", "startsAt", "endsAt", "timezone", "venueName", "address", "postalCode", "city", "country", "latitude", "longitude", "onlineUrl", "category", "subcategory", "imageUrl", "bookingUrl"];
  const activity = { ...a };
  for (const field of scalarFields) activity[field] = chooseValue(a, b, field);
  activity.locationType = a.locationType === b.locationType ? a.locationType
    : [a.locationType, b.locationType].includes("hybrid") || new Set([a.locationType, b.locationType]).has("online") && new Set([a.locationType, b.locationType]).has("physical") ? "hybrid" : chooseValue(a, b, "locationType");
  const lifecycleOrder = { scheduled: 0, tentative: 1, postponed: 2, cancelled: 3 };
  activity.lifecycleStatus = lifecycleOrder[a.lifecycleStatus] >= lifecycleOrder[b.lifecycleStatus] ? a.lifecycleStatus : b.lifecycleStatus;
  activity.admissionType = a.admissionType === b.admissionType ? a.admissionType
    : a.admissionType === "unknown" ? b.admissionType : b.admissionType === "unknown" ? a.admissionType : "unknown";
  activity.organizers = uniqueObjects([...a.organizers, ...b.organizers], (item) => `${normalizedText(item.name)}\u0000${canonicalUrl(item.url) || ""}`);
  activity.tags = [...new Set([...a.tags, ...b.tags].map((item) => normalizedText(item)))].map((key) => [...a.tags, ...b.tags].find((item) => normalizedText(item) === key));
  activity.provenances = mergedProvenances.provenances;
  activity.externalIds = externalIds;
  activity.fieldConfidence = {};
  for (const field of new Set([...Object.keys(a.fieldConfidence), ...Object.keys(b.fieldConfidence)])) {
    activity.fieldConfidence[field] = Math.max(a.fieldConfidence[field] ?? 0, b.fieldConfidence[field] ?? 0);
  }
  const conflictFields = scalarFields.filter((field) => a[field] != null && b[field] != null && JSON.stringify(a[field]) !== JSON.stringify(b[field]));
  activity.confidence = Math.max(a.confidence || 0, b.confidence || 0) - Math.min(0.3, conflictFields.length * 0.03);
  activity.confidence = Number(Math.max(0, activity.confidence).toFixed(2));
  const remapEvidence = (items, side) => items.map((item) => ({ ...item, provenanceIndex: item.provenanceIndex === null ? null : mergedProvenances.indexes[side][item.provenanceIndex] }));
  activity.evidence = uniqueObjects([...remapEvidence(a.evidence, 0), ...remapEvidence(b.evidence, 1)], (item) => JSON.stringify(item));
  for (const field of conflictFields) activity.evidence.push({ field, sourceValue: JSON.stringify([a[field], b[field]]), provenanceIndex: null });
  return { algorithmVersion: ALGORITHM_VERSION, decision: DECISIONS.MATCH, comparison, conflicts: conflictFields, activity };
}

module.exports = { ALGORITHM_VERSION, DECISIONS, normalizedText, canonicalUrl, tokenSimilarity, compareActivities, mergeActivities };
