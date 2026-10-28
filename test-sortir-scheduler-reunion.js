"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {runSortirIngestTickIfDue,OPENAGENDA_SOURCES,REUNION_SOURCES}=require('./sortir-auto-ingest');
const {createSchedulerState,LOCK_ID,CYCLE_VERSION}=require('./sortir/scheduler-state');
const {runReunionProducer}=require('./sortir/openagenda-reunion-daily');
const {MemoryStore}=require('./sortir/test-helpers/memory-store');
const {schedulerClient}=require('./sortir/test-helpers/scheduler-client');
const fixture=require('./sortir/fixtures/openagenda-reunion-v1-archived.json');
const {createExplorerCache}=require('../SUPABASE copie 3/lib/explorer');
const {makeFakeExplorerSupabase}=require('../SUPABASE copie 3/test/helpers/fake-explorer-supabase');
const now=new Date(fixture.asOf);process.env.OPENAGENDA_PUBLIC_KEY='cle-publique-factice-tests';
function setup(){const db=new MemoryStore(),client=schedulerClient(db),state=createSchedulerState(client);return{db,client,state};}
const base={now,timeToMinutes:s=>{const[h,m]=s.split(':');return +h*60 + +m},getReunionTimeHHMM:()=> '04:05',datatourismeMaxTotalPois:0,fetchEvents:async()=>({results:[],fetchedCount:0})};
async function tick(h,opts={}){const r=await runSortirIngestTickIfDue({...base,store:h.db,state:h.state,...opts});return r.workPromise?{tick:r,summary:await r.workPromise}:{tick:r};}
async function fixtureHttp(fn,{failUid,extra=false}={}){
 const old=global.fetch,calls=[];global.fetch=async(input,init={})=>{const u=new URL(input);assert.equal(u.hostname,'api.openagenda.com');assert.equal(init.method||'GET','GET');const match=u.pathname.match(/^\/v2\/agendas\/(\d+)(\/events)?$/);assert.ok(match,'URL fixture inconnue');const uid=+match[1];calls.push({uid,path:u.pathname,query:u.search});if(uid===failUid)throw Error('Panne producteur injectée');const group=fixture.producers.find(g=>g.uid===uid);assert.ok(group);if(!match[2])return new Response(JSON.stringify({schema:{fields:[]}}));let events=structuredClone(group.events);if(extra&&uid===50316469){for(const id of [5246977,68345357,44566861,2664063,41861302])events.push({...structuredClone(events.find(e=>e.uid===14738514)),uid:id,title:'Hors liste '+id});}return new Response(JSON.stringify({events,total:events.length,after:null}));};
 try{return await fn(calls)}finally{global.fetch=old;}
}
function frozenBusiness(db){return JSON.stringify({activities:db.activities,ids:db.externalIds,links:db.provenances.map(p=>[p.id,p.activity_id,p.source_id,p.source_record_id,p.source_occurrence_key,p.source_payload,p.payload_hash])});}

test('scheduler réel : exactement cinq producteurs Réunion, sélection V1, cartes, review, compteurs et rejeu',async()=>fixtureHttp(async calls=>{
 assert.deepEqual(REUNION_SOURCES.map(s=>s.agendaUid),[2568169,50316469,4740352,40627992,1059482]);const h=setup();const first=await tick(h);assert.equal(first.summary.status,'completed');assert.equal(first.summary.sources.length,8);assert.deepEqual(first.summary.sources.map(s=>s.source),[...OPENAGENDA_SOURCES,...REUNION_SOURCES].map(s=>s.key));assert.equal(h.db.activities.length,536);assert.equal(h.db.provenances.length,536);assert.equal(h.db.externalIds.length,1079);assert.equal(h.db.activities.filter(a=>a.record_status==='active').length,227);assert.equal(h.db.activities.filter(a=>a.record_status==='review').length,309);assert.equal(first.summary.sources.reduce((s,r)=>s+r.activitiesCreated,0),536);assert.equal(first.summary.sources.reduce((s,r)=>s+r.activitiesUpdated,0),0);
 assert.deepEqual(new Set(calls.map(c=>c.uid)),new Set(REUNION_SOURCES.map(s=>s.agendaUid)));assert.ok(calls.filter(c=>c.path.endsWith('/events')).every(c=>c.query.includes('geo%5B')||c.query.includes('geo[')));
 const cards=await createExplorerCache(makeFakeExplorerSupabase(h.db.activities.map(a=>({...a,provenances:h.db.provenances.filter(p=>p.activity_id===a.id)}))),{now:()=>+now})({departmentCode:'974',city:null},false,null);assert.equal(cards.activities.length,4);assert.ok(cards.activities.every(c=>h.db.activities.find(a=>a.id===c.id).record_status==='active'));assert.deepEqual(new Set(cards.activities.map(c=>c.city)),new Set(['Saint-Denis','Le Port']));assert.ok(cards.activities.some(c=>c.title.includes('octographiques')));assert.ok(cards.activities.some(c=>c.title==='Ambition Planète'));assert.ok(cards.activities.some(c=>c.title.includes('PUI VALIOTECH')));assert.ok(cards.activities.some(c=>c.title==='e-Nov 2026'));
 const before=frozenBusiness(h.db);const skipped=await tick(h);assert.equal(skipped.tick.reason,'already run recently');
 const replay=await tick(h,{state:{...h.state,recent:async()=>false}});assert.equal(replay.summary.status,'completed');assert.equal(frozenBusiness(h.db),before);assert.ok(replay.summary.sources.every(s=>s.activitiesCreated===0&&s.activitiesUpdated===0));
 assert.equal(h.db.activities.find(a=>a.title.includes('Énergétique')).postal_code,null);
},{extra:true}));

