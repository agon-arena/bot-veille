"use strict";

const { fetchMobilizonEvents } = require("./connectors/mobilizon");

async function main() {
  const { total, results } = await fetchMobilizonEvents({
    endpoint: "https://mobilizon.picasoft.net/api",
    sourceName: "Mobilizon Picasoft",
    beginsOn: new Date().toISOString(),
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
  console.log({ available: total, fetched: results.length, ...counts });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
