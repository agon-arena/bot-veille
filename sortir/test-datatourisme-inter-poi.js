"use strict";
const assert=require('assert/strict'),{compareActivities}=require('./activity-deduplication'),{harness,poi,NOW}=require('./test-datatourisme-poi-reconciliation'),P=require('./datatourisme-poi-state');
let passed=0,failed=0;async function test(name,fn){try{await fn();passed++;console.log('✓ '+name);}catch(e){failed++;console.error(name,e);}}
const description='Cette exposition présente une collection exceptionnelle de peintures et sculptures réalisées par des artistes internationaux dans les salles du musée municipal.';
function pair(){const a=poi('B',3001),b=poi('B',3002);a.label=b.label={'@fr':'Exposition des artistes indépendants'};a.hasDescription=b.hasDescription=[{description:{'@fr':description}}];for(const p of [a,b])p.isLocatedAt[0].address[0].streetAddress=['1 rue du Musée'];return [a,b];}
const activity=p=>P.calculatePoiState(p,{now:NOW}).results[0].activity;
(async()=>{
 await test('A deux UUID, identité forte exacte → MATCH',()=>{const [a,b]=pair();assert.equal(compareActivities(activity(a),activity(b)).decision,'MATCH');});
 await test('B deux UUID, horaires explicites différents → DISTINCT même avec URL commune',()=>{const [a,b]=pair();b.takesPlaceAt[0].startTime='14:00';b.takesPlaceAt[0].endTime='16:00';b.uri=a.uri;assert.equal(compareActivities(activity(a),activity(b)).decision,'DISTINCT');});
 await test('C même UUID, deux séances restent DISTINCT',()=>{const [a,b]=pair();b.uuid=a.uuid;b.takesPlaceAt[0].startTime='14:00';b.takesPlaceAt[0].endTime='16:00';assert.equal(compareActivities(activity(a),activity(b)).decision,'DISTINCT');});
 await test('D ambiguïtés/contradictions → REVIEW sans fusion',()=>{for(const mutate of [p=>p.hasDescription=[],p=>p.hasDescription=[{description:{'@fr':'Une compétition sportive rassemble les équipes locales pour un tournoi de football avec entraînements et remise des prix aux joueurs.'}}],p=>p.isLocatedAt[0].address[0].postalCode='99999',p=>p.isLocatedAt[0].geo.latitude=49]){const [a,b]=pair();mutate(b);assert.equal(compareActivities(activity(a),activity(b)).decision,'REVIEW');}});
 await test('E deux POI soutiennent une activité, retrait de l’un préserve l’autre',async()=>{const h=harness(),[a,b]=pair();await h.run([a,b]);const s=h.activityStore;assert.equal(s.activities.length,1);assert.equal(s.provenances.length,2);assert.equal(new Set(s.externalIds.filter(e=>e.system==='datatourisme-poi').map(e=>e.value)).size,2);a.takesPlaceAt=[{startDate:'2026-10-20',endDate:'2026-10-20',startTime:'10:00',endTime:'12:00'}];await h.run([a]);assert.equal(s.provenances.filter(p=>p.active).length,1);assert.equal(s.activities[0].record_status,'active');});
 await test('F rejeu deux UUID idempotent, provenance et IDs conservés',async()=>{const h=harness(),ps=pair();await h.run(ps);const s=h.activityStore,snapshot=JSON.stringify([s.activities,s.provenances,s.externalIds]);const r=await h.run(ps);assert.equal(r.unchanged.length,2);assert.equal(JSON.stringify([s.activities,s.provenances,s.externalIds]),snapshot);});
 await test('H même début mais fins différentes, ou date seule → jamais MATCH',()=>{const [a,b]=pair();b.takesPlaceAt[0].endTime='13:00';assert.equal(compareActivities(activity(a),activity(b)).decision,'DISTINCT');delete b.takesPlaceAt[0].startTime;assert.equal(compareActivities(activity(a),activity(b)).decision,'REVIEW');});
 await test('G deux fiches archivées : 30 sessions, 60 provenances, aucun doublon puis UNCHANGED',async()=>{
  const ps=require('./fixtures/datatourisme-inter-poi-archived.json'),h=harness(),now='2026-10-22T17:53:41.312Z';
  const left=P.calculatePoiState(ps[0],{now}),right=P.calculatePoiState(ps[1],{now});assert.equal(left.results.length,30);assert.equal(right.results.length,30);
  for(const item of right.results){const same=left.results.find(x=>x.activity.startsAt===item.activity.startsAt&&x.activity.endsAt===item.activity.endsAt);assert.ok(same);assert.equal(compareActivities(same.activity,item.activity).decision,'MATCH');}
  const r=await h.run(ps,now);assert.equal(r.committed.length,2);assert.equal(h.activityStore.activities.length,30);assert.equal(h.activityStore.provenances.filter(p=>p.active).length,60);
  const before=JSON.stringify([h.activityStore.activities,h.activityStore.provenances,h.activityStore.externalIds]);assert.equal((await h.run(ps,now)).unchanged.length,2);assert.equal(JSON.stringify([h.activityStore.activities,h.activityStore.provenances,h.activityStore.externalIds]),before);
 });
 await test('E disparition nationale confirmée d’un UUID : autre UUID actif, aucune stale',async()=>{
  const s=require('./test-datatourisme-national-scan').setup(),[a,b]=pair();
  await s.finalize((await s.scan([a,b])).scanId);const target=s.h.activityStore.provenances.find(p=>p.source_record_id.includes(a.uuid)).activity_id;
  const first=await s.finalize((await s.scan([b])).scanId);assert.equal(first.first_absences,1);assert.equal(first.deactivated,0);
  const second=await s.finalize((await s.scan([b])).scanId);assert.equal(second.confirmed_absences,1);assert.equal(second.deactivated,1);assert.equal(second.staled,0);
  const ps=s.h.activityStore.provenances.filter(p=>p.activity_id===target);assert.equal(ps.length,2);assert.equal(ps.filter(p=>p.active).length,1);assert.equal(s.h.activityStore.activities.find(a=>a.id===target).record_status,'active');
 });
 await test('identifiant/URL commun ne contourne pas titre/lieu/intervalle inter-POI',()=>{
  const [a,b]=pair();const left=activity(a),right=activity(b);right.title='Atelier de cuisine et dégustation';right.provenances[0].originalEventUrl=left.provenances[0].originalEventUrl;
  assert.equal(compareActivities(left,right).decision,'REVIEW');right.externalIds.push(left.externalIds.find(e=>e.system==='datatourisme-poi')?{system:'datatourisme-producer-id',value:'shared'}:null);left.externalIds.push({system:'datatourisme-producer-id',value:'shared'});assert.equal(compareActivities(left,right).decision,'REVIEW');
 });
 await test('timezone contradictoire : intervalle UTC identique ne suffit pas',()=>{const [a,b]=pair(),left=activity(a),right=activity(b);right.timezone='UTC';assert.equal(compareActivities(left,right).decision,'REVIEW');});
 await test('index candidats : REVIEW inter-POI conservé malgré ville contradictoire',()=>{
  const {TemporalCandidateIndex}=require('./temporal-candidate-cache'),{activityToRow}=require('./supabase-persistence'),[a,b]=pair(),left=activity(a),right=activity(b);right.city='Autre commune';const index=new TemporalCandidateIndex();index.set('a',{...activityToRow(left),id:'a',record_status:'active',external_ids:left.externalIds});assert.equal(compareActivities(left,right).decision,'REVIEW');assert.equal(index.matches(right).length,1);
 });
 await test('organisateur sans nom : absence de preuve, jamais contradiction inventée',()=>{const [a,b]=pair(),left=activity(a),right=activity(b);left.organizers=right.organizers=[{name:null,url:'https://museum.example'}];assert.equal(compareActivities(left,right).decision,'MATCH');right.organizers=[{name:'Organisateur distinct',url:'https://other.example'}];left.organizers=[{name:'Association musée',url:'https://museum.example'}];assert.equal(compareActivities(left,right).decision,'REVIEW');});

 await test('A/B identité certaine : organisateur présent ou sans nom ne crée pas de doublon',async()=>{
  for(const missing of [false,true]){const h=harness(),ps=pair();for(const p of ps)p.hasContact=[{legalName:missing?undefined:'Musée municipal',homepage:['https://museum.example']}];
   // Use normalized validation behavior through the real persistence pipeline.
   assert.equal(P.calculatePoiState(ps[1],{now:NOW}).results[0].validation.status,missing?'NEEDS_REVIEW':'VALID');await h.run(ps);assert.equal(h.activityStore.activities.length,1);assert.equal(h.activityStore.provenances.length,2);
  }
 });
 await test('C noms organisateurs contradictoires restent REVIEW et ne fusionnent pas',async()=>{
  const h=harness(),ps=pair();ps[0].hasContact=[{legalName:'Musée municipal',homepage:['https://museum.example']}];ps[1].hasContact=[{legalName:'Club sportif régional',homepage:['https://sport.example']}];
  assert.equal(compareActivities(activity(ps[0]),activity(ps[1])).decision,'REVIEW');await h.run(ps);assert.equal(h.activityStore.activities.length,2);
 });
 await test('D/E organisateur absent ne contourne ni horaires ni lieu contradictoire',async()=>{
  for(const change of [p=>{p.takesPlaceAt[0].startTime='14:00';p.takesPlaceAt[0].endTime='16:00'},p=>p.isLocatedAt[0].address[0].postalCode='99999']){const h=harness(),ps=pair();for(const p of ps)p.hasContact=[{homepage:['https://museum.example']}];change(ps[1]);assert.notEqual(compareActivities(activity(ps[0]),activity(ps[1])).decision,'MATCH');await h.run(ps);assert.equal(h.activityStore.activities.length,2);}
 });
 await test('F/I archive Anne de Bretagne : MATCH malgré warning, statut review et rejeu conservés',async()=>{
  const f=require('./fixtures/datatourisme-editorial-match-archived.json'),h=harness(),s=h.activityStore,c=structuredClone(f.candidate),now='2026-10-24T05:25:41.028Z';
  s.sources=[structuredClone(f.source)];s.provenances=c.provenances.map(p=>{const q={...p};delete q.source;return q;});s.externalIds=c.external_ids;delete c.provenances;delete c.external_ids;s.activities=[c];
  const calc=P.calculatePoiState(f.poi,{now});assert.deepEqual(calc.results[0].validation.warnings.map(w=>w.code),['organizer_name_missing']);assert.equal(calc.results[0].validation.status,'NEEDS_REVIEW');
  const R=require('./datatourisme-poi-reconciliation'),run=()=>R.processReceivedPoiBatch({pois:[f.poi],stateStore:h.stateStore,activityStore:s,sourceId:f.source.id,scanId:'88888888-2222-3333-4444-555555555555',now,persistOccurrences:R.createDatatourismePoiPersister({store:s,now})});
  const before=s.provenances.length,r=await run();assert.equal(r.committed.length,1);assert.equal(s.activities.length,1);assert.equal(s.provenances.length,before+1);assert.equal(s.provenances.at(-1).activity_id,c.id);assert.equal(s.activities[0].record_status,'review');assert.equal(s.items.at(-1).validation_status,'NEEDS_REVIEW');assert.deepEqual(s.items.at(-1).diagnostics.warnings.map(w=>w.code),['organizer_name_missing']);
  const snapshot=JSON.stringify([s.activities,s.provenances,s.externalIds]);assert.equal((await run()).unchanged.length,1);assert.equal(JSON.stringify([s.activities,s.provenances,s.externalIds]),snapshot);
 });
 await test('revue de confiance non éditoriale : MATCH reste bloqué',async()=>{
  const h=harness(),[a,b]=pair();await h.run([a]);const state=P.calculatePoiState(b,{now:NOW});state.results[0].activity.confidence=0.1;
  const R=require('./datatourisme-poi-reconciliation');await R.createDatatourismePoiPersister({store:h.activityStore,now:NOW})([state]);assert.equal(h.activityStore.activities.length,2);assert.equal(h.activityStore.activities[1].record_status,'review');
 });
 await test('C identité indépendante et URL organisme commune : noms différents, politique existante conservée',async()=>{
  const h=harness(),ps=pair();ps[0].hasContact=[{legalName:'Musée municipal',homepage:['https://museum.example']}];ps[1].hasContact=[{legalName:'Service des expositions',homepage:['https://museum.example']}];
  assert.equal(compareActivities(activity(ps[0]),activity(ps[1])).decision,'MATCH');await h.run(ps);assert.equal(h.activityStore.activities.length,1);assert.equal(h.activityStore.provenances.length,2);
 });
 await test('géographie A : identité exacte résout seulement la contradiction GPS, sans déplacement',()=>{
  const [a,b]=require('./fixtures/datatourisme-geographic-identity-archived.json'),left=activity(a),right=activity(b),D=require('./activity-deduplication');assert.equal(D.compareActivities(left,right).decision,'MATCH');assert.ok(D.compareActivities(left,right).signals.some(s=>s.type==='datatourisme_coordinate_conflict_exact_identity'));for(const delta of [0.002,0.02])assert.equal(D.compareActivities(left,{...right,latitude:left.latitude+delta,longitude:left.longitude}).decision,'MATCH');const merged=D.mergeActivities(left,right);assert.equal(merged.activity.latitude,left.latitude);assert.equal(merged.activity.longitude,left.longitude);assert.ok(merged.activity.evidence.some(e=>e.field==='latitude'));assert.ok(merged.activity.evidence.some(e=>e.field==='longitude'));
 });
 await test('géographie B/C : rue, commune, code postal, pays ou lieu distincts interdisent la résolution GPS',()=>{
  const ps=require('./fixtures/datatourisme-geographic-identity-archived.json'),left=activity(ps[0]);for(const patch of [{address:'Autre avenue'},{city:'Autre commune'},{postalCode:'99999'},{country:'BE'},{venueName:'Autre château'},{postalCode:null}]){const right={...activity(ps[1]),...patch};assert.notEqual(compareActivities(left,right).decision,'MATCH');}
 });
 await test('géographie : prose seulement similaire, sans contact commun ou fuseau différent restent REVIEW',()=>{
  const ps=require('./fixtures/datatourisme-geographic-identity-archived.json'),left=activity(ps[0]);for(const patch of [{description:activity(ps[1]).description+' Programme actualisé.'},{organizers:[]},{timezone:'UTC'}])assert.equal(compareActivities(left,{...activity(ps[1]),...patch}).decision,'REVIEW');
 });
 await test('géographie D : proximité GPS ne fusionne jamais deux horaires',()=>{
  const ps=require('./fixtures/datatourisme-geographic-identity-archived.json'),left=activity(ps[0]),right=activity(ps[1]);right.latitude=left.latitude;right.longitude=left.longitude;right.startsAt='2026-12-19T14:00:00Z';assert.equal(compareActivities(left,right).decision,'DISTINCT');
 });
 await test('géographie E/I : Noël archivé, deux sources une activité, GPS et rejeu conservés',async()=>{
  const ps=require('./fixtures/datatourisme-geographic-identity-archived.json'),h=harness(),now='2026-10-25T04:25:51.603Z';await h.run(ps,now);assert.equal(h.activityStore.activities.length,1);assert.equal(h.activityStore.provenances.filter(p=>p.active).length,2);assert.equal(h.activityStore.activities[0].latitude,ps[0].isLocatedAt[0].geo.latitude);const before=JSON.stringify([h.activityStore.activities,h.activityStore.provenances,h.activityStore.externalIds]);assert.equal((await h.run(ps,now)).unchanged.length,2);assert.equal(JSON.stringify([h.activityStore.activities,h.activityStore.provenances,h.activityStore.externalIds]),before);
 });
 await test('programme archivé : preuve de deux ateliers distincts, création et rejeu idempotents',async()=>{
  const ps=require('./fixtures/datatourisme-programme-visits-archived.json'),h=harness(),now='2026-10-25T09:56:37.240Z';
  const S=require('./datatourisme-activity-safety'),R=require('./datatourisme-poi-reconciliation');
  const run=()=>h.run(ps,now,R.createDatatourismePoiPersister({store:h.activityStore,now,beforeCreateActivity:S.guardExactSignatureReview}));
  assert.equal(compareActivities(P.calculatePoiState(ps[0],{now}).results[0].activity,P.calculatePoiState(ps[1],{now}).results[0].activity).decision,'DISTINCT');
  assert.equal((await run()).committed.length,2);assert.equal(h.activityStore.activities.length,2);assert.equal(h.activityStore.provenances.filter(p=>p.active).length,2);
  const rows=h.activityStore.activities.map(a=>({...a,external_ids:h.activityStore.externalIds.filter(e=>e.activity_id===a.id),provenances:h.activityStore.provenances.filter(p=>p.activity_id===a.id)}));
  assert.equal(S.auditActivitySafety(rows).ready,true);
  const before=JSON.stringify([h.activityStore.activities,h.activityStore.provenances,h.activityStore.externalIds]);assert.equal((await run()).unchanged.length,2);assert.equal(JSON.stringify([h.activityStore.activities,h.activityStore.provenances,h.activityStore.externalIds]),before);
  assert.equal(S.auditActivitySafety([...rows,{...rows[0],id:'ambiguous',description:'Programme sans atelier nommé'}]).ready,false);
  assert.equal(S.auditActivitySafety(rows.map((r,i)=>i?{...r,provenances:[]}:r)).ready,false);
 });
 await test('programme : règle générale, noms positivement distincts hors Lanvénégen',()=>{
  const ps=require('./fixtures/datatourisme-programme-visits-archived.json'),now='2026-10-25T09:56:37.240Z',as=ps.map(p=>P.calculatePoiState(p,{now}).results[0].activity);
  for(const a of as){a.city='Autre commune';a.title='Programme des visites locales';a.description=a.description.replaceAll('Lanvénégen','Autre commune');}
  as[0].description=as[0].description.replace('le meuble du photographe','les céramiques bleues');as[1].description=as[1].description.replace("l'En verre du Décor et l'instant de verre",'la forge artisanale');
  assert.equal(compareActivities(...as).decision,'DISTINCT');assert.equal(compareActivities(as[1],as[0]).decision,'DISTINCT');
 });
 await test('programme : descriptions différentes seules ou sujets ambigus restent REVIEW',()=>{
  const ps=require('./fixtures/datatourisme-programme-visits-archived.json'),now='2026-10-25T09:56:37.240Z',as=ps.map(p=>P.calculatePoiState(p,{now}).results[0].activity),D=require('./activity-deduplication');
  for(const patch of [{description:as[0].description},{description:'Une autre présentation du programme et de ses ateliers.'},{description:as[1].description.replace("l'En verre du Décor et l'instant de verre",'le meuble ancien')},{externalIds:as[1].externalIds.filter(e=>e.system!=='datatourisme-producer-id')}]){
   const right={...as[1],...patch};assert.equal(D.distinctNamedDatatourismeVisits(as[0],right),null);assert.equal(compareActivities(as[0],right).decision,'REVIEW');
  }
  const right=structuredClone(as[1]);right.externalIds.push(as[0].externalIds.find(e=>e.system==='datatourisme-producer-id'));assert.equal(D.distinctNamedDatatourismeVisits(as[0],right),null);
  const sharedUrl='https://example.org/one-specific-event';assert.equal(D.distinctNamedDatatourismeVisits({...as[0],provenances:[{original_event_url:sharedUrl}]},{...as[1],provenances:[{original_event_url:sharedUrl}]}),null);
 });
 console.log(`${passed} réussis, ${failed} échoués`);if(failed)process.exitCode=1;
})();
