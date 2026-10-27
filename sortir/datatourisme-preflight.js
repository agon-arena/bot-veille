"use strict";
const { sameInterval, sameInstant, provenanceInterval } = require("./datatourisme-occurrence-identity");
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

// Inspect persisted source evidence, never infer an occurrence from the linked activity.
// Unknown identities/evidence block readiness too: skipping them would hide corruption.
function auditDatatourismeProvenances(rows, sourceId) {
  if (!UUID.test(sourceId || "")) throw new Error("Source UUID obligatoire");
  const issues = []; let checked = 0;
  for (const row of rows) {
    if (row.source_id !== sourceId || row.active !== true) continue;
    checked++;
    const record = /^datatourisme:([0-9a-f-]{36}):(.+)$/.exec(row.source_record_id || "");
    const issue = (code, extra = {}) => issues.push({ code, provenanceId: row.id, poiUuid: record?.[1] || null,
      sourceOccurrenceKey: row.source_occurrence_key, activityId: row.activity_id, ...extra });
    if (!record || !UUID.test(record[1]) || !Number.isFinite(Date.parse(record[2])) ||
      !row.source_occurrence_key?.startsWith(`datatourisme:${record[1]}:`)) { issue("occurrence_identity_unknown"); continue; }
    const expected = provenanceInterval(row);
    if (!expected || !Number.isFinite(Date.parse(expected.startsAt)) ||
      (expected.endsAt != null && !Number.isFinite(Date.parse(expected.endsAt)))) { issue("occurrence_interval_unknown"); continue; }
    const start = new Date(expected.startsAt).toISOString();
    const base = `datatourisme:${record[1]}:${start}`;
    const end = expected.endsAt == null ? "unknown" : new Date(expected.endsAt).toISOString();
    if (![base, `${base}@${start}`, `${base}:end=${end}`].includes(row.source_occurrence_key))
      issue("occurrence_key_conflict", { expected });
    if (!sameInstant(record[2], expected.startsAt)) issue("occurrence_identity_conflict", { expected });
    const activity = row.activity;
    if (!activity || activity.id !== row.activity_id) { issue("activity_missing"); continue; }
    const actual = { startsAt: activity.starts_at, endsAt: activity.ends_at };
    if (!sameInterval(expected, actual)) issue("occurrence_interval_mismatch", { expected, actual });
  }
  return { ready: issues.length === 0, checked, issues };
}

async function runDatatourismePreflight({ store, sourceId, pageSize = 500 }) {
  if (!UUID.test(sourceId || "") || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error("Paramètres précontrôle invalides");
  let from = 0, total = null, checked = 0; const issues = [], seen = new Set();
  while (true) {
    const page = await store.loadActivePage(sourceId, from, pageSize);
    if (!Array.isArray(page.rows) || !Number.isInteger(page.count) || page.count < 0 ||
      (total !== null && total !== page.count) || page.rows.length > pageSize ||
      page.rows.some(r => r.source_id !== sourceId || r.active !== true || !r.id || seen.has(r.id))) throw new Error("Précontrôle : pagination incohérente");
    total = page.count;
    for (const r of page.rows) { if (seen.has(r.id)) throw new Error("Précontrôle : provenance dupliquée"); seen.add(r.id); }
    if (from + page.rows.length > total || (from + page.rows.length < total && page.rows.length !== pageSize)) throw new Error("Précontrôle : pagination incomplète");
    const result = auditDatatourismeProvenances(page.rows, sourceId); checked += result.checked; issues.push(...result.issues);
    from += page.rows.length;
    if (from === total) break;
  }
  if (typeof store.loadActivityPage !== "function") throw new Error("Précontrôle activités obligatoire");
  {
    const activities = []; const ids = new Set(); let offset = 0, count = null;
    while (true) {
      const page = await store.loadActivityPage(offset, pageSize);
      if (!Array.isArray(page.rows) || !Number.isInteger(page.count) || page.count < 0 ||
        (count !== null && count !== page.count) || page.rows.length > pageSize ||
        page.rows.some(r => !r.id || ids.has(r.id) || !["active", "review"].includes(r.record_status))) throw new Error("Pagination activités incohérente");
      count = page.count;
      for (const row of page.rows) { if (ids.has(row.id)) throw new Error("Activité dupliquée"); ids.add(row.id); }
      offset += page.rows.length;
      if (offset > count || (offset < count && page.rows.length !== pageSize)) throw new Error("Pagination activités incomplète");
      activities.push(...page.rows);
      if (offset === count) break;
    }
    // REVIEW decisions (pending AND resolved): the only proof that a signature collision is a
    // documented quarantine. Fail closed if they cannot be read completely.
    if (typeof store.loadReviewDecisionPage !== "function") throw new Error("Précontrôle décisions REVIEW obligatoire");
    const decisions = []; const decisionIds = new Set(); let at = 0, decisionCount = null;
    while (true) {
      const page = await store.loadReviewDecisionPage(at, pageSize);
      if (!Array.isArray(page.rows) || !Number.isInteger(page.count) || page.count < 0 ||
        (decisionCount !== null && decisionCount !== page.count) || page.rows.length > pageSize ||
        page.rows.some(r => !r.id || decisionIds.has(r.id) || r.decision !== "REVIEW")) throw new Error("Pagination décisions incohérente");
      decisionCount = page.count;
      for (const row of page.rows) decisionIds.add(row.id);
      at += page.rows.length;
      if (at > decisionCount || (at < decisionCount && page.rows.length !== pageSize)) throw new Error("Pagination décisions incomplète");
      decisions.push(...page.rows);
      if (at === decisionCount) break;
    }
    const safety = require("./datatourisme-activity-safety").auditActivitySafety(activities, { decisions });
    issues.push(...safety.issues);
    return { ready: issues.length === 0, checked, checkedActivities: safety.checkedActivities, checkedDecisions: decisions.length,
      pendingIdentityReviews: safety.quarantines.length, abandonedQuarantines: safety.abandonedQuarantines, issues };
  }
  return { ready: issues.length === 0, checked, issues };
}

function createSupabaseDatatourismePreflightStore(client) {
  return { async loadActivityPage(from, size) {
    const { data, count, error } = await client.from("sortir_activities")
      .select("id,title,description,starts_at,ends_at,timezone,city,record_status,external_ids:sortir_external_ids(source_id,system,value),provenances:sortir_provenances(id,source_id,active,original_event_url,source_record_id,source_occurrence_key)", { count: "exact" })
      .in("record_status", ["active", "review"]).order("id").range(from, from + size - 1);
    if (error) throw new Error(error.message);
    return { rows: data, count };
  }, async loadReviewDecisionPage(from, size) {
    const { data, count, error } = await client.from("sortir_dedup_decisions")
      .select("id,left_activity_id,right_activity_id,decision,review_status,algorithm_version,signals", { count: "exact" })
      .eq("decision", "REVIEW").order("id").range(from, from + size - 1);
    if (error) throw new Error(error.message);
    return { rows: data, count };
  }, async loadActivePage(sourceId, from, size) {
    const { data, count, error } = await client.from("sortir_provenances")
      .select("id,source_id,active,source_record_id,source_occurrence_key,activity_id,source_payload,activity:sortir_activities(id,starts_at,ends_at,record_status)", { count: "exact" })
      .eq("source_id", sourceId).eq("active", true).order("id").range(from, from + size - 1);
    if (error) throw new Error(error.message);
    return { rows: data, count };
  } };
}
module.exports = { auditDatatourismeProvenances, runDatatourismePreflight, createSupabaseDatatourismePreflightStore };
