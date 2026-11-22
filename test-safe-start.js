"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {getRuntimePolicy}=require('./runtime-policy');
const {fixtureRuntime}=require('./sortir/test-helpers/safe-start-runtime');
const SAFE={BOT_SAFE_START:'on',BOT_AUTO_PIPELINES:'on'};
function assertNoBusiness(h) {
  assert.deepEqual(h.businessCalls(),[],'no external requests, AI, SQL writes, uploads or collection');
  assert.deepEqual(h.fileWrites.filter(w=>!w.restore&&!w.operational),[],'no local business file writes');
}
test('central policy preserves old defaults, and safe mode wins over Render and forced on',()=>{
  for(const [env,expected]of [[{},false],[{RENDER:'true'},true],[{BOT_AUTO_PIPELINES:'on'},true],[{RENDER:'true',BOT_AUTO_PIPELINES:'off'},false]])
    assert.deepEqual(getRuntimePolicy(env),{safeStart:false,automaticPipelines:expected,sortirIngest:false});
  for(const value of ['on','1','true','unexpected-value'])assert.deepEqual(getRuntimePolicy({RENDER:'true',BOT_AUTO_PIPELINES:'on',BOT_SAFE_START:value}),{safeStart:true,automaticPipelines:false,sortirIngest:false});
  for(const value of ['', 'off','0','false'])assert.equal(getRuntimePolicy({RENDER:'true',BOT_SAFE_START:value}).automaticPipelines,true);
});
test('safe server boots with credentials and pending queues: no Storage restoration or jobs even after 48h',async()=>{
  const h=fixtureRuntime(SAFE);h.loadProcess('server.js');await h.settle();
  assert.equal(h.apps.length,1);assert.equal(h.apps[0].port,3000);
  assert(!h.calls.some(c=>c.kind.startsWith('storage-')),'safe startup must not contact Storage, even with configured credentials');
  assert.equal(h.timers.size,0);await h.advance(48*3600000);assert.equal(h.timers.size,0);assertNoBusiness(h);
  const ping=await h.request(h.apps[0],'GET','/ping');assert.equal(ping.payload.safeStart,true);assert.equal(ping.payload.automaticPipelines,false);
  const status=await h.request(h.apps[0],'GET','/api/sortir-ingest-status?current=1');
  assert.equal(status.statusCode,200);assert.equal(status.payload.kind,'sortir_scheduler_monitor');
  assert.equal(status.payload.blockers[0].id,'caa4ae36-7a50-464a-aaed-52b1f14523e7');assertNoBusiness(h);
});
test('safe worker boots with pending creative queue; no immediate retry, delayed AI or business writes',async()=>{
  const h=fixtureRuntime(SAFE);h.loadProcess('veille-mixte.js');await h.settle();
  assert.equal(h.apps[0].port,3002);assert.equal(h.timers.size,0);await h.advance(48*3600000);assertNoBusiness(h);
  const progress=await h.request(h.apps[0],'GET','/certamen/progress');assert.equal(progress.statusCode,200);assert(progress.payload);
});
test('all mutation routes are blocked before their handler, including GitHub ticks and worker calls',async()=>{
  const h=fixtureRuntime(SAFE);h.loadProcess('server.js');h.loadProcess('veille-mixte.js');await h.settle();let blocked=0;
  for(const app of h.apps)for(const route of app.routes)if(!['GET','HEAD','OPTIONS'].includes(route.method)&&route.route!=='/mixte-login'){
    const response=await h.request(app,route.method,route.route);assert.equal(response.statusCode,503,route.route);
    assert.equal(response.payload.code,'BOT_SAFE_START');blocked++;
  }
  assert(blocked>=40);assert.equal(h.timers.size,0);await h.advance(2*3600000);assertNoBusiness(h);
});
test('login and protected supervision remain accessible without admitting business POSTs',async()=>{
  const h=fixtureRuntime({...SAFE,MIXTE_PASSWORD:'offline-password'});h.loadProcess('server.js');await h.settle();
  const login=await h.request(h.apps[0],'POST','/mixte-login',{body:{password:'offline-password',redirect:'/api/sortir-ingest-status?current=1'}});
  assert.equal(login.statusCode,302);assert(login.headers['Set-Cookie']);
  const status=await h.request(h.apps[0],'GET','/api/sortir-ingest-status?current=1&token=offline-password');
  assert.equal(status.statusCode,200);assert.equal(status.payload.daily.successConfirmed,false);
  const tick=await h.request(h.apps[0],'POST','/api/sortir-ingest-tick?token=offline-password');assert.equal(tick.statusCode,503);
  assertNoBusiness(h);
});
test('storage defends indirect uploads too, even after a local file changes and 48 hours pass',async()=>{
  const h=fixtureRuntime(SAFE),server=h.loadProcess('server.js');await h.settle();
  const storage=server.load(require.resolve('./storage-sync'));
  h.files.set('saved-subjects.json','[{"changed":"fixture"}]');
  await storage.uploadAll();await storage.uploadFiles(['saved-subjects.json']);storage.startPeriodicSync();
  await h.advance(48*3600000);assert.equal(h.timers.size,0);assertNoBusiness(h);
});
test('launcher inherits safe flag in both children, keeps both HTTP services up and registers no jobs',async()=>{
  const h=fixtureRuntime(SAFE);h.loadProcess('start.js');await h.settle();
  assert.equal(h.children.length,2);assert(h.children.every(c=>c.env.BOT_SAFE_START==='on'));
  assert.deepEqual(h.apps.map(a=>a.port).sort(),[3000,3002]);assert.equal(h.timers.size,0);
  await h.advance(48*3600000);assertNoBusiness(h);
});
test('without safe flag: normal server still collects YouTube and registers scheduled/recovery jobs',async()=>{
  const h=fixtureRuntime();h.loadProcess('server.js');await h.settle();
  assert(h.calls.some(c=>c.kind==='youtube-collect'),'normal immediate collection preserved, fake SDK only');
  assert(h.timers.size>=5,'collect, delayed resume, pending ideas and storage still scheduled');
  const ping=await h.request(h.apps[0],'GET','/ping');assert.equal(ping.payload.safeStart,false);assert.equal(ping.payload.automaticPipelines,true);
});
test('legacy BOT_AUTO_PIPELINES=off alone remains passive on server but not a total startup fence',async()=>{
  const h=fixtureRuntime({BOT_AUTO_PIPELINES:'off'});h.loadProcess('server.js');h.loadProcess('veille-mixte.js');await h.settle();
  assert(!h.calls.some(c=>c.kind==='youtube-collect'));assert(h.timers.size>=2,'legacy worker creative retry and storage sync preserved');
});
test('historical seals and twelve plans remain intact',()=>{
  const S=require('./sortir/historical-recovery-supervisor');
  assert.equal(S.loadBundle(require.resolve('./sortir/recovery-data/2026-11-02-national/plans-index.json')).plans.length,12);
  assert.equal(require('./sortir/organizer-review-writer').codeHash(),'1b1feff8f66eb18f10176c9ce15b753a331672dfcc2a17fc647c429608452a74');
});

