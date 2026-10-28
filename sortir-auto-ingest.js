"use strict";

// Couche d'orchestration MINCE pour l'ingestion quotidienne Sortir : ne duplique ni les
// connecteurs, ni la validation, ni la persistance/dédoublonnage — appelle le même pipeline que les
// scripts de validation réelle, par LOTS SÉQUENTIELS plutôt qu'un unique appel global, pour
// borner la mémoire quel que soit le nombre de sources à terme (voir l'audit du 19/10/2026).
//
// Déclenchée par un tick HTTP externe (voir server.js /api/sortir-ingest-tick), même patron que
// /api/auto-collect-tick déjà en place pour la veille presse.

const { createClient } = require("@supabase/supabase-js");
const { fetchOpenAgendaJsonEvents } = require("./sortir/connectors/openagenda-json");
const { fetchDatatourismeEvents } = require("./sortir/connectors/datatourisme");
const { createSchedulerState, CYCLE_VERSION } = require("./sortir/scheduler-state");
const { REUNION_SOURCES, runReunionProducer } = require("./sortir/openagenda-reunion-daily");
const { persistSortirIngestion, createDefaultSupabaseStore } = require("./sortir/supabase-persistence");

// --- OpenAgenda : liste des agendas configurés (étape de validation multi-sources : Senlis +
// 2 agendas réels supplémentaires déjà vérifiés avec de vrais événements le 19/10/2026 — pas
// encore une couverture nationale, voir l'audit). ---
const OPENAGENDA_SOURCES = [
  { key: "openagenda-senlis-json", agendaUid: 56170473, sourceName: "Senlis — Agenda officiel de la ville" },
  { key: "openagenda-musees-senlis-json", agendaUid: 26110493, sourceName: "Musées de Senlis" },
  { key: "openagenda-mediatheque-senlis-json", agendaUid: 60837943, sourceName: "Médiathèque municipale de Senlis" }
];
// Taille conservée pour l'utilitaire historique runOpenAgendaBatches. Le scheduler quotidien
// appelle cet utilitaire avec un producteur à la fois pour isoler collecte et persistance.
const OPENAGENDA_BATCH_SIZE = Number.isInteger(Number(process.env.SORTIR_OPENAGENDA_BATCH_SIZE)) && Number(process.env.SORTIR_OPENAGENDA_BATCH_SIZE) > 0
  ? Number(process.env.SORTIR_OPENAGENDA_BATCH_SIZE) : 10;
const OPENAGENDA_MAX_EVENTS_PER_AGENDA = 200; // inchangé par rapport à l'ancien comportement Senlis seul.

// --- DATAtourisme : UN SEUL source.key logique pour tout le territoire national, quelle que
// soit la façon dont les requêtes sont chunkées côté connecteur (voir l'audit : ne jamais créer
// une source par département/région, qui multiplierait inutilement le coût fixe par source). ---
const DATATOURISME_SOURCE_KEY = "datatourisme-national";
const DATATOURISME_BASE_URL = "https://api.datatourisme.fr/v1/entertainmentAndEvent";
const DATATOURISME_SOURCE_NAME = "DATAtourisme — France";
const DATATOURISME_CHUNK_SIZE = Number.isInteger(Number(process.env.SORTIR_DATATOURISME_CHUNK_SIZE)) && Number(process.env.SORTIR_DATATOURISME_CHUNK_SIZE) > 0
  ? Number(process.env.SORTIR_DATATOURISME_CHUNK_SIZE) : 100;
// Limite PILOTE stricte pour cette étape de validation : quelques centaines de POI au maximum,
// jamais une couverture nationale complète (voir consigne explicite). Mettre à 0 désactive
// totalement DATAtourisme dans le cycle quotidien (comportement de repli si la clé API est
// absente, ou si on veut revenir au périmètre OpenAgenda seul sans toucher au code).
const DATATOURISME_MAX_TOTAL_POIS_PILOT = Number.isInteger(Number(process.env.SORTIR_DATATOURISME_MAX_TOTAL_POIS)) && Number(process.env.SORTIR_DATATOURISME_MAX_TOTAL_POIS) >= 0
  ? Number(process.env.SORTIR_DATATOURISME_MAX_TOTAL_POIS) : 300;
