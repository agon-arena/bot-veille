"use strict";
// Offline only: caller explicitly supplies an existing scratch JSONL.
const fs = require('fs'), readline = require('readline'), assert = require('assert/strict');
const { calculatePoiStateBatch } = require('./datatourisme-poi-state');
const { persistSortirIngestion } = require('./supabase-persistence');
const { TemporalCandidateCache } = require('./temporal-candidate-cache');
const H = require('./candidate-memory-harness');
async function differential(file, limit=500){
 const a=H.store(),b=H.store(),cache=new TemporalCandidateCache();let pois=[],received=0,occurrences=0,invalid=0;
 global.fetch=async()=>{throw Error('Réseau interdit');};
 async function flush(){
  const r=calculatePoiStateBatch(pois,{now:new Date('2026-10-21T10:00Z')});invalid+=r.errors.length;
  const results=r.states.flatMap(s=>s.results);occurrences+=results.length;
  for(const [store,candidateCache] of [[a,undefined],[b,cache]]){
   const out=await persistSortirIngestion({store,candidateCache,sources:[H.descriptor(structuredClone(results))],now:H.NOW,reconcileDisappearances:false});
   assert.equal(out.status,'completed');assert.equal(out.stats.INVALID,0);
  }
  assert.deepEqual(H.businessSnapshot(a),H.businessSnapshot(b));pois=[];
 }
 for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){
  if(!line.trim())continue;pois.push(JSON.parse(line));received++;
  if(pois.length===100)await flush();if(received>=limit)break;
 }
 if(pois.length)await flush();return {received,occurrences,invalid,identical:true,old:a.metrics,new:b.metrics};
}
if(require.main===module)differential(process.argv[2],Number(process.argv[3]||500)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={differential};
