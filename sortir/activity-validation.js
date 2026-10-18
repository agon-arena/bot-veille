"use strict";

const {
  LOCATION_TYPES,
  LIFECYCLE_STATUSES,
  ADMISSION_TYPES,
  VALIDATION_STATUSES,
  MAX_TITLE_LENGTH,
  LOW_CONFIDENCE_THRESHOLD,
  NORMALIZED_ACTIVITY_FIELDS,
  createNormalizedActivity
} = require("./activity-schema");

const URL_FIELDS = ["onlineUrl", "imageUrl", "bookingUrl"];
const DATE_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function trimToNull(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function normalizeHttpUrl(value) {
  const trimmed = trimToNull(value);
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return trimmed;
    url.hash = "";
    return url.toString();
  } catch (_) {
    return trimmed;
  }
}

function isValidHttpUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch (_) {
    return false;
  }
}

function normalizeDate(value) {
  const trimmed = trimToNull(value);
  if (!trimmed || !DATE_WITH_OFFSET_RE.test(trimmed)) return trimmed;
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : trimmed;
}

function isValidInstant(value) {
  return typeof value === "string" && DATE_WITH_OFFSET_RE.test(value) && Number.isFinite(Date.parse(value));
}

function isValidTimezone(value) {
  if (!value) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of values) {
    const value = trimToNull(raw);
    if (!value) continue;
    const key = value.toLocaleLowerCase("fr-FR");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizeOrganizers(values) {
  if (!Array.isArray(values)) return [];
  return values.map((item) => ({
    name: trimToNull(item && item.name),
    url: normalizeHttpUrl(item && item.url)
  })).filter((item) => item.name || item.url);
}

function normalizeProvenances(values) {
  if (!Array.isArray(values)) return [];
  return values.map((item) => ({
    sourceType: trimToNull(item && item.sourceType),
    sourceName: trimToNull(item && item.sourceName),
    sourceUrl: normalizeHttpUrl(item && item.sourceUrl),
    originalEventUrl: normalizeHttpUrl(item && item.originalEventUrl),
    externalId: trimToNull(item && item.externalId),
    fetchedAt: normalizeDate(item && item.fetchedAt)
  }));
}

function normalizeExternalIds(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  return values.map((item) => ({
    system: trimToNull(item && item.system),
    value: trimToNull(item && item.value)
  })).filter((item) => {
    if (!item.system || !item.value) return true;
    const key = `${item.system.toLocaleLowerCase("fr-FR")}::${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeFieldConfidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([field, confidence]) => [String(field).trim(), confidence]));
}

function normalizeEvidence(values) {
  if (!Array.isArray(values)) return [];
  return values.map((item) => ({
    field: trimToNull(item && item.field),
    excerpt: trimToNull(item && item.excerpt),
    sourceValue: trimToNull(item && item.sourceValue),
    provenanceIndex: Number.isInteger(item && item.provenanceIndex) ? item.provenanceIndex : null
  }));
}

function normalizeActivity(input) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const activity = createNormalizedActivity(raw);

  for (const field of [
    "title", "description", "timezone", "locationType", "venueName", "address",
    "postalCode", "city", "country", "category", "subcategory"
  ]) {
    activity[field] = trimToNull(raw[field]);
  }

  activity.startsAt = normalizeDate(raw.startsAt);
  activity.endsAt = normalizeDate(raw.endsAt);
  activity.lifecycleStatus = trimToNull(raw.lifecycleStatus) || "scheduled";
  activity.onlineUrl = normalizeHttpUrl(raw.onlineUrl);
  activity.imageUrl = normalizeHttpUrl(raw.imageUrl);
  activity.bookingUrl = normalizeHttpUrl(raw.bookingUrl);
  activity.admissionType = trimToNull(raw.admissionType) || "unknown";
  activity.latitude = raw.latitude === "" || raw.latitude === null || raw.latitude === undefined ? null : raw.latitude;
  activity.longitude = raw.longitude === "" || raw.longitude === null || raw.longitude === undefined ? null : raw.longitude;
  activity.organizers = normalizeOrganizers(raw.organizers);
  activity.tags = normalizeStringList(raw.tags);
  activity.sourceCategories = normalizeStringList(raw.sourceCategories);
  activity.sourceTags = normalizeStringList(raw.sourceTags);
  activity.provenances = normalizeProvenances(raw.provenances);
  activity.externalIds = normalizeExternalIds(raw.externalIds);
  activity.confidence = raw.confidence === "" || raw.confidence === null || raw.confidence === undefined ? null : raw.confidence;
  activity.fieldConfidence = normalizeFieldConfidence(raw.fieldConfidence);
  activity.evidence = normalizeEvidence(raw.evidence);

  return activity;
}

function issue(code, field, message) {
  return { code, field, message };
}

function validateNormalizedActivity(input) {
  const activity = normalizeActivity(input);
  const errors = [];
  const warnings = [];

  if (!activity.title) errors.push(issue("title_required", "title", "Le titre est obligatoire."));
  else if (activity.title.length > MAX_TITLE_LENGTH) errors.push(issue("title_too_long", "title", `Le titre ne doit pas dépasser ${MAX_TITLE_LENGTH} caractères.`));

  if (!isValidInstant(activity.startsAt)) errors.push(issue("starts_at_invalid", "startsAt", "startsAt doit être une date ISO 8601 avec Z ou décalage UTC."));
  if (activity.endsAt && !isValidInstant(activity.endsAt)) errors.push(issue("ends_at_invalid", "endsAt", "endsAt doit être une date ISO 8601 avec Z ou décalage UTC."));
  if (isValidInstant(activity.startsAt) && isValidInstant(activity.endsAt) && Date.parse(activity.endsAt) < Date.parse(activity.startsAt)) {
    errors.push(issue("ends_before_start", "endsAt", "endsAt ne peut pas précéder startsAt."));
  }
  if (activity.timezone && !isValidTimezone(activity.timezone)) errors.push(issue("timezone_invalid", "timezone", "Le fuseau horaire doit être un identifiant IANA valide."));
  if (!LIFECYCLE_STATUSES.includes(activity.lifecycleStatus)) {
    errors.push(issue("lifecycle_status_invalid", "lifecycleStatus", `lifecycleStatus doit être ${LIFECYCLE_STATUSES.join(", ")}.`));
  }
  if (!ADMISSION_TYPES.includes(activity.admissionType)) {
    errors.push(issue("admission_type_invalid", "admissionType", `admissionType doit être ${ADMISSION_TYPES.join(", ")}.`));
  }

  if (!LOCATION_TYPES.includes(activity.locationType)) {
    errors.push(issue("location_type_invalid", "locationType", `locationType doit être ${LOCATION_TYPES.join(", ")}.`));
  }

  const hasPhysicalLocation = Boolean(activity.venueName || activity.address || activity.city);
  if ((activity.locationType === "physical" || activity.locationType === "hybrid") && !hasPhysicalLocation) {
    errors.push(issue("physical_location_insufficient", "locationType", "Une activité physique doit indiquer au moins un lieu, une adresse ou une ville."));
  }
  if ((activity.locationType === "online" || activity.locationType === "hybrid") && !isValidHttpUrl(activity.onlineUrl)) {
    errors.push(issue("online_url_required", "onlineUrl", "Une activité en ligne doit fournir une URL HTTP(S) valide."));
  }

  for (const field of URL_FIELDS) {
    if (activity[field] && !isValidHttpUrl(activity[field])) errors.push(issue("url_invalid", field, `${field} doit être une URL HTTP(S) valide.`));
  }

  activity.organizers.forEach((organizer, index) => {
    if (!organizer.name) warnings.push(issue("organizer_name_missing", `organizers[${index}].name`, "Le nom de l'organisateur est absent."));
    if (organizer.url && !isValidHttpUrl(organizer.url)) errors.push(issue("url_invalid", `organizers[${index}].url`, "L'URL de l'organisateur doit être HTTP(S)."));
  });

  if (!activity.provenances.length) {
    errors.push(issue("provenance_required", "provenances", "Au moins une provenance est obligatoire."));
  }
  activity.provenances.forEach((provenance, index) => {
    const prefix = `provenances[${index}]`;
    if (!provenance.sourceType) errors.push(issue("provenance_source_type_required", `${prefix}.sourceType`, "Le type de source est obligatoire."));
    if (!provenance.sourceName) errors.push(issue("provenance_source_name_required", `${prefix}.sourceName`, "Le nom de la source est obligatoire."));
    if (!provenance.sourceUrl && !provenance.originalEventUrl && !provenance.externalId) {
      errors.push(issue("provenance_locator_required", prefix, "La provenance doit contenir une URL ou un identifiant externe."));
    }
    for (const field of ["sourceUrl", "originalEventUrl"]) {
      if (provenance[field] && !isValidHttpUrl(provenance[field])) errors.push(issue("url_invalid", `${prefix}.${field}`, "L'URL de provenance doit être HTTP(S)."));
    }
    if (!isValidInstant(provenance.fetchedAt)) errors.push(issue("provenance_fetched_at_invalid", `${prefix}.fetchedAt`, "La date de récupération est obligatoire et doit être une date ISO 8601 avec décalage."));
  });

  activity.externalIds.forEach((externalId, index) => {
    if (!externalId.system || !externalId.value) errors.push(issue("external_id_invalid", `externalIds[${index}]`, "Un identifiant externe exige system et value."));
  });

  for (const [field, value] of [["latitude", activity.latitude], ["longitude", activity.longitude]]) {
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) errors.push(issue("coordinate_not_numeric", field, `${field} doit être un nombre.`));
  }
  if (typeof activity.latitude === "number" && (activity.latitude < -90 || activity.latitude > 90)) errors.push(issue("latitude_out_of_range", "latitude", "La latitude doit être comprise entre -90 et 90."));
  if (typeof activity.longitude === "number" && (activity.longitude < -180 || activity.longitude > 180)) errors.push(issue("longitude_out_of_range", "longitude", "La longitude doit être comprise entre -180 et 180."));

  if (activity.confidence !== null) {
    if (typeof activity.confidence !== "number" || !Number.isFinite(activity.confidence) || activity.confidence < 0 || activity.confidence > 1) {
      errors.push(issue("confidence_out_of_range", "confidence", "confidence doit être un nombre entre 0 et 1."));
    } else if (activity.confidence < LOW_CONFIDENCE_THRESHOLD) {
      warnings.push(issue("confidence_low", "confidence", "La confiance globale est insuffisante pour un traitement sans revue."));
    }
  }

  for (const [field, confidence] of Object.entries(activity.fieldConfidence)) {
    if (!NORMALIZED_ACTIVITY_FIELDS.includes(field)) errors.push(issue("field_confidence_unknown_field", `fieldConfidence.${field}`, "Le champ de confiance ciblé est inconnu."));
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      errors.push(issue("field_confidence_out_of_range", `fieldConfidence.${field}`, "La confiance du champ doit être comprise entre 0 et 1."));
    } else if (confidence < LOW_CONFIDENCE_THRESHOLD) {
      warnings.push(issue("field_confidence_low", `fieldConfidence.${field}`, "Ce champ nécessite une revue."));
    }
  }

  activity.evidence.forEach((evidence, index) => {
    const prefix = `evidence[${index}]`;
    if (!evidence.field || !NORMALIZED_ACTIVITY_FIELDS.includes(evidence.field)) errors.push(issue("evidence_field_invalid", `${prefix}.field`, "La preuve doit cibler un champ connu."));
    if (!evidence.excerpt && !evidence.sourceValue) errors.push(issue("evidence_content_required", prefix, "La preuve doit contenir un extrait ou une valeur source."));
    if (evidence.provenanceIndex !== null && (evidence.provenanceIndex < 0 || evidence.provenanceIndex >= activity.provenances.length)) {
      errors.push(issue("evidence_provenance_invalid", `${prefix}.provenanceIndex`, "La preuve référence une provenance inexistante."));
    }
  });

  const status = errors.length
    ? VALIDATION_STATUSES.INVALID
    : warnings.length
      ? VALIDATION_STATUSES.NEEDS_REVIEW
      : VALIDATION_STATUSES.VALID;

  return { status, activity, errors, warnings };
}

module.exports = {
  normalizeActivity,
  validateNormalizedActivity,
  isValidHttpUrl,
  isValidTimezone
};
