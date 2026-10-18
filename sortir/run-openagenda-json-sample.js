"use strict";
// Démonstration bornée du connecteur OpenAgenda JSON. Lit OPENAGENDA_PUBLIC_KEY depuis
// l'environnement (jamais hardcodée) ; n'écrit rien nulle part.

require("dotenv").config();
const { fetchOpenAgendaJsonEvents } = require("./connectors/openagenda-json");

const AGENDA_UID = 56170473; // Senlis — Agenda officiel de la ville

async function main() {
  const apiKey = process.env.OPENAGENDA_PUBLIC_KEY;
  if (!apiKey) throw new Error("OPENAGENDA_PUBLIC_KEY absente de l'environnement");

  const { total, fetchedCount, truncated, results } = await fetchOpenAgendaJsonEvents({
    agendaUid: AGENDA_UID,
    apiKey,
    sourceName: "Senlis — Agenda officiel de la ville",
    maxEvents: 5,
    maxOccurrencesPerEvent: 3
  });

  const counts = { VALID: 0, NEEDS_REVIEW: 0, INVALID: 0, ERROR: 0 };
  for (const result of results) {
    if (result.error || !result.validation) { counts.ERROR += 1; console.log({ error: result.error || "erreur inconnue" }); continue; }
    counts[result.validation.status] += 1;
    const activity = result.validation.activity;
    console.log({
      title: activity.title,
      startsAt: activity.startsAt,
      place: activity.venueName || activity.city,
      locationType: activity.locationType,
      originalEventUrl: activity.provenances[0] && activity.provenances[0].originalEventUrl,
      tags: activity.tags,
      admissionType: activity.admissionType,
      externalIds: activity.externalIds,
      validation: result.validation.status
    });
  }
  console.log({ agendaEventsTotal: total, eventsFetched: fetchedCount, eventsTruncated: truncated, occurrencesProduced: results.length, ...counts });
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
