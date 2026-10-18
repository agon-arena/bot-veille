"use strict";

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { fetchOpenAgendaIcal } = require("./connectors/openagenda-ical");
const { fetchMobilizonEvents } = require("./connectors/mobilizon");
const { fetchParisEvents } = require("./connectors/paris-events");
const { createSupabaseSortirStore, persistSortirIngestion } = require("./supabase-persistence");

const OA_URL = "https://openagenda.com/agendas/56170473/events.v2.ics?relative%5B%5D=current&relative%5B%5D=upcoming";
const MZ_URL = "https://mobilizon.picasoft.net/api";
const PARIS_URL = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records";
const TABLES = ["sortir_sources", "sortir_activities", "sortir_ingestion_runs", "sortir_source_runs", "sortir_provenances", "sortir_external_ids", "sortir_collection_items", "sortir_dedup_decisions"];

function assert(value, message) { if (!value) throw new Error(`ANOMALIE: ${message}`); }
async function execute(builder) { const { data, error, count } = await builder; if (error) throw new Error(error.message); return { data, count }; }
async function tableCounts(client) { const result = {}; for (const table of TABLES) result[table] = (await execute(client.from(table).select("*", { count: "exact", head: true }))).count || 0; return result; }
function delta(before, after) { return Object.fromEntries(TABLES.map((table) => [table, after[table] - before[table]])); }
function occurrenceKey(result) {
  const a = result.validation.activity;
  return result.sourceOccurrenceKey || `${result.sourceRecordId || a.provenances[0].externalId || a.provenances[0].originalEventUrl}@${a.startsAt}`;
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

async function collect() {
  const fetchedAt = new Date().toISOString();
  const [oa, mzPayload, parisPayload] = await Promise.all([
    fetchOpenAgendaIcal({ sourceName: "Senlis — Agenda officiel de la ville", sourceUrl: OA_URL, defaultTimezone: "Europe/Paris", country: "FR", limit: 5, fetchedAt }),
    fetchMobilizonEvents({ endpoint: MZ_URL, sourceName: "Mobilizon Picasoft", beginsOn: fetchedAt, limit: 5, fetchedAt }),
    fetchParisEvents({ endpoint: PARIS_URL, limit: 5, fetchedAt })
  ]);
  const lots = [
    { key: "openagenda-senlis", connectorType: "openagenda_ical", baseUrl: OA_URL, results: oa },
    { key: "mobilizon-picasoft", connectorType: "mobilizon", baseUrl: MZ_URL, results: mzPayload.results },
    { key: "paris-data-que-faire", connectorType: "paris_data", baseUrl: PARIS_URL, results: parisPayload.results }
  ];
  for (const lot of lots) {
    assert(lot.results.length === 5, `${lot.key}: ${lot.results.length} résultats au lieu de 5`);
    assert(lot.results.every((result) => !result.error && result.validation && result.validation.status !== "INVALID"), `${lot.key}: résultat invalide ou en erreur`);
    lot.occurrenceKeys = lot.results.map(occurrenceKey);
    assert(new Set(lot.occurrenceKeys).size === 5, `${lot.key}: clés d'occurrence non uniques`);
  }
  return deepFreeze(lots);
}

async function inspect(client, runId, lots) {
  const ingestion = (await execute(client.from("sortir_ingestion_runs").select("*").eq("id", runId).single())).data;
  const keys = lots.map((lot) => lot.key);
  const sources = (await execute(client.from("sortir_sources").select("id,key").in("key", keys))).data || [];
  const sourceIds = sources.map((source) => source.id);
  const sourceRuns = (await execute(client.from("sortir_source_runs").select("*").eq("ingestion_run_id", runId).in("source_id", sourceIds))).data || [];
  const wanted = new Set(lots.flatMap((lot) => lot.occurrenceKeys));
  const provenances = ((await execute(client.from("sortir_provenances").select("*").in("source_id", sourceIds))).data || []).filter((p) => wanted.has(p.source_occurrence_key));
  const activityIds = [...new Set(provenances.map((p) => p.activity_id))];
  const activities = activityIds.length ? (await execute(client.from("sortir_activities").select("id,title,starts_at,lifecycle_status,record_status,merged_into_id").in("id", activityIds))).data || [] : [];
  const externalIds = activityIds.length ? (await execute(client.from("sortir_external_ids").select("activity_id,source_id,system,value").in("source_id", sourceIds).in("activity_id", activityIds))).data || [] : [];
  const items = sourceRuns.length ? (await execute(client.from("sortir_collection_items").select("id,source_run_id,activity_id,provenance_id,validation_status").in("source_run_id", sourceRuns.map((run) => run.id)))).data || [] : [];
  const decisions = activityIds.length ? (await execute(client.from("sortir_dedup_decisions").select("*").or(`left_activity_id.in.(${activityIds.join(",")}),right_activity_id.in.(${activityIds.join(",")})`))).data || [] : [];
  return { ingestion, sources, sourceRuns, provenances, activities, externalIds, items, decisions };
}

async function verifyGlobalIntegrity(client) {
  const activities = (await execute(client.from("sortir_activities").select("id,record_status,merged_into_id"))).data || [];
  const provenances = (await execute(client.from("sortir_provenances").select("id,activity_id,source_id,source_record_id,source_occurrence_key"))).data || [];
  const activityIds = new Set(activities.map((activity) => activity.id));
  assert(provenances.every((p) => activityIds.has(p.activity_id)), "provenance pointant vers une activité absente");
  const withProvenance = new Set(provenances.map((p) => p.activity_id));
  assert(activities.filter((a) => a.record_status !== "merged").every((a) => withProvenance.has(a.id)), "activité non fusionnée sans provenance");
  const tuples = provenances.map((p) => `${p.source_id}\u0000${p.source_record_id || ""}\u0000${p.source_occurrence_key}`);
  assert(new Set(tuples).size === tuples.length, "tuple de provenance dupliqué");
  assert(activities.filter((a) => a.record_status === "merged").every((a) => a.merged_into_id && activityIds.has(a.merged_into_id)), "activité merged sans canonique valide");
}

function verifyRun(snapshot, lots) {
  const statuses = lots.flatMap((lot) => lot.results.map((result) => result.validation.status));
  const valid = statuses.filter((status) => status === "VALID").length;
  const review = statuses.filter((status) => status === "NEEDS_REVIEW").length;
  const expectedExternalIds = lots.flatMap((lot) => lot.results).reduce((sum, result) => sum + result.activity.externalIds.length, 0);
  assert(snapshot.ingestion.status === "completed", `ingestion ${snapshot.ingestion.status}`);
  assert(snapshot.ingestion.collected_count === 15 && snapshot.ingestion.valid_count === valid && snapshot.ingestion.needs_review_count === review && snapshot.ingestion.invalid_count === 0, "compteurs ingestion incohérents");
  assert(snapshot.sourceRuns.length === 3 && snapshot.sourceRuns.every((run) => run.status === "completed" && run.collected_count === 5 && run.invalid_count === 0), "source runs incohérents");
  assert(snapshot.provenances.length === 15 && snapshot.provenances.every((p) => p.active && p.activity_id), "provenances incomplètes ou inactives");
  assert(new Set(snapshot.provenances.map((p) => p.id)).size === 15, "provenances dupliquées");
  assert(snapshot.activities.length === 15, `${snapshot.activities.length} activités au lieu de 15`);
  assert(snapshot.activities.filter((a) => a.record_status === "active").length === valid, "nombre d'activités active incohérent");
  assert(snapshot.activities.filter((a) => a.record_status === "review").length === review, "nombre d'activités review incohérent");
  assert(snapshot.activities.every((a) => ["active", "review"].includes(a.record_status) && !a.merged_into_id), "activité stale/merged inattendue");
  assert(snapshot.externalIds.length === expectedExternalIds, `${snapshot.externalIds.length} external IDs au lieu de ${expectedExternalIds}`);
  assert(snapshot.items.length === 15 && snapshot.items.every((item) => item.activity_id && item.provenance_id), "journal incomplet");
  assert(snapshot.decisions.every((decision) => decision.decision !== "MATCH" || decision.review_status === "not_required"), "décision MATCH incohérente");
  return { valid, review, expectedExternalIds };
}

function identities(snapshot) {
  return {
    activities: snapshot.activities.map((x) => `${x.id}:${x.record_status}:${x.merged_into_id || ""}`).sort(),
    provenances: snapshot.provenances.map((x) => `${x.id}:${x.source_id}:${x.source_record_id || ""}:${x.source_occurrence_key}:${x.activity_id}:${x.active}`).sort(),
    externalIds: snapshot.externalIds.map((x) => `${x.activity_id}:${x.source_id}:${x.system}:${x.value}`).sort(),
    decisions: snapshot.decisions.map((x) => x.id).sort()
  };
}

function verifyReplayDelta(value, label) {
  assert(value.sortir_activities === 0 && value.sortir_provenances === 0 && value.sortir_external_ids === 0 && value.sortir_dedup_decisions === 0, `création métier inutile au ${label}`);
}

async function replayAndVerify({ client, store, lots, expectedIdentities, before, label }) {
  const result = await persistSortirIngestion({ sources: lots, store });
  const after = await tableCounts(client);
  const snapshot = await inspect(client, result.ingestionRunId, lots);
  verifyRun(snapshot, lots);
  await verifyGlobalIntegrity(client);
  assert(JSON.stringify(identities(snapshot)) === JSON.stringify(expectedIdentities), `identités métier modifiées au ${label}`);
  const replayDelta = delta(before, after);
  verifyReplayDelta(replayDelta, label);
  return { result, after, snapshot, delta: replayDelta };
}

async function main() {
  assert(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY, "variables Supabase absentes");
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const store = createSupabaseSortirStore(client);
  const lots = await collect();
  const before = await tableCounts(client);
  const first = await persistSortirIngestion({ sources: lots, store });
  const afterFirst = await tableCounts(client);
  const firstSnapshot = await inspect(client, first.ingestionRunId, lots);
  const expected = verifyRun(firstSnapshot, lots);
  await verifyGlobalIntegrity(client);
  const firstIds = identities(firstSnapshot);

  const second = await replayAndVerify({ client, store, lots, expectedIdentities: firstIds, before: afterFirst, label: "second run" });
  const third = await replayAndVerify({ client, store, lots, expectedIdentities: firstIds, before: second.after, label: "troisième run" });
  const summarize = (result, snapshot, runDelta) => ({ result, delta: runDelta, statuses: Object.fromEntries(["active", "review", "stale", "merged"].map((status) => [status, snapshot.activities.filter((a) => a.record_status === status).length])), provenances: snapshot.provenances.length, externalIds: snapshot.externalIds.length });
  console.log(JSON.stringify({
    lots: lots.map((lot) => ({ source: lot.key, events: lot.results.map((result) => ({ title: result.validation.activity.title, startsAt: result.validation.activity.startsAt, occurrenceKey: occurrenceKey(result), status: result.validation.status })) })),
    counts: { before, afterFirst, afterSecond: second.after, afterThird: third.after }, expected,
    first: { ...summarize(first, firstSnapshot, delta(before, afterFirst)), decisions: firstSnapshot.decisions.map((d) => d.decision) },
    second: summarize(second.result, second.snapshot, second.delta),
    third: summarize(third.result, third.snapshot, third.delta),
    stableIdentities: true, idempotent: true
  }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { occurrenceKey, deepFreeze };
