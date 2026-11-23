"use strict";
// Daily scheduler only. Do not change the sealed historical persister or its codeHash.
const { safeMessage, isTransientStoreError, retryTransient } = require('./scheduler-cycle-status');
const TERMINAL = new Set(['completed', 'partial', 'failed']);
const READ_METHOD = /^(get|find|list|scan|count)/;
// Pure reads safe to replay on a transient failure. countFinalActivities() runs after all business
// writes; PostgREST cut it at statement_timeout=8s right after heavy write bursts (10/11 and 23/11,
// HTTP 500 in 8.2 s, normally ~50 ms). Replaying it never repeats a write; a persistent failure still
// fails the producer exactly as before, and no count value is ever invented.
const REPLAYABLE_READS = new Set(['countFinalActivities']);
function errorInfo(error) {
  const text = typeof error === 'string' ? error : error?.message || error?.details || error?.code || 'Erreur sans message';
  return { message: safeMessage(text).slice(0, 2000), code: typeof error?.code === 'string' ? error.code : null,
    details: typeof error?.details === 'string' ? safeMessage(error.details).slice(0, 2000) : null,
    httpStatus: error?.httpStatus ?? error?.status ?? null };
}
function asError(error) {
  const info = errorInfo(error);
  return Object.assign(new Error(info.message, { cause: error }), { code: info.code,
    details: typeof error?.details === 'string' ? info.details : error?.details,
    httpStatus: info.httpStatus });
}
function errorText(error) { const e = errorInfo(error); return [e.code, e.message, e.details].filter(Boolean).join(' : '); }
function createDailyRunLifecycle(target, { delaysMs, sleep, log = value => console.error('[sortir-daily-lifecycle]', JSON.stringify(value)) }) {
  const ingestions = new Map(), sources = new Map(), diagnostics = [];
  let uncertainWrite = false;
  const record = (phase, error, id = null) => {
    const detail = { phase, id, ...errorInfo(error) };
    if (diagnostics.length < 32) diagnostics.push(detail);
    log(detail);
  };
  const maps = { createIngestionRun: ingestions, updateIngestionRun: ingestions, createSourceRun: sources, updateSourceRun: sources };
  const proxy = new Proxy(target, { get(store, method) {
    const fn = store[method];
    if (typeof fn !== 'function') return fn;
    return async (...args) => {
      const map = maps[method], closing = method.startsWith('update') && map && TERMINAL.has(args[1]?.status);
      const journal = !!map;
      if (uncertainWrite && !journal && !READ_METHOD.test(method))
        throw Object.assign(new Error('Écriture métier incertaine : aucune autre écriture métier autorisée.'), { code: 'DAILY_WRITE_UNCERTAIN' });
      const entry = map && method.startsWith('update') ? map.get(args[0]) : null;
      if (entry && closing) entry.finalPatch = structuredClone(args[1]);
      const operation = async () => {
        try { return await fn.apply(store, args); }
        catch (error) {
          record(method, error, entry?.row.id || null);
          // Metadata UPDATEs are replayable with exactly the same known ID/patch.
          // An INSERT with a lost response, or a business write, is never replayed here.
          if (!closing && !READ_METHOD.test(method) && isTransientStoreError(error)) uncertainWrite = true;
          throw asError(error);
        }
      };
      // Transience is judged on the ORIGINAL error: asError() turns an empty PostgREST 500 into
      // "Erreur sans message", which would otherwise look definitive and never be replayed.
      const replayRead = async () => {
        for (let attempt = 0; ; attempt++) {
          try { return await fn.apply(store, args); }
          catch (error) {
            record(method, error, null);
            if (!isTransientStoreError(error) || attempt >= delaysMs.length) throw Object.assign(asError(error), { attempts: attempt + 1 });
            await sleep(delaysMs[attempt]);
          }
        }
      };
      const result = closing ? await retryTransient(operation, { delaysMs, sleep, label: method })
        : REPLAYABLE_READS.has(method) ? await replayRead() : await operation();
      if (map && method.startsWith('create')) {
        if (!result?.id) {
          uncertainWrite = true;
          const error = Object.assign(new Error('Création de journal sans identifiant confirmé'), { code: 'DAILY_WRITE_UNCERTAIN' });
          record(method, error); throw error;
        }
        map.set(result.id, { row: { ...args[0], id: result.id }, finalPatch: null });
      }
      if (entry) { Object.assign(entry.row, args[1]); if (closing) entry.finalPatch = null; }
      return result;
    };
  } });
  function stats() {
    const inner = new Set([...ingestions.values()].filter(e => e.row.orchestrator_version === 'sortir-ingestion-v1').map(e => e.row.id));
    const totals = { collected: 0, VALID: 0, NEEDS_REVIEW: 0, INVALID: 0 };
    for (const { row, finalPatch } of sources.values()) if (inner.has(row.ingestion_run_id)) {
      const r = { ...row, ...finalPatch };
      for (const [key, column] of Object.entries({ collected: 'collected_count', VALID: 'valid_count', NEEDS_REVIEW: 'needs_review_count', INVALID: 'invalid_count' })) totals[key] += r[column] || 0;
    }
    return totals;
  }
  async function closeDangling(error, excluded = new Set()) {
    let repaired = 0;
    // Only runs created by this invocation, AFTER its awaited work has settled.
    // No scan, age-based takeover, or closing of a run belonging to another process.
    for (const [map, method] of [[sources, 'updateSourceRun'], [ingestions, 'updateIngestionRun']]) {
      for (const [id, entry] of map) {
        if (excluded.has(id) || TERMINAL.has(entry.row.status)) continue;
        const linked = [...sources.values()].filter(s => s.row.ingestion_run_id === id);
        const cause = error ? errorText(error) : 'Traitement terminé sans clôture interne confirmée';
        const children = linked.filter(s => s.row.error).map(s => ({ sourceRunId: s.row.id, error: s.row.error }));
        const patch = entry.finalPatch || { status: 'failed', finished_at: new Date().toISOString(),
          ...(map === sources ? { error: cause } : {
            ...Object.fromEntries(['collected_count', 'valid_count', 'needs_review_count', 'invalid_count'].map(k => [k, linked.reduce((n, s) => n + (s.row[k] || 0), 0)])),
            error_summary: [{ kind: 'sortir_daily_finalization', error: cause, sourceErrors: children }]
          }) };
        try { await proxy[method](id, patch); repaired++; }
        catch (secondary) { record('cleanup_failed', secondary, id); }
      }
    }
    return { repaired, operatorActionRequired: uncertainWrite || [...ingestions.values(), ...sources.values()]
      .some(e => !excluded.has(e.row.id) && !TERMINAL.has(e.row.status)), diagnostics: diagnostics.slice() };
  }
  return { store: proxy, closeDangling, stats, diagnostics, get uncertainWrite() { return uncertainWrite; } };
}
module.exports = { createDailyRunLifecycle, errorInfo, errorText };
