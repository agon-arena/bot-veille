"use strict";

// Sélection des occurrences DATAtourisme (stratégie F de l'audit du 21/10/2026) : fenêtre
// glissante de 90 jours, plafond de 30, repli sur la prochaine occurrence. Fixtures
// déterministes, `now` toujours injecté, aucun réseau, aucune base réelle (MemoryStore).
const assert = require("assert");
const C = require("./connectors/datatourisme");
const { persistSortirIngestion } = require("./supabase-persistence");
const { DATATOURISME_STALE_AFTER_MS } = require("../sortir-auto-ingest");
global.fetch = async () => { throw new Error("Réseau interdit dans ces tests"); };
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }
class MemoryStore {
  constructor() { this.seq = 0; this.sources = []; this.ingestions = []; this.sourceRuns = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.decisions = []; }
  id(p) { this.seq += 1; return `${p}-${this.seq}`; }
  async ensureSource(row) { let f = this.sources.find(x => x.key === row.key); if (!f) { f = { id: this.id("src"), key: row.key, connector_type: row.connectorType, base_url: row.baseUrl }; this.sources.push(f); } return f; }
  async createIngestionRun(row) { const v = { id: this.id("ing"), ...row }; this.ingestions.push(v); return v; }
  async updateIngestionRun(id, row) { Object.assign(this.ingestions.find(x => x.id === id), row); }
  async createSourceRun(row) { const v = { id: this.id("run"), ...row }; this.sourceRuns.push(v); return v; }
  async updateSourceRun(id, row) { Object.assign(this.sourceRuns.find(x => x.id === id), row); }
  async findProvenancesBatch(sourceId, keys) { const s = new Set(keys); return this.provenances.filter(x => x.source_id === sourceId && s.has(x.source_occurrence_key)); }
  hydrate(row) { return { ...row, provenances: this.provenances.filter(p => p.activity_id === row.id).map(p => ({ ...p, source: this.sources.find(s => s.id === p.source_id) })), external_ids: this.externalIds.filter(id => id.activity_id === row.id) }; }
  async getActivity(id) { const row = this.activities.find(x => x.id === id); if (!row) throw new Error("absente"); return this.hydrate(row); }
  async getActivitiesBatch(ids) { const s = new Set(ids); return this.activities.filter(x => s.has(x.id)).map(x => this.hydrate(x)); }
  async listCandidateActivitiesInRange(startIso, endIso) { const start = Date.parse(startIso), end = Date.parse(endIso); return this.activities.filter(x => ["active", "review"].includes(x.record_status) && Date.parse(x.starts_at) >= start && Date.parse(x.starts_at) <= end).map(x => this.hydrate(x)); }
  async createActivity(row) { const v = { id: this.id("act"), merged_into_id: null, ...row }; this.activities.push(v); return v; }
  async updateActivity(id, row) { const v = this.activities.find(x => x.id === id); Object.assign(v, row); return v; }
  async markActivityMerged(id, cid) { return this.updateActivity(id, { record_status: "merged", merged_into_id: cid }); }
  async updateProvenance(id, row) { const v = this.provenances.find(x => x.id === id); Object.assign(v, row); return v; }
  async touchProvenancesBatch(ids, touch) { const s = new Set(ids); for (const p of this.provenances) if (s.has(p.id)) Object.assign(p, touch); }
  async createProvenanceIdempotent(row) { const conflict = this.provenances.find(x => x.source_id === row.source_id && (x.source_record_id || "") === (row.source_record_id || "") && x.source_occurrence_key === row.source_occurrence_key); if (conflict) return conflict; const v = { id: this.id("prov"), ...row }; this.provenances.push(v); return v; }
  async upsertExternalIds(aid, sid, ids) { for (const id of ids) if (!this.externalIds.some(x => x.activity_id === aid && x.source_id === sid && x.system === id.system && x.value === id.value)) this.externalIds.push({ activity_id: aid, source_id: sid, system: id.system, value: id.value }); }
  async insertCollectionItem(row) { const v = { id: this.id("item"), ...row }; this.items.push(v); return v; }
  async insertCollectionItemsBatch(rows) { for (const row of rows) this.items.push({ id: this.id("item"), ...row }); }
  async insertDedupDecision(row) { if (row.left_activity_id === row.right_activity_id) return null; this.decisions.push({ id: this.id("decision"), ...row }); }
  async applyDisappearances({ sourceId, sourceRunId, cutoff }) {
    const stale = this.provenances.filter(p => p.source_id === sourceId && p.active === true && (p.last_seen_run_id == null || p.last_seen_run_id !== sourceRunId) && Date.parse(p.last_seen_at) < Date.parse(cutoff));
    for (const p of stale) p.active = false;
    for (const activityId of new Set(stale.map(p => p.activity_id))) {
      if (!this.provenances.some(p => p.activity_id === activityId && p.active === true)) {
        const activity = this.activities.find(a => a.id === activityId);
        if (activity) activity.record_status = "stale";
      }
    }
  }
  async countFinalActivities() { return this.activities.filter(x => x.record_status === "active").length; }
}

