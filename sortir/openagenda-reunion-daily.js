"use strict";
const { fetchOpenAgendaJsonEvents } = require("./connectors/openagenda-json");
const { PRODUCERS, prepareItemForV1 } = require("./openagenda-reunion-v1");
const { createOpenAgendaBatchPersister } = require("./openagenda-batch-persister");
const REUNION_SOURCES = Object.freeze(PRODUCERS.map(p => Object.freeze({ ...p, key: `openagenda-${p.agendaUid}-json`, connectorType: "openagenda_json", baseUrl: `https://api.openagenda.com/v2/agendas/${p.agendaUid}/events` })));
async function loadAgendaSchema(uid, apiKey) {
  const r = await fetch(`https://api.openagenda.com/v2/agendas/${uid}`, { headers: { key: apiKey }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Configuration OpenAgenda ${uid} : HTTP ${r.status}`);
  return (await r.json()).schema;
}
async function runReunionProducer({ source, store, now, fetchEvents = fetchOpenAgendaJsonEvents, fetchSchema = loadAgendaSchema }) {
  const agendaSchema = await fetchSchema(source.agendaUid, process.env.OPENAGENDA_PUBLIC_KEY);
  const results = [];
  const fetched = await fetchEvents({ ...source, apiKey: process.env.OPENAGENDA_PUBLIC_KEY, now, fetchedAt: now.toISOString(),
    maxEvents: 200, pageSize: 50, geoBounding: { northEast: { lat: -20.6, lng: 56 }, southWest: { lat: -21.5, lng: 55 } }, agendaSchema,
    onBatch: async batch => { for (const item of batch) { const selected = prepareItemForV1(item); if (selected) results.push(selected); } }
  });
  // Ne rien écrire sur une lecture incomplète ; aucune disparition réconciliée par ce pilote.
  if (fetched.truncated) throw new Error(`Lecture OpenAgenda tronquée : ${source.key}`);
  const persist = createOpenAgendaBatchPersister({ store, now, batchSize: 100 });
  try {
    const outcomes = await persist({ ...source, results });
    return { status: "completed", eventsCollected: fetched.fetchedCount, eventsRetained: new Set(results.map(r => r.sourcePayload?.eventUid).filter(Boolean)).size,
      occurrencesCollected: fetched.occurrencesProduced, occurrencesRetained: results.length, outcomes,
      stats: outcomes.reduce((a, o) => { for (const k of ["collected", "VALID", "NEEDS_REVIEW", "INVALID", "merged", "toReview"]) a[k] = (a[k] || 0) + (o.stats[k] || 0); return a; }, {}) };
  } catch (error) {
    error.details = { eventsCollected: fetched.fetchedCount, eventsRetained: new Set(results.map(r => r.sourcePayload?.eventUid).filter(Boolean)).size,
      occurrencesCollected: fetched.occurrencesProduced, occurrencesRetained: results.length,
      stats: (error.outcomes || []).reduce((a, o) => { for (const k of ["collected", "VALID", "NEEDS_REVIEW", "INVALID", "merged", "toReview"]) a[k] = (a[k] || 0) + (o.stats[k] || 0); return a; }, {}) };
    throw error;
  } finally { persist.purgeCandidateCache(); }
}
module.exports = { REUNION_SOURCES, runReunionProducer, loadAgendaSchema };
