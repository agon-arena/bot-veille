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

// Agrège une liste d'enregistrements ai-usage-tracker (format ai-usage.jsonl : { model,
// input_tokens, output_tokens, cached_tokens, estimated_cost, label, success, ... }) en un
// résumé { model, totalInputTokens, totalOutputTokens, totalCachedTokens, totalCostUsd,
// byLabel } — byLabel distingue judgment / creative-generation / creative-retry pour le
// pipeline séparé (§ chantier 3, audit du 09/09/2026). Ne throw jamais : une entrée absente
// ou mal formée est simplement ignorée, un tableau vide renvoie des totaux null (coût
// "inconnu", pas "zéro").
function aggregateCertamenUsageRecords(records) {
  const safeRecords = Array.isArray(records) ? records.filter(Boolean) : [];
  const byLabel = {};
  let model = null;
  let totalInputTokens = 0, totalOutputTokens = 0, totalCachedTokens = 0, totalCost = 0;
  let costKnown = safeRecords.length > 0;

  for (const r of safeRecords) {
    if (!model && r.model) model = r.model;
    const inTok = Number(r.input_tokens) || 0;
    const outTok = Number(r.output_tokens) || 0;
    const cacheTok = Number(r.cached_tokens) || 0;
    totalInputTokens += inTok;
    totalOutputTokens += outTok;
    totalCachedTokens += cacheTok;
    if (typeof r.estimated_cost === "number") totalCost += r.estimated_cost;
    else if (r.success) costKnown = false;

    const label = r.label || "?";
    if (!byLabel[label]) byLabel[label] = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, model: r.model || null };
    byLabel[label].calls += 1;
    byLabel[label].inputTokens += inTok;
    byLabel[label].outputTokens += outTok;
    byLabel[label].cachedTokens += cacheTok;
    if (typeof r.estimated_cost === "number") byLabel[label].cost += r.estimated_cost;
  }

  return {
    model,
    totalInputTokens: safeRecords.length ? totalInputTokens : null,
    totalOutputTokens: safeRecords.length ? totalOutputTokens : null,
    totalCachedTokens: safeRecords.length ? totalCachedTokens : null,
    totalCostUsd: (costKnown && safeRecords.length) ? Math.round(totalCost * 1e8) / 1e8 : null,
    byLabel
  };
}

// entry : { sessionGeneratedAt, candidateIndex, candidateRank, totalCandidates,
//           sampleStratum, subjectId, subjectTitle, sourceUrl, primaryPipeline,
//           shadowPipeline, runTag, primary, shadow, primaryUsageRecords, shadowUsageRecords }
//
// candidateRank/totalCandidates/sampleStratum et les champs *_usage_* sont apparus le
// 09/09/2026 (chantiers 2 et 3) : colonnes ajoutées par la migration SQL fournie séparément
// (voir rapport). Tant que cette migration n'a pas tourné, un premier insert avec ces
// colonnes échoue (colonne inconnue) — on retombe alors sur `baseRow` (schéma d'origine, en
// service depuis le 06/09/2026) pour ne jamais perdre la télémétrie de base déjà en place.
// Ordre de déploiement donc sans importance pour Certamen (voir rapport, chantier 8).
async function recordCertamenComparison(entry) {
  if (!supabase) return;
  try {
    const primary = (entry && entry.primary) || {};
    const shadow = (entry && entry.shadow) || {};
    const primaryUsage = aggregateCertamenUsageRecords(entry && entry.primaryUsageRecords);
    const shadowUsage = aggregateCertamenUsageRecords(entry && entry.shadowUsageRecords);

    const baseRow = {
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

    const extendedRow = Object.assign({}, baseRow, {
      candidate_rank: Number.isFinite(entry.candidateRank) ? entry.candidateRank : null,
      total_candidates: Number.isFinite(entry.totalCandidates) ? entry.totalCandidates : null,
      sample_stratum: entry.sampleStratum || null,

      primary_model: primaryUsage.model,
      primary_input_tokens: primaryUsage.totalInputTokens,
      primary_output_tokens: primaryUsage.totalOutputTokens,
      primary_cached_tokens: primaryUsage.totalCachedTokens,
      primary_cost_usd: primaryUsage.totalCostUsd,
      primary_usage_by_label: Object.keys(primaryUsage.byLabel).length ? primaryUsage.byLabel : null,

      shadow_model: shadowUsage.model,
      shadow_input_tokens: shadowUsage.totalInputTokens,
      shadow_output_tokens: shadowUsage.totalOutputTokens,
      shadow_cached_tokens: shadowUsage.totalCachedTokens,
      shadow_cost_usd: shadowUsage.totalCostUsd,
      shadow_usage_by_label: Object.keys(shadowUsage.byLabel).length ? shadowUsage.byLabel : null
    });

    const { error } = await supabase.from(TABLE).insert(extendedRow);
    if (error) {
      console.warn("[certamen-comparison-store] Erreur insert Supabase avec colonnes étendues, repli sur le schéma de base (migration pas encore appliquée ?) :", error.message);
      const fallback = await supabase.from(TABLE).insert(baseRow);
      if (fallback.error) {
        console.warn("[certamen-comparison-store] Erreur insert Supabase (ignorée, sans effet sur Certamen) :", fallback.error.message);
      }
    }
  } catch (err) {
    console.warn("[certamen-comparison-store] Exception lors de la persistance (ignorée) :", err.message);
  }
}

module.exports = { recordCertamenComparison, aggregateCertamenUsageRecords };
