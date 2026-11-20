"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const { MemoryStore } = require('./test-helpers/memory-store');
const { schedulerClient } = require('./test-helpers/scheduler-client');
const { createSchedulerState, LOCK_ID } = require('./scheduler-state');
const { readSchedulerStatus, CYCLE_ROOT_VERSION } = require('./scheduler-cycle-status');
const { persistSortirIngestion } = require('./supabase-persistence');
const { createDailyRunLifecycle, errorInfo } = require('./daily-run-lifecycle');
const { scheduledSource, runSortirIngestTickIfDue, OPENAGENDA_SOURCES } = require('../sortir-auto-ingest');
const now = new Date('2026-11-20T00:05:00Z');
global.fetch = async () => { throw Error('External network forbidden in offline tests'); };
process.env.OPENAGENDA_PUBLIC_KEY = 'offline-test-key';
const source = { key: 'daily-fixture', connectorType: 'paris_data', baseUrl: 'https://source.invalid' };
const sleep = async () => {};
function setup() {
  const db = new MemoryStore(), client = schedulerClient(db), state = createSchedulerState(client);
  const tick = extra => runSortirIngestTickIfDue({ now, store: db, client, state, reunionSources: [], parisSources: [],
    datatourismeMaxTotalPois: 0, closeRetryDelaysMs: [0, 0], sleep,
    fetchEvents: async () => ({ results: [], fetchedCount: 0 }), ...extra });
  return { db, client, state, tick };
}
function item() {
  const activity = { title: 'Lecture quotidienne', description: 'Une lecture publique et un débat.', startsAt: '2026-12-01T18:00:00Z',
    endsAt: '2026-12-01T20:00:00Z', timezone: 'Europe/Paris', lifecycleStatus: 'scheduled', locationType: 'physical',
    venueName: 'Bibliothèque', address: '1 rue des Livres', postalCode: '75001', city: 'Paris', country: 'FR',
    latitude: 48.8566, longitude: 2.3522, admissionType: 'free', organizers: [{ name: 'Bibliothèque' }],
    confidence: 1, fieldConfidence: {}, evidence: [], tags: [],
    provenances: [{ sourceType: 'api', sourceName: 'fixture', sourceUrl: 'https://source.invalid', originalEventUrl: 'https://source.invalid/1', externalId: 'one', fetchedAt: now.toISOString() }],
    externalIds: [{ system: 'fixture', value: 'one' }] };
  return { activity, sourceRecordId: 'one', sourceOccurrenceKey: 'one@2026-12-01T18:00:00.000Z', sourcePayload: { title: activity.title } };
}
const run = (db, extra = {}) => scheduledSource({ source, store: db, now, closeRetryDelaysMs: [0, 0], sleep,
  work: store => persistSortirIngestion({ sources: [{ ...source, results: [item()] }], store, now }), ...extra });
const running = db => [...db.ingestions, ...db.sourceRuns].filter(r => r.status === 'running');

