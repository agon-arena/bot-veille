// Point de centralisation unique de la télémétrie des appels IA (audit du 22/08/2026 :
// 23 sites d'appel OpenAI dans 6 fichiers, chacun avec sa propre fonction logAiUsage
// dupliquée). Objectif : mesurer le coût réel du bot en production (server.js + veille-mixte.js
// tournent dans deux process Node séparés — chacun require ce module indépendamment, d'où
// setProcessName() pour savoir lequel a émis quoi).
//
// Règle absolue : une erreur d'instrumentation ne doit JAMAIS faire échouer un appel IA
// métier. Toute fonction exportée ici est donc défensive de bout en bout (try/catch large,
// écriture disque asynchrone et non bloquante, jamais de throw vers l'appelant).

const fs = require("fs");
const path = require("path");

const USAGE_LOG_FILE = path.join(__dirname, "ai-usage.jsonl");

// Tarifs officiels OpenAI, $ par million de tokens — vérifiés le 22/08/2026 sur
// developers.openai.com/api/docs/pricing (cf. audit IA du bot de veille). Seule source de
// vérité pour le coût estimé : ne pas dupliquer ces chiffres ailleurs dans le code. Un
// modèle absent de cette table donne un coût "null" plutôt qu'une estimation inventée —
// à compléter ici, jamais en inline, si un nouveau modèle apparaît dans les logs.
const MODEL_PRICING = {
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.40 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2.00 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10.00 },
  "gpt-4.1-nano": { input: 0.10, cachedInput: 0.025, output: 0.40 },
  "gpt-4.1-mini": { input: 0.40, cachedInput: 0.10, output: 1.60 },
  "gpt-4.1": { input: 2.00, cachedInput: 0.50, output: 8.00 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.60 },
  "gpt-4o": { input: 2.50, cachedInput: 1.25, output: 10.00 }
};

let processName = "?";
let currentRunTag = null;

// Nom du process courant ("server" ou "veille-mixte") — à appeler une fois au démarrage de
// chaque fichier point d'entrée. Purement informatif (champ "process" des enregistrements).
function setProcessName(name) {
  processName = String(name || "?");
}

// Étiquette de run optionnelle (ex: "bench-old-<ts>" / "bench-new-<ts>"), utilisée par le
// harnais de benchmark Certamen pour isoler ses propres appels dans ai-usage.jsonl sans
// toucher au format des 23 sites d'appel existants. null = comportement normal (aucune étiquette).
function setRunTag(tag) {
  currentRunTag = tag || null;
}

function getRunTag() {
  return currentRunTag;
}

// La réponse de l'API renvoie souvent un nom de modèle daté (ex: "gpt-4.1-mini-2025-04-14")
// alors que MODEL_PRICING est indexé sur le nom court utilisé dans le code. Correspondance
// exacte d'abord, puis préfixe le plus long qui matche (pour ne jamais confondre
// "gpt-4.1-mini" et "gpt-4.1").
function findPricing(model) {
  if (!model) return null;
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const bases = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const base of bases) {
    if (model.startsWith(base)) return MODEL_PRICING[base];
  }
  return null;
}

