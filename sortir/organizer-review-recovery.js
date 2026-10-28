"use strict";

// Read-only historical eligibility. No store/client, UPDATE, merge or ingestion here.
const { rowToActivity } = require('./supabase-persistence');
const { validateNormalizedActivity } = require('./activity-validation');
const { compareActivities } = require('./activity-deduplication');
const { organizerWarningNonBlocking } = require('./organizer-review-policy');
const { quarantinedBy } = require('./datatourisme-review-quarantine');
const { sameInterval } = require('./datatourisme-occurrence-identity');

function evaluateOrganizerRecovery({ row, candidates, decisions, hasDiagnostic, asOf, toActivity = rowToActivity }) {
  if (!Number.isFinite(Date.parse(asOf))) throw Error('Explicit valid asOf required');
  const retain = reason => ({ id: row.id, decision: 'RETAIN_REVIEW', reason });
  if (!hasDiagnostic) return { id: row.id, decision: 'SKIP', reason: 'diagnostic_not_targeted' };
  if (row.record_status === 'active') return { id: row.id, decision: 'ALREADY_ACTIVE', reason: 'already_active' };
  if (row.record_status !== 'review') return { id: row.id, decision: 'SKIP', reason: 'status_not_review' };
  if (!(Date.parse(row.starts_at) >= Date.parse(asOf) || Date.parse(row.ends_at) > Date.parse(asOf))) return retain('expired');
  if (!['scheduled', 'tentative'].includes(row.lifecycle_status)) return retain('lifecycle_not_publishable');
  if (quarantinedBy(decisions, row.id).length) return retain('pending_quarantine');
  const supports = (row.provenances || []).filter(p => p.active === true);
  if (!supports.length) return retain('no_active_support');
  if (supports.some(p => p.source?.connector_type !== 'datatourisme')) return retain('connector_out_of_scope');
  const activity = toActivity(row), validation = validateNormalizedActivity(activity);
  if (!organizerWarningNonBlocking(validation, 'datatourisme')) return retain('other_validation');
  for (const p of supports) {
    // Both normalized period-v2 and the older flat source payload remain readable.
    const normalized = p.source_payload?.normalized || p.source_payload;
    if (!normalized?.startsAt || !sameInterval(activity, normalized)) return retain('source_interval_unverified');
  }
  for (const e of row.external_ids || []) {
    if (e.system !== 'datatourisme-occurrence') continue;
    const backed = supports.some(p => {
      if (p.source_id !== e.source_id) return false;
      if (p.source_occurrence_key === e.value) return true;
      const base = p.source_record_id;
      return p.source_occurrence_key === `${base}@${new Date(row.starts_at).toISOString()}` &&
        (e.value === base || (row.ends_at && e.value === `${base}:end=${new Date(row.ends_at).toISOString()}`));
    });
    if (!backed) return retain('unsupported_occurrence_id');
  }
  let compared = 0;
  for (const candidate of candidates) {
    if (candidate.id === row.id) continue;
    const result = compareActivities(toActivity(candidate), activity);
    compared++;
    // Historical recovery must never attach/merge an identity, even a proven MATCH.
    if (result.decision !== 'DISTINCT') return { ...retain(result.decision === 'MATCH' ? 'existing_match_requires_resolution' : 'other_engine_review'), candidateId: candidate.id, compared };
  }
  return { id: row.id, decision: 'PROMOTE', reason: 'distinct_only_organizer_warning', compared };
}

module.exports = { evaluateOrganizerRecovery };