test('une erreur avant collecte est journalisée, isolée et ne bloque ni les autres producteurs ni DATAtourisme',async()=>fixtureHttp(async()=>{
 const h=setup();h.db.getSourceCursor=async()=> 'curseur-existant';const cursors=[];h.db.saveSourceCursor=async(key,url)=>cursors.push({key,url});const env=process.env.DATATOURISME_API_KEY;process.env.DATATOURISME_API_KEY='factice';let dt=0;
 try {const r=await tick(h,{datatourismeMaxTotalPois:1,fetchDatatourisme:async args=>{dt++;assert.equal(args.resumeUrl,'curseur-existant');return{results:[],fetchedCount:0,exhausted:true,nextPageUrl:null}},persist:async()=>({status:'completed',stats:{}})});assert.equal(r.summary.status,'partial');assert.equal(r.summary.sources.length,9);assert.equal(dt,1);assert.deepEqual(cursors,[{key:'datatourisme-national',url:null}]);const failed=r.summary.sources.find(s=>s.source===REUNION_SOURCES[0].key);assert.equal(failed.status,'failed');assert.match(failed.error,/Panne producteur/);const source=h.db.sources.find(s=>s.key===failed.source);assert.ok(h.db.sourceRuns.some(r=>r.source_id===source.id&&r.status==='failed'&&r.error.includes('Panne producteur')));assert.equal(r.summary.sources.find(s=>s.source===REUNION_SOURCES[1].key).status,'completed');assert.equal(h.db.activities.length,7);
 }finally{if(env===undefined)delete process.env.DATATOURISME_API_KEY;else process.env.DATATOURISME_API_KEY=env;}
},{failUid:2568169}));

test('Senlis completed ne supprime pas Réunion ; seule la source échouée est retentée',async()=>fixtureHttp(async calls=>{
 const h=setup();await tick(h);const source=h.db.sources.find(s=>s.key===REUNION_SOURCES[0].key);const wrapper=h.db.sourceRuns.find(r=>r.source_id===source.id&&h.db.ingestions.find(i=>i.id===r.ingestion_run_id)?.orchestrator_version===CYCLE_VERSION);wrapper.status='failed';calls.length=0;const r=await tick(h);assert.deepEqual(r.summary.sources.map(s=>s.source),[source.key]);assert.ok(calls.every(c=>c.uid===2568169));assert.equal(h.db.activities.length,536);
}));

test('une tranche completed suivie d’une panne ne certifie pas le producteur ; reprise idempotente',async()=>fixtureHttp(async()=>{
 const h=setup();const original=h.db.createActivitiesBatch.bind(h.db);let n=0;h.db.createActivitiesBatch=async rows=>{if(++n===2)throw Error('panne seconde tranche');return original(rows)};const first=await tick(h,{openAgendaSources:[],reunionSources:[REUNION_SOURCES[0]]});assert.equal(first.summary.status,'failed');assert.equal(first.summary.sources[0].activitiesCreated,100);assert.ok(first.summary.sources[0].stats.collected>=100);assert.equal(h.db.activities.length,100);assert.equal(await h.state.recent(REUNION_SOURCES[0].key,new Date(+now-20*3600000).toISOString()),false);h.db.createActivitiesBatch=original;const r=await tick(h,{openAgendaSources:[],reunionSources:[REUNION_SOURCES[0]]});assert.equal(r.summary.status,'completed');assert.equal(h.db.activities.length,529);assert.equal(h.db.provenances.length,529);assert.equal(new Set(h.db.provenances.map(p=>p.source_occurrence_key)).size,529);
}));

