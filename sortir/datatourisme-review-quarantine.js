"use strict";
// REVIEW quarantine: an ambiguous source representation stored as its own non-publishable
// activity, linked to each ambiguous candidate by a pending REVIEW decision. The decision
// signals carry the durable trace below; the review status alone proves nothing (it is
// also used for editorial incompleteness).
const { sameInterval } = require("./datatourisme-occurrence-identity");

const QUARANTINE_SIGNAL = "review_quarantine";
const QUARANTINE_VERSION = 1;

function quarantineSignal({ quarantinedActivityId, candidateActivityId, sourceId, metadata, activity }) {
  return { type: QUARANTINE_SIGNAL, version: QUARANTINE_VERSION, reason: "identity_ambiguous",
    quarantinedActivityId, candidateActivityId, sourceId,
    sourceRecordId: metadata.sourceRecordId, sourceOccurrenceKey: metadata.sourceOccurrenceKey,
    startsAt: activity.startsAt, endsAt: activity.endsAt ?? null, timezone: activity.timezone ?? null,
    externalIds: (activity.externalIds || []).map(({ system, value }) => ({ system, value })) };
}
function quarantineMarker(decision) {
  return (Array.isArray(decision?.signals) ? decision.signals : []).find(s => s?.type === QUARANTINE_SIGNAL) || null;
}
const involves = (decision, id) => decision.left_activity_id === id || decision.right_activity_id === id;
const isPendingReview = d => d.decision === "REVIEW" && d.review_status === "pending";
// Decisions written before the quarantine trace existed do not say which side was the
// ambiguous newcomer: both sides stay protected from automatic publication.
function quarantinedBy(decisions, activityId) {
  return (decisions || []).filter(d => isPendingReview(d) && involves(d, activityId) &&
    (quarantineMarker(d)?.quarantinedActivityId === activityId || !quarantineMarker(d)));
}
// Status for a stale activity brought back by its own source: never publish a quarantine.
function reactivationStatus(activityId, decisions) {
  return quarantinedBy(decisions, activityId).length ? "review" : "active";
}

function evaluateQuarantine(activity, decisions) {
  const markers = (decisions || []).filter(d => isPendingReview(d) && quarantineMarker(d)?.quarantinedActivityId === activity.id);
  if (!markers.length) return { quarantined: false, complete: false, issues: [] };
  const issues = [], issue = (code, extra = {}) => issues.push({ code, activityId: activity.id, ...extra });
  if (activity.record_status !== "review") issue(activity.record_status === "active" ? "quarantine_published" : "quarantine_not_in_review", { recordStatus: activity.record_status });
  const provenances = activity.provenances || [], externalIds = activity.external_ids || [];
  for (const decision of markers) {
    const m = quarantineMarker(decision), at = { decisionId: decision.id, sourceOccurrenceKey: m.sourceOccurrenceKey };
    if (m.version !== QUARANTINE_VERSION || !m.candidateActivityId || m.candidateActivityId === activity.id ||
      !involves(decision, m.candidateActivityId) || !decision.algorithm_version ||
      !decision.signals.some(s => s?.type && s.type !== QUARANTINE_SIGNAL)) { issue("quarantine_trace_invalid", at); continue; }
    if (!provenances.some(p => p.active === true && p.source_id === m.sourceId && p.source_record_id === m.sourceRecordId &&
      p.source_occurrence_key === m.sourceOccurrenceKey)) issue("quarantine_provenance_missing", at);
    if (!sameInterval({ startsAt: activity.starts_at, endsAt: activity.ends_at }, { startsAt: m.startsAt, endsAt: m.endsAt })) issue("quarantine_interval_mismatch", at);
    if ((activity.timezone ?? null) !== (m.timezone ?? null)) issue("quarantine_timezone_mismatch", at);
    if (!Array.isArray(m.externalIds) || !m.externalIds.length) issue("quarantine_trace_invalid", at);
    else for (const e of m.externalIds) if (!externalIds.some(x => x.system === e.system && x.value === e.value && (x.source_id == null || x.source_id === m.sourceId)))
      issue("quarantine_external_id_missing", { ...at, system: e.system, value: e.value });
  }
  // Every DATAtourisme identity carried by the quarantine must be backed by its own provenance.
  for (const e of externalIds) {
    const ok = e.system === "datatourisme-occurrence" ? provenances.some(p => p.source_occurrence_key === e.value)
      : e.system === "datatourisme-poi" ? provenances.some(p => p.source_record_id?.startsWith(`datatourisme:${e.value}:`)) : true;
    if (!ok) issue("quarantine_external_id_unsupported", { system: e.system, value: e.value });
  }
  return { quarantined: true, complete: issues.length === 0, issues };
}
// A signature collision is documented only by a DIRECT pending decision designating one side
// as a complete, non-publishable quarantine. A human DISTINCT resolution is proof as well.
function documentedPair(a, b, decisions, evaluations) {
  for (const d of decisions || []) {
    if (!(involves(d, a.id) && involves(d, b.id))) continue;
    if (d.decision === "REVIEW" && d.review_status === "confirmed_distinct") return "confirmed_distinct";
    const m = isPendingReview(d) && quarantineMarker(d);
    if (!m || ![a.id, b.id].includes(m.quarantinedActivityId) || ![a.id, b.id].includes(m.candidateActivityId)) continue;
    if (evaluations.get(m.quarantinedActivityId)?.complete) return "review_quarantine";
  }
  return null;
}

module.exports = { QUARANTINE_SIGNAL, QUARANTINE_VERSION, quarantineSignal, quarantineMarker, quarantinedBy, reactivationStatus, evaluateQuarantine, documentedPair, isPendingReview };
