"use strict";
// Contrôleur GitHub sans accès Supabase : un tick, puis uniquement des GET authentifiés.
const { inspectTick, inspectCycle } = require('./check-scheduler-response');
const MAX_WAIT_MS = 40 * 60 * 1000;
const POLL_MS = 30 * 1000;
const RETRY_DELAYS_MS = [2000, 5000, 10000];
class MonitorError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
const fail = (code, message) => { throw new MonitorError(code, message); };
function cycleAction(cycle, now) {
  let result;
  try { result = inspectCycle(cycle); }
  catch { fail('BUSINESS', 'Cycle échoué, partiel ou incohérent ; consulter son journal durable.'); }
  if (result.action === 'poll') {
    if (cycle.inconsistent) fail('BUSINESS', 'Cycle running incohérent ; consulter son journal durable.');
    const started = Date.parse(cycle.startedAt);
    if (!Number.isFinite(started) || started > now) fail('PROTOCOL', 'Horloge du cycle invalide.');
    if (now - started >= MAX_WAIT_MS) fail('BLOCKED', 'Cycle en cours depuis au moins 40 minutes ; arrêt éventuel à vérifier. Verrou conservé.');
  }
  return result;
}
function schedulerAction(snapshot, now) {
  if (snapshot?.kind !== 'sortir_scheduler_monitor' || !Array.isArray(snapshot.runningCycles) ||
      !Array.isArray(snapshot.blockers) || !['completed','running'].includes(snapshot.lock?.status) ||
      !Array.isArray(snapshot.daily?.expectedSources) || !snapshot.daily.expectedSources.length ||
      !Array.isArray(snapshot.daily.completedSources)) fail('PROTOCOL', 'Projection de supervision invalide.');
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  if (snapshot.cycleDayStart !== dayStart.toISOString()) fail('PROTOCOL', 'Projection hors de la journée de cycle courante.');
  if (snapshot.runningCycles.length > 1) fail('BLOCKED', 'Plusieurs cycles running : intervention requise, aucun verrou modifié.');
  // Un verrou occupé ne devient jamais un succès, même si le dernier cycle est completed.
  if (snapshot.lock.status === 'running' || snapshot.blockers.length) {
    const starts = [...snapshot.blockers.map(r => r.startedAt),
      ...(snapshot.lock.status === 'running' ? [snapshot.lock.startedAt] : [])].map(Date.parse);
    if (starts.some(t => !Number.isFinite(t) || t > now)) fail('PROTOCOL', 'Horloge du verrou ou des traitements invalide.');
    if (starts.some(t => now - t >= MAX_WAIT_MS)) fail('BLOCKED', 'Verrou ou traitement occupé depuis au moins 40 minutes ; abandon possible. Aucune libération automatique.');
    if (snapshot.runningCycles.length) {
      const c = snapshot.runningCycles[0]; cycleAction(c, now);
      return { action: 'poll', cycleId: c.cycleId };
    }
    return { action: 'verify', reason: 'Verrou occupé sans cycle running ; préparation ou clôture en cours, à recontrôler.' };
  }
  if (snapshot.daily.successConfirmed === true && snapshot.daily.expectedSources.every(s => snapshot.daily.completedSources.includes(s)))
    return { action: 'success', successConfirmed: true };
  if (snapshot.latestCycle) {
    const result = cycleAction(snapshot.latestCycle, now);
    if (result.action === 'poll') return { action: 'poll', cycleId: snapshot.latestCycle.cycleId };
  }
  fail('BUSINESS', 'Réussite de tous les producteurs attendus pour la journée non démontrée.');
}
async function monitorScheduler({ baseUrl, token, request = globalThis.fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log } = {}) {
  const root = new URL(baseUrl);
  if (!token || root.protocol !== 'https:' || root.username || root.password || root.search || root.hash)
    fail('CONFIG', 'URL HTTPS et jeton du bot requis.');
  const deadline = now() + MAX_WAIT_MS;
  const remaining = () => {
    const ms = deadline - now();
    if (ms <= 0) fail('TIMEOUT', 'Surveillance limitée à 40 minutes : résultat non confirmé, ingestion non déclarée échouée.');
    return ms;
  };
  async function json(path, method = 'GET') {
    const url = new URL(path, root); url.searchParams.set('token', token);
    for (let attempt = 0; ; attempt++) {
      let error, transient = false;
      try {
        const response = await request(url.toString(), { method, redirect: 'error',
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(Math.min(15000, remaining())) });
        if (!response.ok) {
          transient = response.status === 429 || response.status >= 500;
          error = new MonitorError('HTTP', `${method} ${url.pathname} : HTTP ${response.status}.`);
        } else {
          try { return await response.json(); }
          catch (e) {
            // Une coupure de corps est réessayable ; un JSON complet mal formé ne l'est pas.
            if (e instanceof SyntaxError) fail('PROTOCOL', 'Réponse JSON invalide.');
            throw e;
          }
        }
      } catch (e) {
        if (e instanceof MonitorError) throw e;
        error = new MonitorError('NETWORK', `${method} ${url.pathname} : transport indisponible.`);
        transient = true;
      }
      if (!transient || attempt >= RETRY_DELAYS_MS.length) throw error;
      log(`${error.message} Nouvel essai ${attempt + 1}/${RETRY_DELAYS_MS.length}.`);
      await sleep(Math.min(RETRY_DELAYS_MS[attempt], remaining()));
    }
  }
  const tick = await json('/api/sortir-ingest-tick', 'POST');
  let action;
  try { action = inspectTick(tick); }
  catch { fail('BUSINESS', 'Tick rejeté, configuration inactive ou tentatives quotidiennes épuisées.'); }
  let cycleId = action.cycleId;
  log(cycleId ? `Cycle ${cycleId} accepté ; résultat durable attendu.` : `Tick sans lancement (${action.reason}) : vérification durable.`);
  while (true) {
    remaining();
    if (cycleId) {
      const status = await json(`/api/sortir-ingest-status?cycleId=${encodeURIComponent(cycleId)}`);
      if (status.cycleId !== cycleId) fail('PROTOCOL', 'Identifiant du cycle inattendu.');
      action = cycleAction(status, now());
      if (action.action === 'success') cycleId = null; // Confirmer aussi le verrou et la journée complète.
    }
    if (!cycleId) {
      action = schedulerAction(await json('/api/sortir-ingest-status?current=1'), now());
      if (action.action === 'success') {
        log('Réussite quotidienne confirmée dans le journal durable ; aucun traitement restant ni verrou occupé.');
        return action;
      }
      cycleId = action.cycleId;
      if (cycleId) continue;
    }
    await sleep(Math.min(POLL_MS, remaining()));
  }
}
if (require.main === module) monitorScheduler({ baseUrl: process.env.BOT_VEILLE_URL, token: process.env.BOT_VEILLE_TOKEN })
  .catch(error => { console.error(error instanceof MonitorError ? error.message : 'CONFIG: Configuration de supervision invalide.'); process.exitCode = 1; });
module.exports = { monitorScheduler, schedulerAction, cycleAction, MonitorError, MAX_WAIT_MS, POLL_MS, RETRY_DELAYS_MS };