test('troncature : aucune occurrence persistée, run failed explicite',async()=>{
 const h=setup();const r=await tick(h,{openAgendaSources:[],reunionSources:[REUNION_SOURCES[0]],fetchReunionSchema:async()=>({fields:[]}),fetchReunionEvents:async()=>({truncated:true})});assert.equal(r.summary.status,'failed');assert.equal(h.db.activities.length,0);assert.match(r.summary.error,/tronquée/);assert.equal(h.db.sourceRuns[0].status,'failed');
});

test('verrou atomique entre deux clients/processus, libération, absence de reprise d’un verrou running',async()=>{
 const h=setup(),other=createSchedulerState(schedulerClient(h.db));const acquired=await Promise.all([h.state.acquire(now),other.acquire(now)]);assert.equal(acquired.filter(Boolean).length,1);assert.equal(await other.acquire(new Date(+now+86400000)),false);await h.state.release(now);assert.equal(await other.acquire(now),true);await other.release(now);assert.equal(h.db.ingestions.filter(r=>r.id===LOCK_ID).length,1);
});

test('verrou tenu par une autre instance et ingestion manuelle active : aucun lancement',async()=>{
 const h=setup();await h.state.acquire(now);assert.equal((await tick(h)).tick.reason,'scheduler locked');await h.state.release(now);h.db.ingestions.push({id:'manuel',status:'running'});assert.equal((await tick(h)).tick.reason,'another ingestion running');assert.equal(h.db.sourceRuns.length,0);assert.equal(h.db.ingestions.find(r=>r.id===LOCK_ID).status,'completed');
});

test('échec de contrôle/du constructeur client ne bloque pas définitivement inFlight',async()=>{
 const h=setup();const bad=await tick(h,{state:{...h.state,acquire:async()=>{throw Error('base indisponible')}}});assert.equal(bad.tick.reason,'check failed');const next=await tick(h,{openAgendaSources:[],reunionSources:[]});assert.equal(next.tick.reason,'already run recently');
});

test('DT partial est rendu partial et une panne DT n’invalide pas les producteurs OpenAgenda terminés',async()=>{
 const h=setup(),env=process.env.DATATOURISME_API_KEY;process.env.DATATOURISME_API_KEY='factice';h.db.getSourceCursor=async()=> 'stable';let writes=0;h.db.saveSourceCursor=async()=>{writes++};
 try {const r=await tick(h,{reunionSources:[],datatourismeMaxTotalPois:1,fetchDatatourisme:async()=>({results:[],fetchedCount:1,exhausted:false,nextPageUrl:'suivant'}),persist:async({sources})=>({status:sources[0].connectorType==='datatourisme'?'partial':'completed',stats:{}})});assert.equal(r.summary.status,'partial');assert.equal(writes,0);assert.ok(r.summary.sources.filter(s=>s.source!=='datatourisme-national').every(s=>s.status==='completed'));assert.equal(await h.state.recent(OPENAGENDA_SOURCES[0].key,new Date(+now-7200000).toISOString()),true);assert.equal(await h.state.recent('datatourisme-national',new Date(+now-7200000).toISOString()),false);
 } finally {if(env===undefined)delete process.env.DATATOURISME_API_KEY;else process.env.DATATOURISME_API_KEY=env;}
});

test('un source_run running sans ingestion running empêche un chevauchement',async()=>{
 const h=setup();h.db.sourceRuns.push({id:'orphelin-running',status:'running'});const r=await tick(h);assert.equal(r.tick.reason,'another ingestion running');assert.equal(h.db.sources.length,0);
});

test('deux ticks simultanés ne démarrent qu’un cycle ; l’autre est refusé avant collecte',async()=>{
 const h=setup();let count=0;const fetchEvents=async()=>{count++;await new Promise(r=>setTimeout(r,5));return{results:[]}};
 const opts={...base,store:h.db,state:h.state,reunionSources:[],fetchEvents};const both=await Promise.all([runSortirIngestTickIfDue(opts),runSortirIngestTickIfDue(opts)]);assert.equal(both.filter(r=>r.triggered).length,1);assert.equal(both.find(r=>!r.triggered).reason,'already running');await both.find(r=>r.triggered).workPromise;assert.equal(count,3);
});

