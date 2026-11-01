"use strict";
const {activityToRow}=require('../supabase-persistence');
const {evaluateOrganizerRecovery}=require('../organizer-review-recovery');
const {rowToActivity}=require('../supabase-persistence');
const {TemporalCandidateIndex}=require('../temporal-candidate-cache');
const uuid=n=>`11111111-2222-4333-8444-${String(n).padStart(12,'0')}`;
function fixture(){
 const sources=[{id:uuid(9000),key:'datatourisme-national',connector_type:'datatourisme',base_url:'https://dt.example/api'}],rows=[],items=[],decisions=[],cities=[['Paris','75001',48.86,2.35],['Lyon','69001',45.77,4.83],['Marseille','13001',43.30,5.38],['Toulouse','31000',43.60,1.44],['Strasbourg','67000',48.58,7.75]];
 function add(n,extra={}){const [city,postal,lat,lon]=cities[n%5],start='2027-11-01T10:00:00.000Z',end='2027-11-01T12:00:00.000Z';
 const a={title:'oeuvre'+n,description:'Cette présentation culturelle originale propose une découverte documentée des collections dans un lieu dédié aux rencontres artistiques avec un programme ouvert à tous les publics.',startsAt:start,endsAt:end,timezone:'Europe/Paris',lifecycleStatus:'scheduled',locationType:'physical',venueName:'Musée',address:'1 rue du Musée',postalCode:postal,city,country:'FR',latitude:lat,longitude:lon,organizers:[{name:null,url:'https://museum.example/contact'}],confidence:.95,fieldConfidence:{},evidence:[],externalIds:[],provenances:[],...extra};
 const id=uuid(n),key=`datatourisme:${id}:${start}:end=${end}`,p={id:uuid(10000+n),activity_id:id,source_id:sources[0].id,source_record_id:`datatourisme:${id}:${start}`,source_occurrence_key:key,active:true,original_event_url:'https://data.example/'+id,payload_hash:'fixture-'+n,first_seen_at:'2026-10-20T00:00:00Z',last_seen_at:'2026-10-28T00:00:00Z',source_payload:{version:'datatourisme-period-v2',period:{startTime:'11:00'},normalized:{startsAt:start,endsAt:end,timezone:a.timezone}},source:sources[0]};
 const row={...activityToRow(a,'review'),id,updated_at:'2026-10-28T00:00:00Z',provenances:[p],external_ids:[{activity_id:id,source_id:sources[0].id,system:'datatourisme-poi',value:id},{activity_id:id,source_id:sources[0].id,system:'datatourisme-occurrence',value:key}]};for(const key of Object.keys(row))if(row[key]===undefined)row[key]=null;rows.push(row);return row;}
 for(let n=1;n<=75;n++){const r=add(n,n>=71?{fieldConfidence:{title:.1}}:{});items.push({id:uuid(20000+n),activity_id:r.id,source_run_id:uuid(9001),validation_status:'NEEDS_REVIEW',diagnostics:{warnings:[{code:'organizer_name_missing'}]}});}
 const sentinel=add(76);for(let n=51;n<=60;n++)decisions.push({id:uuid(30000+n),left_activity_id:uuid(n),right_activity_id:sentinel.id,decision:'REVIEW',review_status:'pending',algorithm_version:'sortir-dedup-v4',signals:[]});
 for(let n=61;n<=70;n++){const r=rows[n-1];r.title='Exposition merveilleuse '+n;const other=add(100+n);for(const k of ['city','postal_code','latitude','longitude'])other[k]=r[k];other.title=r.title+' collective';}
 for(let n=1000;n<1646;n++)add(n);
 const asOf='2026-10-28T17:38:11.011Z',index=new TemporalCandidateIndex();rows.forEach(r=>index.set(r.id,r));const diagnosticIds=new Set(items.map(i=>i.activity_id));
 const results=rows.slice(0,75).map(row=>evaluateOrganizerRecovery({row,candidates:index.matches(rowToActivity(row)),decisions,hasDiagnostic:true,asOf}));
 const result={mode:'dry-run',asOf,complete:true,totals:{errors:0},results};
 return {snapshot:{rows,decisions,collectionItems:items,diagnosticIds,sources,snapshotKey:'synthetic-75-plus-646',asOf},result};
}
async function schema(client,sql){
 await client.query('drop schema public cascade; create schema public');
 await client.query('drop role if exists sortir_organizer_recovery_writer');
 for(const role of ['anon','authenticated','service_role'])await client.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='${role}') then create role ${role} nologin;end if;end $$`);
 const f=fixture(),r=f.snapshot.rows[0],defs=Object.entries(r).filter(([k])=>!['provenances','external_ids'].includes(k)).map(([k,v])=>`"${k}" ${k==='id'?'uuid primary key':k.endsWith('_at')?'timestamptz':v&&typeof v==='object'?'jsonb':typeof v==='number'?'double precision':'text'}`);
 await client.query(`create table public.sortir_activities(${defs.join(',')})`);
 await client.query(`create table public.sortir_sources(id uuid primary key,key text,connector_type text,base_url text);
 create table public.sortir_provenances(id uuid primary key,activity_id uuid,source_id uuid,source_record_id text,source_occurrence_key text,active boolean,original_event_url text,payload_hash text,first_seen_at timestamptz,last_seen_at timestamptz,source_payload jsonb);
 create table public.sortir_external_ids(activity_id uuid,source_id uuid,system text,value text,primary key(activity_id,source_id,system,value));
 create table public.sortir_collection_items(id uuid primary key,activity_id uuid,source_run_id uuid,validation_status text,diagnostics jsonb);
 create table public.sortir_dedup_decisions(id uuid primary key,left_activity_id uuid,right_activity_id uuid,decision text,review_status text,algorithm_version text,signals jsonb);
 create table public.sortir_ingestion_runs(id uuid primary key,orchestrator_version text,status text);
 create table public.sortir_source_runs(id uuid primary key,status text);
 create table public.sortir_datatourisme_poi_states(id uuid primary key);
 alter table public.sortir_activities enable row level security;`);
 await client.query(sql);return f;
}
async function seed(client,f){
 for(const table of ['sortir_activities','sortir_sources','sortir_provenances','sortir_external_ids','sortir_collection_items','sortir_dedup_decisions','sortir_ingestion_runs','sortir_source_runs','sortir_datatourisme_poi_states','sortir_organizer_recovery_batches'])await client.query('truncate public.'+table);
 const s=f.snapshot,ps=s.rows.flatMap(r=>r.provenances.map(({source,...p})=>p)),es=s.rows.flatMap(r=>r.external_ids);
 for(const [table,data]of [['sortir_sources',s.sources],['sortir_activities',s.rows.map(({provenances,external_ids,...r})=>r)],['sortir_provenances',ps],['sortir_external_ids',es],['sortir_collection_items',s.collectionItems],['sortir_dedup_decisions',s.decisions]])if(data.length)await client.query(`insert into public.${table} select * from jsonb_populate_recordset(null::public.${table},$1::jsonb)`,[JSON.stringify(data)]);
 const {LOCK_ID,LOCK_VERSION}=require('../scheduler-state');await client.query('insert into public.sortir_ingestion_runs values($1,$2,$3)',[LOCK_ID,LOCK_VERSION,'completed']);
}
module.exports={fixture,schema,seed,uuid};
