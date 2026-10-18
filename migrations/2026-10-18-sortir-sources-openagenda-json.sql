-- Migration requise mais volontairement non exécutée par le code (comme la migration du
-- 2026-10-16 sur record_status).
-- Le connecteur OpenAgenda JSON (sortir/connectors/openagenda-json.js) ne peut créer aucune
-- source : sortir_sources_connector_type_check n'autorise que
-- ('openagenda_ical', 'mobilizon', 'paris_data'), pas 'openagenda_json'. Constaté le
-- 18/10/2026 lors du smoke test de migration ICS → JSON : persistSortirIngestion échoue à
-- l'étape ensureSource() pour toute source JSON, sans toucher aux données métier existantes
-- (aucune activité/provenance affectée, seules des lignes sortir_ingestion_runs/source_runs
-- en statut "failed" ont été créées).

begin;

alter table public.sortir_sources
  drop constraint if exists sortir_sources_connector_type_check;

alter table public.sortir_sources
  add constraint sortir_sources_connector_type_check
  check (connector_type in ('openagenda_ical', 'openagenda_json', 'mobilizon', 'paris_data'));

commit;
