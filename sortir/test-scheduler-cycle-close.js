"use strict";
// Clôture du run enveloppe : panne Supabase pendant la clôture, récupération, échec définitif.
// Stores mémoire et client factice uniquement : aucun réseau, aucune base réelle.
const test=require('node:test'),assert=require('node:assert/strict');
const {MemoryStore}=require('./test-helpers/memory-store'),{schedulerClient}=require('./test-helpers/scheduler-client');
const {createSchedulerState,LOCK_ID}=require('./scheduler-state');
const {readCycleStatus,isTransientStoreError,CYCLE_ROOT_VERSION}=require('./scheduler-cycle-status'),{inspectCycle}=require('./check-scheduler-response');
const ingestPath=require.resolve('../sortir-auto-ingest');
let {runSortirIngestTickIfDue,CYCLE_CLOSE_RETRY_DELAYS_MS}=require(ingestPath);
const now=new Date('2026-11-01T00:05:00Z');
const base={now,datatourismeMaxTotalPois:0,reunionSources:[],parisSources:[]};
global.fetch=async()=>{throw Error('Réseau réel interdit');};

function setup(){
  const db=new MemoryStore(),client=schedulerClient(db),state=createSchedulerState(client),log=[],sleeps=[];
  const update=db.updateIngestionRun.bind(db);
  const closing=[];let closeFault=null;
  db.updateIngestionRun=async(id,row)=>{
    if(row.finished_at&&row.error_summary?.[0]?.kind==='sortir_scheduler_cycle'){
      closing.push(structuredClone(row));log.push('close');
      if(closeFault)return closeFault({id,row,apply:()=>update(id,row),attempt:closing.length});
    }
    return update(id,row);
  };
  const release=state.release.bind(state);let releaseFault=null;
  state.release=async at=>{log.push('release');if(releaseFault)return releaseFault({apply:()=>release(at)});return release(at);};
  const sleep=async ms=>{sleeps.push(ms);};
  let producerCalls=0;
  const run=(extra={})=>runSortirIngestTickIfDue({...base,store:db,state,client,sleep,fetchEvents:async()=>{producerCalls++;return{results:[],fetchedCount:0};},...extra});
  return {db,client,state,log,sleeps,closing,run,get producerCalls(){return producerCalls;},
    setCloseFault(f){closeFault=f;},setReleaseFault(f){releaseFault=f;},
    lock(){return db.ingestions.find(r=>r.id===LOCK_ID);},cycleRows(){return db.ingestions.filter(r=>r.orchestrator_version===CYCLE_ROOT_VERSION);}};
}
async function withKey(fn){const old=process.env.OPENAGENDA_PUBLIC_KEY;process.env.OPENAGENDA_PUBLIC_KEY='valid-test-key';try{return await fn();}finally{old===undefined?delete process.env.OPENAGENDA_PUBLIC_KEY:process.env.OPENAGENDA_PUBLIC_KEY=old;}}
async function quietErrors(fn){const old=console.error,lines=[];console.error=(...a)=>lines.push(a.join(' '));try{return await fn(lines);}finally{console.error=old;}}

test('classification : seules les pannes transitoires sont rejouées',()=>{
  for(const m of ['TypeError: fetch failed','canceling statement due to statement timeout','connect ECONNREFUSED 1.2.3.4:443','upstream connect error','503 Service Unavailable','<html>502 Bad Gateway</html>','HTTP 504','',undefined,'PGRST001: could not connect'])assert.equal(isTransientStoreError({message:m}),true,String(m));
  for(const m of ['permission denied for table sortir_ingestion_runs','Cannot coerce the result to a single JSON object','new row violates check constraint','Verrou scheduler perdu : contrôle opérateur nécessaire','invalid input syntax for type uuid'])assert.equal(isTransientStoreError({message:m}),false,m);
  assert.equal(isTransientStoreError({message:'x',status:503}),true);assert.equal(isTransientStoreError({message:'fetch failed',status:403}),false);
  assert.deepEqual([...CYCLE_CLOSE_RETRY_DELAYS_MS],[2000,5000,15000,30000,60000]);
});

test('clôture réussie au premier essai : une seule écriture finale, avant la libération du verrou',()=>withKey(async()=>{
  const h=setup(),t=await h.run(),s=await t.workPromise;
  assert.equal(s.status,'completed');assert.equal(h.closing.length,1);assert.deepEqual(h.sleeps,[]);
  assert.deepEqual(h.log,['close','release']);assert.equal(h.lock().status,'completed');assert.equal(h.cycleRows().length,1);
  const st=await readCycleStatus(h.client,t.cycleId);assert.equal(inspectCycle(st).successConfirmed,true);
}));

