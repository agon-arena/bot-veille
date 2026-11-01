-- Désactivation réversible, uniquement après autorisation opérateur.
-- Conserve intégralement la table de journal et ses lignes. Aucun DROP TABLE/DELETE.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
revoke all on function public.sortir_organizer_recovery_lock() from sortir_organizer_recovery_writer;
revoke update(record_status,updated_at) on public.sortir_activities from sortir_organizer_recovery_writer;
revoke all on public.sortir_organizer_recovery_batches from sortir_organizer_recovery_writer;
do $$ declare t text; begin
  foreach t in array array['sortir_ingestion_runs','sortir_source_runs','sortir_sources',
    'sortir_activities','sortir_provenances','sortir_external_ids','sortir_collection_items',
    'sortir_dedup_decisions','sortir_datatourisme_poi_states'] loop
    execute format('revoke select on public.%I from sortir_organizer_recovery_writer',t);
    execute format('drop policy if exists organizer_recovery_read on public.%I',t);
  end loop;
end $$;
drop policy if exists organizer_recovery_promote on public.sortir_activities;
alter role sortir_organizer_recovery_writer nologin;
do $$ begin
  if exists(select 1 from pg_roles where rolname='sortir_organizer_recovery_login') then
    alter role sortir_organizer_recovery_login nologin;
    revoke sortir_organizer_recovery_writer from sortir_organizer_recovery_login;
  end if;
end $$;
commit;
