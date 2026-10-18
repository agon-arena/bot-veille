"use strict";

// Teste exclusivement la version batchée d'applyDisappearances (createSupabaseSortirStore),
// via un faux client Supabase en mémoire qui compte les appels .from(...) réellement émis.
// N'utilise PAS MemoryStore (celui de test-supabase-persistence.js) : MemoryStore réimplémente
// sa propre logique naïve en JS pur, elle ne passe jamais par client.from(...) et ne peut donc
// pas démontrer l'absence de N+1 — seul createSupabaseSortirStore(client) le peut.

const assert = require("assert");
const { createSupabaseSortirStore, DISAPPEARANCE_CHUNK_SIZE } = require("./supabase-persistence");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error.message}`); } }

function matchFilter(row, filter) {
  if (filter.type === "eq") return row[filter.col] === filter.val;
  if (filter.type === "lt") return row[filter.col] < filter.val;
  if (filter.type === "in") return filter.arr.includes(row[filter.col]);
  if (filter.type === "or") {
    return filter.expr.split(",").some((clause) => {
      const [col, op, val] = clause.split(".");
      if (op === "is" && val === "null") return row[col] === null || row[col] === undefined;
      if (op === "neq") return row[col] !== val;
      return false;
    });
  }
  return true;
}

// Faux client PostgREST en mémoire : ne modélise que ce qu'applyDisappearances utilise
// réellement (update/select/eq/lt/in/or sur deux tables), avec un journal d'appels exploitable
// par les tests pour prouver l'absence de N+1 — aucune écriture réelle, aucun réseau.
class FakeSupabaseClient {
  constructor(tables) { this.tables = tables; this.calls = []; }
  from(table) {
    const callRecord = { table, op: null };
    this.calls.push(callRecord);
    const state = { filters: [], updatePayload: null, selected: false };
    const builder = {
      update(payload) { callRecord.op = "update"; state.updatePayload = payload; return builder; },
      select() { if (!callRecord.op) callRecord.op = "select"; state.selected = true; return builder; },
      eq(col, val) { state.filters.push({ type: "eq", col, val }); return builder; },
      lt(col, val) { state.filters.push({ type: "lt", col, val }); return builder; },
      in(col, arr) { state.filters.push({ type: "in", col, arr }); return builder; },
      or(expr) { state.filters.push({ type: "or", expr }); return builder; }
    };
    builder.then = (resolve, reject) => {
      try {
        const matching = this.tables[table].filter((row) => state.filters.every((f) => matchFilter(row, f)));
        if (state.updatePayload) for (const row of matching) Object.assign(row, state.updatePayload);
        const data = state.selected ? matching.map((row) => ({ ...row })) : null;
        resolve({ data, error: null });
      } catch (error) { reject(error); }
    };
    return builder;
  }
}

function makeTouchedFixture(count, { secondActiveProvenance = false } = {}) {
  const sourceId = "src-1";
  const sourceRunId = "run-current";
  const cutoff = "2026-10-10T00:00:00.000Z";
  const activities = [];
  const provenances = [];
  for (let i = 0; i < count; i += 1) {
    const activityId = `act-${i}`;
    activities.push({ id: activityId, record_status: "active", updated_at: "2026-01-01T00:00:00.000Z" });
    provenances.push({ id: `prov-disparue-${i}`, activity_id: activityId, source_id: sourceId, active: true, last_seen_at: "2026-10-01T00:00:00.000Z", last_seen_run_id: "run-old" });
    if (secondActiveProvenance) provenances.push({ id: `prov-encore-active-${i}`, activity_id: activityId, source_id: "src-2", active: true, last_seen_at: "2026-10-15T00:00:00.000Z", last_seen_run_id: sourceRunId });
  }
  return { sourceId, sourceRunId, cutoff, activities, provenances };
}

(async () => {
  await test("cas 1 — une seule provenance, elle disparaît → activité stale", async () => {
    const { sourceId, sourceRunId, cutoff, activities, provenances } = makeTouchedFixture(1);
    const client = new FakeSupabaseClient({ sortir_provenances: provenances, sortir_activities: activities });
    const store = createSupabaseSortirStore(client);
    await store.applyDisappearances({ sourceId, sourceRunId, cutoff });
    assert.strictEqual(activities[0].record_status, "stale");
  });

  await test("cas 2 — deux provenances, une seule disparaît → activité reste active", async () => {
    const { sourceId, sourceRunId, cutoff, activities, provenances } = makeTouchedFixture(1, { secondActiveProvenance: true });
    const client = new FakeSupabaseClient({ sortir_provenances: provenances, sortir_activities: activities });
    const store = createSupabaseSortirStore(client);
    await store.applyDisappearances({ sourceId, sourceRunId, cutoff });
    assert.strictEqual(activities[0].record_status, "active");
    assert.strictEqual(provenances.find((p) => p.id === "prov-disparue-0").active, false);
    assert.strictEqual(provenances.find((p) => p.id === "prov-encore-active-0").active, true);
  });

  await test("cas 3 — plusieurs activités disparaissent simultanément, sans COUNT par activité", async () => {
    const { sourceId, sourceRunId, cutoff, activities, provenances } = makeTouchedFixture(3);
    const client = new FakeSupabaseClient({ sortir_provenances: provenances, sortir_activities: activities });
    const store = createSupabaseSortirStore(client);
    await store.applyDisappearances({ sourceId, sourceRunId, cutoff });
    assert(activities.every((a) => a.record_status === "stale"));
    // Ancien algorithme : 1 (désactivation) + 3 (un COUNT par activité) + 3 (un update par activité) = 7.
    // Nouveau : 1 (désactivation) + 1 (lecture groupée, 3 < taille de chunk) + 1 (update groupé) = 3.
    assert.strictEqual(client.calls.length, 3, `attendu 3 appels, obtenu ${client.calls.length}`);
  });

  await test("cas 4 — aucune provenance ne disparaît → aucune activité modifiée, 1 seul appel", async () => {
    const sourceId = "src-1", sourceRunId = "run-current", cutoff = "2026-10-10T00:00:00.000Z";
    const activities = [{ id: "act-0", record_status: "active", updated_at: "2026-01-01T00:00:00.000Z" }];
    const provenances = [{ id: "prov-0", activity_id: "act-0", source_id: sourceId, active: true, last_seen_at: "2026-10-16T00:00:00.000Z", last_seen_run_id: sourceRunId }];
    const client = new FakeSupabaseClient({ sortir_provenances: provenances, sortir_activities: activities });
    const store = createSupabaseSortirStore(client);
    await store.applyDisappearances({ sourceId, sourceRunId, cutoff });
    assert.strictEqual(activities[0].record_status, "active");
    assert.strictEqual(activities[0].updated_at, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(client.calls.length, 1, `attendu 1 appel (rien ne disparaît), obtenu ${client.calls.length}`);
  });

  await test("cas 5 — volume > taille de chunk : aucun activity_id perdu au chunking", async () => {
    const total = DISAPPEARANCE_CHUNK_SIZE * 2 + 200; // force 3 chunks pour les 2 passes groupées
    const { sourceId, sourceRunId, cutoff, activities, provenances } = makeTouchedFixture(total);
    const client = new FakeSupabaseClient({ sortir_provenances: provenances, sortir_activities: activities });
    const store = createSupabaseSortirStore(client);
    await store.applyDisappearances({ sourceId, sourceRunId, cutoff });
    assert.strictEqual(activities.filter((a) => a.record_status === "stale").length, total, "au moins un activity_id perdu pendant le chunking");
    const expectedChunks = Math.ceil(total / DISAPPEARANCE_CHUNK_SIZE);
    assert.strictEqual(client.calls.length, 1 + expectedChunks + expectedChunks, `attendu ${1 + 2 * expectedChunks} appels (1 désactivation + ${expectedChunks} lectures groupées + ${expectedChunks} updates groupés), obtenu ${client.calls.length}`);
  });

  console.log("\nMesure — nombre d'appels Supabase produits par applyDisappearances (tout disparaît) :");
  for (const n of [1, 206, 1000]) {
    const { sourceId, sourceRunId, cutoff, activities, provenances } = makeTouchedFixture(n);
    const client = new FakeSupabaseClient({ sortir_provenances: provenances, sortir_activities: activities });
    const store = createSupabaseSortirStore(client);
    await store.applyDisappearances({ sourceId, sourceRunId, cutoff });
    const ancien = 1 + n + activities.filter((a) => a.record_status === "stale").length; // 1 désactivation + N COUNT + 1 update par activité réellement stale
    console.log(`  N=${String(n).padStart(5, " ")} activités touchées → ancien ≈ ${ancien} appels, nouveau = ${client.calls.length} appels`);
  }

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
