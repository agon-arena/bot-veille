// Tests de non-régression pour ai-usage-tracker.js (phase 1 d'optimisation, 22/08/2026).
// Pas de framework de test dans ce projet : assertions Node natives, exécution directe
// via `node test-ai-usage-tracker.js`. Couvre : calcul de coût, extraction d'usage (API
// Responses ET Chat Completions), résilience aux erreurs/données invalides, withAiUsage
// (succès/échec), agrégation (summarizeRecords/computeStats).

const assert = require("assert");
const tracker = require("./ai-usage-tracker");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

async function main() {

test("computeCost : gpt-4.1-mini, prix connus", () => {
  const cost = tracker.computeCost("gpt-4.1-mini", 1000, 500, 0);
  // (1000/1e6)*0.40 + (500/1e6)*1.60 = 0.0004 + 0.0008 = 0.0012
  assert.strictEqual(cost, 0.0012);
});

test("computeCost : nom de modèle daté (préfixe le plus long)", () => {
  const cost = tracker.computeCost("gpt-4.1-mini-2025-04-14", 1000, 500, 0);
  assert.strictEqual(cost, 0.0012);
});

test("computeCost : gpt-5-nano avec cached_tokens (tarif caché appliqué à la portion cachée)", () => {
  const cost = tracker.computeCost("gpt-5-nano", 1000, 200, 800);
  // 800 cached à 0.005$/M, 200 non-cached à 0.05$/M, 200 out à 0.40$/M
  const expected = (200 / 1e6) * 0.05 + (800 / 1e6) * 0.005 + (200 / 1e6) * 0.40;
  assert.ok(Math.abs(cost - expected) < 1e-9);
});

test("computeCost : modèle inconnu -> null (jamais de prix inventé)", () => {
  assert.strictEqual(tracker.computeCost("modele-qui-n-existe-pas", 1000, 500, 0), null);
});

test("computeCost : tokens manquants -> null", () => {
  assert.strictEqual(tracker.computeCost("gpt-4.1-mini", null, 500, 0), null);
  assert.strictEqual(tracker.computeCost("gpt-4.1-mini", 1000, undefined, 0), null);
});

test("featureForLabel : nomenclature restreinte, connue et par défaut", () => {
  assert.strictEqual(tracker.featureForLabel("score-lot"), "mixed_watch_scoring");
  assert.strictEqual(tracker.featureForLabel("certamen-analyze-batch"), "certamen_candidate_analysis");
  assert.strictEqual(tracker.featureForLabel("label-inexistant"), "unclassified");
});

test("recordAiUsage : ne lève jamais, même avec une entrée totalement invalide", () => {
  assert.doesNotThrow(() => tracker.recordAiUsage(undefined));
  assert.doesNotThrow(() => tracker.recordAiUsage(null));
  assert.doesNotThrow(() => tracker.recordAiUsage({ response: { usage: "pas un objet" } }));
  assert.doesNotThrow(() => tracker.recordAiUsage({ response: { toJSON() { throw new Error("boom"); } } }));
});

await testAsync("withAiUsage : succès -> renvoie la réponse, enregistre success=true avec latence mesurée", async () => {
  const tag = `test-success-${Date.now()}`;
  tracker.setRunTag(tag);
  const fakeResponse = {
    model: "gpt-4.1-mini-2025-04-14",
    output_text: "ok",
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10 } }
  };
  const result = await tracker.withAiUsage(
    { feature: "classification", label: "test-label", sourceType: "unit_test" },
    () => new Promise((resolve) => setTimeout(() => resolve(fakeResponse), 5))
  );
  assert.strictEqual(result, fakeResponse);
  tracker.setRunTag(null);

  const records = tracker.recordsForRunTag(tag);
  assert.strictEqual(records.length, 1);
  const r = records[0];
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.feature, "classification");
  assert.strictEqual(r.label, "test-label");
  assert.strictEqual(r.model, "gpt-4.1-mini-2025-04-14");
  assert.strictEqual(r.input_tokens, 100);
  assert.strictEqual(r.output_tokens, 20);
  assert.strictEqual(r.cached_tokens, 10);
  assert.strictEqual(r.source_type, "unit_test");
  assert.ok(typeof r.latency_ms === "number" && r.latency_ms >= 0);
  assert.strictEqual(typeof r.estimated_cost, "number");
  assert.strictEqual(r.error, null);
});

