"use strict";

// Identity belongs to the source occurrence, never to mutable merged activity dates.
function sameInstant(a, b) {
  return a == null && b == null || a != null && b != null &&
    Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
}
function sameInterval(a, b) {
  return sameInstant(a.startsAt, b.startsAt) && sameInstant(a.endsAt, b.endsAt);
}
function provenanceInterval(row) {
  const payload = row.source_payload;
  const value = payload?.normalized || payload;
  return value && typeof value.startsAt === "string" && "endsAt" in value ? value : null;
}
function matchesLegacyOccurrence(row, item) {
  const interval = provenanceInterval(row);
  return row.source_record_id === item.sourceRecordId &&
    row.source_occurrence_key === item.legacySourceOccurrenceKey &&
    interval !== null && sameInterval(interval, item.activity);
}
const UNSPECIFIED_START = "DATAtourisme : heure de début absente dans la période source.";
function hasUnspecifiedStart(activity) {
  return (activity.evidence || []).some(e => e.field === "startsAt" && e.excerpt === UNSPECIFIED_START);
}
module.exports = { sameInstant, sameInterval, provenanceInterval, matchesLegacyOccurrence, UNSPECIFIED_START, hasUnspecifiedStart };
