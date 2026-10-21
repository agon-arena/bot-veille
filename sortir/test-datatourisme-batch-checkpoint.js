"use strict";
const assert = require('assert/strict');
const { runNationalScanBatched: run, nationalUrl } = require('./datatourisme-national-scan');
const sourceId = '11111111-2222-3333-4444-555555555555', scanId = '77777777-2222-3333-4444-555555555555', now = new Date('2026-10-21T08:00Z');
global.fetch = async () => { throw Error('Réseau interdit'); };
// Transactional reference for the SQL protocol, no Supabase client.
class Store {
 constructor(){ this.observed = new Set(); this.calls = []; }
 async beginBatchScan(s){ this.calls.push('begin'); this.c={id:s.scanId,started_at:s.now,initial_url:s.initialUrl,next_url:s.initialUrl,batch_size:s.checkpointSize,status:'running',pages:0,received:0,total:null,invalid:0,error_codes:{}}; }
 async resumeBatchScan(){this.calls.push('resume'); return structuredClone(this.c);}
 async observeBatch(s){
  this.calls.push('observe'); const c=this.c;
  assert.equal(c.status,'running'); assert.equal(c.next_url,s.url);
  if(c.pending){assert.deepEqual(c.pending,s);return;}
  assert.ok(s.ids.every(id=>!this.observed.has(id)));
  s.ids.forEach(id=>this.observed.add(id));c.pending=structuredClone(s);
 }
 async finishBatch(s){
  this.calls.push('finish');const c=this.c,p=c.pending;
  if(c.lastAck===s.url)return;
  assert.equal(p.url,s.url); c.pages+=p.pages;c.received+=p.ids.length;c.total=p.total;c.next_url=p.nextUrl;c.pending=null;c.lastAck=s.url;c.invalid+=s.invalid;
  for(const [key,n] of Object.entries(s.errorCodes))c.error_codes[key]=(c.error_codes[key]||0)+n;
  if(!c.next_url)c.status='complete';
 }
 finalize(){if(this.c.status!=='complete'||this.c.pending||this.c.received!==this.c.total)throw Error('incomplet');}
}
function fixture(total=2101){
 const store=new Store();let fetched=0,processed=0;
 const options={store,sourceId,scanId,now,fetchPage:async url=>{
  fetched++;const page=Number(new URL(url).searchParams.get('page')||1),from=(page-1)*100,next=new URL(url);next.searchParams.set('page',page+1);
  return {objects:Array.from({length:Math.min(100,total-from)},(_,i)=>({uuid:`aaaaaaaa-2222-3333-4444-${String(from+i).padStart(12,'0')}`})),meta:{total,next:from+100<total?next.toString():null}};
 },processPage:async pois=>{processed+=pois.length;return {classified:pois.map(p=>({uuid:p.uuid,classification:'UNCHANGED'})),errors:[],committed:[]};}};
 return {store,options,get fetched(){return fetched;},get processed(){return processed;}};
}
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('✓ '+name);}catch(e){failed++;console.error(name,e);}}
(async()=>{
 for(const size of [500,1000])await test(`61289 POI checkpoints ${size}`,async()=>{const f=fixture(61289);const r=await run({...f.options,checkpointSize:size});assert.equal(r.pages,613);assert.equal(r.received,61289);assert.equal(f.store.calls.length+1,size===1000?126:248);f.store.finalize();});
 await test('crash avant observation : maximum dix pages relues',async()=>{const f=fixture();const fetch=f.options.fetchPage;let n=0;await assert.rejects(run({...f.options,fetchPage:async u=>{if(++n===10)throw Error('API');return fetch(u);}}));assert.equal(f.store.observed.size,0);assert.throws(()=>f.store.finalize());await run({...f.options,resume:true});f.store.finalize();});
 await test('crash après observation : rejeu idempotent, instant original',async()=>{const f=fixture();await assert.rejects(run({...f.options,processPage:async()=>{throw Error('crash');}}));assert.equal(f.store.observed.size,1000);assert.equal(f.store.c.received,0);const r=await run({...f.options,resume:true,now:new Date('2026-10-22'),processPage:async(p,c)=>{assert.equal(+c.now,+now);return f.options.processPage(p,c);}});assert.equal(r.received,2101);assert.equal(f.store.observed.size,2101);});
 await test('échec après pipeline avant acquittement : au plus 1000 POI rejoués',async()=>{const f=fixture();const finish=f.store.finishBatch.bind(f.store);f.store.finishBatch=async()=>{throw Error('RPC');};await assert.rejects(run(f.options));assert.equal(f.processed,1000);f.store.finishBatch=finish;await run({...f.options,resume:true});assert.equal(f.processed,3101);f.store.finalize();});
 await test('réponse acquittement perdue : pas de double progression',async()=>{const f=fixture();const finish=f.store.finishBatch.bind(f.store);let fail=true;f.store.finishBatch=async s=>{await finish(s);if(fail){fail=false;throw Error('réponse perdue');}};await assert.rejects(run(f.options));await run({...f.options,resume:true});assert.equal(f.processed,2101);assert.equal(f.store.c.pages,22);});
 await test('lot rejoué différent : refus sécurisé',async()=>{const f=fixture();await assert.rejects(run({...f.options,processPage:async()=>{throw Error('crash');}}));const fetch=f.options.fetchPage;await assert.rejects(run({...f.options,resume:true,fetchPage:async u=>{const p=await fetch(u);p.objects.reverse();return p;}}));assert.throws(()=>f.store.finalize());});
 await test('interruption dix pages / finalisation non appelée / API page N',async()=>{const f=fixture();await assert.rejects(run({...f.options,maxPages:10}));assert.equal(f.store.c.received,1000);assert.equal(f.store.c.status,'running');assert.throws(()=>f.store.finalize());});
 await test('335 invalides observés et comptés, aucune empreinte créée',async()=>{const f=fixture(335);const r=await run({...f.options,processPage:async p=>({classified:[],errors:p.map(x=>({uuid:x.uuid,codes:['ends_before_start']})),committed:[]})});assert.equal(r.invalid,335);assert.equal(f.store.observed.size,335);assert.equal(f.store.c.error_codes.ends_before_start,335);});
 await test('persistance partielle : jamais complet',async()=>{const f=fixture(1);await assert.rejects(run({...f.options,processPage:async p=>({classified:p.map(x=>({uuid:x.uuid,classification:'CHANGED'})),errors:[],committed:[]})}));assert.throws(()=>f.store.finalize());});
 await test('adaptateur Supabase : quatre RPC POST batchées, aucun GET par POI',async()=>{
  const { createSupabaseNationalScanStore }=require('./datatourisme-national-scan');
  const calls=[]; const store=createSupabaseNationalScanStore({rpc:async(name,args)=>{calls.push({name,args});return {data:{},error:null};}});
  await store.beginBatchScan({sourceId,scanId,now:now.toISOString(),initialUrl:nationalUrl(now),checkpointSize:1000});
  await store.resumeBatchScan({sourceId,scanId});
  await store.observeBatch({sourceId,scanId,url:nationalUrl(now),nextUrl:null,total:1000,ids:Array(1000).fill(sourceId),pages:10,now:now.toISOString()});
  await store.finishBatch({sourceId,scanId,url:nationalUrl(now),invalid:335,errorCodes:{conversion_error:335}});
  assert.equal(calls.length,4);assert.equal(calls[2].args.p_uuids.length,1000);assert.equal(calls[2].args.p_pages,10);assert.equal(calls[3].args.p_invalid,335);
 });
 console.log(`${passed} réussis, ${failed} échoués`);if(failed)process.exitCode=1;
})();
