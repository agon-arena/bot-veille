"use strict";
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { TemporalCandidateIndex } = require('./temporal-candidate-cache');
const { rowToActivity } = require('./supabase-persistence');
const { evaluateOrganizerRecovery } = require('./organizer-review-recovery');
const { LOCK_ID, LOCK_VERSION } = require('./scheduler-state');
const VERSION = 'organizer-recovery-writer-v1';
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:/.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k] ?? null)]));
  return value ?? null;
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const ordered = values => values.map(canonical).sort((a,b)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?-1:x>y?1:0;});
function immutableState(row,items,decisions) {
  const {record_status,updated_at,provenances,external_ids,...scalar}=row;
  return hash({scalar,provenances:ordered(provenances||[]),externalIds:ordered(external_ids||[]),
    items:ordered(items.filter(i=>i.activity_id===row.id)),decisions:ordered(decisions.filter(d=>d.left_activity_id===row.id||d.right_activity_id===row.id))});
}
function codeHash() { return hash(['organizer-review-writer.js','organizer-recovery-connection.js','run-organizer-review-writer.js','organizer-review-recovery.js','datatourisme-geography-policy.js','data/insee-not-postal-codes.json','data/datatourisme-geographic-review-watchlist.json','organizer-review-policy.js','activity-deduplication.js','activity-validation.js','supabase-persistence.js','temporal-candidate-cache.js','datatourisme-occurrence-identity.js','datatourisme-review-quarantine.js','scheduler-state.js','../migrations/2026-10-29-sortir-organizer-recovery-journal.sql'].map(f=>[f,fs.readFileSync(path.join(__dirname,f),'utf8')])); }
function fingerprint(row, items, decisions) {
  const { provenances, external_ids, ...scalar } = row;
  return hash({scalar,provenances:ordered((provenances||[]).map(p=>({
    ...Object.fromEntries(['id','activity_id','source_id','source_record_id','source_occurrence_key','original_event_url','active','first_seen_at','last_seen_at','payload_hash'].map(k=>[k,p[k]??null])),
    source:Object.fromEntries(['key','connector_type','base_url'].map(k=>[k,p.source?.[k]??null])),
    payload:{timezoneContext:p.source_payload?.timezoneContext??null,version:p.source_payload?.version??null,period:p.source_payload?.period??null,normalized:p.source_payload?.normalized??(p.source_payload?.startsAt?{startsAt:p.source_payload.startsAt,endsAt:p.source_payload.endsAt??null,timezone:p.source_payload.timezone??null}:null)}
  }))),externalIds:ordered((external_ids||[]).map(e=>Object.fromEntries(['activity_id','source_id','system','value'].map(k=>[k,e[k]??null])))),items:ordered(items.filter(i=>i.activity_id===row.id).map(i=>Object.fromEntries(['id','activity_id','validation_status','diagnostics','source_run_id'].map(k=>[k,i[k]??null])))),decisions:ordered(decisions.filter(d=>d.left_activity_id===row.id||d.right_activity_id===row.id))});
}
function buildWritePlan({ snapshot, result, batchSize=75 }) {
  if (!result.complete || result.mode!=='dry-run' || result.totals.errors) throw Error('Complete error-free dry-run required');
  if (!Number.isInteger(batchSize)||batchSize<1||batchSize>100) throw Error('Batch size must be 1..100');
  if (!snapshot.collectionItems) throw Error('Diagnostic history required to seal plan');
  const rows=new Map(snapshot.rows.map(r=>[r.id,r]));
  const entries=result.results.map(r=>{const row=rows.get(r.id);if(!row||row.record_status!=='review'||!['PROMOTE','RETAIN_REVIEW'].includes(r.decision)||!snapshot.diagnosticIds.has(r.id))throw Error('Unsupported plan target');return {id:r.id,decision:r.decision,expectedHash:fingerprint(row,snapshot.collectionItems,snapshot.decisions)};}).sort((a,b)=>a.id.localeCompare(b.id));
  const plan={version:VERSION,asOf:result.asOf,snapshotKey:snapshot.snapshotKey,codeHash:codeHash(),batchSize,entries};return {...plan,planHash:hash(plan)};
}
function validatePlan(plan, authorization) {
  const {planHash,...body}=plan;
  if (plan.version!==VERSION||hash(body)!==planHash||authorization!==planHash||plan.codeHash!==codeHash())throw Error('Exact current plan authorization required');
  if (!plan.entries.length||plan.entries.length>40000||!Number.isInteger(plan.batchSize)||plan.batchSize<1||plan.batchSize>100||new Set(plan.entries.map(e=>e.id)).size!==plan.entries.length)throw Error('Invalid plan');
  for(const e of plan.entries)if(!/^[a-f0-9-]{36}$/i.test(e.id)||!['PROMOTE','RETAIN_REVIEW'].includes(e.decision)||!/^[a-f0-9]{64}$/.test(e.expectedHash))throw Error('Invalid plan entry');
}
async function loadCurrent(client, ids) {
  const query=await client.query(`select to_jsonb(a) as row from public.sortir_activities a where a.id=any($1::uuid[]) or
    (a.record_status in ('active','review') and exists(select 1 from public.sortir_activities t where t.id=any($1::uuid[]) and a.starts_at between t.starts_at-interval '12 hours' and t.starts_at+interval '12 hours'))`,[ids]);
  const rows=query.rows.map(r=>r.row),allIds=rows.map(r=>r.id),byId=new Map(rows.map(r=>[r.id,r]));for(const r of rows){r.provenances=[];r.external_ids=[];}
  const ps=await client.query('select to_jsonb(p) as row from public.sortir_provenances p where p.activity_id=any($1::uuid[])',[allIds]);
  const sources=await client.query('select id,key,connector_type,base_url from public.sortir_sources');const sm=new Map(sources.rows.map(s=>[s.id,s]));
  for(const {row:p}of ps.rows){p.source=sm.get(p.source_id);byId.get(p.activity_id).provenances.push(p);}
  const es=await client.query('select to_jsonb(e) as row from public.sortir_external_ids e where e.activity_id=any($1::uuid[])',[allIds]);for(const {row:e}of es.rows)byId.get(e.activity_id).external_ids.push(e);
  const items=(await client.query('select to_jsonb(i) as row from public.sortir_collection_items i where i.activity_id=any($1::uuid[])',[ids])).rows.map(r=>r.row);
  const decisions=(await client.query('select to_jsonb(d) as row from public.sortir_dedup_decisions d where d.left_activity_id=any($1::uuid[]) or d.right_activity_id=any($1::uuid[])',[ids])).rows.map(r=>r.row);
  return {rows,byId,items,decisions};
}
async function counters(client) {
  const r=await client.query(`select (select count(*)::int from public.sortir_activities) activities,
   (select count(*)::int from public.sortir_provenances) provenances,(select count(*)::int from public.sortir_external_ids) external_ids,
   (select count(*)::int from public.sortir_activities where record_status='active') active,
   (select count(*)::int from public.sortir_activities where record_status='review') review`);return r.rows[0];
}
async function writeBatch({client,plan,batchNumber,authorization,apply=false,hook=async()=>{}}) {
  if(!apply)throw Error('Write mode disabled by default');validatePlan(plan,authorization);
  const entries=plan.entries.slice(batchNumber*plan.batchSize,(batchNumber+1)*plan.batchSize);if(!Number.isInteger(batchNumber)||batchNumber<0||!entries.length)throw Error('Invalid batch number');
  const requestHash=hash(entries);await client.query('begin');let committed=false;
  try {
    await client.query("set local lock_timeout='1s'");await client.query("set local statement_timeout='60s'");await client.query("set local idle_in_transaction_session_timeout='60s'");
    // Non-cooperative/manual ingestion is excluded too. NOWAIT never queues this
    // writer behind an ingestion. Scheduler writes can only proceed after COMMIT.
    const visibility=(await client.query('select public.sortir_organizer_recovery_lock() as visibility')).rows[0].visibility;
    const held=await client.query(`select c.relname from pg_locks l join pg_class c on c.oid=l.relation
      join pg_namespace n on n.oid=c.relnamespace where l.pid=pg_backend_pid() and l.granted
      and l.mode='ShareRowExclusiveLock' and n.nspname='public'`);
    const required=['sortir_ingestion_runs','sortir_source_runs','sortir_sources','sortir_activities','sortir_provenances','sortir_external_ids','sortir_collection_items','sortir_dedup_decisions','sortir_datatourisme_poi_states','sortir_organizer_recovery_batches'];
    if(required.some(t=>!held.rows.some(r=>r.relname===t)))throw Error('Required ingestion exclusion locks missing');
    // A restrictive RLS policy must never silently hide a duplicate candidate.
    for(const table of required){const count=Number((await client.query('select count(*) as n from public.'+table)).rows[0].n);if(!visibility||Number(visibility[table])!==count)throw Error('Incomplete database visibility: '+table);}
    const lock=await client.query('select id,orchestrator_version,status from public.sortir_ingestion_runs where id=$1',[LOCK_ID]);
    if(lock.rows.length!==1||lock.rows[0].orchestrator_version!==LOCK_VERSION||lock.rows[0].status!=='completed')throw Error('Scheduler lock unavailable');
    const running=await client.query("select id from public.sortir_ingestion_runs where status='running' union all select id from public.sortir_source_runs where status='running' limit 1");if(running.rows.length)throw Error('Ingestion running');
    const prior=await client.query('select request_hash,result from public.sortir_organizer_recovery_batches where plan_hash=$1 and batch_number=$2',[plan.planHash,batchNumber]);
    if(prior.rows.length){
      const saved=prior.rows[0].result,expectedPromotions=entries.filter(e=>e.decision==='PROMOTE').length;
      if(prior.rows[0].request_hash!==requestHash||saved.planHash!==plan.planHash||saved.batchNumber!==batchNumber||
        saved.examined!==entries.length||saved.newlyActivated!==expectedPromotions||saved.errors!==0||
        !Array.isArray(saved.journal)||saved.journal.length!==entries.length||
        saved.journal.some((e,i)=>e.id!==entries[i].id||e.expectedHash!==entries[i].expectedHash||e.action!==entries[i].decision||e.before!=='review'||e.after!==(e.action==='PROMOTE'?'active':'review'))||
        !saved.before||!saved.after||saved.after.active-saved.before.active!==expectedPromotions||saved.before.review-saved.after.review!==expectedPromotions||
        ['activities','provenances','external_ids'].some(k=>!Number.isInteger(saved.before[k])||saved.before[k]!==saved.after[k]))throw Error('Checkpoint inconsistency');
      await client.query('commit');committed=true;return {...saved,replayed:true,newlyActivated:0,alreadyProcessed:entries.length};
    }
    const current=await loadCurrent(client,entries.map(e=>e.id)),index=new TemporalCandidateIndex();for(const row of current.rows)if(['active','review'].includes(row.record_status))index.set(row.id,row);
    const asOf=(await client.query('select clock_timestamp() as now')).rows[0].now;
    const before=await counters(client),journal=[];
    const originalState=new Map(entries.map(e=>{const row=current.byId.get(e.id);return [e.id,row&&immutableState(row,current.items,current.decisions)];}));
    // Revalidate the entire batch BEFORE the first business UPDATE.
    for(const entry of entries){const row=current.byId.get(entry.id);if(!row||fingerprint(row,current.items,current.decisions)!==entry.expectedHash)throw Error('Changed since dry-run: '+entry.id);
      const hasDiagnostic=current.items.some(i=>i.activity_id===row.id&&[...(i.diagnostics?.warnings||[]),...(i.diagnostics?.errors||[])].some(w=>w.code==='organizer_name_missing'));
      const evaluation=evaluateOrganizerRecovery({row,candidates:index.matches(rowToActivity(row)),decisions:current.decisions,hasDiagnostic,asOf});
      if(entry.decision==='PROMOTE'&&evaluation.decision!=='PROMOTE')throw Error('Eligibility changed: '+entry.id+' '+evaluation.reason);
      if(!['PROMOTE','RETAIN_REVIEW'].includes(evaluation.decision))throw Error('Unexpected current status: '+entry.id);
      journal.push({id:entry.id,before:'review',after:entry.decision==='PROMOTE'?'active':'review',updatedAtBefore:row.updated_at??null,expectedHash:entry.expectedHash,reason:evaluation.reason,action:entry.decision});
    }
    await hook('validated',client);
    for(const entry of journal.filter(e=>e.after==='active')){const saved=await client.query("update public.sortir_activities set record_status='active',updated_at=clock_timestamp() where id=$1 and record_status='review' returning id,updated_at",[entry.id]);if(saved.rows.length!==1)throw Error('Concurrent status change');entry.updatedAtAfter=new Date(saved.rows[0].updated_at).toISOString();await hook('updated',client,entry);}
    const after=await counters(client),activated=journal.filter(e=>e.after==='active').length;
    const verified=await loadCurrent(client,entries.map(e=>e.id));
    for(const e of journal){const row=verified.byId.get(e.id);if(!row||row.record_status!==e.after||immutableState(row,verified.items,verified.decisions)!==originalState.get(e.id))throw Error('Business data changed during transaction: '+e.id);}
    for(const key of ['activities','provenances','external_ids'])if(after[key]!==before[key])throw Error('Identity count changed');
    if(after.active-before.active!==activated||before.review-after.review!==activated)throw Error('Status count inconsistency');
    const result={planHash:plan.planHash,batchNumber,asOf:new Date(asOf).toISOString(),examined:entries.length,newlyActivated:activated,retainedReview:entries.length-activated,quarantines:journal.filter(e=>e.reason==='pending_quarantine').length,otherAmbiguities:journal.filter(e=>['other_engine_review','existing_match_requires_resolution'].includes(e.reason)).length,errors:0,alreadyProcessed:0,replayed:false,before,after,journal};
    await client.query('insert into public.sortir_organizer_recovery_batches(plan_hash,batch_number,request_hash,result) values($1,$2,$3,$4::jsonb)',[plan.planHash,batchNumber,requestHash,JSON.stringify(result)]);
    await hook('beforeCommit',client);await client.query('commit');committed=true;await hook('afterCommit',client);return result;
  }catch(error){if(!committed){try{await client.query('rollback');}catch(_){} }throw error;}
}
module.exports={VERSION,hash,fingerprint,codeHash,buildWritePlan,validatePlan,writeBatch,loadCurrent};
