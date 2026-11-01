"use strict";
const invalidPostalEqualInsee = new Set(require('./data/insee-not-postal-codes.json').codes);
const historicalReviewIds = new Set(require('./data/datatourisme-geographic-review-watchlist.json').activities.map(r=>r.id));
function inseeUsedAsPostal(postalCode, communeInsee) {
  const postal = String(postalCode || '').trim(), insee = String(communeInsee || '').trim();
  return !!postal && postal === insee && invalidPostalEqualInsee.has(insee);
}
module.exports = { inseeUsedAsPostal, historicalReviewIds };
