"use strict";
// REVIEW = quarantaine métier : sûre, atomique, idempotente, non publiable, non bloquante
// lorsqu'elle est complète ; toute quarantaine partielle reste une erreur d'intégrité.
const assert = require("assert/strict"), fs = require("fs"), path = require("path");
const { harness, poi, NOW, SOURCE } = require("./test-datatourisme-poi-reconciliation");
const R = require("./datatourisme-poi-reconciliation"), P = require("./datatourisme-poi-state"), N = require("./datatourisme-national-scan");
const S = require("./datatourisme-activity-safety"), Q = require("./datatourisme-review-quarantine");
const { compareActivities } = require("./activity-deduplication"), { mergeStoredActivities } = require("./supabase-persistence");
global.fetch = async () => { throw new Error("Réseau réel interdit"); };
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}: ${e.stack}`); } }

const silver = require("./fixtures/datatourisme-silver-friday-archived.json");
const hydrated = s => s.activities.map(a => ({ ...a, provenances: s.provenances.filter(p => p.activity_id === a.id), external_ids: s.externalIds.filter(e => e.activity_id === a.id) }));
const audit = s => S.auditActivitySafety(hydrated(s), { decisions: s.decisions });
const evaluation = (s, id) => Q.evaluateQuarantine(hydrated(s).find(a => a.id === id), s.decisions);
// Exactly the predicate of every public reader (Explorer RPC, partage, participation, reposts).
const published = s => s.activities.filter(a => a.record_status === "active" && ["scheduled", "tentative"].includes(a.lifecycle_status));
const quarantined = s => s.activities.filter(a => evaluation(s, a.id).quarantined);
const guarded = (h, now = NOW) => R.createDatatourismePoiPersister({ store: h.activityStore, now, beforeCreateActivity: S.guardExactSignatureReview });
const runGuarded = (h, pois, now = NOW) => h.run(pois, now, guarded(h, now));
const state = s => JSON.stringify([s.activities, s.provenances, s.externalIds, s.decisions]);
function twins() { const a = poi("B", 1), b = poi("B", 2); b.label = a.label; return [a, b]; }
async function quarantine() {
  const h = harness(), [a, b] = twins(), s = h.activityStore;
  await runGuarded(h, [a]); await runGuarded(h, [b]);
  const q = s.activities.find(x => x.record_status === "review"), base = s.activities.find(x => x.record_status === "active");
  return { h, s, a, b, q, base };
}
// Mirror of the real REST behaviour for the manual resolution tools (not used by ingestion).
function withMoves(s) {
  s.moveProvenances = async (from, to) => { for (const p of s.provenances) if (p.activity_id === from) p.activity_id = to; };
  s.moveExternalIds = async (from, to) => { for (const e of s.externalIds.filter(e => e.activity_id === from)) {
    if (s.externalIds.some(x => x.activity_id === to && x.source_id === e.source_id && x.system === e.system && x.value === e.value)) s.externalIds.splice(s.externalIds.indexOf(e), 1); else e.activity_id = to; } };
  return s;
}

(async () => {
  await test("A — REVIEW légitime → quarantaine complète (activité review, provenance, IDs, décision tracée)", async () => {
    const { s, q, base, b } = await quarantine(), e = evaluation(s, q.id);
    assert.ok(e.quarantined && e.complete, JSON.stringify(e.issues));
    const [d] = s.decisions; assert.equal(s.decisions.length, 1); assert.equal(d.decision, "REVIEW"); assert.equal(d.review_status, "pending");
    const m = Q.quarantineMarker(d); assert.equal(m.quarantinedActivityId, q.id); assert.equal(m.candidateActivityId, base.id);
    assert.ok(m.sourceOccurrenceKey.startsWith(`datatourisme:${b.uuid}:`)); assert.equal(m.timezone, q.timezone);
    assert.deepEqual(new Set(s.externalIds.filter(x => x.activity_id === q.id).map(x => x.system)), new Set(["datatourisme-poi", "datatourisme-occurrence"]));
    assert.ok(d.signals.some(x => x.type === "title_similarity"), "les preuves de comparaison restent consultables");
  });
  await test("B — REVIEW non publiable : absente des lecteurs publics et du compteur final", async () => {
    const { s, q, base } = await quarantine();
    assert.deepEqual(published(s).map(a => a.id), [base.id]); assert.equal(await s.countFinalActivities(), 1); assert.notEqual(q.record_status, "active");
  });
  await test("C — rejeu REVIEW idempotent (UNCHANGED puis retraitement forcé du POI)", async () => {
    const { h, s, b, q } = await quarantine(), before = state(s);
    assert.equal((await runGuarded(h, [b])).unchanged.length, 1); assert.equal(state(s), before);
    h.stateStore.rows.delete(b.uuid);
    const again = await runGuarded(h, [b]); assert.equal(again.committed.length, 1);
    assert.equal(s.activities.length, 2); assert.equal(s.provenances.length, 2); assert.equal(s.externalIds.length, 4); assert.equal(s.decisions.length, 1);
    assert.equal(q.record_status, "review"); assert.ok(evaluation(s, q.id).complete);
  });
  const failures = {
    "INSERT perdu": s => { const create = s.createActivity.bind(s); s.createActivity = async row => { s.createActivity = create; await create(row); throw new Error("réponse perdue"); }; },
    "décision": s => { const insert = s.insertDedupDecision.bind(s); s.insertDedupDecision = async () => { s.insertDedupDecision = insert; throw new Error("décision échouée"); }; },
    "provenance": s => { const create = s.createProvenanceIdempotent.bind(s); s.createProvenanceIdempotent = async () => { s.createProvenanceIdempotent = create; throw new Error("provenance échouée"); }; },
    "provenance (réponse perdue)": s => { const create = s.createProvenanceIdempotent.bind(s); s.createProvenanceIdempotent = async row => { s.createProvenanceIdempotent = create; await create(row); throw new Error("réponse perdue"); }; },
    "external IDs": s => { const upsert = s.upsertExternalIds.bind(s); s.upsertExternalIds = async () => { s.upsertExternalIds = upsert; throw new Error("IDs échoués"); }; },
    "bascule review": s => { const update = s.updateActivity.bind(s); s.updateActivity = async (id, row) => { if (row.record_status === "review") { s.updateActivity = update; throw new Error("bascule échouée"); } return update(id, row); }; },
    "historique": s => { const insert = s.insertCollectionItemsBatch.bind(s); s.insertCollectionItemsBatch = async () => { s.insertCollectionItemsBatch = insert; throw new Error("historique échoué"); }; }
  };
  for (const [step, inject] of Object.entries(failures)) await test(`D/S — interruption « ${step} » : jamais couverte, puis rejeu idempotent`, async () => {
    const h = harness(), [a, b] = twins(), s = h.activityStore; await runGuarded(h, [a]); inject(s);
    const first = await runGuarded(h, [b]); assert.equal(first.committed.length, 0); assert.ok(!h.stateStore.rows.get(b.uuid)?.fingerprint, "empreinte validée sans couverture");
    assert.equal(published(s).length, 1, "aucune quarantaine publiée");
    for (const x of s.activities.filter(x => x.record_status === "review")) assert.ok(evaluation(s, x.id).complete, "review partielle visible");
    assert.equal(audit(s).ready, true, JSON.stringify(audit(s).issues));
    const replay = await runGuarded(h, [b]); assert.equal(replay.committed.length, 1);
    const live = quarantined(s).filter(x => x.record_status === "review");
    assert.equal(live.length, 1); assert.ok(evaluation(s, live[0].id).complete); assert.equal(published(s).length, 1);
    assert.equal(s.provenances.filter(p => p.source_record_id.includes(b.uuid)).length, 1);
    assert.equal(s.decisions.filter(d => Q.quarantineMarker(d)?.quarantinedActivityId === live[0].id).length, 1);
    assert.ok(s.activities.filter(x => x.id !== live[0].id && x.record_status !== "active").every(x => x.record_status === "stale" && !s.provenances.some(p => p.activity_id === x.id)), "seul un staging stale sans soutien peut rester");
    assert.equal(audit(s).ready, true); const snapshot = state(s); h.stateStore.rows.delete(b.uuid); await runGuarded(h, [b]);
    assert.equal(state(s).replace(/"last_seen_[a-z_]+":"[^"]*"/g, ""), snapshot.replace(/"last_seen_[a-z_]+":"[^"]*"/g, ""));
  });
  await test("D — couverture refusée si la quarantaine devient incomplète (aucune empreinte)", async () => {
    const { h, s, b, q } = await quarantine();
    s.externalIds = s.externalIds.filter(e => !(e.activity_id === q.id && e.system === "datatourisme-poi"));
    h.stateStore.rows.delete(b.uuid);
    await assert.rejects(h.run([b], NOW, async states => states.map(x => ({ uuid: x.uuid, status: "completed" }))), /Couverture DATAtourisme incomplète/);
    assert.equal(h.stateStore.rows.has(b.uuid), false);
  });
  await test("E — signature identique + quarantaine complète : précontrôle non bloquant, file explicite", async () => {
    const { s, q } = await quarantine(), r = audit(s);
    assert.equal(r.ready, true); assert.deepEqual(r.quarantines, [q.id]); assert.deepEqual(r.abandonedQuarantines, []);
    assert.equal(S.activitySignature(s.activities[0]), S.activitySignature(s.activities[1]));
  });
  await test("F — signature identique + quarantaine incomplète ou publiée : bloquant", async () => {
    const cases = {
      "ID occurrence absent": s => { s.externalIds = s.externalIds.filter(e => e.system !== "datatourisme-occurrence" || !e.value.includes(twins()[1].uuid)); },
      "intervalle décalé": (s, q) => { q.ends_at = "2026-11-02T12:30:00.000Z"; },
      "fuseau contradictoire": (s, q) => { q.timezone = "UTC"; },
      "quarantaine publiée": (s, q) => { q.record_status = "active"; },
      "provenance inactive": (s, q) => { s.provenances.find(p => p.activity_id === q.id).active = false; }
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const { s, q } = await quarantine(); mutate(s, q); const r = audit(s);
      assert.equal(r.ready, false, name); assert.ok(r.issues.some(i => ["quarantine_incomplete", "duplicate_signature_requires_review", "interrupted_duplicate_signature", "activity_without_active_provenance"].includes(i.code)), name);
    }
  });
  await test("G — activité review sans provenance : invalide (quarantaine, précontrôle, couverture)", async () => {
    const { s, q } = await quarantine(); s.provenances = s.provenances.filter(p => p.activity_id !== q.id);
    assert.ok(evaluation(s, q.id).issues.some(i => i.code === "quarantine_provenance_missing"));
    assert.ok(audit(s).issues.some(i => i.code === "activity_without_active_provenance"));
  });
  await test("H — provenance incohérente (autre clé, autre source, autre activité) : invalide", async () => {
    for (const mutate of [p => { p.source_occurrence_key += ":autre"; }, p => { p.source_id = "autre-source"; }, p => { p.activity_id = "ailleurs"; }]) {
      const { s, q } = await quarantine(); mutate(s.provenances.find(p => p.activity_id === q.id));
      assert.equal(evaluation(s, q.id).complete, false); assert.equal(audit(s).ready, false);
    }
  });
  await test("I — external IDs incomplets ou incohérents : invalide", async () => {
    { const { s, q } = await quarantine(); s.externalIds = s.externalIds.filter(e => !(e.activity_id === q.id && e.system === "datatourisme-poi"));
      assert.ok(evaluation(s, q.id).issues.some(i => i.code === "quarantine_external_id_missing")); assert.equal(audit(s).ready, false); }
    { const { s, q, a } = await quarantine(); s.externalIds.push({ activity_id: q.id, source_id: SOURCE, system: "datatourisme-occurrence", value: `datatourisme:${a.uuid}:2026-11-02T09:00:00.000Z:end=x` });
      assert.ok(evaluation(s, q.id).issues.some(i => i.code === "quarantine_external_id_unsupported")); assert.equal(audit(s).ready, false); }
  });
  await test("J — décision pending/review absente, résolue sans statut, trace invalide : bloquant", async () => {
    for (const mutate of [s => { s.decisions = []; }, s => { s.decisions[0].review_status = "not_required"; }, s => { s.decisions[0].signals = s.decisions[0].signals.filter(x => x.type !== Q.QUARANTINE_SIGNAL); },
      s => { Q.quarantineMarker(s.decisions[0]).candidateActivityId = "inconnue"; }, s => { s.decisions[0].decision = "MATCH"; }]) {
      const { s } = await quarantine(); mutate(s); const r = audit(s); assert.equal(r.ready, false); assert.ok(r.issues.some(i => ["duplicate_signature_requires_review", "quarantine_incomplete"].includes(i.code)));
    }
  });
  await test("J — quarantaine réactivée au rejeu : jamais active (disparition puis retour, décision ancienne sans trace)", async () => {
    for (const legacy of [false, true]) {
      const { h, s, b, q } = await quarantine();
      if (legacy) s.decisions[0].signals = s.decisions[0].signals.filter(x => x.type !== Q.QUARANTINE_SIGNAL);
      await runGuarded(h, [{ ...b, takesPlaceAt: [{ startDate: "2026-11-03", startTime: "10:00", endDate: "2026-11-03", endTime: "12:00" }] }]);
      assert.equal(q.record_status, "stale");
      await runGuarded(h, [b]); assert.equal(q.record_status, "review", `legacy=${legacy}`); assert.ok(!published(s).some(a => a.id === q.id));
    }
  });
  await test("K — MATCH normal inchangé (aucune quarantaine)", async () => {
    const ps = require("./fixtures/datatourisme-geographic-identity-archived.json"), h = harness(), now = "2026-10-25T04:25:51.603Z";
    await runGuarded(h, ps, now); assert.equal(h.activityStore.activities.length, 1); assert.equal(h.activityStore.decisions.filter(d => d.decision === "REVIEW").length, 0);
    assert.equal(h.activityStore.provenances.filter(p => p.active).length, 2); assert.equal(quarantined(h.activityStore).length, 0);
  });
  await test("L — DISTINCT normal inchangé (ateliers nommés, aucune décision REVIEW)", async () => {
    const ps = require("./fixtures/datatourisme-programme-visits-archived.json"), h = harness(), now = "2026-10-25T09:56:37.240Z";
    assert.equal((await runGuarded(h, ps, now)).committed.length, 2); assert.equal(h.activityStore.activities.length, 2);
    assert.equal(h.activityStore.decisions.length, 0); assert.equal(audit(h.activityStore).ready, true);
  });
  await test("M — protections temporelles inchangées : autre horaire ou autre fin = DISTINCT, pas de quarantaine", async () => {
    for (const patch of [{ startTime: "14:00", endTime: "16:00" }, { endTime: "13:00" }]) {
      const h = harness(), [a, b] = twins(); Object.assign(b.takesPlaceAt[0], patch); await runGuarded(h, [a, b]);
      assert.equal(h.activityStore.activities.length, 2); assert.equal(h.activityStore.decisions.length, 0); assert.equal(published(h.activityStore).length, 2);
    }
  });
  await test("N — protections géographiques inchangées : autre adresse jamais fusionnée", async () => {
    const ps = structuredClone(require("./fixtures/datatourisme-geographic-identity-archived.json")), h = harness(), now = "2026-10-25T04:25:51.603Z";
    ps[1].isLocatedAt[0].address[0].postalCode = "99999";
    await runGuarded(h, ps, now); assert.equal(h.activityStore.activities.length, 2);
    for (const q of quarantined(h.activityStore)) { assert.equal(q.record_status, "review"); assert.ok(evaluation(h.activityStore, q.id).complete); }
    assert.ok(!published(h.activityStore).some(a => quarantined(h.activityStore).includes(a))); assert.equal(audit(h.activityStore).ready, true);
  });
  await test("O — MATCH inter-UUID inchangé (Singulières : 30 séances, 60 provenances, 0 REVIEW)", async () => {
    const ps = require("./fixtures/datatourisme-inter-poi-archived.json"), h = harness(), now = "2026-10-22T17:53:41.312Z";
    await runGuarded(h, ps, now); assert.equal(h.activityStore.activities.length, 30); assert.equal(h.activityStore.provenances.filter(p => p.active).length, 60);
    assert.equal(h.activityStore.decisions.filter(d => d.decision === "REVIEW").length, 0);
  });
  await test("P — NEEDS_REVIEW éditorial n'annule toujours pas un MATCH certain (Anne de Bretagne)", async () => {
    const f = require("./fixtures/datatourisme-editorial-match-archived.json"), h = harness(), s = h.activityStore, c = structuredClone(f.candidate), now = "2026-10-24T05:25:41.028Z";
    s.sources = [structuredClone(f.source)]; s.provenances = c.provenances.map(p => { const q = { ...p }; delete q.source; return q; }); s.externalIds = c.external_ids; delete c.provenances; delete c.external_ids; s.activities = [c];
    const r = await R.processReceivedPoiBatch({ pois: [f.poi], stateStore: h.stateStore, activityStore: s, sourceId: f.source.id, scanId: "88888888-2222-3333-4444-555555555555", now, persistOccurrences: R.createDatatourismePoiPersister({ store: s, now, beforeCreateActivity: S.guardExactSignatureReview }) });
    assert.equal(r.committed.length, 1); assert.equal(s.activities.length, 1); assert.equal(s.decisions.filter(d => d.decision === "REVIEW").length, 0);
  });
  await test("Q — Silver Friday archivé : 10 REVIEW complètes, non publiables, A intact, rejeu idempotent", async () => {
    const h = harness(), s = h.activityStore, [A, B] = silver.pois, now = silver.now;
    const states = silver.pois.map(p => P.calculatePoiState(p, { now }));
    assert.deepEqual(states.map(x => x.results.length), [10, 10]);
    for (const item of states[1].results) {
      const twin = states[0].results.find(x => x.activity.startsAt === item.activity.startsAt && x.activity.endsAt === item.activity.endsAt);
      assert.ok(twin); assert.equal(compareActivities(twin.activity, item.activity).decision, "REVIEW", "seuil textuel inchangé");
    }
    assert.deepEqual(states[1].results.map(x => [x.activity.startsAt, x.activity.endsAt, x.activity.timezone]), silver.expected.intervals.map(x => [x.startsAt, x.endsAt, x.timezone]));
    const r = await runGuarded(h, [A, B], now); assert.equal(r.committed.length, 2);
    const fromA = s.activities.filter(a => s.provenances.some(p => p.activity_id === a.id && p.source_record_id.includes(A.uuid)));
    const fromB = s.activities.filter(a => s.provenances.some(p => p.activity_id === a.id && p.source_record_id.includes(B.uuid)));
    assert.equal(fromA.length, 10); assert.equal(fromB.length, 10); assert.ok(fromA.every(a => !fromB.includes(a)), "aucune fusion forcée");
    assert.ok(fromB.every(a => a.record_status === "review" && evaluation(s, a.id).complete));
    assert.equal(s.decisions.length, 10); assert.ok(s.decisions.every(d => d.review_status === "pending" && fromB.some(a => a.id === Q.quarantineMarker(d).quarantinedActivityId)));
    assert.equal(s.provenances.filter(p => p.active).length, 20); assert.equal(s.externalIds.length, 60);
    assert.ok(published(s).every(a => fromA.includes(a))); assert.ok(!published(s).some(a => fromB.includes(a)));
    const r2 = audit(s); assert.equal(r2.ready, true, JSON.stringify(r2.issues)); assert.equal(r2.quarantines.length, 10);
    const before = state(s); assert.equal((await runGuarded(h, [A, B], now)).unchanged.length, 2); assert.equal(state(s), before);
    // No title/UUID exception anywhere in production code.
    for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith(".js") && !f.startsWith("test-") && !f.startsWith("run-"))) {
      const text = fs.readFileSync(path.join(__dirname, f), "utf8");
      assert.ok(!/silver/i.test(text) && !text.includes(B.uuid) && !text.includes(A.uuid), `exception codée dans ${f}`);
    }
  });
  await test("R — résolution simulée REVIEW → MATCH : provenance et historique conservés, couverture saine", async () => {
    const { h, s, b, q, base } = await quarantine(); withMoves(s);
    // The automatic content merge re-applies compareActivities and refuses a REVIEW pair: a human
    // MATCH must be resolved with the identity primitives only (canonical content kept).
    await assert.rejects(mergeStoredActivities({ store: s, canonicalId: base.id, duplicateId: q.id }), /Fusion refusée/);
    await s.moveProvenances(q.id, base.id); await s.moveExternalIds(q.id, base.id); await s.markActivityMerged(q.id, base.id);
    Object.assign(s.decisions[0], { review_status: "confirmed_match", resolved_at: NOW.toISOString() });
    assert.equal(q.record_status, "merged"); assert.equal(q.merged_into_id, base.id);
    assert.ok(s.provenances.every(p => p.activity_id === base.id)); assert.ok(s.externalIds.every(e => e.activity_id === base.id));
    assert.ok(Q.quarantineMarker(s.decisions[0]), "trace conservée"); assert.equal(audit(s).ready, true); assert.equal(audit(s).abandonedQuarantines.length, 0);
    h.stateStore.rows.delete(b.uuid); assert.equal((await runGuarded(h, [b])).committed.length, 1);
    assert.deepEqual(published(s).map(a => a.id), [base.id]);
  });
  await test("R — résolution simulée REVIEW → DISTINCT : publication explicite, précontrôle sain, réactivation normale", async () => {
    const { h, s, b, q } = await quarantine();
    Object.assign(s.decisions[0], { review_status: "confirmed_distinct", resolved_at: NOW.toISOString() }); q.record_status = "active";
    assert.equal(audit(s).ready, true); assert.equal(published(s).length, 2);
    await runGuarded(h, [{ ...b, takesPlaceAt: [{ startDate: "2026-11-03", startTime: "10:00", endDate: "2026-11-03", endTime: "12:00" }] }]); assert.equal(q.record_status, "stale");
    await runGuarded(h, [b]); assert.equal(q.record_status, "active");
  });
  await test("S — reprise de checkpoint après interruption pendant la quarantaine : ACK seulement après couverture, sans doublon", async () => {
    const h = harness(), s = h.activityStore, now = new Date(silver.now), sourceId = SOURCE, scanId = "77777777-2222-3333-4444-000000000042";
    const control = { observed: new Set(), async beginBatchScan(x) { this.c = { id: x.scanId, started_at: x.now, initial_url: x.initialUrl, next_url: x.initialUrl, batch_size: x.checkpointSize, status: "running", pages: 0, received: 0, total: null, invalid: 0, error_codes: {} }; },
      async resumeBatchScan() { return structuredClone(this.c); },
      async observeBatch(x) { if (this.c.pending) { assert.deepEqual(this.c.pending.ids, x.ids); assert.equal(this.c.pending.selection_now, x.selectionNow); return; } this.c.pending = { ...structuredClone(x), selection_now: x.selectionNow }; },
      async finishBatch(x) { assert.equal(this.c.pending.url, x.url); this.c.pages += this.c.pending.pages; this.c.received += this.c.pending.ids.length; this.c.total = this.c.pending.total; this.c.next_url = this.c.pending.nextUrl; this.c.pending = null; if (!this.c.next_url) this.c.status = "complete"; } };
    const processor = N.receivedPoiProcessor({ stateStore: h.stateStore, activityStore: s, persistOccurrences: (states, context) => guarded(h, context.now)(states) });
    const fetchPage = async () => ({ objects: structuredClone(silver.pois), meta: { total: 2, next: null } });
    const update = s.updateActivity.bind(s); let failures = 1;
    s.updateActivity = async (id, row) => { if (row.record_status === "review" && failures-- > 0) throw new Error("crash pendant la quarantaine"); return update(id, row); };
    await assert.rejects(N.runNationalScanBatched({ store: control, sourceId, scanId, now, fetchPage, processPage: processor }), /Lot non terminé/);
    assert.equal(control.c.received, 0); assert.ok(control.c.pending); assert.ok(!h.stateStore.rows.get(silver.pois[1].uuid)?.fingerprint);
    assert.ok(!published(s).some(a => quarantined(s).includes(a)));
    const later = new Date(+now + 3600e3), done = await N.runNationalScanBatched({ store: control, sourceId, scanId, now: later, fetchPage, processPage: processor, resume: true });
    assert.equal(done.status, "complete"); assert.equal(control.c.received, 2); assert.equal(control.c.pending, null);
    assert.ok(h.stateStore.rows.get(silver.pois[1].uuid).fingerprint);
    const live = s.activities.filter(a => a.record_status === "review"); assert.equal(live.length, 10); assert.ok(live.every(a => evaluation(s, a.id).complete));
    assert.equal(s.provenances.length, 20); assert.equal(s.decisions.filter(d => live.some(a => Q.quarantineMarker(d).quarantinedActivityId === a.id)).length, 10);
    assert.equal(audit(s).ready, true);
  });
  await test("E/F — précontrôle global paginé : quarantaine complète prête, décision manquante bloquante", async () => {
    const F = require("./datatourisme-preflight"), { s, q } = await quarantine();
    const store = decisions => ({
      loadActivePage: async (sid, from, size) => { const rows = s.provenances.filter(p => p.source_id === sid && p.active).map(p => ({ ...p, activity: s.activities.find(a => a.id === p.activity_id) })); return { rows: rows.slice(from, from + size), count: rows.length }; },
      loadActivityPage: async (from, size) => { const rows = hydrated(s).filter(a => ["active", "review"].includes(a.record_status)); return { rows: rows.slice(from, from + size), count: rows.length }; },
      loadReviewDecisionPage: async (from, size) => ({ rows: decisions.slice(from, from + size), count: decisions.length }) });
    const ok = await F.runDatatourismePreflight({ store: store(s.decisions), sourceId: SOURCE, pageSize: 1 });
    assert.equal(ok.ready, true, JSON.stringify(ok.issues)); assert.equal(ok.pendingIdentityReviews, 1); assert.equal(ok.checkedDecisions, 1);
    const ko = await F.runDatatourismePreflight({ store: store([]), sourceId: SOURCE });
    assert.equal(ko.ready, false); assert.deepEqual(ko.issues.map(i => i.code), ["duplicate_signature_requires_review"]); assert.ok(ko.issues[0].activityIds.includes(q.id));
    await assert.rejects(F.runDatatourismePreflight({ store: { ...store(s.decisions), loadReviewDecisionPage: undefined }, sourceId: SOURCE }), /décisions REVIEW obligatoire/);
  });
  await test("lecteur Supabase des décisions REVIEW : GET bornés, résultat dédupliqué, troncature refusée", async () => {
    const { createClient } = require("@supabase/supabase-js"), { createSupabaseSortirStore } = require("./supabase-persistence");
    const id = n => `11111111-2222-3333-4444-${String(n).padStart(12, "0")}`, urls = []; let page = () => [{ id: "d1", decision: "REVIEW" }];
    const client = createClient("https://example.supabase.co", "fake", { auth: { persistSession: false }, global: { fetch: async url => { urls.push(String(url)); return new Response(JSON.stringify(page()), { status: 200, headers: { "Content-Type": "application/json" } }); } } });
    const rows = await createSupabaseSortirStore(client).loadReviewDecisionsBatch(Array.from({ length: 120 }, (_, i) => id(i)));
    assert.equal(urls.length, 3); assert.ok(urls.every(u => u.length < 8000 && u.includes("decision=eq.REVIEW"))); assert.equal(rows.length, 1);
    page = () => Array.from({ length: 1000 }, (_, i) => ({ id: `d${i}` }));
    await assert.rejects(createSupabaseSortirStore(client).loadReviewDecisionsBatch([id(1)]), /tronquée/);
  });
  console.log(`${passed} réussis, ${failed} échoués`); if (failed) process.exitCode = 1;
})();
