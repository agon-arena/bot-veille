"use strict";

// Keep the diagnostic and contact URLs. Only this editorial warning may cease
// blocking a NEW DISTINCT DATAtourisme activity; identity decisions are unchanged.
function organizerWarningNonBlocking(validation, connectorType) {
  return connectorType === "datatourisme" && validation.status === "NEEDS_REVIEW" &&
    validation.errors.length === 0 && validation.warnings.length > 0 &&
    validation.warnings.every(w => w.code === "organizer_name_missing");
}

module.exports = { organizerWarningNonBlocking };
