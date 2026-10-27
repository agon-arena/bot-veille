-- Selection clock is independent from catalog/observation clock.
-- Applied and validated manually on 2026-10-23; no scheduler integration.
begin;
create or replace function public.sortir_dt_observe_national_batch_v2(
  p_source_id uuid, p_scan_id uuid, p_url text, p_next text, p_total integer,
  p_uuids uuid[], p_pages integer, p_now timestamptz, p_selection_now timestamptz
) returns void language plpgsql security invoker set search_path = public
as $$
declare v jsonb; expected jsonb; recorded timestamptz;
begin
  select s.datatourisme_national_scan into v from public.sortir_sources s
    where s.id = p_source_id and s.key = 'datatourisme-national' for update;
  if not found or p_scan_id is null or v->>'id' is distinct from p_scan_id::text
    or v->>'status' is distinct from 'running' or v->>'next_url' is distinct from p_url
    or p_url is null or p_now is null or p_selection_now is null
    or v->>'batch_size' is null or p_now is distinct from (v->>'started_at')::timestamptz
    then raise exception 'Lot/horloge invalide'; end if;
  expected := jsonb_build_object('url',p_url,'next',p_next,'total',p_total,
    'count',cardinality(p_uuids),'page_count',p_pages,'ids',to_jsonb(p_uuids));
  if v->>'pending' is not null then
    recorded := coalesce((v->'pending'->>'selection_now')::timestamptz,(v->>'started_at')::timestamptz);
    if ((v->'pending') - 'selection_now') is distinct from expected or recorded is distinct from p_selection_now
      then raise exception 'Reprise différente du lot/instant observé'; end if;
    return;
  end if;
  -- Delegate all existing pagination/observation checks; attach the clock in this transaction.
  perform public.sortir_dt_observe_national_batch(p_source_id,p_scan_id,p_url,p_next,p_total,p_uuids,p_pages,p_now);
  update public.sortir_sources set datatourisme_national_scan =
    jsonb_set(datatourisme_national_scan,'{pending,selection_now}',to_jsonb(p_selection_now)) where id=p_source_id;
end;
$$;
revoke all on function public.sortir_dt_observe_national_batch_v2(uuid,uuid,text,text,integer,uuid[],integer,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.sortir_dt_observe_national_batch_v2(uuid,uuid,text,text,integer,uuid[],integer,timestamptz,timestamptz) to service_role;
notify pgrst, 'reload schema';
commit;
