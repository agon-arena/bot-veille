"use strict";

const { fetchOpenAgendaIcal } = require("./connectors/openagenda-ical");

const SOURCE_URL = "https://openagenda.com/agendas/56170473/events.v2.ics?relative%5B%5D=current&relative%5B%5D=upcoming";

async function main() {
  const results = await fetchOpenAgendaIcal({
    sourceName: "Senlis — Agenda officiel de la ville",
    sourceUrl: SOURCE_URL,
    defaultTimezone: "Europe/Paris",
    country: "FR",
    limit: 5
  });
  const counts = { VALID: 0, NEEDS_REVIEW: 0, INVALID: 0, ERROR: 0 };
  for (const result of results) {
    if (result.error || !result.validation) {
      counts.ERROR += 1;
      console.log({ error: result.error || "erreur inconnue" });
      continue;
    }
    counts[result.validation.status] += 1;
    const activity = result.validation.activity;
    console.log({
      title: activity.title,
      startsAt: activity.startsAt,
      place: activity.venueName || activity.city,
      locationType: activity.locationType,
      originalEventUrl: activity.provenances[0] && activity.provenances[0].originalEventUrl,
      validation: result.validation.status,
      issues: [...result.validation.errors, ...result.validation.warnings].map((entry) => entry.code)
    });
  }
  console.log({ fetched: results.length, ...counts });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
