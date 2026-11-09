"use strict";
// Exécuteur local uniquement. Ni IA, ni ingestion, ni modification du writer scellé.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const S=require('./historical-recovery-supervisor'),W=require('./organizer-review-writer'),P=require('./autonomous-recovery-policy');
const {journalRows,assertSessionConnection}=require('./recovery-control-reads');
const G=require('./recovery-connection-guard'),H=require('./host-power-guard');
const ROOT=path.resolve(__dirname,'..'),MANIFEST=path.join(__dirname,'recovery-data/2026-11-02-national/plans-index.json');
const TABLES=['sortir_ingestion_runs','sortir_source_runs','sortir_sources','sortir_activities','sortir_provenances','sortir_external_ids','sortir_collection_items','sortir_dedup_decisions','sortir_datatourisme_poi_states','sortir_organizer_recovery_batches'];
function atomic(file,value){fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);}
function configAt(file){
 const c=JSON.parse(fs.readFileSync(file)),{seal,...body}=c;assert.equal(W.hash(body),seal,'Configuration altérée');const limits=P.limitsFor(c);
 assert(c.executionDeadline<=Math.min(c.started+limits.hours*3600000,Date.parse(S.DEADLINE)),'Échéance excessive');assert.equal(c.manifestHash,S.MANIFEST_SHA256);assert.equal(path.dirname(path.resolve(file)),c.runDir);
 if(c.initialAnchors){
  assert(Number.isInteger(c.initialCheckpoints)&&c.initialCheckpoints>=85&&c.initialCheckpoints<=285);assert(Number.isInteger(c.initialAcquired)&&c.initialAcquired>=8137&&c.initialAcquired<=27832);
  assert.equal(c.initialAnchors.length,c.initialCheckpoints);assert.equal(new Map(c.initialAnchors).size,c.initialCheckpoints);
  assert(c.initialAnchors.every(a=>Array.isArray(a)&&a.length===2&&/^[a-f0-9]{64}:\d+$/.test(a[0])&&/^[a-f0-9]{64}$/.test(a[1])));assert(c.expectedNext);
  const bundle=S.loadBundle(MANIFEST),known=new Map(c.initialAnchors);let count=0,total=0,gap=false;
  for(const p of bundle.plans)for(let n=0;n<p.batches;n++){if(known.has(`${p.plan.planHash}:${n}`)){assert(!gap,'Préfixe local non contigu');count++;total+=S.entriesFor(p.plan,n).length;}else gap=true;}
  assert.equal(count,c.initialCheckpoints);assert.equal(total,c.initialAcquired);const next=P.targets(bundle,known)[0];assert(next);assert.equal(next.group,c.expectedNext.group);assert.equal(next.batchNumber,c.expectedNext.batchNumber);assert.equal(bundle.plans.find(p=>p.group===next.group).plan.planHash,c.expectedNext.planHash);
 }else{assert.equal(c.initialCheckpoints,85);assert.equal(c.initialAcquired,8137);}
 if(c.continueToEnd){assert(c.initialAnchors);assert.equal(c.stopOnAnyError,true);assert.equal(c.scope.batches,285-c.initialCheckpoints);assert.equal(c.scope.promotions,27832-c.initialAcquired);}
 return c;
}
function credentials(){
 const value=fs.readFileSync(path.join(ROOT,'.env'),'utf8').match(/^SUPABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,'');
 const ref=new URL(value).hostname.split('.')[0];
 const url=cp.execFileSync('/usr/bin/security',['find-generic-password','-a','sortir_organizer_recovery_login','-s',`mnoria.sortir.recovery.${ref}`,'-w'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}).trim();
 return require('./organizer-recovery-connection').recoveryConnectionConfig({SORTIR_RECOVERY_DATABASE_URL:url,SORTIR_RECOVERY_CA_FILE:path.join(__dirname,'recovery-data/2026-10-29-pilot-preparation/supabase-root-ca.crt')});
}
async function worker(configFile,auditOnly=false,checkOnly=false){
 const config=configAt(configFile),dir=config.runDir,bundle=S.loadBundle(MANIFEST),connectionConfig=credentials();
 assertSessionConnection(connectionConfig);
 assert.equal(W.codeHash(),config.codeHash);
 const log=v=>{const line=JSON.stringify({at:new Date().toISOString(),...v});fs.appendFileSync(path.join(dir,'execution.jsonl'),line+'\n',{mode:0o600});console.log(line);};
 let state,heapMax=0,phase='preflight',ctx={},pages=0;const ledger=new S.CheckpointLedger();
 // Secteur, capot ouvert, pas de suspension : exigés hors réconciliation (lecture seule, toujours permise).
 const host=auditOnly?null:new H.HostGuard({onEvent:v=>log({...v,phase})});
 const observeMemory=()=>{if(state?.pending)state.pending.observedPeakRssMiB=Math.max(state.pending.observedPeakRssMiB||0,process.memoryUsage.rss()/1048576);};
 const save=()=>atomic(path.join(dir,'state.json'),state);
 const heartbeat=setInterval(()=>{heapMax=Math.max(heapMax,process.memoryUsage().heapUsed);atomic(path.join(dir,'heartbeat.json'),{at:new Date().toISOString(),pid:process.pid,ppid:process.ppid,phase,pending:state?.pending&&{group:state.pending.group,batch:state.pending.batchNumber+1},verified:state?.verified.length||0,rssMiB:process.memoryUsage().rss/1048576,lastQueryAt:ctx.lastQueryAt,queryTag:ctx.queryTag,host:host?.summary()});},5000);heartbeat.unref();
 const onSignal=()=>{if(state){state.stopRequested=true;save();}};process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
 async function connect(context={}){
  // Connexion abandonnée (jamais réutilisée) après délai client ou faute réseau.
  const guarded=G.openGuardedClient(require('pg').Client,connectionConfig,{onEvent:v=>log({...v,phase})});
  const base={query:async(...args)=>{observeMemory();const r=await guarded.query(...args);observeMemory();return r;},end:()=>guarded.end()};
  try{
   await guarded.connect();assert.equal(guarded.raw.connection.stream.authorized,true,'TLS non vérifié');
   // Lecture comme login : visibilité de ses autres sessions avant SET ROLE.
   const others=await S.readOnly(base,()=>base.query("SELECT pid,state,xact_start FROM pg_stat_activity WHERE usename=session_user AND pid<>pg_backend_pid() AND (xact_start IS NOT NULL OR state='active')"));
   if(!auditOnly&&others.rows.length)P.fail('CONCURRENT_RECOVERY','Autre transaction du login dédié.');
   await base.query('SET ROLE sortir_organizer_recovery_writer');
   if(checkOnly||auditOnly)await base.query('SET SESSION default_transaction_read_only=on');
   context.inWrite=false;
   const client=P.protectedClient(base,context,v=>{if(v.event==='query_error'&&!context.lastError){context.lastError=v.code;context.lastErrorKind=v.kind;}log({...v,phase});});
   return client;
  }catch(e){await base.end();throw e;}
 }
 async function concurrent(c){
  const r=await c.query("SELECT l.pid,c.relname,l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND l.pid<>pg_backend_pid() AND l.mode IN ('RowExclusiveLock','ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock') LIMIT 1",[TABLES]);
  if(r.rows.length)P.fail('CONCURRENT_TRANSACTION','Verrou concurrent sur une table protégée.');
 }
 async function status(c){return (await c.query("SELECT clock_timestamp() AS now,(SELECT status FROM sortir_ingestion_runs WHERE id='be127190-19a4-4f50-b615-7a9a78b8ff14') AS scheduler,(SELECT count(*) FROM sortir_ingestion_runs WHERE status='running') AS running_ingestions,(SELECT count(*) FROM sortir_source_runs WHERE status='running') AS running_sources")).rows[0];}
 async function duplicates(c,ids){
  const a=await c.query("SELECT p.activity_id,q.activity_id AS other FROM sortir_provenances p JOIN sortir_provenances q ON q.source_id=p.source_id AND q.source_occurrence_key=p.source_occurrence_key AND q.activity_id<>p.activity_id JOIN sortir_activities a ON a.id=q.activity_id WHERE p.activity_id=ANY($1::uuid[]) AND p.active AND q.active AND p.source_occurrence_key IS NOT NULL AND a.record_status='active' LIMIT 1",[ids]);
  if(a.rows.length)P.fail('DUPLICATE','Occurrence de provenance déjà active ailleurs.');
  const b=await c.query("SELECT e.activity_id,q.activity_id AS other FROM sortir_external_ids e JOIN sortir_external_ids q ON q.source_id=e.source_id AND q.system=e.system AND q.value=e.value AND q.activity_id<>e.activity_id JOIN sortir_activities a ON a.id=q.activity_id WHERE e.activity_id=ANY($1::uuid[]) AND e.system='datatourisme-occurrence' AND a.record_status='active' LIMIT 1",[ids]);
  if(b.rows.length)P.fail('DUPLICATE','Identifiant d’occurrence déjà actif ailleurs.');
 }
 async function snapshot(c,ids){return {
  activities:(await c.query("SELECT id,record_status,updated_at,md5((to_jsonb(a)-'record_status'-'updated_at')::text) AS immutable_hash FROM sortir_activities a WHERE id=ANY($1::uuid[]) ORDER BY id",[ids])).rows,
  provenances:(await c.query('SELECT id,activity_id,md5(to_jsonb(p)::text) AS immutable_hash FROM sortir_provenances p WHERE activity_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,
  external:(await c.query('SELECT activity_id,source_id,system,value FROM sortir_external_ids WHERE activity_id=ANY($1::uuid[]) ORDER BY activity_id,source_id,system,value',[ids])).rows};}
 async function journal(c){
  const raw=[];for(const p of bundle.plans)raw.push({p,rows:await journalRows(c,p.plan.planHash,p.batches,true)});
  return raw;
 }
 function validateJournal(raw){
  const map=new Map();let gap=false,total=0;
  for(let i=0;i<raw.length;i++){const {p,rows}=raw[i];p.verify();assert(rows.length<=p.batches&&rows.length>=bundle.minimumCommittedBatches[i]&&!(gap&&rows.length),'Préfixe non contigu');
   rows.forEach((r,n)=>{assert.equal(r.batch_number,n);const {committed_at,...stable}=r;map.set(`${p.plan.planHash}:${n}`,S.validateCheckpoint(p.plan,n,stable));total+=r.result.newlyActivated;});if(rows.length<p.batches)gap=true;
  }return {map,total};
 }
 async function reconcile(){
  phase='readonly_reconciliation';const c=await connect({});let data;
  const current=state.pending,cp=current&&bundle.plans.find(p=>p.group===current.group),key=cp&&`${cp.plan.planHash}:${current.batchNumber}`;
  try{data=await S.readOnly(c,async()=>{
    // Après toute anomalie : journal intégral. Sinon registre d'empreintes serveur ; la
    // ligne du lot en cours est toujours relue et revalidée en entier.
    const checked=await S.verifyJournal(c,bundle,ledger,{committedAt:true,fetch:key?[key]:[],forceFull:!!state.stopped});let after;
    if(current){const ids=S.entriesFor(cp.plan,current.batchNumber).map(e=>e.id);after=await snapshot(c,ids);await duplicates(c,ids);}
    return {checked,row:key&&checked.fresh.get(key),after,system:await status(c)};});
  }finally{await c.end();}
  const {checked}=data;for(const [k,v] of state.anchors)assert.equal(checked.map.get(k),v,'Checkpoint acquis modifié');
  log({event:'checkpoints_reconciled',mode:checked.mode,checkpoints:checked.map.size});
  if(state.pending){const pending=state.pending;
   if(data.row){
    const p=bundle.plans.find(p=>p.group===pending.group),entries=S.entriesFor(p.plan,pending.batchNumber);assert.equal(checked.map.size,state.anchors.length+1);
    assert.equal(data.after.activities.length,entries.length);assert(data.after.activities.every(r=>r.record_status==='active'));
    const strip=rows=>rows.map(({record_status,updated_at,...r})=>r);
    assert.deepEqual(strip(data.after.activities),strip(pending.before.activities));assert.deepEqual(data.after.provenances,pending.before.provenances);assert.deepEqual(data.after.external,pending.before.external);
    const dates=new Map(data.row.result.journal.map(e=>[e.id,e.updatedAtAfter]));for(const r of data.after.activities)assert.equal(new Date(r.updated_at).toISOString(),dates.get(r.id));
    const verified={group:pending.group,batch:pending.batchNumber+1,entries:entries.length,committedAt:data.row.committed_at,durationMs:Date.now()-pending.started,writerDurationMs:pending.writerDurationMs,observedPeakRssMiB:pending.observedPeakRssMiB,checkpoint:{planHash:p.plan.planHash,batchNumber:pending.batchNumber,digest:checked.map.get(`${p.plan.planHash}:${pending.batchNumber}`)},errors:0,integrity:true,duplicates:false};
    state.verified.push(verified);log({event:'batch_postverified',...verified,checkpoints:checked.map.size});
   }else{assert.equal(checked.map.size,state.anchors.length);assert.deepEqual(data.after,pending.before);log({event:'no_commit_confirmed',group:pending.group,batch:pending.batchNumber+1});}
   state.pending=null;
  }else assert.equal(checked.map.size,state.anchors.length,'Checkpoint concurrent inattendu');
  state.anchors=[...checked.map];state.totalAcquired=checked.total;state.lastSystem=data.system;state.reconciliation={at:new Date().toISOString(),success:true};save();
 }
 async function finish(){
  const anchors=new Map(state.anchors),next=P.targets(bundle,anchors)[0];
  const finished=bundle.plans.filter(p=>Array.from({length:p.batches},(_,n)=>anchors.has(`${p.plan.planHash}:${n}`)).every(Boolean)).map(p=>p.group);
  const duration=Date.now()-state.started,promotions=state.verified.reduce((n,b)=>n+b.entries,0);
  const report={at:new Date().toISOString(),runDir:dir,status:state.stopped?'STOPPED':state.phase==='checked'?'CHECKED':state.phase==='complete'?'COMPLETE':state.phase==='running'?'RUNNING':'READY',limits:P.limitsFor(config),executionDeadline:new Date(config.executionDeadline).toISOString(),
   lots:state.verified,lotsExecuted:state.verified.length,promotions,totalHistorical:state.totalAcquired,remaining:27832-state.totalAcquired,checkpoints:state.anchors.length,plansFinished:finished,nextBatch:next&&`${next.group}/${next.batchNumber+1}`,
   durationMs:duration,writerDurationMs:state.writerDurationMs||0,averageBatchMs:state.verified.length?state.verified.reduce((n,b)=>n+b.durationMs,0)/state.verified.length:0,maxRssMiB:Math.max(state.peakRssMiB||0,process.resourceUsage().maxRSS/1024),maxObservedHeapMiB:Math.max(state.peakHeapMiB||0,heapMax/1048576),retries:state.retries,anomaly:state.stopped,pendingCommitUncertain:!!state.pending,reconciliation:state.reconciliation,integrity:!state.pending&&state.verified.every(b=>b.integrity),system:state.lastSystem,segments:state.segments,limitsApplyTo:config.continueToEnd?'verified_segment':'whole_run',authorizationScope:config.scope,codeHash:W.codeHash()};
  state.peakRssMiB=report.maxRssMiB;state.peakHeapMiB=report.maxObservedHeapMiB;save();
  atomic(path.join(dir,'report.json'),report);
  fs.writeFileSync(path.join(dir,'report.md'),`# Reprise historique DATAtourisme\n\nÉtat : ${report.status}\n\n- Lots vérifiés : ${report.lotsExecuted}\n- Promotions acquittées : ${promotions}\n- Total historique : ${report.totalHistorical}\n- Entrées restantes : ${report.remaining}\n- Checkpoints : ${report.checkpoints}\n- Plans terminés : ${finished.join(', ')}\n- Prochain lot : ${report.nextBatch||'aucun'}\n- Durée : ${Math.round(duration/1000)} secondes\n- Durée moyenne par lot : ${Math.round(report.averageBatchMs/1000)} secondes\n- Pic RSS : ${report.maxRssMiB.toFixed(1)} Mio\n- Retries : ${report.retries}\n- Anomalie : ${state.stopped?.code||'aucune'}\n- Contrôles d’intégrité : ${report.integrity?'conformes':'à réconcilier'}\n- Scheduler : ${state.lastSystem?.scheduler}\n- Ingestions actives : ${state.lastSystem?.running_ingestions}\n- Sources actives : ${state.lastSystem?.running_sources}\n\nLes détails et l’horodatage des vérifications sont dans report.json et execution.jsonl.\n`,{mode:0o600});
  log({event:'report_written',status:report.status,lots:report.lotsExecuted,promotions,remaining:report.remaining});
 }
 try{
  if(host){await host.start();host.assertSafe('preflight');}
  if(auditOnly){state=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));await reconcile();await finish();return;}
  assert(!fs.existsSync(path.join(dir,'state.json')),'Exécution déjà démarrée : aucun redémarrage automatique.');
  const c=await connect(ctx);let anchors=new Map(config.initialAnchors||[]),raw,system;
  try{
   await S.readProgress(c,bundle,anchors);assert.equal(anchors.size,config.initialCheckpoints);await S.readOnly(c,()=>concurrent(c));
   raw=await S.readOnly(c,()=>journal(c));const checked=validateJournal(raw);assert.equal(checked.total,config.initialAcquired);assert.equal(checked.map.size,config.initialCheckpoints);
   const next=P.targets(bundle,anchors)[0],expected=config.expectedNext||{group:'007',batchNumber:0};assert.equal(next.group,expected.group);assert.equal(next.batchNumber,expected.batchNumber);
   if(expected.planHash)assert.equal(bundle.plans.find(p=>p.group===next.group).plan.planHash,expected.planHash);
   let verifiedHistorical=0;
   for(const {p,rows} of raw)for(const row of rows){const ids=S.entriesFor(p.plan,row.batch_number).map(e=>e.id);
    await S.readOnly(c,async()=>{const r=(await c.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE record_status='active')::int AS active FROM sortir_activities WHERE id=ANY($1::uuid[])",[ids])).rows[0];assert.equal(r.total,ids.length);assert.equal(r.active,ids.length);await duplicates(c,ids);});
    verifiedHistorical+=ids.length;if(verifiedHistorical%1000<100)log({event:'historical_integrity_progress',verifiedHistorical});
   }
   assert.equal(verifiedHistorical,config.initialAcquired);await S.readProgress(c,bundle,anchors,ledger);assert.equal(anchors.size,config.initialCheckpoints);await S.readOnly(c,()=>concurrent(c));system=await S.readOnly(c,()=>status(c));
  }finally{await c.end();}
  state={started:config.started,phase:'ready',anchors:[...anchors],verified:[],pending:null,totalAcquired:config.initialAcquired,retries:0,stopped:null,lastSystem:system,stopRequested:false,segmentStart:0,segments:[{startIndex:0,at:new Date().toISOString()}]};save();
  const selected=P.runTargets(bundle,anchors,config),nextLabel=`${selected[0].group}/${selected[0].batchNumber+1}`;
  if(config.onlyBatch){assert.equal(selected.length,1,'Un seul lot ciblé requis');assert.equal(selected[0].group,config.onlyBatch.group);assert.equal(selected[0].batchNumber,config.onlyBatch.batchNumber);assert.equal(bundle.plans.find(p=>p.group===selected[0].group).plan.planHash,config.onlyBatch.planHash);}
  atomic(path.join(dir,'ready.json'),{at:new Date().toISOString(),pid:process.pid,ppid:process.ppid,configSeal:config.seal,historicalVerified:config.initialAcquired,checkpoints:config.initialCheckpoints,next:nextLabel,maxLots:selected.length,maxPromotions:selected.reduce((n,t)=>n+t.entries,0),deadline:S.DEADLINE,system});
  if(checkOnly){state.phase='checked';save();log({event:'readonly_preflight_passed',historicalVerified:config.initialAcquired,checkpoints:config.initialCheckpoints,next:nextLabel});return;}
  phase='awaiting_activation';await finish();log({event:'ready_no_writes',maxLots:selected.length,maxPromotions:selected.reduce((n,t)=>n+t.entries,0)});
  while(!fs.existsSync(path.join(dir,'ARM.json'))){P.guard(state,config,1);await new Promise(r=>setTimeout(r,500));}
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'ARM.json'))).configSeal,config.seal);fs.renameSync(path.join(dir,'ARM.json'),path.join(dir,'ARM.consumed.json'));host.assertSafe('activation');state.phase='running';save();await finish();
  for(const target of selected){
   if(P.advanceSegment(state,config,target.entries)){save();log({event:'verified_segment_completed_next_started',segment:state.segments.length,limits:P.limitsFor(config)});}
   P.guard(state,config,target.entries);phase='batch_preflight';ctx={};pages=0;host.assertSafe('batch_start');
   // Vérification intégrale périodique du journal (tous les 10 lots), en plus de celle du démarrage.
   if(state.verified.length&&state.verified.length%10===0)ledger.forceFull=true;
   const p=bundle.plans.find(p=>p.group===target.group),n=target.batchNumber,ids=S.entriesFor(p.plan,n).map(e=>e.id),known=new Map(state.anchors);let before,client=await connect(ctx);
   try{await S.readProgress(client,bundle,known,ledger);assert.equal(known.size,state.anchors.length);await S.readOnly(client,()=>concurrent(client));before=await S.readOnly(client,async()=>{await duplicates(client,ids);return snapshot(client,ids);});assert.equal(before.activities.length,ids.length);assert(before.activities.every(a=>a.record_status==='review'));}finally{await client.end();}
   state.pending={...target,before,started:Date.now()};save();phase='batch_validation';
   await S.supervise({bundle,connect:async()=>{const c=await connect(ctx),query=c.query;
    c.query=async(...args)=>{P.guard(state,config,target.entries);if(phase==='batch_validation')host.assertSafe(phase);const r=await query(...args);if(args[0].includes('ORDER BY a.id LIMIT 100')&&++pages%25===0)log({event:'candidate_progress',group:p.group,batch:n+1,pages,rssMiB:process.memoryUsage().rss/1048576});return r;};return c;
   },apply:true,authorization:bundle.manifestHash,maxBatches:1,ledger,log:line=>{const v=JSON.parse(line);if(v.event==='network_retry'){if(config.stopOnAnyError){log({...v,event:'retry_prevented'});P.fail('EXECUTION_ERROR','Arrêt demandé à la première erreur, sans retry.');}state.retries++;save();}log(v);if(v.event==='commit_reconciled')P.fail('COMMIT_UNCERTAIN','Checkpoint apparu pendant le lot : arrêt et réconciliation seule.');},
   writeBatch:async args=>{
    assert.equal(args.plan.planHash,p.plan.planHash);assert.equal(args.batchNumber,n);P.guard(state,config,ids.length);
    // Dernier point sûr : au-delà, la garde d'hôte n'interrompt plus le writer (transaction).
    host.assertSafe('before_writer');phase='writer';
    const hook=args.hook;let updates=0;const writerStarted=Date.now();state.pending.writerStartedAt=new Date(writerStarted).toISOString();save();log({event:'writer_started',group:p.group,batch:n+1});let result;
    try{result=await W.writeBatch({...args,hook:async(...a)=>{P.guard(state,config,ids.length);if(a[0]==='updated')assert(++updates<=ids.length);if(a[0]==='beforeCommit')await duplicates(args.client,ids);await hook(...a);}});}
    finally{const durationMs=Date.now()-writerStarted;state.pending.writerDurationMs=durationMs;state.writerDurationMs=(state.writerDurationMs||0)+durationMs;save();log({event:'writer_finished',group:p.group,batch:n+1,durationMs});}
    if(result.replayed)P.fail('CONCURRENT_RECOVERY','Lot acquitté ailleurs : arrêt.');return result;
   }});
   await reconcile();assert.equal(state.verified.at(-1)?.group,p.group);assert.equal(state.verified.at(-1)?.batch,n+1);assert.equal(state.pending,null);phase='between_batches';save();await finish();
  }
  state.phase='complete';save();
 }catch(error){
  log({event:'stopped',phase,code:error.code||'INTEGRITY_OR_PRECONDITION',postgresCode:ctx.lastError,errorKind:ctx.lastErrorKind,host:error.hostReason,read:error.controlRead});
  if(state){state.stopped={at:new Date().toISOString(),phase,code:error.code||'INTEGRITY_OR_PRECONDITION',postgresCode:ctx.lastError,errorKind:ctx.lastErrorKind,host:error.hostReason,read:error.controlRead,target:state.pending&&{group:state.pending.group,batch:state.pending.batchNumber+1}};save();try{await reconcile();}catch(e){state.reconciliation={at:new Date().toISOString(),success:false,code:e.code||'READONLY_RECONCILIATION_FAILED',read:e.controlRead};save();log({event:'readonly_reconciliation_failed',code:e.code,read:e.controlRead});}}
  else atomic(path.join(dir,'preflight-failed.json'),{at:new Date().toISOString(),code:error.code||'PRECONDITION',phase,read:error.controlRead});
  process.exitCode=1;
 }finally{
  clearInterval(heartbeat);host?.stop();process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);
  if(state)await finish();
 }
}
async function watchdog(configFile){
 const config=configAt(configFile),limits=P.limitsFor(config),dir=config.runDir,lock=path.join(__dirname,'recovery-data/.autonomous-historical-recovery.lock');
 const log=v=>fs.appendFileSync(path.join(dir,'watchdog.jsonl'),JSON.stringify({at:new Date().toISOString(),...v})+'\n',{mode:0o600});
 fs.writeFileSync(path.join(dir,'started-once'),String(process.pid),{flag:'wx',mode:0o600});
 fs.mkdirSync(lock);atomic(path.join(lock,'owner.json'),{pid:process.pid,runDir:dir,label:config.label});
 const caffeinate=cp.spawn('/usr/bin/caffeinate',['-i','-s','-w',String(process.pid)],{stdio:'ignore'});
 let powerError=false,stopWorker=()=>{powerError=true;};caffeinate.on('error',()=>stopWorker('POWER_ASSERTION_LOST'));caffeinate.on('exit',()=>stopWorker('POWER_ASSERTION_LOST'));
 await new Promise(r=>setTimeout(r,500));if(powerError||caffeinate.exitCode!==null)throw Error('Power assertion failed');
 log({event:'watchdog_started',pid:process.pid,ppid:process.ppid,caffeinatePid:caffeinate.pid,limits,executionDeadline:config.executionDeadline});
 const child=cp.spawn(process.execPath,['--max-old-space-size=768',__filename,'--worker',configFile],{cwd:ROOT,stdio:'inherit'});
 let highest=0,violated=false,busy=false,monitorFailures=0,reason;
 const terminate=code=>{if(violated)return;violated=true;reason=code;log({event:'watchdog_stop',code});child.kill('SIGKILL');};
 stopWorker=terminate;
 const onSignal=()=>terminate('EXTERNAL_STOP');process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
 const timer=setInterval(()=>{
  if(Date.now()>=config.executionDeadline)terminate('TIME_LIMIT');
  if(busy)return;busy=true;
  cp.execFile('/bin/ps',['-p',String(child.pid),'-o','rss='],{timeout:2000},(e,out)=>{busy=false;if(e){if(child.exitCode===null&&++monitorFailures>=3)terminate('MEMORY_MONITOR_FAILED');return;}monitorFailures=0;const rss=Number(out.trim())*1024;if(!Number.isFinite(rss)){terminate('MEMORY_MONITOR_FAILED');return;}highest=Math.max(highest,rss);if(rss>limits.rssBytes)terminate('MEMORY_LIMIT');atomic(path.join(dir,'watchdog-heartbeat.json'),{at:new Date().toISOString(),pid:process.pid,workerPid:child.pid,rssMiB:rss/1048576,maxObservedRssMiB:highest/1048576,violated});});
 },500);
 const result=await new Promise(resolve=>{child.on('exit',(code,signal)=>resolve({code,signal}));child.on('error',e=>resolve({code:1,error:e.code}));});
 clearInterval(timer);process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);
 log({event:'worker_exited',...result,maxObservedRssMiB:highest/1048576,violated,reason});
 if((violated||result.signal)&&fs.existsSync(path.join(dir,'state.json'))){
  const file=path.join(dir,'state.json'),state=JSON.parse(fs.readFileSync(file));state.stopped=state.stopped||{at:new Date().toISOString(),code:reason||result.signal};atomic(file,state);
  const audit=cp.spawn(process.execPath,['--max-old-space-size=512',__filename,'--reconcile',configFile],{cwd:ROOT,stdio:'inherit'});
  const deadline=setTimeout(()=>audit.kill('SIGKILL'),180000);
  await new Promise(resolve=>{audit.on('exit',resolve);audit.on('error',resolve);});clearTimeout(deadline);
 }
 const reportFile=path.join(dir,'report.json');
 if(fs.existsSync(reportFile)){const r=JSON.parse(fs.readFileSync(reportFile));r.watchdog={...result,maxObservedRssMiB:highest/1048576,violated,reason};atomic(reportFile,r);}
 else atomic(path.join(dir,'report.json'),{status:'STOPPED',anomaly:reason||'PREFLIGHT_OR_WORKER_FAILED',workerResult:result,runDir:dir});
 stopWorker=()=>{};caffeinate.kill('SIGTERM');fs.rmSync(lock,{recursive:true});log({event:'watchdog_finished',restarts:0});
 process.exitCode=result.code===0&&!violated?0:1;
}
if(require.main===module){const [mode,file]=process.argv.slice(2);(mode==='--watchdog'?watchdog(file):mode==='--worker'?worker(file):mode==='--reconcile'?worker(file,true):mode==='--check'?worker(file,false,true):Promise.reject(Error('Explicit mode required'))).catch(e=>{console.error(JSON.stringify({event:'fatal',code:e.code||'LOCAL_EXECUTOR',message:'Arrêt de sécurité ; aucun redémarrage automatique.'}));process.exitCode=1;});}
module.exports={atomic,configAt,worker,watchdog};
