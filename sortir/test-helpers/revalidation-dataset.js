"use strict";
// Jeu de données déterministe pour comparer l'ancienne et la nouvelle revalidation sur
// le même moteur PostgreSQL local : cibles réparties sur quelques jours (fenêtres qui se
// recouvrent comme en production), candidats actifs/review/archivés, deux sources,
// candidats exactement aux bornes ±12 h, et plus de 100 candidats par fenêtre.
const {activityToRow}=require('../supabase-persistence');
const {TemporalCandidateIndex}=require('../temporal-candidate-cache');
const {evaluateOrganizerRecovery}=require('../organizer-review-recovery');
const {rowToActivity}=require('../supabase-persistence');
const W=require('../organizer-review-writer');
const F=require('./organizer-writer-fixture');
const HOUR=3600000,BASE=Date.parse('2027-11-01T00:00:00Z');
const CITIES=[['Paris','75001',48.86,2.35],['Lyon','69001',45.77,4.83],['Marseille','13001',43.30,5.38]];
const WORDS=['jazz','baroque','lecture','sculpture','cinema','danse','poesie','theatre','photo','opera','conte','marionnette','histoire','science','vitrail'];
function rng(seed){return ()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};}
function build({targets=130,candidates=1400,days=4,seed=11}={}){
  const r=rng(seed),pick=a=>a[Math.floor(r()*a.length)],used=new Set();
  const id=()=>{let k;do k=1+Math.floor(r()*999999);while(used.has(k));used.add(k);return F.uuid(k);};
  const sources=[{id:F.uuid(9000),key:'datatourisme-national',connector_type:'datatourisme',base_url:'https://dt.example/api',datatourisme_national_scan:{status:'finalized'}},{id:F.uuid(9001),key:'openagenda-test',connector_type:'openagenda',base_url:'https://oa.example/api'}];
  const rows=[],items=[];
  function add({start,title,cityIndex,status='review',dt=true}){
    const [city,postal,lat,lon]=CITIES[cityIndex],startsAt=new Date(start).toISOString(),endsAt=new Date(start+2*HOUR).toISOString(),aid=id();
    const a={title,description:'Cette présentation culturelle originale propose une découverte documentée des collections dans un lieu dédié aux rencontres artistiques avec un programme ouvert à tous les publics.',startsAt,endsAt,timezone:'Europe/Paris',lifecycleStatus:'scheduled',locationType:'physical',venueName:'Salle '+title,address:'1 rue '+title,postalCode:postal,city,country:'FR',latitude:lat+r()/50,longitude:lon+r()/50,organizers:[{name:null,url:'https://org.example/'+aid}],confidence:.95,fieldConfidence:{},evidence:[],externalIds:[],provenances:[]};
    const source=sources[dt?0:1],key=`${source.key}:${aid}:${startsAt}:end=${endsAt}`;
    const p={id:id(),activity_id:aid,source_id:source.id,source_record_id:`${source.key}:${aid}:${startsAt}`,source_occurrence_key:key,active:true,original_event_url:'https://data.example/'+aid,payload_hash:'h-'+aid,first_seen_at:'2026-10-20T00:00:00Z',last_seen_at:'2026-10-28T00:00:00Z',source_payload:{version:'datatourisme-period-v2',period:{startTime:'11:00'},normalized:{startsAt,endsAt,timezone:'Europe/Paris'}}};
    const ext=dt?[{activity_id:aid,source_id:source.id,system:'datatourisme-poi',value:aid},{activity_id:aid,source_id:source.id,system:'datatourisme-occurrence',value:key}]:[{activity_id:aid,source_id:source.id,system:'openagenda-event',value:aid}];
    const row={...activityToRow(a,status),id:aid,updated_at:'2026-10-28T00:00:00Z',provenances:[p],external_ids:ext};
    for(const k of Object.keys(row))if(row[k]===undefined)row[k]=null;rows.push(row);return row;
  }
  const targetRows=[];
  for(let i=0;i<targets;i++){
    const start=BASE+Math.floor(r()*days)*24*HOUR+(8+Math.floor(r()*12))*HOUR+Math.floor(r()*4)*15*60000;
    const row=add({start,title:`${pick(WORDS)} ${pick(WORDS)} cible${i}`,cityIndex:i%3});targetRows.push(row);
    items.push({id:id(),activity_id:row.id,source_run_id:F.uuid(9002),validation_status:'NEEDS_REVIEW',diagnostics:{warnings:[{code:'organizer_name_missing'}]}});
  }
  // Bornes exactes : inclus à ±12 h, exclus à ±12 h + 1 min (inclusion SQL BETWEEN et matches()).
  for(const t of targetRows.slice(0,4))for(const d of [-12*HOUR-60000,-12*HOUR,-12*HOUR+60000,12*HOUR-60000,12*HOUR,12*HOUR+60000])
    add({start:Date.parse(t.starts_at)+d,title:`${t.title.split(' ')[0]} borne${rows.length}`,cityIndex:CITIES.findIndex(c=>c[0]===t.city),status:'active',dt:false});
  for(let i=0;i<candidates;i++){
    const start=BASE-14*HOUR+Math.floor(r()*((days*24+28)*4))*15*60000,u=r();
    add({start,title:`${pick(WORDS)} ${pick(WORDS)} c${i}`,cityIndex:Math.floor(r()*3),status:u<.7?'active':u<.9?'review':'archived',dt:r()<.5});
  }
  return {sources,rows,items,targetRows};
}
async function load(db,data){
  for(const table of ['sortir_activities','sortir_sources','sortir_provenances','sortir_external_ids','sortir_collection_items','sortir_dedup_decisions','sortir_ingestion_runs','sortir_source_runs','sortir_datatourisme_poi_states','sortir_organizer_recovery_batches'])await db.query('truncate public.'+table);
  const ps=data.rows.flatMap(r=>r.provenances),es=data.rows.flatMap(r=>r.external_ids);
  for(const [table,rows] of [['sortir_sources',data.sources],['sortir_activities',data.rows.map(({provenances,external_ids,...r})=>r)],['sortir_provenances',ps],['sortir_external_ids',es],['sortir_collection_items',data.items]])
    await db.query(`insert into public.${table} select * from jsonb_populate_recordset(null::public.${table},$1::jsonb)`,[JSON.stringify(rows)]);
  const {LOCK_ID,LOCK_VERSION}=require('../scheduler-state');await db.query('insert into public.sortir_ingestion_runs values($1,$2,$3)',[LOCK_ID,LOCK_VERSION,'completed']);
}
// Décisions et empreintes calculées par le chemin AUTORITATIF du writer (loadCurrent +
// index complet), comme une simulation de scellement : seules les PROMOTE entrent au plan.
async function sealPlan(db,targetRows,size=100){
  const current=await W.loadCurrent(db,targetRows.map(t=>t.id)),index=new TemporalCandidateIndex();
  for(const row of current.rows)if(['active','review'].includes(row.record_status))index.set(row.id,row);
  const asOf=(await db.query('select clock_timestamp() as now')).rows[0].now,authoritative=new Map(),entries=[];
  for(const t of targetRows){
    const row=current.byId.get(t.id),candidates=index.matches(rowToActivity(row));
    const ev=evaluateOrganizerRecovery({row,candidates,decisions:current.decisions,hasDiagnostic:true,asOf});
    authoritative.set(t.id,{decision:ev.decision,candidates:new Set(candidates.filter(c=>c.id!==t.id).map(c=>c.id))});
    if(ev.decision==='PROMOTE'&&entries.length<size)entries.push({id:t.id,decision:'PROMOTE',expectedHash:W.fingerprint(row,current.items,current.decisions)});
  }
  entries.sort((a,b)=>a.id.localeCompare(b.id));
  return {plan:{batchSize:size,entries},authoritative};
}
module.exports={build,load,sealPlan,HOUR};
