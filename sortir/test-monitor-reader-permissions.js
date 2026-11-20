'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const SQL=fs.readFileSync(require.resolve('./prepare-monitor-reader-2026-11-20.sql'),'utf8');
async function fixture(){const db=new PGlite();await db.exec(`CREATE ROLE authenticator NOLOGIN NOINHERIT;
 CREATE TABLE sortir_ingestion_runs(id uuid,status text,orchestrator_version text,started_at timestamptz,finished_at timestamptz,error_summary jsonb,collected_count int);
 CREATE TABLE sortir_source_runs(id uuid,started_at timestamptz,status text,error text);
 CREATE TABLE sortir_activities(id int,record_status text);CREATE TABLE sortir_organizer_recovery_batches(id int);
 CREATE SCHEMA storage;CREATE TABLE storage.objects(id int);
 ALTER TABLE sortir_ingestion_runs ENABLE ROW LEVEL SECURITY;ALTER TABLE sortir_source_runs ENABLE ROW LEVEL SECURITY;
 INSERT INTO sortir_ingestion_runs VALUES('00000000-0000-0000-0000-000000000001','running','fixture',now(),NULL,'[]',0);
 INSERT INTO sortir_source_runs VALUES('00000000-0000-0000-0000-000000000002',now(),'partial','fixture');`);return db;}
const committed=()=>SQL.replace(/ROLLBACK;\s*$/,'COMMIT;'); // In-memory fixtures only.
test('prepared identity SQL rolls back by default and changes no production object',async()=>{
 const db=await fixture();try{await db.exec(SQL);assert.equal((await db.query("SELECT count(*)::int n FROM pg_roles WHERE rolname='sortir_monitor_reader'")).rows[0].n,0);}finally{await db.close();}
});
test('dedicated role reads only permitted columns on two run tables and no business/Storage data',async()=>{
 const db=await fixture();try{await db.exec(committed());await db.exec('SET SESSION AUTHORIZATION authenticator; SET ROLE sortir_monitor_reader');
  assert.equal((await db.query('SELECT id,status,orchestrator_version,started_at,finished_at,error_summary FROM sortir_ingestion_runs')).rows.length,1);
  assert.equal((await db.query('SELECT id,started_at,status FROM sortir_source_runs')).rows.length,1);
  for(const q of ['SELECT * FROM sortir_ingestion_runs','SELECT error FROM sortir_source_runs','SELECT * FROM sortir_activities','SELECT * FROM sortir_organizer_recovery_batches','SELECT * FROM storage.objects'])await assert.rejects(db.query(q),/permission denied/);
 }finally{await db.close();}
});
test('dedicated role cannot insert, update, delete, truncate, create, grant or become service_role',async()=>{
 const db=await fixture();try{await db.exec('CREATE ROLE service_role NOLOGIN BYPASSRLS');await db.exec(committed());await db.exec('SET SESSION AUTHORIZATION authenticator; SET ROLE sortir_monitor_reader');
 for(const q of ["INSERT INTO sortir_ingestion_runs(id) VALUES('00000000-0000-0000-0000-000000000003')","UPDATE sortir_ingestion_runs SET status='completed'","DELETE FROM sortir_ingestion_runs","UPDATE sortir_source_runs SET status='completed'","INSERT INTO sortir_activities VALUES(1,'active')","TRUNCATE sortir_ingestion_runs","CREATE TABLE public.unauthorized(id int)","GRANT SELECT ON sortir_activities TO sortir_monitor_reader","SET ROLE service_role"])await assert.rejects(db.exec(q),undefined,q);
 }finally{await db.close();}
});
test('provisioning refuses unexpected PUBLIC business reads and writes without broadening production permissions',async()=>{
 for(const grant of ['GRANT SELECT ON sortir_activities TO PUBLIC','GRANT UPDATE(record_status) ON sortir_activities TO PUBLIC']){
  const db=await fixture();try{await db.exec(grant);await assert.rejects(db.exec(SQL),/unexpected table rights/);await db.exec('ROLLBACK');assert.equal((await db.query("SELECT count(*)::int n FROM pg_roles WHERE rolname='sortir_monitor_reader'")).rows[0].n,0);}finally{await db.close();}
 }
});
test('provisioning refuses accessible SECURITY DEFINER RPCs',async()=>{
 const db=await fixture();try{await db.exec("CREATE FUNCTION public.unsafe_write() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'INSERT INTO sortir_activities VALUES(1,''active'')'");await assert.rejects(db.exec(SQL),/privileged public function/);await db.exec('ROLLBACK');}finally{await db.close();}
});

test('provisioning refuses PUBLIC schema creation and sequence permissions',async()=>{
 for(const grant of ['GRANT CREATE ON SCHEMA public TO PUBLIC','CREATE SEQUENCE public.exposed_sequence; GRANT USAGE ON SEQUENCE public.exposed_sequence TO PUBLIC']){
  const db=await fixture();try{await db.exec(grant);await assert.rejects(db.exec(SQL),/unexpected schema or sequence rights/);await db.exec('ROLLBACK');}finally{await db.close();}
 }
});
