"use strict";

// Contrat central du pipeline Sortir. Ce module ne collecte, ne déduplique et ne publie
// rien : il définit uniquement la forme commune produite par les futurs connecteurs.

const LOCATION_TYPES = Object.freeze(["physical", "online", "hybrid"]);
const LIFECYCLE_STATUSES = Object.freeze(["scheduled", "tentative", "cancelled", "postponed"]);
const ADMISSION_TYPES = Object.freeze(["free", "paid", "mixed", "unknown"]);
const VALIDATION_STATUSES = Object.freeze({
  VALID: "VALID",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  INVALID: "INVALID"
});

const MAX_TITLE_LENGTH = 200;
const LOW_CONFIDENCE_THRESHOLD = 0.6;

// Liste volontairement courte : category/subcategory restent des chaînes libres afin de
// ne pas figer prématurément la taxonomie Sortir.
const SUGGESTED_CATEGORIES = Object.freeze([
  "culture",
  "loisirs",
  "sport",
  "rencontres",
  "citoyenneté/politique"
]);

const NORMALIZED_ACTIVITY_FIELDS = Object.freeze([
  "title", "description", "startsAt", "endsAt", "timezone",
  "lifecycleStatus",
  "locationType", "venueName", "address", "postalCode", "city", "country",
  "latitude", "longitude", "onlineUrl", "organizers", "category", "subcategory",
  "tags", "provenances", "externalIds", "imageUrl", "bookingUrl", "admissionType", "confidence",
  "fieldConfidence", "evidence"
]);

function createNormalizedActivity(overrides = {}) {
  return {
    title: null,
    description: null,
    startsAt: null,
    endsAt: null,
    timezone: null,
    lifecycleStatus: "scheduled",
    locationType: null,
    venueName: null,
    address: null,
    postalCode: null,
    city: null,
    country: null,
    latitude: null,
    longitude: null,
    onlineUrl: null,
    organizers: [],
    category: null,
    subcategory: null,
    tags: [],
    provenances: [],
    externalIds: [],
    imageUrl: null,
    bookingUrl: null,
    admissionType: "unknown",
    confidence: null,
    fieldConfidence: {},
    evidence: [],
    ...overrides
  };
}

module.exports = {
  LOCATION_TYPES,
  LIFECYCLE_STATUSES,
  ADMISSION_TYPES,
  VALIDATION_STATUSES,
  MAX_TITLE_LENGTH,
  LOW_CONFIDENCE_THRESHOLD,
  SUGGESTED_CATEGORIES,
  NORMALIZED_ACTIVITY_FIELDS,
  createNormalizedActivity
};