function computeCost(model, inputTokens, outputTokens, cachedTokens) {
  const pricing = findPricing(model);
  if (!pricing || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const cached = Number.isFinite(cachedTokens) && cachedTokens > 0 ? cachedTokens : 0;
  const uncachedInput = Math.max(0, inputTokens - cached);
  const cost = (uncachedInput / 1e6) * pricing.input
    + (cached / 1e6) * (pricing.cachedInput ?? pricing.input)
    + (outputTokens / 1e6) * pricing.output;
  return Math.round(cost * 1e8) / 1e8;
}

// Les deux formes d'API du projet (Responses : input_tokens/output_tokens ;
// Chat Completions, encore utilisée par checkCertamenPositionAlignment : prompt_tokens/
// completion_tokens) exposent le cache à des endroits différents.
function extractUsage(response) {
  const u = (response && response.usage) || {};
  const inputTokens = u.input_tokens ?? u.prompt_tokens ?? null;
  const outputTokens = u.output_tokens ?? u.completion_tokens ?? null;
  const cachedTokens = u.input_tokens_details?.cached_tokens
    ?? u.prompt_tokens_details?.cached_tokens
    ?? null;
  const model = (response && response.model) || null;
  return { inputTokens, outputTokens, cachedTokens, model };
}

// Écriture SYNCHRONE et volontaire (pas fs.appendFile) : un process qui appelle
// process.exit() juste après un appel IA (cas réel du mode --certamen-batch-benchmark, qui
// sort dès sa dernière promesse résolue) perdrait silencieusement une écriture asynchrone
// encore en vol. Le coût réel est négligeable : un appel IA prend, au minimum, plusieurs
// dizaines de ms de réseau, contre une poignée de µs pour ajouter une ligne à un fichier.
function appendRecord(record) {
  let line;
  try {
    line = JSON.stringify(record) + "\n";
  } catch (error) {
    return; // objet non sérialisable : on abandonne l'écriture, jamais de throw
  }
  try {
    fs.appendFileSync(USAGE_LOG_FILE, line);
  } catch (error) {
    try { console.warn("[ai-usage-tracker] écriture ai-usage.jsonl impossible :", error.message); } catch (_) {}
  }
}

function logHumanLine(record) {
  const costLabel = typeof record.estimated_cost === "number" ? `$${record.estimated_cost.toFixed(6)}` : "?";
  const parts = [
    `[ai-usage] ${record.label}`,
    `feature=${record.feature}`,
    `model=${record.model || "?"}`,
    `in=${record.input_tokens ?? "?"}`,
    `out=${record.output_tokens ?? "?"}`,
    record.cached_tokens ? `cached=${record.cached_tokens}` : null,
    `latency=${record.latency_ms ?? "?"}ms`,
    `cost=${costLabel}`,
    record.batch_size ? `batch=${record.items_processed ?? "?"}/${record.batch_size}` : null,
    record.success ? null : `error=${record.error}`
  ].filter(Boolean);
  try { console.log(parts.join(" | ")); } catch (_) {}
}

// Point d'entrée bas niveau : construit et persiste un enregistrement à partir d'une
// réponse OpenAI (succès) ou d'une erreur (échec). Ne lève jamais — voir la règle absolue
// en tête de fichier.
function recordAiUsage(entry) {
  try {
    const {
      feature, label, response, error, latencyMs, success,
      batchSize, itemsProcessed, sourceType, model: fallbackModel
    } = entry || {};

    const usage = response ? extractUsage(response) : { inputTokens: null, outputTokens: null, cachedTokens: null, model: null };
    const model = usage.model || fallbackModel || null;
    const cost = success ? computeCost(model, usage.inputTokens, usage.outputTokens, usage.cachedTokens) : null;

    const record = {
      ts: new Date().toISOString(),
      feature: feature || "unclassified",
      label: label || "?",
      model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_tokens: usage.cachedTokens,
      latency_ms: Number.isFinite(latencyMs) ? latencyMs : null,
      success: !!success,
      error: success ? null : String((error && error.message) || error || "erreur inconnue").slice(0, 300),
      estimated_cost: cost,
      batch_size: Number.isFinite(batchSize) ? batchSize : null,
      items_processed: Number.isFinite(itemsProcessed) ? itemsProcessed : null,
      source_type: sourceType || null,
      process: processName,
      run_tag: currentRunTag
    };

    appendRecord(record);
    logHumanLine(record);
  } catch (loggingError) {
    try { console.warn("[ai-usage-tracker] échec instrumentation (ignoré) :", loggingError.message); } catch (_) {}
  }
}

// Point d'entrée principal pour les 23 sites d'appel : enveloppe un appel OpenAI, mesure la
// latence réelle, enregistre succès/échec avec tous les champs demandés, puis relance
// l'erreur telle quelle (comportement métier inchangé — le fallback/retry existant à chaque
// site d'appel continue de fonctionner à l'identique).
async function withAiUsage(meta, fn) {
  const startedAt = Date.now();
  try {
    const response = await fn();
    recordAiUsage({ ...meta, response, latencyMs: Date.now() - startedAt, success: true });
    return response;
  } catch (error) {
    recordAiUsage({ ...meta, error, latencyMs: Date.now() - startedAt, success: false });
    throw error;
  }
}

// Nomenclature volontairement restreinte (demande explicite : pas de taxonomie
// surdimensionnée) — un label de site d'appel se range dans une de ces familles.
const FEATURE_BY_LABEL = {
  "resume-factuel": "summary",
  "analyse-debat": "generation",
  "verif-alignement-debat": "classification",
  "align-positions": "classification",
  "article-style": "generation",
  "finalisation-article": "generation",
  "arene-libre": "generation",
  "devise-latine": "generation",
  "suggestion-lien": "subject_selection",
  "raccourci-titre": "classification",
  "idees-ia": "generation",
  "theme-agon": "classification",
  "tags-sujet": "classification",
  "analyze-sujet": "mixed_watch_scoring",
  "score-unitaire": "mixed_watch_scoring",
  "verif-sources": "classification",
  "score-lot": "mixed_watch_scoring",
  "dedup": "deduplication",
  "dedup-retry": "deduplication",
  "certamen-analyze": "certamen_candidate_analysis",
  "certamen-analyze-batch": "certamen_candidate_analysis",
  "certamen-judgment": "certamen_candidate_analysis",
  "certamen-creative-generation": "generation",
  "certamen-creative-generation-strict": "generation",
  "certamen-creative-retry": "generation",
  "certamen-align-positions": "classification",
  "certamen-dedup-lot": "deduplication",
  "certamen-position-alignment": "classification",
  "certamen-idees-ia": "generation"
};

function featureForLabel(label) {
  return FEATURE_BY_LABEL[label] || "unclassified";
}

function readAllRecords() {
  try {
    const raw = fs.readFileSync(USAGE_LOG_FILE, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (error) {
    return [];
  }
}

function summarizeRecords(records) {
  const totals = {
    calls: 0, successCalls: 0, errorCalls: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0,
    cost: 0, costKnown: true,
    latencyMsSum: 0, latencyMsCount: 0
  };
  const byFeature = {};
  const byModel = {};
  const byLabel = {};

  for (const r of records) {
    totals.calls += 1;
    if (r.success) totals.successCalls += 1; else totals.errorCalls += 1;
    totals.inputTokens += Number(r.input_tokens) || 0;
    totals.outputTokens += Number(r.output_tokens) || 0;
    totals.cachedTokens += Number(r.cached_tokens) || 0;
    if (typeof r.estimated_cost === "number") totals.cost += r.estimated_cost;
    else if (r.success) totals.costKnown = false;
    if (typeof r.latency_ms === "number") { totals.latencyMsSum += r.latency_ms; totals.latencyMsCount += 1; }

    const feat = r.feature || "unclassified";
    byFeature[feat] = byFeature[feat] || { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, costKnown: true, latencyMsSum: 0, latencyMsCount: 0 };
    byFeature[feat].calls += 1;
    byFeature[feat].inputTokens += Number(r.input_tokens) || 0;
    byFeature[feat].outputTokens += Number(r.output_tokens) || 0;
    if (typeof r.estimated_cost === "number") byFeature[feat].cost += r.estimated_cost;
    else if (r.success) byFeature[feat].costKnown = false;
    if (typeof r.latency_ms === "number") { byFeature[feat].latencyMsSum += r.latency_ms; byFeature[feat].latencyMsCount += 1; }

    const model = r.model || "?";
    byModel[model] = byModel[model] || { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, latencyMsSum: 0, latencyMsCount: 0 };
    byModel[model].calls += 1;
    byModel[model].inputTokens += Number(r.input_tokens) || 0;
    byModel[model].outputTokens += Number(r.output_tokens) || 0;
    if (typeof r.estimated_cost === "number") byModel[model].cost += r.estimated_cost;
    if (typeof r.latency_ms === "number") { byModel[model].latencyMsSum += r.latency_ms; byModel[model].latencyMsCount += 1; }

    const label = r.label || "?";
    byLabel[label] = byLabel[label] || { calls: 0, batches: 0, itemsProcessed: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    byLabel[label].calls += 1;
    // Un batch_size de 1 (appel unitaire, ex. repli Certamen) n'est pas un "lot" au sens
    // où l'utilisateur veut le compter ici — seuls les appels regroupant réellement
    // plusieurs éléments comptent comme lot.
    if (r.batch_size > 1) byLabel[label].batches += 1;
    byLabel[label].itemsProcessed += Number(r.items_processed) || (r.batch_size ? 0 : 1);
    byLabel[label].inputTokens += Number(r.input_tokens) || 0;
    byLabel[label].outputTokens += Number(r.output_tokens) || 0;
    if (typeof r.estimated_cost === "number") byLabel[label].cost += r.estimated_cost;
  }

  totals.avgLatencyMs = totals.latencyMsCount ? Math.round(totals.latencyMsSum / totals.latencyMsCount) : null;
  for (const feat of Object.keys(byFeature)) {
    byFeature[feat].avgLatencyMs = byFeature[feat].latencyMsCount ? Math.round(byFeature[feat].latencyMsSum / byFeature[feat].latencyMsCount) : null;
  }
  for (const model of Object.keys(byModel)) {
    byModel[model].avgLatencyMs = byModel[model].latencyMsCount ? Math.round(byModel[model].latencyMsSum / byModel[model].latencyMsCount) : null;
  }
  for (const label of Object.keys(byLabel)) {
    byLabel[label].avgBatchSize = byLabel[label].batches ? Number((byLabel[label].itemsProcessed / byLabel[label].batches).toFixed(2)) : null;
  }

  const certamenLabels = ["certamen-analyze", "certamen-analyze-batch"];
  const mixteLabels = ["score-lot", "score-unitaire"];
  const summarizeLabels = (labels) => labels.reduce((acc, l) => {
    const s = byLabel[l];
    if (!s) return acc;
    acc.calls += s.calls;
    acc.batches += s.batches;
    acc.itemsProcessed += s.itemsProcessed;
    acc.cost += s.cost;
    return acc;
  }, { calls: 0, batches: 0, itemsProcessed: 0, cost: 0 });

  return {
    totals,
    byFeature,
    byModel,
    byLabel,
    pipelines: {
      certamen: summarizeLabels(certamenLabels),
      veille_mixte: summarizeLabels(mixteLabels)
    }
  };
}

// Statistiques agrégées, filtrées sur une fenêtre glissante (ex: 24h) et/ou une étiquette
// de run (benchmark). Lecture synchrone volontaire : appelée à la demande depuis une route
// admin, jamais dans le chemin critique d'un appel IA.
function computeStats({ sinceMs = null, runTag = null } = {}) {
  const all = readAllRecords();
  const cutoff = sinceMs != null ? Date.now() - sinceMs : null;
  const filtered = all.filter((r) => {
    if (cutoff != null) {
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t) || t < cutoff) return false;
    }
    if (runTag != null && r.run_tag !== runTag) return false;
    return true;
  });
  return { totalRecords: all.length, windowRecords: filtered.length, ...summarizeRecords(filtered) };
}

function recordsForRunTag(runTag) {
  return readAllRecords().filter((r) => r.run_tag === runTag);
}

module.exports = {
  USAGE_LOG_FILE,
  MODEL_PRICING,
  setProcessName,
  setRunTag,
  getRunTag,
  featureForLabel,
  computeCost,
  recordAiUsage,
  withAiUsage,
  computeStats,
  summarizeRecords,
  readAllRecords,
  recordsForRunTag
};
