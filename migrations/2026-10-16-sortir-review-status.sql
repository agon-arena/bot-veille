-- Migration requise mais volontairement non exécutée par le code.
-- Une activité en attente de résolution REVIEW ne doit pas être publiable et ne peut
-- donc pas partager le statut métier `active` ni détourner le statut `stale`.

begin;

alter table public.sortir_activities
  drop constraint if exists sortir_activities_record_status_check;

alter table public.sortir_activities
  add constraint sortir_activities_record_status_check
  check (record_status in ('active', 'review', 'stale', 'merged'));

commit;