// IMPORTANT (point vérifié explicitement avant d'activer DATAtourisme réellement, voir le
// rapport joint à cette étape) : applyDisappearances() marque une provenance comme disparue si
// elle n'a pas été revue depuis `staleAfterMs` (7 jours par défaut), PAS "si elle n'a pas été
// vue par CE run précis" — le chunking par pagination est donc déjà compatible avec DES CHUNKS
// SÉQUENTIELS DANS LA MÊME EXÉCUTION (aucune provenance n'est fausse-positive marquée disparue
// tant que le passage complet du catalogue reste nettement plus rapide que staleAfterMs).
// CE QUI N'EST PAS ENCORE GARANTI à cette étape : qu'une exécution quotidienne future couvre
// un jour la TOTALITÉ du catalogue national dans la fenêtre de 7 jours, même avec le
// curseur désormais persisté entre les exécutions du scheduler. Tant que ce n'est pas
// garanti, un staleAfterMs très large pour CETTE SEULE
// source évite tout faux positif de disparition, sans modifier ni contourner
// persistSortirIngestionUnlocked/applyDisappearances : c'est un PARAMÈTRE déjà prévu à cet
// effet, pas un bricolage. À resserrer explicitement le jour où la couverture complète du
// catalogue national est garantie à chaque cycle.
const DATATOURISME_STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

// Indian/Reunion = UTC+4 fixe, pas d'heure d'été (même constante que server.js). 04:00 Réunion
// = 00:00 UTC. Heure creuse choisie par défaut ; pas de contrainte technique mesurée imposant
// une autre heure à ce stade (la réingestion d'un lot déjà connu prend ~6-10 s en conditions
// réelles, voir validation du 18/10/2026).
const SORTIR_INGEST_HOUR = "04:00";
// Même tolérance que /api/auto-collect-tick (incident du 10/07/2026 : GitHub Actions a sauté
// des ticks sous charge) — réutilisée telle quelle plutôt que d'en inventer une nouvelle sans
// donnée justifiant une valeur différente.
const SORTIR_INGEST_TOLERANCE_MIN = 40;
// Un run enveloppe completed par producteur dans les 20 dernières heures certifie son passage.
const SORTIR_RECENT_RUN_LOOKBACK_MS = 20 * 60 * 60 * 1000;

// Verrou local rapide, complété par le verrou atomique partagé scheduler-state.js.
let inFlight = false;

function isDue(nowMinutes, scheduledMinutes, toleranceMin) {
  return nowMinutes >= scheduledMinutes && nowMinutes - scheduledMinutes < toleranceMin;
}

function getSupabaseClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function hasRecentCompletedRun(client, sinceIso, sourceKey) {
  const { data: source, error: sourceError } = await client.from("sortir_sources").select("id").eq("key", sourceKey).maybeSingle();
  if (sourceError) throw new Error(sourceError.message);
  if (!source) return false; // source jamais créée : jamais exécuté
  const { data: runs, error: runsError } = await client.from("sortir_source_runs").select("id").eq("source_id", source.id).eq("status", "completed").gte("started_at", sinceIso).limit(1);
  if (runsError) throw new Error(runsError.message);
  return Array.isArray(runs) && runs.length > 0;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function heapUsedMB() { return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10; }

// Traite les agendas OpenAgenda configurés par LOTS SÉQUENTIELS : ne précharge JAMAIS les
// événements de tous les agendas avant de commencer -- seuls les événements du lot COURANT sont
// récupérés juste avant son ingestion, puis le lot suivant n'est même construit qu'une fois le
// précédent entièrement persisté (await explicite). Les références du lot traité (descripteurs,
// résultats bruts du connecteur) sont réassignées à null entre deux lots pour ne retenir aucune
// référence inutile une fois le lot persisté -- le ramasse-miettes peut alors les libérer.
async function runOpenAgendaBatches({ sources, batchSize, fetchEvents, persist, store, now, onBatchSummary }) {
  const batches = chunkArray(sources, batchSize);
  const summaries = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    let batch = batches[batchIndex];
    const heapBeforeMB = heapUsedMB();
    const fetchStartedAt = Date.now();
    let descriptors = [];
    let eventsCollected = 0;
    for (const source of batch) {
      const fetched = await fetchEvents({
        agendaUid: source.agendaUid, apiKey: process.env.OPENAGENDA_PUBLIC_KEY,
        maxEvents: OPENAGENDA_MAX_EVENTS_PER_AGENDA, sourceName: source.sourceName, now, fetchedAt: now.toISOString()
      });
      if (fetched.truncated) throw new Error(`Lecture OpenAgenda tronquée : ${source.key}`);
      const { results } = fetched;
      eventsCollected += fetched.fetchedCount ?? new Set(results.map(r => r.sourcePayload?.eventUid).filter(Boolean)).size;
      descriptors.push({ key: source.key, connectorType: "openagenda_json", baseUrl: `https://api.openagenda.com/v2/agendas/${source.agendaUid}/events`, results });
    }
    const fetchDurationMs = Date.now() - fetchStartedAt;
    const poisFetched = descriptors.reduce((sum, d) => sum + d.results.length, 0);

    const persistStartedAt = Date.now();
    const result = await persist({ store, sources: descriptors, now });
    const persistDurationMs = Date.now() - persistStartedAt;
    const heapAfterMB = heapUsedMB();

    const summary = {
      type: "openagenda", batchIndex, sourcesCount: batch.length,
      poisFetched, eventsCollected, occurrencesRetained: poisFetched, activitiesProduced: poisFetched,
      fetchDurationMs, persistDurationMs, totalDurationMs: fetchDurationMs + persistDurationMs,
      heapUsedBeforeMB: heapBeforeMB, heapUsedAfterMB: heapAfterMB,
      status: result.status, stats: result.stats
    };
    console.log("[sortir-auto-ingest] lot OpenAgenda :", JSON.stringify(summary));
    if (onBatchSummary) onBatchSummary(summary);
    summaries.push(summary);
    // Libère explicitement les références de ce lot avant de passer au suivant (demandé
    // explicitement) : descriptors/batch deviennent éligibles au ramasse-miettes dès cette
    // itération terminée, plutôt que de rester vivants jusqu'à la fin de toute la boucle.
    descriptors = null;
    batch = null;
  }
  return summaries;
}

