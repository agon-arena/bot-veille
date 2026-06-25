// Sélection des sujets Certamen cochés ("Sujets clivants" → "Cocher les 10") et préparation
// d'un payload Agôn minimal — étape de préparation uniquement, aucune publication ici.
//
// saved-subjects.json est un pool partagé avec la veille mixte : on ne retient un sujet
// coché que s'il appartient aussi à la dernière session Certamen (certamen-sessions.json),
// ce qui exclut naturellement les sujets cochés depuis la veille mixte.
//
// Les champs IA Certamen (question, positions, thème) sont déjà calculés à la collecte
// par analyzeCertamenSubjectWithAI() et stockés sous subject.certamen.* — on les lit en
// priorité. subject.ai n'est jamais utilisé : il est explicitement null sur les sujets
// Certamen (cf. runCertamenSession() dans veille-mixte.js).

const fs = require("fs");
const path = require("path");

const SAVED_FILE = path.join(__dirname, "saved-subjects.json");
const CERTAMEN_HISTORY_FILE = path.join(__dirname, "certamen-sessions.json");
const MAX_CHECKED_SUBJECTS = 10;

function loadSavedSubjectsForCertamen() {
  try {
    return JSON.parse(fs.readFileSync(SAVED_FILE, "utf8"));
  } catch {
    return [];
  }
}

function loadLatestCertamenSession() {
  try {
    const sessions = JSON.parse(fs.readFileSync(CERTAMEN_HISTORY_FILE, "utf8"));
    return Array.isArray(sessions) && sessions.length ? sessions[0] : null;
  } catch {
    return null;
  }
}

function loadAllCertamenSessions() {
  try {
    const sessions = JSON.parse(fs.readFileSync(CERTAMEN_HISTORY_FILE, "utf8"));
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

function getCheckedCertamenSubjects() {
  const latestSession = loadLatestCertamenSession();
  if (!latestSession || !Array.isArray(latestSession.subjects) || !latestSession.subjects.length) {
    return [];
  }

  const certamenSubjectsByTitle = new Map(
    latestSession.subjects.map((s) => [String(s.subject || "").trim(), s])
  );

  const saved = loadSavedSubjectsForCertamen();
  const matched = [];

  for (const savedItem of saved) {
    const title = String(savedItem.subject || "").trim();
    if (!title) continue;
    const certamenSubject = certamenSubjectsByTitle.get(title);
    if (!certamenSubject) continue;
    matched.push({ subject: certamenSubject, savedItem });
  }

  return matched.slice(0, MAX_CHECKED_SUBJECTS);
}

// Variante pilotée par le client (bouton "Tout générer" sur /certamen) : reçoit une liste
// explicite de titres (les sujets cochés/affichés à l'écran) au lieu de dériver la
// sélection de saved-subjects.json. Même source de vérité pour les champs IA
// (subject.certamen.*), mais cherche dans TOUTES les sessions conservées, pas seulement la
// plus récente : l'auto-collecte Certamen tourne en tâche de fond et peut remplacer la
// "dernière session" entre le chargement de la page côté client et le clic sur le bouton —
// un sujet encore affiché à l'écran ne doit pas devenir "introuvable" pour autant.
function getCertamenSubjectsByTitles(titles) {
  const sessions = loadAllCertamenSessions();
  if (!sessions.length) return [];

  // On part de la session la plus ancienne vers la plus récente afin que la version la
  // plus à jour d'un sujet (si son titre est identique entre deux sessions) gagne.
  const certamenSubjectsByTitle = new Map();
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    for (const s of Array.isArray(sessions[i].subjects) ? sessions[i].subjects : []) {
      certamenSubjectsByTitle.set(String(s.subject || "").trim(), s);
    }
  }

  const savedByTitle = new Map(
    loadSavedSubjectsForCertamen().map((s) => [String(s.subject || "").trim(), s])
  );

  const matched = [];
  for (const rawTitle of Array.isArray(titles) ? titles : []) {
    const title = String(rawTitle || "").trim();
    if (!title) continue;
    const certamenSubject = certamenSubjectsByTitle.get(title);
    if (!certamenSubject) continue;
    matched.push({ subject: certamenSubject, savedItem: savedByTitle.get(title) || null });
  }

  return matched.slice(0, MAX_CHECKED_SUBJECTS);
}

// Payload Agôn minimal : question + positions + thème, pas de résumé/article généré.
// Priorité absolue à subject.certamen.* ; fallback prudent sur le sujet enregistré
// (saved-subjects.json) ou le titre brut si un champ manque — jamais de nouvel appel IA.
function buildCertamenAgonPayload(subject, savedItem) {
  const certamen = subject.certamen || {};
  const saved = savedItem || {};

  const question = String(
    certamen.suggestedQuestion || saved.debateQuestion || subject.subject || ""
  ).trim().slice(0, 110);

  const positionA = String(certamen.positionA || saved.positionA || "").trim().slice(0, 55);
  const positionB = String(certamen.positionB || saved.positionB || "").trim().slice(0, 55);
  const theme = String(certamen.theme || saved.agonTheme || "").trim();
  const politicalOrientation = certamen.politicalOrientation || saved.politicalOrientation || null;

  const sources = Array.isArray(subject.sources) && subject.sources.length
    ? subject.sources.join(", ")
    : String(saved.sources || "");

  // Pas de texte de contenu pour Certamen : uniquement le titre (question) et les
  // positions. certamen.reason est une justification interne (diagnostic IA), jamais
  // destinée à être publiée — on ne la réutilise donc jamais ici.
  const resume = "";

  const links = Array.isArray(saved.contents)
    ? saved.contents
        .map((c) => ({
          title: c.title || "",
          url: c.link || "",
          source: c.source || "",
          type: c.type || "article"
        }))
        .filter((l) => l.url)
    : [];

  return {
    subject: subject.subject,
    question,
    positionA,
    positionB,
    theme,
    resume,
    sources,
    links,
    keywords: saved.mainKeyword ? [saved.mainKeyword] : [],
    storySelection: null,
    arenaMode: positionA && positionB ? "positions" : "libre",
    politicalOrientation
  };
}

module.exports = {
  MAX_CHECKED_SUBJECTS,
  getCheckedCertamenSubjects,
  getCertamenSubjectsByTitles,
  buildCertamenAgonPayload
};
