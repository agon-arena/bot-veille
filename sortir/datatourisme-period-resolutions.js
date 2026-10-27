"use strict";

// Human decisions for exact source representations, not POI exclusions. Both the
// redundant period AND its precise replacement must still be present unchanged.
// Any source evolution expires the decision and restores the normal REVIEW policy.
const decisions = Object.freeze([
  { uuid: "013a9d7d-900b-31a7-b736-93073a931ce2", approvedBy: "user", resolution: "redundant-date-only",
    redundant: { startDate: "2026-12-05", endDate: "2026-12-05" },
    replacement: { startDate: "2026-12-05", endDate: "2026-12-05", startTime: "10:00", endTime: "11:30" } },
  { uuid: "0220712b-c7bc-3196-aa3a-cc2c75b76c42", approvedBy: "user", resolution: "redundant-date-only",
    redundant: { startDate: "2026-11-07", endDate: "2026-11-07" },
    replacement: { startDate: "2026-11-07", endDate: "2026-11-07", startTime: "10:00", endTime: "18:30" } }
]);
const canonical = value => JSON.stringify(value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
function resolvedDatatourismePeriods(uuid, periods) {
  const decision = decisions.find(d => d.uuid === uuid);
  if (!decision || !periods.some(p => canonical(p) === canonical(decision.replacement))) return periods;
  return periods.filter(p => canonical(p) !== canonical(decision.redundant));
}
module.exports = { resolvedDatatourismePeriods };
