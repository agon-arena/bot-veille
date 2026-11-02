"use strict";
// Préfiltre des candidats de dédoublonnage pour le chemin non temporel (OpenAgenda, Paris,
// Mobilizon). Charger toutes les activités active/review de France sur la plage des nouvelles
// occurrences (28 k à 53 k lignes complètes depuis l'ingestion nationale DATAtourisme) a
// dépassé le tas de 160 Mo sur Render le 01/11/2026.
//
// Exactitude : on ne retire que des candidats pour lesquels compareActivities rend
// forcément DISTINCT, or seules les décisions MATCH/REVIEW sont exploitées et persistées.
// Hors branche DATAtourisme inter-POI (cible porteuse d'un datatourisme-poi : repli complet),
// une paire à ±12 h n'est jamais non-DISTINCT sans au moins l'un de ces signaux :
// identifiant externe partagé, URL d'origine partagée, même ville, même adresse, ≤ 100 m.
// Les clés sont calculées avec les fonctions mêmes du comparateur, sur des champs qui ne
// dépendent d'aucune autre colonne : une ligne allégée donne les mêmes clés qu'une complète.
const { normalizedText, canonicalUrl } = require("./activity-deduplication");
const { normalizeActivity } = require("./activity-validation");

const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const NEAR_METERS = 200; // marge au-dessus de la règle des 100 m

function distanceMeters(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat), dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Même formule de clé que sharedExternalId / sharedOriginalUrl. t : même instant que
// candidateMatches (Date.parse brut de startsAt cible / starts_at candidat).
function matchKeys(input, t) {
  const activity = normalizeActivity(input);
  const lat = activity.latitude, lon = activity.longitude;
  return {
    t,
    city: normalizedText(activity.city),
    address: normalizedText(activity.address),
    coords: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
    ids: activity.externalIds.map(item => `${normalizedText(item.system)}\u0000${String(item.value || "").trim()}`),
    urls: activity.provenances.map(item => canonicalUrl(item.originalEventUrl)).filter(Boolean)
  };
}

function createCandidatePrefilter(targets, toActivity) {
  // La branche inter-POI peut rendre REVIEW sans signal de lieu : aucun préfiltre sûr.
  if (targets.some(activity => (activity.externalIds || []).some(id => id.system === "datatourisme-poi"))) return null;
  const keyed = targets.map(activity => matchKeys(activity, Date.parse(activity.startsAt))).filter(k => Number.isFinite(k.t));
  const index = { city: new Map(), address: new Map(), ids: new Map(), urls: new Map() };
  const add = (map, key, k) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(k); };
  for (const k of keyed) {
    add(index.city, k.city, k); add(index.address, k.address, k);
    for (const id of k.ids) add(index.ids, id, k);
    for (const url of k.urls) add(index.urls, url, k);
  }
  const located = keyed.filter(k => k.coords);
  return function mayMatch(row) {
    const c = matchKeys(toActivity(row), Date.parse(row.starts_at));
    if (!Number.isFinite(c.t)) return false;
    const near = k => Math.abs(k.t - c.t) <= TWELVE_HOURS;
    const hit = list => (list || []).some(near);
    if (hit(index.city.get(c.city)) || hit(index.address.get(c.address))) return true;
    if (c.ids.some(id => hit(index.ids.get(id))) || c.urls.some(url => hit(index.urls.get(url)))) return true;
    return Boolean(c.coords) && located.some(k => near(k) && distanceMeters(k.coords, c.coords) <= NEAR_METERS);
  };
}

module.exports = { createCandidatePrefilter, matchKeys, TWELVE_HOURS, NEAR_METERS };