// Traite DATAtourisme par CHUNKS DE PAGINATION séquentiels, sous un seul source.key logique
// (jamais une source par département/région, voir l'audit). Chaque chunk est entièrement
// persisté (et sa mémoire libérée) avant que le chunk suivant ne soit récupéré -- jamais
// l'intégralité du catalogue accumulée en mémoire. `staleAfterMs` est volontairement très large
// pour cette source (voir DATATOURISME_STALE_AFTER_MS) tant que la couverture complète du
// catalogue national entre deux exécutions n'est pas garantie.
async function runDatatourismeChunks({ apiKey, maxTotalPois, chunkSize, persist, store, now, fetchChunk, onChunkSummary }) {
  if (!apiKey || !maxTotalPois) {
    return { skipped: true, reason: !apiKey ? "no api key" : "maxTotalPois=0", summaries: [] };
  }
  const summaries = [];
  // UNE lecture, au tout début du cycle -- jamais relue ensuite (resumeUrl est tenu à jour en
  // mémoire pour le reste de la boucle).
  let resumeUrl = await store.getSourceCursor(DATATOURISME_SOURCE_KEY);
  let totalFetched = 0;
  let chunkIndex = 0;
  while (totalFetched < maxTotalPois) {
    const remaining = maxTotalPois - totalFetched;
    const heapBeforeMB = heapUsedMB();
    const fetchStartedAt = Date.now();
    let chunk;
    let cursorWasInvalid = false;
    try {
      chunk = await fetchChunk({ apiKey, resumeUrl, maxEvents: Math.min(chunkSize, remaining), sourceName: DATATOURISME_SOURCE_NAME, now });
    } catch (error) {
      if (!resumeUrl) throw error; // page 1 elle-même échoue : vraie panne, pas un problème de curseur.
      // Curseur potentiellement invalide (expiré, format changé par l'API entre deux jours...) :
      // repli immédiat sur un redémarrage propre depuis la première page, jamais un blocage
      // définitif de l'ingestion quotidienne.
      console.error("[sortir-auto-ingest] Curseur DATAtourisme invalide, reprise depuis le début :", error.message);
      cursorWasInvalid = true;
      resumeUrl = null;
      chunk = await fetchChunk({ apiKey, resumeUrl: null, maxEvents: Math.min(chunkSize, remaining), sourceName: DATATOURISME_SOURCE_NAME, now });
    }
    const fetchDurationMs = Date.now() - fetchStartedAt;

    let descriptor = { key: DATATOURISME_SOURCE_KEY, connectorType: "datatourisme", baseUrl: DATATOURISME_BASE_URL, results: chunk.results, refusedPoiUuids: chunk.refusedPoiUuids || [] };
    const persistStartedAt = Date.now();
    const result = await persist({ store, sources: [descriptor], now, staleAfterMs: DATATOURISME_STALE_AFTER_MS });
    const persistDurationMs = Date.now() - persistStartedAt;
    const heapAfterMB = heapUsedMB();

    totalFetched += chunk.fetchedCount;
    chunkIndex += 1;
    const summary = {
      type: "datatourisme", chunkIndex, poisFetched: chunk.fetchedCount, activitiesProduced: chunk.results.length, refusedPois: (chunk.refusedPoiUuids || []).length,
      // Compteurs du connecteur (fenêtre 90 j + plafond 30), pas des warnings : la persistance
      // revalide chaque activité et ne conserve pas les warnings du connecteur.
      occurrenceSelection: chunk.occurrenceStats || null,
      fetchDurationMs, persistDurationMs, totalDurationMs: fetchDurationMs + persistDurationMs,
      heapUsedBeforeMB: heapBeforeMB, heapUsedAfterMB: heapAfterMB,
      status: result.status, stats: result.stats, exhausted: chunk.exhausted, cursorWasInvalid,
      cursorBefore: resumeUrl, cursorAfter: null, cursorAdvanced: false
    };

    if (result.status === "completed") {
      // Le curseur n'avance QU'APRÈS la persistance réussie de CE chunk : si le process
      // s'arrête avant cette ligne (crash, panne réseau...), le prochain cycle relira l'ANCIEN
      // curseur (jamais mis à jour) et rejouera ce même chunk -- sans danger grâce à
      // l'idempotence déjà validée. exhausted=true -> curseur remis à null : le cycle suivant
      // repart proprement du début pour revisiter progressivement tout le catalogue.
      const newCursor = chunk.exhausted ? null : chunk.nextPageUrl;
      await store.saveSourceCursor(DATATOURISME_SOURCE_KEY, newCursor); // UNE écriture, seulement ici.
      resumeUrl = newCursor;
      summary.cursorAfter = newCursor;
      summary.cursorAdvanced = true;
      console.log("[sortir-auto-ingest] chunk DATAtourisme :", JSON.stringify(summary));
      if (onChunkSummary) onChunkSummary(summary);
      summaries.push(summary);
    } else {
      console.error("[sortir-auto-ingest] chunk DATAtourisme non persisté (status=" + result.status + "), curseur inchangé pour permettre le rejeu :", JSON.stringify(result.stats));
      if (onChunkSummary) onChunkSummary(summary);
      summaries.push(summary);
      descriptor = null;
      break; // le prochain cycle reprendra avec le MÊME curseur qu'avant ce chunk.
    }
    descriptor = null;

    if (chunk.exhausted || chunk.fetchedCount === 0) break;
  }
  return { skipped: false, summaries };
}

