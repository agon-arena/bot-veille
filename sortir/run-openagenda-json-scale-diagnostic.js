"use strict";

// Runner diagnostic STRICTEMENT LOCAL — créé pour mesurer le comportement réel du connecteur
// OpenAgenda JSON à une échelle significative, sans aucune écriture Supabase ni persistance.
// Ne modifie pas connectors/openagenda-json.js : on l'appelle tel quel et on instrumente
// uniquement fetch() (intercepté puis restauré) pour observer chaque page HTTP demandée.
// Volontairement NON COMMITÉ (voir compte rendu transmis à l'utilisateur).

require("dotenv").config();
const { fetchOpenAgendaJsonEvents } = require("./connectors/openagenda-json");

const MAX_OCCURRENCES_PER_EVENT_DEFAULT = 20; // cf. connectors/openagenda-json.js:12 (non exporté)

function eventTitle(event) {
  const title = event && event.title;
  if (!title) return null;
  if (typeof title === "string") return title;
  if (typeof title === "object") return title.fr || Object.values(title).find(Boolean) || null;
  return null;
}

// Instrumente global.fetch pendant la durée de l'appel, puis le restaure. Ne journalise
// jamais la clé API (transmise en en-tête HTTP par le connecteur, jamais dans l'URL).
async function withInstrumentedFetch(run) {
  const pages = [];
  const rawEvents = [];
  const original = global.fetch;
  global.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    // OpenAgenda renvoie un curseur `after` sous forme de tableau de 4 valeurs ; le connecteur
    // le retransmet donc via `after[]` (répété), jamais via une clé `after` scalaire.
    const requestedAfter = url.searchParams.getAll("after[]").length ? url.searchParams.getAll("after[]") : null;
    const startedAt = Date.now();
    const response = await original(input, init);
    const durationMs = Date.now() - startedAt;
    const clone = response.clone();
    let body = null;
    try { body = await clone.json(); } catch (_) { /* non-JSON, laissé à la charge du connecteur */ }
    const events = body && Array.isArray(body.events) ? body.events : [];
    pages.push({
      requestedAfter,
      status: response.status,
      total: body && body.total,
      eventsInPage: events.length,
      nextAfter: (body && body.after) || null,
      durationMs
    });
    for (const event of events) {
      rawEvents.push({
        uid: event && event.uid,
        title: eventTitle(event),
        timingsCount: Array.isArray(event && event.timings) ? event.timings.length : 0
      });
    }
    return response;
  };
  try {
    const result = await run();
    return { result, pages, rawEvents };
  } finally {
    global.fetch = original;
  }
}

function analyzePages(pages) {
  const afters = pages.map((p) => p.requestedAfter && p.requestedAfter.join("|")).filter(Boolean);
  const seenAfters = new Set();
  const repeatedAfter = [];
  for (const value of afters) {
    if (seenAfters.has(value)) repeatedAfter.push(value);
    seenAfters.add(value);
  }
  const lastPage = pages[pages.length - 1];
  const terminatedCleanly = Boolean(lastPage) && !lastPage.nextAfter;
  return { pagesRequested: pages.length, repeatedAfterValues: repeatedAfter, terminatedCleanly, lastPage };
}

function analyzeRawEvents(rawEvents) {
  const uidCounts = new Map();
  for (const event of rawEvents) uidCounts.set(event.uid, (uidCounts.get(event.uid) || 0) + 1);
  const duplicateUids = [...uidCounts.entries()].filter(([, count]) => count > 1);
  const distinctEvents = uidCounts.size;
  const totalTimings = rawEvents.reduce((sum, e) => sum + e.timingsCount, 0);
  const withMultipleOccurrences = rawEvents.filter((e) => e.timingsCount > 1).length;
  const maxOccurrences = rawEvents.reduce((max, e) => Math.max(max, e.timingsCount), 0);
  const exceedingDefaultGuard = rawEvents
    .filter((e) => e.timingsCount > MAX_OCCURRENCES_PER_EVENT_DEFAULT)
    .sort((a, b) => b.timingsCount - a.timingsCount);
  return { distinctEvents, duplicateUids, totalTimings, withMultipleOccurrences, maxOccurrences, exceedingDefaultGuard };
}