test('normal success closes inner, source wrapper and producer wrapper', async () => {
  const { db } = setup(); const r = await run(db);
  assert.equal(r.status, 'completed'); assert.equal(r.operatorActionRequired, undefined);
  assert.equal(running(db).length, 0); assert.equal(db.activities.length, 1);
});
test('ordinary producer failure closes owned rows and never another run', async () => {
  const { db } = setup(); db.ingestions.push({ id: 'other-worker', status: 'running' });
  const r = await run(db, { work: async () => { throw Error('source HTTP 503'); } });
  assert.equal(r.status, 'failed'); assert.deepEqual(running(db).map(r => r.id), ['other-worker']);
});
test('final count failure: business data preserved, inner failed, source errors and original cause preserved', async () => {
  const { db } = setup(); db.countFinalActivities = async () => { throw { code: '57014', message: 'count timeout', details: 'read-only aggregate' }; };
  const r = await run(db); const inner = db.ingestions.find(r => r.orchestrator_version === 'sortir-ingestion-v1');
  assert.equal(r.status, 'failed'); assert.equal(r.operatorActionRequired, undefined); assert.equal(running(db).length, 0);
  assert.equal(inner.status, 'failed'); assert.equal(inner.collected_count, 1); assert.equal(r.stats.collected, 1);
  assert.match(JSON.stringify(inner.error_summary), /57014.*count timeout/);
  assert.equal(db.activities.length, 1); assert.equal(db.provenances.length, 1);
  assert(r.journalErrors.some(e => e.phase === 'countFinalActivities' && e.code === '57014'));
});
test('November 10 shape: partial source then count failure retains both causes', async () => {
  const { db } = setup(); db.countFinalActivities = async () => { throw Error('count timeout'); };
  const r = await run(db, { work: async store => {
    const inner = await store.createIngestionRun({ status: 'running', orchestrator_version: 'sortir-ingestion-v1' });
    const child = await store.createSourceRun({ status: 'running', ingestion_run_id: inner.id });
    await store.updateSourceRun(child.id, { status: 'partial', collected_count: 1512, valid_count: 812,
      needs_review_count: 624, invalid_count: 76, error: 'Fusion refusée: décision REVIEW' });
    await store.countFinalActivities();
  } });
  const inner = db.ingestions.find(r => r.orchestrator_version === 'sortir-ingestion-v1');
  assert.equal(running(db).length, 0); assert.equal(inner.collected_count, 1512);
  assert.match(JSON.stringify(inner.error_summary), /count timeout/); assert.match(JSON.stringify(inner.error_summary), /Fusion refusée/);
  assert.equal(r.stats.INVALID, 76);
});
test('lost final UPDATE response: exact patch retried, no business replay', async () => {
  const { db } = setup(), original = db.updateIngestionRun.bind(db), patches = []; let first = true;
  db.updateIngestionRun = async (id, patch) => {
    if (db.ingestions.find(r => r.id === id)?.orchestrator_version === 'sortir-ingestion-v1' && patch.finished_at) {
      patches.push(structuredClone(patch)); await original(id, patch);
      if (first) { first = false; throw Error('fetch failed'); } return;
    } return original(id, patch);
  };
  const r = await run(db); assert.equal(r.status, 'completed'); assert.equal(patches.length, 2);
  assert.deepEqual(patches[0], patches[1]); assert.equal(db.activities.length, 1); assert.equal(running(db).length, 0);
});
test('persistent journal failure stops the cycle, holds mutex, retains primary and secondary errors', async () => {
  const h = setup(), update = h.db.updateIngestionRun.bind(h.db); let fetches = 0;
  h.db.countFinalActivities = async () => { throw Error('primary count failure'); };
  h.db.updateIngestionRun = async (id, patch) => {
    if (h.db.ingestions.find(r => r.id === id)?.orchestrator_version === 'sortir-ingestion-v1') throw Error('permission denied for journal');
    return update(id, patch);
  };
  const t = await h.tick({ fetchEvents: async () => { fetches++; return { results: [], fetchedCount: 0 }; } }), r = await t.workPromise;
  assert.equal(r.operatorActionRequired, true); assert.equal(fetches, 1);
  assert.equal(h.db.ingestions.find(r => r.id === LOCK_ID).status, 'running');
  assert.equal(h.db.ingestions.find(r => r.id === t.cycleId).status, 'running');
  assert.match(r.sources[0].error, /primary count failure/);
  assert(r.sources[0].journalErrors.some(e => e.message.includes('permission denied')));
  assert.equal((await h.tick()).reason, 'scheduler locked');
});
test('failed count is retryable next cycle without double activity or provenance', async () => {
  const h = setup(), count = h.db.countFinalActivities.bind(h.db); let fail = true;
  h.db.countFinalActivities = async () => { if (fail) throw Error('read timeout'); return count(); };
  const extra = { openAgendaSources: [OPENAGENDA_SOURCES[0]], fetchEvents: async () => ({ results: [item()], fetchedCount: 1 }) };
  const first = await h.tick(extra); assert.equal((await first.workPromise).status, 'failed');
  assert.equal(running(h.db).length, 0); fail = false;
  const next = await h.tick({ ...extra, now: new Date(now.getTime() + 61 * 60000) });
  assert.equal((await next.workPromise).status, 'completed'); assert.equal(h.db.activities.length, 1); assert.equal(h.db.provenances.length, 1);
  assert.equal((await h.tick({ ...extra, now: new Date(now.getTime() + 120 * 60000) })).reason, 'already run recently');
});
test('lost business INSERT response prevents further business writes and automatic replay', async () => {
  const h = setup(), create = h.db.createActivity.bind(h.db); let inserts = 0;
  h.db.createActivity = async row => { inserts++; await create(row); throw Error('fetch failed'); };
  const t = await h.tick({ fetchEvents: async () => ({ results: [item(), item()], fetchedCount: 2 }) }), r = await t.workPromise;
  assert.equal(r.operatorActionRequired, true); assert.equal(inserts, 1); assert.equal(h.db.activities.length, 1);
  assert.equal(h.db.ingestions.find(r => r.id === LOCK_ID).status, 'running');
  assert.equal((await h.tick()).reason, 'scheduler locked');
});
test('lost cycle INSERT response preserves known ID and mutex, no producer starts', async () => {
  const h = setup(), create = h.db.createIngestionRun.bind(h.db); let fetched = false;
  h.db.createIngestionRun = async row => { const saved = await create(row); if (row.orchestrator_version === CYCLE_ROOT_VERSION) throw Error('fetch failed'); return saved; };
  const r = await h.tick({ fetchEvents: async () => { fetched = true; return { results: [] }; } });
  assert.equal(r.operatorActionRequired, true); assert.equal(fetched, false); assert(r.cycleId);
  assert(h.db.ingestions.some(x => x.id === r.cycleId && x.status === 'running'));
  assert.equal(h.db.ingestions.find(r => r.id === LOCK_ID).status, 'running');
});
test('an old running row is only suspected abandoned, never closed by a new worker', async () => {
  const h = setup(); h.db.ingestions.push({ id: 'old', status: 'running', started_at: '2026-11-10T10:05:19.738Z', orchestrator_version: 'sortir-ingestion-v1' });
  await h.state.acquire(now); await h.state.release(now);
  const snapshot = await readSchedulerStatus(h.client, ['one'], now);
  assert.equal(snapshot.blockers[0].abandonmentSuspected, true); assert.equal(snapshot.blockers[0].automaticRecoveryAllowed, false);
  assert.equal((await h.tick()).reason, 'another ingestion running'); assert.equal(h.db.ingestions[0].status, 'running');
});
test('active worker: concurrent tick denied; no age-based closure even after 40 minutes', async () => {
  const h = setup(); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }); const blocked = new Promise(resolve => { release = resolve; });
  const t = await h.tick({ fetchEvents: async () => { entered(); await blocked; return { results: [], fetchedCount: 0 }; } });
  await ready;
  const other = createSchedulerState(h.client); assert.equal(await other.acquire(new Date(now.getTime() + 3600000)), false);
  assert.equal((await h.tick()).reason, 'already running');
  release(); assert.equal((await t.workPromise).status, 'completed'); assert.equal(running(h.db).length, 0);
});
test('lifecycle retains thrown strings and redacts secrets without mutating original errors', async () => {
  process.env.SORTIR_TEST_SECRET_TOKEN = 'do-not-print-secret';
  try {
    const detail = errorInfo({ code: 'XX000', message: 'do-not-print-secret', details: 'SQL diagnostic' });
    assert.equal(detail.message, '[redacted]'); assert.equal(detail.code, 'XX000');
    const { db } = setup(); const r = await run(db, { work: async () => { throw 'source failure string'; } });
    assert.match(r.error, /source failure string/); assert.equal(running(db).length, 0);
  } finally { delete process.env.SORTIR_TEST_SECRET_TOKEN; }
});

test('real SIGKILL offline: new process cannot take over durable running rows', { timeout: 10000 }, async () => {
  const { fork } = require('node:child_process'), { once } = require('node:events');
  const child = fork(require.resolve('./test-helpers/daily-interruption-worker'), [], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [{ snapshot }] = await once(child, 'message');
    child.kill('SIGKILL'); const [code, signal] = await exited;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    const h = setup(); h.db.seq = snapshot.seq;
    for (const [key, rows] of Object.entries(snapshot)) if (Array.isArray(rows)) h.db[key].splice(0, h.db[key].length, ...rows);
    const before = structuredClone(h.db.ingestions);
    assert.equal((await h.tick()).reason, 'scheduler locked');
    assert.deepEqual(h.db.ingestions, before);
    assert(h.db.ingestions.some(r => r.orchestrator_version === 'sortir-ingestion-v1' && r.status === 'running'));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('unconfirmed journal INSERT identity is never considered a safe ordinary failure', async () => {
  const { db } = setup(), create = db.createIngestionRun.bind(db);
  db.createIngestionRun = async row => { await create(row); return null; };
  const result = await run(db);
  assert.equal(result.operatorActionRequired, true); assert.match(result.error, /identifiant/);
});
