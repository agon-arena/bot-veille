-- PREPARATION ONLY. Never run on Supabase without explicit authorization.
-- No secret, no user account, no service_role; JWT signing remains outside Render.
-- Requires an administrator for CREATE ROLE, two SELECT policies and one membership.
BEGIN;
CREATE ROLE sortir_monitor_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO sortir_monitor_reader;
GRANT SELECT(id,status,orchestrator_version,started_at,finished_at,error_summary)
 ON public.sortir_ingestion_runs TO sortir_monitor_reader;
GRANT SELECT(id,started_at,status) ON public.sortir_source_runs TO sortir_monitor_reader;
CREATE POLICY sortir_monitor_read ON public.sortir_ingestion_runs
 FOR SELECT TO sortir_monitor_reader USING (true);
CREATE POLICY sortir_monitor_read ON public.sortir_source_runs
 FOR SELECT TO sortir_monitor_reader USING (true);
-- Fail on unexpected rights inherited through PUBLIC, including privileged RPCs.
DO $check$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sortir_monitor_reader' AND
   (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolcanlogin)) THEN
  RAISE EXCEPTION 'Unsafe monitoring role';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'
   AND c.relkind IN ('r','p','v','m','f') AND
   (has_table_privilege('sortir_monitor_reader',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
    has_any_column_privilege('sortir_monitor_reader',c.oid,'INSERT,UPDATE,REFERENCES') OR
    (has_any_column_privilege('sortir_monitor_reader',c.oid,'SELECT') AND
     NOT(n.nspname='public' AND c.relname IN ('sortir_ingestion_runs','sortir_source_runs'))))) THEN
  RAISE EXCEPTION 'Monitoring role has unexpected table rights';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%'
   AND n.nspname<>'information_schema' AND has_schema_privilege('sortir_monitor_reader',n.oid,'CREATE')) OR
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind='S' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND CASE WHEN c.relkind='S' THEN has_sequence_privilege('sortir_monitor_reader',c.oid,'USAGE,SELECT,UPDATE') ELSE false END) THEN
  RAISE EXCEPTION 'Monitoring role has unexpected schema or sequence rights';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'
   AND has_schema_privilege('sortir_monitor_reader',n.oid,'USAGE')
   AND p.prosecdef AND p.prorettype<>'trigger'::regtype
   AND has_function_privilege('sortir_monitor_reader',p.oid,'EXECUTE')) THEN
  RAISE EXCEPTION 'Monitoring role can invoke privileged public function';
 END IF;
END
$check$;
GRANT sortir_monitor_reader TO authenticator;
-- Deliberately no NOTIFY / JWT issuance / production credential configured.
-- A separately reviewed and authorized copy may COMMIT only after its checks pass.
ROLLBACK;
