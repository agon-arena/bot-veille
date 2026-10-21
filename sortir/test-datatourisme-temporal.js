"use strict";
const assert = require("assert");
const C = require("./connectors/datatourisme");
const { persistSortirIngestion, sanitizeSourcePayload, stableJson } = require("./supabase-persistence");
const { compareActivities, DECISIONS } = require("./activity-deduplication");
const fixtures = require("./fixtures/datatourisme-temporal.json");
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
  async findProvenance(sourceId, recordId, key) { return this.provenances.find(x => x.source_id === sourceId && (x.source_record_id || "") === (recordId || "") && x.source_occurrence_key === key) || null; }
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
  async moveProvenances() {} async moveExternalIds() {}
  async createProvenanceIdempotent(row) { const conflict = this.provenances.find(x => x.source_id === row.source_id && (x.source_record_id || "") === (row.source_record_id || "") && x.source_occurrence_key === row.source_occurrence_key); if (conflict) return conflict; const v = { id: this.id("prov"), ...row }; this.provenances.push(v); return v; }
  async upsertExternalIds(aid, sid, ids) { for (const id of ids) if (!this.externalIds.some(x => x.activity_id === aid && x.source_id === sid && x.system === id.system && x.value === id.value)) this.externalIds.push({ activity_id: aid, source_id: sid, system: id.system, value: id.value }); }
  async insertCollectionItem(row) { const v = { id: this.id("item"), ...row }; this.items.push(v); return v; }
  async insertCollectionItemsBatch(rows) { for (const row of rows) this.items.push({ id: this.id("item"), ...row }); }
  async insertDedupDecision(row) { if (row.left_activity_id === row.right_activity_id) return null; if (!this.decisions.some(x => x.left_activity_id === row.left_activity_id && x.right_activity_id === row.right_activity_id && x.algorithm_version === row.algorithm_version)) this.decisions.push({ id: this.id("decision"), ...row }); }
  async applyDisappearances({ sourceId, sourceRunId, cutoff }) {
    const stale = this.provenances.filter(p => p.source_id === sourceId && p.active === true && (p.last_seen_run_id == null || p.last_seen_run_id !== sourceRunId) && Date.parse(p.last_seen_at) < Date.parse(cutoff));
    for (const p of stale) p.active = false;
    const touchedIds = [...new Set(stale.map(p => p.activity_id))];
    for (const activityId of touchedIds) {
      const stillActive = this.provenances.some(p => p.activity_id === activityId && p.active === true);
      if (!stillActive) {
        const activity = this.activities.find(a => a.id === activityId);
        if (activity) activity.record_status = "stale";
      }
    }
  }
  async countFinalActivities() { return this.activities.filter(x => x.record_status === "active").length; }
}

const clone = x => JSON.parse(JSON.stringify(x));
const opts = { fetchedAt: "2026-10-21T00:00:00Z", now: new Date("2026-10-21T00:00:00Z"), sourceName: "DATAtourisme", sourceUrl: "https://api.datatourisme.fr/v1/entertainmentAndEvent" };
const periods = [{ startDate: "2026-10-09", startTime: "14:00", endDate: "2026-11-26", endTime: "20:30" },
  { startDate: "2026-10-09", startTime: "14:00", endDate: "2026-11-26", endTime: "18:00" }];
function carrier(per = periods) { return { ...clone(fixtures.thierryCarrier), takesPlaceAt: clone(per) }; }
function territory(code, commune) { return { isLocatedAt: [{ address: [{ hasAddressCity: { insee: commune, isPartOfDepartment: { insee: code } } }] }] }; }
const ingest = (store, results) => persistSortirIngestion({ store, now: new Date(opts.fetchedAt), sources: [{ key: "datatourisme-national", connectorType: "datatourisme", baseUrl: opts.sourceUrl, results }] });
const convert = p => C.convertDatatourismeEvent(p, opts);

