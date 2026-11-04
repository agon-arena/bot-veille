"use strict";
// Tests hors réseau : horloge virtuelle, HTTP simulé, journal en mémoire.
const test = require('node:test'), assert = require('node:assert/strict');
const { monitorScheduler, schedulerAction, cycleAction, MAX_WAIT_MS, POLL_MS } = require('./monitor-scheduler');
const { cycleResult, readSchedulerStatus, createCycleStatusHandler, CYCLE_ROOT_VERSION } = require('./scheduler-cycle-status');
const { inspectTick } = require('./check-scheduler-response');
const { LOCK_ID, LOCK_VERSION } = require('./scheduler-state');
const { MemoryStore } = require('./test-helpers/memory-store');
const { schedulerClient } = require('./test-helpers/scheduler-client');
const AT = Date.parse('2026-11-04T02:22:00Z');
const ID = '11111111-2222-4333-8444-111111111111';
function status(state = 'completed', started = AT) {
  const sources = state === 'running' ? [] : [{ source: 'a', status: state }];
  return { ...cycleResult({ cycleId: ID, expectedSources: ['a'], sources }),
    status: state, startedAt: new Date(started).toISOString(), finished: state !== 'running',
    finishedAt: state === 'running' ? null : new Date(started + 1000).toISOString(), inconsistent: false };
}
function snapshot(overrides = {}) {
  return { kind: 'sortir_scheduler_monitor', cycleDayStart: '2026-11-04T00:00:00.000Z', lock: { status: 'completed', startedAt: new Date(AT).toISOString() },
    runningCycles: [], blockers: [], latestCycle: status(),
    daily: { expectedSources: ['a'], completedSources: ['a'], successConfirmed: true }, ...overrides };
}
const response = (value, code = 200) => ({ ok: code >= 200 && code < 300, status: code, json: async () => value });
function harness(handler) {
  let time = AT; const calls = [], sleeps = [], logs = [];
  return { calls, sleeps, logs, setTime: t => { time = t; },
    run: () => monitorScheduler({ baseUrl: 'https://bot.example', token: 'do-not-log-this-token', now: () => time,
      sleep: async ms => { sleeps.push(ms); time += ms; }, log: line => logs.push(line),
      request: async (url, options) => {
        const u = new URL(url); calls.push({ path: u.pathname, cycleId: u.searchParams.get('cycleId'), current: u.searchParams.get('current'), method: options.method });
        assert.equal(u.searchParams.get('token'), 'do-not-log-this-token');
        return handler({ url: u, options, time, calls });
      } }) };
}
function journalRow(c, id = c.cycleId) {
  return { id, orchestrator_version: CYCLE_ROOT_VERSION, status: c.status, started_at: c.startedAt,
    finished_at: c.finishedAt, error_summary: [c] };
}
function dbWithLock(lockStatus = 'completed', startedAt = AT) {
  const db = new MemoryStore();
  db.ingestions.push({ id: LOCK_ID, orchestrator_version: LOCK_VERSION, status: lockStatus, started_at: new Date(startedAt).toISOString() });
  return db;
}
test('succès définitif immédiat, contrôle de la journée, un seul POST et aucun sleep', async () => {
  const h = harness(({ options, url }) => response(options.method === 'POST' ? { triggered: true, status: 'started', cycleId: ID } : url.searchParams.has('cycleId') ? status() : snapshot()));
  assert.equal((await h.run()).successConfirmed, true);
  assert.deepEqual(h.calls.map(c => c.method), ['POST','GET','GET']); assert.deepEqual(h.sleeps, []);
});
test('cycle réussi après 32 minutes : pas de fausse alerte à 150 s, polling 30 s', async () => {
  const h = harness(({ options, url, time }) => response(options.method === 'POST' ? { triggered: true, status: 'started', cycleId: ID } :
    url.searchParams.has('cycleId') ? status(time - AT < 32 * 60000 ? 'running' : 'completed') : snapshot()));
  await h.run(); assert.equal(h.sleeps.length, 64); assert(h.sleeps.every(ms => ms === POLL_MS));
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});
test('échec métier durable : arrêt immédiat, sans retry ni attente', async () => {
  const h = harness(({ options }) => response(options.method === 'POST' ? { triggered: true, status: 'started', cycleId: ID } : status('failed')));
  await assert.rejects(h.run(), e => e.code === 'BUSINESS'); assert.deepEqual(h.sleeps, []);
});
for (const reason of ['scheduler locked','already running','already run recently','retry spacing','another ingestion running']) {
  test(`${reason} exige une vérification quotidienne durable`, async () => {
    assert.equal(inspectTick({ triggered: false, reason }).action, 'verify');
    const h = harness(({ options }) => response(options.method === 'POST' ? { triggered: false, reason } : snapshot()));
    await h.run(); assert.equal(h.calls[1].current, '1');
  });
}
test('verrou occupé : retrouve le cycle et attend son résultat réel', async () => {
  let reads = 0;
  const h = harness(({ options, url }) => {
    if (options.method === 'POST') return response({ triggered: false, reason: 'scheduler locked' });
    if (url.searchParams.has('cycleId')) return response(status(++reads < 2 ? 'running' : 'completed'));
    return response(reads ? snapshot() : snapshot({ lock: { status: 'running', startedAt: new Date(AT).toISOString() },
      runningCycles: [status('running')], blockers: [{ id: ID, startedAt: new Date(AT).toISOString() }], daily: { expectedSources: ['a'], completedSources: [], successConfirmed: false } }));
  });
  await h.run(); assert.deepEqual(h.sleeps, [POLL_MS]); assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});