// 21/10/2026 08:00Z = 10:00 à Paris (heure d'été). now + 90 j = 19/01/2027 08:00Z = 09:00 à Paris.
const NOW = new Date("2026-10-21T08:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const UUID = "11111111-2222-3333-4444-555555555555";
const opts = (now = NOW, extra = {}) => ({ sourceName: "DATAtourisme — France", sourceUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent", fetchedAt: now.toISOString(), now, ...extra });
function poi(periods, uuid = UUID) {
  return { uuid, uri: `https://data.datatourisme.fr/75/${uuid}`, label: { "@fr": "Exposition fenêtre glissante" }, type: ["Event", "EntertainmentAndEvent", "ExhibitionEvent"],
    isLocatedAt: [{ geo: { latitude: 48.86, longitude: 2.35 }, address: [{ streetAddress: ["1 rue de Rivoli"], postalCode: "75001", hasAddressCity: { label: { "@fr": "Paris" }, insee: "75056", isPartOfDepartment: { insee: "75" } } }] }],
    takesPlaceAt: periods };
}
const at = (startDate, startTime, endTime, endDate) => ({ startDate, startTime, ...(endTime ? { endTime, endDate: endDate || startDate } : {}) });
function addDays(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10); }
function series(firstDate, count, stepDays, time = "10:00", endTime = "12:00") { return Array.from({ length: count }, (_, i) => at(addDays(firstDate, i * stepDays), time, endTime)); }
// Mélange déterministe (aucun Math.random) : l'ordre API n'est jamais chronologique.
function shuffle(list) { return list.map((p, i) => [((i * 7919) % 104729), p]).sort((a, b) => a[0] - b[0]).map(([, p]) => p); }
const convert = (periods, now = NOW, extra) => C.convertDatatourismeEventWithStats(poi(periods), opts(now, extra));
const starts = (results) => results.filter(r => r.activity).map(r => r.activity.startsAt);
const keys = (results) => results.filter(r => r.activity).map(r => r.sourceOccurrenceKey);
function assertStatsInvariant(stats) {
  const sum = stats.pastPeriodsSkipped + stats.outOfWindowPeriodsSkipped + stats.duplicatePeriodsRemoved + stats.invalidPeriods + stats.cappedOccurrencesDropped + stats.occurrencesProduced;
  assert.strictEqual(sum, stats.periodsTotal, `invariant des compteurs : ${JSON.stringify(stats)}`);
}
const ingest = (store, results, now, staleAfterMs = DATATOURISME_STALE_AFTER_MS) => persistSortirIngestion({ store, now, staleAfterMs, sources: [{ key: "datatourisme-national", connectorType: "datatourisme", baseUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent", results }] });

(async () => {
  await test("périodes API non triées → occurrences chronologiques, indépendantes de l'ordre fourni", () => {
    const periods = [at("2026-11-10", "10:00", "12:00"), at("2026-10-25", "15:00", "17:00"), at("2026-12-01", "09:00", "11:00"), at("2026-11-02", "18:30", "20:00"), at("2026-10-25", "10:00", "12:00")];
    const { results, stats } = convert(periods);
    // 25/10/2026 : passage à l'heure d'hiver, 10:00 à Paris = 09:00Z.
    assert.deepStrictEqual(starts(results), ["2026-10-25T09:00:00.000Z", "2026-10-25T14:00:00.000Z", "2026-11-02T17:30:00.000Z", "2026-11-10T09:00:00.000Z", "2026-12-01T08:00:00.000Z"]);
    assert.deepStrictEqual(keys(convert([...periods].reverse()).results), keys(results));
    assert.deepStrictEqual(keys(convert(shuffle(periods)).results), keys(results));
    assertStatsInvariant(stats);
  });

  await test("périodes passées exclues, y compris une période du jour déjà terminée", () => {
    const { results, stats } = convert([at("2026-10-01", "10:00", "12:00"), at("2026-10-20", "10:00", "12:00"), at("2026-10-21", "06:00", "07:00"), at("2025-05-01", "10:00"), at("2026-10-30", "10:00", "12:00")]);
    assert.deepStrictEqual(starts(results), ["2026-10-30T09:00:00.000Z"]);
    assert.strictEqual(stats.pastPeriodsSkipped, 4);
    assertStatsInvariant(stats);
  });

  await test("événement en cours conservé (plage longue commencée, créneau du jour en cours), fin inconnue passée exclue", () => {
    const { results, stats } = convert([at("2026-11-05", "10:00", "12:00"), at("2026-10-01", "10:00", "18:00", "2026-12-31"), at("2026-10-21", "09:00", "12:00"), at("2026-10-21", "09:30")]);
    assert.deepStrictEqual(starts(results), ["2026-10-01T08:00:00.000Z", "2026-10-21T07:00:00.000Z", "2026-11-05T09:00:00.000Z"]);
    assert.strictEqual(stats.pastPeriodsSkipped, 1, "début passé sans fin connue : non visible dans Explorer");
  });

  await test("période future ≤ 90 jours conservée, borne exacte incluse", () => {
    const { results } = convert([at("2027-01-15", "10:00", "12:00"), at("2027-01-19", "09:00", "10:00"), at("2027-01-19", "09:01", "10:00")]);
    assert.deepStrictEqual(starts(results), ["2027-01-15T09:00:00.000Z", "2027-01-19T08:00:00.000Z"], "now + 90 j inclus, une minute plus tard exclu");
  });

  await test("période > 90 jours exclue dès qu'il existe une occurrence dans la fenêtre", () => {
    const { results, stats } = convert([at("2027-02-10", "10:00", "12:00"), at("2026-11-05", "10:00", "12:00"), at("2087-05-04", "08:00", "12:00"), at("2027-01-20", "10:00", "12:00")]);
    assert.deepStrictEqual(starts(results), ["2026-11-05T09:00:00.000Z"]);
    assert.strictEqual(stats.outOfWindowPeriodsSkipped, 3);
    assert.strictEqual(stats.poisWithFallback, 0);
    assertStatsInvariant(stats);
  });

  await test("aucune occurrence dans les 90 jours → seule la VRAIE prochaine occurrence future est conservée", () => {
    const periods = [at("2027-06-10", "10:00", "12:00"), at("2027-03-05", "18:00", "20:00"), at("2026-09-01", "10:00", "12:00"), at("2088-01-01", "10:00", "12:00"), at("2027-03-05", "14:00", "16:00"), at("2027-03-06", "08:00", "09:00")];
    const { results, stats } = convert(shuffle(periods));
    assert.deepStrictEqual(starts(results), ["2027-03-05T13:00:00.000Z"]);
    assert.strictEqual(stats.poisWithFallback, 1);
    assert.strictEqual(stats.pastPeriodsSkipped, 1);
    assert.strictEqual(stats.outOfWindowPeriodsSkipped, 4);
    assertStatsInvariant(stats);
  });

  await test("repli : une occurrence juste après la fenêtre (convertie au préfiltre) bat une période brute plus lointaine", () => {
    const { results } = convert([at("2027-01-21", "08:00", "09:00"), at("2027-01-20", "10:00", "12:00")]);
    assert.deepStrictEqual(starts(results), ["2027-01-20T09:00:00.000Z"]);
  });

  await test("repli : aucune occurrence future du tout → aucun item, aucune erreur (rien à afficher)", () => {
    const { results, stats } = convert([at("2026-09-01", "10:00", "12:00"), at("2026-10-21", "06:00", "07:00")]);
    assert.deepStrictEqual(results, []);
    assert.strictEqual(stats.occurrencesProduced, 0);
    assertStatsInvariant(stats);
  });

  await test("plafond de 30 : les 30 premières chronologiquement, warning connecteur et compteurs", () => {
    const periods = series("2026-10-22", 40, 1);
    const { results, stats } = convert(shuffle(periods));
    assert.strictEqual(results.length, 30);
    assert.deepStrictEqual(starts(results), series("2026-10-22", 30, 1).map(p => C.combineDateAndTime(p.startDate, p.startTime, "Europe/Paris")));
    assert(results[29].validation.warnings.some(w => w.code === "occurrences_truncated"));
    assert.strictEqual(stats.poisCapped, 1);
    assert.strictEqual(stats.cappedOccurrencesDropped, 10);
    assertStatsInvariant(stats);
  });

  await test("plus de 30 créneaux dans les 30 prochains jours (5 par jour) : 30 premiers créneaux, ordre intra-journée", () => {
    const periods = [];
    for (let d = 0; d < 10; d++) for (const time of ["18:00", "10:00", "14:00", "16:00", "11:00"]) periods.push(at(addDays("2026-11-02", d), time, "19:00"));
    const { results, stats } = convert(periods);
    assert.strictEqual(results.length, 30);
    assert.strictEqual(results[0].activity.startsAt, "2026-11-02T09:00:00.000Z");
    assert.strictEqual(results[4].activity.startsAt, "2026-11-02T17:00:00.000Z");
    assert.strictEqual(results[29].activity.startsAt, "2026-11-07T17:00:00.000Z", "six journées complètes");
    assert.strictEqual(stats.cappedOccurrencesDropped, 20);
  });

  await test("périodes identiques dédupliquées AVANT le plafond", () => {
    const distinct = series("2026-10-22", 30, 1);
    const { results, stats } = convert(shuffle([...distinct, ...distinct.map(p => ({ ...p }))]));
    assert.strictEqual(results.length, 30);
    assert.strictEqual(new Set(keys(results)).size, 30);
    assert.strictEqual(stats.duplicatePeriodsRemoved, 30);
    assert.strictEqual(stats.poisCapped, 0, "30 occurrences distinctes : le plafond n'est pas atteint");
    assertStatsInvariant(stats);
  });

  await test("période sans startDate : erreur isolée, les autres périodes sont sélectionnées normalement", () => {
    const { results, stats } = convert([at("2026-11-05", "10:00", "12:00"), { endTime: "19:00" }, null]);
    assert.strictEqual(results.filter(r => r.error === "Période sans date de début exploitable.").length, 2);
    assert.deepStrictEqual(starts(results), ["2026-11-05T09:00:00.000Z"]);
    assert.strictEqual(stats.invalidPeriods, 2);
    assertStatsInvariant(stats);
  });

  await test("DST/Temporal : conversions exactes autour du changement d'heure, erreur dans la fenêtre signalée", () => {
    const { results } = convert([at("2026-10-26", "10:00", "12:00"), at("2026-10-24", "10:00", "12:00"), at("2026-10-25", "02:30")]);
    assert.deepStrictEqual(starts(results), ["2026-10-24T08:00:00.000Z", "2026-10-26T09:00:00.000Z"]);
    assert.strictEqual(results.filter(r => r.error).length, 1, "heure ambiguë du 25/10/2026 : rejetée, jamais déplacée");
  });

  await test("préfiltre brut : une période lointaine non convertible ne fait pas échouer le POI", () => {
    // 26/10/2087 02:30 à Paris est ambiguë (nuit du passage à l'heure d'hiver) : jamais convertie.
    const { results, stats } = convert([at("2087-10-26", "02:30"), at("2026-11-05", "10:00", "12:00")]);
    assert.deepStrictEqual(results.map(r => r.error), [null]);
    assert.strictEqual(stats.invalidPeriods, 0);
    assert.strictEqual(stats.outOfWindowPeriodsSkipped, 1);
  });

  await test("Nouméa : marge de fuseau du préfiltre, occurrence du lendemain local conservée", () => {
    const p = poi([at("2026-10-22", "06:00", "08:00"), at("2026-10-21", "06:00", "07:00")]);
    p.isLocatedAt[0].address[0].hasAddressCity = { label: { "@fr": "Nouméa" }, insee: "98818", isPartOfDepartment: { insee: "988" } };
    const { results } = C.convertDatatourismeEventWithStats(p, opts());
    assert.deepStrictEqual(starts(results), ["2026-10-21T19:00:00.000Z"], "22/10 06:00 Nouméa = 21/10 19:00Z, à venir ; 21/10 06:00 Nouméa déjà passé");
  });

  await test("rejeu identique → mêmes clés, aucune activité supplémentaire en persistance", async () => {
    const periods = shuffle(series("2026-10-22", 12, 3));
    assert.deepStrictEqual(keys(convert(periods).results), keys(convert(periods).results));
    const store = new MemoryStore();
    await ingest(store, convert(periods).results, NOW);
    await ingest(store, convert([...periods].reverse()).results, new Date(NOW.getTime() + 60_000));
    assert.strictEqual(store.activities.length, 12);
    assert.strictEqual(store.provenances.length, 12);
  });

  await test("simulation J+7 : les nouvelles occurrences entrent dans la fenêtre, aucun doublon", async () => {
    const store = new MemoryStore();
    // Série hebdomadaire sur un an (fenêtre) et série quotidienne sur 60 jours (plafond).
    const weekly = series("2026-10-23", 52, 7, "18:00", "20:00");
    const daily = series("2026-10-22", 60, 1, "10:00");
    const weeklyPoi = { ...poi(weekly, "aaaaaaaa-0000-3000-8000-000000000001"), label: { "@fr": "Conférence hebdomadaire" } };
    const dailyPoi = { ...poi(daily, "aaaaaaaa-0000-3000-8000-000000000002"), label: { "@fr": "Visite quotidienne" } };
    const run = (now) => C.convertDatatourismeEventsWithStats([weeklyPoi, dailyPoi], opts(now));
    const day0 = run(NOW);
    await ingest(store, day0.results, NOW);
    const day0Keys = new Set(keys(day0.results));
    assert.strictEqual(store.activities.length, 13 + 30, "13 conférences dans 90 j + 30 visites plafonnées");
    const day7Now = new Date(NOW.getTime() + 7 * DAY);
    const day7 = run(day7Now);
    const fresh = keys(day7.results).filter(k => !day0Keys.has(k));
    await ingest(store, day7.results, day7Now);
    // Conférence du 22/01/2027 entrée dans la fenêtre ; visites : six passées (22-27/10), six nouvelles (21-26/11).
    assert.strictEqual(fresh.length, 1 + 6);
    assert.strictEqual(store.activities.length, 13 + 30 + fresh.length);
    assert.strictEqual(store.provenances.length, store.activities.length);
    assert.strictEqual(new Set(store.provenances.map(p => p.source_occurrence_key)).size, store.provenances.length);
    assert(store.activities.every(a => a.record_status === "active"), "les occurrences passées vieillissent par le mécanisme stale normal (365 j)");
  });

  await test("réactivation : une occurrence poussée hors du plafond devient stale puis revient avec la même activité", async () => {
    const store = new MemoryStore();
    const originals = series("2026-10-22", 35, 2, "10:00");
    await ingest(store, convert(originals).results, NOW);
    assert.strictEqual(store.activities.length, 30);
    const pushedOut = keys(convert(originals).results).slice(25);
    const idsBefore = new Map(store.provenances.map(p => [p.source_occurrence_key, p.activity_id]));
    // J+1 : le producteur insère cinq créneaux plus tôt ; vieillissement court pour ce test seulement.
    const day1 = new Date(NOW.getTime() + DAY);
    const extras = ["2026-10-23", "2026-10-25", "2026-10-27", "2026-10-29", "2026-10-31"].map(d => at(d, "10:00", "12:00"));
    await ingest(store, convert([...originals, ...extras], day1).results, day1, 12 * 60 * 60 * 1000);
    for (const key of pushedOut) assert.strictEqual(store.activities.find(a => a.id === idsBefore.get(key)).record_status, "stale", key);
    // J+12 : les créneaux ajoutés sont passés ou retirés, les occurrences écartées reviennent.
    const day12 = new Date(NOW.getTime() + 12 * DAY);
    await ingest(store, convert(originals, day12).results, day12, 12 * 60 * 60 * 1000);
    for (const key of pushedOut) {
      const provenances = store.provenances.filter(p => p.source_occurrence_key === key);
      assert.strictEqual(provenances.length, 1, `aucune provenance dupliquée pour ${key}`);
      assert.strictEqual(provenances[0].activity_id, idsBefore.get(key), "même activité qu'avant");
      assert.strictEqual(store.activities.find(a => a.id === idsBefore.get(key)).record_status, "active");
    }
    // 30 initiales + 5 créneaux insérés + 5 originales entrées pour la première fois sous le plafond.
    assert.strictEqual(store.activities.length, 40);
    assert.strictEqual(new Set(store.provenances.map(p => p.source_occurrence_key)).size, store.provenances.length, "aucune copie");
  });

  await test("fetchDatatourismeEvents : compteurs agrégés par lot dans occurrenceStats, instant now injecté", async () => {
    const pois = [poi([at("2026-10-01", "10:00", "12:00"), at("2026-11-05", "10:00", "12:00"), at("2087-01-01", "10:00", "12:00")]), poi(series("2026-10-22", 35, 1), "bbbbbbbb-0000-3000-8000-000000000001")];
    const previous = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ objects: pois, meta: { total: 2, next: null } }) });
    try {
      const result = await C.fetchDatatourismeEvents({ apiKey: "fake", maxEvents: 2, now: NOW });
      assert.deepStrictEqual(result.occurrenceStats, { poisConverted: 2, periodsTotal: 38, pastPeriodsSkipped: 1, outOfWindowPeriodsSkipped: 1, duplicatePeriodsRemoved: 0, invalidPeriods: 0, poisCapped: 1, cappedOccurrencesDropped: 5, poisWithFallback: 0, occurrencesProduced: 31 });
      assert.strictEqual(result.results.length, 31);
    } finally { global.fetch = previous; }
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed) process.exitCode = 1;
})();
