"use strict";

// Couche d'orchestration MINCE pour l'ingestion quotidienne Sortir/OpenAgenda : ne duplique
// ni le connecteur, ni la validation, ni la persistance — appelle exactement le même pipeline
// que les scripts de validation réelle (fetchOpenAgendaJsonEvents + persistSortirIngestion).
// Déclenchée par un tick HTTP externe (voir server.js /api/sortir-ingest-tick), exactement le
// même patron que /api/auto-collect-tick déjà en place pour la veille presse.
//
// Périmètre initial volontairement restreint à une seule source déjà validée en conditions
// réelles : Mobilizon, Paris et les anciens agendas OpenAgenda ne sont pas branchés ici.

const { createClient } = require("@supabase/supabase-js");
const { fetchOpenAgendaJsonEvents } = require("./sortir/connectors/openagenda-json");
const { persistSortirIngestion, createDefaultSupabaseStore } = require("./sortir/supabase-persistence");

const SORTIR_AGENDA_UID = 56170473;
const SORTIR_SOURCE_KEY = "openagenda-senlis-json";
const SORTIR_SOURCE_URL = `https://api.openagenda.com/v2/agendas/${SORTIR_AGENDA_UID}/events`;
const SORTIR_SOURCE_NAME = "Senlis — Agenda officiel de la ville";

// Indian/Reunion = UTC+4 fixe, pas d'heure d'été (même constante que server.js). 04:00 Réunion
// = 00:00 UTC. Heure creuse choisie par défaut ; pas de contrainte technique mesurée imposant
// une autre heure à ce stade (la réingestion d'un lot déjà connu prend ~6-10 s en conditions
// réelles, voir validation du 18/10/2026).
const SORTIR_INGEST_HOUR = "04:00";
// Même tolérance que /api/auto-collect-tick (incident du 10/07/2026 : GitHub Actions a sauté
// des ticks sous charge) — réutilisée telle quelle plutôt que d'en inventer une nouvelle sans
// donnée justifiant une valeur différente.
const SORTIR_INGEST_TOLERANCE_MIN = 40;
// "Déjà exécuté aujourd'hui" = un run complété pour cette source dans les 20 heures qui
// précèdent — évite tout calcul de frontière de journée civile Réunion/UTC (source d'erreurs
// bien plus probable qu'un vrai double déclenchement à moins de 20h d'écart pour un job
// quotidien unique).
const SORTIR_RECENT_RUN_LOOKBACK_MS = 20 * 60 * 60 * 1000;

// Garde anti-double-exécution SIMULTANÉE, dans CE process. ingestionQueue (supabase-
// persistence.js) sérialise déjà les écritures : deux appels à persistSortirIngestion() ne
// s'exécutent jamais en parallèle, mais rien n'empêche un deuxième appel d'être lancé pendant
// que le premier tourne encore (il se mettrait juste en attente, puis s'exécuterait quand même
// — gaspillage d'un appel OpenAgenda, sans risque de corruption grâce à l'idempotence, mais
// évitable). ingestionQueue ne protège pas non plus entre deux PROCESS/instances différents :
// c'est AUTO_PIPELINES_ENABLED (server.js), pas ce module, qui réserve l'exécution à Render.
let inFlight = false;

function isDue(nowMinutes, scheduledMinutes, toleranceMin) {
  return nowMinutes >= scheduledMinutes && nowMinutes - scheduledMinutes < toleranceMin;
}

function getSupabaseClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function hasRecentCompletedRun(client, sinceIso) {
  const { data: source, error: sourceError } = await client.from("sortir_sources").select("id").eq("key", SORTIR_SOURCE_KEY).maybeSingle();
  if (sourceError) throw new Error(sourceError.message);
  if (!source) return false; // source jamais créée : jamais exécuté
  const { data: runs, error: runsError } = await client.from("sortir_source_runs").select("id").eq("source_id", source.id).eq("status", "completed").gte("started_at", sinceIso).limit(1);
  if (runsError) throw new Error(runsError.message);
  return Array.isArray(runs) && runs.length > 0;
}

