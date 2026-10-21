-- PROPOSITION UNIQUEMENT : ne pas appliquer pendant le prototype.
-- Les provenances sont par occurrence et absentes pour DENY/KEEP vide ; les activités
-- peuvent fusionner plusieurs sources/POI. Ni elles ni les journaux de runs ne portent
-- une référence unique, compacte et atomiquement remplaçable par UUID de POI.
begin;

create table public.sortir_datatourisme_poi_states (
  poi_uuid uuid primary key,
  fingerprint text check (fingerprint ~ '^[a-f0-9]{64}$'),
  algorithm_version text check (length(algorithm_version) between 1 and 80),
  last_observed_at timestamptz not null,
  last_observed_scan_id uuid not null,
  absence_count smallint not null default 0 check (absence_count between 0 and 2),
  last_absence_scan_id uuid,
  needs_reprocess boolean not null default false,
  check ((fingerprint is null) = (algorithm_version is null)),
  check ((absence_count = 0) = (last_absence_scan_id is null))
);
comment on table public.sortir_datatourisme_poi_states is
  'Observation catalogue et référence Mnoria par POI. Empreinte nullable si reçu mais jamais traité avec succès.';
comment on column public.sortir_datatourisme_poi_states.last_observed_scan_id is
  'Dernier scan ayant reçu le POI, même invalide. La finalisation est certifiée séparément sur sortir_sources.';

-- Un seul checkpoint mutable sur la source existante, pas de table/journal de scans.
alter table public.sortir_sources add column datatourisme_national_scan jsonb;

alter table public.sortir_datatourisme_poi_states enable row level security;
revoke all on public.sortir_datatourisme_poi_states from public, anon, authenticated;
grant select, insert, update on public.sortir_datatourisme_poi_states to service_role;

create function public.sortir_load_datatourisme_poi_states(p_uuids uuid[])
returns setof public.sortir_datatourisme_poi_states
language plpgsql security invoker set search_path = public
as $$
begin
  if p_uuids is null or cardinality(p_uuids) > 500 then
    raise exception 'Un lot contient au maximum 500 UUID';
  end if;
  return query select s.* from public.sortir_datatourisme_poi_states s
    where s.poi_uuid = any(p_uuids);
end;
$$;

create function public.sortir_observe_datatourisme_poi_states(
  p_uuids uuid[], p_observed_at timestamptz, p_scan_id uuid
)
returns void language plpgsql security invoker set search_path = public
as $$
begin
  if p_uuids is null or cardinality(p_uuids) > 500 or p_observed_at is null or p_scan_id is null then
    raise exception 'Observation invalide (maximum 500 UUID)';
  end if;
  -- UNCHANGED : aucune écriture de fingerprint/version. Ne pas faire reculer l'observation.
  update public.sortir_datatourisme_poi_states
    set last_observed_at = p_observed_at, last_observed_scan_id = p_scan_id,
      absence_count = 0, last_absence_scan_id = null
    where poi_uuid = any(p_uuids) and last_observed_at <= p_observed_at;
end;
$$;

