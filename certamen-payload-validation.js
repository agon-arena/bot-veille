// Validation/nettoyage des payloads Agôn Certamen avant publication — aucune publication
// ici, aucun appel IA. Travaille uniquement à partir des champs déjà calculés par
// analyzeCertamenSubjectWithAI() (via certamen-checked-subjects.js) : on ne génère jamais
// de texte de remplacement, on détecte et on classe (ready / needs_review / blocked).

const { getCheckedCertamenSubjects, buildCertamenAgonPayload } = require("./certamen-checked-subjects");

// Cap connu appliqué en amont (analyzeCertamenSubjectWithAI : .slice(0, 55)) : une position
// dont la longueur colle à cette limite et qui ne se termine pas par une ponctuation/espace
// a très probablement été coupée au milieu d'un mot (ex: "britanniq", "chale").
const POSITION_TRUNCATION_LIMIT = 55;

const WEAK_QUESTION_PATTERNS = [
  /reflète-t-(elle|il)/i,
  /\b(pragmatisme|idéalisme)\b/i,
  /\bportée (symbolique|réelle)\b/i
];

const DEBATE_MARKERS = /\b(faut-il|doit-on|devrait-on|peut-on|légaliser|interdire|réguler|réglementer|financer|sanctionner|autoriser|imposer|obliger)\b/i;

const THIN_THEMES = new Set(["Sports - loisirs", "Sciences - technologie"]);
const SPORT_TECH_RESULT_WORDS = /\b(résultat|score|qualification|élimination|finale|match|victoire|défaite|classement|tournoi)\b/i;
const SCORE_PATTERN = /\b\d+\s*[-–]\s*\d+\b/;

const PARTISAN_MARKERS = [
  /extrême droite/i,
  /extrême gauche/i,
  /pro-trump/i,
  /anti-trump/i,
  /\bfascis/i,
  /\bnazis/i
];

function dedupeLinksByUrl(links) {
  const seen = new Set();
  const deduped = [];
  for (const link of Array.isArray(links) ? links : []) {
    const url = String(link?.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    deduped.push(link);
  }
  return deduped;
}

function looksTruncated(text, limit = POSITION_TRUNCATION_LIMIT) {
  const t = String(text || "").trim();
  if (!t || t.length < limit - 3) return false;
  const lastChar = t[t.length - 1];
  if (/[\s.!?…»"')\]]/.test(lastChar)) return false;
  return true;
}

function isWeakQuestion(question) {
  const q = String(question || "").trim();
  if (!q) return true;
  if (q.length < 25) return true;
  if (!/\?\s*$/.test(q)) return true;
  return WEAK_QUESTION_PATTERNS.some((re) => re.test(q));
}

function isPartisanText(text) {
  const t = String(text || "");
  return PARTISAN_MARKERS.some((re) => re.test(t));
}

// Sujet sportif/technique réduit à un résultat ou un fait sans enjeu collectif : on
// n'exclut que si le thème est "à risque" ET qu'aucun marqueur de débat (faut-il,
// légaliser, réguler…) n'apparaît dans la question. Un sujet sportif avec un vrai enjeu
// (ex: choix d'un site de JO) n'est donc pas marqué.
function isThinSportsOrTechnicalSubject(payload) {
  if (!THIN_THEMES.has(String(payload.theme || "").trim())) return false;
  if (DEBATE_MARKERS.test(String(payload.question || ""))) return false;
  const text = `${payload.subject || ""} ${payload.question || ""} ${payload.resume || ""}`;
  return SCORE_PATTERN.test(text) || SPORT_TECH_RESULT_WORDS.test(text);
}

function validateAndCleanCertamenPayload(payload) {
  const reasons = [];
  const blockingReasons = [];
  const reviewReasons = [];

  const cleaned = { ...(payload || {}) };

  // Invariant absolu : jamais de bulle actu / récit Agôn pour Certamen.
  if (cleaned.storySelection !== null && cleaned.storySelection !== undefined) {
    reasons.push("story_selection_not_null");
  }
  cleaned.storySelection = null;

  const originalLinksCount = Array.isArray(cleaned.links) ? cleaned.links.length : 0;
  cleaned.links = dedupeLinksByUrl(cleaned.links);
  if (cleaned.links.length < originalLinksCount) {
    reasons.push("duplicate_links_removed");
  }

  cleaned.question = String(cleaned.question || "").trim();
  cleaned.positionA = String(cleaned.positionA || "").trim();
  cleaned.positionB = String(cleaned.positionB || "").trim();
  cleaned.theme = String(cleaned.theme || "").trim();
  cleaned.resume = String(cleaned.resume || "").trim();
  cleaned.arenaMode = cleaned.arenaMode === "libre" ? "libre" : "positions";

  if (!cleaned.question) {
    blockingReasons.push("missing_question");
  } else if (isWeakQuestion(cleaned.question)) {
    reviewReasons.push("weak_question");
  }

  if (cleaned.arenaMode === "positions") {
    if (!cleaned.positionA || !cleaned.positionB) {
      blockingReasons.push("missing_position");
    } else {
      if (looksTruncated(cleaned.positionA) || looksTruncated(cleaned.positionB)) {
        blockingReasons.push("position_truncated");
      }
      if (isPartisanText(cleaned.positionA) || isPartisanText(cleaned.positionB)) {
        reviewReasons.push("position_too_partisan");
      }
    }
  }

  if (isThinSportsOrTechnicalSubject(cleaned)) {
    reviewReasons.push("not_clivant_enough");
  }

  const allReasons = [...new Set([...reasons, ...blockingReasons, ...reviewReasons])];

  let status = "ready";
  if (blockingReasons.length) status = "blocked";
  else if (reviewReasons.length) status = "needs_review";

  return { payload: cleaned, status, reasons: allReasons };
}

// Sélectionne les 10 sujets Certamen cochés, construit leur payload brut, puis applique
// la validation/nettoyage. Ne publie rien : sert uniquement à la prévisualisation et au
// futur filtrage "mode strict" (seuls les "ready" seront publiables).
function getCheckedCertamenPayloadsPreview() {
  const checked = getCheckedCertamenSubjects();

  const items = checked.map(({ subject, savedItem }) => {
    const rawPayload = buildCertamenAgonPayload(subject, savedItem);
    const { payload: cleanedPayload, status, reasons } = validateAndCleanCertamenPayload(rawPayload);
    return {
      subject: subject.subject,
      status,
      reasons,
      rawPayload,
      cleanedPayload
    };
  });

  return {
    items,
    readyCount: items.filter((i) => i.status === "ready").length,
    blockedCount: items.filter((i) => i.status === "blocked").length,
    needsReviewCount: items.filter((i) => i.status === "needs_review").length
  };
}

// Mode strict : seuls les payloads "ready" doivent être considérés publiables. Les
// "blocked" ne le seront jamais ; les "needs_review" nécessitent une validation manuelle
// (non implémentée à cette étape — aucune publication n'est faite ici).
function filterPublishableCertamenPayloads(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item.status === "ready")
    .map((item) => item.cleanedPayload);
}

module.exports = {
  validateAndCleanCertamenPayload,
  getCheckedCertamenPayloadsPreview,
  filterPublishableCertamenPayloads
};
