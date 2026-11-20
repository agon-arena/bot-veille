'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createMonitorReadClient,monitoringConfigured}=require('./monitor-read-client');
const {readSchedulerStatus}=require('./scheduler-cycle-status');
const NOW=Date.parse('2026-11-20T12:00:00Z');
const jwt=claims=>[Buffer.from(JSON.stringify({alg:'HS256'})).toString('base64url'),Buffer.from(JSON.stringify({role:'sortir_monitor_reader',iss:'https://reader.invalid/auth/v1',exp:NOW/1000+3600,...claims})).toString('base64url'),'offline'].join('.');
const config=()=>({SORTIR_MONITOR_SUPABASE_URL:'https://reader.invalid',SORTIR_MONITOR_PUBLISHABLE_KEY:'sb_publishable_offline',SORTIR_MONITOR_ACCESS_TOKEN:jwt(),SUPABASE_URL:'https://business.invalid',SUPABASE_SECRET_KEY:'business-key-never-used'});
test('missing reader credentials never fall back to business keys',()=>{
 let constructions=0;assert.throws(()=>createMonitorReadClient({env:{SUPABASE_URL:'https://business.invalid',SUPABASE_SECRET_KEY:'business-key'},createClient(){constructions++;}}));assert.equal(constructions,0);assert.equal(monitoringConfigured({}),false);
});
test('reader rejects privileged roles, invalid JWTs, expired tokens and unsafe endpoints without leaking secrets',()=>{
 for(const change of [{SORTIR_MONITOR_ACCESS_TOKEN:jwt({role:'service_role'})},{SORTIR_MONITOR_ACCESS_TOKEN:jwt({role:'authenticated'})},{SORTIR_MONITOR_ACCESS_TOKEN:jwt({exp:NOW/1000})},{SORTIR_MONITOR_ACCESS_TOKEN:jwt({nbf:NOW/1000+1})},{SORTIR_MONITOR_ACCESS_TOKEN:jwt({iss:'https://business.invalid/auth/v1'})},{SORTIR_MONITOR_ACCESS_TOKEN:'secret-not-jwt'},{SORTIR_MONITOR_PUBLISHABLE_KEY:'sb_secret_privileged'},{SORTIR_MONITOR_SUPABASE_URL:'http://reader.invalid'},{SORTIR_MONITOR_SUPABASE_URL:'https://user:password@reader.invalid'}]){
  let calls=0;assert.throws(()=>createMonitorReadClient({env:{...config(),...change},now:()=>NOW,createClient(){calls++;}}),e=>!e.message.includes('business-key')&&!e.message.includes('secret-not-jwt')&&!e.message.includes('password'));assert.equal(calls,0);
 }
});
test('actual SDK uses only the dedicated reader headers, with no auth refresh and bounded GET',async()=>{
 const env=config(),calls=[];const reader=createMonitorReadClient({env,now:()=>NOW,request:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify([{id:'fixture'}]),{status:200,headers:{'Content-Type':'application/json'}});}});
 const result=await reader.from('sortir_ingestion_runs').select('id,status').eq('status','running').limit(1);
 assert.equal(result.data[0].id,'fixture');assert.equal(calls.length,1);const {url,options}=calls[0];assert(url.startsWith('https://reader.invalid/rest/v1/sortir_ingestion_runs?'));assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.get('apikey'),env.SORTIR_MONITOR_PUBLISHABLE_KEY);assert.equal(options.headers.get('Authorization'),'Bearer '+env.SORTIR_MONITOR_ACCESS_TOKEN);assert(options.signal);assert(!JSON.stringify(calls).includes('business.invalid'));assert(!JSON.stringify(calls).includes(env.SUPABASE_SECRET_KEY));
});
test('reader exposes neither writes, extra columns, other tables nor RPC/Storage',async()=>{
 let calls=0;const reader=createMonitorReadClient({env:config(),now:()=>NOW,request:async()=>{calls++;throw Error('network must remain unused');}});
 for(const table of ['sortir_activities','sortir_sources','sortir_organizer_recovery_batches','__proto__'])assert.throws(()=>reader.from(table));
 const table=reader.from('sortir_ingestion_runs');for(const m of ['insert','update','upsert','delete'])assert.equal(table[m],undefined);
 for(const columns of ['*','id,provenances(*)','collected_count'])assert.throws(()=>table.select(columns));
 const query=table.select('id');for(const m of ['insert','update','upsert','delete','rpc','select','setHeader'])assert.throws(()=>query[m]);
 assert.throws(()=>query.eq('collected_count',1));assert.throws(()=>query.limit(1000));assert.equal(reader.rpc,undefined);assert.equal(reader.storage,undefined);assert.equal(calls,0);
});
test('transport blocks mutations, RPC, auth, Storage, redirects and other projects before network',async()=>{
 let options,calls=0;createMonitorReadClient({env:config(),now:()=>NOW,createClient:(url,key,o)=>{options=o;return{};},request:async()=>{calls++;return new Response('[]');}});
 for(const method of ['POST','PATCH','DELETE','PUT'])await assert.rejects(options.global.fetch('https://reader.invalid/rest/v1/sortir_ingestion_runs',{method}));
 for(const url of ['https://business.invalid/rest/v1/sortir_ingestion_runs','https://reader.invalid/storage/v1/object/json-data','https://reader.invalid/rest/v1/rpc/do_write','https://reader.invalid/auth/v1/token','https://reader.invalid/rest/v1/sortir_activities'])await assert.rejects(options.global.fetch(url));
 await assert.rejects(options.global.fetch('https://reader.invalid/rest/v1/sortir_ingestion_runs',{headers:{'Accept-Profile':'storage'}}));assert.equal(calls,0);assert.equal(options.auth.persistSession,false);assert.equal(options.auth.autoRefreshToken,false);
});
test('token expiry after client creation stops subsequent reads without external calls',async()=>{
 let now=NOW,calls=0;const reader=createMonitorReadClient({env:config(),now:()=>now,request:async()=>{calls++;return new Response('[]',{headers:{'Content-Type':'application/json'}});}});now+=3600001;
 const result=await reader.from('sortir_source_runs').select('id');assert(result.error);assert.equal(calls,0);
});
test('existing scheduler projection works through the actual restricted SDK without writes',async()=>{
 const calls=[];const reader=createMonitorReadClient({env:config(),now:()=>NOW,request:async(raw,options)=>{
  const u=new URL(raw);calls.push({url:u,method:options.method});let data=[];
  if(u.searchParams.get('id')?.startsWith('eq.'))data={id:'be127190-19a4-4f50-b615-7a9a78b8ff14',orchestrator_version:'sortir-scheduler-lock-v1',status:'completed',started_at:'2026-11-20T09:53:32.555Z'};
  else if(u.searchParams.get('status')==='eq.running'&&u.pathname.endsWith('sortir_ingestion_runs'))data=[{id:'abandoned-fixture',orchestrator_version:'sortir-ingestion-v1',status:'running',started_at:'2026-11-10T10:05:19.738Z'}];
  return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
 }});
 const status=await readSchedulerStatus(reader,['fixture-source'],new Date(NOW));assert.equal(status.lock.status,'completed');assert.equal(status.blockers[0].id,'abandoned-fixture');assert.equal(status.daily.successConfirmed,false);assert.equal(calls.length,4);assert(calls.every(c=>c.method==='GET'));
});
