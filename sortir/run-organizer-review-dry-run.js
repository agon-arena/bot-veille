"use strict";
// Offline only. Deliberately no --apply mode, credentials or Supabase dependency.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { TemporalCandidateIndex } = require('./temporal-candidate-cache');
const { rowToActivity } = require('./supabase-persistence');
const { evaluateOrganizerRecovery } = require('./organizer-review-recovery');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function atomicJson(file, value) { fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); }
function runDryRun({ rows, decisions, diagnosticIds, asOf, outputDir, batchSize = 100, maxBatches = Infinity, targetIds = null, snapshotKey, resume = false }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw Error('batchSize must be 1..500');
  if (!(maxBatches === Infinity || Number.isInteger(maxBatches) && maxBatches >= 0)) throw Error('Invalid maxBatches');
  if (!Number.isFinite(Date.parse(asOf))) throw Error('Explicit asOf required');
  if (!snapshotKey) throw Error('Immutable snapshotKey required');
  const inputs = { snapshotKey, asOf, batchSize, targetIds: targetIds && [...targetIds].sort(), code: ['run-organizer-review-dry-run.js','organizer-review-policy.js','organizer-review-recovery.js','activity-validation.js','activity-deduplication.js','supabase-persistence.js','temporal-candidate-cache.js','datatourisme-review-quarantine.js','datatourisme-occurrence-identity.js'].map(f => [f, digest(fs.readFileSync(path.join(__dirname, f)))]) };
  const key = digest(JSON.stringify(inputs));
  fs.mkdirSync(outputDir, { recursive: true });
  const manifestFile = path.join(outputDir, 'manifest.json');
  if (fs.existsSync(manifestFile)) { const saved = JSON.parse(fs.readFileSync(manifestFile)); if (!resume || saved.key !== key) throw Error('Existing run or changed snapshot/code/options: new output directory required'); }
  else { if (fs.readdirSync(outputDir).length) throw Error('Output directory must be empty'); atomicJson(manifestFile, { key, inputs, mode: 'dry-run', writesToDatabase: 0 }); }
  const targets = rows.filter(r => diagnosticIds.has(r.id) && (!targetIds || targetIds.has(r.id)) && ['review','active'].includes(r.record_status) && (Date.parse(r.starts_at) >= Date.parse(asOf) || Date.parse(r.ends_at) > Date.parse(asOf))).sort((a,b) => a.id.localeCompare(b.id));
  if (targetIds && targets.length !== targetIds.size) throw Error('Requested pilot IDs are not all eligible snapshot targets');
  const index = new TemporalCandidateIndex();
  for (const row of rows) if (['active','review'].includes(row.record_status)) index.set(row.id, row);
  const decisionIndex = new Map();
  for (const d of decisions) for (const id of new Set([d.left_activity_id,d.right_activity_id])) { if (!decisionIndex.has(id)) decisionIndex.set(id, []); decisionIndex.get(id).push(d); }
  const totals = { examined: 0, wouldActivate: 0, retainedReview: 0, errors: 0, quarantines: 0, otherAmbiguities: 0, alreadyActive: 0, skipped: 0, alreadyProcessed: 0, databaseWrites: 0 };
  const results = []; let processedBatches = 0;
  const activities = new Map();
  const toActivity = row => { if (!activities.has(row.id)) activities.set(row.id, rowToActivity(row)); return activities.get(row.id); };
  for (let start = 0; start < targets.length; start += batchSize) {
    const batchTargets = targets.slice(start,start+batchSize), file = path.join(outputDir, `batch-${String(start).padStart(8,'0')}.json`);
    let batch;
    if (fs.existsSync(file)) { batch = JSON.parse(fs.readFileSync(file)); if (batch.key !== key || JSON.stringify(batch.results.map(r=>r.id)) !== JSON.stringify(batchTargets.map(r=>r.id))) throw Error('Invalid batch checkpoint'); totals.alreadyProcessed += batch.results.length; }
    else {
      if (processedBatches >= maxBatches) break;
      batch = { key, start, results: batchTargets.map(row => {
        try { return evaluateOrganizerRecovery({ row, candidates: index.matches(toActivity(row)), decisions: decisionIndex.get(row.id) || [], hasDiagnostic: diagnosticIds.has(row.id), asOf, toActivity }); }
        catch (e) { return { id: row.id, decision: 'ERROR', reason: e.message }; }
      }) };
      atomicJson(file, batch); processedBatches++;
    }
    for (const r of batch.results) { totals.examined++; totals.wouldActivate += r.decision === 'PROMOTE'; totals.retainedReview += r.decision === 'RETAIN_REVIEW'; totals.errors += r.decision === 'ERROR'; totals.quarantines += r.reason === 'pending_quarantine'; totals.otherAmbiguities += ['other_engine_review','existing_match_requires_resolution'].includes(r.reason); totals.alreadyActive += r.decision === 'ALREADY_ACTIVE'; totals.skipped += r.decision === 'SKIP'; }
    results.push(...batch.results);
    atomicJson(path.join(outputDir,'progress.json'), { key, totalTargets: targets.length, complete: results.length === targets.length, totals, lastId: results.at(-1)?.id });
  }
  const result = { mode: 'dry-run', asOf, totalTargets: targets.length, complete: results.length === targets.length, totals, results };
  atomicJson(path.join(outputDir,'result.json'), result);
  return result;
}
function loadSnapshot(dir) {
  const required = ['sortir_activities.json','sortir_provenances.json','sortir_external_ids.json','sortir_collection_items.json','sources.json','decisions.json','periods.json','baseline.json'];
  const hashes = [], data = {};
  for (const file of required) { const buffer=fs.readFileSync(path.join(dir,file)); hashes.push([file,digest(buffer)]); data[file]=JSON.parse(buffer); }
  const rows=data['sortir_activities.json'], rowMap=new Map(rows.map(r=>[r.id,r])), sourceMap=new Map(data['sources.json'].map(s=>[s.id,s])), periods=new Map(data['periods.json'].map(p=>[p.id,p]));
  for (const file of ['sortir_activities.json','sortir_provenances.json','sortir_collection_items.json','sources.json','decisions.json','periods.json']) {
    if (new Set(data[file].map(r=>r.id)).size !== data[file].length) throw Error('Duplicate snapshot IDs '+file);
  }
  const ids = data['sortir_external_ids.json'];
  if (new Set(ids.map(e=>JSON.stringify([e.activity_id,e.source_id,e.system,e.value]))).size !== ids.length) throw Error('Duplicate external IDs');
  if (data['sortir_provenances.json'].some(p=>!sourceMap.has(p.source_id)||!periods.has(p.id))) throw Error('Incomplete source/period support');
  const legacyFile=path.join(dir,'legacy-payloads.json'),legacy=fs.existsSync(legacyFile)?fs.readFileSync(legacyFile):null,legacyMap=new Map(legacy?JSON.parse(legacy).map(p=>[p.id,p.source_payload]):[]);
  if(legacy) hashes.push(['legacy-payloads.json',digest(legacy)]);
  for(const r of rows){r.provenances=[];r.external_ids=[];}
  for(const p of data['sortir_provenances.json']) {const meta=periods.get(p.id);p.source=sourceMap.get(p.source_id);p.source_payload=legacyMap.get(p.id)||p.source_payload||(meta&&{version:meta.version,period:meta.period,normalized:meta.normalized});if(!rowMap.has(p.activity_id))throw Error('Orphan provenance');rowMap.get(p.activity_id).provenances.push(p);}
  for(const e of data['sortir_external_ids.json']) {if(!rowMap.has(e.activity_id))throw Error('Orphan external ID');rowMap.get(e.activity_id).external_ids.push(e);}
  const expected=data['baseline.json'].before;
  for(const [name,array]of [['sortir_activities',rows],['sortir_provenances',data['sortir_provenances.json']],['sortir_external_ids',data['sortir_external_ids.json']],['sortir_collection_items',data['sortir_collection_items.json']]])if(array.length!==expected[name])throw Error('Incomplete snapshot '+name);
  const diagnosticIds=new Set(data['sortir_collection_items.json'].filter(i=>[...(i.diagnostics?.warnings||[]),...(i.diagnostics?.errors||[])].some(w=>w.code==='organizer_name_missing')).map(i=>i.activity_id));
  return { rows, decisions:data['decisions.json'], diagnosticIds, snapshotKey:digest(JSON.stringify(hashes)), asOf:data['baseline.json'].at };
}
if(require.main===module){
  global.fetch=async()=>{throw Error('Network forbidden: offline dry-run only');};
  try {
    const args=process.argv.slice(2),options={};
    while(args.length){const flag=args.shift();if(flag==='--resume')options.resume=true;else if(['--snapshot-dir','--output-dir','--batch-size','--max-batches','--ids-file','--as-of'].includes(flag)&&args.length&&!args[0].startsWith('--'))options[flag.slice(2)]=args.shift();else throw Error('Unknown/missing option '+flag);}
    if(!options['snapshot-dir']||!options['output-dir'])throw Error('Required: --snapshot-dir DIR --output-dir DIR [--batch-size 100] [--max-batches N] [--resume] [--ids-file JSON] [--as-of ISO]');
    const input=fs.realpathSync(options['snapshot-dir']),output=path.resolve(options['output-dir']);if(output===input||output.startsWith(input+path.sep))throw Error('Output must be outside immutable snapshot');
    const snapshot=loadSnapshot(input),result=runDryRun({...snapshot,asOf:options['as-of']||snapshot.asOf,outputDir:output,batchSize:Number(options['batch-size']||100),maxBatches:options['max-batches']===undefined?Infinity:Number(options['max-batches']),targetIds:options['ids-file']?new Set(JSON.parse(fs.readFileSync(options['ids-file']))):null,resume:options.resume});
    console.log(JSON.stringify({...result,results:undefined},null,2));if(result.totals.errors)process.exitCode=1;
  }catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={runDryRun,loadSnapshot};
