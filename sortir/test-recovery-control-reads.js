"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const C=require('./recovery-control-reads');
function session(){
 let now=0,tx=false,last=0,dead=false;const settings=['off','2min','0'],calls=[];
 const c={calls,advance:n=>{now+=n;},get transaction(){return tx;},get settings(){return [...settings];},get dead(){return dead;},end:async()=>{dead=true;tx=false;},query:async(sql,args)=>{
  calls.push(sql);
  if(dead||tx&&now-last>=15000)throw Object.assign(Error('idle in transaction'),{code:'25P03'});
  if(/^BEGIN/i.test(sql)){tx=true;last=now;return {rows:[]};}
  if(/^COMMIT|^ROLLBACK/i.test(sql)){tx=false;return {rows:[]};}
  if(sql.includes('pg_catalog.set_config')){settings.splice(0,3,...args);return {rows:[{}]};}
  if(sql.includes('read_control_read_only'))return {rows:[{backend_pid:42,read_control_read_only:settings[0],statement_timeout:settings[1],idle_timeout:settings[2]}]};
  last=now;return {rows:[{ok:true}]};
 }};return c;
}
test('régression : ancien BEGIN + attente client 15,5 s reproduit 25P03',async()=>{const c=session();await c.query('BEGIN READ ONLY');await c.query('SELECT 1');c.advance(15511);await assert.rejects(c.query('SELECT 2'),{code:'25P03'});});
test('nouveaux contrôles : attente client 30 s sans transaction ouverte',async()=>{const c=session();await C.readOnly(c,async()=>{await c.query('SELECT 1');assert.equal(c.transaction,false);c.advance(30000);await c.query('SELECT 2');});assert.deepEqual(c.settings,['off','2min','0']);assert(!c.calls.some(s=>/^BEGIN|^COMMIT|^ROLLBACK/i.test(s)));});
test('GUC READ ONLY et délais 15 s conservés pendant le contrôle puis restaurés',async()=>{const c=session();await C.readOnly(c,async()=>assert.deepEqual(c.settings,['on','15s','15s']));assert.deepEqual(c.settings,['off','2min','0']);});
test('erreur métier : restaure la session et conserve l’erreur initiale',async()=>{const c=session(),error=Object.assign(Error('divergence'),{code:'BUSINESS'});await assert.rejects(C.readOnly(c,async()=>{throw error;}),e=>e===error);assert.deepEqual(c.settings,['off','2min','0']);});
test('erreur 25P03 : erreur initiale préservée même si restauration échoue',async()=>{const c=session();await assert.rejects(C.readOnly(c,async()=>{await c.end();throw Object.assign(Error('fatal'),{code:'25P03'});}),{code:'25P03'});assert.equal(c.dead,true);});
test('restauration impossible : ferme la connexion, ne rend pas une session au writer',async()=>{const c=session(),query=c.query;let settings=0;c.query=(s,a)=>{if(s.includes('pg_catalog.set_config')&&++settings===2)throw Error('restore failed');return query(s,a);};await assert.rejects(C.readOnly(c,async()=>{}),{code:'CONTROL_RESTORE'});assert.equal(c.dead,true);});
test('BEGIN/DML/SET/multi-commandes refusés pendant les contrôles',async()=>{for(const sql of ['BEGIN','UPDATE activities SET x=1','SET default_transaction_read_only=off','SELECT 1; SELECT 2']){const c=session();await assert.rejects(C.readOnly(c,()=>c.query(sql)),{code:'CONTROL_SQL'});}});
test('contrôles imbriqués sur une même connexion refusés',async()=>{const c=session();await C.readOnly(c,()=>assert.rejects(C.readOnly(c,async()=>{}),{code:'NESTED_CONTROL_READ'}));});
test('pooling transactionnel refusé, mode session conservé',()=>{assert.throws(()=>C.assertSessionConnection({host:'aws.pooler.supabase.com',port:6543}),{code:'SESSION_CONNECTION_REQUIRED'});C.assertSessionConnection({host:'aws.pooler.supabase.com',port:5432});});
test('journal paginé : cinq checkpoints maximum, aucun checkpoint perdu',async()=>{const source=Array.from({length:17},(_,n)=>({batch_number:n})),pages=[];const c={query:async(s,[hash,after,limit])=>{pages.push(limit);return {rows:source.filter(r=>after===null||r.batch_number>after).slice(0,limit)};}};assert.deepEqual(await C.journalRows(c,'plan',17),source);assert(pages.length>1);assert(pages.every(n=>n<=5));});
test('journal : ordre invalide et dépassement borné détectés',async()=>{await assert.rejects(C.journalRows({query:async()=>({rows:[{batch_number:1},{batch_number:0}]})},'p',3),{code:'CHECKPOINT'});});
test('erreur de journal : code PostgreSQL préservé et page exacte enregistrée',async()=>{const error=Object.assign(Error('idle timeout'),{code:'25P03'});await assert.rejects(C.journalRows({query:async()=>{throw error;}},'sealed',30),e=>e===error&&e.code==='25P03'&&e.controlRead.planHash==='sealed'&&e.controlRead.after===null&&e.controlRead.limit===5);});
test('PostgreSQL local : READ ONLY, clôture implicite et restauration après erreur',async()=>{const {PGlite}=require('@electric-sql/pglite'),db=new PGlite(),c={query:async(s,p)=>p?db.query(s,p):(await db.exec(s)).at(-1)||{rows:[]}};try{
 await db.exec('create table check_local(id int)');await C.readOnly(c,async()=>{assert.equal((await c.query("SELECT current_setting('transaction_read_only') AS ro")).rows[0].ro,'on');});
 // Vérifie le refus PostgreSQL, en dehors du filtre JS, sur la base WASM locale seulement.
 await db.exec('set default_transaction_read_only=on');await assert.rejects(db.exec('insert into check_local values(1)'),e=>e.code==='25006');await db.exec('set default_transaction_read_only=off');
 await assert.rejects(C.readOnly(c,()=>c.query('SELECT 1/0')),e=>e.code==='22012');await db.exec('insert into check_local values(1)');assert.equal((await db.query('select count(*)::int as n from check_local')).rows[0].n,1);
 }finally{await db.close();}});
