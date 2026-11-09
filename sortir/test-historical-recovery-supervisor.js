"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const S=require('./historical-recovery-supervisor'),W=require('./organizer-review-writer');
const {options}=require('./run-historical-recovery-supervisor');
const NOW=Date.parse('2026-11-04T12:00:00Z');
function fixture(){
  const plan={planHash:'sealed',batchSize:1,entries:[0,1,2].map(i=>({id:`id${i}`,decision:'PROMOTE',expectedHash:`hash${i}`}))};
  const bundle={manifestHash:'manifest',deadline:S.DEADLINE,minimumCommittedBatches:[0],plans:[{group:'006',plan,batches:3,verify(){}}]};
  const journal=new Map(),calls=[];let connections=0,writes=0;
  function checkpoint(n){return {plan_hash:plan.planHash,batch_number:n,request_hash:W.hash(S.entriesFor(plan,n)),result:{planHash:plan.planHash,batchNumber:n,examined:1,newlyActivated:1,errors:0,
    before:{activities:3,provenances:3,external_ids:6,active:n,review:3-n},after:{activities:3,provenances:3,external_ids:6,active:n+1,review:2-n},
    journal:[{...plan.entries[n],action:'PROMOTE',before:'review',after:'active'}]}};}
  async function connect(){connections++;let readOnly='off',statement='2min',idle='0';return {end:async()=>{},query:async(sql,args=[])=>{
    calls.push(sql);
    if(sql.includes('pg_catalog.set_config')){[readOnly,statement,idle]=args;return {rows:[{}]};}
    if(sql.includes('read_control_read_only'))return {rows:[{backend_pid:1,read_control_read_only:readOnly,statement_timeout:statement,idle_timeout:idle}]};
    if(sql.includes('clock_timestamp'))return {rows:[{now:new Date(NOW)}]};
    if(sql.includes('orchestrator_version'))return {rows:[{status:'completed',orchestrator_version:require('./scheduler-state').LOCK_VERSION}]};
    if(sql.includes('UNION ALL'))return {rows:[]};
    if(sql.includes('national_scan'))return {rows:[{status:'finalized'}]};
    if(sql.includes('sortir_organizer_recovery_batches'))return {rows:args.length===2&&sql.includes('batch_number=$2')?[journal.get(args[1])].filter(Boolean):[...journal.values()].sort((a,b)=>a.batch_number-b.batch_number).filter(r=>args[1]===null||r.batch_number>args[1]).slice(0,args[2])};
    if(/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql))return {rows:[]};
    throw Error('Unexpected SQL: '+sql);
  }};}
  const run=(extra={})=>S.supervise({bundle,connect,apply:true,authorization:'manifest',now:()=>NOW,sleep:async()=>{},log:()=>{},maxBatches:3,
    validateBatch:async()=>({targets:1}),writeBatch:async({batchNumber,hook})=>{writes++;await hook('validated');await hook('beforeCommit');journal.set(batchNumber,checkpoint(batchNumber));},...extra});
  return {plan,bundle,journal,calls,connect,checkpoint,run,get connections(){return connections;},get writes(){return writes;}};
}
test('CLI refuse implicit mode, unknown flags and missing double authorization',()=>{
  for(const args of [[],['--apply'],['--check','--apply'],['--check','--wat'],['--check','--max-batches','0']])assert.throws(()=>options(args,{}));
  assert.equal(options(['--validate-files'],{}).mode,'--validate-files');
  assert.equal(options(['--apply','--authorize-manifest-sha256',S.MANIFEST_SHA256],{SORTIR_RECOVERY_ALLOW_WRITE:'I_AUTHORIZE_EXACT_PLAN'}).mode,'--apply');
});
test('authorization is checked before connection',async()=>{const f=fixture();await assert.rejects(f.run({authorization:'wrong'}),{code:'AUTH'});assert.equal(f.connections,0);});
test('committed prefix never calls writer again; restart uses durable journal',async()=>{const f=fixture();f.journal.set(0,f.checkpoint(0));const r=await f.run();assert.equal(f.writes,2);assert.equal(r.activated,2);await f.run();assert.equal(f.writes,2);});
test('read-only mode cannot invoke writer',async()=>{const f=fixture();await f.run({apply:false});assert.equal(f.writes,0);assert.equal(f.journal.size,0);});
test('network cut before commit reconnects and retries only unacknowledged batch',async()=>{const f=fixture();let tries=0;const r=await f.run({maxBatches:1,writeBatch:async({batchNumber})=>{if(!tries++)throw Object.assign(Error('reset'),{code:'ECONNRESET'});f.journal.set(batchNumber,f.checkpoint(batchNumber));}});assert.equal(tries,2);assert.equal(f.connections,2);assert.equal(r.totalRetries,1);});
test('lost COMMIT response reconciles journal before another writer invocation',async()=>{const f=fixture();let tries=0;const r=await f.run({maxBatches:1,writeBatch:async({batchNumber})=>{tries++;f.journal.set(batchNumber,f.checkpoint(batchNumber));throw Object.assign(Error('lost COMMIT'),{code:'ECONNRESET'});}});assert.equal(tries,1);assert.equal(r.reconciled,1);assert.equal(f.connections,2);});
test('network retries are bounded',async()=>{const f=fixture();let tries=0;await assert.rejects(f.run({writeBatch:async()=>{tries++;throw Object.assign(Error('reset'),{code:'ECONNRESET'});}}));assert.equal(tries,4);});
test('business divergence stops immediately without retry or write',async()=>{const f=fixture();await assert.rejects(f.run({validateBatch:async()=>{throw new S.RecoveryStop('BUSINESS','changed');}}),{code:'BUSINESS'});assert.equal(f.connections,1);assert.equal(f.writes,0);});
test('checkpoint gap or altered payload stops before writer',async()=>{for(const kind of ['gap','altered','missingPrefix']){const f=fixture();if(kind==='gap')f.journal.set(1,f.checkpoint(1));else if(kind==='altered'){const row=f.checkpoint(0);row.result.newlyActivated=0;f.journal.set(0,row);}else f.bundle.minimumCommittedBatches=[1];await assert.rejects(f.run(),{code:'CHECKPOINT'});assert.equal(f.writes,0);}});
test('a checkpoint disappearing on reconnect stops instead of re-promoting',async()=>{
  const f=fixture();f.journal.set(0,f.checkpoint(0));let tries=0;
  await assert.rejects(f.run({writeBatch:async()=>{tries++;f.journal.delete(0);throw Object.assign(Error('reset'),{code:'ECONNRESET'});}}),{code:'CHECKPOINT'});
  assert.equal(tries,1);
});
test('sealed national bundle retains exact 7051 prefix and 20781 remainder',()=>{
  const b=S.loadBundle(require('node:path').join(__dirname,'recovery-data/2026-11-02-national/plans-index.json'));
  const acquired=b.plans.reduce((n,p,i)=>n+p.plan.entries.slice(0,b.minimumCommittedBatches[i]*p.plan.batchSize).length,0);
  assert.equal(acquired,7051);assert.equal(b.plans.reduce((n,p)=>n+p.plan.entries.length,0)-acquired,20781);
  assert.equal(b.minimumCommittedBatches[5],21);assert.equal(b.plans[5].group,'006');
});
test('host deadline and interruption prevent connection',async()=>{for(const extra of [{now:()=>Date.parse(S.DEADLINE)},{signal:{aborted:true}}]){const f=fixture();await assert.rejects(f.run(extra));assert.equal(f.connections,0);}});
test('database clock deadline stops despite earlier host clock',async()=>{const f=fixture();await assert.rejects(f.run({connect:async()=>{const c=await f.connect();const query=c.query;c.query=(s,a)=>s.includes('clock_timestamp')?Promise.resolve({rows:[{now:S.DEADLINE}]}):query(s,a);return c;}}),{code:'EXPIRED'});assert.equal(f.writes,0);});
test('occupied mutex or unfinished scan stops without releasing locks',async()=>{for(const mode of ['mutex','scan']){const f=fixture();await assert.rejects(f.run({connect:async()=>{const c=await f.connect(),query=c.query;c.query=(s,a)=>s.includes(mode==='mutex'?'orchestrator_version':'national_scan')?Promise.resolve({rows:[{status:'running'}]}):query(s,a);return c;}}),{code:'BUSY'});assert.equal(f.writes,0);assert.ok(!f.calls.some(s=>/unlock|update|delete/i.test(s)));}});
test('deadline hook before COMMIT prevents committing after expiry',async()=>{const f=fixture();let clock=NOW;await assert.rejects(f.run({now:()=>clock,writeBatch:async({hook})=>{clock=Date.parse(S.DEADLINE);await hook('beforeCommit');assert.fail('must stop');}}),{code:'EXPIRED'});assert.equal(f.journal.size,0);});
test('only connection faults are retried',()=>{assert.equal(S.transient({code:'ECONNRESET'}),true);for(const code of ['57014','55P03','23505','BUSINESS'])assert.equal(S.transient({code}),false);});
test('real local PostgreSQL engine: paginated revalidation matches unchanged writer',async()=>{
  const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs');
  const F=require('./test-helpers/organizer-writer-fixture'),engine=new PGlite();
  const db={query:async(s,p)=>p?engine.query(s,p):(await engine.exec(s)).at(-1)||{rows:[]},close:()=>engine.close()};
  try{
    const f=await F.schema(db,fs.readFileSync(require('node:path').join(__dirname,'../migrations/2026-10-29-sortir-organizer-recovery-journal.sql'),'utf8'));
    await F.seed(db,f);
    await db.query("alter table sortir_sources add column datatourisme_national_scan jsonb default '{\"status\":\"finalized\"}'");
    const current=await W.loadCurrent(db,[f.snapshot.rows[0].id]);
    const row=current.byId.get(f.snapshot.rows[0].id);
    const plan={batchSize:1,entries:[{id:row.id,decision:'PROMOTE',expectedHash:W.fingerprint(row,current.items,current.decisions)}]};
    const queries=[];const client={query:(s,a)=>{queries.push({s,a});return db.query(s,a);}};
    const r=await S.revalidateBatch(client,plan,0,'2028-01-01T00:00:00Z');
    assert.equal(r.targets,1);assert.ok(r.candidatePages>1);
    assert.ok(queries.filter(q=>q.s.includes('ORDER BY a.id')).every(q=>q.s.includes('LIMIT 100')&&q.a[0].length<=25));
    plan.entries[0].expectedHash='changed';await assert.rejects(S.revalidateBatch(client,plan,0,'2028-01-01T00:00:00Z'),{code:'BUSINESS'});
    plan.entries[0].expectedHash=W.fingerprint(row,current.items,current.decisions);
    const body={...plan,version:W.VERSION,asOf:S.DEADLINE,snapshotKey:'local-test',codeHash:W.codeHash()};
    const sealed={...body,planHash:W.hash(body)};
    const bundle={manifestHash:'local-test',deadline:'2028-01-01T00:00:00Z',minimumCommittedBatches:[0],
      plans:[{group:'006',plan:sealed,batches:1,verify:()=>W.validatePlan(sealed,sealed.planHash)}]};
    let writerCalls=0;
    const result=await S.supervise({bundle,connect:async()=>({...client,end:async()=>{}}),apply:true,authorization:'local-test',now:()=>NOW,
      sleep:async()=>{},log:()=>{},writeBatch:async args=>{writerCalls++;await W.writeBatch(args);throw Object.assign(Error('lost COMMIT response'),{code:'ECONNRESET'});}});
    assert.equal(writerCalls,1);assert.equal(result.reconciled,1);
    assert.equal((await db.query('select count(*)::int as n from sortir_organizer_recovery_batches')).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int as n from sortir_activities where record_status='active'")).rows[0].n,1);
  }finally{await db.close();}
});
