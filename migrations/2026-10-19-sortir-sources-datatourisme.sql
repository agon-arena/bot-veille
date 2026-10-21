-- Migration requise mais volontairement non exécutée par le code (même convention que
-- 2026-10-16-sortir-review-status.sql et 2026-10-18-sortir-sources-openagenda-json.sql).
-- Le connecteur DATAtourisme (sortir/connectors/datatourisme.js) ne peut créer aucune source :
-- sortir_sources_connector_type_check n'autorise que
-- ('openagenda_ical', 'openagenda_json', 'mobilizon', 'paris_data'), pas 'datatourisme'.
-- Constaté le 19/10/2026 lors de la validation réelle bornée du scheduler multi-sources :
-- persistSortirIngestion échoue à l'étape ensureSource() pour la source DATAtourisme, sans
-- toucher aux données métier existantes (aucune activité/provenance affectée, seules des
-- lignes sortir_ingestion_runs/source_runs en statut "failed" ont été créées, exactement comme
-- pour l'incident openagenda_json du 18/10/2026).
--
-- Portée strictement limitée à l'ajout de 'datatourisme' à la liste des valeurs autorisées :
-- aucune donnée existante touchée, aucune autre contrainte modifiée.

begin;

alter table public.sortir_sources
  drop constraint if exists sortir_sources_connector_type_check;

alter table public.sortir_sources
  add constraint sortir_sources_connector_type_check
  check (connector_type in ('openagenda_ical', 'openagenda_json', 'mobilizon', 'paris_data', 'datatourisme'));

commit;
