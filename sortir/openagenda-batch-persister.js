"use strict";
const { persistSortirIngestion } = require("./supabase-persistence");
const { createWriteBehindStore } = require("./write-behind-store");
const { CompactCandidateCache } = require("./compact-candidate-cache");

// Adaptateur partagé par le pilote et le scheduler. Réutilise les mêmes décisions et la même
// enveloppe d'écritures groupées que le pipeline existant ; aucun client n'est créé ici.
// Les tranches/deltas ne certifient pas la couverture d'une source : pas de disparition.
function createOpenAgendaBatchPersister({ store, now, batchSize = 100 }) {
  if (!store || now == null || !Number.isFinite(+new Date(now))) throw new Error("Store et instant explicites obligatoires");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("Taille de tranche OpenAgenda invalide");
  for (const method of ["createActivitiesBatch", "createProvenancesBatch", "upsertExternalIdsBatch", "flipActivitiesBatch", "insertDedupDecisionsBatch"]) {
    if (typeof store[method] !== "function") throw new Error(`Primitive groupée obligatoire : ${method}`);
  }
  const target = createWriteBehindStore(store);
  const candidateCache = new CompactCandidateCache();
  const persist = async ({ key, baseUrl, results }) => {
    if (!key || !baseUrl) throw new Error("Identité de source OpenAgenda obligatoire");
    const outcomes = [];
    let batch = [];
    async function flush() {
      if (!batch.length) return;
      const result = await persistSortirIngestion({ store: target, now: new Date(now), reconcileDisappearances: false, candidateCache,
        sources: [{ key, baseUrl, connectorType: "openagenda_json", results: batch }] });
      outcomes.push(result);
      if (result.status !== "completed") throw new Error("Tranche OpenAgenda incomplète : arrêt et rejeu nécessaires");
      batch = [];
    }
    try {
      for (const item of results) { batch.push(item); if (batch.length === batchSize) await flush(); }
      await flush();
      return outcomes;
    } catch (error) {
      error.outcomes = outcomes;
      throw error;
    }
  };
  persist.stats = target.writeBehindStats;
  persist.candidateCache = candidateCache;
  persist.purgeCandidateCache = () => candidateCache.purge();
  return persist;
}
module.exports = { createOpenAgendaBatchPersister };
