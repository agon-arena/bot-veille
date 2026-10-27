-- Fin de snapshot avec dérive de source (catalogue modifié pendant un scan long).
-- Le curseur DATAtourisme signale sa fin par l'ABSENCE de meta.next sur une réponse 200
-- valide ; meta.total reste figé à la valeur de l'ouverture du curseur. Une page terminale
-- prouvée peut donc précéder ce total initial. Ce chemin est explicite, jamais déduit d'une
-- erreur : il exige des preuves structurelles (continuité meta.page, pages pleines, contrôle
-- frais du catalogue au plus égal au reçu). Aucune absence ne progresse pour un tel scan.
-- Chemin normal (reçus = total) inchangé. Aucune colonne, aucun nouvel état : la dérive est
-- consignée dans le JSON du checkpoint (pending.source_drift → source_drift → last_result).
begin;
create or replace function public.sortir_dt_observe_terminal_drift_batch(
  p_source_id uuid, p_scan_id uuid, p_url text, p_total integer, p_uuids uuid[], p_pages integer,
  p_now timestamptz, p_selection_now timestamptz, p_terminal_page integer, p_page_size integer,
  p_terminal_count integer, p_control_total integer, p_control_at timestamptz
) returns void language plpgsql security invoker set search_path = public
as $$
declare v jsonb; n integer; received integer; pages integer; expected jsonb; drift jsonb;
begin
  select s.datatourisme_national_scan into v from public.sortir_sources s
    where s.id = p_source_id and s.key = 'datatourisme-national' and s.connector_type = 'datatourisme' for update;
  if not found or p_scan_id is null or v->>'id' is distinct from p_scan_id::text
    or v->>'status' is distinct from 'running' or v->>'next_url' is distinct from p_url
    or p_url is null or p_now is null or p_selection_now is null
    or v->>'batch_size' is null or p_now is distinct from (v->>'started_at')::timestamptz
    then raise exception 'Lot/horloge invalide'; end if;
  expected := jsonb_build_object('url',p_url,'next',null,'total',p_total,
    'count',cardinality(p_uuids),'page_count',p_pages,'ids',to_jsonb(p_uuids));
  if v->>'pending' is not null then
    -- Replay: same pages, same clock, same terminal proof. The control may be re-measured.
    drift := v->'pending'->'source_drift';
    if ((v->'pending') - 'selection_now' - 'source_drift') is distinct from expected
      or (v->'pending'->>'selection_now')::timestamptz is distinct from p_selection_now
      or jsonb_typeof(drift) is distinct from 'object'
      or (drift->>'terminal_page')::integer is distinct from p_terminal_page
      or (drift->>'terminal_count')::integer is distinct from p_terminal_count
      or (drift->>'page_size')::integer is distinct from p_page_size
      then raise exception 'Reprise différente du lot terminal observé'; end if;
    return;
  end if;
  n := cardinality(p_uuids); received := (v->>'received')::integer; pages := (v->>'pages')::integer;
  if p_uuids is null or n < 1 or p_pages is null or p_pages < 1 or p_pages > (v->>'batch_size')::integer / 100
    or n > least((v->>'batch_size')::integer, p_pages * 100)
    or (select count(distinct u) from unnest(p_uuids) u) <> n
    or p_total is null or p_total <= 0 or (v->>'total' is not null and (v->>'total')::integer <> p_total)
    or received is null or pages is null or received <> pages * 100
    -- Strict drift only: a complete snapshot keeps using the normal observation path.
    or received + n >= p_total
    -- Explicit terminal page, contiguous cursor, every earlier page full.
    or p_page_size is distinct from 100 or p_terminal_count is null or p_terminal_count < 1 or p_terminal_count > p_page_size
    or p_terminal_page is distinct from pages + p_pages
    or received + n <> (p_terminal_page - 1) * p_page_size + p_terminal_count
    -- Fresh control: the catalogue now holds no more POIs than this snapshot returned.
    or p_control_total is null or p_control_total <= 0 or p_control_total > received + n or p_control_at is null
    then raise exception 'Fin de curseur non démontrée : dérive refusée'; end if;
  if exists(select 1 from public.sortir_datatourisme_poi_states s where s.poi_uuid = any(p_uuids) and s.last_observed_scan_id = p_scan_id)
    then raise exception 'POI déjà reçu dans ce scan'; end if;
  insert into public.sortir_datatourisme_poi_states(poi_uuid, last_observed_at, last_observed_scan_id)
    select u, p_now, p_scan_id from unnest(p_uuids) u
    on conflict(poi_uuid) do update set last_observed_at = excluded.last_observed_at,
      last_observed_scan_id = excluded.last_observed_scan_id, absence_count = 0, last_absence_scan_id = null;
  drift := jsonb_build_object('initial_total', p_total, 'received_total', received + n, 'missing', p_total - received - n,
    'missing_ratio', round((p_total - received - n)::numeric / p_total, 6), 'terminal_page', p_terminal_page,
    'page_size', p_page_size, 'terminal_count', p_terminal_count, 'terminal_url', p_url,
    'control_total', p_control_total, 'control_at', p_control_at, 'scan_started_at', v->>'started_at');
  update public.sortir_sources set datatourisme_national_scan = v || jsonb_build_object('pending',
    expected || jsonb_build_object('selection_now', p_selection_now, 'source_drift', drift)) where id = p_source_id;