(async () => {
  const zones = { 971:"America/Guadeloupe",972:"America/Martinique",973:"America/Cayenne",974:"Indian/Reunion",975:"America/Miquelon",976:"Indian/Mayotte",977:"America/St_Barthelemy",978:"America/Marigot",986:"Pacific/Wallis",988:"Pacific/Noumea" };
  for (const [code, zone] of Object.entries(zones)) await test(`territoire ${code} : ${zone}, fuseau IANA valide`, () => {
    assert.strictEqual(C.inferTimezoneFromPoi(territory(code)), zone); assert.doesNotThrow(() => new Intl.DateTimeFormat("fr", { timeZone: zone }));
    const hours = { 971:[19,19],972:[19,19],973:[18,18],974:[11,11],975:[18,17],976:[12,12],977:[19,19],978:[19,19],986:[3,3],988:[4,4] }[code];
    for (const [i,date] of ["2026-01-15","2026-07-15"].entries()) assert.strictEqual(C.combineDateAndTime(date,"15:00",zone), date+`T${String(hours[i]).padStart(2,"0")}:00:00.000Z`);
  });
  for (const commune of ["98718","98723","98731","98746","98756","98757"]) await test(`987 ${commune} : Marquises (UTC−09:30)`, () => {
    assert.strictEqual(C.inferTimezoneFromPoi(territory("987",commune)), "Pacific/Marquesas");
    assert.strictEqual(C.combineDateAndTime("2026-01-15","15:00","Pacific/Marquesas"),"2026-01-16T00:30:00.000Z");
  });
  await test("987 Gambier et Tahiti sont distincts", () => {
    assert.strictEqual(C.inferTimezoneFromPoi(territory("987","98719")),"Pacific/Gambier");
    assert.strictEqual(C.inferTimezoneFromPoi(territory("987","98735")),"Pacific/Tahiti");
    assert.strictEqual(C.combineDateAndTime("2026-01-15","15:00","Pacific/Gambier"),"2026-01-16T00:00:00.000Z");
    assert.strictEqual(C.combineDateAndTime("2026-01-15","15:00","Pacific/Tahiti"),"2026-01-16T01:00:00.000Z");
  });
  await test("987 sans commune : erreur explicite, aucun repli vers Paris ou Tahiti", () => assert.throws(() => C.inferTimezoneFromPoi(territory("987")), /indéterminé/));
  await test("fuseau explicite fiable prioritaire, y compris pour 987", () => {
    assert.strictEqual(C.inferTimezoneFromPoi({...territory("988"),timezone:"Pacific/Tahiti"}),"Pacific/Tahiti");
    assert.strictEqual(C.inferTimezoneFromPoi({...territory("987"),timezone:"Pacific/Gambier"}),"Pacific/Gambier");
    assert.strictEqual(C.inferTimezoneFromPoi(territory("988"),{timezone:"UTC"}),"UTC");
  });
  await test("fuseau explicite invalide ignoré, métropole et Corse inchangées", () => {
    assert.strictEqual(C.inferTimezoneFromPoi({...territory("988"),timezone:"Not/AZone"}),"Pacific/Noumea");
    assert.strictEqual(C.inferTimezoneFromPoi(territory("75")),"Europe/Paris");assert.strictEqual(C.inferTimezoneFromPoi(territory("2A")),"Europe/Paris");
  });
  await test("cas réel Koné : 06h locale donne 19hZ la veille, pas 05hZ", () => {
    const a=convert(fixtures.kone)[0].activity;
    assert.strictEqual(a.timezone,"Pacific/Noumea");assert.strictEqual(a.startsAt,"2025-12-30T19:00:00.000Z");
  });
  await test("cas réel La Foa : 07h locale donne 20hZ la veille", () => {
    const a=convert(fixtures.laFoa)[0].activity;
    assert.strictEqual(a.timezone,"Pacific/Noumea");assert.strictEqual(a.startsAt,"2025-12-30T20:00:00.000Z");
  });
  const dates = [
    ["2026-03-29","01:30","2026-03-29T00:30:00.000Z"],
    ["2026-03-29","03:30","2026-03-29T01:30:00.000Z"],
    ["2026-10-25","01:30","2026-10-24T23:30:00.000Z"],
    ["2026-10-25","03:30","2026-10-25T02:30:00.000Z"],
    ["2026-01-15","15:00","2026-01-15T14:00:00.000Z"],
    ["2026-07-15","15:00","2026-07-15T13:00:00.000Z"]
  ];
  for (const [date,time,expected] of dates) await test(`Europe/Paris ${date} ${time} : conversion exacte`,()=>assert.strictEqual(C.combineDateAndTime(date,time,"Europe/Paris"),expected));
  await test("heure de printemps inexistante et heure d'automne ambiguë : aucune date artificielle",()=>{
    assert.throws(()=>C.combineDateAndTime("2026-03-29","02:30","Europe/Paris"));
    assert.throws(()=>C.combineDateAndTime("2026-10-25","02:30","Europe/Paris"));
    // Périodes de la fenêtre (référence 21/10/2026) : la nuit d'automne 2026 et celle de printemps 2027.
    for(const startDate of ["2026-10-25","2027-03-28"]){const r=convert(carrier([{startDate,startTime:"02:30"}]))[0];assert(r.error,startDate);assert.strictEqual(r.activity,null);}
  });
  await test("Nouméa : mêmes règles UTC+11 en hiver, été et nuits de changement d'heure parisien",()=>{
    for(const date of ["2026-01-15","2026-07-15","2026-03-29","2026-10-25"]){const result=C.combineDateAndTime(date,"15:00","Pacific/Noumea");assert.strictEqual(result,date+"T04:00:00.000Z");}
    assert.strictEqual(C.combineDateAndTime("2026-03-29","02:30","Pacific/Noumea"),"2026-03-28T15:30:00.000Z");
  });
  await test("Thierry Carrier : UUID et début identiques, deux fins donc deux clés distinctes",()=>{
    const r=convert(carrier());assert.strictEqual(r.length,2);assert.strictEqual(r[0].activity.startsAt,r[1].activity.startsAt);
    assert.notStrictEqual(r[0].sourceOccurrenceKey,r[1].sourceOccurrenceKey);
    // Même début : tri déterministe par fin, quel que soit l'ordre API.
    assert.strictEqual(r[0].activity.endsAt,"2026-11-26T17:00:00.000Z");assert.strictEqual(r[1].activity.endsAt,"2026-11-26T19:30:00.000Z");
    assert.strictEqual(compareActivities(r[0].activity,r[1].activity).decision,DECISIONS.DISTINCT);
  });
  await test("même UUID + même début + même fin : clé identique, périodes identiques dédupliquées",()=>{
    const r=convert(carrier([periods[0],clone(periods[0])]));assert.strictEqual(r.length,1);
    assert.strictEqual(r[0].sourceOccurrenceKey,convert(carrier([periods[0]]))[0].sourceOccurrenceKey);
  });
  await test("identité indépendante de l'ordre et du format date/heure équivalent",()=>{
    const a=convert(carrier()),b=convert(carrier([...periods].reverse()));
    assert.deepStrictEqual(a.map(r=>r.sourceOccurrenceKey).sort(),b.map(r=>r.sourceOccurrenceKey).sort());
    const formatted={...periods[0],startTime:"1970-01-01T14:00:00",endTime:"20:30:00"};
    assert.strictEqual(convert(carrier([formatted]))[0].sourceOccurrenceKey,a.find(r=>r.activity.endsAt==="2026-11-26T19:30:00.000Z").sourceOccurrenceKey);
  });
  await test("fin inconnue distincte d'une fin explicite",()=>{
    // Début futur : une fin inconnue n'est visible que si l'occurrence n'a pas encore commencé.
    const a=convert(carrier([{startDate:"2026-11-26",startTime:"14:00"},{startDate:"2026-11-26",startTime:"14:00",endDate:"2026-11-26",endTime:"20:30"}]));
    assert.strictEqual(a.length,2);assert.notStrictEqual(a[0].sourceOccurrenceKey,a[1].sourceOccurrenceKey);
  });
  await test("pipeline réel MemoryStore : deux périodes préservées, rejeu inversé sans doublon",async()=>{
    const store=new MemoryStore();await ingest(store,convert(carrier()));
    assert.strictEqual(store.activities.length,2);assert.strictEqual(store.provenances.length,2);
    const ends=store.activities.map(a=>a.ends_at).sort();assert.deepStrictEqual(ends,["2026-11-26T17:00:00.000Z","2026-11-26T19:30:00.000Z"]);
    await ingest(store,convert(carrier([...periods].reverse())));assert.strictEqual(store.activities.length,2);assert.strictEqual(store.provenances.length,2);
  });
  await test("doublon identique même dans un lot fourni directement : aucune activité supplémentaire",async()=>{
    const store=new MemoryStore(),r=convert(carrier([periods[0]]));await ingest(store,[...r,...r]);assert.strictEqual(store.activities.length,1);assert.strictEqual(store.provenances.length,1);
  });
  async function legacyStore(end) {
    const store=new MemoryStore();const item=convert(carrier([end==='18:00'?periods[1]:periods[0]]))[0];
    const legacy=clone(item);delete legacy.sourceOccurrenceKey;delete legacy.legacySourceOccurrenceKey;delete legacy.sourcePayload;
    legacy.activity.provenances[0].externalId=legacy.sourceRecordId;
    legacy.activity.externalIds.find(e=>e.system==='datatourisme-occurrence').value=legacy.sourceRecordId;
    await ingest(store,[legacy]);return store;
  }
  await test("ancienne clé simple : nouvelle clé réutilise activité/provenance sans doublon",async()=>{
    const store=await legacyStore("20:30");const id=store.activities[0].id,pid=store.provenances[0].id;
    await ingest(store,convert(carrier([periods[0]])));assert.strictEqual(store.activities.length,1);assert.strictEqual(store.provenances.length,1);
    assert.strictEqual(store.activities[0].id,id);assert.strictEqual(store.provenances[0].id,pid);assert(store.provenances[0].source_payload.period);
  });
  await test("Thierry historique : fin canonique 18h mais payload 20h30, compatibilité sans fusion silencieuse",async()=>{
    const store=await legacyStore("20:30");store.activities[0].ends_at="2026-11-26T17:00:00.000Z";
    store.activities[0].evidence=[{field:"endsAt",sourceValue:JSON.stringify(["2026-11-26T19:30:00.000Z","2026-11-26T17:00:00.000Z"]),provenanceIndex:null}];
    const oldId=store.activities[0].id;
    await ingest(store,convert(carrier()));assert.strictEqual(store.activities.length,2);assert.strictEqual(store.provenances.length,2);
    assert.strictEqual(store.activities.find(a=>a.id===oldId).ends_at,"2026-11-26T17:00:00.000Z");
    await ingest(store,convert(carrier([...periods].reverse())));assert.strictEqual(store.activities.length,2);assert.strictEqual(store.provenances.length,2);
  });
  await test("trace : un seul fragment brut et sa normalisation, aucune copie du catalogue",()=>{
    const p=carrier();p.takesPlaceAt=Array.from({length:1000},()=>clone(periods[0]));
    const converted=convert(p),item=converted[0],payload=sanitizeSourcePayload(item.sourcePayload);
    // 1000 périodes identiques : dédupliquées AVANT le plafond, donc une seule occurrence, sans troncature.
    assert.strictEqual(converted.length,1);assert(!item.validation.warnings.some(w=>w.code==="occurrences_truncated"));
    assert.deepStrictEqual(payload.period,periods[0]);assert.strictEqual(payload.normalized.endsAt,item.activity.endsAt);
    assert.strictEqual(payload.poiUuid,p.uuid);assert.strictEqual(payload.timezoneContext.departmentInsee,"57");assert(!JSON.stringify(payload).includes('takesPlaceAt'));assert(JSON.stringify(payload).length<1200);
    assert(!('description' in payload));assert.strictEqual(p.takesPlaceAt.length,1000);
  });
  await test("trace mise à jour même si seul le fragment brut change (hash métier identique)",async()=>{
    const store=new MemoryStore();const p=carrier([periods[0]]);await ingest(store,convert(p));
    p.takesPlaceAt[0].openingDetails="Information horaire reçue";await ingest(store,convert(p));
    assert.strictEqual(store.activities.length,1);assert.strictEqual(store.provenances[0].source_payload.period.openingDetails,"Information horaire reçue");
  });
  await test("hors périmètre : contradiction réelle Atelier créatif conservée, règle ALLOW/DENY identique",()=>{
    const p=clone(fixtures.atelierCreatif),r=convert(p)[0];assert.strictEqual(r.activity.startsAt,"2026-10-29T14:00:00.000Z");
    assert(r.activity.description.includes("Vendredi 30 octobre"));assert.strictEqual(C.isRelevantForMnoria({sourceCategories:["Market"]}),false);assert.strictEqual(C.isRelevantForMnoria({sourceCategories:["Market","Concert"]}),true);
  });
  await test("disparition puis retour d'une variante de période : aucune nouvelle copie",async()=>{
    const store=new MemoryStore();await ingest(store,convert(carrier()));await ingest(store,convert(carrier([periods[1]])));
    await ingest(store,convert(carrier()));assert.strictEqual(store.activities.length,2);assert.strictEqual(store.provenances.length,2);
  });
  await test("trace du fuseau explicite et commune inconnue en Polynésie",()=>{
    const p=carrier([periods[0]]);p.timezone="UTC";const r=convert(p)[0];assert.strictEqual(r.sourcePayload.timezoneContext.poi,"UTC");assert.strictEqual(r.activity.timezone,"UTC");
    assert.throws(()=>C.inferTimezoneFromPoi(territory("987","98799")),/inconnue/);
  });
  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);if(failed)process.exitCode=1;
})();
