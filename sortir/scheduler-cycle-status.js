"use strict";
const CYCLE_ROOT_VERSION = 'sortir-scheduler-cycle-v1';
const KIND = 'sortir_scheduler_cycle';
function safeMessage(value) {
  let text = String(value || 'Erreur non précisée');
  for (const [name,secret] of Object.entries(process.env)) if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && secret && secret.length>=8) text=text.split(secret).join('[redacted]');
  return text.replace(/([?&](?:api_key|key|token)=)[^&\s]+/gi,'$1[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [redacted]');
}
// Le store Supabase ne propage que le message : classification sur le message, ou sur
// status/httpStatus numériques quand ils existent. Un message vide (corps HTTP illisible) est
// traité comme transitoire ; tout le reste (droits, ligne absente, contrainte) est définitif.
const TRANSIENT_MESSAGE = /fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR|timed? ?out|timeout|aborted|canceling statement|too many connections|connection (?:terminated|refused|reset)|could not connect|server closed the connection|deadlock detected|could not serialize|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|upstream|rate limit|too many requests|PGRST00[0-3]|\b(?:HTTP|status)\s*:?\s*(?:408|429|5\d\d)\b/i;
function isTransientStoreError(error) {
  const status = Number(error?.httpStatus ?? error?.status);
  if (Number.isInteger(status) && status > 0) return status === 408 || status === 429 || status >= 500;
  const message = String(error?.message ?? '').trim();
  return !message || error?.name === 'AbortError' || TRANSIENT_MESSAGE.test(message);
}
// Rejoue la même opération idempotente : nouvel essai uniquement sur erreur transitoire,
// délais progressifs bornés. La dernière erreur est relancée, annotée du nombre d'essais.
async function retryTransient(operation, { delaysMs, sleep, label }) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const transient = isTransientStoreError(error);
      if (!transient || attempt >= delaysMs.length) { error.attempts = attempt + 1; error.transient = transient; throw error; }
      console.error(`[sortir-auto-ingest] ${label} : essai ${attempt + 1}/${delaysMs.length + 1} échoué (transitoire), nouvel essai dans ${delaysMs[attempt]} ms :`, safeMessage(error.message));
      await sleep(delaysMs[attempt]);
    }
  }
}
function producerResult(r) {
  return Object.fromEntries(['source','status','error','errorCode','httpStatus','eventsCollected','eventsRetained','occurrencesRetained','activitiesCreated','activitiesUpdated','startedAt','finishedAt','durationMs','ingestionRunId','sourceRunId','reportingError'].filter(k => r[k] !== undefined).map(k => [k,r[k]]));
}
function cycleResult({ cycleId, expectedSources, sources, releaseError = null }) {
  sources = sources.map(producerResult);
  const completedCount = sources.filter(s => s.status === 'completed' && !s.reportingError).length;
  const failedCount = sources.filter(s => s.status === 'failed').length;
  const partialCount = sources.filter(s => s.status === 'partial' || (s.status === 'completed' && s.reportingError)).length;
  const pendingCount = expectedSources.length - sources.length;
  let status = pendingCount ? 'running' : completedCount === expectedSources.length ? 'completed' : completedCount || partialCount ? 'partial' : 'failed';
  if (releaseError) status = 'failed';
  return { kind: KIND, cycleId, expectedSources, expectedCount: expectedSources.length, completedCount, failedCount, partialCount, pendingCount,
    status, successConfirmed: status === 'completed' && pendingCount === 0, sources, releaseError };
}
async function readCycleStatus(client, cycleId) {
  const query = client.from('sortir_ingestion_runs').select('id,status,orchestrator_version,started_at,finished_at,error_summary')
    .eq('id',cycleId).eq('orchestrator_version',CYCLE_ROOT_VERSION).maybeSingle();
  if (typeof query.abortSignal === 'function') query.abortSignal(AbortSignal.timeout(10000));
  const {data,error} = await query;
  if(error) throw new Error('Lecture du journal de cycle indisponible');
  if(!data) return null;
  return cycleStatusFromRow(data);
}
function cycleStatusFromRow(data) {
  const saved = data.error_summary?.find(e => e?.kind === KIND);
  if(!saved || !Array.isArray(saved.expectedSources) || !saved.expectedSources.length || !Array.isArray(saved.sources)) throw new Error('Journal de cycle incomplet');
  if(new Set(saved.expectedSources).size!==saved.expectedSources.length || new Set(saved.sources.map(s=>s.source)).size!==saved.sources.length || saved.sources.some(s=>!saved.expectedSources.includes(s.source))) throw new Error('Journal de cycle incohérent');
  if(saved.sources.some(s=>!['completed','partial','failed'].includes(s.status)))throw new Error('Statut producteur invalide');
  const computed = cycleResult({...saved,cycleId:data.id});
  for(const k of ['expectedCount','completedCount','failedCount','partialCount','pendingCount']) if(computed[k]!==saved[k])throw new Error('Compteurs du cycle incohérents');
  // A killed worker leaves running durable. Never infer success from finished producers.
  return {...computed,status:data.status,successConfirmed:data.status==='completed' && !!data.finished_at && computed.successConfirmed,
    finished:data.status!=='running' && !!data.finished_at,startedAt:data.started_at,finishedAt:data.finished_at,
    inconsistent:data.status!=='running' && data.status!==computed.status};
}
// Projection de supervision uniquement : jamais de prise/libération de verrou.
async function readSchedulerStatus(client, expectedSources, now = new Date()) {
  if (!Array.isArray(expectedSources) || !expectedSources.length || new Set(expectedSources).size !== expectedSources.length)
    throw new Error('Producteurs attendus non configurés');
  const { LOCK_ID, LOCK_VERSION } = require('./scheduler-state');
  // 04:00 Indian/Reunion = 00:00 UTC, sans changement saisonnier.
  const since = new Date(now); since.setUTCHours(0, 0, 0, 0);
  const read = async query => {
    if (typeof query.abortSignal === 'function') query.abortSignal(AbortSignal.timeout(10000));
    const r = await query; if (r.error) throw new Error('Lecture de supervision indisponible'); return r.data;
  };
  const columns = 'id,status,orchestrator_version,started_at,finished_at,error_summary';
  const dailyRows = await read(client.from('sortir_ingestion_runs').select(columns)
    .eq('orchestrator_version', CYCLE_ROOT_VERSION).gte('started_at', since.toISOString()).limit(51));
  if (dailyRows.length > 50) throw new Error('Journal quotidien au-delà de la borne de supervision');
  const running = await read(client.from('sortir_ingestion_runs').select(columns).eq('status', 'running').neq('id', LOCK_ID).limit(51));
  const sourceRuns = await read(client.from('sortir_source_runs').select('id,started_at,status').eq('status', 'running').limit(51));
  const lock = await read(client.from('sortir_ingestion_runs').select(columns).eq('id', LOCK_ID).maybeSingle());
  if (!lock || lock.orchestrator_version !== LOCK_VERSION || !['running', 'completed'].includes(lock.status))
    throw new Error('Verrou scheduler absent ou incohérent');
  const cycles = dailyRows.map(cycleStatusFromRow).sort((a,b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const runningCycles = running.filter(r => r.orchestrator_version === CYCLE_ROOT_VERSION).map(cycleStatusFromRow);
  const completedSources = new Set();
  for (const c of cycles) if (c.finished && !c.inconsistent && !c.releaseError && ['completed','partial'].includes(c.status))
    for (const s of c.sources) if (s.status === 'completed' && !s.reportingError) completedSources.add(s.source);
  const blockers = [...running, ...sourceRuns];
  return { kind: 'sortir_scheduler_monitor', checkedAt: now.toISOString(), cycleDayStart: since.toISOString(),
    lock: { status: lock.status, startedAt: lock.started_at },
    runningCycles, latestCycle: cycles[0] || null,
    blockers: blockers.map(r => ({ id: r.id, startedAt: r.started_at })),
    daily: { expectedSources, completedSources: [...completedSources],
      successConfirmed: lock.status === 'completed' && blockers.length === 0 && expectedSources.every(s => completedSources.has(s)) } };
}
// Runs enveloppe démarrés depuis le début de la journée de cycle (lecture seule, bornée).
async function listCycleAttempts(client, sinceIso) {
  const {data,error} = await client.from('sortir_ingestion_runs').select('id,started_at')
    .eq('orchestrator_version',CYCLE_ROOT_VERSION).gte('started_at',sinceIso).limit(50);
  if(error) throw new Error(error.message);
  return data || [];
}
function createCycleStatusHandler(getClient, { getExpectedSources, now = () => new Date() } = {}) {
  return async(req,res)=>{
    res.set?.('Cache-Control', 'no-store');
    if (req.query.current === '1') {
      try { return res.json(await readSchedulerStatus(getClient(), getExpectedSources?.(), now())); }
      catch { return res.status(503).json({error:'Supervision du scheduler indisponible',successConfirmed:false}); }
    }
    if(!/^[a-f0-9-]{36}$/i.test(req.query.cycleId||''))return res.status(400).json({error:'cycleId requis et valide'});
    try {const result=await readCycleStatus(getClient(),req.query.cycleId);return result?res.json(result):res.status(404).json({error:'Cycle introuvable'});}
    catch {return res.status(503).json({error:'Statut du cycle indisponible',successConfirmed:false});}
  };
}
module.exports={safeMessage,isTransientStoreError,retryTransient,CYCLE_ROOT_VERSION,KIND,producerResult,cycleResult,readCycleStatus,cycleStatusFromRow,readSchedulerStatus,listCycleAttempts,createCycleStatusHandler};