test('verrou ancien sans cycle : alerte abandon possible, aucune mutation', async () => {
  const h = harness(({ options }) => response(options.method === 'POST' ? { triggered: false, reason: 'scheduler locked' } :
    snapshot({ lock: { status: 'running', startedAt: new Date(AT - MAX_WAIT_MS).toISOString() } })));
  await assert.rejects(h.run(), e => e.code === 'BLOCKED' && /Aucune libération/.test(e.message));
  assert.deepEqual(h.calls.map(c => c.method), ['POST','GET']);
});
test('cycle ancien et run source orphelin détectés sans modifier les verrous', () => {
  assert.throws(() => cycleAction(status('running', AT - MAX_WAIT_MS), AT), e => e.code === 'BLOCKED');
  assert.throws(() => schedulerAction(snapshot({ blockers: [{ id: 'orphan', startedAt: new Date(AT - MAX_WAIT_MS).toISOString() }] }), AT), e => e.code === 'BLOCKED');
});
test('verrou récent sans cycle : attente bornée à 40 minutes, jamais succès automatique', async () => {
  const h = harness(({ options, time }) => response(options.method === 'POST' ? { triggered: false, reason: 'scheduler locked' } :
    snapshot({ lock: { status: 'running', startedAt: new Date(time).toISOString() } })));
  await assert.rejects(h.run(), e => e.code === 'TIMEOUT');
  assert.equal(h.sleeps.reduce((n,ms) => n + ms, 0), MAX_WAIT_MS);
});
test('journée incomplète ou succès incohérent : jamais de vert', async () => {
  for (const daily of [ { expectedSources: ['a','b'], completedSources: ['a'], successConfirmed: true },
    { expectedSources: ['a'], completedSources: ['a'], successConfirmed: false } ]) {
    assert.throws(() => schedulerAction(snapshot({ daily }), AT), e => e.code === 'BUSINESS');
  }
  assert.throws(() => cycleAction({ ...status(), completedCount: 0 }, AT), e => e.code === 'BUSINESS');
});
test('réseau, HTTP 429 et 503 : retries bornés du GET, aucun nouveau POST', async () => {
  let n = 0;
  const h = harness(({ options, url }) => {
    if (options.method === 'POST') return response({ triggered: true, status: 'started', cycleId: ID });
    if (url.searchParams.has('cycleId')) {
      n++; if (n === 1) throw new TypeError('fetch failed do-not-log-this-token');
      if (n === 2) return response({},429); if (n === 3) return response({},503);
      return response(status());
    }
    return response(snapshot());
  });
  await h.run(); assert.deepEqual(h.sleeps, [2000,5000,10000]);
  assert.equal(h.calls.filter(c => c.method === 'POST').length,1);
  assert(!h.logs.join(' ').includes('do-not-log-this-token'));
});
test('réponse POST perdue : retry puis verrou occupé, retrouve le résultat sans second lancement métier', async () => {
  let posts = 0;
  const h = harness(({ options }) => {
    if (options.method === 'POST') { if (++posts === 1) throw new TypeError('lost response'); return response({ triggered: false, reason: 'already running' }); }
    return response(snapshot());
  });
  await h.run(); assert.equal(posts,2); assert.deepEqual(h.sleeps,[2000]);
});
test('réseau durable, timeout HTTP et 5xx persistants : quatre tentatives maximum', async () => {
  for (const mode of ['network','timeout','http']) {
    const h = harness(() => { if(mode==='network')throw new TypeError('offline'); if(mode==='timeout')throw new DOMException('deadline','TimeoutError'); return response({},502); });
    await assert.rejects(h.run(), e => e.code === (mode==='http'?'HTTP':'NETWORK'));
    assert.equal(h.calls.length,4); assert.deepEqual(h.sleeps,[2000,5000,10000]);
  }
});
test('HTTP définitif et JSON invalide : arrêt immédiat, pas de retry', async () => {
  for(const code of [400,401,403,404]) {
    const h=harness(()=>response({},code)); await assert.rejects(h.run(),e=>e.code==='HTTP'); assert.equal(h.calls.length,1);
  }
  const h=harness(()=>({ok:true,json:async()=>{throw new SyntaxError('bad JSON')}}));
  await assert.rejects(h.run(),e=>e.code==='PROTOCOL'); assert.equal(h.calls.length,1);
});
test('lecture quotidienne : sources réussies réunies entre deux tentatives, uniquement SELECT', async () => {
  const db=dbWithLock(), client=schedulerClient(db);
  const first={...cycleResult({cycleId:ID,expectedSources:['a','b'],sources:[{source:'a',status:'completed'},{source:'b',status:'failed'}]}),
    startedAt:new Date(AT-60000).toISOString(),finishedAt:new Date(AT-30000).toISOString()};
  const second={...status(),cycleId:'22222222-2222-4333-8444-111111111111',sources:[{source:'b',status:'completed'}],expectedSources:['b']};
  db.ingestions.push(journalRow(first),journalRow(second));
  const r=await readSchedulerStatus(client,['a','b'],new Date(AT));
  assert.equal(r.daily.successConfirmed,true); assert.deepEqual(new Set(r.daily.completedSources),new Set(['a','b']));
  assert(client.calls.every(c=>c.action==='select'));
});
test('succès de la veille, échec actuel ou journal altéré : aucune réussite quotidienne', async () => {
  const db=dbWithLock(), client=schedulerClient(db);
  db.ingestions.push(journalRow(status('completed',AT-86400000)));
  assert.equal((await readSchedulerStatus(client,['a'],new Date(AT))).daily.successConfirmed,false);
  db.ingestions.push(journalRow(status('failed')));
  assert.equal((await readSchedulerStatus(client,['a'],new Date(AT))).daily.successConfirmed,false);
  db.ingestions.at(-1).error_summary[0].completedCount=9;
  await assert.rejects(readSchedulerStatus(client,['a'],new Date(AT)),/incohérents/);
});
test('endpoint current : lecture seule du verrou et des traitements, aucune libération', async () => {
  const db=dbWithLock('running',AT-MAX_WAIT_MS), client=schedulerClient(db), before=JSON.stringify(db.ingestions);
  const handler=createCycleStatusHandler(()=>client,{getExpectedSources:()=>['a'],now:()=>new Date(AT)});
  const res={status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
  await handler({query:{current:'1'}},res);
  assert.equal(res.body.lock.status,'running'); assert.equal(JSON.stringify(db.ingestions),before);
  assert(client.calls.every(c=>c.action==='select'));
  assert.throws(()=>schedulerAction(res.body,AT),e=>e.code==='BLOCKED');
});
test('projection périmée ou cycle incohérent : jamais de faux vert', () => {
  assert.throws(()=>schedulerAction(snapshot({cycleDayStart:'2026-11-03T00:00:00.000Z'}),AT),e=>e.code==='PROTOCOL');
  assert.throws(()=>cycleAction({...status('running'),inconsistent:true},AT),e=>e.code==='BUSINESS');
});
test('contrat workflow : 45 minutes, secrets en environnement et contrôleur unique', () => {
  const fs=require('fs'),path=require('path');
  const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/auto-collect.yml'),'utf8');
  assert.match(workflow,/timeout-minutes: 45/);
  assert.match(workflow,/run: node sortir\/monitor-scheduler\.js/);
  assert.match(workflow,/BOT_VEILLE_TOKEN: \$\{\{ secrets\.BOT_VEILLE_TOKEN \}\}/);
  assert(!workflow.includes('SECONDS + 150'));
  assert.equal(MAX_WAIT_MS,2400000); assert.equal(POLL_MS,30000);
});
