"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Client}=require('pg');
const G=require('./recovery-connection-guard'),C=require('./recovery-control-reads'),P=require('./autonomous-recovery-policy'),S=require('./historical-recovery-supervisor');
const {startFakePg}=require('./test-helpers/fake-pg-server');
const config=port=>({host:'127.0.0.1',port,user:'u',database:'d',query_timeout:200});
const elapsed=async work=>{const t=Date.now();let error=null;try{await work();}catch(e){error=e;}return {ms:Date.now()-t,error};};
test('régression 05/11 : pg nu met la requête suivante en file derrière la requête expirée',async()=>{
  const server=await startFakePg(),raw=new Client(config(server.port));
  try{
    await raw.connect();
    const first=await elapsed(()=>raw.query('SELECT STALL'));assert.equal(first.error.message,'Query read timeout');
    setTimeout(()=>server.release(),150);
    // Même mécanisme que la restauration de session de 49,7 s : la requête suivante n'est
    // envoyée qu'à l'arrivée de la réponse retenue (ici 150 ms, sous son propre délai).
    const next=await elapsed(()=>raw.query('SELECT 1'));assert.equal(next.error,null);assert(next.ms>=120,`attente ${next.ms} ms`);
  }finally{raw.on('error',()=>{});raw.connection.stream.destroy();await server.close();}
});
test('connexion protégée : délai client => connexion abandonnée, requête suivante refusée sans attente',async()=>{
  const server=await startFakePg(),events=[],g=G.openGuardedClient(Client,config(server.port),{onEvent:v=>events.push(v)});
  try{
    await g.connect();assert.equal((await g.query('SELECT 1')).rows.length,0);
    const first=await elapsed(()=>g.query('SELECT STALL'));
    assert.equal(first.error.code,'CLIENT_QUERY_TIMEOUT');assert.equal(S.transient(first.error),false);
    const next=await elapsed(()=>g.query('SELECT 1'));
    assert.equal(next.error.code,'CONNECTION_POISONED');assert(next.ms<50,`refus en ${next.ms} ms`);assert.equal(S.transient(next.error),false);
    assert.equal(g.poisoned,true);assert.equal(g.raw.connection.stream.destroyed,true);
    const e=events.find(v=>v.event==='connection_poisoned');assert.equal(e.reason,'client_read_timeout');
    // La requête a bien quitté le processus ; aucune réponse reçue.
    assert(e.bytesWrittenDuringQuery>0);assert.equal(e.bytesReadDuringQuery,0);
    const end=await elapsed(()=>g.end());assert(end.ms<50);
    server.release();
  }finally{await server.close();}
});
test('keepalive TCP activé, délais existants inchangés',()=>{
  let seen;class Spy{constructor(c){seen=c;}on(){}}
  G.openGuardedClient(Spy,{query_timeout:65000,connectionTimeoutMillis:20000});
  assert.equal(seen.keepAlive,true);assert.equal(seen.query_timeout,65000);assert.equal(seen.connectionTimeoutMillis,20000);
});
test('contrôle readOnly sur délai client : erreur initiale conservée, aucune restauration sur la connexion compromise',async()=>{
  const server=await startFakePg(),g=G.openGuardedClient(Client,config(server.port));
  try{
    await g.connect();const client={query:(...a)=>g.query(...a),end:()=>g.end()};
    const r=await elapsed(()=>C.readOnly(client,()=>client.query('SELECT STALL')));
    assert.equal(r.error.code,'CLIENT_QUERY_TIMEOUT');assert(r.ms<400,`arrêt en ${r.ms} ms (au lieu de l'attente de la réponse retenue)`);
    assert.equal(g.poisoned,true);
  }finally{server.release();await server.close();}
});
test('fin bornée : end() ne bloque pas sur un socket sans réponse',async()=>{
  let destroyed=false;class Hang{constructor(){this.connection={stream:{destroyed:false,destroy(){destroyed=true;this.destroyed=true;}}};}on(){}connect(){return Promise.resolve();}end(){return new Promise(()=>{});}}
  const g=G.openGuardedClient(Hang,{},{endTimeoutMs:50});await g.connect();
  const r=await elapsed(()=>g.end());assert(r.ms<500);assert.equal(destroyed,true);
});
test('faute socket : erreur d’origine conservée (retry réseau inchangé avant COMMIT)',async()=>{
  const {EventEmitter}=require('node:events');let emitter;
  class Flaky extends EventEmitter{constructor(){super();emitter=this;this.connection={stream:{destroy(){}}};}connect(){return Promise.resolve();}query(){return new Promise(()=>{});}}
  const g=G.openGuardedClient(Flaky,{});await g.connect();
  const pending=g.query('SELECT 1');emitter.emit('error',Object.assign(Error('read ECONNRESET'),{code:'ECONNRESET'}));
  await assert.rejects(pending,e=>e.code==='ECONNRESET'&&S.transient(e));
  await assert.rejects(g.query('SELECT 2'),e=>e.code==='ECONNRESET');
});
test('classement des erreurs sans texte serveur',()=>{
  assert.deepEqual(G.classifyError(new Error('Query read timeout')),{kind:'client_read_timeout',code:'CLIENT_QUERY_TIMEOUT',clientMessage:'Query read timeout'});
  const server=Object.assign(new Error('duplicate key value violates unique constraint (secret=42)'),{code:'23505',severity:'ERROR',routine:'_bt_check_unique'});
  const c=G.classifyError(server);assert.equal(c.kind,'server_error');assert.equal(c.sqlstate,'23505');assert(!JSON.stringify(c).includes('secret'));
  assert.equal(G.classifyError(Object.assign(Error('x'),{code:'ECONNRESET'})).kind,'network');
  assert.equal(G.classifyError(new S.RecoveryStop('BUSINESS','m')).code,'BUSINESS');
});
test('journal query_error : type précis au lieu du libellé générique QUERY',async()=>{
  const events=[],c=P.protectedClient({query:async()=>{throw new Error('Query read timeout');},end:async()=>{}},{},v=>events.push(v));
  await assert.rejects(c.query('SELECT clock_timestamp() AS now'));
  assert.equal(events[0].kind,'client_read_timeout');assert.equal(events[0].code,'CLIENT_QUERY_TIMEOUT');
});
test('COMMIT incertain : toujours COMMIT_UNCERTAIN même si la connexion est abandonnée',async()=>{
  const server=await startFakePg(),g=G.openGuardedClient(Client,config(server.port)),ctx={};
  try{
    await g.connect();const c=P.protectedClient({query:(...a)=>g.query(...a),end:()=>g.end()},ctx);
    server.stallWhen=sql=>sql==='COMMIT';
    await c.query('BEGIN');await assert.rejects(c.query('COMMIT'),{code:'COMMIT_UNCERTAIN'});
    assert.equal(ctx.commitSent,true);assert.equal(g.poisoned,true);
  }finally{server.release();await server.close();}
});
