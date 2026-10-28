"use strict";

// Teste sortir-auto-ingest.js : aucune écriture réelle (fetchEvents/fetchDatatourisme/persist/
// client sont toujours mockés). Ne teste pas le pipeline lui-même (déjà couvert par
// sortir/test-*.js), seulement la couche d'orchestration (lots séquentiels OpenAgenda, chunks
// DATAtourisme, garde anti-double-run, capture d'erreur, absence de préchargement global).

const assert = require("assert");
const {
  runSortirIngestTickIfDue: realTick, hasRecentCompletedRun, isDue, runOpenAgendaBatches, runDatatourismeChunks, chunkArray,
  OPENAGENDA_SOURCES, SORTIR_INGEST_HOUR, SORTIR_INGEST_TOLERANCE_MIN, DATATOURISME_SOURCE_KEY
} = require("./sortir-auto-ingest");

const { MemoryStore } = require("./sortir/test-helpers/memory-store");
// La suite historique conserve son périmètre Senlis ; les huit sources et le verrou partagé
// sont exercés par test-sortir-scheduler-reunion.js avec leur vraie orchestration.
function runSortirIngestTickIfDue(args) {
  return realTick({ ...args, reunionSources: [], store: Object.assign(new MemoryStore(), args.store || {}),
    state: { acquire: async () => true, release: async () => {}, hasOtherRunning: async () => false,
      recent: (key, since) => hasRecentCompletedRun(args.client, since, key) } });
}

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${error.name ? "" : ""}${name}: ${error.stack || error.message}`); } }

function timeToMinutes(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }
function fixedTimeClient(hhmm) { return () => hhmm; }
function neverRanClient() {
  return {
    from() {
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
function sampleResults(n = 1) {
  return Array.from({ length: n }, (_, i) => ({ index: i, error: null, activity: {
    title: `Événement test ${i}`, description: null, startsAt: "2026-11-01T19:00:00.000Z", endsAt: "2026-11-01T21:00:00.000Z",
    timezone: "Europe/Paris", lifecycleStatus: "scheduled", locationType: "physical", venueName: "Salle test",
    address: null, postalCode: null, city: "Senlis", country: "FR", latitude: null, longitude: null, onlineUrl: null,
    organizers: [], category: null, subcategory: null, tags: [], imageUrl: null, confidence: 0.9, fieldConfidence: {}, evidence: [],
    provenances: [{ sourceType: "api", sourceName: "Senlis", sourceUrl: "https://oa.example", originalEventUrl: `https://oa.example/e/${i}`, externalId: `openagenda:${i}:2026-11-01T19:00:00.000Z`, fetchedAt: new Date().toISOString() }],
    externalIds: [{ system: "openagenda-event", value: String(i) }]
  } }));
}
function fakeSources(n) { return Array.from({ length: n }, (_, i) => ({ key: `src-${i}`, agendaUid: 1000 + i, sourceName: `Source ${i}` })); }

