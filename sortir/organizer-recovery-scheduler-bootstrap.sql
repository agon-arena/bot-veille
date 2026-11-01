-- PREPARATION SEULEMENT. Ne pas appliquer sans autorisation de production.
-- Initialise une ligne technique d'exclusion, jamais un run d'ingestion métier.
-- Ne corrige pas la fiabilité du déclencheur quotidien externe.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
lock table public.sortir_ingestion_runs,public.sortir_source_runs
  in share row exclusive mode nowait;
do $$ begin
  if exists(select 1 from public.sortir_ingestion_runs where status='running')
    or exists(select 1 from public.sortir_source_runs where status='running') then
    raise exception 'Bootstrap refused: ingestion running';
  end if;
  if exists(select 1 from public.sortir_ingestion_runs
    where id='be127190-19a4-4f50-b615-7a9a78b8ff14'::uuid
    and (orchestrator_version is distinct from 'sortir-scheduler-lock-v1'
      or status is distinct from 'completed')) then
    raise exception 'Bootstrap refused: existing lock requires operator review';
  end if;
end $$;
insert into public.sortir_ingestion_runs(id,orchestrator_version,status,started_at,finished_at)
values('be127190-19a4-4f50-b615-7a9a78b8ff14','sortir-scheduler-lock-v1',
  'completed',clock_timestamp(),clock_timestamp())
on conflict(id) do nothing;
commit;
