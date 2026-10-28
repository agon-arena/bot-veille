"use strict";

// Périmètre éditorial V1 partagé par le pilote et le scheduler ; aucun effet au chargement.
const { validateNormalizedActivity } = require("./activity-validation");

const PRODUCERS = Object.freeze([
  { agendaUid: 2568169, sourceName: "Bicentenaire de la Photographie - 2026-2027" },
  { agendaUid: 50316469, sourceName: "CINOR" },
  { agendaUid: 4740352, sourceName: "PUI VALIOTECH" },
  { agendaUid: 40627992, sourceName: "Innovons La Réunion" },
  { agendaUid: 1059482, sourceName: "GCS TESIS" }
].map(Object.freeze));

const CANDIDATES = Object.freeze({
  43961004: Object.freeze({ reviewField: "startsAt", review: "Les créneaux décrivent un projet multi-sites commencé en septembre ; le texte annonce notamment une exposition en décembre. Vérifier périmètre et dates." }),
  68013649: Object.freeze({ reason: "Exposition photographique, musée Léon Dierx, tout public." }),
  14738514: Object.freeze({ reason: "Congrès sur la transition écologique, ouverture au grand public annoncée, sur inscription." }),
  93891444: Object.freeze({ reason: "Séminaire recherche/innovation explicitement ouvert à toute personne intéressée, sur inscription." }),
  38318793: Object.freeze({ reviewField: "postalCode", review: "Rencontre sur la transition énergétique ; code postal absent. Géographie à résoudre sans inventer de code postal, et accès à confirmer." }),
  32268142: Object.freeze({ reason: "Conférences et tables rondes sur les enjeux du numérique en santé, sur inscription." })
});
const EXCLUSIONS = Object.freeze({
  59485599: "Salon collectivités/entreprises, orientation professionnelle, hors sélection V1.",
  67415611: "Visite touristique récurrente, hors sélection éditoriale V1.",
  74755368: "Collecte destinée aux agents de la DEAL, pas une activité publique proposée à Explorer.",
  43127128: "Atelier d'émergence de projets recherche/entreprises, orientation professionnelle, hors V1.",
  66169754: "Inscription réservée aux partenaires des 24h de l'innovation."
});
function decisionForEvent(eventUid) {
  const candidate = CANDIDATES[eventUid];
  return candidate ? { retain: true, ...candidate } : {
    retain: false, reason: EXCLUSIONS[eventUid] || "Événement non examiné : hors liste éditoriale V1."
  };
}
// La persistance revalide activity : une validation.status modifiée seule ne suffit pas.
// Réutilise la revue existante par champ et conserve sa preuve, sans changer le moteur.
function prepareItemForV1(item) {
  if (item.error || !item.activity) return item;
  const decision = decisionForEvent(item.sourcePayload?.eventUid);
  if (!decision.retain) return null;
  const activity = decision.review ? {
    ...item.activity,
    fieldConfidence: { ...item.activity.fieldConfidence, [decision.reviewField]: 0.5 },
    evidence: [...item.activity.evidence, { field: decision.reviewField, excerpt: decision.review, provenanceIndex: 0 }]
  } : item.activity;
  const validation = validateNormalizedActivity(activity);
  return { ...item, activity: validation.activity, validation,
    sourcePayload: { ...item.sourcePayload, editorialDecision: decision } };
}
module.exports = { PRODUCERS, CANDIDATES, EXCLUSIONS, decisionForEvent, prepareItemForV1 };
