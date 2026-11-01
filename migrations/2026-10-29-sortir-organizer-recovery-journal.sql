-- Installation uniquement après autorisation explicite. Aucun UPDATE métier.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
lock table public.sortir_ingestion_runs,public.sortir_source_runs,public.sortir_sources,
  public.sortir_activities,public.sortir_provenances,public.sortir_external_ids,
  public.sortir_collection_items,public.sortir_dedup_decisions,
  public.sortir_datatourisme_poi_states in share row exclusive mode nowait;
do $$ begin
  if exists(select 1 from public.sortir_ingestion_runs where status='running') or
     exists(select 1 from public.sortir_source_runs where status='running') then
    raise exception 'Installation refused: ingestion running';
  end if;
end $$;
create table public.sortir_organizer_recovery_batches (
  plan_hash text not null check (plan_hash ~ '^[a-f0-9]{64}$'),
  batch_number integer not null check (batch_number >= 0),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  committed_at timestamptz not null default clock_timestamp(),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  primary key (plan_hash, batch_number)
);
comment on table public.sortir_organizer_recovery_batches is
  'Journal et checkpoint atomiques avec chaque lot de reprise organizer_name_missing. Détails avant/après dans result ; aucune suppression automatique.';
alter table public.sortir_organizer_recovery_batches enable row level security;
revoke all on public.sortir_organizer_recovery_batches from public, anon, authenticated, service_role;
do $$ begin
  if exists(select 1 from pg_roles where rolname='sortir_organizer_recovery_writer') then
    raise exception 'Installation refused: recovery role already exists; audit its privileges first';
  end if;
  create role sortir_organizer_recovery_writer nologin noinherit nosuperuser
    nocreatedb nocreaterole noreplication nobypassrls;
end $$;
-- Fonction privilégiée limitée aux verrous : aucun UPDATE/INSERT métier.
create function public.sortir_organizer_recovery_lock() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set row_security=off as $$
declare t text; n bigint; visibility jsonb := '{}'::jsonb;
begin
  lock table public.sortir_ingestion_runs,public.sortir_source_runs,public.sortir_sources,
    public.sortir_activities,public.sortir_provenances,public.sortir_external_ids,
    public.sortir_collection_items,public.sortir_dedup_decisions,
    public.sortir_datatourisme_poi_states,public.sortir_organizer_recovery_batches
    in share row exclusive mode nowait;
  if not exists(select 1 from public.sortir_ingestion_runs where
    id='be127190-19a4-4f50-b615-7a9a78b8ff14'::uuid and
    orchestrator_version='sortir-scheduler-lock-v1' and status='completed') then
    raise exception 'Scheduler lock unavailable';
  end if;
  if exists(select 1 from public.sortir_ingestion_runs where status='running') or
     exists(select 1 from public.sortir_source_runs where status='running') then
    raise exception 'Ingestion running';
  end if;
  foreach t in array array['sortir_ingestion_runs','sortir_source_runs','sortir_sources',
    'sortir_activities','sortir_provenances','sortir_external_ids','sortir_collection_items',
    'sortir_dedup_decisions','sortir_datatourisme_poi_states','sortir_organizer_recovery_batches'] loop
    execute format('select count(*) from public.%I',t) into n;
    visibility := visibility || jsonb_build_object(t,n);
  end loop;
  return visibility;
end $$;
revoke all on function public.sortir_organizer_recovery_lock() from public,anon,authenticated,service_role;
grant execute on function public.sortir_organizer_recovery_lock() to sortir_organizer_recovery_writer;
grant usage on schema public to sortir_organizer_recovery_writer;
do $$ declare t text; begin
  foreach t in array array['sortir_ingestion_runs','sortir_source_runs','sortir_sources',
    'sortir_activities','sortir_provenances','sortir_external_ids','sortir_collection_items',
    'sortir_dedup_decisions','sortir_datatourisme_poi_states'] loop
    execute format('grant select on public.%I to sortir_organizer_recovery_writer',t);
    execute format('create policy organizer_recovery_read on public.%I for select to sortir_organizer_recovery_writer using (true)',t);
  end loop;
end $$;
grant update(record_status,updated_at) on public.sortir_activities to sortir_organizer_recovery_writer;
create policy organizer_recovery_promote on public.sortir_activities for update
  to sortir_organizer_recovery_writer using(
    record_status='review'
    and exists(select 1 from public.sortir_provenances p join public.sortir_sources s on s.id=p.source_id
      where p.activity_id=sortir_activities.id and p.active and s.connector_type='datatourisme')
    and not exists(select 1 from public.sortir_provenances p join public.sortir_sources s on s.id=p.source_id
      where p.activity_id=sortir_activities.id and p.active and s.connector_type<>'datatourisme')
    and exists(select 1 from public.sortir_collection_items i,
      lateral jsonb_array_elements(case when jsonb_typeof(i.diagnostics->'warnings')='array'
        then i.diagnostics->'warnings' else '[]'::jsonb end) w
      where i.activity_id=sortir_activities.id and w->>'code'='organizer_name_missing')
    and not exists(select 1 from public.sortir_dedup_decisions d
      where d.decision='REVIEW' and d.review_status='pending'
      and (d.left_activity_id=sortir_activities.id or d.right_activity_id=sortir_activities.id)
      and (not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(d.signals)='array'
          then d.signals else '[]'::jsonb end) s where s->>'type'='review_quarantine')
        or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(d.signals)='array'
          then d.signals else '[]'::jsonb end) s where s->>'type'='review_quarantine'
          and s->>'quarantinedActivityId'=sortir_activities.id::text)))
  ) with check(record_status='active');
grant select,insert on public.sortir_organizer_recovery_batches to sortir_organizer_recovery_writer;
create policy organizer_recovery_journal_read on public.sortir_organizer_recovery_batches
  for select to sortir_organizer_recovery_writer using(true);
create policy organizer_recovery_journal_insert on public.sortir_organizer_recovery_batches
  for insert to sortir_organizer_recovery_writer with check(true);
-- Un login PostgreSQL dédié doit recevoir ce rôle APRES autorisation opérateur.
commit;