test('journalisation indisponible pour une source : erreur visible et sources suivantes traitées',async()=>{
 const h=setup(),ensure=h.db.ensureSource.bind(h.db);h.db.ensureSource=async source=>{if(source.key===OPENAGENDA_SOURCES[0].key)throw Error('registre inaccessible');return ensure(source)};
 const r=await tick(h,{reunionSources:[]});assert.equal(r.summary.status,'partial');assert.match(r.summary.error,/registre inaccessible/);assert.equal(r.summary.sources.length,3);assert.equal(r.summary.sources[1].status,'completed');assert.equal(h.db.ingestions.find(i=>i.orchestrator_version===CYCLE_VERSION).status,'failed');
});

test('une erreur de libération est visible ; aucun vol de verrou au prochain tick',async()=>{
 const h=setup();const r=await tick(h,{reunionSources:[],state:{...h.state,release:async()=>{throw Error('libération impossible')}}});assert.equal(r.summary.status,'failed');assert.match(r.summary.error,/libération impossible/);assert.equal((await tick(h)).tick.reason,'scheduler locked');
});

test('une erreur de callback de suivi ne masque pas le résultat métier et laisse traiter la suite',async()=>{
 const h=setup();const r=await tick(h,{reunionSources:[],onBatchSummary:()=>{throw Error('suivi injecté')}});assert.equal(r.summary.status,'partial');assert.equal(r.summary.sources.length,3);assert.ok(r.summary.sources.every(s=>s.status==='completed'&&s.reportingError==='suivi injecté'));
});

test('panne du fetch Senlis : les deux autres agendas et DATAtourisme restent exécutés',async()=>{
 const h=setup(),env=process.env.DATATOURISME_API_KEY;process.env.DATATOURISME_API_KEY='factice';h.db.getSourceCursor=async()=>null;h.db.saveSourceCursor=async()=>{};const calls=[];
 try {const r=await tick(h,{reunionSources:[],datatourismeMaxTotalPois:1,fetchEvents:async({agendaUid})=>{calls.push(agendaUid);if(agendaUid===56170473)throw Error('fetch Senlis indisponible');return{results:[]}},fetchDatatourisme:async()=>{calls.push('DT');return{fetchedCount:0,results:[],exhausted:true}},persist:async()=>({status:'completed',stats:{}})});assert.equal(r.summary.status,'partial');assert.deepEqual(calls,[56170473,26110493,60837943,'DT']);assert.match(h.db.sourceRuns[0].error,/fetch Senlis indisponible/);
 }finally{if(env===undefined)delete process.env.DATATOURISME_API_KEY;else process.env.DATATOURISME_API_KEY=env;}
});

test('compteurs de mise à jour mesurés sur le store, sans confondre une bascule de création avec une mise à jour',async()=>{
 const h=setup();const {convertOpenAgendaJsonEvent}=require('./sortir/connectors/openagenda-json');const event=fixture.producers.find(g=>g.uid===50316469).events.find(e=>e.uid===14738514);const item=convertOpenAgendaJsonEvent(event,{agendaUid:50316469,now,sourceName:'Test',sourceUrl:'https://api.openagenda.com/v2/agendas/50316469/events'})[0];let change=false;
 const opts={openAgendaSources:[OPENAGENDA_SOURCES[0]],reunionSources:[],fetchEvents:async()=>{const row=structuredClone(item);if(change)row.activity.description='Description enrichie et confirmée pour ce congrès ouvert au public. '.repeat(20);return{results:[row],fetchedCount:1}}};
 const first=await tick(h,opts);assert.equal(first.summary.sources[0].activitiesCreated,1);assert.equal(first.summary.sources[0].activitiesUpdated,0);change=true;
 const updated=await tick(h,{...opts,state:{...h.state,recent:async()=>false}});assert.equal(updated.summary.status,'completed');assert.equal(updated.summary.sources[0].activitiesCreated,0);assert.equal(updated.summary.sources[0].activitiesUpdated,1);assert.equal(h.db.activities.length,1);
});

test('échec de fermeture du source_run : tentative de fermeture du run enveloppe et poursuite des autres producteurs',async()=>{
 const h=setup(),update=h.db.updateSourceRun.bind(h.db);h.db.updateSourceRun=async(id,row)=>{const source=h.db.sourceRuns.find(r=>r.id===id);if(source.source_id===h.db.sources[0]?.id)throw Error('journal source indisponible');return update(id,row)};
 const r=await tick(h,{reunionSources:[],persist:async()=>({status:'completed',stats:{}})});assert.equal(r.summary.status,'partial');assert.match(r.summary.error,/journal source indisponible/);assert.equal(h.db.ingestions.find(i=>i.orchestrator_version===CYCLE_VERSION).status,'failed');assert.equal(r.summary.sources[2].status,'completed');
});
