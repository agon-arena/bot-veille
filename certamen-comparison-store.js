// Persistance de la télémétrie du mode comparatif Certamen (§ demande du 06/09/2026).
//
// Pourquoi une table Supabase plutôt qu'un fichier JSON local comme ai-usage.jsonl :
// ai-usage.jsonl n'est PAS synchronisé par storage-sync.js (absent de FILES_TO_SYNC) et vit
// uniquement sur le disque de l'instance qui l'écrit. Sur Render, ce disque ne survit pas
// forcément à un redéploiement — le diagnostic du 06/09/2026 a constaté que 12 jours de
// CERTAMEN_SEPARATED_COMPARE=on n'avaient laissé localement aucune trace exploitable. Une
// table Postgres (via le même projet Supabase que storage-sync.js) survit aux redémarrages,
// redéploiements et instances éphémères, et est lisible aussi bien depuis Render que depuis
// le développement local.
//
// Règle absolue, identique à ai-usage-tracker.js : une erreur d'écriture ici ne doit JAMAIS
// faire échouer une session Certamen ni influencer analyzed/debatables. recordCertamenComparison
// ne relance donc jamais d'erreur (try/catch de bout en bout, log d'avertissement seulement).

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const TABLE = "certamen_pipeline_comparisons";

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  } catch (err) {
    console.warn("[certamen-comparison-store] Impossible d'initialiser le client Supabase :", err.message);
    supabase = null;
  }
} else {
  console.log("[certamen-comparison-store] Variables SUPABASE_URL / SUPABASE_SECRET_KEY absentes — persistance des comparaisons désactivée (mode local).");
}

// primary/shadow attendus au format retourné par normalizeCertamenPipelineOutcome
// (veille-mixte.js) : { success, error, editorialDecision, debatePotentialScore, theme,
// risk, isDebatable, suggestedQuestion, positionA, positionB }.
function computeDecisionMatch(primary, shadow) {
  if (!primary || !shadow) return null;
  if (primary.editorialDecision == null || shadow.editorialDecision == null) return null;
  return primary.editorialDecision === shadow.editorialDecision;
}

function computeScoreDiff(primary, shadow) {
  if (!primary || !shadow) return null;
  if (!Number.isFinite(primary.debatePotentialScore) || !Number.isFinite(shadow.debatePotentialScore)) return null;
  return shadow.debatePotentialScore - primary.debatePotentialScore;
}

// entry : { sessionGeneratedAt, candidateIndex, subjectId, subjectTitle, sourceUrl,
//           primaryPipeline, shadowPipeline, runTag, primary, shadow }
async function recordCertamenComparison(entry) {
  if (!supabase) return;
  try {
    const primary = (entry && entry.primary) || {};
    const shadow = (entry && entry.shadow) || {};
    const row = {
      session_generated_at: entry.sessionGeneratedAt || null,
      candidate_index: Number.isFinite(entry.candidateIndex) ? entry.candidateIndex : null,
      subject_id: entry.subjectId || null,
      subject_title: entry.subjectTitle || null,
      source_url: entry.sourceUrl || null,
      primary_pipeline: entry.primaryPipeline || null,
      shadow_pipeline: entry.shadowPipeline || null,
      run_tag: entry.runTag || null,

      primary_success: !!primary.success,
      primary_error: primary.error || null,
      primary_editorial_decision: primary.editorialDecision || null,
      primary_debate_score: Number.isFinite(primary.debatePotentialScore) ? primary.debatePotentialScore : null,
      primary_theme: primary.theme || null,
      primary_risk: primary.risk || null,
      primary_is_debatable: primary.isDebatable ?? null,
      primary_suggested_question: primary.suggestedQuestion || null,
      primary_position_a: primary.positionA || null,
      primary_position_b: primary.positionB || null,

      shadow_success: !!shadow.success,
      shadow_error: shadow.error || null,
      shadow_editorial_decision: shadow.editorialDecision || null,
      shadow_debate_score: Number.isFinite(shadow.debatePotentialScore) ? shadow.debatePotentialScore : null,
      shadow_theme: shadow.theme || null,
      shadow_risk: shadow.risk || null,
      shadow_is_debatable: shadow.isDebatable ?? null,
      shadow_suggested_question: shadow.suggestedQuestion || null,
      shadow_position_a: shadow.positionA || null,
      shadow_position_b: shadow.positionB || null,

      decision_match: computeDecisionMatch(primary, shadow),
      score_diff: computeScoreDiff(primary, shadow)
    };

    const { error } = await supabase.from(TABLE).insert(row);
    if (error) {
      console.warn("[certamen-comparison-store] Erreur insert Supabase (ignorée, sans effet sur Certamen) :", error.message);
    }
  } catch (err) {
    console.warn("[certamen-comparison-store] Exception lors de la persistance (ignorée) :", err.message);
  }
}

module.exports = { recordCertamenComparison };
