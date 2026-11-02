"use strict";

// Garde-fou déterministe sur les fusions proposées par la déduplication IA
// (deduplicateSubjectsWithAI, veille-mixte.js). Le modèle ne voit que des subjectId et des
// titres ; sur de longues listes (150-250 sujets), il glisse parfois dans un groupe des
// identifiants sans rapport. Diagnostic du 02/11/2026 : l'arène midterms 4504 a reçu
// « L'Iran met en garde les États-Unis », la caricature de Mohammed VI et « 31 octobre :
// militants assignés à résidence » (vidéo Révolution permanente, devenue la vidéo principale
// de l'arène) — alors que ce dernier sujet avait sa vraie fusion dans un autre groupe.
//
// Règle : un sujet n'entre dans un groupe fusionné que s'il partage avec le sujet principal (ou
// un sujet déjà accepté) soit un mot significatif présent dans au moins deux titres du groupe
// (le cœur du sujet : « midterms », « Binance »…), soit au moins deux mots significatifs
// quelconques. Un seul mot rencontré une seule fois ne suffit pas : sur un gros groupe
// (36 titres pour les midterms), « condamné » suffisait à y rattacher la caricature de
// Mohammed VI. Aucun appel IA.

const MIN_SHARED_TOPIC_KEYWORDS = 2;

// Mots trop génériques pour prouver à eux seuls un même sujet d'actualité (en plus des
// mots vides déjà retirés par getKeywords). Forme nettoyée : minuscules, sans accents.
const GENERIC_TOPIC_KEYWORDS = new Set([
  "etats", "unis", "royaume", "gouvernement", "president", "presidente", "ministre", "premier",
  "francais", "francaise", "pays", "annee", "annees", "deux", "trois", "quatre",
  "faut", "veut", "peut", "doit", "sous", "sans", "nouvel", "grand", "grande",
  "premiere", "dernier", "derniere", "jour", "jours", "semaine", "heure", "heures",
  "minutes", "morts", "mort", "blesses", "personnes", "ville", "loin", "ancien",
  "ancienne", "fois", "veille", "cours", "ouvert", "selon"
]);

function getSubjectTitles(subject) {
  const titles = [subject?.subject, ...(Array.isArray(subject?.contents) ? subject.contents.map((c) => c?.title) : [])];
  return [...new Set(titles.map((title) => String(title || "").trim()).filter(Boolean))];
}

function getTitleKeywords(title, getKeywords) {
  return new Set(getKeywords(title).filter((word) => !GENERIC_TOPIC_KEYWORDS.has(word)));
}

// Nombre de titres distincts du groupe qui contiennent chaque mot significatif.
function addTitlesToAnchor(anchor, titles, getKeywords) {
  titles.forEach((title) => {
    if (anchor.titles.has(title)) return;
    anchor.titles.add(title);
    getTitleKeywords(title, getKeywords).forEach((word) => {
      anchor.frequency.set(word, (anchor.frequency.get(word) || 0) + 1);
    });
  });
}

function sharesTopicWithAnchor(titles, anchor, getKeywords) {
  const keywords = new Set();
  titles.forEach((title) => getTitleKeywords(title, getKeywords).forEach((word) => keywords.add(word)));
  let shared = 0;
  for (const word of keywords) {
    const frequency = anchor.frequency.get(word) || 0;
    if (frequency >= 2) return true;
    if (frequency === 1) shared++;
  }
  return shared >= MIN_SHARED_TOPIC_KEYWORDS;
}

// Renvoie { accepted, rejected } : accepted = sujets à fusionner dans keepSubject.
// Passes répétées : un sujet rejeté peut être repêché s'il partage le sujet d'un sujet
// accepté entre-temps (chaîne de formulations différentes d'une même actualité).
function filterIncoherentMergeSubjects(keepSubject, mergeSubjects, getKeywords) {
  const anchor = { titles: new Set(), frequency: new Map() };
  addTitlesToAnchor(anchor, getSubjectTitles(keepSubject), getKeywords);
  const pending = (mergeSubjects || []).map((subject) => ({ subject, titles: getSubjectTitles(subject) }));
  const acceptedSet = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of pending) {
      if (acceptedSet.has(entry) || !sharesTopicWithAnchor(entry.titles, anchor, getKeywords)) continue;
      addTitlesToAnchor(anchor, entry.titles, getKeywords);
      acceptedSet.add(entry);
      changed = true;
    }
  }
  return {
    accepted: pending.filter((entry) => acceptedSet.has(entry)).map((entry) => entry.subject),
    rejected: pending.filter((entry) => !acceptedSet.has(entry)).map((entry) => entry.subject)
  };
}

module.exports = { filterIncoherentMergeSubjects };
