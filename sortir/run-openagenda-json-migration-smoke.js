"use strict";
// Smoke test de migration ICS → JSON, strictement borné aux activités OpenAgenda déjà
// présentes en base (retrouvées via leur uid OpenAgenda extrait des provenances ICS
// existantes). Vérifie qu'aucune duplication n'est créée, que les provenances ICS restent
// intactes, et que le rejeu JSON est idempotent.
//
// Garde-fou volontaire : n'écrit dans Supabase que si CONFIRM_SORTIR_SUPABASE_WRITE=1.
// Usage: CONFIRM_SORTIR_SUPABASE_WRITE=1 node sortir/run-openagenda-json-migration-smoke.js

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { mapOpenAgendaJsonOccurrence } = require("./connectors/openagenda-json");
const { createSupabaseSortirStore, persistSortirIngestion } = require("./supabase-persistence");

const TABLES = ["sortir_sources", "sortir_activities", "sortir_ingestion_runs", "sortir_source_runs", "sortir_provenances", "sortir_external_ids", "sortir_collection_items", "sortir_dedup_decisions"];
const JSON_SOURCES = [
  { key: "openagenda-senlis-json", agendaUid: 56170473, sourceName: "Senlis — Agenda officiel de la ville (JSON)" },
  { key: "openagenda-musees-senlis-json", agendaUid: 26110493, sourceName: "Musées de Senlis (JSON)" }
];

async function execute(builder) { const { data, error, count } = await builder; if (error) throw new Error(error.message); return { data, count }; }
async function tableCounts(client) { const result = {}; for (const table of TABLES) result[table] = (await execute(client.from(table).select("*", { count: "exact", head: true }))).count || 0; return result; }

async function oaApi(agendaUid, params, apiKey) {
  const url = new URL(`https://api.openagenda.com/v2/agendas/${agendaUid}/events`);
  for (const [k, v] of Object.entries(params)) { if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, x)); else url.searchParams.set(k, v); }
  const res = await fetch(url, { headers: { key: apiKey } });
  return { status: res.status, json: await res.json() };
}

function extractEventUid(sourceRecordId) {
  if (!sourceRecordId) return null;
  const idx = sourceRecordId.indexOf("//");
  if (idx < 0) return null;
  const head = sourceRecordId.slice(0, idx);
  return /^\d+$/.test(head) ? Number(head) : null;
}

