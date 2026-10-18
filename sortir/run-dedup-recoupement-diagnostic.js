"use strict";
// Outil manuel de diagnostic — PAS un test automatique, PAS exécuté par un test runner.
// Compare deux agendas OpenAgenda réels (par défaut : Senlis officiel + Musées de Senlis) pour
// repérer, sur des données réelles et sans rien fabriquer, de véritables recoupements inter-sources
// (même UID des deux côtés) et des quasi-doublons naturels (même jour/lieu, UID différents).
// Fait un appel réseau réel vers openagenda.com mais n'écrit rien nulle part.
// Usage: node sortir/run-dedup-recoupement-diagnostic.js [uidA] [uidB]

const { fetchOpenAgendaIcal } = require("./connectors/openagenda-ical");
const { compareActivities } = require("./activity-deduplication");

const DEFAULT_SOURCE_A = { key: "openagenda-senlis", sourceName: "Senlis — Agenda officiel de la ville", agendaUid: "56170473" };
const DEFAULT_SOURCE_B = { key: "openagenda-musees-senlis", sourceName: "Musées de Senlis", agendaUid: "26110493" };
const MAX_CASES_PER_CATEGORY = 5;
const MAX_BUCKET_SIZE = 25; // garde-fou anti-explosion combinatoire sur un lieu très actif

function icsUrl(agendaUid) {
  return `https://openagenda.com/agendas/${agendaUid}/events.v2.ics?relative%5B%5D=current&relative%5B%5D=upcoming`;
}

async function fetchSource(source) {
  const sourceUrl = icsUrl(source.agendaUid);
  const results = await fetchOpenAgendaIcal({ sourceName: source.sourceName, sourceUrl, defaultTimezone: "Europe/Paris", country: "FR", limit: 2000 });
  return { ...source, sourceUrl, results: results.filter((r) => r.activity && r.validation && r.validation.status !== "INVALID") };
}

function uidOf(item) {
  const external = item.activity.externalIds.find((e) => e.system === "ical");
  return external ? external.value : null;
}

function bucketKey(item) {
  const day = item.activity.startsAt ? item.activity.startsAt.slice(0, 10) : "?";
  const venue = String(item.activity.venueName || item.activity.address || item.activity.city || "?").trim().toLocaleLowerCase("fr-FR");
  return `${day}|${venue}`;
}

function groupByBucket(items) {
  const map = new Map();
  for (const item of items) {
    const key = bucketKey(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// Recherche générique : aucun titre ni UID codé en dur. Reproductible sur n'importe quelle paire
// d'agendas OpenAgenda tant qu'ils publient des événements au même moment/lieu.
async function discoverRecoupement(sourceAConfig = DEFAULT_SOURCE_A, sourceBConfig = DEFAULT_SOURCE_B) {
  const sourceA = await fetchSource(sourceAConfig);
  const sourceB = await fetchSource(sourceBConfig);
  const bucketsA = groupByBucket(sourceA.results);
  const bucketsB = groupByBucket(sourceB.results);

  const caseA = []; // vrais doublons : même UID des deux côtés
  const caseB = []; // quasi-doublons réels : UID différents, décision REVIEW
  const control = []; // paires manifestement distinctes au même lieu/horaire (DISTINCT), à titre de contrôle

  for (const [key, itemsA] of bucketsA) {
    const itemsB = bucketsB.get(key);
    if (!itemsB || !itemsB.length) continue;
    if (itemsA.length + itemsB.length > MAX_BUCKET_SIZE) continue; // garde-fou
    for (const a of itemsA) {
      for (const b of itemsB) {
        const sameUid = uidOf(a) && uidOf(a) === uidOf(b);
        const comparison = compareActivities(a.activity, b.activity);
        const pair = { a, b, comparison, sameUid };
        if (sameUid && comparison.decision === "MATCH" && caseA.length < MAX_CASES_PER_CATEGORY) caseA.push(pair);
        else if (!sameUid && comparison.decision === "REVIEW" && caseB.length < MAX_CASES_PER_CATEGORY) caseB.push(pair);
        else if (!sameUid && comparison.decision === "DISTINCT" && control.length < 2) control.push(pair);
      }
    }
  }
  return { sourceA, sourceB, caseA, caseB, control };
}

function describe(activity) {
  return {
    title: activity.title,
    startsAt: activity.startsAt,
    venueName: activity.venueName,
    address: activity.address,
    organizers: activity.organizers,
    externalIds: activity.externalIds,
    originalEventUrl: activity.provenances[0] && activity.provenances[0].originalEventUrl,
    sourceName: activity.provenances[0] && activity.provenances[0].sourceName
  };
}

function printPair(label, pair) {
  console.log(`\n================ ${label} ================`);
  console.log("A:", JSON.stringify(describe(pair.a.activity), null, 2));
  console.log("B:", JSON.stringify(describe(pair.b.activity), null, 2));
  console.log("Signaux:", JSON.stringify(pair.comparison.signals, null, 2));
  console.log("DÉCISION:", pair.comparison.decision);
}

async function main() {
  const [agendaUidA, agendaUidB] = process.argv.slice(2);
  const sourceAConfig = agendaUidA ? { ...DEFAULT_SOURCE_A, agendaUid: agendaUidA } : DEFAULT_SOURCE_A;
  const sourceBConfig = agendaUidB ? { ...DEFAULT_SOURCE_B, agendaUid: agendaUidB } : DEFAULT_SOURCE_B;

  console.log(`Comparaison ${sourceAConfig.sourceName} (uid ${sourceAConfig.agendaUid}) vs ${sourceBConfig.sourceName} (uid ${sourceBConfig.agendaUid})...`);
  const { sourceA, sourceB, caseA, caseB, control } = await discoverRecoupement(sourceAConfig, sourceBConfig);
  console.log(`Occurrences valides chargées : ${sourceA.results.length} (A) / ${sourceB.results.length} (B)`);

  if (!caseA.length) console.log("\nAucun vrai doublon (même UID des deux côtés) trouvé dans ce run — rien n'a été fabriqué, c'est un résultat possible selon le contenu réel des agendas au moment du test.");
  caseA.forEach((pair, i) => printPair(`CAS A${i + 1} — vrai doublon (même UID)`, pair));

  if (!caseB.length) console.log("\nAucun quasi-doublon naturel (REVIEW) trouvé dans ce run.");
  caseB.forEach((pair, i) => printPair(`CAS B${i + 1} — quasi-doublon réel (REVIEW)`, pair));

  control.forEach((pair, i) => printPair(`CONTRÔLE${i + 1} — même lieu/horaire, événements distincts (DISTINCT)`, pair));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { discoverRecoupement, DEFAULT_SOURCE_A, DEFAULT_SOURCE_B, icsUrl };
