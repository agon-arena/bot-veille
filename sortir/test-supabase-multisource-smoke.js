"use strict";

const assert = require("assert");
const { occurrenceKey, deepFreeze } = require("./run-supabase-multisource-smoke");

function result(rawStartsAt, normalizedStartsAt, metadata = {}) {
  const provenance = { externalId: "event-42", originalEventUrl: "https://example.test/events/42" };
  return {
    ...metadata,
    activity: { startsAt: rawStartsAt, provenances: [provenance] },
    validation: { activity: { startsAt: normalizedStartsAt, provenances: [provenance] } }
  };
}

assert.strictEqual(
  occurrenceKey(result("2027-03-05T13:00:00Z", "2027-03-05T13:00:00.000Z")),
  "event-42@2027-03-05T13:00:00.000Z"
);
assert.strictEqual(
  occurrenceKey(result("2026-10-16T19:50:00+00:00", "2026-10-16T19:50:00.000Z")),
  "event-42@2026-10-16T19:50:00.000Z"
);
assert.strictEqual(
  occurrenceKey(result("2026-10-16T19:50:00+00:00", "2026-10-16T19:50:00.000Z", { sourceRecordId: "record-7", sourceOccurrenceKey: "source-defined-key" })),
  "source-defined-key"
);

const frozen = deepFreeze([{ results: [result("2027-03-05T13:00:00Z", "2027-03-05T13:00:00.000Z")] }]);
assert(Object.isFrozen(frozen));
assert(Object.isFrozen(frozen[0].results[0].validation.activity));
assert.throws(() => { frozen[0].results.push(result("2027-03-06T13:00:00Z", "2027-03-06T13:00:00.000Z")); }, TypeError);

console.log("✓ runner multisource: clés normalisées et lot profondément figé");
