"use strict";
// Rattrapage quotidien : cycle dû dès 04:00 Réunion, idempotent par producteur sur la journée,
// tentatives bornées et espacées. Stores mémoire et client factice : aucun réseau, aucune base.
const test=require('node:test'),assert=require('node:assert/strict');
const {MemoryStore}=require('./test-helpers/memory-store'),{schedulerClient}=require('./test-helpers/scheduler-client');
const {createSchedulerState,LOCK_ID}=require('./scheduler-state'),{CYCLE_ROOT_VERSION,readCycleStatus}=require('./scheduler-cycle-status');
const {inspectTick}=require('./check-scheduler-response');
const {runSortirIngestTickIfDue,OPENAGENDA_SOURCES,SORTIR_MAX_CYCLE_ATTEMPTS_PER_DAY}=require('../sortir-auto-ingest');
global.fetch=async()=>{throw Error('Réseau réel interdit');};
process.env.OPENAGENDA_PUBLIC_KEY='valid-test-key';
const at=iso=>new Date(iso);

function setup(){
  const db=new MemoryStore(),client=schedulerClient(db),state=createSchedulerState(client),fetched=[];let failing=new Set();
  const tick=(iso,extra={})=>runSortirIngestTickIfDue({now:at(iso),store:db,state,client,datatourismeMaxTotalPois:0,reunionSources:[],parisSources:[],
    fetchEvents:async({agendaUid})=>{fetched.push(agendaUid);if(failing.has(agendaUid))throw Error('HTTP 503 simulé');return{results:[],fetchedCount:0};},...extra});
  const done=async(iso,extra)=>{const t=await tick(iso,extra);if(t.workPromise)t.summary=await t.workPromise;return t;};
  return {db,client,state,fetched,done,setFailing(uids){failing=new Set(uids);},cycles(){return db.ingestions.filter(r=>r.orchestrator_version===CYCLE_ROOT_VERSION);},lock(){return db.ingestions.find(r=>r.id===LOCK_ID);}};
}
const [A,B,C]=OPENAGENDA_SOURCES.map(s=>s.agendaUid);

test('tick tardif (13:00 Réunion) : le cycle du jour jamais lancé démarre, puis plus rien le même jour',async()=>{
  const h=setup(),t=await h.done('2026-11-01T09:00:00Z');
  assert.equal(t.triggered,true);assert.equal(t.summary.status,'completed');assert.equal(h.fetched.length,3);
  const again=await h.done('2026-11-01T15:00:00Z');assert.deepEqual(again,{triggered:false,reason:'already run recently'});
  assert.equal(h.fetched.length,3);assert.equal(h.cycles().length,1);assert.equal(h.lock().status,'completed');
  assert.equal(inspectTick(again).action,'skipped');
});

test('journée suivante : le succès de la veille ne compte plus, nouveau cycle dès 04:00 Réunion',async()=>{
  const h=setup();await h.done('2026-11-01T00:05:00Z');
  const before=await h.done('2026-11-01T23:50:00Z');assert.equal(before.reason,'already run recently','03:50 Réunion : encore la journée précédente');
  const next=await h.done('2026-11-02T00:05:00Z');assert.equal(next.triggered,true);assert.equal(next.summary.status,'completed');
  assert.equal(h.cycles().length,2);assert.equal(h.fetched.length,6);
});

test('échec partiel : relance limitée au producteur en échec, espacement 1 h, plafond de 3 tentatives',async()=>{
  const h=setup();h.setFailing([B]);
  const first=await h.done('2026-11-01T00:05:00Z');assert.equal(first.summary.status,'partial');
  const tooSoon=await h.done('2026-11-01T00:50:00Z');assert.deepEqual(tooSoon,{triggered:false,reason:'retry spacing',attemptsToday:1});
  assert.equal(inspectTick(tooSoon).action,'skipped');assert.equal(h.lock().status,'completed','verrou rendu après le refus');
  const second=await h.done('2026-11-01T01:10:00Z');assert.deepEqual(second.summary.expectedSources,[OPENAGENDA_SOURCES[1].key]);
  assert.equal(second.summary.status,'failed');
  const third=await h.done('2026-11-01T02:20:00Z');assert.equal(third.summary.status,'failed');
  assert.equal(h.fetched.filter(u=>u===A).length,1);assert.equal(h.fetched.filter(u=>u===C).length,1);assert.equal(h.fetched.filter(u=>u===B).length,3);
  const exhausted=await h.done('2026-11-01T05:00:00Z');
  assert.deepEqual(exhausted,{triggered:false,reason:'daily attempts exhausted',attemptsToday:SORTIR_MAX_CYCLE_ATTEMPTS_PER_DAY});
  assert.throws(()=>inspectTick(exhausted),/inachevé après 3 tentatives/);assert.equal(h.fetched.length,5);assert.equal(h.cycles().length,3);
  h.setFailing([]);const tomorrow=await h.done('2026-11-02T00:05:00Z');assert.equal(tomorrow.summary.status,'completed');assert.equal(tomorrow.summary.expectedCount,3);
});

test('rattrapage réussi au 2e essai : producteur rétabli, journée close sans nouvelle relance',async()=>{
  const h=setup();h.setFailing([C]);await h.done('2026-11-01T00:05:00Z');h.setFailing([]);
  const retry=await h.done('2026-11-01T04:00:00Z');assert.equal(retry.summary.status,'completed');assert.deepEqual(retry.summary.expectedSources,[OPENAGENDA_SOURCES[2].key]);
  assert.equal((await readCycleStatus(h.client,retry.cycleId)).successConfirmed,true);
  assert.equal((await h.done('2026-11-01T08:00:00Z')).reason,'already run recently');assert.equal(h.cycles().length,2);
});

test('concurrence : verrou tenu ailleurs, aucune tentative consommée ni lecture des tentatives',async()=>{
  const h=setup(),other=createSchedulerState(h.client);assert.equal(await other.acquire(at('2026-11-01T00:00:00Z')),true);
  const t=await h.done('2026-11-01T00:05:00Z');assert.deepEqual(t,{triggered:false,reason:'scheduler locked'});
  assert.equal(h.cycles().length,0);assert.equal(h.fetched.length,0);
  assert.equal(h.client.calls.some(c=>c.table==='sortir_ingestion_runs'&&c.action==='select'),false);
  await other.release(at('2026-11-01T00:06:00Z'));assert.equal((await h.done('2026-11-01T00:10:00Z')).triggered,true);
});

test('lecture des tentatives impossible : check failed, verrou rendu, aucune ingestion',async()=>{
  const h=setup(),broken={...h.client,from(t){const q=h.client.from(t);if(t!=='sortir_ingestion_runs')return q;const sel=q.select;q.select=(...a)=>{const r=sel(...a);r.then=(res)=>res({data:null,error:{message:'fetch failed'}});return r;};return q;}};
  const t=await h.done('2026-11-01T00:05:00Z',{client:broken});
  assert.equal(t.triggered,false);assert.equal(t.reason,'check failed');assert.throws(()=>inspectTick(t));
  assert.equal(h.lock().status,'completed');assert.equal(h.fetched.length,0);assert.equal(h.cycles().length,0);
});

test('transition de déploiement : "not due" d’un serveur pas encore redéployé reste un simple skip',()=>{
  assert.equal(inspectTick({triggered:false,reason:'not due'}).action,'skipped');
});
