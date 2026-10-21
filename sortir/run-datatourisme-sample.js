"use strict";
// Démonstration bornée du connecteur DATAtourisme sur La Réunion (département 974). Lit
// DATATOURISME_API_KEY depuis l'environnement (jamais hardcodée) ; n'écrit rien nulle part,
// aucune écriture Supabase. Échantillon volontairement petit (defaultMaxEvents ci-dessous).

require("dotenv").config();
const { fetchDatatourismeEvents } = require("./connectors/datatourisme");

const REUNION_DEPARTMENT_INSEE = "974";
const DEFAULT_MAX_EVENTS = 30;

async function main() {
  const apiKey = process.env.DATATOURISME_API_KEY;
  if (!apiKey) {
    console.log("DATATOURISME_API_KEY absente de l'environnement : aucune requête réelle effectuée.");
    console.log("Pour l'ajouter : créer une clé gratuite sur https://www.datatourisme.fr/utiliser-les-donnees, puis ajouter dans .env (bot veille) :");
    console.log("  DATATOURISME_API_KEY=votre_cle_ici");
    console.log("Ensuite relancer : node sortir/run-datatourisme-sample.js");
    return;
  }

  const maxEvents = Number(process.argv[2]) || DEFAULT_MAX_EVENTS;
  const startedAt = Date.now();
  const { total, fetchedCount, pagesFetched, truncated, results } = await fetchDatatourismeEvents({
    apiKey,
    departmentInsee: REUNION_DEPARTMENT_INSEE,
    sourceName: "DATAtourisme — La Réunion",
    maxEvents,
    maxOccurrencesPerEvent: 5
  });
  const durationMs = Date.now() - startedAt;

  const counts = { VALID: 0, NEEDS_REVIEW: 0, INVALID: 0, ERROR: 0 };
  const samples = [];
  for (const result of results) {
    if (result.error || !result.validation) { counts.ERROR += 1; continue; }
    counts[result.validation.status] += 1;
    const activity = result.validation.activity;
    // Vérification explicite demandée : les coordonnées doivent tomber dans la zone de La
    // Réunion (approximativement lat [-21.5,-20.6], lon [55.0,56.0]) — alerte sans bloquer si
    // un résultat semble hors zone (filtre département différent d'un filtre géographique strict).
    const looksLikeReunion = typeof activity.latitude === "number" && typeof activity.longitude === "number"
      ? activity.latitude <= -20.6 && activity.latitude >= -21.5 && activity.longitude >= 55.0 && activity.longitude <= 56.0
      : null;
    if (samples.length < 10) {
      samples.push({
        title: activity.title,
        startsAt: activity.startsAt,
        city: activity.city,
        category: activity.sourceCategories[0] || null,
        venue: activity.address || activity.city,
        originalEventUrl: activity.provenances[0] && activity.provenances[0].originalEventUrl,
        externalId: activity.externalIds.find((e) => e.system === "datatourisme-poi")?.value,
        coordsInReunionBoundingBox: looksLikeReunion
      });
    }
  }

  console.log("=== Échantillon (jusqu'à 10 événements représentatifs) ===");
  console.log(JSON.stringify(samples, null, 1));
  console.log("\n=== Mesures ===");
  console.log(JSON.stringify({
    departmentFilter: REUNION_DEPARTMENT_INSEE,
    totalDisponibleCoteAPI: total,
    poisRecuperes: fetchedCount,
    requetesAPI: pagesFetched,
    occurrencesNormalisees: results.length,
    tempsExecutionMs: durationMs,
    truncated,
    ...counts
  }, null, 1));
}

main().catch((error) => { console.error("Échec:", error.message); process.exitCode = 1; });