function analyzeResults(results) {
  const stats = { VALID: 0, NEEDS_REVIEW: 0, INVALID: 0, errors: 0, truncatedWarnings: 0 };
  const occurrenceIds = []; // attendu UNIQUE par activité (1 occurrenceKey = 1 NormalizedActivity)
  const eventIds = []; // attendu PARTAGÉ entre les occurrences d'un même événement récurrent (non un défaut)
  for (const item of results) {
    if (item.error || !item.validation) { stats.errors += 1; continue; }
    stats[item.validation.status] = (stats[item.validation.status] || 0) + 1;
    if (item.validation.warnings.some((w) => w.code === "occurrences_truncated")) stats.truncatedWarnings += 1;
    for (const id of item.activity.externalIds) {
      if (id.system === "openagenda-occurrence") occurrenceIds.push(id.value);
      if (id.system === "openagenda-event") eventIds.push(id.value);
    }
  }
  const duplicateOccurrenceIds = occurrenceIds.length - new Set(occurrenceIds).size;
  const distinctEventIdsReferenced = new Set(eventIds).size;
  return { ...stats, totalActivities: results.length, occurrenceIdsUnique: duplicateOccurrenceIds === 0, duplicateOccurrenceIds, distinctEventIdsReferenced };
}

async function runFullScaleTest() {
  const apiKey = process.env.OPENAGENDA_PUBLIC_KEY;
  if (!apiKey) throw new Error("OPENAGENDA_PUBLIC_KEY absente (.env)");
  const agendaUid = 56170473; // Senlis — Agenda officiel de la ville, déjà configurée en base (source openagenda-senlis-json)

  const startedAt = Date.now();
  const { result, pages, rawEvents } = await withInstrumentedFetch(() =>
    fetchOpenAgendaJsonEvents({
      agendaUid,
      apiKey,
      maxEvents: 200, // > 110 événements "upcoming" mesurés ce jour : pas de troncature artificielle
      sourceName: "Senlis — Agenda officiel de la ville",
      fetchedAt: new Date().toISOString()
    })
  );
  const durationMs = Date.now() - startedAt;

  return {
    label: "collecte complète (maxEvents=200, > total réel)",
    agendaUid,
    durationMs,
    apiTotal: result.total,
    fetchedCount: result.fetchedCount,
    truncatedByMaxEvents: result.truncated,
    pageAnalysis: analyzePages(pages),
    rawEventAnalysis: analyzeRawEvents(rawEvents),
    resultAnalysis: analyzeResults(result.results),
    pages
  };
}

async function runMaxEventsCapTest() {
  const apiKey = process.env.OPENAGENDA_PUBLIC_KEY;
  const agendaUid = 56170473;
  const { result, pages } = await withInstrumentedFetch(() =>
    fetchOpenAgendaJsonEvents({ agendaUid, apiKey, maxEvents: 30, sourceName: "Senlis (test plafond maxEvents)", fetchedAt: new Date().toISOString() })
  );
  return { label: "plafond maxEvents=30 (< total réel, < taille de page 50)", apiTotal: result.total, fetchedCount: result.fetchedCount, truncatedByMaxEvents: result.truncated, pageAnalysis: analyzePages(pages) };
}

async function runInvalidAgendaErrorTest() {
  const apiKey = process.env.OPENAGENDA_PUBLIC_KEY;
  try {
    await fetchOpenAgendaJsonEvents({ agendaUid: 999999999, apiKey, maxEvents: 5, sourceName: "agenda inexistant (test erreur réseau/API)" });
    return { threw: false };
  } catch (error) {
    return { threw: true, message: error.message };
  }
}

async function main() {
  const fullScale = await runFullScaleTest();
  const capTest = await runMaxEventsCapTest();
  const errorTest = await runInvalidAgendaErrorTest();
  console.log(JSON.stringify({ fullScale, capTest, errorTest }, null, 2));
}

main().catch((error) => { console.error("ÉCHEC DIAGNOSTIC:", error.message); process.exitCode = 1; });