// Compteurs observés sur les primitives réelles, sans changer la logique de persistance.
function measuredStore(store) {
  const created = new Set(), updated = new Set();
  const proxy = new Proxy(store, { get(target, key) {
    const fn = target[key];
    if (typeof fn !== "function") return fn;
    return async (...args) => {
      const result = await fn.apply(target, args);
      if (key === "createActivity") created.add(result.id);
      if (key === "createActivitiesBatch") for (const row of result) created.add(row.id);
      if (key === "updateActivity" || key === "markActivityMerged") updated.add(args[0]);
      if (key === "flipActivitiesBatch") for (const id of args[0]) updated.add(id);
      return result;
    };
  } });
  return { store: proxy, counts: () => ({ activitiesCreated: created.size, activitiesUpdated: [...updated].filter(id => !created.has(id)).length }) };
}
async function scheduledSource({ source, store, now, work, onBatchSummary }) {
  let ingestion, sourceRun;
  const started = Date.now(), measured = measuredStore(store);
  let result;
  try {
    ingestion = await store.createIngestionRun({ status: "running", orchestrator_version: CYCLE_VERSION, started_at: now.toISOString() });
    const registered = await store.ensureSource(source);
    sourceRun = await store.createSourceRun({ ingestion_run_id: ingestion.id, source_id: registered.id, status: "running", started_at: now.toISOString() });
    result = await work(measured.store);
  } catch (error) {
    result = { eventsCollected: null, eventsRetained: null, occurrencesRetained: null, ...error.details, status: "failed", error: error.message };
  }
  result = { ...result, source: source.key, startedAt: now.toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started, ...measured.counts() };
  const stats = result.stats || {};
  const journalRow = () => ({ status: result.status, collected_count: stats.collected || 0, valid_count: stats.VALID || 0,
    needs_review_count: stats.NEEDS_REVIEW || 0, invalid_count: stats.INVALID || 0, finished_at: result.finishedAt });
  try {
    if (sourceRun) await store.updateSourceRun(sourceRun.id, { ...journalRow(), error: result.status === "completed" ? null : JSON.stringify({ error: result.error || "Persistance incomplète", result }) });
  } catch (error) { result.status = "failed"; result.error = `${result.error || ""} Journal source : ${error.message}`; }
  // Toujours tenter de fermer le run enveloppe, même si la mise à jour source a échoué.
  try {
    if (ingestion) await store.updateIngestionRun(ingestion.id, { ...journalRow(), error_summary: result.status === "completed" ? [] : [{ source: source.key, error: result.error || "Persistance incomplète" }] });
  } catch (error) { result.status = "failed"; result.error = `${result.error || ""} Journal ingestion : ${error.message}`; }
  console[result.status === "completed" ? "log" : "error"]("[sortir-auto-ingest] producteur :", JSON.stringify(result));
  if (onBatchSummary) { try { await onBatchSummary(result); } catch (error) { result.reportingError = error.message; console.error("[sortir-auto-ingest] Callback de suivi :", error.message); } }
  return result;
}