end;
$$;
revoke all on function public.sortir_dt_observe_terminal_drift_batch(uuid,uuid,text,integer,uuid[],integer,timestamptz,timestamptz,integer,integer,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.sortir_dt_observe_terminal_drift_batch(uuid,uuid,text,integer,uuid[],integer,timestamptz,timestamptz,integer,integer,integer,integer,timestamptz) to service_role;

create or replace function public.sortir_dt_finish_national_page(p_source_id uuid, p_scan_id uuid, p_url text)
returns void language plpgsql security invoker set search_path = public
as $$
declare v jsonb; pending jsonb; received integer; drift jsonb;
begin
select s.datatourisme_national_scan into v from public.sortir_sources s where s.id = p_source_id and s.key = 'datatourisme-national' for update;
pending := v->'pending';
if not found or p_scan_id is null or p_url is null or v->>'id' is distinct from p_scan_id::text or v->>'status' is distinct from 'running' or pending->>'url' is distinct from p_url then raise exception 'Aucun chunk en attente à certifier'; end if;
received := (v->>'received')::integer + (pending->>'count')::integer;
drift := pending->'source_drift';
if pending->>'next' is null and received <> (pending->>'total')::integer then
  -- Only a terminal batch observed with its structural proof may end before the initial total.
  if jsonb_typeof(drift) is distinct from 'object' or (drift->>'received_total')::integer is distinct from received
    or (drift->>'initial_total')::integer is distinct from (pending->>'total')::integer or received >= (pending->>'total')::integer
    or (drift->>'control_total')::integer is null or (drift->>'control_total')::integer > received
    then raise exception 'Total incomplet'; end if;
else drift := null;
end if;
update public.sortir_sources set datatourisme_national_scan = v || jsonb_build_object('received', received, 'pages', (v->>'pages')::integer + coalesce((pending->>'page_count')::integer, 1), 'total', (pending->>'total')::integer, 'next_url', pending->'next', 'pending', null, 'status', case when pending->>'next' is null then 'complete' else 'running' end)
  || case when drift is null then '{}'::jsonb else jsonb_build_object('source_drift', drift) end where id = p_source_id;
end;
$$;

create or replace function public.sortir_dt_finalize_national_scan(p_source_id uuid, p_scan_id uuid, p_now timestamptz)
returns jsonb language plpgsql security invoker set search_path = public
as $$
declare v jsonb; confirmed uuid[]; affected_activities uuid[]; first_count integer; confirmed_count integer; deactivated bigint := 0; staled bigint := 0; result jsonb; drift jsonb; unobserved integer;
begin
select s.datatourisme_national_scan into v from public.sortir_sources s where s.id = p_source_id and s.key = 'datatourisme-national' and s.connector_type = 'datatourisme' for update;
if not found or p_scan_id is null or p_now is null then raise exception 'Source/scan invalide'; end if;
if v->>'last_finalized_id' = p_scan_id::text then return v->'last_result'; end if;
drift := v->'source_drift';
if v->>'id' is distinct from p_scan_id::text or v->>'status' is distinct from 'complete' or v->>'pending' is not null or v->>'next_url' is not null or coalesce((v->>'pages')::integer, 0) < 1 or coalesce((v->>'total')::integer, 0) <= 0
  or ((v->>'received')::integer is distinct from (v->>'total')::integer and (jsonb_typeof(drift) is distinct from 'object'
    or (drift->>'received_total')::integer is distinct from (v->>'received')::integer or (drift->>'initial_total')::integer is distinct from (v->>'total')::integer
    or (v->>'received')::integer >= (v->>'total')::integer or (drift->>'control_total')::integer is null or (drift->>'control_total')::integer > (v->>'received')::integer))
  then raise exception 'Scan national non complet : aucune absence ne peut progresser'; end if;
if (v->>'received')::integer is distinct from (v->>'total')::integer then
  -- Snapshot ended before its initial total: non-observation proves nothing. No absence
  -- progresses, no provenance is deactivated, no activity becomes stale.
  select count(*) into unobserved from public.sortir_datatourisme_poi_states s where s.last_observed_scan_id is distinct from p_scan_id;
  result := jsonb_build_object('scan_id', p_scan_id, 'completion', 'completed_with_source_drift', 'observed', (v->>'received')::integer,
    'first_absences', 0, 'confirmed_absences', 0, 'deactivated', 0, 'staled', 0, 'unobserved_states_not_counted', unobserved,
    'source_drift', drift, 'finalized_at', p_now);
else
with changed as (update public.sortir_datatourisme_poi_states s set absence_count = s.absence_count + 1, last_absence_scan_id = p_scan_id, needs_reprocess = s.needs_reprocess or s.absence_count = 1 where s.last_observed_scan_id is distinct from p_scan_id and s.absence_count < 2 returning s.poi_uuid, s.absence_count)
select count(*) filter(where absence_count = 1), count(*) filter(where absence_count = 2), coalesce(array_agg(poi_uuid) filter(where absence_count = 2), '{}'::uuid[]) into first_count, confirmed_count, confirmed from changed;
if cardinality(confirmed) > 0 then
select coalesce(array_agg(distinct p.activity_id), '{}'::uuid[]) into affected_activities from public.sortir_provenances p join unnest(confirmed) u on split_part(p.source_record_id, ':', 2) = u::text where p.source_id = p_source_id and p.source_record_id like ('datatourisme:' || u::text || ':%');
update public.sortir_provenances p set active = false from unnest(confirmed) u where p.source_id = p_source_id and p.active = true and split_part(p.source_record_id, ':', 2) = u::text and p.source_record_id like ('datatourisme:' || u::text || ':%');
get diagnostics deactivated = row_count;
update public.sortir_activities a set record_status = 'stale', updated_at = p_now where a.id = any(affected_activities) and a.record_status in ('active', 'review') and not exists(select 1 from public.sortir_provenances p where p.activity_id = a.id and p.active = true);
get diagnostics staled = row_count;
end if;
result := jsonb_build_object('scan_id', p_scan_id, 'observed', (v->>'received')::integer, 'first_absences', first_count, 'confirmed_absences', confirmed_count, 'deactivated', deactivated, 'staled', staled);
end if;
update public.sortir_sources set datatourisme_national_scan = v || jsonb_build_object('status', 'finalized', 'last_finalized_id', p_scan_id, 'last_result', result) where id = p_source_id;
return result;
end;
$$;
notify pgrst, 'reload schema';
commit;