async function main() {
  if (process.env.CONFIRM_SORTIR_SUPABASE_WRITE !== "1") {
    console.error("Ce script écrit dans la VRAIE base Supabase. Relancez avec CONFIRM_SORTIR_SUPABASE_WRITE=1. Aucune écriture effectuée.");
    process.exitCode = 1;
    return;
  }
  const apiKey = process.env.OPENAGENDA_PUBLIC_KEY;
  if (!apiKey) throw new Error("OPENAGENDA_PUBLIC_KEY absente");
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error("variables Supabase absentes");

  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const store = createSupabaseSortirStore(client);

  console.log("Récupération des activités OpenAgenda (ICS) déjà en base...");
  const { data: icsRows } = await execute(client.from("sortir_provenances").select("activity_id,source_record_id,sortir_sources!inner(connector_type)").eq("sortir_sources.connector_type", "openagenda_ical"));
  const activityIds = [...new Set(icsRows.map((r) => r.activity_id))];
  console.log(`${activityIds.length} activité(s) OpenAgenda (ICS) identifiée(s).`);

  const before = await tableCounts(client);
  const { data: beforeActivities } = await execute(client.from("sortir_activities").select("id,title,record_status").in("id", activityIds));
  const { data: beforeProvenances } = await execute(client.from("sortir_provenances").select("id,activity_id,source_id").in("activity_id", activityIds));
  const beforeStatusById = Object.fromEntries(beforeActivities.map((a) => [a.id, a.record_status]));
  const beforeIcsProvenanceCount = beforeProvenances.length;

  // Reconstruit, pour chaque activité existante, l'occurrence JSON correspondante via son uid
  // OpenAgenda extrait de la provenance ICS — lot strictement borné aux activités déjà connues.
  const eventUidByActivity = new Map();
  for (const row of icsRows) {
    const uid = extractEventUid(row.source_record_id);
    if (uid) eventUidByActivity.set(row.activity_id, uid);
  }
  const uniqueUids = [...new Set(eventUidByActivity.values())];
  console.log(`${uniqueUids.length} uid(s) OpenAgenda distinct(s) à récupérer en JSON.`);

  const resultsBySource = { [JSON_SOURCES[0].key]: [], [JSON_SOURCES[1].key]: [] };
  const { data: activityStarts } = await execute(client.from("sortir_activities").select("id,starts_at").in("id", activityIds));
  const startsById = Object.fromEntries(activityStarts.map((a) => [a.id, a.starts_at]));

  for (const [activityId, eventUid] of eventUidByActivity) {
    let found = null;
    for (const source of JSON_SOURCES) {
      const { status, json } = await oaApi(source.agendaUid, { "uid[]": [eventUid], detailed: 1, monolingual: "fr" }, apiKey);
      if (status === 200 && Array.isArray(json.events) && json.events.length) { found = { event: json.events[0], source }; break; }
    }
    if (!found) { console.log(`  ⚠ uid ${eventUid} introuvable en JSON — ignoré pour ce smoke test.`); continue; }
    const targetIso = new Date(startsById[activityId]).toISOString();
    const timing = (found.event.timings || []).find((t) => new Date(t.begin).toISOString() === targetIso);
    if (!timing) { console.log(`  ⚠ occurrence ${targetIso} introuvable dans les timings JSON de l'uid ${eventUid} — ignoré.`); continue; }
    const { activity } = mapOpenAgendaJsonOccurrence(found.event, timing, { sourceName: found.source.sourceName, sourceUrl: `https://api.openagenda.com/v2/agendas/${found.source.agendaUid}/events`, fetchedAt: new Date().toISOString() });
    resultsBySource[found.source.key].push({ activity });
  }

  const lots = JSON_SOURCES.map((s) => ({ key: s.key, connectorType: "openagenda_json", baseUrl: `https://api.openagenda.com/v2/agendas/${s.agendaUid}/events`, results: resultsBySource[s.key] }));
  const totalOccurrences = lots.reduce((sum, l) => sum + l.results.length, 0);
  console.log(`Lot borné prêt : ${totalOccurrences} occurrence(s) JSON correspondant à des activités déjà connues.`);
  if (!totalOccurrences) { console.log("Rien à persister."); return; }
  console.log("DEBUG lots shape:", JSON.stringify(lots.map((l) => ({ key: l.key, resultsCount: l.results.length, sample: l.results[0] && { hasActivity: Boolean(l.results[0].activity), title: l.results[0].activity && l.results[0].activity.title } })), null, 2));

  console.log("\n=== PREMIÈRE PERSISTANCE JSON ===");
  const first = await persistSortirIngestion({ sources: lots, store });
  const afterFirst = await tableCounts(client);
  console.log("stats:", JSON.stringify(first.stats, null, 2));
  console.log("sources (statut par source, erreurs incluses):", JSON.stringify(first.sources, null, 2));
  console.log("delta vs avant:", JSON.stringify(Object.fromEntries(TABLES.map((t) => [t, afterFirst[t] - before[t]])), null, 2));

  const { data: afterActivities } = await execute(client.from("sortir_activities").select("id,title,record_status").in("id", activityIds));
  const noNewActivityRows = afterActivities.length === beforeActivities.length;
  const statusUnchanged = afterActivities.every((a) => beforeStatusById[a.id] === a.record_status);
  console.log("Aucune nouvelle ligne d'activité (pas de duplication) :", noNewActivityRows, `(${beforeActivities.length} → ${afterActivities.length})`);
  console.log("Aucun changement de statut injustifié :", statusUnchanged);

  const { data: afterIcsProvenances } = await execute(client.from("sortir_provenances").select("id,activity_id,source_id,sortir_sources!inner(connector_type)").in("activity_id", activityIds).eq("sortir_sources.connector_type", "openagenda_ical"));
  console.log("Provenances ICS préservées :", afterIcsProvenances.length === beforeIcsProvenanceCount, `(${beforeIcsProvenanceCount} → ${afterIcsProvenances.length})`);

  const { data: afterAllProvenances } = await execute(client.from("sortir_provenances").select("id,activity_id,source_id,sortir_sources!inner(key)").in("activity_id", activityIds));
  const newJsonProvenances = afterAllProvenances.filter((p) => p.sortir_sources.key.endsWith("-json"));
  console.log(`Nouvelles provenances JSON créées : ${newJsonProvenances.length}`);

  console.log("\n=== REJEU (idempotence) ===");
  const second = await persistSortirIngestion({ sources: lots, store });
  const afterSecond = await tableCounts(client);
  const businessTables = ["sortir_activities", "sortir_provenances", "sortir_external_ids", "sortir_dedup_decisions"];
  const replayDelta = Object.fromEntries(businessTables.map((t) => [t, afterSecond[t] - afterFirst[t]]));
  console.log("delta rejeu (doit être 0 sur les tables métier):", JSON.stringify(replayDelta, null, 2));
  const idempotent = businessTables.every((t) => replayDelta[t] === 0);
  console.log(idempotent ? "✓ Idempotence confirmée." : "✗ ANOMALIE: le rejeu a modifié des tables métier.");

  const sane = noNewActivityRows && statusUnchanged && afterIcsProvenances.length === beforeIcsProvenanceCount && idempotent;
  console.log(sane ? "\n✓✓✓ SMOKE TEST SAIN" : "\n✗✗✗ SMOKE TEST EN ANOMALIE — NE PAS RETIRER ICS");
  if (!sane) process.exitCode = 1;
}

main().catch((error) => { console.error("ERREUR:", error.message, error.stack); process.exitCode = 1; });