revoke all on function public.sortir_load_datatourisme_poi_states(uuid[]) from public, anon, authenticated;
revoke all on function public.sortir_observe_datatourisme_poi_states(uuid[], timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.sortir_load_datatourisme_poi_states(uuid[]) to service_role;
grant execute on function public.sortir_observe_datatourisme_poi_states(uuid[], timestamptz, uuid) to service_role;

-- Lecture de toutes les occurrences historiques des seuls POI reçus/calculés.
-- Les lignes inactives rendent rejouable une panne entre désactivation et stale.
-- PostgREST pagine cette fonction (500 lignes/page, count exact) par POST.
create function public.sortir_load_datatourisme_poi_provenances(p_source_id uuid, p_uuids uuid[])
returns table (
  poi_uuid uuid, id uuid, source_id uuid, source_record_id text,
  source_occurrence_key text, activity_id uuid, active boolean, activity_ends_at timestamptz
)
language plpgsql stable security invoker set search_path = public
as $$
begin
  if p_source_id is null or p_uuids is null or cardinality(p_uuids) > 500 then
    raise exception 'Lecture invalide (maximum 500 POI)';
  end if;
  return query
    select u.poi_uuid, p.id, p.source_id, p.source_record_id, p.source_occurrence_key,
      p.activity_id, p.active, a.ends_at
    from (select distinct unnest(p_uuids) as poi_uuid) u
    join public.sortir_provenances p on p.source_id = p_source_id
      and split_part(p.source_record_id, ':', 2) = u.poi_uuid::text
      and p.source_record_id like ('datatourisme:' || u.poi_uuid::text || ':%')
    join public.sortir_activities a on a.id = p.activity_id
    order by p.id;
end;
$$;

create function public.sortir_deactivate_datatourisme_provenances(p_source_id uuid, p_ids uuid[])
returns bigint language plpgsql security invoker set search_path = public
as $$
declare affected bigint;
begin
  if p_source_id is null or p_ids is null or cardinality(p_ids) > 500 then
    raise exception 'Désactivation invalide (maximum 500 provenances)';
  end if;
  update public.sortir_provenances set active = false
    where source_id = p_source_id and id = any(p_ids) and active = true
      and source_record_id like 'datatourisme:%';
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create function public.sortir_load_activity_supports(p_ids uuid[])
returns table (id uuid, record_status text, has_active_provenance boolean)
language plpgsql stable security invoker set search_path = public
as $$
begin
  if p_ids is null or cardinality(p_ids) > 500 then
    raise exception 'Lecture invalide (maximum 500 activités)';
  end if;
  return query select a.id, a.record_status,
    exists(select 1 from public.sortir_provenances p where p.activity_id = a.id and p.active = true)
    from public.sortir_activities a where a.id = any(p_ids);
end;
$$;

create function public.sortir_stale_unsupported_activities(p_ids uuid[], p_updated_at timestamptz)
returns bigint language plpgsql security invoker set search_path = public
as $$
declare affected bigint;
begin
  if p_ids is null or cardinality(p_ids) > 500 or p_updated_at is null then
    raise exception 'Mise en stale invalide (maximum 500 activités)';
  end if;
  -- Vérification au moment de l'écriture, même après la lecture de soutien :
  -- ne pas déclasser une activité qui possède désormais un soutien actif.
  update public.sortir_activities a set record_status = 'stale', updated_at = p_updated_at
    where a.id = any(p_ids) and a.record_status in ('active', 'review')
      and not exists(select 1 from public.sortir_provenances p where p.activity_id = a.id and p.active = true);
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.sortir_load_datatourisme_poi_provenances(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.sortir_deactivate_datatourisme_provenances(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.sortir_load_activity_supports(uuid[]) from public, anon, authenticated;
revoke all on function public.sortir_stale_unsupported_activities(uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.sortir_load_datatourisme_poi_provenances(uuid, uuid[]) to service_role;
grant execute on function public.sortir_deactivate_datatourisme_provenances(uuid, uuid[]) to service_role;
grant execute on function public.sortir_load_activity_supports(uuid[]) to service_role;
grant execute on function public.sortir_stale_unsupported_activities(uuid[], timestamptz) to service_role;

-- Les cinq opérations suivantes prennent le même verrou source. Un seul scan national
-- peut être actif. Une panne laisse running/complete ; abandon explicite avant un nouveau scan.
create function public.sortir_dt_begin_national_scan(p_source_id uuid, p_scan_id uuid, p_now timestamptz, p_initial_url text)
returns void language plpgsql security invoker set search_path = public
as $$
declare v jsonb;
begin
  select s.datatourisme_national_scan into v from public.sortir_sources s
    where s.id = p_source_id and s.key = 'datatourisme-national' and s.connector_type = 'datatourisme' for update;
  if not found or p_scan_id is null or p_now is null or p_initial_url is null
    or p_initial_url !~ '^https://api[.]datatourisme[.]fr/v1/entertainmentAndEvent[?]' then
    raise exception 'Source/scan national invalide';
  end if;
  if v->>'status' in ('running', 'complete') then raise exception 'Scan précédent non finalisé/abandonné'; end if;
  if v->>'id' = p_scan_id::text or v->>'last_finalized_id' = p_scan_id::text then raise exception 'UUID de scan réutilisé'; end if;
  update public.sortir_sources set datatourisme_national_scan = jsonb_build_object(
    'id', p_scan_id, 'status', 'running', 'started_at', p_now, 'next_url', p_initial_url,
    'total', null, 'received', 0, 'pages', 0, 'pending', null,
    'last_finalized_id', v->'last_finalized_id', 'last_result', v->'last_result') where id = p_source_id;
end;
$$;

create function public.sortir_dt_observe_national_page(
  p_source_id uuid, p_scan_id uuid, p_url text, p_next text, p_total integer, p_uuids uuid[], p_now timestamptz
)
returns void language plpgsql security invoker set search_path = public
as $$
declare v jsonb; n integer; received integer;
begin
  select s.datatourisme_national_scan into v from public.sortir_sources s
    where s.id = p_source_id and s.key = 'datatourisme-national' for update;
  if not found or p_scan_id is null or v->>'id' is distinct from p_scan_id::text
    or v->>'status' is distinct from 'running' or v->>'next_url' is distinct from p_url
    or v->>'pending' is not null or p_url is null or p_now is null then raise exception 'Page hors scan actif'; end if;
  n := cardinality(p_uuids); received := (v->>'received')::integer;
  if p_uuids is null or n > 100 or p_total is null or p_total <= 0
    or (select count(distinct u) from unnest(p_uuids) u) <> n
    or (v->>'total' is not null and (v->>'total')::integer <> p_total)
    or received + n > p_total
    or (p_next is null and received + n <> p_total)
    or (p_next is not null and (n = 0 or received + n >= p_total)) then raise exception 'Pagination nationale incomplète'; end if;
  if exists(select 1 from public.sortir_datatourisme_poi_states s where s.poi_uuid = any(p_uuids) and s.last_observed_scan_id = p_scan_id) then
    raise exception 'POI déjà reçu dans ce scan';
  end if;
  -- Ne touche JAMAIS l'empreinte, même si la conversion qui suit échoue.
  insert into public.sortir_datatourisme_poi_states(poi_uuid, last_observed_at, last_observed_scan_id)
    select u, p_now, p_scan_id from unnest(p_uuids) u
    on conflict(poi_uuid) do update set last_observed_at = excluded.last_observed_at,
      last_observed_scan_id = excluded.last_observed_scan_id, absence_count = 0, last_absence_scan_id = null;
  update public.sortir_sources set datatourisme_national_scan = v || jsonb_build_object(
    'pending', jsonb_build_object('url', p_url, 'next', p_next, 'total', p_total, 'count', n)) where id = p_source_id;
end;
$$;

create function public.sortir_dt_finish_national_page(p_source_id uuid, p_scan_id uuid, p_url text)
returns void language plpgsql security invoker set search_path = public
as $$
declare v jsonb; pending jsonb; received integer;
begin
  select s.datatourisme_national_scan into v from public.sortir_sources s
    where s.id = p_source_id and s.key = 'datatourisme-national' for update;
  pending := v->'pending';
  if not found or p_scan_id is null or p_url is null or v->>'id' is distinct from p_scan_id::text
    or v->>'status' is distinct from 'running' or pending->>'url' is distinct from p_url then
    raise exception 'Aucun chunk en attente à certifier';
  end if;
  received := (v->>'received')::integer + (pending->>'count')::integer;
  if pending->>'next' is null and received <> (pending->>'total')::integer then raise exception 'Total incomplet'; end if;
  update public.sortir_sources set datatourisme_national_scan = v || jsonb_build_object(
    'received', received, 'pages', (v->>'pages')::integer + coalesce((pending->>'page_count')::integer, 1), 'total', (pending->>'total')::integer,
    'next_url', pending->'next', 'pending', null,
    'status', case when pending->>'next' is null then 'complete' else 'running' end) where id = p_source_id;
end;
$$;

create function public.sortir_dt_fail_national_scan(p_source_id uuid, p_scan_id uuid)
returns void language plpgsql security invoker set search_path = public
as $$
begin
  perform 1 from public.sortir_sources s where s.id = p_source_id and s.key = 'datatourisme-national' for update;
  update public.sortir_sources set datatourisme_national_scan = datatourisme_national_scan || '{"status":"failed"}'::jsonb
    where id = p_source_id and datatourisme_national_scan->>'id' = p_scan_id::text
      and datatourisme_national_scan->>'status' in ('running', 'complete');
end;
$$;

-- UNE transaction/RPC : compteurs + désactivation + stale + certification finale.
-- Toute erreur/crash avant COMMIT annule tout. Après COMMIT, rejouer renvoie le résultat mémorisé.
create function public.sortir_dt_finalize_national_scan(p_source_id uuid, p_scan_id uuid, p_now timestamptz)
returns jsonb language plpgsql security invoker set search_path = public
as $$
declare v jsonb; confirmed uuid[]; affected_activities uuid[]; first_count integer; confirmed_count integer;
  deactivated bigint := 0; staled bigint := 0; result jsonb;
begin
  select s.datatourisme_national_scan into v from public.sortir_sources s
    where s.id = p_source_id and s.key = 'datatourisme-national' and s.connector_type = 'datatourisme' for update;
  if not found or p_scan_id is null or p_now is null then raise exception 'Source/scan invalide'; end if;
  if v->>'last_finalized_id' = p_scan_id::text then return v->'last_result'; end if;
  if v->>'id' is distinct from p_scan_id::text or v->>'status' is distinct from 'complete'
    or v->>'pending' is not null or v->>'next_url' is not null
    or coalesce((v->>'pages')::integer, 0) < 1 or coalesce((v->>'total')::integer, 0) <= 0
    or (v->>'received')::integer is distinct from (v->>'total')::integer then
    raise exception 'Scan national non complet : aucune absence ne peut progresser';
  end if;
  with changed as (
    update public.sortir_datatourisme_poi_states s set absence_count = s.absence_count + 1,
      last_absence_scan_id = p_scan_id, needs_reprocess = s.needs_reprocess or s.absence_count = 1
      where s.last_observed_scan_id is distinct from p_scan_id and s.absence_count < 2
      returning s.poi_uuid, s.absence_count
  ) select count(*) filter(where absence_count = 1), count(*) filter(where absence_count = 2),
      coalesce(array_agg(poi_uuid) filter(where absence_count = 2), '{}'::uuid[])
      into first_count, confirmed_count, confirmed from changed;
  if cardinality(confirmed) > 0 then
    -- Inclut les historiques inactifs pour terminer d'éventuels stale anciens en attente.
    select coalesce(array_agg(distinct p.activity_id), '{}'::uuid[]) into affected_activities
      from public.sortir_provenances p join unnest(confirmed) u on split_part(p.source_record_id, ':', 2) = u::text
      where p.source_id = p_source_id and p.source_record_id like ('datatourisme:' || u::text || ':%');
    update public.sortir_provenances p set active = false
      from unnest(confirmed) u where p.source_id = p_source_id and p.active = true
        and split_part(p.source_record_id, ':', 2) = u::text
        and p.source_record_id like ('datatourisme:' || u::text || ':%');
    get diagnostics deactivated = row_count;
    update public.sortir_activities a set record_status = 'stale', updated_at = p_now
      where a.id = any(affected_activities) and a.record_status in ('active', 'review')
        and not exists(select 1 from public.sortir_provenances p where p.activity_id = a.id and p.active = true);
    get diagnostics staled = row_count;
  end if;
  result := jsonb_build_object('scan_id', p_scan_id, 'observed', (v->>'received')::integer,
    'first_absences', first_count, 'confirmed_absences', confirmed_count, 'deactivated', deactivated, 'staled', staled);
  update public.sortir_sources set datatourisme_national_scan = v || jsonb_build_object(
    'status', 'finalized', 'last_finalized_id', p_scan_id, 'last_result', result) where id = p_source_id;
  return result;
end;
$$;

revoke all on function public.sortir_dt_begin_national_scan(uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.sortir_dt_observe_national_page(uuid, uuid, text, text, integer, uuid[], timestamptz) from public, anon, authenticated;
revoke all on function public.sortir_dt_finish_national_page(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.sortir_dt_fail_national_scan(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sortir_dt_finalize_national_scan(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.sortir_dt_begin_national_scan(uuid, uuid, timestamptz, text) to service_role;
grant execute on function public.sortir_dt_observe_national_page(uuid, uuid, text, text, integer, uuid[], timestamptz) to service_role;
grant execute on function public.sortir_dt_finish_national_page(uuid, uuid, text) to service_role;
grant execute on function public.sortir_dt_fail_national_scan(uuid, uuid) to service_role;
grant execute on function public.sortir_dt_finalize_national_scan(uuid, uuid, timestamptz) to service_role;

commit;

-- Opt-in checkpoints 500/1000. No scheduler wiring; migration NOT APPLIED.
create function public.sortir_dt_begin_batch_scan(p_source_id uuid, p_scan_id uuid, p_now timestamptz, p_initial_url text, p_size integer)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if p_size is null or p_size not in (500,1000) then raise exception 'Taille invalide'; end if;
  perform public.sortir_dt_begin_national_scan(p_source_id,p_scan_id,p_now,p_initial_url);
  update public.sortir_sources set datatourisme_national_scan = datatourisme_national_scan || jsonb_build_object('batch_size',p_size,'initial_url',p_initial_url,'invalid',0,'error_codes','{}'::jsonb) where id=p_source_id;
end; $$;
create function public.sortir_dt_resume_batch_scan(p_source_id uuid, p_scan_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v jsonb;
begin
  select datatourisme_national_scan into v from public.sortir_sources where id=p_source_id and key='datatourisme-national';
  if v->>'id' is distinct from p_scan_id::text or v->>'status' not in ('running','complete') or v->>'batch_size' is null then raise exception 'Scan non reprenable'; end if;
  return v;
end; $$;
create function public.sortir_dt_observe_national_batch(
  p_source_id uuid, p_scan_id uuid, p_url text, p_next text, p_total integer, p_uuids uuid[], p_pages integer, p_now timestamptz
)
returns void language plpgsql security invoker set search_path = public
as $$
declare v jsonb; n integer; received integer;
begin
  select s.datatourisme_national_scan into v from public.sortir_sources s
    where s.id = p_source_id and s.key = 'datatourisme-national' for update;
  if not found or p_scan_id is null or v->>'id' is distinct from p_scan_id::text
    or v->>'status' is distinct from 'running' or v->>'next_url' is distinct from p_url
    or p_url is null or p_now is null then raise exception 'Page hors scan actif'; end if;
  if v->>'batch_size' is null or p_now is distinct from (v->>'started_at')::timestamptz then raise exception 'Mode/instant invalide'; end if;
  if v->>'pending' is not null then
    if v->'pending' is distinct from jsonb_build_object('url', p_url, 'next', p_next, 'total', p_total, 'count', cardinality(p_uuids), 'page_count', p_pages, 'ids', to_jsonb(p_uuids)) then raise exception 'Reprise différente du lot observé'; end if;
    return;
  end if;
  n := cardinality(p_uuids); received := (v->>'received')::integer;
  if p_uuids is null or n > least((v->>'batch_size')::integer, p_pages * 100) or p_pages is null or p_pages < 1 or p_pages > (v->>'batch_size')::integer / 100 or p_total is null or p_total <= 0
    or (select count(distinct u) from unnest(p_uuids) u) <> n
    or (v->>'total' is not null and (v->>'total')::integer <> p_total)
    or received + n > p_total
    or (p_next is null and received + n <> p_total)
    or (p_next is not null and (n = 0 or received + n >= p_total)) then raise exception 'Pagination nationale incomplète'; end if;
  if exists(select 1 from public.sortir_datatourisme_poi_states s where s.poi_uuid = any(p_uuids) and s.last_observed_scan_id = p_scan_id) then
    raise exception 'POI déjà reçu dans ce scan';
  end if;
  -- Ne touche JAMAIS l'empreinte, même si la conversion qui suit échoue.
  insert into public.sortir_datatourisme_poi_states(poi_uuid, last_observed_at, last_observed_scan_id)
    select u, p_now, p_scan_id from unnest(p_uuids) u
    on conflict(poi_uuid) do update set last_observed_at = excluded.last_observed_at,
      last_observed_scan_id = excluded.last_observed_scan_id, absence_count = 0, last_absence_scan_id = null;
  update public.sortir_sources set datatourisme_national_scan = v || jsonb_build_object(
    'pending', jsonb_build_object('url', p_url, 'next', p_next, 'total', p_total, 'count', n, 'page_count', p_pages, 'ids', to_jsonb(p_uuids))) where id = p_source_id;
end;
$$;


create function public.sortir_dt_finish_national_batch(p_source_id uuid, p_scan_id uuid, p_url text, p_invalid integer, p_errors jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare v jsonb; codes jsonb;
begin
  select datatourisme_national_scan into v from public.sortir_sources where id=p_source_id and key='datatourisme-national' for update;
  if v->>'id' is distinct from p_scan_id::text or v->>'batch_size' is null then raise exception 'Scan invalide'; end if;
  if v->>'last_acked_batch_url'=p_url then return; end if;
  if p_invalid is null or p_invalid < 0 or p_invalid > (v->'pending'->>'count')::integer or jsonb_typeof(p_errors) is distinct from 'object' then raise exception 'Erreurs invalides'; end if;
  select coalesce(jsonb_object_agg(key,n),'{}'::jsonb) into codes from (
    select key,sum(value::integer) n from (select * from jsonb_each_text(coalesce(v->'error_codes','{}'::jsonb)) union all select * from jsonb_each_text(p_errors)) e group by key
  ) totals;
  perform public.sortir_dt_finish_national_page(p_source_id,p_scan_id,p_url);
  update public.sortir_sources set datatourisme_national_scan = datatourisme_national_scan || jsonb_build_object('invalid',coalesce((v->>'invalid')::integer,0)+p_invalid,'error_codes',codes,'last_acked_batch_url',p_url) where id=p_source_id;
end; $$;
revoke all on function public.sortir_dt_begin_batch_scan(uuid, uuid, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.sortir_dt_begin_batch_scan(uuid, uuid, timestamptz, text, integer) to service_role;
revoke all on function public.sortir_dt_resume_batch_scan(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sortir_dt_resume_batch_scan(uuid, uuid) to service_role;
revoke all on function public.sortir_dt_observe_national_batch(uuid, uuid, text, text, integer, uuid[], integer, timestamptz) from public, anon, authenticated;
grant execute on function public.sortir_dt_observe_national_batch(uuid, uuid, text, text, integer, uuid[], integer, timestamptz) to service_role;
revoke all on function public.sortir_dt_finish_national_batch(uuid, uuid, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.sortir_dt_finish_national_batch(uuid, uuid, text, integer, jsonb) to service_role;
