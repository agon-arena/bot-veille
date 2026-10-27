-- Manual recovery only: full checkpoint CAS, no business-state reset.
begin;
create function public.sortir_dt_reopen_failed_batch_scan(
  p_source_id uuid, p_scan_id uuid, p_expected_checkpoint jsonb
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare v jsonb; pending jsonb; n integer; pages integer; received integer; total integer;
begin
  select datatourisme_national_scan into v from public.sortir_sources
    where id = p_source_id and key = 'datatourisme-national'
      and connector_type = 'datatourisme' for update;
  if not found or p_scan_id is null or p_expected_checkpoint is null
     or jsonb_typeof(p_expected_checkpoint) is distinct from 'object' then
    raise exception 'Source/snapshot invalide';
  end if;
  -- Retry après réponse perdue : idempotent seulement si rien n'a avancé depuis.
  if v = (p_expected_checkpoint || jsonb_build_object('status', 'running'))
     and p_expected_checkpoint->>'status' = 'failed'
     and v->>'id' = p_scan_id::text then return v; end if;
  if v is distinct from p_expected_checkpoint or v->>'id' is distinct from p_scan_id::text
     or v->>'status' is distinct from 'failed'
     or v->>'last_finalized_id' = p_scan_id::text
     or coalesce((v->>'batch_size')::integer, 0) not in (500,1000)
     or v->>'started_at' is null or v->>'initial_url' is null then
    raise exception 'Checkpoint modifié/non réouvrable';
  end if;
  pending := v->'pending';
  if jsonb_typeof(pending) is distinct from 'object'
     or jsonb_typeof(pending->'ids') is distinct from 'array'
     or pending->>'url' is null
     or pending->>'url' is distinct from v->>'next_url' then
    raise exception 'Lot pending incohérent';
  end if;
  n := (pending->>'count')::integer; pages := (pending->>'page_count')::integer;
  received := (v->>'received')::integer; total := (pending->>'total')::integer;
  if n is null or n <= 0 or pages is null or pages < 1
     or pages > (v->>'batch_size')::integer / 100
     or n > least((v->>'batch_size')::integer, pages * 100)
     or received is null or received < 0 or total is null or total <= 0
     or jsonb_array_length(pending->'ids') <> n
     or (select count(distinct value::uuid) from jsonb_array_elements_text(pending->'ids')) <> n
     or received + n > total
     or (v->>'total' is not null and (v->>'total')::integer <> total)
     or (pending->>'next' is null and received + n <> total)
     or (pending->>'next' is not null and received + n >= total) then
    raise exception 'Pagination pending incohérente';
  end if;
  v := v || jsonb_build_object('status', 'running');
  update public.sortir_sources set datatourisme_national_scan = v where id = p_source_id;
  return v;
end;
$$;
revoke all on function public.sortir_dt_reopen_failed_batch_scan(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.sortir_dt_reopen_failed_batch_scan(uuid, uuid, jsonb)
  to service_role;

notify pgrst, 'reload schema';
commit;
