"use strict";
// Supervision externe : aucun changement du writer, de ses règles ou des plans scellés.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const W = require('./organizer-review-writer');
const { evaluateOrganizerRecovery } = require('./organizer-review-recovery');
const { TemporalCandidateIndex } = require('./temporal-candidate-cache');
const { rowToActivity } = require('./supabase-persistence');
const { LOCK_ID, LOCK_VERSION } = require('./scheduler-state');
const {readOnly,journalRows,journalDigests,ROW_DIGEST,assertSessionConnection}=require('./recovery-control-reads');
const {openGuardedClient}=require('./recovery-connection-guard');
const DEADLINE = '2026-11-05T17:00:00.000Z'; // 21:00 Réunion : aucun override CLI.
const MANIFEST_SHA256 = '2dac946e00972458d61e8fb65b531a26a7308ec3bb0c5eabc86935f7fd60277d';
const RETRY_DELAYS = [2000, 5000, 15000];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
class RecoveryStop extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const stop = (code, message) => { throw new RecoveryStop(code, message); };
function checkDeadline(value, deadline = DEADLINE) {
  const stamp = Number(new Date(value));
  if (!Number.isFinite(stamp) || stamp >= Date.parse(deadline)) stop('EXPIRED', 'Échéance atteinte ou horloge invalide : revalidation et nouveau scellement requis.');
}
function loadBundle(manifestPath) {
  const bytes = fs.readFileSync(manifestPath);
  if (sha256(bytes) !== MANIFEST_SHA256) stop('PLAN', 'Manifeste différent de la reprise autorisable.');
  const manifest = JSON.parse(bytes), seen = new Set();
  if (manifest.asOf !== DEADLINE || manifest.entries !== 27832 || manifest.batches !== 285 || manifest.plans.length !== 12)
    stop('PLAN', 'Périmètre national inattendu.');
  const plans = manifest.plans.map((meta, i) => {
    if (meta.group !== String(i + 1).padStart(3, '0') || meta.path !== `plan-${meta.group}/sealed-plan.json`)
      stop('PLAN', 'Ordre ou chemin de plan invalide.');
    const filename = path.join(path.dirname(manifestPath), meta.path), data = fs.readFileSync(filename);
    if (sha256(data) !== meta.fileSha256) stop('PLAN', 'Fichier de plan altéré.');
    const plan = JSON.parse(data); W.validatePlan(plan, meta.planHash);
    if (plan.asOf !== DEADLINE || plan.codeHash !== manifest.codeHash || plan.snapshotKey !== manifest.snapshotKey ||
        plan.entries.length !== meta.entries || Math.ceil(plan.entries.length / plan.batchSize) !== meta.batches)
      stop('PLAN', 'Métadonnées du plan incohérentes.');
    for (const e of plan.entries) {
      if (seen.has(e.id) || e.decision !== 'PROMOTE') stop('PLAN', 'Identité dupliquée ou décision hors périmètre.');
      seen.add(e.id);
    }
    return { ...meta, plan, verify: () => {
      if (sha256(fs.readFileSync(manifestPath)) !== MANIFEST_SHA256 || sha256(fs.readFileSync(filename)) !== meta.fileSha256)
        stop('PLAN', 'Plans modifiés pendant la supervision.');
      W.validatePlan(plan, meta.planHash);
    } };
  });
  if (seen.size !== 27832 || plans.reduce((n,p) => n + p.batches, 0) !== 285) stop('PLAN', 'Totaux du manifeste incohérents.');
  return { manifestHash: MANIFEST_SHA256, deadline: DEADLINE, plans,
    minimumCommittedBatches: [17, 1, 1, 4, 30, 21, 0, 0, 0, 0, 0, 0] };
}
function entriesFor(plan, batchNumber) {
  return plan.entries.slice(batchNumber * plan.batchSize, (batchNumber + 1) * plan.batchSize);
}
// Même preuve que le chemin replay du writer ; aucune fonction d'écriture appelée.
function validateCheckpoint(plan, batchNumber, row) {
  const entries = entriesFor(plan, batchNumber), saved = row?.result;
  const promotions = entries.filter(e => e.decision === 'PROMOTE').length;
  const countKeys = ['activities', 'provenances', 'external_ids', 'active', 'review'];
  if (!entries.length || row.plan_hash !== plan.planHash || row.batch_number !== batchNumber || row.request_hash !== W.hash(entries) ||
      !saved || saved.planHash !== plan.planHash || saved.batchNumber !== batchNumber || saved.examined !== entries.length ||
      saved.newlyActivated !== promotions || saved.errors !== 0 || !Array.isArray(saved.journal) || saved.journal.length !== entries.length ||
      saved.journal.some((e,i) => e.id !== entries[i].id || e.expectedHash !== entries[i].expectedHash ||
        e.action !== entries[i].decision || e.before !== 'review' || e.after !== (e.action === 'PROMOTE' ? 'active' : 'review')) ||
      !saved.before || !saved.after || countKeys.some(k => !Number.isInteger(saved.before[k]) || !Number.isInteger(saved.after[k])) ||
      saved.after.active - saved.before.active !== promotions || saved.before.review - saved.after.review !== promotions ||
      ['activities','provenances','external_ids'].some(k => saved.before[k] !== saved.after[k]))
    stop('CHECKPOINT', 'Checkpoint transactionnel incohérent : arrêt sans nouvelle promotion.');
  return W.hash(row);
}
function transient(error) {
  if (error instanceof RecoveryStop) return false;
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|57P01|57P02|57P03|08\w{3})$/.test(error?.code || '') ||
    /connection (terminated unexpectedly|terminated|reset)|socket hang up|read ECONNRESET/i.test(error?.message || '');
}
async function serverTime(client, deadline) {
  const r = await client.query('SELECT clock_timestamp() AS now');
  const value = r.rows[0]?.now; checkDeadline(value, deadline); return value;
}
async function assertIdle(client) {
  const lock = await client.query('SELECT status,orchestrator_version FROM public.sortir_ingestion_runs WHERE id=$1', [LOCK_ID]);
  if (lock.rows.length !== 1 || lock.rows[0].status !== 'completed' || lock.rows[0].orchestrator_version !== LOCK_VERSION)
    stop('BUSY', 'Mutex scheduler indisponible : aucun verrou libéré.');
  const active = await client.query("SELECT id FROM public.sortir_ingestion_runs WHERE status='running' UNION ALL SELECT id FROM public.sortir_source_runs WHERE status='running' LIMIT 1");
  if (active.rows.length) stop('BUSY', 'Ingestion active : reprise interdite.');
  const scan = await client.query("SELECT datatourisme_national_scan->>'status' AS status FROM public.sortir_sources WHERE key='datatourisme-national'");
  if (scan.rows.length !== 1 || scan.rows[0].status !== 'finalized') stop('BUSY', 'Scan national non finalisé ou source introuvable.');
}
async function readCheckpoint(client, plan, batchNumber) {
  const r = await client.query('SELECT plan_hash,batch_number,request_hash,result FROM public.sortir_organizer_recovery_batches WHERE plan_hash=$1 AND batch_number=$2', [plan.planHash,batchNumber]);
  if (r.rows.length > 1) stop('CHECKPOINT', 'Checkpoint dupliqué.');
  if (r.rows[0]) validateCheckpoint(plan,batchNumber,r.rows[0]);
  return r.rows[0] || null;
}
// Vérification du journal des checkpoints du manifeste, dans un contrôle readOnly.
// Mode intégral : chaque ligne relue et revalidée (chemin historique). Mode incrémental
// (registre fourni et prêt) : une seule requête d'empreintes sha256 calculées par le
// serveur ; toute altération, suppression ou ligne en double d'un checkpoint déjà
// vérifié renvoie au mode intégral, autoritatif. Les nouveaux checkpoints sont toujours
// relus et revalidés en entier, puis les mêmes contrôles de préfixe s'appliquent.
async function verifyJournal(client, bundle, ledger = null, { forceFull = false, committedAt = false, fetch = [] } = {}) {
  for (const p of bundle.plans) p.verify();
  const byHash = new Map(bundle.plans.map(p => [p.plan.planHash, p])), want = new Set(fetch);
  let rows = null, mode = 'full';
  if (ledger?.ready && !forceFull && !ledger.forceFull) { rows = await incrementalRows(client, bundle, ledger, byHash, committedAt, want); if (rows) mode = 'incremental'; else ledger.fallbacks++; }
  if (!rows) {
    rows = new Map();
    for (const p of bundle.plans) for (const row of await journalRows(client, p.plan.planHash, p.batches, committedAt, !!ledger))
      rows.set(`${p.plan.planHash}:${row.batch_number}`, { row, fresh: true, planHash: p.plan.planHash });
  }
  const map = new Map(), fresh = new Map(), entries = new Map(); let gap = false, total = 0;
  for (let i = 0; i < bundle.plans.length; i++) {
    const p = bundle.plans[i], numbers = [...rows.values()].filter(r => r.planHash === p.plan.planHash).map(r => r.batchNumber ?? r.row.batch_number).sort((a, b) => a - b);
    if (numbers.length > p.batches || numbers.length < bundle.minimumCommittedBatches[i] || (gap && numbers.length))
      stop('CHECKPOINT', 'Préfixe de reprise absent, régressif ou non contigu.');
    numbers.forEach((n, k) => { if (n !== k) stop('CHECKPOINT', 'Trou dans les checkpoints.'); });
    for (const n of numbers) {
      const key = `${p.plan.planHash}:${n}`, item = rows.get(key);
      if (item.fresh) {
        const { row_digest, committed_at, ...stable } = item.row, anchor = validateCheckpoint(p.plan, n, stable);
        if (want.has(key) || committedAt) fresh.set(key, item.row);
        entries.set(key, { rowDigest: row_digest, anchor, activated: stable.result.newlyActivated });
        map.set(key, anchor); total += stable.result.newlyActivated;
      } else { map.set(key, item.entry.anchor); entries.set(key, item.entry); total += item.entry.activated; }
    }
    if (numbers.length < p.batches) gap = true;
  }
  if (ledger) ledger.record(entries, mode);
  return { map, total, fresh, mode };
}
async function incrementalRows(client, bundle, ledger, byHash, committedAt, want) {
  const digests = await journalDigests(client, [...byHash.keys()], bundle.plans.reduce((n, p) => n + p.batches, 0));
  const seen = new Map();
  for (const d of digests) { const key = `${d.plan_hash}:${d.batch_number}`; if (seen.has(key) || !d.row_digest) return null; seen.set(key, d); }
  for (const [key, entry] of ledger.entries) if (seen.get(key)?.row_digest !== entry.rowDigest) return null;
  const rows = new Map();
  for (const [key, d] of seen) {
    if (ledger.entries.has(key) && !want.has(key)) { rows.set(key, { planHash: d.plan_hash, batchNumber: d.batch_number, entry: ledger.entries.get(key) }); continue; }
    const row = await readCheckpointRow(client, d.plan_hash, d.batch_number, committedAt || want.has(key));
    // Ligne changée entre les deux lectures : retour au mode intégral.
    if (!row || row.row_digest !== d.row_digest) return null;
    rows.set(key, { row, fresh: true, planHash: d.plan_hash });
  }
  return rows;
}
async function readCheckpointRow(client, planHash, batchNumber, committedAt) {
  const r = await client.query(`SELECT plan_hash,batch_number,request_hash,result${committedAt ? ',committed_at' : ''},${ROW_DIGEST} AS row_digest
    FROM public.sortir_organizer_recovery_batches WHERE plan_hash=$1 AND batch_number=$2`, [planHash, batchNumber]);
  return r.rows.length === 1 ? r.rows[0] : null;
}
// Registre en mémoire du processus : empreinte serveur de chaque checkpoint vérifié.
class CheckpointLedger {
  constructor() { this.entries = new Map(); this.ready = false; this.forceFull = false; this.fallbacks = 0; this.stats = { full: 0, incremental: 0 }; }
  record(entries, mode) {
    // Sans empreinte serveur (lecture sans registre), le registre reste inutilisable.
    if ([...entries.values()].some(e => !/^[a-f0-9]{64}$/.test(e.rowDigest || ''))) { this.entries = new Map(); this.ready = false; return; }
    this.entries = new Map(entries); this.ready = true; this.stats[mode]++; if (mode === 'full') this.forceFull = false;
  }
}
async function readProgress(client, bundle, anchors, ledger = null, options = {}) {
  return readOnly(client, async () => {
    await serverTime(client,bundle.deadline); await assertIdle(client);
    const { map: found } = await verifyJournal(client, bundle, ledger, options);
    for (const [key,digest] of found) if (anchors.has(key) && anchors.get(key)!==digest) stop('CHECKPOINT', 'Checkpoint précédemment observé modifié.');
    for (const key of anchors.keys()) if (!found.has(key)) stop('CHECKPOINT','Checkpoint précédemment observé disparu.');
    for (const [key,value] of found) anchors.set(key,value);
    return found;
  });
}
async function hydrateRows(client, rows, sources) {
  const ids=rows.map(r=>r.id), byId=new Map(rows.map(r=>[r.id,{...r,provenances:[],external_ids:[]} ]));
  if (!ids.length) return [];
  // Provenances et identifiants externes en un seul aller-retour (mêmes lignes, mêmes filtres).
  const linked=await client.query(`SELECT 'p' AS kind,to_jsonb(p) AS row FROM public.sortir_provenances p WHERE activity_id=ANY($1::uuid[])
    UNION ALL SELECT 'e' AS kind,to_jsonb(e) AS row FROM public.sortir_external_ids e WHERE activity_id=ANY($1::uuid[])`,[ids]);
  for(const {kind,row} of linked.rows) {
    const target=byId.get(row.activity_id);
    if(kind==='p') target.provenances.push({...row,source:sources.get(row.source_id)}); else target.external_ids.push(row);
  }
  return [...byId.values()];
}
// Revalidation préliminaire paginée sur l'UNION des fenêtres ±12 h des cibles du lot :
// au plus 100 candidats hydratés en mémoire par page. Chaque cible reçoit exactement les
// candidats du découpage historique en groupes de 25 (matches() borne chaque cible à sa
// propre fenêtre). Horloge serveur au début (asOf) et à la fin ; entre les deux, la garde
// locale d'échéance s'applique avant chaque requête et le writer revérifie l'horloge
// serveur avant validation et avant COMMIT. Le writer conserve son contrôle autoritatif.
async function revalidateBatch(client, plan, batchNumber, deadline, { observe } = {}) {
  const entries=entriesFor(plan,batchNumber), ids=entries.map(e=>e.id), byId=new Map(entries.map(e=>[e.id,e])); let pages=0;
  await readOnly(client,async()=>{
    const asOf=await serverTime(client,deadline); await assertIdle(client);
    const sources=new Map((await client.query('SELECT id,key,connector_type,base_url FROM public.sortir_sources')).rows.map(s=>[s.id,s]));
    const targets=await hydrateRows(client,(await client.query('SELECT to_jsonb(a) AS row FROM public.sortir_activities a WHERE id=ANY($1::uuid[])',[ids])).rows.map(r=>r.row),sources);
    const items=(await client.query('SELECT to_jsonb(i) AS row FROM public.sortir_collection_items i WHERE activity_id=ANY($1::uuid[])',[ids])).rows.map(r=>r.row);
    const decisions=(await client.query('SELECT to_jsonb(d) AS row FROM public.sortir_dedup_decisions d WHERE left_activity_id=ANY($1::uuid[]) OR right_activity_id=ANY($1::uuid[])',[ids])).rows.map(r=>r.row);
    if(targets.length!==ids.length) stop('BUSINESS','Cible historique absente.');
    const check=(row,candidates)=>{
      const entry=byId.get(row.id);
      if(!entry || W.fingerprint(row,items,decisions)!==entry.expectedHash) stop('BUSINESS','Empreinte modifiée depuis le scellement.');
      const hasDiagnostic=items.some(i=>i.activity_id===row.id&&[...(i.diagnostics?.warnings||[]),...(i.diagnostics?.errors||[])].some(w=>w.code==='organizer_name_missing'));
      const r=evaluateOrganizerRecovery({row,candidates,decisions,hasDiagnostic,asOf});
      observe?.({id:row.id,candidates:candidates.map(c=>c.id),decision:r.decision,reason:r.reason});
      if(r.decision!==entry.decision) stop('BUSINESS',`Éligibilité modifiée : ${r.reason}.`);
    };
    for(const row of targets) check(row,[]);
    let after=null;
    while(true) {
      const raw=(await client.query(`SELECT to_jsonb(a) AS row FROM public.sortir_activities a
        WHERE a.record_status IN ('active','review') AND ($2::uuid IS NULL OR a.id>$2::uuid)
        AND EXISTS(SELECT 1 FROM public.sortir_activities t WHERE t.id=ANY($1::uuid[])
          AND a.starts_at BETWEEN t.starts_at-interval '12 hours' AND t.starts_at+interval '12 hours')
        ORDER BY a.id LIMIT 100`,[ids,after])).rows.map(r=>r.row);
      if(raw.some((r,i)=>!r.id || (i ? r.id<=raw[i-1].id : after && r.id<=after))) stop('BUSINESS','Pagination des candidats incohérente.');
      const index=new TemporalCandidateIndex(); for(const row of await hydrateRows(client,raw,sources)) index.set(row.id,row);
      for(const row of targets) check(row,index.matches(rowToActivity(row)));
      pages++; if(raw.length<100) break; after=raw.at(-1).id;
    }
    await serverTime(client,deadline);
  });
  return { targets:entries.length,candidatePages:pages };
}
// Capture aussi les erreurs pg émises hors d'une query (ancien ECONNRESET non intercepté).
async function connectRecovery(env) {
  const {Client}=require('pg'), {recoveryConnectionConfig}=require('./organizer-recovery-connection');
  const config=recoveryConnectionConfig(env);assertSessionConnection(config);
  const guarded=openGuardedClient(Client,config),client={query:(...args)=>guarded.query(...args),end:()=>guarded.end()};
  try {await guarded.connect();await client.query('SET ROLE sortir_organizer_recovery_writer');return client;}
  catch(error){await client.end();throw error;}
}
async function supervise({bundle,connect,apply=false,authorization,maxBatches=1,now=Date.now,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),log=console.log,signal,
  writeBatch=W.writeBatch,validateBatch=revalidateBatch,ledger=null}={}) {
  if(!Number.isInteger(maxBatches)||maxBatches<1||maxBatches>285) stop('CONFIG','Limite de lots invalide.');
  if(apply && authorization!==bundle.manifestHash) stop('AUTH','Autorisation exacte du manifeste requise.');
  const guard=()=>{if(signal?.aborted)stop('INTERRUPTED','Arrêt demandé ; reprise depuis le journal durable.');checkDeadline(now(),bundle.deadline);};
  let client=null,totalRetries=0,completed=0,activated=0,reconciled=0; const anchors=new Map();
  const emit=value=>log(JSON.stringify({at:new Date(now()).toISOString(),...value}));
  async function close(){if(client){const old=client;client=null;await old.end();}}
  async function retry(label,work){
    for(let attempt=0;;attempt++){
      guard();
      try {
        if(!client){client=await connect();await readProgress(client,bundle,anchors,ledger);emit({event:'checkpoints_verified',batches:anchors.size});}
        return await work(client);
      } catch(error){
        await close();
        if(!transient(error)||attempt>=RETRY_DELAYS.length||totalRetries>=6)throw error;
        totalRetries++;emit({event:'network_retry',operation:label,attempt:attempt+1,totalRetries,
          note:'Résultat éventuellement committé : lecture du journal sur nouvelle connexion avant toute écriture.'});
        await sleep(RETRY_DELAYS[attempt]);
      }
    }
  }
  try {
    await retry('initial_checkpoint_read',async()=>{});
    for(const p of bundle.plans)for(let n=0;n<p.batches;n++){
      const key=`${p.plan.planHash}:${n}`;
      if(anchors.has(key))continue;
      if(completed>=maxBatches)return {completed,activated,reconciled,totalRetries,limited:true};
      await retry(`${p.group}/${n+1}`,async c=>{
        guard();p.verify();
        const prior=await readOnly(c,async()=>{await serverTime(c,bundle.deadline);await assertIdle(c);return readCheckpoint(c,p.plan,n);});
        if(prior){anchors.set(key,validateCheckpoint(p.plan,n,prior));reconciled+=prior.result.newlyActivated;emit({event:'commit_reconciled',plan:p.group,batch:n+1,entries:entriesFor(p.plan,n).length});return;}
        const checked=await validateBatch(c,p.plan,n,bundle.deadline);
        emit({event:'batch_validated',plan:p.group,batch:n+1,...checked});guard();
        if(!apply){emit({event:'checked_read_only',plan:p.group,batch:n+1});return;}
        await writeBatch({client:c,plan:p.plan,batchNumber:n,authorization:p.plan.planHash,apply:true,
          hook:async phase=>{if(phase==='validated'||phase==='beforeCommit'){guard();await serverTime(c,bundle.deadline);}}});
        const saved=await readOnly(c,()=>readCheckpoint(c,p.plan,n));
        if(!saved)stop('CHECKPOINT','Writer terminé sans checkpoint durable confirmé.');
        anchors.set(key,validateCheckpoint(p.plan,n,saved)); activated+=saved.result.newlyActivated;
        emit({event:'batch_committed',plan:p.group,batch:n+1,activated:saved.result.newlyActivated});
      });
      completed++;
    }
    return {completed,activated,reconciled,totalRetries,limited:false};
  } finally {await close();}
}
module.exports={DEADLINE,MANIFEST_SHA256,RecoveryStop,stop,loadBundle,validateCheckpoint,checkDeadline,transient,serverTime,assertIdle,
  readOnly,readProgress,verifyJournal,CheckpointLedger,revalidateBatch,connectRecovery,supervise,entriesFor};
