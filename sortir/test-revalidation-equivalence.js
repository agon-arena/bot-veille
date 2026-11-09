"use strict";
// Équivalence ancienne (groupes de 25, horloge à chaque page) / nouvelle revalidation
// (union des 100 cibles, 2 allers-retours par page) sur le même moteur PostgreSQL local.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const F=require('./test-helpers/organizer-writer-fixture'),D=require('./test-helpers/revalidation-dataset');
const S=require('./historical-recovery-supervisor'),{legacyRevalidateBatch}=require('./test-helpers/legacy-revalidation');
const FAR='2028-01-01T00:00:00Z';
let engine,db;
before(async()=>{
  engine=new PGlite();db={query:async(s,p)=>p?engine.query(s,p):(await engine.exec(s)).at(-1)||{rows:[]}};
  await F.schema(db,fs.readFileSync(path.join(__dirname,'../migrations/2026-10-29-sortir-organizer-recovery-journal.sql'),'utf8'));
  await db.query("alter table sortir_sources add column datatourisme_national_scan jsonb default '{\"status\":\"finalized\"}'");
});
after(()=>engine.close());
async function prepare(options){const data=D.build(options);await D.load(db,data);return {data,...await D.sealPlan(db,data.targetRows)};}
async function run(fn,plan,{deadline=FAR,clock}={}){
  const queries=[],seen=new Map(),decisions=[];let clocks=0;
  const client={query:async(s,a)=>{
    queries.push({s,a});
    if(clock&&s.includes('clock_timestamp')){clocks++;const now=clock(clocks);if(now)return {rows:[{now}]};}
    const r=await db.query(s,a);
    if(s.includes('ORDER BY a.id LIMIT 100'))assert(r.rows.length<=100,'au plus 100 candidats en mémoire par page');
    return r;
  }};
  const observe=o=>{decisions.push(o.decision);const set=seen.get(o.id)||new Set();for(const id of o.candidates)if(id!==o.id)set.add(id);seen.set(o.id,set);};
  try{const result=await fn(client,plan,0,deadline,{observe});return {result,queries,seen,decisions};}
  catch(error){return {error,queries,seen,decisions};}
}
const sorted=set=>[...set].sort();
for(const options of [{seed:11,days:4},{seed:23,days:1,targets:110,candidates:1600},{seed:5,days:12,targets:120,candidates:1200}]){
  test(`mêmes candidats et mêmes décisions pour chaque cible (seed ${options.seed}, ${options.days} j)`,async()=>{
    const {plan,authoritative}=await prepare(options);
    const old=await run(legacyRevalidateBatch,plan),now=await run(S.revalidateBatch,plan);
    assert.equal(old.error,undefined);assert.equal(now.error,undefined);
    assert.equal(now.result.targets,plan.entries.length);
    for(const e of plan.entries){
      // Ensemble des candidats évalués : identique entre ancienne et nouvelle version,
      // et identique à celui du writer (chemin autoritatif sous verrous).
      assert.deepEqual(sorted(now.seen.get(e.id)),sorted(old.seen.get(e.id)),e.id);
      assert.deepEqual(sorted(now.seen.get(e.id)),sorted(authoritative.get(e.id).candidates),e.id);
    }
    assert(old.decisions.every(d=>d==='PROMOTE')&&now.decisions.every(d=>d==='PROMOTE'));
    const candidateQueries=now.queries.filter(q=>q.s.includes('ORDER BY a.id LIMIT 100'));
    assert(candidateQueries.every(q=>q.a[0].length===plan.entries.length&&q.a[0].length<=100));
    assert.equal(now.queries.filter(q=>q.s.includes('clock_timestamp')).length,2);
    assert(now.queries.length<old.queries.length&&now.result.candidatePages<old.result.candidatePages);
    assert(sorted(new Set([...now.seen.values()].flatMap(s=>[...s]))).length>plan.entries.length,'jeu de données réellement chargé');
  });
}
async function mutate(kind,plan,data){
  const target=data.targetRows.find(t=>t.id===plan.entries[73].id);
  const twin=async(shiftMs,status='active')=>{
    const id=F.uuid(999999),start=new Date(Date.parse(target.starts_at)+shiftMs).toISOString(),end=new Date(Date.parse(target.ends_at)+shiftMs).toISOString();
    await db.query(`insert into sortir_activities select * from jsonb_populate_record(null::sortir_activities,$1::jsonb)`,[JSON.stringify({...Object.fromEntries(Object.entries(target).filter(([k])=>!['provenances','external_ids'].includes(k))),id,record_status:status,starts_at:start,ends_at:end})]);
    await db.query(`insert into sortir_provenances select * from jsonb_populate_record(null::sortir_provenances,$1::jsonb)`,[JSON.stringify({...target.provenances[0],id:F.uuid(999998),activity_id:id,source_id:data.sources[1].id,source_occurrence_key:'twin'})]);
  };
  if(kind==='match')await twin(0);
  else if(kind==='match_at_12h')await twin(12*D.HOUR);
  else if(kind==='match_after_12h')await twin(12*D.HOUR+60000);
  else if(kind==='match_archived')await twin(0,'archived');
  else if(kind==='fingerprint')await db.query("update sortir_provenances set payload_hash='modifie' where activity_id=$1",[target.id]);
  else if(kind==='quarantine')await db.query("insert into sortir_dedup_decisions values($1,$2,$3,'REVIEW','pending','sortir-dedup-v4','[]'::jsonb)",[F.uuid(999997),target.id,data.targetRows[0].id]);
  else if(kind==='deleted')await db.query('delete from sortir_activities where id=$1',[target.id]);
  else if(kind==='status')await db.query("update sortir_activities set record_status='active' where id=$1",[target.id]);
}
for(const kind of ['match','match_at_12h','match_after_12h','match_archived','fingerprint','quarantine','deleted','status']){
  test(`modification concurrente « ${kind} » : même verdict des deux versions`,async()=>{
    const {plan,data}=await prepare({seed:11,days:4});await mutate(kind,plan,data);
    const old=await run(legacyRevalidateBatch,plan),now=await run(S.revalidateBatch,plan);
    assert.equal(now.error?.code,old.error?.code,kind);assert.equal(now.error?.message,old.error?.message,kind);
    // Borne incluse : un doublon à exactement +12 h est vu par les deux versions.
    if(['match','fingerprint','quarantine','deleted','status','match_at_12h'].includes(kind))assert.equal(now.error?.code,'BUSINESS',kind);
    if(['match_after_12h','match_archived'].includes(kind))assert.equal(now.error,undefined,kind);
  });
}
test('échéance : dépassée au départ ou pendant la pagination => arrêt EXPIRED des deux versions, avant tout retour',async()=>{
  const {plan}=await prepare({seed:11,days:4});
  for(const clock of [()=>FAR,n=>n>=6?FAR:null]){
    const old=await run(legacyRevalidateBatch,plan,{deadline:FAR,clock}),now=await run(S.revalidateBatch,plan,{deadline:FAR,clock});
    if(clock.length===0){assert.equal(old.error?.code,'EXPIRED');assert.equal(now.error?.code,'EXPIRED');continue;}
    // Horloge serveur dépassant l'échéance après 5 lectures : l'ancienne version s'arrête
    // pendant la pagination, la nouvelle à sa lecture finale. Aucune ne valide le lot.
    assert.equal(old.error?.code,'EXPIRED');
    const late=await run(S.revalidateBatch,plan,{deadline:FAR,clock:n=>n>=2?FAR:null});
    assert.equal(late.error?.code,'EXPIRED');assert.equal(late.result,undefined);
  }
});
