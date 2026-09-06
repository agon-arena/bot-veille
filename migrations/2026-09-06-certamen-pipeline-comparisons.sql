-- Table de télémétrie du mode comparatif Certamen (CERTAMEN_SEPARATED_COMPARE).
-- Persiste, pour chaque candidat passé en mode ombre, le résultat du pipeline principal
-- (déjà calculé par runCertamenSession, jamais rejoué) et celui du pipeline d'ombre
-- (jamais utilisé pour analyzed/debatables/publication — voir certamen-comparison-store.js).
--
-- À exécuter manuellement dans le SQL editor Supabase du projet utilisé par storage-sync.js
-- (même SUPABASE_URL que le bot de veille). Non exécuté automatiquement.

create table if not exists certamen_pipeline_comparisons (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Identité du candidat comparé
  session_generated_at timestamptz,      -- horodatage de la session Certamen (startedAt)
  candidate_index integer,               -- index (0-based) dans l'échantillon compare
  subject_id text,                       -- subjectId du sujet (ensureSubjectIds)
  subject_title text,                    -- subject.subject, tronqué à 500 caractères
  source_url text,                       -- lien de la première source, si disponible

  -- Quel pipeline était réellement actif pour la publication au moment du test
  primary_pipeline text not null check (primary_pipeline in ('unitary', 'separated')),
  shadow_pipeline text not null check (shadow_pipeline in ('unitary', 'separated')),
  run_tag text,                          -- "certamen_compare_unitaire" / "certamen_compare_separe"

  -- Résultat du pipeline principal (réutilisé tel quel, jamais rejoué pour cette écriture)
  primary_success boolean not null default false,
  primary_error text,
  primary_editorial_decision text,
  primary_debate_score integer,
  primary_theme text,
  primary_risk text,
  primary_is_debatable boolean,
  primary_suggested_question text,
  primary_position_a text,
  primary_position_b text,

  -- Résultat du pipeline d'ombre (jamais publié, jamais utilisé pour analyzed/debatables)
  shadow_success boolean not null default false,
  shadow_error text,
  shadow_editorial_decision text,
  shadow_debate_score integer,
  shadow_theme text,
  shadow_risk text,
  shadow_is_debatable boolean,
  shadow_suggested_question text,
  shadow_position_a text,
  shadow_position_b text,

  -- Calculés à l'écriture pour simplifier les requêtes d'audit (§9)
  decision_match boolean,                -- primary_editorial_decision = shadow_editorial_decision
  score_diff integer                     -- shadow_debate_score - primary_debate_score
);

create index if not exists idx_certamen_comparisons_created_at
  on certamen_pipeline_comparisons (created_at);

create index if not exists idx_certamen_comparisons_session
  on certamen_pipeline_comparisons (session_generated_at);

create index if not exists idx_certamen_comparisons_decisions
  on certamen_pipeline_comparisons (primary_editorial_decision, shadow_editorial_decision);

create index if not exists idx_certamen_comparisons_theme
  on certamen_pipeline_comparisons (primary_theme);