// Un seul tick et un seul verrou partagé ; reprise indépendante de chaque producteur complet.
async function runSortirIngestTickIfDue({
  now = new Date(), timeToMinutes, getReunionTimeHHMM, client = null,
  fetchEvents = fetchOpenAgendaJsonEvents, fetchDatatourisme = fetchDatatourismeEvents,
  persist = persistSortirIngestion, store = null, state = null,
  openAgendaSources = OPENAGENDA_SOURCES, reunionSources = REUNION_SOURCES,
  fetchReunionEvents = fetchOpenAgendaJsonEvents, fetchReunionSchema,
  datatourismeMaxTotalPois = DATATOURISME_MAX_TOTAL_POIS_PILOT,
  datatourismeChunkSize = DATATOURISME_CHUNK_SIZE, onBatchSummary = null
} = {}) {
  if (!isDue(timeToMinutes(getReunionTimeHHMM()), timeToMinutes(SORTIR_INGEST_HOUR), SORTIR_INGEST_TOLERANCE_MIN)) return { triggered: false, reason: "not due" };
  if (inFlight) return { triggered: false, reason: "already running" };
  inFlight = true;
  let schedulerState, locked = false, activeStore, jobs;
  try {
    schedulerState = state || createSchedulerState(client || getSupabaseClient());
    locked = await schedulerState.acquire(now);
    if (!locked) { inFlight = false; return { triggered: false, reason: "scheduler locked" }; }
    if (await schedulerState.hasOtherRunning()) {
      await schedulerState.release(new Date()); locked = false; inFlight = false;
      return { triggered: false, reason: "another ingestion running" };
    }
    activeStore = store || createDefaultSupabaseStore();
    const legacy = openAgendaSources.map(source => ({ source: { ...source, connectorType: "openagenda_json", baseUrl: `https://api.openagenda.com/v2/agendas/${source.agendaUid}/events` },
      work: async target => (await runOpenAgendaBatches({ sources: [source], batchSize: 1, fetchEvents, persist, store: target, now }))[0] }));
    jobs = [...legacy, ...reunionSources.map(source => ({ source,
      work: target => runReunionProducer({ source, store: target, now, fetchEvents: fetchReunionEvents, fetchSchema: fetchReunionSchema }) }))];
    if (process.env.DATATOURISME_API_KEY && datatourismeMaxTotalPois) jobs.push({ source: { key: DATATOURISME_SOURCE_KEY, connectorType: "datatourisme", baseUrl: DATATOURISME_BASE_URL },
      work: async target => {
        const outcome = await runDatatourismeChunks({ apiKey: process.env.DATATOURISME_API_KEY, maxTotalPois: datatourismeMaxTotalPois,
          chunkSize: datatourismeChunkSize, persist, store: target, now, fetchChunk: fetchDatatourisme });
        const statuses = outcome.summaries.map(s => s.status);
        return { ...outcome, status: statuses.every(s => s === "completed") ? "completed" : "partial",
          stats: outcome.summaries.reduce((a, s) => { for (const k of ["collected", "VALID", "NEEDS_REVIEW", "INVALID", "merged", "toReview"]) a[k] = (a[k] || 0) + (s.stats?.[k] || 0); return a; }, {}) };
      } });
    const since = new Date(now.getTime() - SORTIR_RECENT_RUN_LOOKBACK_MS).toISOString();
    const pending = [];
    for (const job of jobs) {
      try { if (!await schedulerState.recent(job.source.key, since)) pending.push(job); }
      catch (error) { pending.push({ ...job, work: async () => { throw new Error(`Contrôle de reprise impossible : ${error.message}`); } }); }
    }
    jobs = pending;
    if (!jobs.length) {
      await schedulerState.release(new Date()); locked = false; inFlight = false;
      return { triggered: false, reason: "already run recently" };
    }
  } catch (error) {
    if (locked) { try { await schedulerState.release(new Date()); } catch (releaseError) { console.error("[sortir-auto-ingest] Libération verrou :", releaseError.message); } }
    inFlight = false;
    console.error("[sortir-auto-ingest] Préparation impossible :", error.message);
    return { triggered: false, reason: "check failed", error: error.message };
  }
  const startedAt = Date.now();
  const workPromise = (async () => {
    const summaries = [];
    let releaseError;
    try {
      for (const job of jobs) {
        try { summaries.push(await scheduledSource({ ...job, store: activeStore, now, onBatchSummary })); }
        catch (error) {
          const failure = { source: job.source.key, status: "failed", error: error.message };
          summaries.push(failure);
          console.error("[sortir-auto-ingest] Échec inattendu du producteur :", JSON.stringify(failure));
        }
      }
    } finally {
      try { await schedulerState.release(new Date()); } catch (error) { releaseError = error.message; console.error("[sortir-auto-ingest] Libération verrou :", releaseError); }
      inFlight = false;
    }
    const completed = summaries.filter(s => s.status === "completed").length;
    let status = "failed";
    if (completed === summaries.length) status = "completed";
    else if (completed || summaries.some(s => s.status === "partial")) status = "partial";
    if (summaries.some(s => s.reportingError)) status = "partial";
    if (releaseError) status = "failed";
    const summary = {
      status, durationMs: Date.now() - startedAt,
      error: releaseError || summaries.filter(s => s.status !== "completed" || s.reportingError)
        .map(s => `${s.source}: ${s.error || s.reportingError || s.status}`).join("; ") || undefined,
      sources: summaries,
      openAgendaBatches: summaries.filter(s => s.source.startsWith("openagenda-")).length,
      datatourismeChunks: summaries.find(s => s.source === DATATOURISME_SOURCE_KEY)?.summaries?.length || 0
    };
    console.log("[sortir-auto-ingest] Cycle terminé :", JSON.stringify({ ...summary, sources: undefined }));
    return summary;
  })();
  workPromise.catch(error => console.error("[sortir-auto-ingest] Erreur inattendue :", error.message));
  return { triggered: true, status: "started", workPromise };
}

module.exports = {
  runSortirIngestTickIfDue,
  REUNION_SOURCES,
  scheduledSource,
  isDue,
  hasRecentCompletedRun,
  runOpenAgendaBatches,
  runDatatourismeChunks,
  chunkArray,
  OPENAGENDA_SOURCES,
  OPENAGENDA_BATCH_SIZE,
  OPENAGENDA_MAX_EVENTS_PER_AGENDA,
  DATATOURISME_SOURCE_KEY,
  DATATOURISME_BASE_URL,
  DATATOURISME_CHUNK_SIZE,
  DATATOURISME_MAX_TOTAL_POIS_PILOT,
  DATATOURISME_STALE_AFTER_MS,
  SORTIR_INGEST_HOUR,
  SORTIR_INGEST_TOLERANCE_MIN,
  SORTIR_RECENT_RUN_LOOKBACK_MS
};
