"use strict";
const assert=require('assert/strict'),{harness,poi,NOW}=require('./test-datatourisme-poi-reconciliation'),R=require('./datatourisme-poi-reconciliation'),{guardExactSignatureReview,auditActivitySafety}=require('./datatourisme-activity-safety');
let passed=0,failed=0;async function test(name,fn){try{await fn();passed++;console.log('✓ '+name);}catch(e){failed++;console.error(name,e);}}
function twins(){const a=poi('B',1),b=poi('B',2);b.label=a.label;return [a,b];}
(async()=>{
 await test('conflit exact non documenté (candidat sans décision REVIEW) refusé avant INSERT : aucune activité/provenance ajoutée',async()=>{
  const h=harness(),[a,b]=twins();await h.run([a]);const count=h.activityStore.activities.length,prov=h.activityStore.provenances.length;
  // The colliding candidate would get no pending decision (here: DISTINCT without named-visit proof).
  const guard=args=>guardExactSignatureReview({...args,decision:'REVIEW',comparisons:args.comparisons.map(c=>({...c,result:{...c.result,decision:'DISTINCT'}}))});
  const result=await h.run([b],NOW,R.createDatatourismePoiPersister({store:h.activityStore,now:NOW,beforeCreateActivity:guard}));assert.equal(result.committed.length,0);assert.equal(result.toPersist.length,1);
  assert.equal(h.activityStore.activities.length,count);assert.equal(h.activityStore.provenances.length,prov);assert.ok(!h.stateStore.rows.has(b.uuid)||!h.stateStore.rows.get(b.uuid).fingerprint);
 });
 await test('conflit REVIEW exact documenté : quarantaine créée au lieu de bloquer',async()=>{
  const h=harness(),[a,b]=twins();await h.run([a]);
  const result=await h.run([b],NOW,R.createDatatourismePoiPersister({store:h.activityStore,now:NOW,beforeCreateActivity:guardExactSignatureReview}));assert.equal(result.committed.length,1);
  assert.equal(h.activityStore.activities.filter(x=>x.record_status==='review').length,1);assert.equal(h.activityStore.decisions.filter(d=>d.review_status==='pending').length,1);
 });
 await test('REVIEW normal reste possible, activé seulement après provenance ; rejeu idempotent',async()=>{
  const h=harness(),[a,b]=twins(),s=h.activityStore;await h.run([a]);const create=s.createActivity.bind(s);s.createActivity=async row=>{assert.equal(row.record_status,'stale');return create(row);};
  await h.run([b]);const review=s.activities.find(a=>a.record_status==='review');assert.ok(review);assert.ok(s.provenances.some(p=>p.activity_id===review.id&&p.active));
  const snapshot=JSON.stringify([s.activities,s.provenances,s.externalIds]);assert.equal((await h.run([b])).unchanged.length,1);assert.equal(JSON.stringify([s.activities,s.provenances,s.externalIds]),snapshot);
 });
 await test('réponse INSERT perdue après mutation : staging non fonctionnel même si cleanup échoue',async()=>{
  const h=harness(),[a,b]=twins();await h.run([a]);const s=h.activityStore,create=s.createActivity.bind(s);s.createActivity=async row=>{await create(row);throw Error('réponse perdue');};s.updateActivity=async()=>{throw Error('réseau');};
  const result=await h.run([b]);assert.equal(result.committed.length,0);assert.equal(result.toPersist.length,1);const orphan=s.activities.filter(a=>!s.provenances.some(p=>p.activity_id===a.id));assert.equal(orphan.length,1);assert.equal(orphan[0].record_status,'stale');
 });
 await test('échec provenance après REVIEW : aucune review sans soutien',async()=>{
  const h=harness(),[a,b]=twins();await h.run([a]);h.activityStore.createProvenanceIdempotent=async()=>{throw Error('échec provenance');};const result=await h.run([b]);assert.equal(result.committed.length,0);assert.equal(result.toPersist.length,1);assert.ok(!h.activityStore.activities.some(a=>a.record_status==='review'&&!h.activityStore.provenances.some(p=>p.activity_id===a.id&&p.active)));
 });
 await test('MATCH connu et DISTINCT autre séance non régressés',async()=>{
  const h=harness();await h.run([poi('B')]);await h.run([poi('BC')]);assert.equal(h.activityStore.activities.length,2);assert.equal(h.activityStore.provenances.length,2);assert.equal((await h.run([poi('BC')])).unchanged.length,1);
 });
 await test('précontrôle : orpheline fonctionnelle et groupe interrompu bloquent',()=>{
  const a={id:'a',title:'Titre',city:'Paris',starts_at:'2026-11-01T10:00Z',ends_at:'2026-11-01T12:00Z',record_status:'active',provenances:[{active:true}]},b={...a,id:'b',record_status:'review',provenances:[]};
  const r=auditActivitySafety([a,b]);assert.deepEqual(r.issues.map(x=>x.code),['activity_without_active_provenance','interrupted_duplicate_signature']);
  assert.equal(auditActivitySafety([a,{...b,record_status:'stale'}]).ready,true);
 });
 await test('précontrôle : autre source active protège, doublon soutenu reste à examiner',()=>{
  const a={id:'a',title:'Titre',city:'Paris',starts_at:'2026-11-01T10:00Z',record_status:'review',provenances:[{source_id:'other',active:true}]};assert.equal(auditActivitySafety([a]).ready,true);assert.equal(auditActivitySafety([a,{...a,id:'b'}]).issues[0].code,'duplicate_signature_requires_review');
 });
 console.log(`${passed} réussis, ${failed} échoués`);if(failed)process.exitCode=1;
})();