test('panne transitoire puis récupération : verrou tenu, mêmes valeurs rejouées, aucune nouvelle ingestion',()=>withKey(()=>quietErrors(async()=>{
  const h=setup();let concurrent;
  h.setCloseFault(async({apply,attempt})=>{
    assert.equal(h.lock().status,'running','verrou tenu pendant les essais');
    if(attempt===1){await apply();throw Error('TypeError: fetch failed');} // écrite puis réponse perdue
    if(attempt===2){concurrent=[await h.run(),await createSchedulerState(h.client).acquire(now)];throw Error('canceling statement due to statement timeout');}
    return apply();
  });
  const t=await h.run(),s=await t.workPromise;
  assert.equal(s.status,'completed');assert.equal(h.closing.length,3);assert.deepEqual(h.sleeps,[2000,5000]);
  assert.deepEqual(h.closing[1],h.closing[0]);assert.deepEqual(h.closing[2],h.closing[0]);
  assert.deepEqual(concurrent[0],{triggered:false,reason:'already running'});assert.equal(concurrent[1],false);
  assert.equal(h.producerCalls,3);assert.equal(h.cycleRows().length,1);assert.deepEqual(h.log,['close','close','close','release']);
  assert.equal(h.lock().status,'completed');
  const st=await readCycleStatus(h.client,t.cycleId);assert.equal(st.status,'completed');assert.equal(inspectCycle(st).successConfirmed,true);
  const writes=h.closing.length;await h.run({now:new Date('2026-11-01T00:10:00Z')});assert.equal(h.closing.length,writes,'aucune double clôture');
})));

test('échec transitoire permanent : 6 essais bornés, run et verrou laissés running, jamais completed',()=>withKey(()=>quietErrors(async lines=>{
  const h=setup();h.setCloseFault(async()=>{throw Error('TypeError: fetch failed');});
  const t=await h.run(),s=await t.workPromise;
  assert.equal(h.closing.length,6);assert.deepEqual(h.sleeps,[2000,5000,15000,30000,60000]);
  assert.equal(s.status,'failed');assert.equal(s.successConfirmed,false);assert.equal(s.operatorActionRequired,true);
  assert.equal(h.log.includes('release'),false);assert.equal(h.lock().status,'running');
  const row=h.cycleRows()[0];assert.equal(row.status,'running');assert.equal(row.finished_at,undefined);
  const st=await readCycleStatus(h.client,t.cycleId);assert.equal(st.successConfirmed,false);assert.equal(inspectCycle(st).action,'poll');
  assert(lines.some(l=>l.includes('INTERVENTION OPÉRATEUR REQUISE')&&l.includes(t.cycleId)));
  const calls=h.producerCalls,next=await h.run({now:new Date('2026-11-01T00:10:00Z')});
  assert.deepEqual(next,{triggered:false,reason:'scheduler locked'});assert.equal(h.producerCalls,calls);assert.equal(h.cycleRows().length,1);
})));

test('erreur définitive : un seul essai, aucun délai, état conservateur',()=>withKey(()=>quietErrors(async()=>{
  const h=setup();h.setCloseFault(async()=>{throw Error('permission denied for table sortir_ingestion_runs');});
  const s=await (await h.run()).workPromise;
  assert.equal(h.closing.length,1);assert.deepEqual(h.sleeps,[]);assert.equal(s.operatorActionRequired,true);
  assert.equal(h.lock().status,'running');assert.equal(h.cycleRows()[0].status,'running');
})));

test('libération du verrou : transitoire rejouée ; perte confirmée → cycle rétrogradé failed',()=>withKey(()=>quietErrors(async()=>{
  const a=setup();let n=0;a.setReleaseFault(async({apply})=>{if(++n===1)throw Error('fetch failed');return apply();});
  const sa=await (await a.run()).workPromise;assert.equal(sa.status,'completed');assert.deepEqual(a.sleeps,[2000]);assert.equal(a.closing.length,1);assert.equal(a.lock().status,'completed');
  const b=setup();b.setReleaseFault(async()=>{throw Error('Verrou scheduler perdu : contrôle opérateur nécessaire');});
  const t=await b.run(),sb=await t.workPromise;
  assert.equal(sb.status,'failed');assert.equal(b.closing.length,2);assert.equal(b.closing[0].status,'completed');assert.equal(b.closing[1].status,'failed');
  assert.equal(b.closing[1].finished_at,b.closing[0].finished_at);
  const st=await readCycleStatus(b.client,t.cycleId);assert.equal(st.status,'failed');assert.equal(st.successConfirmed,false);assert.match(st.releaseError,/Verrou scheduler perdu/);
})));

test('interruption pendant la clôture puis redémarrage : aucune reprise silencieuse ni succès',()=>withKey(async()=>{
  const h=setup();h.setCloseFault(()=>new Promise(()=>{})); // processus tué : la clôture ne revient jamais
  const t=await h.run();for(let i=0;i<20&&!h.closing.length;i++)await new Promise(r=>setImmediate(r));
  assert.equal(h.closing.length,1);
  delete require.cache[ingestPath];({runSortirIngestTickIfDue}=require(ingestPath)); // nouveau processus
  const next=await h.run({now:new Date('2026-11-01T00:10:00Z')});
  assert.deepEqual(next,{triggered:false,reason:'scheduler locked'});assert.equal(h.cycleRows().length,1);
  assert.equal(h.lock().status,'running');const st=await readCycleStatus(h.client,t.cycleId);assert.equal(st.successConfirmed,false);assert.equal(inspectCycle(st).action,'poll');
}));
