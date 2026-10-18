"use strict";

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { fetchOpenAgendaIcal } = require("./connectors/openagenda-ical");
const { createSupabaseSortirStore, persistSortirIngestion } = require("./supabase-persistence");

const SOURCE_KEY = "openagenda-senlis";
const SOURCE_URL = "https://openagenda.com/agendas/56170473/events.v2.ics?relative%5B%5D=current&relative%5B%5D=upcoming";
const TABLES = ["sortir_sources", "sortir_activities", "sortir_ingestion_runs", "sortir_source_runs", "sortir_provenances", "sortir_external_ids", "sortir_collection_items", "sortir_dedup_decisions"];

function assert(condition, message) { if (!condition) throw new Error(`ANOMALIE: ${message}`); }
async function query(client, builder) { const { data, error, count } = await builder; if (error) throw new Error(error.message); return { data, count }; }
async function counts(client) {
  const result = {};
  for (const table of TABLES) result[table] = (await query(client, client.from(table).select("*", { count: "exact", head: true }))).count || 0;
  return result;
}
function delta(before, after) { return Object.fromEntries(TABLES.map((table) => [table, after[table] - before[table]])); }

async function inspectRun(client, runId, occurrenceKeys) {
  const ingestion = (await query(client, client.from("sortir_ingestion_runs").select("*").eq("id", runId).single())).data;
  const source = (await query(client, client.from("sortir_sources").select("*").eq("key", SOURCE_KEY).single())).data;
  const sourceRun = (await query(client, client.from("sortir_source_runs").select("*").eq("ingestion_run_id", runId).eq("source_id", source.id).single())).data;
  const provenances = (await query(client, client.from("sortir_provenances").select("*").eq("source_id", source.id).in("source_occurrence_key", occurrenceKeys))).data || [];
  const activityIds = [...new Set(provenances.map((item) => item.activity_id))];
  const activities = activityIds.length ? (await query(client, client.from("sortir_activities").select("id,title,starts_at,lifecycle_status,record_status,merged_into_id").in("id", activityIds))).data || [] : [];
  const externalIds = activityIds.length ? (await query(client, client.from("sortir_external_ids").select("activity_id,source_id,system,value").eq("source_id", source.id).in("activity_id", activityIds))).data || [] : [];
  const items = (await query(client, client.from("sortir_collection_items").select("id,activity_id,provenance_id,validation_status").eq("source_run_id", sourceRun.id))).data || [];
  return { ingestion, source, sourceRun, provenances, activities, externalIds, items };
}

function verify(snapshot, occurrenceKeys) {
  assert(snapshot.ingestion.status === "completed", `ingestion ${snapshot.ingestion.status}`);
  assert(snapshot.sourceRun.status === "completed", `source run ${snapshot.sourceRun.status}`);
  assert(snapshot.ingestion.collected_count === 5 && snapshot.ingestion.valid_count === 5 && snapshot.ingestion.invalid_count === 0, "compteurs ingestion incohérents");
  assert(snapshot.sourceRun.collected_count === 5 && snapshot.sourceRun.valid_count === 5 && snapshot.sourceRun.invalid_count === 0, "compteurs source incohérents");
  assert(snapshot.provenances.length === 5, `${snapshot.provenances.length} provenances au lieu de 5`);
  assert(new Set(snapshot.provenances.map((p) => `${p.source_record_id || ""}\u0000${p.source_occurrence_key}`)).size === 5, "provenances dupliquées");
  assert(new Set(snapshot.provenances.map((p) => p.source_occurrence_key)).size === occurrenceKeys.length, "clés d'occurrence dupliquées");
  assert(snapshot.provenances.every((p) => p.active && p.activity_id), "provenance inactive ou orpheline");
  assert(snapshot.activities.length === 5, `${snapshot.activities.length} activités au lieu de 5`);
  assert(snapshot.activities.every((a) => a.record_status === "active" && !a.merged_into_id), "activité non active ou absorbée de façon inattendue");
  assert(snapshot.externalIds.length === 5, `${snapshot.externalIds.length} external IDs au lieu de 5`);
  assert(new Set(snapshot.externalIds.map((id) => `${id.source_id}\u0000${id.system}\u0000${id.value}\u0000${id.activity_id}`)).size === snapshot.externalIds.length, "external IDs dupliqués");
  assert(snapshot.items.length === 5 && snapshot.items.every((item) => item.validation_status === "VALID" && item.activity_id && item.provenance_id), "journal incomplet");
}

