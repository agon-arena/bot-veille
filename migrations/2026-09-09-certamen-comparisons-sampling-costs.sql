-- Complète certamen_pipeline_comparisons (migrations/2026-09-06-certamen-pipeline-comparisons.sql)
-- suite à l'audit du 09/09/2026 :
--   - chantier 1/2 : l'échantillonnage du mode comparatif est désormais stratifié (haut/
--     milieu/bas du classement) au lieu de ne prendre que les meilleurs candidats — on
--     persiste donc le rang réel du candidat, la taille totale de la liste et la strate
--     choisie, pour pouvoir vérifier après coup que l'échantillon est représentatif ;
--   - chantier 3 : coûts/tokens réels du candidat comparé (primary et shadow), capturés
--     depuis ai-usage.jsonl au moment de l'appel (voir captureCertamenUsageRecords,
--     veille-mixte.js) — jusqu'ici disponibles seulement dans ce fichier local non
--     synchronisé entre déploiements Render.
--
-- ATTENTION : cette migration n'a PAS été exécutée automatiquement. À lancer manuellement
-- dans le SQL editor du même projet Supabase (SUPABASE_URL du bot de veille), avant ou
-- après le déploiement du code — recordCertamenComparison() (certamen-comparison-store.js)
-- retombe sur l'ancien schéma si ces colonnes n'existent pas encore, donc l'ordre des deux
-- opérations n'a aucune conséquence sur le fonctionnement de Certamen (voir rapport,
-- chantier 8). Chaque ADD COLUMN est idempotent (IF NOT EXISTS) : ce script peut être
-- rejoué sans risque.

alter table certamen_pipeline_comparisons
  -- Chantier 1/2 : position réelle du candidat dans la liste triée de la session, et
  -- strate d'où il a été tiré. candidate_index garde son sens précédent (position dans le
  -- SOUS-ENSEMBLE effectivement comparé cette session, 0-based, dans l'ordre d'exécution) ;
  -- candidate_rank est nouveau et donne la position réelle dans `candidates` (0-based),
  -- ex. 5, 15, 25... pour un tirage sur 120 candidats.
  add column if not exists candidate_rank integer,
  add column if not exists total_candidates integer,
  add column if not exists sample_stratum text check (sample_stratum in ('high', 'middle', 'low')),

  -- Chantier 3 : coûts/tokens agrégés du pipeline PRINCIPAL pour ce candidat (un seul appel
  -- IA en mode unitaire, ou judgment+creative en mode séparé si CERTAMEN_SEPARATED_ANALYZE
  -- est un jour activé).
  add column if not exists primary_model text,
  add column if not exists primary_input_tokens integer,
  add column if not exists primary_output_tokens integer,
  add column if not exists primary_cached_tokens integer,
  add column if not exists primary_cost_usd numeric,
  add column if not exists primary_usage_by_label jsonb,

  -- Chantier 3 : coûts/tokens agrégés du pipeline D'OMBRE pour ce même candidat. Quand le
  -- shadow est le pipeline séparé, primary_usage_by_label / shadow_usage_by_label distingue
  -- les libellés "certamen-judgment", "certamen-creative-generation" et
  -- "certamen-creative-retry" (clés de l'objet JSON, une par étape effectivement appelée).
  add column if not exists shadow_model text,
  add column if not exists shadow_input_tokens integer,
  add column if not exists shadow_output_tokens integer,
  add column if not exists shadow_cached_tokens integer,
  add column if not exists shadow_cost_usd numeric,
  add column if not exists shadow_usage_by_label jsonb;

create index if not exists idx_certamen_comparisons_stratum
  on certamen_pipeline_comparisons (sample_stratum);