await testAsync("withAiUsage : échec -> relance l'erreur d'origine ET enregistre success=false", async () => {
  const tag = `test-failure-${Date.now()}`;
  tracker.setRunTag(tag);
  const boom = new Error("panne API simulée");
  await assert.rejects(
    () => tracker.withAiUsage(
      { feature: "classification", label: "test-label-erreur", sourceType: "unit_test" },
      () => Promise.reject(boom)
    ),
    (err) => err === boom
  );
  tracker.setRunTag(null);

  const records = tracker.recordsForRunTag(tag);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].success, false);
  assert.strictEqual(records[0].error, "panne API simulée");
  assert.strictEqual(records[0].estimated_cost, null);
  assert.strictEqual(records[0].input_tokens, null);
});

await testAsync("withAiUsage : format Chat Completions (prompt_tokens/completion_tokens) reconnu", async () => {
  const tag = `test-chatcompletions-${Date.now()}`;
  tracker.setRunTag(tag);
  await tracker.withAiUsage(
    { feature: "classification", label: "test-chat", sourceType: "unit_test" },
    () => Promise.resolve({
      model: "gpt-4o-mini-2024-07-18",
      usage: { prompt_tokens: 300, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0 } }
    })
  );
  tracker.setRunTag(null);
  const records = tracker.recordsForRunTag(tag);
  assert.strictEqual(records[0].input_tokens, 300);
  assert.strictEqual(records[0].output_tokens, 40);
  assert.ok(typeof records[0].estimated_cost === "number");
});

test("summarizeRecords : agrégation totals/byFeature/byModel/byLabel + pipelines certamen/mixte", () => {
  const records = [
    { feature: "mixed_watch_scoring", label: "score-lot", model: "gpt-5-nano", input_tokens: 1000, output_tokens: 100, cached_tokens: 0, estimated_cost: 0.001, success: true, latency_ms: 500, batch_size: 8, items_processed: 8 },
    { feature: "certamen_candidate_analysis", label: "certamen-analyze-batch", model: "gpt-4.1-mini", input_tokens: 5000, output_tokens: 900, cached_tokens: 0, estimated_cost: 0.003, success: true, latency_ms: 1500, batch_size: 8, items_processed: 8 },
    { feature: "certamen_candidate_analysis", label: "certamen-analyze", model: "gpt-4.1-mini", input_tokens: 1300, output_tokens: 120, cached_tokens: 0, estimated_cost: 0.0007, success: true, latency_ms: 900, batch_size: 1, items_processed: 1 },
    { feature: "classification", label: "align-positions", model: "gpt-4.1-mini", input_tokens: null, output_tokens: null, cached_tokens: null, estimated_cost: null, success: false, latency_ms: 200, error: "timeout" }
  ];
  const summary = tracker.summarizeRecords(records);
  assert.strictEqual(summary.totals.calls, 4);
  assert.strictEqual(summary.totals.successCalls, 3);
  assert.strictEqual(summary.totals.errorCalls, 1);
  assert.strictEqual(summary.totals.inputTokens, 1000 + 5000 + 1300);
  assert.ok(Math.abs(summary.totals.cost - (0.001 + 0.003 + 0.0007)) < 1e-9);
  assert.strictEqual(summary.byFeature["mixed_watch_scoring"].calls, 1);
  assert.strictEqual(summary.byModel["gpt-4.1-mini"].calls, 3);
  assert.strictEqual(summary.byLabel["score-lot"].batches, 1);
  assert.strictEqual(summary.byLabel["score-lot"].avgBatchSize, 8);
  assert.strictEqual(summary.pipelines.certamen.calls, 2);
  assert.strictEqual(summary.pipelines.certamen.itemsProcessed, 9); // batch:8 + fallback unitaire:1
  assert.strictEqual(summary.pipelines.veille_mixte.calls, 1);
});

test("computeStats : ne lève jamais si ai-usage.jsonl est absent/corrompu (lecture défensive)", () => {
  assert.doesNotThrow(() => tracker.computeStats({ sinceMs: 60 * 60 * 1000 }));
});

console.log(`\n${passed} test(s) réussi(s).`);
if (process.exitCode) {
  console.error("Des tests ont échoué.");
} else {
  console.log("Tous les tests sont passés.");
}

}

main();
