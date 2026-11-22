'use strict';
// Offline only. Disposable signing key, synthetic password/JWT and injected HTTP.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createTokenProvider}=require('./monitor-token-provider');
const {createMonitorReadClient,monitoringConfigured}=require('./monitor-read-client');
const {createCycleStatusHandler}=require('./scheduler-cycle-status');
const ORIGIN='https://reader.invalid',ID='11111111-2222-4333-8444-111111111111',NOW=Date.parse('2026-11-22T04:00:00Z');
const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk={...keys.publicKey.export({format:'jwk'}),kid:'offline',alg:'ES256',use:'sig'};
const config={url:ORIGIN,key:'sb_publishable_offline',email:'offline@example.invalid',password:'offline-password-never-production',userId:ID};
const env=()=>({SORTIR_MONITOR_SUPABASE_URL:ORIGIN,SORTIR_MONITOR_PUBLISHABLE_KEY:config.key,SORTIR_MONITOR_AUTH_EMAIL:config.email,SORTIR_MONITOR_AUTH_PASSWORD:config.password,SORTIR_MONITOR_AUTH_USER_ID:ID});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function fixture(mode='ok') {
 let time=NOW;const calls=[];
 function sign(){const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const text=enc({alg:'ES256',kid:'offline'})+'.'+enc({role:mode==='role'?'service_role':'sortir_monitor_reader',iss:ORIGIN+'/auth/v1',aud:'authenticated',sub:mode==='identity'?'other-user':ID,session_id:ID,iat:time/1000,exp:time/1000+(mode==='expired'?-1:3600)});let signature=crypto.sign('sha256',Buffer.from(text),{key:keys.privateKey,dsaEncoding:'ieee-p1363'});if(mode==='signature')signature=Buffer.alloc(64);return text+'.'+signature.toString('base64url');}
 const request=async(raw,o)=>{
  const path=new URL(raw).pathname+new URL(raw).search;calls.push({path,method:o.method});assert.equal(o.redirect,'error');assert(o.signal);assert.equal(o.headers.apikey||o.headers.get?.('apikey'),config.key);
  if(path.endsWith('jwks.json')){if(mode==='network')throw Error(config.password);return json({keys:[jwk]});}
  if(path.includes('/token?')){assert.deepEqual(JSON.parse(o.body),{email:config.email,password:config.password});if(mode==='login')return json({message:config.password},400);return json({access_token:sign(),refresh_token:'synthetic-unused-refresh'});}
  if(path.includes('/logout?')){if(mode==='logout-network')throw Error(config.password);return mode==='logout'?json({},500):new Response(null,{status:204});}
  if(path==='/auth/v1/user')return json({error_code:mode==='personal'?'bad_jwt':'session_not_found'},403);
  if(path.startsWith('/rest/v1/'))return json(mode==='forbidden'?{message:config.password,code:'42501'}:[],mode==='forbidden'?403:200);
  throw Error('Unexpected endpoint');
 };
 return {request,calls,now:()=>time,advance:ms=>{time+=ms;}};
}
test('renewal closes session before exposing verified ES256 token; no refresh or timers',async()=>{
 const f=fixture(),p=createTokenProvider({config,...f});assert.equal(f.calls.length,0);const tokens=await Promise.all(Array.from({length:12},()=>p.getToken()));assert(tokens.every(t=>t===tokens[0]));assert.deepEqual(f.calls.map(c=>c.path),['/auth/v1/.well-known/jwks.json','/auth/v1/token?grant_type=password','/auth/v1/logout?scope=local','/auth/v1/user']);assert.equal(await p.getToken(),tokens[0]);assert.equal(f.calls.length,4);
 f.advance(3300001);await p.getToken();assert.equal(f.calls.length,8);f.advance(3600001);await p.getToken();assert.equal(f.calls.length,12);
});
for(const mode of ['network','login','logout','logout-network','personal','signature','role','identity','expired'])test('fail closed and sanitized: '+mode,async()=>{
 const f=fixture(mode),p=createTokenProvider({config,...f});await assert.rejects(p.getToken(),e=>e.message==='Authentification de supervision indisponible');const n=f.calls.length;await assert.rejects(p.getToken());assert.equal(f.calls.length,n);assert(!f.calls.some(c=>c.path.startsWith('/rest/')));
 if(['signature','role','identity','expired'].includes(mode))assert(f.calls.some(c=>c.path.includes('/logout?')));
});
test('failed proactive renewal discards old still-valid token; next demand retries only after cooldown',async()=>{
 const f=fixture();let fail=false;const request=(...args)=>fail?Promise.reject(Error(config.password)):f.request(...args);const p=createTokenProvider({config,...f,request});await p.getToken();f.advance(3300001);fail=true;await assert.rejects(p.getToken());await assert.rejects(p.getToken());fail=false;f.advance(30001);await p.getToken();assert.equal(f.calls.filter(x=>x.path.includes('/token?')).length,2);
});
test('SDK clients created per route share one renewal and never read business credentials',async()=>{
 const base=env(),f=fixture();const protectedEnv=new Proxy(base,{get(o,k){if(!k.startsWith('SORTIR_MONITOR_'))throw Error('Business key accessed');return o[k];}});
 assert.equal(monitoringConfigured(protectedEnv),true);assert.equal(f.calls.length,0);
 for(let n=0;n<2;n++){const client=createMonitorReadClient({env:protectedEnv,...f});const r=await client.from('sortir_source_runs').select('id,started_at,status').limit(1);assert.equal(r.error,null);}
 assert.equal(f.calls.filter(c=>c.path.includes('/token?')).length,1);assert.equal(f.calls.filter(c=>c.path.startsWith('/rest/')).length,2);
});
test('PostgREST refusal clears cached JWT and returns generic 503, no retry/fallback',async()=>{
 const f=fixture('forbidden'),client=createMonitorReadClient({env:env(),...f});let status,body;const res={set(){},status(s){status=s;return this;},json(b){body=b;}};
 await createCycleStatusHandler(()=>client,{getExpectedSources:()=>['offline'],now:()=>new Date(NOW)})({query:{current:'1'}},res);
 assert.equal(status,503);assert(!JSON.stringify(body).includes(config.password));const n=f.calls.length;const result=await client.from('sortir_source_runs').select('id');assert(result.error);assert.equal(f.calls.length,n);
});
test('configuration missing auth credential fails closed before HTTP',()=>{const e=env();delete e.SORTIR_MONITOR_AUTH_PASSWORD;assert.equal(monitoringConfigured(e),false);assert.throws(()=>createMonitorReadClient({env:e}),/Configuration/);});
test('uncertain logout/session verification blocks further signins for the lifetime of the provider',async()=>{
 for(const mode of ['logout','logout-network','personal']){const f=fixture(mode),p=createTokenProvider({config,...f});await assert.rejects(p.getToken());const n=f.calls.length;p.invalidate();f.advance(24*3600000);await assert.rejects(p.getToken());assert.equal(f.calls.length,n);}
});
test('Auth renewal is lazy: client construction and health configuration check make no network call',()=>{
 const f=fixture();const e=env();assert(monitoringConfigured(e));createMonitorReadClient({env:e,...f});assert.deepEqual(f.calls,[]);
});
test('network timeout and Auth 401 never leak password/token and never reach PostgREST',async()=>{
 for(const code of ['timeout',401]){const f=fixture();const request=async(url,o)=>{
  if(new URL(url).pathname.endsWith('/token')){if(code==='timeout')throw new DOMException(config.password,'AbortError');return json({message:config.password},401);}
  return f.request(url,o);
 };const p=createTokenProvider({config,...f,request});await assert.rejects(p.getToken(),e=>e.message==='Authentification de supervision indisponible');assert(!f.calls.some(c=>c.path.startsWith('/rest/')));}
});
test('existing protected status handler integrates Auth renewal and all four restricted reads',async()=>{
 const f=fixture(),{LOCK_ID,LOCK_VERSION}=require('./scheduler-state');
 const request=async(raw,o)=>{
  const u=new URL(raw);if(!u.pathname.startsWith('/rest/'))return f.request(raw,o);
  assert.equal(o.method,'GET');assert(o.headers.get('Authorization').startsWith('Bearer '));
  f.calls.push({path:u.pathname,method:o.method});
  const data=u.searchParams.has('id')?[{id:LOCK_ID,orchestrator_version:LOCK_VERSION,status:'completed',started_at:new Date(NOW-60000).toISOString()}]:[];
  return json(data);
 };
 const client=createMonitorReadClient({env:env(),...f,request});let code=200,body;
 const res={set(){},status(s){code=s;return this;},json(value){body=value;return this;}};
 await createCycleStatusHandler(()=>client,{getExpectedSources:()=>['offline'],now:()=>new Date(NOW)})({query:{current:'1'}},res);
 assert.equal(code,200);assert.equal(body.kind,'sortir_scheduler_monitor');assert.equal(body.lock.status,'completed');
 assert.equal(f.calls.filter(c=>c.path.includes('/token?')).length,1);assert.equal(f.calls.filter(c=>c.path.startsWith('/rest/')).length,4);
 assert(!JSON.stringify(body).includes(config.password));assert(!JSON.stringify(body).includes('Bearer'));
});
