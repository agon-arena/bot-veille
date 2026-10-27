"use strict";
const { normalizedText, distinctNamedDatatourismeVisits } = require("./activity-deduplication");
const Q = require("./datatourisme-review-quarantine");
// A signature is a safety signal, never proof that two source events are identical.
function activitySignature(row) {
  if (!row.title || !Number.isFinite(Date.parse(row.starts_at)) || !row.city) return null;
  return JSON.stringify([normalizedText(row.title), Date.parse(row.starts_at),
    row.ends_at == null ? null : Date.parse(row.ends_at), normalizedText(row.city)]);
}
// Before INSERT: an identical signature may only become a REVIEW quarantine, i.e. every
// colliding candidate gets its own pending REVIEW decision (written by the pipeline right
// after the staging INSERT). Any other collision stays undocumented and blocks.
function guardExactSignatureReview({ row, comparisons, decision }) {
  if (decision !== "REVIEW") return;
  const signature = activitySignature(row);
  const conflicts = comparisons.filter(c => signature && activitySignature(c.candidate) === signature &&
    c.result?.decision !== "REVIEW" &&
    !(c.result?.decision === "DISTINCT" && c.result.signals?.some(s => s.type === "datatourisme_distinct_named_visits")));
  if (conflicts.length) throw new Error(`Signature REVIEW à arbitrer avant INSERT : ${conflicts.map(c => c.candidate.id).join(",")}`);
}
// `decisions`: REVIEW decisions (pending and resolved) touching the audited activities.
// A signature group passes only if each pair is proven distinct or documented by a DIRECT
// decision designating one side as a complete, non-publishable quarantine.
function auditActivitySafety(activities, { interruptedActivityIds = [], decisions = [] } = {}) {
  const issues = [], groups = new Map(), interrupted = new Set(interruptedActivityIds), evaluations = new Map();
  const live = new Set(activities.filter(a => ["active", "review"].includes(a.record_status)).map(a => a.id));
  for (const row of activities) {
    if (!["active", "review"].includes(row.record_status)) continue;
    const supports = row.provenances || [];
    // These are persisted ingestion activities: an active/review record requires support.
    if (!supports.some(p => p.active === true)) issues.push({ code: "activity_without_active_provenance", activityId: row.id });
    const evaluation = Q.evaluateQuarantine(row, decisions);
    evaluations.set(row.id, evaluation);
    if (evaluation.quarantined && !evaluation.complete) issues.push({ code: "quarantine_incomplete", activityId: row.id, details: evaluation.issues });
    const signature = activitySignature(row);
    if (signature) { if (!groups.has(signature)) groups.set(signature, []); groups.get(signature).push(row); }
  }
  for (const [signature, rows] of groups) if (rows.length > 1) {
    const unresolved = rows.some(r => interrupted.has(r.id) || !(r.provenances || []).some(p => p.active));
    const documented = !unresolved && rows.every((a, i) => rows.slice(i + 1).every(b =>
      distinctNamedDatatourismeVisits(a, b) || Q.documentedPair(a, b, decisions, evaluations)));
    if (documented) continue;
    issues.push({ code: unresolved ? "interrupted_duplicate_signature" : "duplicate_signature_requires_review",
      signature, activityIds: rows.map(r => r.id) });
  }
  const quarantines = [...evaluations].filter(([, e]) => e.quarantined && e.complete).map(([id]) => id);
  // Trace of an interrupted staging (stale/merged: never published, never coverage).
  const abandonedQuarantines = decisions.filter(d => Q.isPendingReview(d) && Q.quarantineMarker(d) &&
    !live.has(Q.quarantineMarker(d).quarantinedActivityId)).map(d => ({ decisionId: d.id, activityId: Q.quarantineMarker(d).quarantinedActivityId }));
  return { ready: issues.length === 0, checkedActivities: activities.length, issues, quarantines, abandonedQuarantines };
}
module.exports = { activitySignature, guardExactSignatureReview, auditActivitySafety };
