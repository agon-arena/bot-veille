"use strict";
// Outil manuel d'intégration — PAS un test automatique, PAS exécuté par un test runner.
// Persiste dans la VRAIE base Supabase le petit lot de recoupement réel détecté par
// run-dedup-recoupement-diagnostic.js (quelques occurrences au maximum), puis rejoue exactement
// le même lot pour vérifier l'idempotence. N'écrit jamais ailleurs que sur ce lot borné.
//
// Garde-fou volontaire : n'écrit dans Supabase que si CONFIRM_SORTIR_SUPABASE_WRITE=1 est défini,
// pour éviter toute exécution accidentelle (ex. script lancé par erreur, balayage automatisé).
//
// Usage: CONFIRM_SORTIR_SUPABASE_WRITE=1 node sortir/run-dedup-recoupement-smoke.js

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { discoverRecoupement, DEFAULT_SOURCE_A, DEFAULT_SOURCE_B } = require("./run-dedup-recoupement-diagnostic");
const { createSupabaseSortirStore, persistSortirIngestion } = require("./supabase-persistence");

const TABLES = ["sortir_sources", "sortir_activities", "sortir_ingestion_runs", "sortir_source_runs", "sortir_provenances", "sortir_external_ids", "sortir_collection_items", "sortir_dedup_decisions"];

async function execute(builder) { const { data, error, count } = await builder; if (error) throw new Error(error.message); return { data, count }; }
async function tableCounts(client) { const result = {}; for (const table of TABLES) result[table] = (await execute(client.from(table).select("*", { count: "exact", head: true }))).count || 0; return result; }

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function toResults(pairs, side) {
  const seen = new Set();
  const items = [];
  for (const pair of pairs) {
    const item = side === "a" ? pair.a : pair.b;
    if (seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }
  return items;
}

async function main() {
  if (process.env.CONFIRM_SORTIR_SUPABASE_WRITE !== "1") {
    console.error("Ce script écrit dans la VRAIE base Supabase. Relancez avec CONFIRM_SORTIR_SUPABASE_WRITE=1 pour confirmer explicitement. Aucun appel réseau ni écriture n'a été effectué.");
    process.exitCode = 1;
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error("variables Supabase absentes");

  console.log("Recherche d'un recoupement réel entre les deux agendas...");
  const { caseA, caseB, control } = await discoverRecoupement(DEFAULT_SOURCE_A, DEFAULT_SOURCE_B);
  const pairs = [...caseA, ...caseB, ...control];
  if (!pairs.length) {
    console.log("Aucun recoupement trouvé dans ce run — rien à persister, aucune écriture effectuée.");
    return;
  }
  const resultsA = deepFreeze(toResults(pairs, "a"));
  const resultsB = deepFreeze(toResults(pairs, "b"));
  console.log(`Lot borné : ${resultsA.length} occurrence(s) source A, ${resultsB.length} occurrence(s) source B (${caseA.length} doublon(s), ${caseB.length} quasi-doublon(s), ${control.length} contrôle(s)).`);

  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const store = createSupabaseSortirStore(client);
  const lots = [
    { key: DEFAULT_SOURCE_A.key, connectorType: "openagenda_json", baseUrl: `https://api.openagenda.com/v2/agendas/${DEFAULT_SOURCE_A.agendaUid}/events`, results: resultsA },
    { key: DEFAULT_SOURCE_B.key, connectorType: "openagenda_json", baseUrl: `https://api.openagenda.com/v2/agendas/${DEFAULT_SOURCE_B.agendaUid}/events`, results: resultsB }
  ];

  const before = await tableCounts(client);
  console.log("Avant:", JSON.stringify(before, null, 2));

  const first = await persistSortirIngestion({ sources: lots, store });
  const afterFirst = await tableCounts(client);
  console.log("Résultat 1ère persistance:", JSON.stringify(first.stats, null, 2));
  console.log("Delta 1ère persistance:", JSON.stringify(Object.fromEntries(TABLES.map((t) => [t, afterFirst[t] - before[t]])), null, 2));

  const second = await persistSortirIngestion({ sources: lots, store });
  const afterSecond = await tableCounts(client);
  const businessTables = ["sortir_activities", "sortir_provenances", "sortir_external_ids", "sortir_dedup_decisions"];
  const replayDelta = Object.fromEntries(businessTables.map((t) => [t, afterSecond[t] - afterFirst[t]]));
  console.log("Delta rejeu (doit être 0 sur les tables métier):", JSON.stringify(replayDelta, null, 2));
  const idempotent = businessTables.every((t) => replayDelta[t] === 0);
  console.log(idempotent ? "✓ Idempotence confirmée." : "✗ ANOMALIE: le rejeu a modifié des tables métier.");
  if (!idempotent) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error("ERREUR:", error.message); process.exitCode = 1; });

module.exports = { main };