async function main() {
  assert(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY, "variables Supabase absentes");
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const store = createSupabaseSortirStore(client);
  const fetchedAt = new Date().toISOString();
  const results = await fetchOpenAgendaIcal({ sourceName: "Senlis — Agenda officiel de la ville", sourceUrl: SOURCE_URL, defaultTimezone: "Europe/Paris", country: "FR", limit: 5, fetchedAt });
  assert(results.length === 5, `${results.length} événements collectés`);
  assert(results.every((result) => !result.error && result.validation && result.validation.status === "VALID"), "les 5 événements ne sont pas tous VALID");
  const occurrenceKeys = results.map((result) => `${result.activity.provenances[0].externalId}@${result.activity.startsAt}`);
  assert(new Set(occurrenceKeys).size === 5, "les 5 clés d'occurrence ne sont pas uniques");
  const descriptor = { key: SOURCE_KEY, connectorType: "openagenda_ical", baseUrl: SOURCE_URL, results };

  const before = await counts(client);
  const first = await persistSortirIngestion({ sources: [descriptor], store });
  const afterFirst = await counts(client);
  const firstSnapshot = await inspectRun(client, first.ingestionRunId, occurrenceKeys);
  verify(firstSnapshot, occurrenceKeys);

  const firstActivityIds = firstSnapshot.activities.map((item) => item.id).sort();
  const firstProvenanceIds = firstSnapshot.provenances.map((item) => item.id).sort();
  const firstExternalIds = firstSnapshot.externalIds.map((item) => `${item.activity_id}:${item.source_id}:${item.system}:${item.value}`).sort();

  const second = await persistSortirIngestion({ sources: [descriptor], store });
  const afterSecond = await counts(client);
  const secondSnapshot = await inspectRun(client, second.ingestionRunId, occurrenceKeys);
  verify(secondSnapshot, occurrenceKeys);
  assert(JSON.stringify(secondSnapshot.activities.map((item) => item.id).sort()) === JSON.stringify(firstActivityIds), "les IDs d'activité ont changé au retry");
  assert(JSON.stringify(secondSnapshot.provenances.map((item) => item.id).sort()) === JSON.stringify(firstProvenanceIds), "les IDs de provenance ont changé au retry");
  assert(JSON.stringify(secondSnapshot.externalIds.map((item) => `${item.activity_id}:${item.source_id}:${item.system}:${item.value}`).sort()) === JSON.stringify(firstExternalIds), "les external IDs ont changé au retry");
  const secondDelta = delta(afterFirst, afterSecond);
  assert(secondDelta.sortir_activities === 0 && secondDelta.sortir_provenances === 0 && secondDelta.sortir_external_ids === 0 && secondDelta.sortir_dedup_decisions === 0, "le retry a créé des données métier supplémentaires");

  console.log(JSON.stringify({ sourceKey: SOURCE_KEY, occurrenceKeys, first: { result: first, delta: delta(before, afterFirst), activities: firstSnapshot.activities, provenances: firstSnapshot.provenances.length, externalIds: firstSnapshot.externalIds.length, collectionItems: firstSnapshot.items.length }, second: { result: second, delta: secondDelta, activities: secondSnapshot.activities.length, provenances: secondSnapshot.provenances.length, externalIds: secondSnapshot.externalIds.length, collectionItems: secondSnapshot.items.length }, idempotent: true }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
