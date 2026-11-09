"use strict";
// Vérification incrémentale du journal : même verdict que la vérification intégrale
// historique pour toute altération, suppression ou insertion (moteur PostgreSQL local).
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const F=require('./test-helpers/organizer-writer-fixture'),S=require('./historical-recovery-supervisor'),W=require('./organizer-review-writer');
const FAR='2028-01-01T00:00:00Z';
let engine,db,bundle,queries=[];
const client={query:(s,a)=>{queries.push(s);return db.query(s,a);}};
function makePlan(label,count){
  const plan={batchSize:2,entries:Array.from({length:count},(_,i)=>({id:F.uuid(500000+label.charCodeAt(0)*1000+i),decision:'PROMOTE',expectedHash:W.hash(label+i)}))};
  return {...plan,planHash:W.hash({label,...plan})};
}
function checkpoint(plan,n,extra={}){
  const entries=S.entriesFor(plan,n);
  return {plan_hash:plan.planHash,batch_number:n,request_hash:W.hash(entries),result:{planHash:plan.planHash,batchNumber:n,asOf:'2026-11-05T10:00:00.000Z',examined:entries.length,newlyActivated:entries.length,errors:0,
    before:{activities:9,provenances:9,external_ids:9,active:n,review:9-n},after:{activities:9,provenances:9,external_ids:9,active:n+entries.length,review:9-n-entries.length},
    journal:entries.map(e=>({id:e.id,expectedHash:e.expectedHash,action:'PROMOTE',before:'review',after:'active',reason:'distinct_only_organizer_warning'}))},...extra};
}
const insert=row=>db.query('insert into sortir_organizer_recovery_batches(plan_hash,batch_number,request_hash,result) values($1,$2,$3,$4::jsonb)',[row.plan_hash,row.batch_number,row.request_hash,JSON.stringify(row.result)]);
async function baseline(){
  await db.query('truncate sortir_organizer_recovery_batches');
  // Plan 1 terminé (4 lots), plan 2 en cours (2 lots sur 3), plan 3 non commencé.
  for(let n=0;n<4;n++)await insert(checkpoint(bundle.plans[0].plan,n));
  for(let n=0;n<2;n++)await insert(checkpoint(bundle.plans[1].plan,n));
}
before(async()=>{
  engine=new PGlite();db={query:async(s,p)=>p?engine.query(s,p):(await engine.exec(s)).at(-1)||{rows:[]}};
  const f=await F.schema(db,fs.readFileSync(path.join(__dirname,'../migrations/2026-10-29-sortir-organizer-recovery-journal.sql'),'utf8'));
  await F.seed(db,f);await db.query("alter table sortir_sources add column datatourisme_national_scan jsonb default '{\"status\":\"finalized\"}'");
  const plans=[makePlan('a',8),makePlan('b',6),makePlan('c',4)];
  bundle={manifestHash:'local',deadline:FAR,minimumCommittedBatches:[0,0,0],plans:plans.map((plan,i)=>({group:String(i+1).padStart(3,'0'),plan,batches:Math.ceil(plan.entries.length/2),verify(){}}))};
});
after(()=>engine.close());
const P=i=>bundle.plans[i].plan,key=(i,n)=>`${P(i).planHash}:${n}`;
const MUTATIONS={
  none:async()=>{},
  result_invalid:()=>db.query("update sortir_organizer_recovery_batches set result=jsonb_set(result,'{newlyActivated}','0') where plan_hash=$1 and batch_number=1",[P(0).planHash]),
  result_valid_but_changed:()=>db.query("update sortir_organizer_recovery_batches set result=jsonb_set(result,'{asOf}','\"2026-11-06T00:00:00.000Z\"') where plan_hash=$1 and batch_number=2",[P(0).planHash]),
  journal_reason:()=>db.query("update sortir_organizer_recovery_batches set result=jsonb_set(result,'{journal,0,reason}','\"autre\"') where plan_hash=$1 and batch_number=0",[P(1).planHash]),
  request_hash:()=>db.query("update sortir_organizer_recovery_batches set request_hash=repeat('a',64) where plan_hash=$1 and batch_number=3",[P(0).planHash]),
  committed_at_only:()=>db.query("update sortir_organizer_recovery_batches set committed_at=committed_at+interval '1 second' where plan_hash=$1 and batch_number=0",[P(0).planHash]),
  delete_last:()=>db.query('delete from sortir_organizer_recovery_batches where plan_hash=$1 and batch_number=1',[P(1).planHash]),
  delete_middle:()=>db.query('delete from sortir_organizer_recovery_batches where plan_hash=$1 and batch_number=1',[P(0).planHash]),
  insert_next_valid:()=>insert(checkpoint(P(1),2)),
  insert_next_invalid:()=>insert({...checkpoint(P(1),2),request_hash:'b'.repeat(64)}),
  insert_gap:()=>insert(checkpoint(P(2),0)),
  insert_beyond:()=>insert({...checkpoint(P(1),2),batch_number:4}),
  insert_foreign:()=>insert({...checkpoint(P(1),2),plan_hash:'f'.repeat(64)}),
  move_to_foreign:()=>db.query("update sortir_organizer_recovery_batches set plan_hash=repeat('e',64) where plan_hash=$1 and batch_number=3",[P(0).planHash]),
  delete_and_reinsert_identical:async()=>{await db.query('delete from sortir_organizer_recovery_batches where plan_hash=$1 and batch_number=1',[P(1).planHash]);await insert(checkpoint(P(1),1));}
};
async function primed(){await baseline();const ledger=new S.CheckpointLedger(),anchors=new Map();await S.readProgress(client,bundle,anchors,ledger);assert.equal(ledger.ready,true);return {ledger,anchors};}
async function outcome(anchors,ledger){
  queries=[];
  try{const found=await S.readProgress(client,bundle,new Map(anchors),ledger);return {ok:true,map:[...found].sort(),queries:[...queries]};}
  catch(e){return {ok:false,code:e.code,message:e.message,queries:[...queries]};}
}
const strip=o=>({ok:o.ok,code:o.code,message:o.message,map:o.map});
for(const [name,mutation] of Object.entries(MUTATIONS)){
  test(`journal « ${name} » : verdict incrémental identique au contrôle intégral`,async()=>{
    const {ledger,anchors}=await primed();await mutation();
    const full=await outcome(anchors,null);
    // Re-amorce sur l'état de départ, applique la même mutation, puis chemin incrémental.
    const second=await primed();await mutation();
    const inc=await outcome(second.anchors,second.ledger);
    assert.deepEqual(strip(inc),strip(full));
    const detected=!['none','insert_next_valid','insert_foreign'].includes(name);
    if(name==='none'){assert.equal(inc.queries.filter(s=>s.includes('sortir_organizer_recovery_batches')).length,1,'une seule requête d’empreintes');assert.equal(second.ledger.stats.incremental,1);}
    if(name==='insert_next_valid'){assert(inc.ok);assert(inc.map.some(([k])=>k===key(1,2)));assert.equal(second.ledger.stats.incremental,1);}
    // Toute altération/suppression d'un checkpoint déjà vérifié renvoie au contrôle intégral.
    if(detected&&!name.startsWith('insert'))assert.equal(second.ledger.fallbacks,1,name);
    if(['result_invalid','result_valid_but_changed','journal_reason','request_hash','delete_last','delete_middle','insert_next_invalid','insert_gap','insert_beyond','move_to_foreign'].includes(name))assert.equal(inc.code,'CHECKPOINT',name);
    void ledger;
  });
}
test('empreinte indépendante du fuseau de session',async()=>{
  const {ledger,anchors}=await primed();await db.query("set time zone 'Pacific/Kiritimati'");
  try{const r=await outcome(anchors,ledger);assert(r.ok);assert.equal(ledger.fallbacks,0);assert.equal(ledger.stats.incremental,1);}
  finally{await db.query("set time zone 'UTC'");}
});
test('ligne modifiée entre la lecture des empreintes et la relecture : retour au contrôle intégral',async()=>{
  const {ledger,anchors}=await primed();await insert(checkpoint(P(1),2));
  // Session unique en lecture seule : la modification concurrente est simulée sur la
  // réponse de la relecture (empreinte différente de celle lue juste avant).
  const racing={query:async(s,a)=>{const r=await db.query(s,a);if(s.includes('AND batch_number=$2')&&s.includes('row_digest'))return {rows:r.rows.map(x=>({...x,row_digest:'0'.repeat(64)}))};return r;}};
  const found=await S.readProgress(racing,bundle,new Map(anchors),ledger);
  assert.equal(ledger.fallbacks,1);assert(found.has(key(1,2)));
});
test('vérification intégrale forcée périodiquement (forceFull)',async()=>{
  const {ledger,anchors}=await primed();ledger.forceFull=true;queries=[];
  await S.readProgress(client,bundle,new Map(anchors),ledger);
  assert.equal(ledger.stats.full,2);assert.equal(ledger.forceFull,false);assert(queries.filter(s=>s.includes('LIMIT $3')).length>=3);
});
test('différentiel aléatoire : 60 séquences de 1 à 3 mutations, verdicts identiques',async()=>{
  let seed=7;const rnd=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;},names=Object.keys(MUTATIONS);
  for(let i=0;i<60;i++){
    const seq=Array.from({length:1+Math.floor(rnd()*3)},()=>names[Math.floor(rnd()*names.length)]);
    const apply=async()=>{for(const n of seq){try{await MUTATIONS[n]();}catch{}}};
    const a=await primed();await apply();const full=await outcome(a.anchors,null);
    const b=await primed();await apply();const inc=await outcome(b.anchors,b.ledger);
    assert.deepEqual(strip(inc),strip(full),seq.join('+'));
  }
});
test('aucune ligne non bornée : journal plus long que le manifeste refusé',async()=>{
  const {ledger,anchors}=await primed();
  for(let n=2;n<7;n++)await insert({...checkpoint(P(1),2),batch_number:n});
  for(let n=0;n<4;n++)await insert({...checkpoint(P(2),0),batch_number:n});
  const r=await outcome(anchors,ledger);assert.equal(r.ok,false);assert.equal(r.code,'CHECKPOINT');
});
