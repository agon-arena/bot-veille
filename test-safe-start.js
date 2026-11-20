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
    assert.deepEqual(getRuntimePolicy(env),{safeStart:false,automaticPipelines:expected});
  for(const value of ['on','1','true','unexpected-value'])assert.deepEqual(getRuntimePolicy({RENDER:'true',BOT_AUTO_PIPELINES:'on',BOT_SAFE_START:value}),{safeStart:true,automaticPipelines:false});
  for(const value of ['', 'off','0','false'])assert.equal(getRuntimePolicy({RENDER:'true',BOT_SAFE_START:value}).automaticPipelines,true);
});
test('safe server boots with active configs and pending queues: reads restored, no jobs even after 48h',async()=>{
  const h=fixtureRuntime(SAFE);h.loadProcess('server.js');await h.settle();
  assert.equal(h.apps.length,1);assert.equal(h.apps[0].port,3000);
  assert(h.calls.some(c=>c.kind==='storage-download'));
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