test('recycled worker inherits safe mode again and cannot schedule delayed creative writes',async()=>{
  const h=fixtureRuntime(SAFE);h.loadProcess('start.js');await h.settle();
  h.children[0].child.emit('exit',75,null);await h.settle();
  assert.equal(h.children.length,3);assert.equal(h.children[2].env.BOT_SAFE_START,'on');
  assert.equal(h.timers.size,0);await h.advance(48*3600000);assertNoBusiness(h);
});
test('normal mode preserves manual configuration routes',async()=>{
  const h=fixtureRuntime({BOT_AUTO_PIPELINES:'off'});h.loadProcess('server.js');await h.settle();
  const result=await h.request(h.apps[0],'POST','/api/auto-publish',{body:{enabled:false}});
  assert.equal(result.statusCode,200);assert.equal(JSON.parse(h.files.get('auto-publish-config.json')).enabled,false);
});


test('safe Storage stays disabled for explicit init/download calls with configured credentials',async()=>{
  const h=fixtureRuntime(SAFE),server=h.loadProcess('server.js');await h.settle();
  const storage=server.load(require.resolve('./storage-sync'));
  storage.init();await storage.downloadAll();await storage.uploadAll();
  await storage.uploadFiles(['saved-subjects.json']);storage.startPeriodicSync();
  await h.advance(48*3600000);
  assert(!h.calls.some(c=>c.kind.startsWith('storage-')));
  assert.equal(h.fileWrites.filter(w=>w.restore).length,0);
  assert.equal(h.timers.size,0);assertNoBusiness(h);
});

