"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const H=require('./host-power-guard'),S=require('./historical-recovery-supervisor');
const PMSET_AC="Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charged;",PMSET_BATT="Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t50%; discharging;";
const IOREG=v=>`+-o AppleSmartBattery\n  {\n      "AppleClamshellCausesSleep" = No\n      "AppleClamshellState" = ${v}\n  }`;
function guard(sample,extra={}){let clock=1_000_000;const g=new H.HostGuard({sample:async()=>sample(),now:()=>clock,...extra});return {g,advance:ms=>{clock+=ms;}};}
test('lecture macOS : secteur, batterie, capot',()=>{
  assert.equal(H.parseAcPower(PMSET_AC),true);assert.equal(H.parseAcPower(PMSET_BATT),false);assert.equal(H.parseAcPower(''),null);
  assert.equal(H.parseLidClosed(IOREG('No')),false);assert.equal(H.parseLidClosed(IOREG('Yes')),true);assert.equal(H.parseLidClosed('rien'),null);
});
test('lecture réelle via pmset/ioreg simulés',async()=>{
  const exec=async file=>file.endsWith('pmset')?PMSET_BATT:IOREG('No');
  assert.deepEqual(await H.readHostPower(exec),{acPower:false,lidClosed:false});
  assert.deepEqual(await H.readHostPower(async()=>null),{acPower:null,lidClosed:null});
});
test('secteur + capot ouvert : sûr',async()=>{const {g}=guard(()=>({acPower:true,lidClosed:false}));await g.refresh();g.assertSafe('batch_start');});
test('incident du 05/11 : batterie ou capot fermé => arrêt HOST_UNSAFE non retryable',async()=>{
  for(const [state,reason] of [[{acPower:false,lidClosed:false},'battery_power'],[{acPower:true,lidClosed:true},'lid_closed'],[{acPower:null,lidClosed:false},'power_unknown'],[{acPower:true,lidClosed:null},'lid_unknown']]){
    const {g}=guard(()=>state);await g.refresh();
    assert.throws(()=>g.assertSafe('batch_validation'),e=>e.code==='HOST_UNSAFE'&&e.hostReason===reason&&e instanceof S.RecoveryStop&&!S.transient(e));
  }
});
test('échec fermé : aucun échantillon ou échantillon trop ancien',async()=>{
  const {g,advance}=guard(()=>({acPower:true,lidClosed:false}));
  assert.throws(()=>g.assertSafe('preflight'),e=>e.hostReason==='power_state_stale');
  await g.refresh();g.assertSafe('preflight');advance(10_000);g.observeTick();advance(10_000);g.observeTick();advance(11_000);
  assert.throws(()=>g.assertSafe('before_writer'),e=>e.hostReason==='power_state_stale');
});
test('suspension détectée par l’écart d’horloge murale (veille de 62 s du 05/11)',async()=>{
  const events=[],{g,advance}=guard(()=>({acPower:true,lidClosed:false}),{onEvent:v=>events.push(v)});
  await g.refresh();g.observeTick();advance(62_000);await g.refresh();
  assert.throws(()=>g.assertSafe('batch_validation'),e=>e.hostReason==='host_suspended');
  assert(events.some(v=>v.event==='host_suspension_detected'&&v.gapMs===62_000));
  // Persistant : un retour sur secteur ne fait pas oublier une suspension.
  await g.refresh();assert.throws(()=>g.assertSafe('before_writer'));
});
test('transitions d’alimentation journalisées une seule fois',async()=>{
  let s={acPower:true,lidClosed:false};const events=[],{g}=guard(()=>s,{onEvent:v=>events.push(v)});
  await g.refresh();await g.refresh();s={acPower:false,lidClosed:false};await g.refresh();await g.refresh();
  assert.deepEqual(events.map(e=>e.unsafe),[null,'battery_power']);
});
test('câblage : garde aux seuls points sûrs, jamais dans le writer ni en réconciliation',()=>{
  const src=fs.readFileSync(path.join(__dirname,'autonomous-historical-recovery.js'),'utf8');
  assert.match(src,/const host=auditOnly\?null:new H\.HostGuard/);
  for(const phase of ['preflight','activation','batch_start','before_writer'])assert(src.includes(`host.assertSafe('${phase}')`),phase);
  assert.match(src,/if\(phase==='batch_validation'\)host\.assertSafe\(phase\)/);
  const writer=src.slice(src.indexOf("host.assertSafe('before_writer')"));
  const call=writer.slice(writer.indexOf('W.writeBatch('),writer.indexOf('}});}',writer.indexOf('W.writeBatch(')));
  assert(call.length>0&&!call.includes('host.'),'aucune garde d’hôte dans les hooks du writer');
  const reconcile=src.slice(src.indexOf('async function reconcile('),src.indexOf('async function finish('));
  assert(!reconcile.includes('host.'),'la réconciliation en lecture seule reste toujours possible');
});
