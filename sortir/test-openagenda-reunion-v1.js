"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("path"), fs = require("fs");
const fixture = require("./fixtures/openagenda-reunion-v1-archived.json");
const { convertOpenAgendaJsonEvent } = require("./connectors/openagenda-json");
const { PRODUCERS, prepareItemForV1 } = require("./openagenda-reunion-v1");
const { MemoryStore } = require("./test-helpers/memory-store");
const { createOpenAgendaBatchPersister } = require("./openagenda-batch-persister");
const { persistSortirIngestion } = require("./supabase-persistence");
const { compareActivities } = require("./activity-deduplication");
const now = new Date(fixture.asOf);
function converted(group, event) { return convertOpenAgendaJsonEvent(event, { now, fetchedAt: fixture.asOf, sourceName: String(group.uid), agendaUid: group.uid, sourceUrl: `https://api.openagenda.com/v2/agendas/${group.uid}/events` }); }
async function run() {
  const db = new MemoryStore(), persist = createOpenAgendaBatchPersister({ store: db, now });
  const sources = fixture.producers.map(g => ({ key: "openagenda-"+g.uid, baseUrl: `https://api.openagenda.com/v2/agendas/${g.uid}/events`,
    results: g.events.flatMap(e => converted(g,e)).map(prepareItemForV1).filter(Boolean) }));
  for (const source of sources) await persist(source);
  return { db, persist, sources };
}
test("corpus réel : cinq producteurs, six candidats, 227 actives et 309 en revue", async () => {
  assert.deepEqual(fixture.producers.map(g => g.uid), PRODUCERS.map(p => p.agendaUid));
  assert.equal(fixture.producers.reduce((n,g) => n+g.events.length,0),12);
  const {db,persist,sources}=await run();
  assert.equal(new Set(sources.flatMap(s=>s.results).map(r=>r.sourcePayload.eventUid)).size,6);
  assert.equal(db.activities.length,536);
  assert.equal(db.activities.filter(a=>a.record_status==="active").length,227);
  assert.equal(db.activities.filter(a=>a.record_status==="review").length,309);
  assert.equal(db.provenances.length,536);
  const before={activities:db.activities.length,provenances:db.provenances.length,ids:db.externalIds.length,payloadWrites:db.payloadWrites};
  for(const source of sources)await persist(source);
  assert.deepEqual({activities:db.activities.length,provenances:db.provenances.length,ids:db.externalIds.length,payloadWrites:db.payloadWrites},before);
  assert.equal(persist.stats.requests["1_activities"],10);
  persist.purgeCandidateCache();
  assert.equal(persist.candidateCache.rows.size,0);
});
test("cinq relais réels : MATCH puis persistance et replay sans duplication", async () => {
  for(const pair of fixture.relayPairs){
    const results=pair.map(p=>converted({uid:p.agendaUid},p.event));
    const first=results[0].find(a=>results[1].some(b=>a.activity.startsAt===b.activity.startsAt));
    const second=results[1].find(b=>first.activity.startsAt===b.activity.startsAt);
    assert.equal(compareActivities(first.activity,second.activity).decision,"MATCH");
    const db=new MemoryStore();
    const sources=results.map((rows,i)=>({key:"relay-"+i,connectorType:"openagenda_json",baseUrl:`https://api.openagenda.com/v2/agendas/${pair[i].agendaUid}/events`,results:rows}));
    for(let i=0;i<2;i++)await persistSortirIngestion({store:db,sources,now,reconcileDisappearances:false});
    assert.equal(db.activities.length,new Set(results.flat().map(r=>r.activity.startsAt)).size);
    assert.equal(db.provenances.length,results.flat().length);
  }
});
const appRoot=process.env.MNORIA_APP_ROOT||path.resolve(__dirname,"../../SUPABASE copie 3");
const explorerAvailable=fs.existsSync(path.join(appRoot,"lib/explorer.js"));
test("vrai Explorer : quatre cartes ; 250 créneaux futurs donnent une carte, deux phases en donnent deux", {skip:!explorerAvailable}, async()=>{
  const {createExplorerCache}=require(path.join(appRoot,"lib/explorer"));
  const {makeFakeExplorerSupabase}=require(path.join(appRoot,"test/helpers/fake-explorer-supabase"));
  const {db}=await run();
  const rows=db.activities.map(a=>({...a,provenances:db.provenances.filter(p=>p.activity_id===a.id)}));
  const get=async list=>await createExplorerCache(makeFakeExplorerSupabase(list),{now:()=>+now})({departmentCode:"974",city:null},false,null);
  const page=await get(rows);
  assert.equal(page.activities.length,4);
  assert.equal(new Set(page.activities.map(a=>a.title)).size,4);
  const specimen=rows.find(a=>a.record_status==="active");
  const series=Array.from({length:250},(_,i)=>({...specimen,id:"long-"+i,starts_at:new Date(+now+(i+1)*86400000).toISOString(),ends_at:new Date(+now+(i+1)*86400000+3600000).toISOString()}));
  assert.equal((await get(series)).activities.length,1);
  series.push({...specimen,id:"ongoing",starts_at:new Date(+now-3600000).toISOString(),ends_at:new Date(+now+3600000).toISOString()});
  assert.equal((await get(series)).activities.length,2);
});
