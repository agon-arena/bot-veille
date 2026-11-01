"use strict";
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),tls=require('tls'),cp=require('child_process');
const {recoveryConnectionConfig}=require('./organizer-recovery-connection');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sortir-tls-test-'));let passed=0,server;
 const test=async(name,fn)=>{await fn();passed++;console.log('✓ '+name);};
 const openssl=args=>cp.execFileSync('openssl',args,{cwd:dir,stdio:'ignore'});
 try {
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','2','-subj','/CN=Sortir isolated test CA','-addext','basicConstraints=critical,CA:TRUE']);
  openssl(['req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=localhost']);
  fs.writeFileSync(path.join(dir,'server.ext'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\n');
  openssl(['x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out','server.crt','-days','2','-extfile','server.ext']);
  const env={SORTIR_RECOVERY_DATABASE_URL:'postgres://sortir_organizer_recovery_login:test@127.0.0.1:5432/isolated',SORTIR_RECOVERY_CA_FILE:path.join(dir,'ca.crt')};
  await test('TLS explicite : CA, nom d’hôte, TLS 1.2 minimum et validation obligatoire',()=>{const c=recoveryConnectionConfig(env);assert.equal(c.ssl.rejectUnauthorized,true);assert.equal(c.ssl.checkServerIdentity,tls.checkServerIdentity);assert.equal(c.ssl.servername,'127.0.0.1');assert.equal(c.ssl.minVersion,'TLSv1.2');assert(!c.connectionString);});
  await test('absence de CA : refus sans connexion',()=>assert.throws(()=>recoveryConnectionConfig({...env,SORTIR_RECOVERY_CA_FILE:''}),/trusted/));
  await test('désactivation globale TLS : refus',()=>assert.throws(()=>recoveryConnectionConfig({...env,NODE_TLS_REJECT_UNAUTHORIZED:'0'}),/remain enabled/));
  await test('paramètres URL pouvant écraser TLS ou l’hôte : tous refusés',()=>{for(const suffix of ['sslmode=require','sslmode=no-verify','ssl=false','uselibpqcompat=true','host=other.example'])assert.throws(()=>recoveryConnectionConfig({...env,SORTIR_RECOVERY_DATABASE_URL:env.SORTIR_RECOVERY_DATABASE_URL+'?'+suffix}),/options forbidden/);});
  await test('compte privilégié : refus au lieu de SET ROLE après connexion admin',()=>assert.throws(()=>recoveryConnectionConfig({...env,SORTIR_RECOVERY_DATABASE_URL:'postgres://postgres:test@localhost/test'}),/Dedicated recovery login/));
  await test('identifiants ou base absents : aucun fallback vers les variables PG',()=>{for(const uri of ['postgres://localhost/test','postgres://sortir_organizer_recovery_login@localhost/test','postgres://sortir_organizer_recovery_login:test@localhost/'])assert.throws(()=>recoveryConnectionConfig({...env,SORTIR_RECOVERY_DATABASE_URL:uri}),/Explicit dedicated/);});
  await test('protocole non PostgreSQL : refus',()=>assert.throws(()=>recoveryConnectionConfig({...env,SORTIR_RECOVERY_DATABASE_URL:'https://localhost'}),/PostgreSQL/));
  await test('certificat serveur utilisé comme CA : refus',()=>assert.throws(()=>recoveryConnectionConfig({...env,SORTIR_RECOVERY_CA_FILE:path.join(dir,'server.crt')}),/CA certificate/));
  await test('clé privée fournie comme CA : refus',()=>assert.throws(()=>recoveryConnectionConfig({...env,SORTIR_RECOVERY_CA_FILE:path.join(dir,'ca.key')}),/public certificates/));
  server=tls.createServer({key:fs.readFileSync(path.join(dir,'server.key')),cert:fs.readFileSync(path.join(dir,'server.crt'))},socket=>socket.end());server.on('tlsClientError',()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const connect=ssl=>new Promise((resolve,reject)=>{const socket=tls.connect({host:'127.0.0.1',port:server.address().port,...ssl},()=>{const authorized=socket.authorized;socket.end();resolve(authorized);});socket.on('error',reject);});
  const ssl=recoveryConnectionConfig(env).ssl;
  await test('handshake réel : CA connue et nom correct acceptés',async()=>assert.equal(await connect(ssl),true));
  await test('handshake réel : nom incorrect rejeté',async()=>assert.rejects(connect({...ssl,servername:'wrong.example'}),e=>e.code==='ERR_TLS_CERT_ALTNAME_INVALID'));
  await test('handshake réel : racine inconnue rejetée',async()=>assert.rejects(connect({...ssl,ca:tls.rootCertificates}),e=>['UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(e.code)));
  console.log(`${passed} réussis, 0 échoué`);
 } finally {if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