// Toutes les dépendances réelles sont injectables, jamais invoquées tant que l'appelant
// n'appelle pas explicitement cette fonction (aucun effet de bord au require() du module).
async function runSortirIngestTickIfDue({
  now = new Date(),
  timeToMinutes,
  getReunionTimeHHMM,
  client = null,
  fetchEvents = fetchOpenAgendaJsonEvents,
  persist = persistSortirIngestion,
  store = null
} = {}) {
  const nowMin = timeToMinutes(getReunionTimeHHMM());
  if (!isDue(nowMin, timeToMinutes(SORTIR_INGEST_HOUR), SORTIR_INGEST_TOLERANCE_MIN)) {
    return { triggered: false, reason: "not due" };
  }
  if (inFlight) {
    return { triggered: false, reason: "already running" };
  }
  // Posé AVANT tout await : si le verrou n'était posé qu'après la vérification « déjà
  // exécuté » (elle-même asynchrone), deux ticks arrivant à quelques millisecondes d'écart
  // passeraient tous les deux le test ci-dessus avant que l'un des deux n'ait eu la chance de
  // poser le verrou — fenêtre de course fermée en le posant ici, synchrone.
  inFlight = true;

  const activeClient = client || getSupabaseClient();
  try {
    const since = new Date(now.getTime() - SORTIR_RECENT_RUN_LOOKBACK_MS).toISOString();
    if (await hasRecentCompletedRun(activeClient, since)) {
      inFlight = false;
      return { triggered: false, reason: "already run recently" };
    }
  } catch (error) {
    inFlight = false;
    console.error("[sortir-auto-ingest] Vérification « déjà exécuté » impossible :", error.message);
    return { triggered: false, reason: "check failed", error: error.message };
  }

  const startedAt = Date.now();
  // Ne JAMAIS attendre la fin réelle du pipeline avant de répondre : une ingestion avec
  // beaucoup d'occurrences réellement nouvelles peut prendre plusieurs minutes (mesuré en
  // conditions réelles le 18/10/2026, ~5 min pour 180 nouvelles activités), largement au-delà
  // du --max-time du tick GitHub Actions. Même patron que /api/auto-collect-tick, qui ne
  // bloque pas non plus sur le /refresh qu'il déclenche. workPromise reste exposé pour les
  // tests (qui veulent attendre la fin de façon déterministe), jamais attendu par la route HTTP.
  const workPromise = (async () => {
    try {
      const { results } = await fetchEvents({
        agendaUid: SORTIR_AGENDA_UID, apiKey: process.env.OPENAGENDA_PUBLIC_KEY, maxEvents: 200,
        sourceName: SORTIR_SOURCE_NAME, fetchedAt: new Date().toISOString()
      });
      const descriptor = { key: SORTIR_SOURCE_KEY, connectorType: "openagenda_json", baseUrl: SORTIR_SOURCE_URL, results };
      const activeStore = store || createDefaultSupabaseStore();
      const result = await persist({ store: activeStore, sources: [descriptor] });
      const summary = { status: result.status, stats: result.stats, durationMs: Date.now() - startedAt };
      console.log("[sortir-auto-ingest] Ingestion quotidienne terminée :", JSON.stringify(summary));
      return summary;
    } catch (error) {
      // Capturé ici, jamais relancé : une panne réseau Supabase/OpenAgenda transitoire (déjà
      // observée en conditions réelles) ne doit jamais faire tomber le process serveur. Le run
      // suivant (demain) reste inchangé.
      console.error("[sortir-auto-ingest] Échec de l'ingestion quotidienne (capturé) :", error.message);
      return { status: "failed", error: error.message, durationMs: Date.now() - startedAt };
    } finally {
      inFlight = false;
    }
  })();
  workPromise.catch(() => {}); // filet explicite : déjà entièrement catché ci-dessus, mais jamais de rejection non gérée si personne n'attend workPromise.

  return { triggered: true, status: "started", workPromise };
}

module.exports = {
  runSortirIngestTickIfDue,
  isDue,
  hasRecentCompletedRun,
  SORTIR_AGENDA_UID,
  SORTIR_SOURCE_KEY,
  SORTIR_SOURCE_URL,
  SORTIR_SOURCE_NAME,
  SORTIR_INGEST_HOUR,
  SORTIR_INGEST_TOLERANCE_MIN,
  SORTIR_RECENT_RUN_LOOKBACK_MS
};