test('server supervision fails closed without dedicated credentials even when business keys exist',async()=>{
  const h=fixtureRuntime({...SAFE,SORTIR_MONITOR_SUPABASE_URL:'',SORTIR_MONITOR_PUBLISHABLE_KEY:'',SORTIR_MONITOR_ACCESS_TOKEN:''});
  h.loadProcess('server.js');await h.settle();
  const ping=await h.request(h.apps[0],'GET','/ping');assert.equal(ping.payload.supervisionConfigured,false);
  const status=await h.request(h.apps[0],'GET','/api/sortir-ingest-status?current=1');assert.equal(status.statusCode,503);
  assert.equal(h.calls.filter(c=>c.kind==='sql-read').length,0);assert(!h.calls.some(c=>c.kind.startsWith('storage-')));assertNoBusiness(h);
});
test('SORTIR-only flag: exact "on" inside safe mode only, fails closed otherwise',()=>{
  assert.equal(getRuntimePolicy({BOT_SAFE_START:'on',BOT_SORTIR_INGEST:'on'}).sortirIngest,true);
  assert.equal(getRuntimePolicy({BOT_SAFE_START:'on',BOT_SORTIR_INGEST:' ON '}).sortirIngest,true);
  for(const v of ['','off','1','true','yes','enabled'])assert.equal(getRuntimePolicy({BOT_SAFE_START:'on',BOT_SORTIR_INGEST:v}).sortirIngest,false,v);
  assert.equal(getRuntimePolicy({BOT_SORTIR_INGEST:'on',RENDER:'true'}).sortirIngest,false,'never outside safe mode');
  const p=getRuntimePolicy({BOT_SAFE_START:'on',BOT_SORTIR_INGEST:'on',RENDER:'true',BOT_AUTO_PIPELINES:'on'});
  assert.equal(p.safeStart,true);assert.equal(p.automaticPipelines,false,'SORTIR flag never re-enables other pipelines');
});
test('SORTIR-only mode: only the SORTIR tick crosses the fence; Storage, jobs and every other mutation stay blocked',async()=>{
  const h=fixtureRuntime({...SAFE,BOT_SORTIR_INGEST:'on'});h.loadProcess('server.js');h.loadProcess('veille-mixte.js');await h.settle();
  assert(!h.calls.some(c=>c.kind.startsWith('storage-')),'no Storage restoration');assert.equal(h.timers.size,0);
  await h.advance(48*3600000);assert.equal(h.timers.size,0);assertNoBusiness(h);
  const ping=await h.request(h.apps[0],'GET','/ping');
  assert.equal(ping.payload.safeStart,true);assert.equal(ping.payload.automaticPipelines,false);assert.equal(ping.payload.sortirIngest,true);
  let blocked=0;
  for(const app of h.apps)for(const route of app.routes)if(!['GET','HEAD','OPTIONS'].includes(route.method)&&!['/mixte-login','/api/sortir-ingest-tick'].includes(route.route)){
    const r=await h.request(app,route.method,route.route);assert.equal(r.statusCode,503,route.route);assert.equal(r.payload.code,'BOT_SAFE_START');blocked++;
  }
  assert(blocked>=40,'all other mutations still fenced');
  assertNoBusiness(h);
});
test('X-Bot-Token header authenticates machine reads without URL token or cookie; wrong values refused',async()=>{
  const h=fixtureRuntime({...SAFE,MIXTE_PASSWORD:'offline-password'});h.loadProcess('server.js');await h.settle();
  const ok=await h.request(h.apps[0],'GET','/api/sortir-ingest-status?current=1',{headers:{'X-Bot-Token':'offline-password'}});
  assert.equal(ok.statusCode,200);assert.equal(ok.headers['Set-Cookie'],undefined,'header auth issues no cookie');
  for(const bad of ['','offline-passwor','offline-password ','OFFLINE-PASSWORD','offline-password-extra']){
    const r=await h.request(h.apps[0],'GET','/api/sortir-ingest-status?current=1',{headers:{'X-Bot-Token':bad}});assert.equal(r.statusCode,401,JSON.stringify(bad));
  }
  const none=await h.request(h.apps[0],'GET','/api/sortir-ingest-status?current=1');assert.equal(none.statusCode,401);
  assertNoBusiness(h);
});
test('SORTIR tick route admitted past the fence only with the flag (handler reached, not 503)',async()=>{
  for(const [env,fenced] of [[SAFE,true],[{...SAFE,BOT_SORTIR_INGEST:'on'},false]]){
    const h=fixtureRuntime({...env,MIXTE_PASSWORD:'offline-password'});h.loadProcess('server.js');await h.settle();
    const r=await h.request(h.apps[0],'POST','/api/sortir-ingest-tick');
    if(fenced){assert.equal(r.statusCode,503);assert.equal(r.payload.code,'BOT_SAFE_START');}
    else assert.equal(r.statusCode,401,'fence passed, mixte auth still required');
  }
});