(async () => {
  await test("E — isDue() correspond bien à une fenêtre quotidienne autour de l'heure/fuseau choisis", async () => {
    const scheduled = timeToMinutes(SORTIR_INGEST_HOUR);
    assert.strictEqual(SORTIR_INGEST_HOUR, "04:00", "heure de La Réunion (Indian/Reunion, UTC+4) documentée");
    assert.strictEqual(isDue(scheduled - 1, scheduled, SORTIR_INGEST_TOLERANCE_MIN), false, "avant l'heure : pas dû");
    assert.strictEqual(isDue(scheduled, scheduled, SORTIR_INGEST_TOLERANCE_MIN), true, "exactement à l'heure : dû");
    assert.strictEqual(isDue(scheduled + SORTIR_INGEST_TOLERANCE_MIN - 1, scheduled, SORTIR_INGEST_TOLERANCE_MIN), true, "dans la tolérance : dû");
    assert.strictEqual(isDue(scheduled + SORTIR_INGEST_TOLERANCE_MIN, scheduled, SORTIR_INGEST_TOLERANCE_MIN), false, "tolérance dépassée : plus dû");
  });

  await test("F — aucune ingestion au simple chargement du module (pas d'appel réseau implicite)", async () => {
    delete require.cache[require.resolve("./sortir-auto-ingest")];
    const startedAt = Date.now();
    const mod = require("./sortir-auto-ingest");
    const loadMs = Date.now() - startedAt;
    assert(loadMs < 50, `require() a pris ${loadMs} ms : suspect d'un appel réseau implicite au chargement`);
    assert.strictEqual(typeof mod.runSortirIngestTickIfDue, "function");
  });

  // --- chunkArray : utilitaire pur, testé isolément ---
  await test("chunkArray découpe correctement, y compris dernier lot partiel", () => {
    assert.deepStrictEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepStrictEqual(chunkArray([], 3), []);
    assert.deepStrictEqual(chunkArray([1, 2], 10), [[1, 2]]);
  });

  // --- OpenAgenda : plusieurs sources réparties en plusieurs lots, traitement séquentiel ---
  await test("G — plusieurs agendas OpenAgenda répartis en PLUSIEURS lots séquentiels (taille de lot < nombre de sources)", async () => {
    const sources = fakeSources(5);
    const fetchCallOrder = [];
    const persistCallOrder = [];
    let concurrentFetchCount = 0, maxConcurrentFetch = 0;
    const fetchEvents = async (args) => {
      concurrentFetchCount += 1; maxConcurrentFetch = Math.max(maxConcurrentFetch, concurrentFetchCount);
      fetchCallOrder.push(args.agendaUid);
      await new Promise((r) => setTimeout(r, 5));
      concurrentFetchCount -= 1;
      return { results: sampleResults(1) };
    };
    const persist = async (args) => { persistCallOrder.push(args.sources.map((s) => s.key)); return { status: "completed", stats: { collected: args.sources.length } }; };
    const summaries = await runOpenAgendaBatches({ sources, batchSize: 2, fetchEvents, persist, store: {}, now: new Date() });
    assert.strictEqual(summaries.length, 3, "5 sources / lot de 2 = 3 lots (2+2+1)");
    assert.deepStrictEqual(persistCallOrder, [["src-0", "src-1"], ["src-2", "src-3"], ["src-4"]], "chaque lot est persisté séparément, dans l'ordre");
    assert.strictEqual(summaries.every((s) => s.status === "completed"), true);
  });

  await test("H — exécution strictement séquentielle : le lot N+1 n'est récupéré qu'après la persistance complète du lot N", async () => {
    const sources = fakeSources(4);
    const timeline = [];
    const fetchEvents = async (args) => { timeline.push(`fetch:${args.agendaUid}`); return { results: sampleResults(1) }; };
    const persist = async (args) => { timeline.push(`persist:${args.sources.map((s) => s.key).join(",")}`); await new Promise((r) => setTimeout(r, 5)); return { status: "completed", stats: {} }; };
    await runOpenAgendaBatches({ sources, batchSize: 2, fetchEvents, persist, store: {}, now: new Date() });
    // Aucun "fetch" du lot 2 ne doit apparaître avant le "persist" du lot 1 : preuve directe
    // qu'aucun préchargement global n'a lieu.
    const persistLot1Index = timeline.indexOf("persist:src-0,src-1");
    const fetchLot2Index = timeline.indexOf("fetch:1002");
    assert(persistLot1Index !== -1 && fetchLot2Index !== -1 && persistLot1Index < fetchLot2Index, `ordre observé: ${JSON.stringify(timeline)}`);
  });

  await test("I — aucun préchargement global : seuls les événements du lot COURANT sont en mémoire avant son ingestion", async () => {
    const sources = fakeSources(6);
    let maxSourcesSeenAtOnce = 0;
    const fetchEvents = async () => { return { results: sampleResults(1) }; };
    const persist = async (args) => { maxSourcesSeenAtOnce = Math.max(maxSourcesSeenAtOnce, args.sources.length); return { status: "completed", stats: {} }; };
    await runOpenAgendaBatches({ sources, batchSize: 2, fetchEvents, persist, store: {}, now: new Date() });
    assert.strictEqual(maxSourcesSeenAtOnce, 2, "jamais plus que la taille d'un lot en une seule persistance");
  });

  await test("J — l’utilitaire remonte une exception ; l’enveloppe du scheduler isole les producteurs", async () => {
    const sources = fakeSources(4);
    const persistOrder = [];
    const fetchEvents = async () => ({ results: sampleResults(1) });
    const persist = async (args) => {
      persistOrder.push(args.sources.map((s) => s.key).join(","));
      if (args.sources[0].key === "src-0") throw new Error("panne simulée du lot 1");
      return { status: "completed", stats: {} };
    };
    let threw = null;
    try { await runOpenAgendaBatches({ sources, batchSize: 2, fetchEvents, persist, store: {}, now: new Date() }); }
    catch (error) { threw = error; }
    // L'échec du lot 1 remonte (pas de rattrapage silencieux ici -- c'est runSortirIngestTickIfDue
    // au niveau au-dessus qui capture toute erreur, voir le test K) : mais seul le lot 1 a été
    // tenté avant l'échec, le lot 2 n'a jamais démarré EN PARALLÈLE (aucune exécution concurrente).
    assert.ok(threw, "l'échec du lot 1 doit remonter");
    assert.deepStrictEqual(persistOrder, ["src-0,src-1"], "le lot 2 ne doit jamais être tenté après l'échec du lot 1 dans cette boucle séquentielle");
  });

  await test("A' — déclenche les 3 agendas historiques dans des enveloppes isolées", async () => {
    let persistArgsList = [];
    const result = await runSortirIngestTickIfDue({
      timeToMinutes, getReunionTimeHHMM: fixedTimeClient(SORTIR_INGEST_HOUR),
      client: neverRanClient(),
      fetchEvents: async () => ({ results: sampleResults(1) }),
      persist: async (args) => { persistArgsList.push(args); return { status: "completed", stats: { collected: 1 } }; },
      store: {}
    });
    assert.strictEqual(result.triggered, true);
    const summary = await result.workPromise;
    assert.strictEqual(summary.status, "completed");
    assert.strictEqual(summary.openAgendaBatches, 3, "trois producteurs isolés séquentiellement");
    const openAgendaCall = persistArgsList.find((a) => a.sources[0].connectorType === "openagenda_json");
    assert.strictEqual(openAgendaCall.sources.length, 1);
    assert.deepStrictEqual(persistArgsList.filter(a => a.sources[0].connectorType === "openagenda_json").flatMap(a => a.sources.map(s => s.key)), OPENAGENDA_SOURCES.map(s => s.key));
  });

  await test("C — une erreur du pipeline est capturée sans crash du process", async () => {
    const result = await runSortirIngestTickIfDue({
      timeToMinutes, getReunionTimeHHMM: fixedTimeClient(SORTIR_INGEST_HOUR),
      client: neverRanClient(),
      fetchEvents: async () => ({ results: sampleResults(1) }),
      persist: async () => { throw new Error("panne Supabase simulée"); },
      store: {},
      datatourismeMaxTotalPois: 0
    });
    assert.strictEqual(result.triggered, true);
    const summary = await result.workPromise; // ne doit jamais rejeter
    assert.strictEqual(summary.status, "failed");
    assert(summary.error.includes("panne Supabase simulée"));
  });

  await test("D — deux déclenchements quasi simultanés ne lancent qu'un seul traitement réel", async () => {
    let fetchCallCount = 0;
    const fetchEvents = async () => { fetchCallCount += 1; await new Promise((r) => setTimeout(r, 30)); return { results: sampleResults(1) }; };
    const persist = async () => ({ status: "completed", stats: {} });
    const opts = { timeToMinutes, getReunionTimeHHMM: fixedTimeClient(SORTIR_INGEST_HOUR), client: neverRanClient(), fetchEvents, persist, store: {}, datatourismeMaxTotalPois: 0 };
    const [first, second] = await Promise.all([runSortirIngestTickIfDue(opts), runSortirIngestTickIfDue(opts)]);
    const results = [first, second];
    const started = results.filter((r) => r.triggered && r.status === "started");
    const rejected = results.filter((r) => !r.triggered);
    assert.strictEqual(started.length, 1, "un seul des deux doit réellement démarrer");
    assert.strictEqual(rejected.length, 1, "l'autre doit être refusé");
    assert.strictEqual(rejected[0].reason, "already running");
    await started[0].workPromise;
    assert.strictEqual(fetchCallCount, OPENAGENDA_SOURCES.length, "un seul cycle réel, un fetch par agenda configuré");
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

  // --- DATAtourisme : chunking, curseur, même source.key, arrêt à la limite pilote ---
  function poiStub(n) { return { uuid: `poi-${n}`, uri: `https://data.datatourisme.fr/x/poi-${n}`, label: `Événement ${n}`, isLocatedAt: [{ address: [{ hasAddressCity: { label: "Ville" } }] }], takesPlaceAt: [{ startDate: "2026-06-01", startTime: "10:00" }] }; }
  function fakeChunk({ poisPerChunk, totalChunks }) {
    let callIndex = 0;
    return async ({ resumeUrl }) => {
      callIndex += 1;
      const start = (callIndex - 1) * poisPerChunk;
      const results = Array.from({ length: poisPerChunk }, (_, i) => ({ index: i, error: null, validation: { status: "VALID" }, activity: { title: `POI ${start + i}`, externalIds: [{ system: "datatourisme-poi", value: `poi-${start + i}` }] } }));
      const exhausted = callIndex >= totalChunks;
      return { fetchedCount: poisPerChunk, results, nextPageUrl: exhausted ? null : `https://api.datatourisme.fr/v1/entertainmentAndEvent?page=${callIndex + 1}`, exhausted };
    };
  }
  // Store minimal simulant sortir_sources.resume_cursor pour UNE clé, avec compteur de
  // lectures/écritures -- persiste entre deux appels successifs de runDatatourismeChunks tant
  // qu'on réutilise la MÊME instance (simule des exécutions successives, ex. jour 1 / jour 2).
  function fakeCursorStore(initialCursor = null) {
    let cursor = initialCursor;
    const reads = []; const writes = [];
    return {
      async getSourceCursor(key) { reads.push(key); return cursor; },
      async saveSourceCursor(key, value) { writes.push({ key, value }); cursor = value; },
      get cursor() { return cursor; },
      get reads() { return reads; },
      get writes() { return writes; }
    };
  }

  await test("K — DATAtourisme : plusieurs chunks successifs, TOUJOURS le même source.key", async () => {
    const descriptorsSeen = [];
    const persist = async (args) => { descriptorsSeen.push(args.sources[0].key); return { status: "completed", stats: { collected: args.sources[0].results.length } }; };
    const outcome = await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 10, chunkSize: 5, persist, store: fakeCursorStore(), now: new Date(), fetchChunk: fakeChunk({ poisPerChunk: 5, totalChunks: 2 }) });
    assert.strictEqual(outcome.summaries.length, 2);
    assert.deepStrictEqual(descriptorsSeen, [DATATOURISME_SOURCE_KEY, DATATOURISME_SOURCE_KEY], "même source.key pour tous les chunks");
  });

  await test("L — DATAtourisme : pagination bornée par la limite pilote, s'arrête sans tout parcourir", async () => {
    let chunksRequested = 0;
    const fetchChunk = async ({ resumeUrl }) => {
      chunksRequested += 1;
      return { fetchedCount: 100, results: Array.from({ length: 100 }, (_, i) => ({ activity: { title: `x${i}` } })), nextPageUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent?page=next", exhausted: false };
    };
    const persist = async (args) => ({ status: "completed", stats: { collected: args.sources[0].results.length } });
    const outcome = await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 250, chunkSize: 100, persist, store: fakeCursorStore(), now: new Date(), fetchChunk });
    assert.strictEqual(chunksRequested, 3, "250 POI max / 100 par chunk = 3 chunks, jamais plus même si l'API indique qu'il en reste");
    assert.strictEqual(outcome.summaries.reduce((s, c) => s + c.poisFetched, 0), 300, "3 chunks complets (250 est une limite APPROXIMATIVE par le haut, jamais une page tronquée)");
  });

  await test("M — DATAtourisme désactivé si aucune clé API ou limite pilote à 0 (jamais d'appel)", async () => {
    const neverCall = async () => { throw new Error("ne doit jamais être appelé"); };
    const outcome1 = await runDatatourismeChunks({ apiKey: null, maxTotalPois: 300, chunkSize: 100, persist: neverCall, store: fakeCursorStore(), now: new Date(), fetchChunk: neverCall });
    assert.strictEqual(outcome1.skipped, true);
    const outcome2 = await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 0, chunkSize: 100, persist: neverCall, store: fakeCursorStore(), now: new Date(), fetchChunk: neverCall });
    assert.strictEqual(outcome2.skipped, true);
  });

  await test("N — idempotence : rejouer le même chunk DATAtourisme deux fois ne provoque aucune concurrence ni divergence de source.key", async () => {
    const persistCalls = [];
    const persist = async (args) => { persistCalls.push(args.sources[0].key); return { status: "completed", stats: { merged: 0, collected: args.sources[0].results.length } }; };
    // Chaque passage obtient SA PROPRE instance de chunk factice (état interne réinitialisé) :
    // on rejoue bien exactement le même chunk défini, pas la suite logique d'un curseur partagé.
    const first = await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 3, chunkSize: 3, persist, store: fakeCursorStore(), now: new Date(), fetchChunk: fakeChunk({ poisPerChunk: 3, totalChunks: 1 }) });
    const second = await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 3, chunkSize: 3, persist, store: fakeCursorStore(), now: new Date(), fetchChunk: fakeChunk({ poisPerChunk: 3, totalChunks: 1 }) });
    assert.strictEqual(first.summaries.length, 1);
    assert.strictEqual(second.summaries.length, 1);
    assert.deepStrictEqual(persistCalls, [DATATOURISME_SOURCE_KEY, DATATOURISME_SOURCE_KEY]);
  });

  // --- Reprise du curseur entre deux cycles (point central de cette étape) ---

  await test("O — une seule lecture du curseur par cycle, une écriture par chunk réussi", async () => {
    const store = fakeCursorStore();
    const persist = async (args) => ({ status: "completed", stats: { collected: args.sources[0].results.length } });
    await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 15, chunkSize: 5, persist, store, now: new Date(), fetchChunk: fakeChunk({ poisPerChunk: 5, totalChunks: 5 }) });
    assert.strictEqual(store.reads.length, 1, "une seule lecture, peu importe le nombre de chunks");
    assert.strictEqual(store.writes.length, 3, "une écriture par chunk réussi (15 POI / 5 par chunk = 3 chunks)");
  });

  await test("P — jour 1 puis jour 2 : le second cycle reprend EXACTEMENT où le premier s'est arrêté, jamais à la page 1", async () => {
    const store = fakeCursorStore(); // au départ : jamais exécuté, curseur = null
    const persist = async (args) => ({ status: "completed", stats: { collected: args.sources[0].results.length } });
    const resumeUrlsRequested = [];
    function trackedFetchChunk(inner) { return async (args) => { resumeUrlsRequested.push(args.resumeUrl); return inner(args); }; }

    // Jour 1 : catalogue de 5 chunks, on ne traite que les 2 premiers (petite limite pilote).
    await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 10, chunkSize: 5, persist, store, now: new Date(), fetchChunk: trackedFetchChunk(fakeChunk({ poisPerChunk: 5, totalChunks: 5 })) });
    const cursorAfterDay1 = store.cursor;
    assert.ok(cursorAfterDay1, "un curseur doit être sauvegardé : le catalogue n'est pas épuisé");
    assert.strictEqual(resumeUrlsRequested[0], null, "jour 1 : aucun curseur préexistant, démarre bien à la page 1");

    // Jour 2 : même store (même ligne sortir_sources), nouvelle instance de fetchChunk (simule
    // un nouveau process) -- doit reprendre avec le curseur sauvegardé, pas repartir de zéro.
    resumeUrlsRequested.length = 0;
    await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 10, chunkSize: 5, persist, store, now: new Date(), fetchChunk: trackedFetchChunk(fakeChunk({ poisPerChunk: 5, totalChunks: 5 })) });
    assert.strictEqual(resumeUrlsRequested[0], cursorAfterDay1, "jour 2 doit démarrer EXACTEMENT avec le curseur laissé par le jour 1");
  });

  await test("Q — fin de catalogue (exhausted=true) : le curseur est remis à null pour revisiter depuis le début au cycle suivant", async () => {
    const store = fakeCursorStore("https://api.datatourisme.fr/v1/entertainmentAndEvent?page=42");
    const persist = async (args) => ({ status: "completed", stats: { collected: args.sources[0].results.length } });
    await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 5, chunkSize: 5, persist, store, now: new Date(), fetchChunk: fakeChunk({ poisPerChunk: 5, totalChunks: 1 }) });
    assert.strictEqual(store.cursor, null, "catalogue épuisé : le curseur doit être remis à zéro, pas laissé à une valeur périmée");
  });

  await test("R — crash/échec de persistance : le curseur n'avance PAS, le prochain cycle rejoue le même chunk", async () => {
    const store = fakeCursorStore();
    let persistCallCount = 0;
    const persist = async () => { persistCallCount += 1; if (persistCallCount === 2) return { status: "failed", stats: {} }; return { status: "completed", stats: { collected: 5 } }; };
    const resumeUrlsRequested = [];
    function trackedFetchChunk(inner) { return async (args) => { resumeUrlsRequested.push(args.resumeUrl); return inner(args); }; }
    // Chunk 1 réussit (curseur avance), chunk 2 échoue à la persistance (curseur ne doit PAS avancer).
    const outcome = await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 15, chunkSize: 5, persist, store, now: new Date(), fetchChunk: trackedFetchChunk(fakeChunk({ poisPerChunk: 5, totalChunks: 5 })) });
    assert.strictEqual(outcome.summaries.length, 2, "le run s'arrête dès l'échec, pas de 3e chunk tenté");
    assert.strictEqual(outcome.summaries[1].status, "failed");
    assert.strictEqual(outcome.summaries[1].cursorAdvanced, false);
    const cursorAfterCrash = store.cursor;
    assert.notStrictEqual(cursorAfterCrash, null);

    // Cycle suivant : doit repartir avec le curseur d'APRÈS le chunk 1 (pas d'après le chunk 2
    // qui a échoué) -- donc rejoue bien le même chunk 2.
    resumeUrlsRequested.length = 0;
    await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 5, chunkSize: 5, persist: async () => ({ status: "completed", stats: { collected: 5 } }), store, now: new Date(), fetchChunk: trackedFetchChunk(fakeChunk({ poisPerChunk: 5, totalChunks: 5 })) });
    assert.strictEqual(resumeUrlsRequested[0], cursorAfterCrash, "le cycle suivant doit repartir avec le même curseur qu'après le chunk 1 réussi, pour rejouer le chunk 2");
  });

  await test("S — curseur invalide (rejeté par l'API) : repli immédiat sur la page 1, jamais de blocage définitif", async () => {
    const store = fakeCursorStore("https://api.datatourisme.fr/v1/entertainmentAndEvent?page=stale-cursor");
    const persist = async (args) => ({ status: "completed", stats: { collected: args.sources[0].results.length } });
    const resumeUrlsRequested = [];
    const fetchChunk = async ({ resumeUrl }) => {
      resumeUrlsRequested.push(resumeUrl);
      if (resumeUrl) throw new Error("curseur invalide simulé (HTTP 400)");
      return { fetchedCount: 5, results: Array.from({ length: 5 }, (_, i) => ({ activity: { title: `x${i}` } })), nextPageUrl: null, exhausted: true };
    };
    const outcome = await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 5, chunkSize: 5, persist, store, now: new Date(), fetchChunk });
    assert.deepStrictEqual(resumeUrlsRequested, ["https://api.datatourisme.fr/v1/entertainmentAndEvent?page=stale-cursor", null], "tente d'abord le curseur sauvegardé, puis retombe sur la page 1 dans le MÊME cycle");
    assert.strictEqual(outcome.summaries.length, 1, "le chunk de repli (page 1) est bien traité, pas d'échec définitif");
    assert.strictEqual(outcome.summaries[0].cursorWasInvalid, true);
    assert.strictEqual(store.cursor, null, "catalogue épuisé dès la page 1 dans ce scénario : curseur remis à zéro");
  });

  await test("T — DATAtourisme : le résumé de chaque lot porte les compteurs de sélection du vrai connecteur", async () => {
    const { fetchDatatourismeEvents } = require("./sortir/connectors/datatourisme");
    const now = new Date("2026-10-21T08:00:00Z");
    const located = { isLocatedAt: [{ address: [{ hasAddressCity: { label: "Paris", insee: "75056", isPartOfDepartment: { insee: "75" } } }] }], type: ["ExhibitionEvent"] };
    const daily = Array.from({ length: 35 }, (_, i) => ({ startDate: new Date(Date.parse("2026-10-22T12:00:00Z") + i * 86400000).toISOString().slice(0, 10), startTime: "10:00", endTime: "12:00" }));
    const objects = [
      { ...located, uuid: "poi-capped", uri: "https://data.datatourisme.fr/x/poi-capped", label: "Visite quotidienne", takesPlaceAt: daily },
      { ...located, uuid: "poi-window", uri: "https://data.datatourisme.fr/x/poi-window", label: "Conférence", takesPlaceAt: [{ startDate: "2026-09-01", startTime: "10:00", endTime: "12:00" }, { startDate: "2026-11-05", startTime: "18:00", endTime: "20:00" }, { startDate: "2090-01-01", startTime: "18:00", endTime: "20:00" }] }
    ];
    const previousFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ objects, meta: { total: 2, next: null } }) });
    // La persistance revalide les activités et ne garde pas les warnings du connecteur : les
    // compteurs ne doivent rien lui devoir.
    const persist = async (args) => ({ status: "completed", stats: { collected: args.sources[0].results.length } });
    try {
      const outcome = await runDatatourismeChunks({ apiKey: "test-key", maxTotalPois: 2, chunkSize: 2, persist, store: fakeCursorStore(), now, fetchChunk: fetchDatatourismeEvents });
      assert.deepStrictEqual(outcome.summaries[0].occurrenceSelection, {
        poisConverted: 2, periodsTotal: 38, pastPeriodsSkipped: 1, outOfWindowPeriodsSkipped: 1, duplicatePeriodsRemoved: 0,
        invalidPeriods: 0, poisCapped: 1, cappedOccurrencesDropped: 5, poisWithFallback: 0, occurrencesProduced: 31
      });
      assert.strictEqual(outcome.summaries[0].activitiesProduced, 31);
    } finally { global.fetch = previousFetch; }
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
