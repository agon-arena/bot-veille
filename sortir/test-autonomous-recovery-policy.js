"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),P=require('./autonomous-recovery-policy'),S=require('./historical-recovery-supervisor');
const now=Date.parse('2026-11-05T05:00:00Z'),config={executionDeadline:now+18*3600000};
test('budget: un lot de 100 passe, 101 est refusé',()=>{P.guard({verified:[]},config,100,now);assert.throws(()=>P.guard({verified:[]},config,101,now),{code:'BATCH_LIMIT'});});
test('configuration un seul lot : impossible de poursuivre après 100 promotions',()=>{const c={...config,limits:{...P.LIMITS,batches:1,promotions:100}};P.guard({verified:[]},c,100,now);assert.throws(()=>P.guard({verified:[{entries:100}]},c,1,now),{code:'AUTHORIZATION_LIMIT'});});
test('une configuration ne peut augmenter aucun plafond global',()=>{for(const k of Object.keys(P.LIMITS))assert.throws(()=>P.limitsFor({limits:{...P.LIMITS,[k]:P.LIMITS[k]+1}}),{code:'AUTHORIZATION_LIMIT'});});
test('sélection strictement bornée à un seul lot',()=>{const p={planHash:'p',batchSize:100,entries:Array.from({length:300},(_,i)=>({id:i}))};assert.deepEqual(P.targets({plans:[{group:'007',plan:p,batches:3}]},new Map(),{...P.LIMITS,batches:1,promotions:100}).map(t=>t.batchNumber),[0]);});
const successful=()=>({entries:100,integrity:true,duplicates:false,errors:0});
test('poursuite complète : passage de tranche seulement après succès, sans relever les plafonds',()=>{
 const c={...config,continueToEnd:true,scope:{batches:101,promotions:10100}},s={verified:Array.from({length:100},successful),pending:null,segmentStart:0};
 const deadline=c.executionDeadline,limits={...P.LIMITS};assert.throws(()=>P.guard(s,c,100,now),{code:'AUTHORIZATION_LIMIT'});
 assert.equal(P.advanceSegment(s,c,100,now),true);assert.equal(s.segmentStart,100);P.guard(s,c,100,now);assert.equal(c.executionDeadline,deadline);assert.deepEqual(P.LIMITS,limits);
 s.verified.push(successful());assert.throws(()=>P.guard(s,c,1,now),{code:'AUTHORIZATION_LIMIT'});
});
test('aucune poursuite de tranche après anomalie, checkpoint ambigu ou intégrité invalide',()=>{
 const c={...config,continueToEnd:true,scope:{batches:101,promotions:10100}};
 for(const bad of ['error','pending','integrity','duplicate']){const s={verified:Array.from({length:100},successful),pending:null,segmentStart:0};if(bad==='error')s.stopped={code:'25P03'};if(bad==='pending')s.pending={};if(bad==='integrity')s.verified[0].integrity=false;if(bad==='duplicate')s.verified[0].duplicates=true;assert.throws(()=>P.advanceSegment(s,c,100,now));assert.equal(s.segmentStart,0);}
});
test('l’échéance est inchangée lors du passage à une autre tranche',()=>{const c={executionDeadline:now,continueToEnd:true,scope:{batches:101,promotions:10100}},s={verified:Array.from({length:100},successful),pending:null,segmentStart:0};assert.throws(()=>P.advanceSegment(s,c,100,now),{code:'TIME_LIMIT'});assert.equal(s.segmentStart,0);});
test('le mode habituel reste limité à 100 lots, sans poursuite implicite',()=>{const s={verified:Array.from({length:100},successful)};assert.equal(P.advanceSegment(s,config,100,now),false);assert.throws(()=>P.guard(s,config,100,now),{code:'AUTHORIZATION_LIMIT'});});
test('reliquat scellé réel : 199 lots, 19595 promotions, début 007/2 et aucun lot supérieur à 100',()=>{
 const fs=require('fs'),path=require('path'),b=S.loadBundle(path.join(__dirname,'recovery-data/2026-11-02-national/plans-index.json')),state=JSON.parse(fs.readFileSync(path.join(__dirname,'recovery-data/2026-11-05-authorized-007-1-GEDUdn/state.json'))),anchors=new Map(state.anchors),c={continueToEnd:true,scope:{batches:199,promotions:19595}};
 const list=P.runTargets(b,anchors,c);assert.equal(list.length,199);assert.equal(list.reduce((n,t)=>n+t.entries,0),19595);assert.deepEqual(list[0],{group:'007',batchNumber:1,entries:100});assert.equal(list.at(-1).group,'012');assert(list.every(t=>t.entries<=100));
 const policy={...config,...c},progress={verified:[],pending:null,segmentStart:0,segments:[{startIndex:0}]};
 for(const target of list){P.advanceSegment(progress,policy,target.entries,now);P.guard(progress,policy,target.entries,now);progress.verified.push({...successful(),entries:target.entries});}
 assert.equal(progress.verified.length,199);assert.equal(progress.segments.length,2);assert.equal(progress.segmentStart,100);assert.equal(progress.verified.reduce((n,b)=>n+b.entries,0),19595);assert.throws(()=>P.guard(progress,policy,1,now),{code:'AUTHORIZATION_LIMIT'});
 assert.throws(()=>P.runTargets(b,anchors,{...c,scope:{batches:200,promotions:19595}}),{code:'AUTHORIZATION_LIMIT'});
});
test('configuration de reprise : ancrages existants, comptes et prochain lot vérifiés localement',()=>{
 const fs=require('fs'),os=require('os'),path=require('path'),W=require('./organizer-review-writer'),A=require('./autonomous-historical-recovery');
 const previous=JSON.parse(fs.readFileSync(path.join(__dirname,'recovery-data/2026-11-05-authorized-007-1-GEDUdn/state.json'))),b=S.loadBundle(path.join(__dirname,'recovery-data/2026-11-02-national/plans-index.json'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mnoria-anchor-test-')),file=path.join(dir,'config.json');
 const good={runDir:dir,started:now,executionDeadline:Math.min(now+18*3600000,Date.parse(S.DEADLINE)),limits:P.LIMITS,manifestHash:S.MANIFEST_SHA256,initialCheckpoints:86,initialAcquired:8237,initialAnchors:previous.anchors,expectedNext:{group:'007',batchNumber:1,planHash:b.plans[6].plan.planHash},continueToEnd:true,stopOnAnyError:true,scope:{batches:199,promotions:19595}};
 const write=body=>fs.writeFileSync(file,JSON.stringify({...body,seal:W.hash(body)}));
 try{write(good);assert.equal(A.configAt(file).initialCheckpoints,86);
  for(const patch of [{initialAcquired:8238},{expectedNext:{...good.expectedNext,batchNumber:0}},{scope:{batches:199,promotions:19594}},{initialAnchors:previous.anchors.slice(1)}]){write({...good,...patch});assert.throws(()=>A.configAt(file));}
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('budget: plafond strict de 100 lots',()=>assert.throws(()=>P.guard({verified:Array.from({length:100},()=>({entries:1}))},config,1,now),{code:'AUTHORIZATION_LIMIT'}));
test('budget: plafond strict de 10000 promotions',()=>assert.throws(()=>P.guard({verified:[{entries:9950}]},config,100,now),{code:'AUTHORIZATION_LIMIT'}));
test('18 heures et échéance des plans : aucune prolongation',()=>{assert.throws(()=>P.guard({verified:[]},{executionDeadline:now},1,now),{code:'TIME_LIMIT'});assert.throws(()=>P.guard({verified:[]},config,1,Date.parse(S.DEADLINE)),{code:'TIME_LIMIT'});});
test('signal stop interdit le prochain lot',()=>assert.throws(()=>P.guard({verified:[],stopRequested:true},config,1,now),{code:'INTERRUPTED'}));
test('sélection: ignore les acquis et ne dépasse pas 100 lots/10000 entrées',()=>{const p={planHash:'p',batchSize:100,entries:Array.from({length:15000},(_,i)=>({id:i}))};const r=P.targets({plans:[{group:'007',plan:p,batches:150}]},new Map([['p:0','ok']]));assert.equal(r.length,100);assert.equal(r[0].batchNumber,1);assert.equal(r.reduce((n,t)=>n+t.entries,0),10000);});
test('sélection: conserve le dernier petit lot',()=>{const p={planHash:'p',batchSize:100,entries:Array.from({length:186},(_,i)=>({id:i}))};assert.deepEqual(P.targets({plans:[{group:'006',plan:p,batches:2}]},new Map()).map(t=>t.entries),[100,86]);});
function fake(failSql){return {query:async sql=>{if(sql===failSql)throw Object.assign(Error('simulated connection failure'),{code:'ECONNRESET'});return {rows:[]};},end:async()=>{}};}
test('erreur réseau AVANT COMMIT reste éligible aux retries existants',async()=>{const c=P.protectedClient(fake('UPDATE'),{});await c.query('begin');await assert.rejects(c.query('UPDATE'),e=>e.code==='ECONNRESET'&&S.transient(e));});
test('réponse COMMIT perdue : erreur NON retryable, jamais de replay automatique',async()=>{const ctx={},c=P.protectedClient(fake('commit'),ctx);await c.query('begin');await assert.rejects(c.query('commit'),e=>e.code==='COMMIT_UNCERTAIN'&&!S.transient(e));assert.equal(ctx.commitSent,true);});
test('erreur après COMMIT confirmé : NON retryable',async()=>{const c=P.protectedClient(fake('SELECT checkpoint'),{});await c.query('begin');await c.query('commit');await assert.rejects(c.query('SELECT checkpoint'),{code:'COMMIT_UNCERTAIN'});});
test('COMMIT de transaction read-only ne marque pas un COMMIT métier',async()=>{const ctx={},c=P.protectedClient(fake('SELECT'),ctx);await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query('COMMIT');assert(!ctx.commitSent);await assert.rejects(c.query('SELECT'),e=>e.code==='ECONNRESET');});
test('25P03 reste non retryable',async()=>{const c=P.protectedClient({query:async()=>{throw Object.assign(Error('idle timeout'),{code:'25P03'});},end:async()=>{}},{});await assert.rejects(c.query('SELECT'),e=>e.code==='25P03'&&!S.transient(e));});
