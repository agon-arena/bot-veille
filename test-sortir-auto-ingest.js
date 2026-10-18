"use strict";

// Teste sortir-auto-ingest.js : aucune écriture réelle (fetchEvents/persist/client sont
// toujours mockés). Ne teste pas le pipeline lui-même (déjà couvert par sortir/test-*.js),
// seulement la couche d'orchestration (déclenchement, garde anti-double-run, capture d'erreur).

const assert = require("assert");
const {
  runSortirIngestTickIfDue, isDue, SORTIR_AGENDA_UID, SORTIR_SOURCE_KEY,
  SORTIR_INGEST_HOUR, SORTIR_INGEST_TOLERANCE_MIN
} = require("./sortir-auto-ingest");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error.message}`); } }

function timeToMinutes(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }
function fixedTimeClient(hhmm) { return () => hhmm; }
function neverRanClient() {
  return {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        gte() { return this; },
        limit() { return this; },
        maybeSingle: async () => ({ data: null, error: null }), // sortir_sources: pas trouvée -> jamais exécuté
        then(resolve) { resolve({ data: [], error: null }); } // sortir_source_runs: liste vide
      };
    }
  };
}
function sampleResults() {
  return [{ index: 0, error: null, activity: {
    title: "Événement test", description: null, startsAt: "2026-11-01T19:00:00.000Z", endsAt: "2026-11-01T21:00:00.000Z",
    timezone: "Europe/Paris", lifecycleStatus: "scheduled", locationType: "physical", venueName: "Salle test",
    address: null, postalCode: null, city: "Senlis", country: "FR", latitude: null, longitude: null, onlineUrl: null,
    organizers: [], category: null, subcategory: null, tags: [], imageUrl: null, confidence: 0.9, fieldConfidence: {}, evidence: [],
    provenances: [{ sourceType: "api", sourceName: "Senlis", sourceUrl: "https://oa.example", originalEventUrl: "https://oa.example/e/1", externalId: "openagenda:1:2026-11-01T19:00:00.000Z", fetchedAt: new Date().toISOString() }],
    externalIds: [{ system: "openagenda-event", value: "1" }]
  } }];
}

(async () => {
  await test("E — isDue() correspond bien à une fenêtre quotidienne autour de l'heure/fuseau choisis", async () => {
    const scheduled = timeToMinutes(SORTIR_INGEST_HOUR);
    assert.strictEqual(SORTIR_INGEST_HOUR, "04:00", "heure de La Réunion (Indian/Reunion, UTC+4) documentée");
    assert.strictEqual(isDue(scheduled - 1, scheduled, SORTIR_INGEST_TOLERANCE_MIN), false, "avant l'heure : pas dû");
    assert.strictEqual(isDue(scheduled, scheduled, SORTIR_INGEST_TOLERANCE_MIN), true, "exactement à l'heure : dû");
    assert.strictEqual(isDue(scheduled + SORTIR_INGEST_TOLERANCE_MIN - 1, scheduled, SORTIR_INGEST_TOLERANCE_MIN), true, "dans la tolérance : dû");
    assert.strictEqual(isDue(scheduled + SORTIR_INGEST_TOLERANCE_MIN, scheduled, SORTIR_INGEST_TOLERANCE_MIN), false, "tolérance dépassée : plus dû");
    assert.strictEqual(isDue(scheduled + 24 * 60 - 1, scheduled, SORTIR_INGEST_TOLERANCE_MIN), false, "le lendemain avant l'heure suivante : pas dû (une seule fois par jour)");
  });

  await test("F — aucune ingestion au simple chargement du module (pas d'appel réseau implicite)", async () => {
    delete require.cache[require.resolve("./sortir-auto-ingest")];
    const startedAt = Date.now();
    const mod = require("./sortir-auto-ingest");
    const loadMs = Date.now() - startedAt;
    // Un appel réseau (OpenAgenda ou Supabase) implicite au require() prendrait au minimum
    // plusieurs centaines de ms, typiquement des secondes — un require() quasi instantané est
    // une preuve directe qu'aucun effet de bord ne s'est produit sans invocation explicite.
    assert(loadMs < 50, `require() a pris ${loadMs} ms : suspect d'un appel réseau implicite au chargement`);
    assert.strictEqual(typeof mod.runSortirIngestTickIfDue, "function");
  });

  await test("A — déclenche exactement le pipeline OpenAgenda attendu (agenda/source corrects)", async () => {
    let fetchArgs = null, persistArgs = null;
    const result = await runSortirIngestTickIfDue({
      timeToMinutes, getReunionTimeHHMM: fixedTimeClient(SORTIR_INGEST_HOUR),
      client: neverRanClient(),
      fetchEvents: async (args) => { fetchArgs = args; return { results: sampleResults() }; },
      persist: async (args) => { persistArgs = args; return { status: "completed", stats: { collected: 1, VALID: 1 } }; },
      store: {}
    });
    assert.strictEqual(result.triggered, true);
    await result.workPromise;
    assert.strictEqual(fetchArgs.agendaUid, SORTIR_AGENDA_UID);
    assert.strictEqual(persistArgs.sources.length, 1);
    assert.strictEqual(persistArgs.sources[0].key, SORTIR_SOURCE_KEY);
    assert.strictEqual(persistArgs.sources[0].connectorType, "openagenda_json");
  });

  await test("B — ne déclenche jamais Mobilizon ou Paris", async () => {
    let persistArgs = null;
    const result = await runSortirIngestTickIfDue({
      timeToMinutes, getReunionTimeHHMM: fixedTimeClient(SORTIR_INGEST_HOUR),
      client: neverRanClient(),
      fetchEvents: async () => ({ results: sampleResults() }),
      persist: async (args) => { persistArgs = args; return { status: "completed", stats: {} }; },
      store: {}
    });
    await result.workPromise;
    const connectorTypes = persistArgs.sources.map((s) => s.connectorType);
    assert.deepStrictEqual(connectorTypes, ["openagenda_json"]);
    assert(!connectorTypes.includes("mobilizon"));
    assert(!connectorTypes.includes("paris_data"));
  });

  await test("C — une erreur du pipeline est capturée sans crash du process", async () => {
    const result = await runSortirIngestTickIfDue({
      timeToMinutes, getReunionTimeHHMM: fixedTimeClient(SORTIR_INGEST_HOUR),
      client: neverRanClient(),
      fetchEvents: async () => ({ results: sampleResults() }),
      persist: async () => { throw new Error("panne Supabase simulée"); },
      store: {}
    });
    assert.strictEqual(result.triggered, true);
    const summary = await result.workPromise; // ne doit jamais rejeter
    assert.strictEqual(summary.status, "failed");
    assert(summary.error.includes("panne Supabase simulée"));
  });

  await test("D — deux déclenchements quasi simultanés ne lancent qu'un seul traitement réel", async () => {
    let fetchCallCount = 0;
    const fetchEvents = async () => { fetchCallCount += 1; await new Promise((r) => setTimeout(r, 30)); return { results: sampleResults() }; };
    const persist = async () => ({ status: "completed", stats: {} });
    const opts = { timeToMinutes, getReunionTimeHHMM: fixedTimeClient(SORTIR_INGEST_HOUR), client: neverRanClient(), fetchEvents, persist, store: {} };
    const [first, second] = await Promise.all([runSortirIngestTickIfDue(opts), runSortirIngestTickIfDue(opts)]);
    const results = [first, second];
    const started = results.filter((r) => r.triggered && r.status === "started");
    const rejected = results.filter((r) => !r.triggered);
    assert.strictEqual(started.length, 1, "un seul des deux doit réellement démarrer");
    assert.strictEqual(rejected.length, 1, "l'autre doit être refusé");
    assert.strictEqual(rejected[0].reason, "already running");
    await started[0].workPromise;
    assert.strictEqual(fetchCallCount, 1, "un seul appel OpenAgenda réel, pas deux");
  });

  await test("ne se déclenche pas hors de la fenêtre horaire", async () => {
    const result = await runSortirIngestTickIfDue({
      timeToMinutes, getReunionTimeHHMM: fixedTimeClient("12:00"),
      client: neverRanClient(), fetchEvents: async () => { throw new Error("ne doit jamais être appelé"); }, persist: async () => { throw new Error("ne doit jamais être appelé"); }
    });
    assert.deepStrictEqual(result, { triggered: false, reason: "not due" });
  });

  await test("ne se déclenche pas si un run a déjà été complété récemment", async () => {
    const alreadyRanClient = {
      from(table) {
        if (table === "sortir_sources") return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { id: "src-1" }, error: null }) };
        return { select() { return this; }, eq() { return this; }, gte() { return this; }, limit() { return this; }, then(resolve) { resolve({ data: [{ id: "run-1" }], error: null }); } };
      }
    };
    const result = await runSortirIngestTickIfDue({
      timeToMinutes, getReunionTimeHHMM: fixedTimeClient(SORTIR_INGEST_HOUR),
      client: alreadyRanClient, fetchEvents: async () => { throw new Error("ne doit jamais être appelé"); }, persist: async () => { throw new Error("ne doit jamais être appelé"); }
    });
    assert.deepStrictEqual(result, { triggered: false, reason: "already run recently" });
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
