require("dotenv").config();

const storageSync = require("./storage-sync");

const express = require("express");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");
const stringSimilarity = require("string-similarity");
const { extractFromHtml } = require("@extractus/article-extractor");
const { fetchTranscript } = require("youtube-transcript");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MIXTE_PASSWORD = process.env.MIXTE_PASSWORD || "";
const AGON_URL = (process.env.AGON_URL || "http://localhost:3001").trim();
const SENT_TO_AGON_FILE = path.join(__dirname, "sent-to-agon.json");
const AUTO_COLLECT_FILE = path.join(__dirname, "auto-collect-config.json");
const AUTO_PUBLISH_FILE = path.join(__dirname, "auto-publish-config.json");
const PENDING_IDEAS_FILE = path.join(__dirname, "pending-ideas.json");
let autoCollectTimers = [];

function loadPendingIdeas() {
  try { return JSON.parse(fs.readFileSync(PENDING_IDEAS_FILE, "utf8")); }
  catch { return []; }
}

function savePendingIdeas(items) {
  fs.writeFileSync(PENDING_IDEAS_FILE, JSON.stringify(items, null, 2), "utf8");
}

function loadAutoCollectConfig() {
  try { return JSON.parse(fs.readFileSync(AUTO_COLLECT_FILE, "utf8")); }
  catch { return { enabled: false, times: ["08:00"] }; }
}

function getReunionTimeHHMM() {
  const parts = new Intl.DateTimeFormat("fr-FR", { timeZone: "Indian/Reunion", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const h = parts.find(p => p.type === "hour").value;
  const m = parts.find(p => p.type === "minute").value;
  return `${h}:${m}`;
}

function getReunionDateStr() {
  return new Date().toLocaleDateString("fr-CA", { timeZone: "Indian/Reunion" });
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Indian/Reunion est à UTC+4 toute l'année (pas d'heure d'été).
const REUNION_UTC_OFFSET_HOURS = 4;

function loadAutoPublishConfig() {
  try { return JSON.parse(fs.readFileSync(AUTO_PUBLISH_FILE, "utf8")); }
  catch { return { enabled: false }; }
}

// /refresh démarre la collecte en tâche de fond sur le worker (port 3002) et répond
// tout de suite : il faut attendre la fin réelle (via /progress) avant de lancer la
// publication auto, sinon elle s'exécute sur la session précédente déjà envoyée.
async function waitForVeilleMixteIdle(maxWaitMs = 25 * 60 * 1000, pollIntervalMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await fetch("http://127.0.0.1:3002/progress");
      const p = await r.json();
      if (!p.running) return true;
    } catch (err) {
      // erreur transitoire : on continue à essayer jusqu'au délai max
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

function scheduleOneAutoCollect(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const now = new Date();
  // Calcule la prochaine occurrence de h:m heure de la Réunion, indépendamment
  // du fuseau horaire local du process (ex: UTC sur Render).
  let next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    h - REUNION_UTC_OFFSET_HOURS, m, 0, 0
  ));
  // Boucle (pas un simple +24h) car la date UTC et la date Réunion peuvent
  // différer de plus d'un jour de décalage pour les heures 00h-03h59 Réunion.
  while (next <= now) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  const delay = next - now;
  const timer = setTimeout(async () => {
    autoCollectTimers = autoCollectTimers.filter(t => t !== timer);
    console.log(`[auto-collect] Déclenchement à ${timeStr}`);
    const cfg = loadAutoCollectConfig();
    if (cfg.enabled) {
      try {
        await fetch("http://127.0.0.1:3002/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ minSources: cfg.minSources || 3 })
        });
        const autoPub = loadAutoPublishConfig();
        if (autoPub.enabled) {
          const finished = await waitForVeilleMixteIdle();
          if (finished) {
            await runAutoPublishPipeline();
          } else {
            console.warn("[auto-collect] Délai d'attente dépassé, auto-publish annulé pour cette session.");
          }
        }
      } catch (err) {
        console.error(`[auto-collect] Erreur: ${err.message}`);
      }
      scheduleOneAutoCollect(timeStr);
    }
  }, delay);
  autoCollectTimers.push(timer);
  const nextDate = new Date(Date.now() + delay);
  console.log(`[auto-collect] Prochaine collecte ${timeStr} → ${nextDate.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`);
}

function scheduleAutoCollect(config) {
  autoCollectTimers.forEach(t => clearTimeout(t));
  autoCollectTimers = [];
  if (!config.enabled || !Array.isArray(config.times) || !config.times.length) return;
  config.times.forEach(t => scheduleOneAutoCollect(t));
}

const AGON_STORIES_FILE = process.env.AGON_STORIES_FILE
  || path.join(__dirname, "..", "SUPABASE copie 3", "data", "stories.json");
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const AGON_THEMES = [
  "Politique",
  "International",
  "Économie - emploi",
  "Société - éducation",
  "Sciences - technologie",
  "Climat - environnement",
  "Justice - faits divers",
  "Culture - modes",
  "Philosophie - sciences sociales",
  "Médias - divertissements",
  "Sports - loisirs",
  "Santé - bien-être",
  "Vie personnelle - modes de vie",
  "Espace jeunes"
];

const AGON_THEME_ALIASES = {
  "Politique, économie et relations internationales": "Politique",
  "Société, éducation et justice": "Société - éducation",
  "Sciences, technologies et environnement": "Sciences - technologie",
  "Culture, modes et médias": "Culture - modes",
  "Santé, corps et bien-être": "Santé - bien-être",
  "Sport, loisirs et passions": "Sports - loisirs",
  "Espace jeunes (collégiens - lycéens)": "Espace jeunes",
  "Économie / emploi": "Économie - emploi",
  "Société / éducation": "Société - éducation",
  "Sciences et technologie": "Sciences - technologie",
  "Justice / faits divers": "Justice - faits divers",
  "Culture - tendances": "Culture - modes",
  "Vie personnelle et modes de vie": "Vie personnelle - modes de vie"
};

function normalizeAgonTheme(theme) {
  const value = String(theme || "").trim();
  return AGON_THEMES.includes(value)
    ? value
    : (AGON_THEME_ALIASES[value] || AGON_THEMES[0]);
}

function buildAgonDebateUrl(debateId) {
  const normalizedId = String(debateId || "").trim();
  if (!normalizedId) return "";
  return `${AGON_URL.replace(/\/$/, "")}/debate?id=${encodeURIComponent(normalizedId)}`;
}

function loadSentToAgonItems() {
  if (!fs.existsSync(SENT_TO_AGON_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SENT_TO_AGON_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSentToAgonItems(items) {
  fs.writeFileSync(SENT_TO_AGON_FILE, JSON.stringify(items, null, 2), "utf8");
}

function safeJsonParse(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Réponse IA vide.");

  try {
    return JSON.parse(raw);
  } catch (error) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : (raw.match(/\{[\s\S]*\}/)?.[0] || "");

    if (candidate) {
      return JSON.parse(candidate);
    }

    throw error;
  }
}

function upsertSentToAgonItem(payload) {
  const subject = String(payload?.subject || "").trim();
  const question = String(payload?.question || "").trim();
  if (!subject && !question) {
    throw new Error("Sujet ou question manquants pour l'historique Agôn.");
  }

  const items = loadSentToAgonItems();
  const key = question || subject;
  const existingIndex = items.findIndex((item) => String(item.question || item.subject || "").trim() === key);
  const nextItem = {
    ...(existingIndex !== -1 ? items[existingIndex] : {}),
    ...payload,
    subject,
    question,
    sentAt: payload?.sentAt || new Date().toISOString()
  };

  if (existingIndex !== -1) {
    items[existingIndex] = nextItem;
  } else {
    items.unshift(nextItem);
  }

  saveSentToAgonItems(items);
  return nextItem;
}

function normalizeStoryText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getStoryKeywords(value) {
  const stopWords = new Set([
    "avec", "dans", "pour", "contre", "entre", "apres", "avant", "plus", "moins",
    "encore", "comme", "leurs", "leurs", "cette", "celui", "celle", "ceux", "elles",
    "nous", "vous", "eux", "mais", "donc", "etre", "avoir", "faire", "selon",
    "sujet", "histoire", "episode", "actualite", "actualites", "debats", "debat",
    "arene", "arenes", "question", "resume", "gauche", "droite", "politique", "france"
  ]);

  return normalizeStoryText(value)
    .split(" ")
    .filter(Boolean)
    .filter((word) => word.length >= 4)
    .filter((word) => !stopWords.has(word));
}

function limitStoryText(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1).trimEnd() + "…";
}

const AGON_ARTICLE_MIN_LENGTH = 800;
const AGON_ARTICLE_MAX_LENGTH = 1600;

// Coupe un texte à la dernière phrase complète sous maxLength — jamais en
// plein mot. Réservé au corps d'un article ou à un résumé ; les éléments de
// fin (devise, question, signature) ne passent jamais par ici.
function cutTextAtSentenceEnd(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  const window = value.slice(0, maxLength);
  for (let i = window.length - 1; i > 0; i--) {
    if (!".!?…".includes(window[i])) continue;
    const next = value[i + 1];
    if (next === undefined || /\s/.test(next)) {
      return value.slice(0, i + 1).trim();
    }
  }
  const lastSpace = window.lastIndexOf(" ");
  return (lastSpace > 0 ? window.slice(0, lastSpace) : window).trim();
}

// Assemblage final unique pour les deux arènes : les éléments de fin sont
// intouchables, seul le corps est raccourci (à une fin de phrase) pour que le
// tout tienne dans maxLength. Garantit qu'une coupe ne peut jamais emporter
// la devise, la question ou la signature.
function assembleArticleWithinLimit(body, tailLines, maxLength = AGON_ARTICLE_MAX_LENGTH) {
  const tail = (Array.isArray(tailLines) ? tailLines : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  const tailText = tail.join("\n\n");
  const budget = tailText ? maxLength - tailText.length - 2 : maxLength;
  const fittedBody = cutTextAtSentenceEnd(String(body || "").trim(), Math.max(budget, 200));
  return [fittedBody, tailText].filter(Boolean).join("\n\n");
}

function limitDebateQuestion(text) {
  return String(text || "").trim().replace(/\s*\?$/, " ?");
}

// Les modèles IA ont une connaissance figée à leur date d'entraînement : sans ce
// rappel explicite, ils peuvent évoquer une année passée comme si elle était
// actuelle. À insérer dans tout prompt qui mentionne "actuel", "récent" ou une date.
function buildCurrentDateContext() {
  const currentDateLabel = new Date().toLocaleDateString("fr-FR", { timeZone: "Indian/Reunion", year: "numeric", month: "long", day: "numeric" });
  return `Date actuelle : ${currentDateLabel}. Nous sommes en ${new Date().getFullYear()}. N'évoque jamais une autre année comme si elle était récente ou actuelle (ta connaissance s'arrête avant cette date, mais le contexte ci-dessus est réel et à jour).`;
}

const AGON_ARTICLE_SIGNATURE_LIST = [
  "J.L Grasso",
  "F. Glorennec",
  "T. Guyomarch",
  "M. Guillot",
  "P. Ratsky"
];
const AGON_ARTICLE_SIGNATURES = new Set(AGON_ARTICLE_SIGNATURE_LIST);
let agonArticleSignatureCursor = Math.floor(Math.random() * AGON_ARTICLE_SIGNATURE_LIST.length) - 1;

function getNextAgonArticleSignature() {
  agonArticleSignatureCursor = (agonArticleSignatureCursor + 1) % AGON_ARTICLE_SIGNATURE_LIST.length;
  return AGON_ARTICLE_SIGNATURE_LIST[agonArticleSignatureCursor];
}

function looksLikeLatinQuestionLine(line) {
  const value = String(line || "").trim();
  return /^[A-ZÀ-Ÿ][A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){1,4}$/.test(value);
}

const FRENCH_FUNCTION_WORDS = new Set([
  "le","la","les","un","une","des","du","de","en","au","aux",
  "et","est","sont","avec","pour","sur","sous","par","dans","vers",
  "qui","que","dont","mais","car","ni","ou","donc","ce","se",
  "il","elle","ils","elles","on","nous","vous","leur","leurs"
]);

function looksLikeLatinPhrase(line) {
  const cleaned = String(line || "").replace(/[.,;:!?'"«»]+/g, " ").replace(/\s+/g, " ").trim();
  if (!/^[A-ZÀ-Ÿ]/.test(cleaned)) return false;
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 12) return false;
  if (!words.every(w => /^[A-Za-zÀ-ÿ]+$/.test(w))) return false;
  // "et" est commun au latin et au français (ex. "Memoria et iustitia") : neutre
  return !words.map(w => w.toLowerCase()).filter(w => w !== "et").some(w => FRENCH_FUNCTION_WORDS.has(w));
}

function normalizeLatinQuestion(line) {
  const value = String(line || "")
    .replace(/[?？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "";
  if (/\bag[oô]n\b/i.test(value.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) {
    return "";
  }
  if (!looksLikeLatinQuestionLine(value)) return "";
  return value;
}

function buildFallbackLatinQuestion(payload = {}) {
  const text = [
    payload.subject,
    payload.summary,
    payload.debateQuestion,
    payload.narrativeTension
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const selected = "Res ipsa loquitur";
  return normalizeLatinQuestion(selected);
}

function normalizeArticleLineForCompare(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[?？!.,;:«»"""''`´()[\]{}\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitArticleOpeningSentence(bodyBlocks) {
  const blocks = Array.isArray(bodyBlocks)
    ? bodyBlocks.map((block) => String(block || "").trim()).filter(Boolean)
    : [];
  if (!blocks.length) return [];

  const firstBlock = blocks[0];
  const match = firstBlock.match(/^(.+?[.!?…])\s+(\S[\s\S]*)$/);
  if (!match) return blocks;

  const opening = match[1].trim();
  const rest = match[2].trim();
  if (!opening || !rest) return blocks;
  return [opening, rest, ...blocks.slice(1)];
}

function ensureArticleOpeningSentenceBreak(article) {
  const blocks = String(article || "")
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (!blocks.length) return "";
  return splitArticleOpeningSentence(blocks).join("\n\n").trim();
}


function extractLatinQuestionFromArticle(article) {
  const lines = String(article || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeLatinQuestion(lines[i]);
    if (candidate) return candidate;
  }

  return "";
}

function enforceFinalArticleQuestion(article, debateQuestion, latinQuestion, forcedSignature = "", options = {}) {
  const question = limitDebateQuestion(debateQuestion);
  const latin = normalizeLatinQuestion(latinQuestion) || extractLatinQuestionFromArticle(article);

  const forbiddenLines = [
    options.positionA,
    options.positionB
  ]
    .map(normalizeArticleLineForCompare)
    .filter(Boolean);
  const normalizedQuestion = normalizeArticleLineForCompare(question);
  const normalizedLatin = normalizeArticleLineForCompare(latin);

  const rawLines = String(article || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const signature = AGON_ARTICLE_SIGNATURES.has(forcedSignature)
    ? forcedSignature
    : rawLines.length && AGON_ARTICLE_SIGNATURES.has(rawLines[rawLines.length - 1])
    ? rawLines.pop()
    : getNextAgonArticleSignature();

  if (!question) {
    return assembleArticleWithinLimit(
      ensureArticleOpeningSentenceBreak(rawLines.join("\n\n")),
      [signature]
    );
  }

  const bodyBlocks = rawLines
    .filter((line) => {
      const normalizedLine = normalizeArticleLineForCompare(line);
      if (!normalizedLine) return false;
      if (AGON_ARTICLE_SIGNATURES.has(line)) return false;
      if (forbiddenLines.includes(normalizedLine)) return false;
      if (normalizedLatin && normalizedLine === normalizedLatin) return false;
      if (looksLikeLatinPhrase(line)) return false;
      if (/[?？]\s*$/.test(line)) return false;
      if (normalizedQuestion && normalizedLine === normalizedQuestion) return false;
      if (normalizedQuestion && normalizedLine.includes(normalizedQuestion)) return false;
      return true;
    });

  const body = splitArticleOpeningSentence(bodyBlocks).join("\n\n").trim();

  return assembleArticleWithinLimit(body, [latin, question, signature]);
}

function decodeLooseJsonString(value) {
  return String(value || "")
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .trim();
}

function buildFallbackStoryTitle(subject, theme) {
  const rawTopic = String(subject || "").trim();
  const normalizedTheme = normalizeAgonTheme(theme);

  const themeMap = {
    "Politique": "Actualité politique",
    "International": "Actualité internationale",
    "Économie / emploi": "Actualité économique",
    "Société / éducation": "Débat de société",
    "Sciences et technologie": "Actualité scientifique",
    "Climat - environnement": "Actualité environnementale",
    "Justice / faits divers": "Justice et faits divers",
    "Culture - tendances": "Actualité culturelle",
    "Médias - divertissements": "Médias et divertissements",
    "Sports - loisirs": "Actualité sportive",
    "Santé - bien-être": "Actualité santé",
    "Vie personnelle et modes de vie": "Modes de vie"
  };

  const cleaned = rawTopic
    .replace(/^EN DIRECT\s*[-:]\s*/i, "")
    .replace(/^DIRECT\s*[-:]\s*/i, "")
    .replace(/[?!.]+$/g, "")
    .trim();

  const beforeColon = cleaned.split(":")[0].trim();
  const shortBase = beforeColon || cleaned;
  const compact = limitStoryText(shortBase, 42).replace(/[?!.]+$/g, "").trim();

  if (compact && compact.split(/\s+/).length <= 6) {
    return compact;
  }

  return themeMap[normalizedTheme] || "Actualité en cours";
}

function buildSourceFacts(payload, maxItems = 5) {
  const items = Array.isArray(payload?.contents) ? payload.contents : [];
  return items
    .map((item) => {
      const title = String(item?.title || "").trim();
      if (!title) return "";
      const cleanedTitle = title
        .replace(/^\[\s*direct\s*\]\s*/i, "")
        .replace(/^direct\s*[-: ]\s*/i, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!cleanedTitle) return "";
      return /[.!?]$/.test(cleanedTitle) ? cleanedTitle : `${cleanedTitle}.`;
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function ensureNarrativeLength(text, payload, minLength = 600) {
  let value = String(text || "").trim();
  if (!value) return value;
  if (value.length >= minLength) return value;

  const resume = String(payload?.ai?.resume || "").trim();
  const subject = String(payload?.subject || "").trim();
  const theme = String(payload?.ai?.agonTheme || "").trim();
  const facts = buildSourceFacts(payload, 6);
  const expansions = [
    resume && !value.includes(resume) ? resume : "",
    facts.length ? `Plusieurs developpements convergent deja sur le meme point : ${facts.join(" ")}` : "",
    subject && !value.includes(subject) ? `Au coeur de cette sequence, ${subject}.` : "",
    theme ? `Cette actualite s'inscrit dans ${theme.toLowerCase()}, avec des effets qui peuvent vite depasser l'evenement du jour.` : ""
  ].filter(Boolean);

  for (const extra of expansions) {
    if (value.length >= minLength) break;
    if (!extra) continue;
    value = `${value}
${limitStoryText(extra, 900)}`.trim();
  }

  return value;
}

function buildFallbackClosingLine(payload, storySuggestion) {
  const isPositionsArena = String(payload?.ai?.arenaMode || "").trim() === "positions";
  const subject = String(payload?.subject || "").trim();
  const theme = String(payload?.ai?.agonTheme || "").trim();

  const positionCandidates = [
    subject ? `La contradiction ouverte autour de ${limitStoryText(subject.replace(/[?!.]+$/g, ""), 90)} ne fait que commencer.` : "",
    theme ? `${theme} entre dans une phase plus delicate.` : "",
    "Le point de rupture politique est peut-etre plus proche qu'il n'y parait."
  ];

  const libreCandidates = [
    subject ? `Jusqu'ou cette secousse autour de ${limitStoryText(subject.replace(/[?!.]+$/g, ""), 90)} peut-elle aller ?` : "",
    theme ? `Jusqu'ou ${theme.toLowerCase()} peut-il etre bouscule par cette nouvelle sequence ?` : "",
    "Ce nouvel episode peut-il faire bouger le rapport de force ?"
  ];

  const candidates = (isPositionsArena ? positionCandidates : libreCandidates)
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  return limitStoryText(candidates[0] || "La sequence vient de prendre un tour plus expose.", 160);
}

function buildFallbackNarrativeContext(payload, storySuggestion) {
  const latestEvent = String(payload?.ai?.resume || payload?.subject || "").trim();
  const subject = String(payload?.subject || "").trim();
  const opening = buildFallbackClosingLine(payload, storySuggestion);
  const facts = buildSourceFacts(payload, 3);
  const isPositionsArena = String(payload?.ai?.arenaMode || "").trim() === "positions";
  const debateQuestion = String(payload?.ai?.debateQuestion || "").trim();

  const paragraphParts = [
    latestEvent ? latestEvent.replace(/^Nouvel épisode\s*:\s*/i, "") : "",
    facts.length ? `Les sources convergent surtout sur ceci : ${facts.join(" ")}` : "",
    subject && !latestEvent ? `Le coeur du sujet reste ${subject}.` : ""
  ].filter(Boolean);

  const articleBody = limitStoryText(paragraphParts.join(" "), 760);
  const lines = [articleBody];
  if (opening) lines.push(limitStoryText(opening, 160));
  if (isPositionsArena && debateQuestion) lines.push(debateQuestion);

  const base = lines.filter(Boolean).join("\n");
  return sanitizeNarrativeText(ensureNarrativeLength(base, payload, 600), { payload });
}


function buildStoryHistoryLine(story) {
  const summary = String(story?.story_summary || "").trim();
  if (summary) return limitStoryText(summary, 320);
  const latest = String(story?.latest_episode_summary || "").trim();
  if (latest) return limitStoryText(latest, 220);
  return "";
}

function sanitizeNarrativeText(text, options = {}) {
  const allowHistoryLine = Boolean(options.allowHistoryLine);
  const injectedHistoryLine = String(options.historyLine || "").trim();
  const normalizedInjectedHistory = injectedHistoryLine
    ? `L'histoire jusqu'ici : ${injectedHistoryLine}`
    : "";
  const payload = options.payload || null;

  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => String(line || "").trim())
    .filter(Boolean);

  const cleanedLines = [];
  let historyLineAlreadyKept = false;

  lines.forEach((line) => {
    const normalized = line.replace(/\s+/g, " ").trim();
    const lower = normalized.toLowerCase();

    if (
      lower.startsWith("jusqu'ici, aucun") ||
      lower.startsWith("jusqu'ici, aucun") ||
      lower.startsWith("aucune histoire associee") ||
      lower.startsWith("aucune histoire associée") ||
      lower.startsWith("aucun article precedent") ||
      lower.startsWith("aucun article précédent") ||
      lower.startsWith("pas d'episode precedent") ||
      lower.startsWith("pas d'épisode précédent")
    ) {
      return;
    }

    if (lower.startsWith("l'histoire jusqu'ici :") || lower.startsWith("l'histoire jusqu'ici :")) {
      if (!allowHistoryLine || historyLineAlreadyKept) {
        return;
      }
      historyLineAlreadyKept = true;
      cleanedLines.push(normalizedInjectedHistory || normalized);
      return;
    }

    cleanedLines.push(normalized);
  });

  if (allowHistoryLine && normalizedInjectedHistory) {
    const existingIndex = cleanedLines.findIndex((line) => {
      const lower = line.toLowerCase();
      return lower.startsWith("l'histoire jusqu'ici :") || lower.startsWith("l'histoire jusqu'ici :");
    });
    if (existingIndex === -1) {
      cleanedLines.unshift(normalizedInjectedHistory);
    } else {
      cleanedLines[existingIndex] = normalizedInjectedHistory;
    }
  }

  const isPositionsArena = String(payload?.ai?.arenaMode || "").trim() === "positions";
  const debateQuestion = String(payload?.ai?.debateQuestion || "").trim();
  if (isPositionsArena && debateQuestion) {
    const normalizedLines = cleanedLines.filter((line) => line !== debateQuestion);
    const finalCliff = buildFallbackClosingLine(payload, null);
    const lastLine = normalizedLines[normalizedLines.length - 1] || "";

    if (!normalizedLines.length) {
      normalizedLines.push(finalCliff);
    } else if (/[?]$/.test(lastLine)) {
      normalizedLines[normalizedLines.length - 1] = finalCliff;
    }

    normalizedLines.push(debateQuestion);
    return normalizedLines.join("\n").trim();
  }

  return cleanedLines.join("\n").trim();
}

function buildFullArticleFallback(payload, story) {
  const parts = [];
  const historyLine = buildStoryHistoryLine(story);
  const previousEpisode = String(story?.latest_episode_summary || "").trim();
  const latestEvent = String(payload.ai?.resume || payload.subject || "").trim();
  const opening = buildFallbackClosingLine(payload, story ? { story_decision: "existing_story" } : null);

  if (historyLine) {
    parts.push(`L'histoire jusqu'ici : ${historyLine}`);
  }
  if (previousEpisode) {
    parts.push(limitStoryText(previousEpisode, 320));
  }
  if (latestEvent) {
    parts.push(limitStoryText(latestEvent, 1600));
  }
  if (opening) {
    parts.push(limitStoryText(opening, 220));
  }
  return sanitizeNarrativeText(parts.filter(Boolean).join("\n"), {
    allowHistoryLine: Boolean(historyLine),
    historyLine,
    payload
  });
}

// ── Récupération du texte complet d'un article ──────────────────────────────
async function fetchArticleFullText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BotVeille/1.0; +https://agon.app)" }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const article = await extractFromHtml(html, url);
    if (!article || !article.content) return null;
    const text = article.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { text, charCount: text.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Détection paywall / article tronqué ─────────────────────────────────────
const PAYWALL_PATTERNS = [
  /réservé[e]?\s+aux\s+abonné[e]?s/i,
  /abonnez[-\s]vous\s+pour\s+(lire|continuer|accéder)/i,
  /pour\s+lire\s+la\s+suite/i,
  /article\s+réservé/i,
  /déjà\s+abonné\b/i,
  /se\s+connecter\s+pour\s+lire/i,
  /cet\s+article\s+est\s+réservé/i,
  /accès\s+réservé/i,
  /contenu\s+réservé/i,
  /subscribe\s+to\s+(continue|read)/i,
  /this\s+(article|content)\s+is\s+for\s+subscribers/i,
  /premium\s+content/i,
];

function isCompleteUsableArticle(text) {
  if (!text || text.length < 600) return false;
  for (const pat of PAYWALL_PATTERNS) {
    if (pat.test(text)) return false;
  }
  return true;
}

// ── Extraction d'ID YouTube depuis n'importe quelle URL ─────────────────────
function extractYouTubeIdFromAnyUrl(url) {
  const s = String(url || "");
  const watchMatch = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];
  const shortMatch = s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];
  const pathMatch = s.match(/\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{11})/);
  if (pathMatch) return pathMatch[1];
  return null;
}

// ── Récupération d'une transcription YouTube ────────────────────────────────
async function fetchYouTubeTranscriptText(url) {
  const videoId = extractYouTubeIdFromAnyUrl(url);
  if (!videoId) return null;
  try {
    let segments;
    try {
      segments = await fetchTranscript(videoId, { lang: "fr" });
    } catch {
      segments = await fetchTranscript(videoId);
    }
    if (!Array.isArray(segments) || segments.length === 0) return null;
    const text = segments.map(s => s.text).join(" ").replace(/\s+/g, " ").trim();
    if (text.length < 300) return null;
    return { text, charCount: text.length };
  } catch {
    return null;
  }
}

// ── Sélection des sources exploitables pour le résumé factuel ───────────────
async function selectFactualSources(allContents) {
  const articles = allContents.filter(c => c.type !== "youtube");
  const videos = allContents.filter(c => c.type === "youtube");

  const stats = {
    articlesChecked: articles.length,
    articlesUsed: 0,
    articlesIgnored: 0,
    videosChecked: 0,
    videosUsed: 0,
    videosIgnored: 0,
  };

  // Fetch tous les articles en parallèle, dans l'ordre de pertinence existant
  const fetchResults = await Promise.allSettled(
    articles.map(a => fetchArticleFullText(a.url))
  );

  const usable = [];

  for (let i = 0; i < articles.length; i++) {
    if (usable.length >= 4) break;
    const fetched = fetchResults[i].status === "fulfilled" ? fetchResults[i].value : null;
    if (fetched && isCompleteUsableArticle(fetched.text)) {
      usable.push({ ...articles[i], sourceKind: "article complet", fullText: fetched.text });
      stats.articlesUsed++;
    } else {
      const reason = !fetched
        ? "inaccessible/timeout"
        : fetched.text.length < 600 ? "texte trop court" : "paywall/tronqué";
      console.log(`[résumé factuel] IGNORÉ article "${articles[i].title.slice(0, 60)}" — ${reason}`);
      stats.articlesIgnored++;
    }
  }

  // Compléter jusqu'à 4 avec des transcriptions YouTube si nécessaire
  if (usable.length < 4 && videos.length > 0) {
    for (const video of videos) {
      if (usable.length >= 4) break;
      stats.videosChecked++;
      const fetched = await fetchYouTubeTranscriptText(video.url);
      if (fetched) {
        usable.push({ ...video, sourceKind: "transcription vidéo", fullText: fetched.text });
        stats.videosUsed++;
      } else {
        console.log(`[résumé factuel] IGNORÉ vidéo "${video.title.slice(0, 60)}" — pas de transcription`);
        stats.videosIgnored++;
      }
    }
  }

  console.log(`[résumé factuel] ${stats.articlesUsed} article(s) complet(s), ${stats.videosUsed} vidéo(s) (transcription), ${stats.articlesIgnored + stats.videosIgnored} source(s) ignorée(s)`);

  if (usable.length === 0) {
    throw new Error("Aucune source exploitable — article complet accessible ou vidéo avec transcription — trouvée parmi les sources sélectionnées.");
  }

  return { usable, stats };
}

async function generateCompleteNarrativeContext(payload, storySelection) {
  function cleanSummarySourceTitle(title) {
    return String(title || "")
      .replace(/\s*[•|-]\s*[A-Z0-9À-Ÿ'' ]{2,}$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const allContents = (Array.isArray(payload?.contents) ? payload.contents : [])
    .map((item) => ({
      source: String(item?.source || "").trim(),
      title: cleanSummarySourceTitle(item?.title || ""),
      type: String(item?.type || "article").trim(),
      url: String(item?.link || item?.url || "").trim(),
      summary: String(item?.summary || "").trim(),
      date: String(item?.date || "").trim()
    }))
    .filter((item) => item.title || item.url);

  if (!openai) {
    throw new Error("OPENAI_API_KEY manquant pour générer le résumé.");
  }

  const { usable } = await selectFactualSources(allContents);

  const prompt = `Tu es un assistant éditorial pour Agôn.

${buildCurrentDateContext()}

Ta mission : produire un résumé factuel clair à partir des sources fournies.

Agôn ne veut pas republier une revue de presse. Cette étape sert uniquement à comprendre ce qui s'est passé, de façon neutre et fiable.

Objectif :
- établir les faits principaux ;
- identifier les acteurs concernés ;
- rester strictement dans les informations présentes dans les sources.

Règles absolues :
- Fonde-toi exclusivement sur le texte intégral des sources ci-dessous.
- Ne rien inventer.
- Ne pas extrapoler.
- Ne pas dramatiser.
- Ne pas créer de débat.
- Ne pas poser de question.
- Ne pas analyser les différences de traitement médiatique.
- Ne pas écrire comme une dépêche froide.
- Ne pas copier les formulations des sources.
- Ne pas mentionner "les médias" en général si les sources ne permettent pas de le dire.
- Si une information est absente, incertaine ou contradictoire, ne pas l'ajouter.
- Si les sources sont peu nombreuses, reste proportionnellement prudent dans l'ampleur des conclusions.
- Pour les transcriptions vidéo : n'utilise que ce qui est dit explicitement ; distingue les faits rapportés des opinions ou commentaires exprimés.

Important :
Le résumé doit rester factuel, neutre et strictement fondé sur les informations présentes dans les sources.
Même si le résumé reste factuel, évite le ton administratif ou mou.
La première phrase doit être concrète, directe et située : elle doit faire entrer dans l'événement, pas seulement l'annoncer.
Fais apparaître sobrement ce qui rend l'événement sensible : lieu, acteurs, incertitude, risque immédiat, décision attendue ou rapport de force.
Ne commence pas par une formule générique si un fait précis permet une entrée plus vive.

Sortie attendue :
Texte brut uniquement, sans titre, sans signature, sans liste.

Structure du texte :
1. Une première phrase qui résume clairement le sujet.
2. Quelques phrases qui expliquent les faits principaux.
3. Une phrase finale qui indique l'enjeu immédiat ou la décision qui se pose.

RÈGLE DE SÉCURITÉ FACTUELLE :
Tu ne dois jamais enrichir les faits par mémoire, déduction ou vraisemblance.
N'ajoute jamais :
- une fonction politique ou institutionnelle ;
- un chiffre ;
- un statut judiciaire ;
- une réaction politique, syndicale ou associative ;
- une causalité ;
- une décision officielle ;
- une responsabilité.
Si une information n'est pas explicitement présente dans les sources fournies, enlève-la ou formule prudemment.
Exemples :
- Écrire "Sébastien Lecornu a proposé…", pas "Sébastien Lecornu, ministre de…", sauf si la source donne ce titre.
- Écrire "65 personnes présentées à la justice", pas "65 condamnés" ni "65 auteurs".
- Écrire "une piste évoquée", pas "une mesure décidée".
Principe central : tu peux améliorer le style, la clarté et l'enjeu, mais tu ne dois jamais compléter les faits.

Longueur :
1000 à 1500 caractères.

Sujet :
${payload.subject || ""}

Sources (texte intégral) :
${JSON.stringify({
  contents: usable.map((item) => ({
    title: item.title,
    type: item.sourceKind,
    date: item.date,
    text: item.fullText.slice(0, 6000)
  }))
}, null, 2)}

Réponds uniquement en texte brut.`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.35,
      max_output_tokens: 1500
    });
    const text = String(response.output_text || "").trim();
    if (!text) throw new Error("Réponse vide de l'IA pour le résumé.");
    return cutTextAtSentenceEnd(text, 1800);
  } catch (error) {
    throw new Error(error.message || "Erreur génération résumé");
  }
}

async function generateMediaAnalysis(payload) {
  const summary = String(payload?.summary || "").trim();
  const subject = String(payload?.subject || "").trim();
  const sourceTitles = Array.isArray(payload?.contents)
    ? payload.contents.map(c => String(c?.title || "").trim()).filter(Boolean).slice(0, 8)
    : [];

  if (!summary) {
    throw new Error("Résumé manquant pour l'analyse médiatique.");
  }

  if (!openai) {
    return { hasMediaContrast: false, mediaTreatment: "" };
  }

  const sourcesTitlesSection = sourceTitles.length
    ? `\nTitres des sources disponibles :\n${sourceTitles.map(t => `- "${t}"`).join("\n")}`
    : "";

  const prompt = `Tu es un stratège éditorial pour Agôn.

${buildCurrentDateContext()}

À partir du résumé factuel et des titres de sources, trouve le vrai débat révélé par cette actualité.

Le débat doit :
* opposer deux positions raisonnables ;
* porter sur un vrai choix collectif ;
* éviter les évidences morales ;
* rester concret et lié aux faits.

Évite les fausses questions comme :
"Faut-il protéger les enfants ?", "Faut-il éviter les accidents ?", "Faut-il empêcher la guerre ?"

Si la question est trop évidente, cherche le dilemme réel :
sécurité/liberté, fermeté/accompagnement, urgence/prudence, diplomatie/rapport de force, innovation/protection, responsabilité individuelle/action publique.

Pour les sujets sans décision collective directe (fait divers, accident, catastrophe, affaire judiciaire, violence, décès) : ne cherche pas le débat dans l'événement lui-même. Cherche-le dans la réponse collective — médiatisation, fonctionnement des institutions, traitement sociétal. N'utilise cet angle "réponse collective" que si le résumé factuel mentionne déjà, explicitement, un élément concret de cette réponse (réaction citée, mesure évoquée, polémique engagée, dispositif existant). Si le résumé ne contient aucun élément de ce type, ne fabrique pas un tel angle : choisis "understand" ou "avoid". Exemple valable seulement si le résumé évoque déjà la médiatisation : une disparition médiatisée → "La médiatisation d'une disparition aide-t-elle l'enquête ou menace-t-elle la présomption d'innocence ?". Si aucun angle pertinent n'émerge, choisis "avoid".

RÈGLE D'ANCRAGE FACTUEL DE LA QUESTION :
debateAngle, narrativeTension et debateQuestion ne doivent désigner aucune mesure, chiffre, dispositif, proposition ou acteur qui n'apparaît pas explicitement dans le résumé factuel.
Les titres de sources peuvent t'aider à repérer un angle, mais tout élément concret cité dans la question finale (mesure, chiffre, dispositif, proposition, acteur) doit être traçable mot pour mot dans le résumé factuel — pas seulement dans un titre.
Si un titre évoque un élément que le résumé factuel ne reprend pas, ignore cet élément pour construire la question : reste au niveau de généralité que permet le résumé.
La question doit pouvoir se déduire de ce qui est écrit dans le résumé factuel, sans information supplémentaire.

RÈGLE DE SÉCURITÉ FACTUELLE :
N'ajoute jamais un fait absent du résumé factuel ou des titres fournis.
N'enrichis pas par mémoire, déduction ou vraisemblance.

Interdit d'ajouter :
* une fonction politique ou institutionnelle ;
* un chiffre ;
* un statut judiciaire ;
* une réaction politique, syndicale ou associative ;
* une causalité ;
* une décision officielle ;
* une responsabilité.

Si une information n'est pas explicitement présente dans le résumé factuel ou les titres fournis, enlève-la ou formule prudemment.

Exemples :
* "Sébastien Lecornu a proposé…", pas "Sébastien Lecornu, ministre de…", sauf si le titre est donné.
* "65 personnes présentées à la justice", pas "65 condamnés".
* "une piste évoquée", pas "une mesure décidée".

Principe central :
tu peux améliorer la clarté, le style et l'enjeu, mais jamais compléter les faits.

Réponds uniquement en JSON :
{
  "debatePotential": "fort | moyen | faible",
  "debateAngle": "enjeu réel en une phrase, max 180 caractères",
  "narrativeTension": "pourquoi le choix est difficile, avec deux risques opposés",
  "debateQuestion": "question Agôn, max 80 caractères",
  "positionA": "camp A, max 55 caractères",
  "positionB": "camp B, max 55 caractères",
  "editorialDecision": "arena | understand | reformulate | avoid"
}

Si le sujet ne permet pas un vrai débat, choisis "understand" ou "avoid".

Sujet :
${subject}

Résumé factuel :
${summary}
${sourcesTitlesSection}

Réponds uniquement en JSON valide, sans balises markdown.`;

  const response = await openai.responses.create({
    model: "gpt-4o",
    input: prompt,
    temperature: 0.5,
    max_output_tokens: 900
  });

  let parsed = {};
  try {
    parsed = safeJsonParse(response.output_text || "");
  } catch (error) {
    parsed = {};
  }

  const allowedEditorialDecisions = new Set(["arena", "understand", "reformulate", "avoid"]);
  const possibleBiases = Array.isArray(parsed.possibleBiases)
    ? parsed.possibleBiases.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4)
    : [];

  const debateQuestion = limitDebateQuestion(String(parsed.debateQuestion || "").trim());
  let positionA = String(parsed.positionA || "").trim().slice(0, 55);
  let positionB = String(parsed.positionB || "").trim().slice(0, 55);

  const aligned = await alignPositionsByPolitics({ debateQuestion, positionA, positionB });
  positionA = aligned.positionA;
  positionB = aligned.positionB;

  return {
    hasMediaContrast: false,
    mediaTreatment: "",
    mainIssue: String(parsed.mainIssue || "").trim(),
    narrativeTension: String(parsed.narrativeTension || "").trim(),
    possibleBiases,
    debatePotential: String(parsed.debatePotential || "").trim(),
    editorialWarning: String(parsed.editorialWarning || "").trim(),
    debateAngle: String(parsed.debateAngle || "").trim().slice(0, 180),
    debateQuestion,
    positionA,
    positionB,
    politicalOrientation: aligned.politicalOrientation || { isPolitical: false, positionA: null, positionB: null },
    editorialDecision: allowedEditorialDecisions.has(String(parsed.editorialDecision || "").trim())
      ? String(parsed.editorialDecision || "").trim()
      : "avoid",
    questionQuality: Number(parsed.questionQuality) || 0
  };
}

async function alignPositionsByPolitics({ debateQuestion, positionA, positionB }) {
  if (!openai || !debateQuestion || !positionA || !positionB) {
    return { positionA, positionB };
  }

  const prompt = `Tu analyses une question de débat et ses deux positions.

Question : "${debateQuestion}"
Position A : "${positionA}"
Position B : "${positionB}"

Ta mission :
Déterminer si cette question révèle un clivage politique gauche/droite, même tendanciel ou probable.

Un clivage gauche/droite existe quand une des positions s'aligne tendanciellement avec des valeurs de gauche (solidarité, régulation, services publics, égalité, collectif) et l'autre avec des valeurs de droite (liberté individuelle, marché, sécurité, mérite, souveraineté nationale).

Même si le clivage n'est pas parfaitement symétrique ou évident, réponds true dès qu'une orientation probable se dégage. Ne réponds false que si le débat est vraiment neutre politiquement (purement technique, scientifique ou factuel).

JSON attendu uniquement :
{
  "hasPoliticalOrientation": true/false,
  "leftPosition": "...",
  "rightPosition": "..."
}

Si hasPoliticalOrientation est false, leftPosition et rightPosition sont des chaînes vides.

Réponds uniquement en JSON valide, sans balises markdown.`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.4,
      max_output_tokens: 200
    });
    const parsed = safeJsonParse(response.output_text || "");
    if (parsed.hasPoliticalOrientation && parsed.leftPosition && parsed.rightPosition) {
      return {
        positionA: String(parsed.leftPosition).trim().slice(0, 55),
        positionB: String(parsed.rightPosition).trim().slice(0, 55),
        politicalOrientation: { isPolitical: true, positionA: "left", positionB: "right" }
      };
    }
  } catch (e) {
    // fall through
  }
  return { positionA, positionB, politicalOrientation: { isPolitical: false, positionA: null, positionB: null } };
}




async function generateStyledArticle(payload) {
  const subject = String(payload?.subject || "").trim();
  const summary = String(payload?.summary || "").trim();
  const hasMediaContrast = payload?.hasMediaContrast === true;
  const mediaTreatment = String(payload?.mediaTreatment || "").trim();
  const debateAngle = String(payload?.debateAngle || "").trim();
  const debateQuestion = String(payload?.debateQuestion || "").trim();
  const positionA = String(payload?.positionA || "").trim();
  const positionB = String(payload?.positionB || "").trim();
  const mainIssue = String(payload?.mainIssue || "").trim();
  const narrativeTension = String(payload?.narrativeTension || "").trim();
  const debatePotential = String(payload?.debatePotential || "").trim();
  const editorialWarning = String(payload?.editorialWarning || "").trim();
  const editorialDecision = String(payload?.editorialDecision || "").trim();
  const questionQuality = payload?.questionQuality ?? "";
  const possibleBiases = Array.isArray(payload?.possibleBiases)
    ? payload.possibleBiases.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4)
    : [];

  if (!summary) {
    throw new Error("Résumé manquant pour générer l'article final.");
  }

  if (!openai) {
    return {
      article: cutTextAtSentenceEnd(summary, 1600),
      debateQuestion,
      positionA,
      positionB
    };
  }

  const inputJson = JSON.stringify({
    subject,
    resumeFactuel: summary,
    analyseMediatique: {
      hasMediaContrast,
      mediaTreatment: hasMediaContrast ? mediaTreatment : "",
      mainIssue,
      narrativeTension,
      possibleBiases,
      debatePotential,
      editorialWarning
    },
    elementsDebat: {
      debateAngle,
      debateQuestion,
      positionA,
      positionB,
      editorialDecision,
      questionQuality
    }
  }, null, 2);

  const prompt = `Tu es éditeur pour Agôn.

${buildCurrentDateContext()}

Tu reçois :
1. un résumé factuel neutre ;
2. un angle de débat ;
3. une tension narrative ;
4. une question Agôn ;
5. deux positions opposées.

Ta mission : rédiger l'article final visible dans Agôn.

Agôn ne publie pas une revue de presse classique.
Agôn part de l'actualité pour faire ressortir les enjeux, les choix collectifs et les désaccords possibles.

Le texte doit rester naturel.
N'affiche jamais de rubriques comme : "Pourquoi ça fait parler", "Tension d'opinion", "Biais", "Le nœud du débat", "Enjeu caché".

UTILISATION DES DONNÉES :
* Le premier paragraphe restitue les faits à partir de resumeFactuel.
* Le deuxième paragraphe cadre l'enjeu à partir de debateAngle et narrativeTension.
* La question finale reprend debateQuestion. Une très légère amélioration est possible seulement si elle clarifie la formulation sans changer le sens ni désaligner positionA et positionB.
* positionA et positionB servent seulement à comprendre le débat : elles ne doivent pas apparaître dans l'article.

RÈGLE DE SÉCURITÉ FACTUELLE :
Tu dois rédiger sans jamais enrichir les faits.

N'ajoute jamais par mémoire, déduction ou vraisemblance :
* une fonction politique ou institutionnelle ;
* un chiffre ;
* un statut judiciaire ;
* une réaction politique, syndicale ou associative ;
* une causalité ;
* une décision officielle ;
* une responsabilité.

Si une information n'est pas explicitement présente dans le résumé factuel ou les données reçues, tu l'enlèves ou tu formules prudemment.

Exemples :
* Écrire "Sébastien Lecornu a proposé…", pas "Sébastien Lecornu, ministre de…", sauf si le titre est donné.
* Écrire "65 personnes présentées à la justice", pas "65 condamnés" ni "65 auteurs".
* Écrire "une piste évoquée", pas "une mesure décidée".

Principe central : tu peux améliorer le style, la clarté et l'enjeu, mais tu ne dois jamais compléter les faits.

STRUCTURE OBLIGATOIRE :
1. Une première phrase claire et mémorable.
2. Ligne vide.
3. Premier paragraphe : ce qui s'est passé.
4. Ligne vide.
5. Deuxième paragraphe : l'enjeu et la tension entre les options.
6. Ligne vide.
7. La question Agôn seule sur une ligne.
8. Ligne vide.
9. La signature seule sur la toute dernière ligne.

SIGNATURE :
Choisir une seule signature parmi :
J.L Grasso / F. Glorennec / T. Guyomarch / M. Guillot / P. Ratsky

RÈGLES ABSOLUES :
* Ne rien inventer.
* Ne pas ajouter de fait absent du résumé factuel.
* L'article ne doit contenir qu'une seule question : la question Agôn finale.
* Aucune autre phrase interrogative ne doit apparaître.
* La question Agôn doit apparaître une seule fois, seule sur sa ligne, juste avant la signature.
* Ne pas écrire de titre dans le champ article.
* Ne pas transformer l'article en revue de presse.
* Ne pas afficher les positions dans l'article.
* La phrase avant la question doit être affirmative.

PONT FACTUEL ENTRE LE CORPS ET LA QUESTION :
* Si debateQuestion fait référence à une mesure, un chiffre, un dispositif, une proposition ou un acteur précis, le corps de l'article doit l'avoir nommé et expliqué avant la question.
* La question finale ne doit jamais introduire une information, un chiffre, une mesure ou un acteur absent du corps de l'article.
* Le lecteur doit comprendre, en lisant uniquement les deux paragraphes, pourquoi cette question se pose précisément ainsi.

DEUXIÈME PARAGRAPHE — MÉTHODE :
1. Présenter les deux options face à face, sans les nommer mécaniquement.
2. Retour à la ligne obligatoire après l'énoncé des options.
3. Montrer ce qui rend le choix difficile : enjeu commun, risque identifiable, prix à payer.
4. Finir sur une phrase courte et précise qui resserre la tension.

INTERDIT :
* "Le choix est…"
* "Le dilemme est…"
* "Cette tension oppose…"
* "Deux logiques s'opposent…"
* "Option A… À l'inverse, Option B…"

FORMULATIONS INTERDITES :
* "dans un contexte de tensions"
* "chaque mouvement est scruté"
* "la situation reste volatile"
* "les détails restent flous"
* "cette action s'inscrit dans"
* "la tension monte"
* "Cette situation révèle…"
* "Ce sujet met en lumière…"
* "Le choix collectif porte sur…"
* "Il s'agit d'équilibrer deux impératifs…"

DERNIÈRE PHRASE AVANT LA QUESTION :
Elle doit apporter une idée précise liée au sujet :
choix politique concret, risque identifiable, rapport de force, coût social, économique ou institutionnel.
Elle ne doit jamais être une formule générique.

LONGUEUR :
1000 à 1600 caractères.

SORTIE :
Réponds uniquement en JSON valide :
{
  "article": "",
  "debateQuestion": "",
  "positionA": "",
  "positionB": ""
}

Données à traiter :
${inputJson}

Réponds uniquement en JSON valide, sans balises markdown.`;

  const response = await openai.responses.create({
    model: "gpt-4o",
    input: prompt,
    temperature: 0.35,
    max_output_tokens: 2000
  });

  const rawText = String(response.output_text || "").trim();
  if (!rawText) throw new Error("Réponse vide de l'IA pour l'article final.");

  let parsed = {};
  try {
    parsed = safeJsonParse(rawText);
  } catch (error) {
    const looseArticle = rawText.match(/"article"\s*:\s*"([\s\S]*?)"\s*,\s*"debateQuestion"\s*:/)?.[1];
    parsed = {
      article: looseArticle ? decodeLooseJsonString(looseArticle) : rawText,
      debateQuestion,
      positionA,
      positionB
    };
  }

  const baseResult = {
    // Pas de coupe ici : l'article passe ensuite par enforceFinalArticleQuestion
    // (finition + endpoint), seul point qui applique la limite proprement.
    article: String(parsed.article || summary).trim(),
    debateQuestion: limitDebateQuestion(parsed.debateQuestion || debateQuestion),
    positionA: String(parsed.positionA || positionA).replace(/\s+/g, " ").trim(),
    positionB: String(parsed.positionB || positionB).replace(/\s+/g, " ").trim()
  };

  return polishAgonFinalArticle(payload, baseResult);
}

async function polishAgonFinalArticle(payload, previousJson) {
  const subject = String(payload?.subject || "").trim();
  const summary = String(payload?.summary || "").trim();
  const narrativeTension = String(payload?.narrativeTension || "").trim();
  const base = {
    article: String(previousJson?.article || "").trim(),
    debateQuestion: String(previousJson?.debateQuestion || "").trim(),
    positionA: String(previousJson?.positionA || "").replace(/\s+/g, " ").trim(),
    positionB: String(previousJson?.positionB || "").replace(/\s+/g, " ").trim()
  };

  if (!openai || !base.article) {
    return { ...base, latinQuestion: "" };
  }

  try {
    const promptFinalisation = `Tu dois vérifier, corriger et finaliser un JSON d'article Agôn.

${buildCurrentDateContext()}

Objectif :
Ajouter une question latine courte et verrouiller la structure finale.
Corrige uniquement les problèmes de structure, de longueur, de question latine, de question Agôn, de positions ou de signature.
Ne réécris pas tout si ce n'est pas nécessaire.
Conserve le fond, le ton et les faits du texte fourni.

RÈGLE DE SÉCURITÉ FACTUELLE :
Ne complète jamais les faits.
Si tu dois allonger l'article, développe uniquement l'enjeu, la tension ou les conséquences possibles déjà présentes, sans ajouter de fait nouveau.

Interdit d'ajouter :
- une fonction politique ou institutionnelle ;
- un chiffre ;
- un statut judiciaire ;
- une réaction politique, syndicale ou associative ;
- une causalité ;
- une décision officielle ;
- une responsabilité.

Si une information n'est pas explicitement présente dans l'article reçu, debateQuestion, positionA, positionB ou les données reçues, tu l'enlèves ou tu formules prudemment.

Principe central :
tu peux améliorer la fluidité, la structure, la devise latine et la clarté, mais tu ne dois jamais compléter les faits.

Contraintes strictes :
- article : minimum 800 caractères, signature comprise. Si le texte fourni est trop court, développe le deuxième paragraphe pour atteindre cette taille.
- article : objectif 1000 à 1400 caractères.
- article : jamais plus de 1600 caractères, signature comprise.
- latinQuestion : obligatoire, jamais vide.
- debateQuestion : maximum 80 caractères, espaces, apostrophes, accents, tirets et point d'interrogation final compris.
- positionA : maximum 55 caractères, espaces compris.
- positionB : maximum 55 caractères, espaces compris.

Structure obligatoire du champ article :
1. Une première phrase claire et mémorable.
2. Ligne vide obligatoire juste après cette première phrase.
3. Premier paragraphe court : ce qui s'est passé.
4. Ligne vide obligatoire entre le premier paragraphe et le deuxième paragraphe.
5. Deuxième paragraphe court : l'enjeu, le contraste ou le choix collectif révélé.
6. Ligne vide.
7. Question latine très courte, sans point d'interrogation.
8. Ligne vide.
9. Question Agôn définitive seule sur une ligne.
10. Ligne vide.
11. Signature seule sur la toute dernière ligne.

Vérification prioritaire des sauts de ligne :
- Il doit obligatoirement y avoir une ligne vide juste après la première phrase.
- Il doit obligatoirement y avoir une ligne vide entre le premier paragraphe et le deuxième paragraphe.
- Il doit obligatoirement y avoir une ligne vide entre la question latine et la question Agôn.
- Il doit obligatoirement y avoir une ligne vide entre la question Agôn et la signature.
- Si un de ces sauts de ligne est absent, corrige article.
- La première phrase ne doit pas être un titre séparé, mais une accroche intégrée.

Devise latine — règle prioritaire absolue :
- Tu dois obligatoirement produire le champ latinQuestion.
- latinQuestion est un élément central de l'article Agôn : il ne doit jamais être vide, absent ou oublié.
- latinQuestion est une devise latine courte, directement liée au sujet précis de l'article.
- latinQuestion est une devise latine, pas une question grammaticale. Elle ne doit jamais contenir de point d'interrogation.
- Elle doit être placée juste avant la question Agôn définitive.
- Le champ latinQuestion ne doit jamais être vide quand la réponse JSON est valide.
- Ne jamais utiliser "Agôn", "Agon" ou le nom de la plateforme.
- Ne pas utiliser de mot grec, de marque, de nom propre ou de nom de pays.

FORMAT STRICT — latinQuestion :
- 2 à 5 mots MAXIMUM. Jamais plus.
- Aucune virgule, aucun point, aucune ponctuation.
- Aucune conjonction latine (sed, etiam, autem, enim, vel, aut, quod, quia).
- Pas une phrase avec sujet + verbe conjugué + complément.
- Une devise, un fragment, une maxime — pas une sentence complète.
- Exemples valides : "Labor ultra vires" / "Captus sine defensore" / "Res ipsa loquitur"
- Exemples INTERDITS : "Promovere controversias potest disputationem, sed etiam societatem dividere" / "Salus publica suprema lex esse debet"

Méthode obligatoire pour créer la devise :
1. Identifie l'enjeu central, la tension ou la valeur en jeu dans CE sujet précis.
2. Formule une devise latine courte (2 à 5 mots maximum) qui capture cet enjeu.
3. La devise doit fonctionner comme une maxime ou une sentence : sobre, forte, mémorable.
4. Quelqu'un qui lit la devise doit pouvoir deviner de quoi parle l'article.

Méthode de raisonnement — applique-la à chaque sujet :
1. Quel est l'enjeu CONCRET de CE débat ? (pas "la guerre en général", mais "faut-il frapper les dépôts de missiles iraniens")
2. Quelle tension précise cela crée-t-il ? (pas "sécurité vs liberté", mais "frapper maintenant vs risquer l'escalade")
3. Traduis cette tension précise en latin court.

Exemples de raisonnement (ne pas recopier — illustrent la méthode, pas le résultat) :
- Débat sur l'âge de départ à la retraite à 64 ans → tension précise : travailler plus longtemps vs épuisement → "Labor ultra vires"
- Débat sur la garde à vue sans avocat → tension précise : efficacité policière vs droits fondamentaux → "Captus sine defensore"
- Débat sur les frais de scolarité des étudiants étrangers → tension précise : financement public vs accès universel → "Scientia an pretium"
- Débat sur l'interdiction des téléphones à l'école → tension précise : concentration vs liberté numérique → "Schola sine machina"
- Débat sur le vote des étrangers aux municipales → tension précise : appartenance vs nationalité → "Civis an peregrinus"

Interdits absolus :
- Ne jamais utiliser "Securitas", "Libertas", "Bellum", "Pax" sauf si parfaitement justifiés par CE sujet précis.
- Ne jamais produire une devise qui fonctionnerait pour un autre sujet.
- Ne jamais recopier un exemple ci-dessus.

Question Agôn :
- Elle doit être claire, concrète et débattable.
- Maximum 80 caractères strictement.
- Si elle dépasse 80 caractères, la raccourcir avant de répondre.
- Elle doit toujours se terminer par un point d'interrogation.
- Elle doit apparaître seule, après la question latine.
- Elle ne doit apparaître qu'une seule fois dans l'article.
- Elle doit être compréhensible sans lire tout l'article.
- Elle doit permettre deux positions défendables.
- La question finale ne doit pas contenir une justification qui avantage un camp.
- Éviter les formulations du type :
  "Faut-il faire X pour protéger / contenir / défendre / empêcher… ?"
- Préférer :
  "Faut-il choisir X ou Y ?"
  "La France doit-elle soutenir X ?"
  "Faut-il autoriser X malgré Y ?"
- Éviter les questions molles comme :
  "Faut-il s'inquiéter ?"
  "Est-ce une bonne chose ?"
  "Qui a raison ?"
- Éviter les questions évidentes comme :
  "Faut-il protéger les enfants ?"
  "Faut-il éviter les accidents ?"
  "Faut-il empêcher les drames ?"

Positions :
- positionA et positionB doivent être très générales.
- Ce sont des étiquettes de camp, pas des arguments.
- Maximum 55 caractères chacune.
- Elles doivent répondre directement à debateQuestion.
- Elles doivent être symétriques, courtes et défendables.
- Ne jamais utiliser "car", "parce que", "afin de", "pour que".
- Éviter aussi "pour" si cela transforme la position en argument.
- Si une position dépasse 55 caractères ou ressemble à un argument, corrige-la.

Signature :
- article doit toujours se terminer par une signature.
- La signature doit être seule sur la toute dernière ligne.
- Choisir un seul nom parmi cette liste :
  J.L Grasso / F. Glorennec / T. Guyomarch / M. Guillot / P. Ratsky
- Ne jamais inventer d'autre nom.
- Ne jamais expliquer le choix du nom.
- Ne pas mettre de tiret avant la signature.

Style à préserver :
- Ton éditorial sobre, tendu et vivant.
- Texte clair, sérieux, accessible et journalistique.
- Captivant sans être sensationnaliste.
- Ne pas transformer l'article en tribune personnelle.
- Ne pas ajouter de fait absent du résumé factuel.
- Ne pas dramatiser artificiellement.
- Ne pas ajouter de rubrique ou de titre séparé.
- La question latine apporte la touche symbolique : il ne faut donc pas rendre tout l'article antique, pompeux ou théâtral.

Formulations interdites sauf nécessité factuelle forte :
- "dans un contexte de tensions"
- "chaque mouvement est scruté"
- "la situation reste volatile"
- "les détails restent flous"
- "cette action s'inscrit dans"
- "la tension monte"
- "la stabilité fragile de la zone"
- "les relations restent fragiles"
- "la communauté internationale observe"

Règles absolues :
- Ne rien inventer.
- Ne pas ajouter de fait absent du résumé factuel.
- Ne pas dramatiser artificiellement.
- Ne pas transformer l'article en tribune personnelle.
- Ne pas afficher les positions dans l'article.
- Ne pas écrire de titre séparé dans le champ article.
- Ne pas ajouter de rubrique du type "Pourquoi ça fait parler", "Tension d'opinion", "Biais" ou "Enjeu".
- La question latine, la question Agôn et la signature doivent respecter exactement la structure demandée.
- L'article ne doit contenir qu'une seule et unique question : la question Agôn finale. Aucune autre phrase interrogative ne doit apparaître dans l'article, ni dans l'accroche, ni dans le premier paragraphe, ni dans le deuxième paragraphe.
- La phrase avant la question latine doit être affirmative.

Vérification obligatoire avant de répondre :
1. Le JSON contient bien le champ latinQuestion.
2. latinQuestion n'est pas vide.
3. article contient une ligne latine exactement identique à latinQuestion.
4. Cette ligne latinQuestion est placée juste avant debateQuestion.
5. La ligne française dans article est exactement identique au champ debateQuestion.
6. Il y a une ligne vide juste après la première phrase de article.
7. Il y a une ligne vide entre le premier paragraphe et le deuxième paragraphe.
8. Le deuxième paragraphe contient un retour à la ligne entre l'énoncé des options et l'explication de l'enjeu commun.
9. Il y a une ligne vide entre latinQuestion et debateQuestion.
10. Il y a une ligne vide entre debateQuestion et la signature.
11. debateQuestion fait 80 caractères maximum.
12. positionA et positionB font 55 caractères maximum.
13. article se termine par une signature autorisée, seule sur la dernière ligne.
14. Tout chiffre, mesure, dispositif, proposition ou acteur cité dans debateQuestion apparaît et est expliqué dans le corps de l'article avant la question.
15. debateQuestion ne contient aucune information, chiffre, mesure ou acteur absent du corps de l'article — la question ne doit jamais sembler tomber du ciel.
16. Si la condition 14 ou 15 échoue : reformule debateQuestion pour qu'elle découle directement de ce qui est expliqué dans le corps, OU ajoute une phrase de transition factuelle dans le deuxième paragraphe expliquant la mesure ou le chiffre concerné (sans inventer de fait nouveau), OU si rien de tout cela n'est possible, ramène la question au niveau de généralité que couvre réellement le corps de l'article.
17. Si une condition échoue, corrige le JSON avant de répondre.

JSON attendu uniquement :
{
  "article": "...",
  "latinQuestion": "...",
  "debateQuestion": "...",
  "positionA": "...",
  "positionB": "..."
}

Sujet :
${subject}

Résumé factuel :
${summary}

JSON à vérifier et finaliser :
${JSON.stringify(base, null, 2)}

Réponds uniquement en JSON valide, sans balises markdown.`;

    const finalisationResponse = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: promptFinalisation,
      temperature: 0.45,
      max_output_tokens: 2200
    });
    const parsed = safeJsonParse(String(finalisationResponse.output_text || "").trim());
    const finalQuestion = limitDebateQuestion(parsed.debateQuestion || base.debateQuestion);
    const finalLatinQuestion = normalizeLatinQuestion(parsed.latinQuestion || "")
      || extractLatinQuestionFromArticle(parsed.article || "")
      || buildFallbackLatinQuestion({
        subject,
        summary,
        debateQuestion: finalQuestion,
        narrativeTension
      });
    const finalSignature = getNextAgonArticleSignature();
    let finalArticle = enforceFinalArticleQuestion(parsed.article || base.article, finalQuestion, finalLatinQuestion, finalSignature, {
      positionA: parsed.positionA || base.positionA,
      positionB: parsed.positionB || base.positionB
    });

    return {
      article: finalArticle,
      latinQuestion: finalLatinQuestion,
      debateQuestion: finalQuestion,
      positionA: String(parsed.positionA || base.positionA || "Pour").replace(/\s+/g, " ").trim(),
      positionB: String(parsed.positionB || base.positionB || "Contre").replace(/\s+/g, " ").trim()
    };
  } catch (error) {
    console.error("Erreur finition article Agôn :", error.message);
    return { ...base, latinQuestion: "" };
  }
}

async function generateFreeArenaArticle(payload) {
  const subject = String(payload?.subject || "").trim();
  const summary = String(payload?.summary || "").trim();

  if (!summary) {
    throw new Error("Résumé manquant pour générer l'article factuel.");
  }

  if (!openai) {
    return {
      article: cutTextAtSentenceEnd(summary, 1600),
      debateQuestion: cutTextAtSentenceEnd(subject, 100)
    };
  }

  const prompt = `Tu es éditeur pour Agôn.

${buildCurrentDateContext()}

Tu reçois un résumé factuel neutre d'un événement. Cette arène est une "arène libre" : un espace de discussion ouverte, sans question de débat imposée et sans opposition entre deux camps.

Ta mission : rédiger un titre factuel et un article factuel et sobre, qui exposent les faits avec clarté sans orienter le lecteur vers une prise de position.

LANGUE : le titre et l'article doivent être rédigés entièrement en français, même si le résumé factuel ou les sources contiennent des passages en anglais ou dans une autre langue. Traduis tout élément non francophone avant de l'utiliser.

RÈGLE DE SÉCURITÉ FACTUELLE :
Tu dois rédiger sans jamais enrichir les faits.
N'ajoute jamais par mémoire, déduction ou vraisemblance :
* une fonction politique ou institutionnelle ;
* un chiffre ;
* un statut judiciaire ;
* une réaction politique, syndicale ou associative ;
* une causalité ;
* une décision officielle ;
* une responsabilité.
Si une information n'est pas explicitement présente dans le résumé factuel, tu l'enlèves ou tu formules prudemment.
Principe central : tu peux améliorer le style et la clarté, mais tu ne dois jamais compléter les faits.

TITRE FACTUEL (champ "title") :
* Une phrase courte, sobre et factuelle qui résume le sujet.
* Jamais une question.
* Jamais une formulation binaire ou orientée débat.
* Maximum 90 caractères.
Exemples valables :
- "Violences après la finale du PSG : les réparations publiques au cœur des tensions"
- "Une affaire relance les inquiétudes autour de la sécurité des mineurs"
- "L'intelligence artificielle s'installe progressivement dans les pratiques scolaires"
- "Le logement reste un facteur majeur de tension sociale"
Formulations interdites :
- "Faut-il durcir les sanctions contre les violences urbaines ?"
- "Sécurité ou justice sociale ?"
- "L'État doit-il sanctionner davantage ?"
- toute formulation binaire ou orientée débat.

ARTICLE FACTUEL (champ "article") — structure obligatoire :
1. Une accroche factuelle courte et concrète.
2. Ligne vide.
3. Un paragraphe qui résume clairement les faits.
4. Ligne vide.
5. Un paragraphe de mise en contexte présentant les enjeux ou conséquences générales, sans les présenter comme un choix entre deux camps.
6. Ligne vide.
7. Une conclusion sobre qui ouvre la réflexion sans poser de question ni orienter vers une position.
8. Ligne vide.
9. Une signature seule sur la dernière ligne, choisie parmi : J.L Grasso / F. Glorennec / T. Guyomarch / M. Guillot / P. Ratsky.

INTERDICTIONS STRICTES POUR L'ARTICLE :
* Aucune phrase interrogative, nulle part dans le texte.
* Pas de formulations du type : "La question est donc de savoir si…", "Faut-il…", "Deux visions s'opposent…", "D'un côté… de l'autre…".
* Pas d'opposition artificielle entre deux camps ou deux positions.
* Pas de devise ni de formule latine.
* Pas de conclusion en forme de débat.
* Le texte doit ouvrir une discussion libre, pas enfermer le lecteur dans deux positions.

LONGUEUR :
Article : 900 à 1300 caractères, signature comprise. Une devise latine sera insérée ensuite avant la signature : ne dépasse jamais 1300 caractères.

SORTIE :
Réponds uniquement en JSON valide :
{
  "title": "",
  "article": ""
}

Sujet :
${subject}

Résumé factuel :
${summary}

Réponds uniquement en JSON valide, sans balises markdown.`;

  const response = await openai.responses.create({
    model: "gpt-4o",
    input: prompt,
    temperature: 0.35,
    max_output_tokens: 2000
  });

  const rawText = String(response.output_text || "").trim();
  if (!rawText) throw new Error("Réponse vide de l'IA pour l'article factuel.");

  let parsed = {};
  try {
    parsed = safeJsonParse(rawText);
  } catch (error) {
    parsed = { title: subject, article: rawText };
  }

  const articleLines = String(parsed.article || summary)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const articleSignature = articleLines.length && AGON_ARTICLE_SIGNATURES.has(articleLines[articleLines.length - 1])
    ? articleLines.pop()
    : getNextAgonArticleSignature();

  return {
    article: assembleArticleWithinLimit(articleLines.join("\n\n"), [articleSignature]),
    debateQuestion: limitStoryText(parsed.title || subject, 100)
  };
}

function insertLatinMottoBeforeSignature(article, latinMotto, forcedSignature = "") {
  const motto = normalizeLatinQuestion(latinMotto);
  const rawLines = String(article || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!rawLines.length) return String(article || "").trim();

  const normalizedMotto = normalizeArticleLineForCompare(motto);
  const signature = AGON_ARTICLE_SIGNATURES.has(forcedSignature)
    ? forcedSignature
    : AGON_ARTICLE_SIGNATURES.has(rawLines[rawLines.length - 1])
    ? rawLines.pop()
    : getNextAgonArticleSignature();

  const bodyBlocks = rawLines.filter((line) => {
    const normalizedLine = normalizeArticleLineForCompare(line);
    if (!normalizedLine) return false;
    if (AGON_ARTICLE_SIGNATURES.has(line)) return false;
    if (normalizedMotto && normalizedLine === normalizedMotto) return false;
    if (looksLikeLatinPhrase(line)) return false;
    return true;
  });

  const body = splitArticleOpeningSentence(bodyBlocks).join("\n\n").trim();

  return assembleArticleWithinLimit(body, [motto, signature]);
}

async function generateFreeArenaLatinMotto(payload) {
  const subject = String(payload?.subject || "").trim();
  const summary = String(payload?.summary || "").trim();
  const article = String(payload?.article || "").trim();
  const sources = Array.isArray(payload?.sources) ? payload.sources.filter(Boolean) : [];
  const agonTheme = String(payload?.agonTheme || "").trim();
  const fallbackMotto = "Res ipsa loquitur";

  if (!article) {
    throw new Error("Article manquant pour générer la devise latine.");
  }

  if (!openai) {
    return { latinMotto: fallbackMotto, article: insertLatinMottoBeforeSignature(article, fallbackMotto) };
  }

  const prompt = `Tu es éditeur pour Agôn.

Tu dois produire une devise latine courte de synthèse pour un article d'arène libre.

Cette arène libre n'oppose pas deux camps : il n'y a ni question de débat, ni position A, ni position B.
La devise ne doit donc jamais prendre la forme d'une opposition (par exemple "X an Y"), et ne doit jamais reprendre mécaniquement deux positions puisqu'elles n'existent pas ici.

Sujet :
${subject}

Thématique Agôn :
${agonTheme || "non précisée"}

Sources :
${sources.length ? sources.join(", ") : "non précisées"}

Article factuel :
${article || summary}

Ta mission :
Résume l'idée centrale de cet article en une devise latine courte qui :
- résume l'idée principale du sujet ;
- est courte, sobre, avec un ton sérieux, presque sentencieux ;
- est compréhensible et mémorisable ;
- tient en 2 à 5 mots maximum ;
- ne crée aucune opposition artificielle ;
- n'est jamais une question (aucun point d'interrogation) ;
- n'utilise jamais le format "X an Y" ;
- évite les phrases longues, le latin trop complexe, douteux ou les conjonctions (sed, etiam, autem, enim, vel, aut, quod, quia) ;
- ne mentionne jamais "Agôn", "Agon" ni le nom de la plateforme.

Exemples d'esprit attendu (ne jamais recopier, ils illustrent seulement le style) :
"Ordo post tumultum" / "Veritas sub iudicio" / "Civitas in discrimine" / "Memoria et iustitia" / "Ratio inter metum"

Réponds uniquement en JSON valide avec cette structure :
{
  "latinMotto": "..."
}

Réponds uniquement en JSON valide, sans balises markdown.`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.4,
      max_output_tokens: 120
    });

    const parsed = safeJsonParse(String(response.output_text || "").trim());
    const latinMotto = normalizeLatinQuestion(parsed.latinMotto || "") || fallbackMotto;
    return { latinMotto, article: insertLatinMottoBeforeSignature(article, latinMotto) };
  } catch (error) {
    console.error("Erreur IA devise latine (arène libre) :", error.message);
    return { latinMotto: fallbackMotto, article: insertLatinMottoBeforeSignature(article, fallbackMotto) };
  }
}




function buildFallbackStorySuggestion(payload, stories = []) {
  const text = [
    payload.subject,
    payload.ai?.debateQuestion,
    payload.ai?.resume,
    ...(payload.sources || []),
    ...((payload.contents || []).map((item) => item.title))
  ].filter(Boolean).join(" ");
  const keywords = [...new Set(getStoryKeywords(text))].slice(0, 8);
  const newStory = {
    story_title: "",
    story_summary: "",
    main_actors: keywords.slice(0, 3),
    central_tension: limitStoryText(payload.ai?.debateQuestion || payload.subject || "Tension politique à suivre.", 140),
    keywords,
    status: "active"
  };

  if (!stories.length) {
    return {
      story_decision: "new_story",
      matched_story_id: null,
      matched_story_title: null,
      confidence: 0.2,
      reason: "Aucune histoire existante n'est disponible pour ce sujet.",
      criteria: {
        main_actors_match: false,
        central_tension_match: false,
        temporal_continuity: false,
        editorial_theme_match: false,
        strong_keywords_match: false
      },
      new_story: newStory
    };
  }

  const referenceText = [payload.subject, payload.ai?.debateQuestion, payload.ai?.resume].filter(Boolean).join(" ");
  const referenceKeywords = new Set(getStoryKeywords(referenceText));
  let bestStory = null;
  let bestScore = 0;

  for (const story of stories) {
    const titleText = String(story.story_title || "").trim();
    const titleKeywords = new Set(getStoryKeywords(titleText));
    const storyKeywords = new Set(getStoryKeywords([
      story.story_title
    ].filter(Boolean).join(" ")));

    const sharedTitleKeywords = [...referenceKeywords].filter((word) => titleKeywords.has(word)).length;
    const sharedStoryKeywords = [...referenceKeywords].filter((word) => storyKeywords.has(word)).length;
    const titleSimilarity = stringSimilarity.compareTwoStrings(normalizeStoryText(referenceText), normalizeStoryText(titleText));

    const score = (sharedTitleKeywords * 0.28) + (sharedStoryKeywords * 0.12) + (titleSimilarity * 0.9);

    if (score > bestScore) {
      bestScore = score;
      bestStory = {
        ...story,
        _sharedTitleKeywords: sharedTitleKeywords,
        _sharedStoryKeywords: sharedStoryKeywords,
        _titleSimilarity: titleSimilarity
      };
    }
  }

  if (bestStory) {
    const strongTitleMatch = bestStory._sharedTitleKeywords >= 2 || bestStory._titleSimilarity >= 0.62;
    const mediumTitleMatch = bestStory._sharedTitleKeywords >= 1 || bestStory._titleSimilarity >= 0.46;

    if (strongTitleMatch) {
      return {
        story_decision: "existing_story",
        matched_story_id: bestStory.story_id,
        matched_story_title: bestStory.story_title,
        matched_story_summary: bestStory.story_summary || "",
        previous_episode_id: bestStory.latest_episode_id || "",
        previous_episode_title: bestStory.latest_episode_title || "",
        previous_episode_summary: bestStory.latest_episode_summary || "",
        previous_episode_url: buildAgonDebateUrl(bestStory.latest_episode_id || ""),
        confidence: Number(Math.min(0.96, 0.72 + bestStory._titleSimilarity * 0.2).toFixed(2)),
        reason: "Le sujet recoupe directement le titre d'une histoire existante, plus precise que les autres options.",
        criteria: {
          main_actors_match: bestStory._sharedTitleKeywords >= 1,
          central_tension_match: true,
          temporal_continuity: bestStory._sharedStoryKeywords >= 1,
          editorial_theme_match: true,
          strong_keywords_match: bestStory._sharedTitleKeywords >= 1
        },
        new_story: newStory
      };
    }

    if (mediumTitleMatch && bestStory._sharedStoryKeywords >= 1) {
      return {
        story_decision: "uncertain",
        matched_story_id: bestStory.story_id,
        matched_story_title: bestStory.story_title,
        matched_story_summary: bestStory.story_summary || "",
        previous_episode_id: bestStory.latest_episode_id || "",
        previous_episode_title: bestStory.latest_episode_title || "",
        previous_episode_summary: bestStory.latest_episode_summary || "",
        previous_episode_url: buildAgonDebateUrl(bestStory.latest_episode_id || ""),
        confidence: Number(Math.min(0.79, 0.58 + bestStory._titleSimilarity * 0.18).toFixed(2)),
        reason: "Le sujet semble correspondre a une histoire existante, mais une verification editoriale reste utile.",
        criteria: {
          main_actors_match: bestStory._sharedTitleKeywords >= 1,
          central_tension_match: true,
          temporal_continuity: bestStory._sharedStoryKeywords >= 1,
          editorial_theme_match: true,
          strong_keywords_match: bestStory._sharedTitleKeywords >= 1
        },
        new_story: newStory
      };
    }
  }

  return {
    story_decision: "new_story",
    matched_story_id: null,
    matched_story_title: null,
    confidence: Number(bestScore.toFixed(2)),
    reason: "Aucune continuite narrative nette n'a ete detectee avec les histoires existantes.",
    criteria: {
      main_actors_match: false,
      central_tension_match: false,
      temporal_continuity: false,
      editorial_theme_match: false,
      strong_keywords_match: false
    },
    new_story: newStory
  };
}

function findSpecificStoryTitleMatch(payload, stories = []) {
  const referenceText = [
    payload.subject,
    payload.ai?.debateQuestion,
    payload.ai?.resume,
    ...(Array.isArray(payload.ai?.keywords) ? payload.ai.keywords : []),
    ...((payload.contents || []).map((item) => item.title))
  ].filter(Boolean).join(" ");
  const normalizedReference = normalizeStoryText(referenceText);
  const referenceKeywords = new Set(getStoryKeywords(referenceText));
  let best = null;

  for (const story of stories) {
    const title = String(story.story_title || "").trim();
    const normalizedTitle = normalizeStoryText(title);
    const titleKeywords = getStoryKeywords(title);
    if (!title || !titleKeywords.length || titleKeywords.length > 4) continue;
    const allTitleWordsMatch = titleKeywords.every((word) => referenceKeywords.has(word));
    if (!allTitleWordsMatch) continue;

    const exactPhraseMatch = normalizedTitle && normalizedReference.includes(normalizedTitle);
    const specificityBonus = 3 / titleKeywords.length;
    const score = (exactPhraseMatch ? 4 : 2) + specificityBonus;

    if (!best || score > best.score) {
      best = { story, score };
    }
  }

  return best?.story || null;
}

async function loadAgonStories() {
  function readLocalAgonStories() {
    try {
      if (!AGON_STORIES_FILE || !fs.existsSync(AGON_STORIES_FILE)) return [];
      const parsed = JSON.parse(fs.readFileSync(AGON_STORIES_FILE, "utf8") || "[]");
      return Array.isArray(parsed)
        ? parsed.filter((story) => String(story?.status || "active").trim().toLowerCase() !== "archived")
        : [];
    } catch (error) {
      console.warn("[stories] Impossible de lire le fichier local Agôn :", error.message);
      return [];
    }
  }

  try {
    const response = await fetch(`${AGON_URL}/api/veille/stories`);
    if (!response.ok) return readLocalAgonStories();
    const data = await response.json();
    const apiStories = Array.isArray(data?.stories) ? data.stories : [];
    return apiStories.length ? apiStories : readLocalAgonStories();
  } catch (error) {
    return readLocalAgonStories();
  }
}

async function suggestStoryLink(payload) {
  const stories = await loadAgonStories();
  const compactStories = stories.slice(0, 200).map((story) => ({
    story_id: story.story_id,
    story_title: story.story_title,
    story_summary: story.story_summary,
    main_actors: Array.isArray(story.main_actors) ? story.main_actors.slice(0, 5) : [],
    central_tension: story.central_tension || "",
    keywords: Array.isArray(story.keywords) ? story.keywords.slice(0, 8) : [],
    latest_episode_id: story.latest_episode_id || "",
    latest_episode_title: story.latest_episode_title || "",
    latest_episode_summary: story.latest_episode_summary || "",
    updated_at: story.updated_at || ""
  }));
  const titleOnlyStories = compactStories.map((story) => ({
    story_id: story.story_id,
    story_title: story.story_title
  }));

  const fallback = buildFallbackStorySuggestion(payload, compactStories);
  const specificTitleMatch = findSpecificStoryTitleMatch(payload, compactStories);
  const storiesHaveSparseMetadata = compactStories.every((story) => {
    return !String(story.story_summary || "").trim()
      && !String(story.central_tension || "").trim()
      && !(Array.isArray(story.main_actors) && story.main_actors.length)
      && !(Array.isArray(story.keywords) && story.keywords.length)
      && !String(story.latest_episode_summary || "").trim();
  });

  if (!openai) {
    return fallback;
  }

  const compactContents = (payload.contents || []).slice(0, 8).map((item) => ({
    source: item.source,
    type: item.type,
    orientation: item.orientation,
    title: item.title
  }));
  const analysisKeywords = Array.isArray(payload.ai?.keywords) ? payload.ai.keywords.slice(0, 8) : [];

  const prompt = `
${buildCurrentDateContext()}

Tu aides a rattacher une actualite a une histoire suivie dans un bot de veille.

Role attendu :
- Les histoires existantes d'Agon sont des arcs editoriaux volontairement larges.
- Tu dois trouver l'histoire associee la plus pertinente en te basant uniquement sur le titre de l'histoire.
- Tu ne dois utiliser aucun resume d'histoire, aucun episode precedent, aucun acteur stocke, aucun mot-cle stocke.
- Le titre de l'histoire est la seule information autorisee cote histoires existantes.

Regles de choix :
- Choisis une histoire existante des qu'un titre de la liste correspond clairement a l'enjeu dominant de l'actualite.
- Le sujet, les mots-cles et les sources doivent primer sur le theme general.
- Ne choisis jamais une histoire trop large si une histoire plus precise existe dans la liste.
- Si deux histoires conviennent, choisis la plus specifique.
- "new_story" est reserve aux cas ou aucune histoire existante ne couvre correctement le sujet.
- "uncertain" est reserve aux cas ou deux histoires sont vraiment concurrentes ou ou le sujet est ambigu.
- Si une histoire courte nomme explicitement le pays, l'acteur ou le lieu dominant de l'actualite, choisis-la avant une histoire regionale ou thematique plus large.
- Exemple : si le sujet est principalement Israel et qu'une histoire "Israel" existe, choisis "Israel" avant une histoire plus large sur le Moyen-Orient.
- Exemple : si le sujet est principalement Gaza, Iran, Liban, Etats-Unis ou Trump et qu'une histoire portant ce nom precis existe, choisis cette histoire precise avant une histoire plus generale.

Actualite a classer :
${JSON.stringify({
  subject: payload.subject || "",
  keywords: analysisKeywords,
  agon_theme: normalizeAgonTheme(payload.ai?.agonTheme),
  sources: payload.sources || [],
  contents: compactContents
}, null, 2)}

Histoires existantes :
${JSON.stringify(titleOnlyStories, null, 2)}

Reponds uniquement en JSON valide sous cette forme :
{
  "story_decision": "existing_story" ou "new_story" ou "uncertain",
  "matched_story_id": "id ou null",
  "matched_story_title": "titre ou null",
  "confidence": 0.0,
  "reason": "justification courte",
  "criteria": {
    "main_actors_match": true,
    "central_tension_match": true,
    "temporal_continuity": true,
    "editorial_theme_match": true,
    "strong_keywords_match": true
  },
  "new_story": {
    "story_title": "titre très court et général",
    "main_actors": ["..."],
    "central_tension": "...",
    "keywords": ["..."],
    "status": "active"
  }
}

Contraintes :
- Quand tu choisis une histoire existante, matched_story_id doit etre exactement un story_id fourni dans la liste.
- Pour une histoire existante, mets confidence entre 0.65 et 0.95 selon la nettete du rattachement.
- Renseigne criteria.editorial_theme_match a true si le titre de l'histoire couvre bien l'actualite.
- Renseigne criteria.strong_keywords_match a true si le titre de l'histoire contient ou implique clairement l'acteur, le lieu, le pays, l'institution ou l'enjeu central.
- story_title doit etre tres court, tres general, et pouvoir accueillir plusieurs episodes.
- privilegie une formule nominale simple, de 2 a 5 mots si possible.
- exemples de bons story_title : "Guerre en Iran", "Fin de vie", "Primaire de la gauche", "Crise au Liban".
- Si aucune histoire ne correspond clairement, cree une nouvelle histoire.
- Si confidence >= 0.65 et correspondance claire avec un titre existant : existing_story.
- Si confidence entre 0.50 et 0.64 : uncertain.
- Si confidence < 0.50 : new_story.
`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 900
    });
    const parsed = JSON.parse(String(response.output_text || "{}").match(/\{[\s\S]*\}/)?.[0] || "{}");
    const matchedStory = compactStories.find((story) => story.story_id === parsed.matched_story_id) || null;
    const fallbackMatchedStory = compactStories.find((story) => story.story_id === fallback.matched_story_id) || null;
    const shouldUseFallbackMatch = (
      fallback.story_decision === "existing_story"
      && (!matchedStory || parsed.story_decision === "new_story")
    );
    let finalMatchedStory = shouldUseFallbackMatch ? fallbackMatchedStory : matchedStory;
    let finalDecision = shouldUseFallbackMatch
      ? fallback.story_decision
      : (["existing_story", "new_story", "uncertain"].includes(parsed.story_decision) ? parsed.story_decision : fallback.story_decision);
    let finalConfidence = shouldUseFallbackMatch
      ? fallback.confidence
      : (Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : fallback.confidence);
    let finalReason = shouldUseFallbackMatch
      ? String(fallback.reason || "").trim()
      : String(parsed.reason || fallback.reason || "").trim();
    const finalCriteria = {
      main_actors_match: Boolean(parsed.criteria?.main_actors_match),
      central_tension_match: Boolean(parsed.criteria?.central_tension_match),
      temporal_continuity: Boolean(parsed.criteria?.temporal_continuity),
      editorial_theme_match: Boolean(parsed.criteria?.editorial_theme_match),
      strong_keywords_match: Boolean(parsed.criteria?.strong_keywords_match)
    };
    const concreteMatchCount = [
      finalCriteria.main_actors_match,
      finalCriteria.central_tension_match,
      finalCriteria.temporal_continuity,
      finalCriteria.strong_keywords_match
    ].filter(Boolean).length;

    if (
      specificTitleMatch
      && (!finalMatchedStory || String(finalMatchedStory.story_id || "") !== String(specificTitleMatch.story_id || ""))
    ) {
      const currentKeywordCount = finalMatchedStory ? getStoryKeywords(finalMatchedStory.story_title || "").length : 99;
      const specificKeywordCount = getStoryKeywords(specificTitleMatch.story_title || "").length;
      if (!finalMatchedStory || specificKeywordCount <= currentKeywordCount) {
        finalMatchedStory = specificTitleMatch;
        finalDecision = "existing_story";
        finalConfidence = Math.max(finalConfidence, 0.82);
        finalReason = `L'histoire "${specificTitleMatch.story_title}" nomme plus précisément l'acteur ou le lieu dominant de cette actualité.`;
        finalCriteria.main_actors_match = true;
        finalCriteria.editorial_theme_match = true;
        finalCriteria.strong_keywords_match = true;
      }
    }

    if (
      storiesHaveSparseMetadata
      && finalMatchedStory
      && (finalDecision === "uncertain" || finalDecision === "new_story")
      && finalConfidence >= 0.60
      && finalCriteria.editorial_theme_match
    ) {
      finalDecision = "existing_story";
      finalConfidence = Math.max(finalConfidence, 0.66);
      finalReason = finalReason || "Le titre de l'histoire existante couvre clairement l'enjeu dominant de cette actualite.";
    }

    const hasEnoughSparseMatch = storiesHaveSparseMetadata
      && finalMatchedStory
      && finalConfidence >= 0.65
      && (finalCriteria.editorial_theme_match || concreteMatchCount >= 1);

    if (finalDecision === "existing_story" && (!finalMatchedStory || (finalConfidence < 0.65 && !finalCriteria.editorial_theme_match))) {
      finalDecision = finalMatchedStory && finalConfidence >= 0.55 ? "uncertain" : "new_story";
      finalConfidence = Math.min(finalConfidence, finalDecision === "uncertain" ? 0.74 : 0.58);
      finalReason = finalDecision === "uncertain"
        ? "Correspondance possible, mais pas assez solide pour rattacher automatiquement cette actualité."
        : "Aucune histoire existante ne correspond assez précisément au sujet.";
      if (finalDecision === "new_story") finalMatchedStory = null;
    }

    return {
      story_decision: finalDecision,
      matched_story_id: finalMatchedStory ? finalMatchedStory.story_id : null,
      matched_story_title: finalMatchedStory ? finalMatchedStory.story_title : null,
      matched_story_summary: finalMatchedStory ? finalMatchedStory.story_summary || "" : "",
      previous_episode_id: finalMatchedStory ? finalMatchedStory.latest_episode_id || "" : "",
      previous_episode_title: finalMatchedStory ? finalMatchedStory.latest_episode_title || "" : "",
      previous_episode_summary: finalMatchedStory ? finalMatchedStory.latest_episode_summary || "" : "",
      previous_episode_url: finalMatchedStory ? buildAgonDebateUrl(finalMatchedStory.latest_episode_id || "") : "",
      confidence: finalConfidence,
      reason: finalReason,
      criteria: finalCriteria,
      new_story: {
        story_title: "",
        story_summary: "",
        main_actors: Array.isArray(parsed.new_story?.main_actors) ? parsed.new_story.main_actors.slice(0, 6) : fallback.new_story.main_actors,
        central_tension: limitStoryText(parsed.new_story?.central_tension || fallback.new_story.central_tension, 180),
        keywords: Array.isArray(parsed.new_story?.keywords) ? parsed.new_story.keywords.slice(0, 8) : fallback.new_story.keywords,
        status: "active"
      }
    };
  } catch (error) {
    return fallback;
  }
}

function getMixteCookie(req) {
  const raw = req.headers.cookie || "";
  const match = raw.match(/(?:^|;\s*)mixte_auth=([^;]+)/);
  return match ? match[1] : "";
}

function requireMixteAuth(req, res, next) {
  if (!MIXTE_PASSWORD) return next();
  if (getMixteCookie(req) === MIXTE_PASSWORD) return next();
  if (req.query.token === MIXTE_PASSWORD) {
    res.setHeader("Set-Cookie", `mixte_auth=${MIXTE_PASSWORD}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
    return next();
  }
  res.status(401).send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Accès restreint — Veille mixte</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f7f7f7; }
    .box { background: white; border: 1px solid #ddd; border-radius: 14px; padding: 36px 40px; text-align: center; max-width: 360px; width: 100%; }
    h2 { margin: 0 0 8px; }
    p { color: #666; font-size: 0.9rem; margin: 0 0 24px; }
    input { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font: inherit; font-size: 0.95rem; box-sizing: border-box; margin-bottom: 12px; }
    button { width: 100%; padding: 11px; background: #111; color: white; border: none; border-radius: 8px; font: inherit; font-weight: 700; cursor: pointer; }
    .err { color: #c0392b; font-size: 0.85rem; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Veille mixte</h2>
    <p>Accès réservé</p>
    <form method="POST" action="/mixte-login">
      <input type="password" name="password" placeholder="Mot de passe" autofocus>
      <input type="hidden" name="redirect" value="${req.originalUrl}">
      <button type="submit">Accéder</button>
      ${req.query.err ? '<p class="err">Mot de passe incorrect.</p>' : ''}
    </form>
  </div>
</body>
</html>`);
}

app.use(express.urlencoded({ extended: false }));

app.post("/mixte-login", (req, res) => {
  const { password, redirect } = req.body;
  if (password === MIXTE_PASSWORD) {
    res.setHeader("Set-Cookie", `mixte_auth=${MIXTE_PASSWORD}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
    return res.redirect(redirect || "/mixte");
  }
  res.redirect("/mixte?err=1");
});

const VEILLE_MIXTE_HTML = path.join(__dirname, "veille-mixte.html");
const VEILLE_YOUTUBE_HTML = path.join(__dirname, "veille-youtube.html");

function sendEmptyMixtePage(res) {
  return res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Veille mixte presse + YouTube</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 980px; margin: 40px auto; padding: 0 16px; background: #f7f7f7; color: #111; line-height: 1.5; }
    .nav { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
    .nav a, .nav-refresh-btn, .refresh-btn { display: inline-flex; align-items: center; justify-content: center; border: 1px solid #ddd; background: white; border-radius: 999px; padding: 9px 14px; color: #111; text-decoration: none; font: inherit; font-size: 0.9rem; font-weight: 700; cursor: pointer; }
    .nav a:hover, .nav-refresh-btn:hover, .refresh-btn:hover { background: #eee; }
    h1 { margin: 0 0 8px; font-size: 1.35rem; }
    .intro { color: #555; margin: 0 0 20px; }
    .status { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; background: white; border: 1px solid #e5e7eb; border-radius: 16px; padding: 16px 18px; margin-bottom: 18px; }
    .refresh-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .min-sources-select { padding: 8px 10px; border: 1px solid #ddd; border-radius: 999px; background: white; font: inherit; font-size: 0.9rem; }
    .refresh-btn { background: #111; color: white; border-color: #111; }
    .refresh-btn:disabled { opacity: 0.6; cursor: wait; }
    #progress-panel { display: none; background: white; border: 1px solid #e5e7eb; border-radius: 16px; padding: 16px 18px; margin-bottom: 18px; }
    .progress-bar-track { height: 7px; background: #eee; border-radius: 999px; overflow: hidden; margin: 10px 0; }
    .progress-bar-fill { height: 100%; width: 0%; background: #111; transition: width 0.25s ease; }
    .empty-state { background: white; border: 1px dashed #d1d5db; border-radius: 16px; padding: 24px 20px; color: #555; }
  </style>
</head>
<body>
  <div class="nav">
    <a href="/mixte">Veille mixte</a>
    <a href="/saved">Sujets enregistrés</a>
    <a href="/sent-to-agon">Articles envoyés vers Agôn</a>
    <a href="/admin">Admin</a>
  </div>

  <h1>Veille mixte presse + YouTube</h1>
  <p class="intro">La page est prête. Aucune collecte n'a encore été générée sur cette instance.</p>

  <div class="status">
    <div>
      Dernière génération du fichier :
      <strong>Aucune pour le moment</strong>
    </div>
    <div class="refresh-row">
      <select class="min-sources-select" id="min-sources-select" title="Sources minimum par sujet">
        <option value="2">2 sources min.</option>
        <option value="3">3 sources min.</option>
        <option value="4" selected>4 sources min.</option>
        <option value="5">5 sources min.</option>
        <option value="6">6 sources min.</option>
      </select>
      <button class="refresh-btn" type="button" onclick="startRefresh()">Mettre à jour</button>
    </div>
  </div>

  <div id="progress-panel">
    <div>Étape <span id="prog-step">...</span> / 6 — <span id="prog-name">Démarrage...</span></div>
    <div class="progress-bar-track"><div class="progress-bar-fill" id="prog-bar"></div></div>
    <div id="prog-detail"></div>
  </div>

  <div class="empty-state">Les sujets apparaîtront ici après une collecte. Tu peux aussi ouvrir les sujets enregistrés ou les articles déjà envoyés depuis la navigation.</div>

  <script>
    async function pollProgress() {
      const panel = document.getElementById('progress-panel');
      const step = document.getElementById('prog-step');
      const name = document.getElementById('prog-name');
      const detail = document.getElementById('prog-detail');
      const bar = document.getElementById('prog-bar');
      const r = await fetch('/progress?t=' + Date.now());
      const p = await r.json();
      if (p.running || p.done) panel.style.display = 'block';
      if (p.stepIndex) step.textContent = p.stepIndex;
      if (p.step) name.textContent = p.step;
      if (detail) detail.textContent = p.detail || '';
      if (bar) bar.style.width = Math.max(0, Math.min(100, Number(p.percent || 0))) + '%';
      return p;
    }

    async function startRefresh() {
      const btn = document.querySelector('.refresh-btn');
      const minSources = Number(document.getElementById('min-sources-select')?.value) || 4;
      btn.disabled = true;
      btn.textContent = 'Collecte en cours...';
      await fetch('/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minSources }) });
      const timer = setInterval(async function() {
        try {
          const p = await pollProgress();
          if (!p.running && p.done) {
            clearInterval(timer);
            window.location.reload();
          }
        } catch(e) {}
      }, 2000);
    }

    (async function watchRunningCollect() {
      const panel = document.getElementById('progress-panel');
      if (panel) panel.style.display = 'block';
      try {
        const p = await pollProgress();
        if (!p.running && !p.done) {
          if (panel) panel.style.display = 'none';
          return;
        }
        const btn = document.querySelector('.refresh-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Collecte en cours...'; }
        const timer = setInterval(async function() {
          try {
            const next = await pollProgress();
            if (!next.running && next.done) {
              clearInterval(timer);
              window.location.reload();
            }
          } catch(e) {}
        }, 2000);
      } catch(e) {
        if (panel) panel.style.display = 'none';
      }
    })();
  </script>
</body>
</html>`);
}

function sendMissingPage(res, title, message) {
  return res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <title>${title}</title>
      <style>
        body { font-family: system-ui; max-width: 500px; margin: 80px auto; padding: 0 16px; text-align: center; color: #111; }
        h1 { font-size: 1.3rem; margin-bottom: 8px; }
        p { color: #555; margin-bottom: 24px; }
        .min-sources-row { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 20px; font-size: 0.9rem; color: #555; }
        .min-sources-row select { padding: 6px 10px; border: 1px solid #ccc; border-radius: 8px; font: inherit; font-size: 0.9rem; }
        #launch-btn {
          background: #111; color: #fff; border: none; border-radius: 999px;
          padding: 12px 28px; font: inherit; font-size: 1rem; font-weight: 700;
          cursor: pointer; margin-bottom: 12px;
        }
        #launch-btn:disabled { opacity: 0.5; cursor: wait; }
        #status { font-size: 0.88rem; color: #555; min-height: 20px; }
      </style>
    </head>
    <body>
      <h1>${title}</h1>
      <p>${message}</p>
      <div class="min-sources-row">
        <label for="min-sources">Sources minimum :</label>
        <select id="min-sources">
          <option value="2">2 sources</option>
          <option value="3">3 sources</option>
          <option value="4" selected>4 sources (défaut)</option>
          <option value="5">5 sources</option>
          <option value="6">6 sources</option>
        </select>
      </div>
      <button id="launch-btn" onclick="launch()">Lancer la première collecte</button>
      <div id="status"></div>
      <script>
        (async function autoHookRunning() {
          try {
            var r = await fetch('/progress?t=' + Date.now());
            var p = await r.json();
            if (!p.running) return;
            var btn = document.getElementById('launch-btn');
            var status = document.getElementById('status');
            if (btn) { btn.disabled = true; btn.textContent = 'Collecte en cours…'; }
            if (status) status.textContent = 'Collecte déjà en cours, veuillez patienter…';
            var poll = setInterval(async function() {
              try {
                var r2 = await fetch('/progress?t=' + Date.now());
                var p2 = await r2.json();
                if (p2.step && status) status.textContent = 'Étape ' + p2.stepIndex + ' / ' + p2.stepTotal + ' — ' + p2.step + (p2.detail ? ' (' + p2.detail + ')' : '');
                if (!p2.running && p2.done) { clearInterval(poll); window.location.reload(); }
              } catch(e) {}
            }, 2000);
          } catch(e) {}
        })();

        async function launch() {
          const btn = document.getElementById('launch-btn');
          const status = document.getElementById('status');
          btn.disabled = true;
          btn.textContent = 'Collecte en cours…';
          status.textContent = 'Récupération des sources et analyse IA…';
          try {
            var minSources = Number(document.getElementById('min-sources')?.value) || 4;
            await fetch('/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minSources }) });
            var seenRunning = false;
            var poll = setInterval(async function() {
              try {
                var r = await fetch('/progress?t=' + Date.now());
                var p = await r.json();
                if (p.running) seenRunning = true;
                if (p.step) status.textContent = 'Étape ' + p.stepIndex + ' / ' + p.stepTotal + ' — ' + p.step + (p.detail ? ' (' + p.detail + ')' : '');
                if (seenRunning && p.done) { clearInterval(poll); window.location.reload(); }
              } catch(e) {}
            }, 2000);
            setTimeout(function() { clearInterval(poll); window.location.reload(); }, 15 * 60 * 1000);
          } catch(e) {
            status.textContent = 'Erreur : ' + e.message;
            btn.disabled = false;
            btn.textContent = 'Réessayer';
          }
        }
      </script>
    </body>
    </html>
  `);
}

app.get("/", (req, res) => {
  res.redirect("/mixte");
});

app.get("/veille-mixte.html", requireMixteAuth, (req, res) => {
  if (!fs.existsSync(VEILLE_MIXTE_HTML)) {
    return sendEmptyMixtePage(res);
  }
  res.sendFile(VEILLE_MIXTE_HTML);
});

app.get("/youtube", (req, res) => {
  if (!fs.existsSync(VEILLE_YOUTUBE_HTML)) {
    return sendMissingPage(res, "Veille YouTube", "La veille YouTube n'a pas encore été générée.");
  }
  res.sendFile(VEILLE_YOUTUBE_HTML);
});

app.get("/mixte", requireMixteAuth, (req, res) => {
  if (!fs.existsSync(VEILLE_MIXTE_HTML)) {
    return sendEmptyMixtePage(res);
  }
  res.sendFile(VEILLE_MIXTE_HTML);
});

app.get("/veille-mixte.json", (req, res) => {
  const filePath = path.join(__dirname, "veille-mixte.json");

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "veille-mixte.json non généré" });
  }

  res.sendFile(filePath);
});

app.post("/refresh", requireMixteAuth, async (req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:3002/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body || {}) });
    const data = await response.json().catch(() => ({ ok: false, error: "Réponse API mixte invalide" }));
    if (!response.ok || data.ok === false) {
      return res.status(response.status || 500).json({ ok: false, error: data.error || "Erreur démarrage collecte" });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/progress", requireMixteAuth, async (req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:3002/progress");
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.json({ running: false, done: false, stepIndex: 0, stepTotal: 6, step: "", detail: "" });
  }
});

app.post("/save", requireMixteAuth, async (req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:3002/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/analyze", requireMixteAuth, async (req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:3002/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || "Erreur analyse IA");
    }
    const data = await response.json();
    const isLibreMode = String(req.body?.arenaMode || "").trim() === "libre";
    const normalizedData = {
      ...data,
      arenaMode: isLibreMode ? "libre" : "positions",
      debateQuestion: "",
      resume: "",
      positionA: "",
      positionB: ""
    };
    res.json(normalizedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/generate-tags", requireMixteAuth, async (req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:3002/generate-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {})
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || "Erreur génération tags");
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur génération tags" });
  }
});

app.post("/suggest-story", requireMixteAuth, async (req, res) => {
  try {
    const suggestion = await suggestStoryLink(req.body || {});
    res.json({ ok: true, suggestion });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur suggestion histoire" });
  }
});

app.post("/generate-full-article", requireMixteAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const article = await generateCompleteNarrativeContext(payload, payload.storySelection || null);
    res.json({ ok: true, article });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur génération résumé" });
  }
});

app.post("/generate-final-article", requireMixteAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await generateMediaAnalysis(payload);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur analyse médiatique" });
  }
});


app.post("/generate-styled-article", requireMixteAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await generateStyledArticle(payload);
    if (result && result.debateQuestion) {
      result.debateQuestion = limitDebateQuestion(result.debateQuestion);
    }
    if (result && result.article) {
      result.latinQuestion = normalizeLatinQuestion(result.latinQuestion || "") || extractLatinQuestionFromArticle(result.article);
      result.article = enforceFinalArticleQuestion(result.article, result.debateQuestion, result.latinQuestion, "", {
        positionA: result.positionA,
        positionB: result.positionB
      });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur génération article définitif" });
  }
});

app.post("/generate-free-article", requireMixteAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await generateFreeArenaArticle(payload);
    res.json({ ok: true, ...result, positionA: "", positionB: "" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur génération article factuel (arène libre)" });
  }
});

app.post("/generate-latin-motto", requireMixteAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await generateFreeArenaLatinMotto(payload);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur génération devise latine (arène libre)" });
  }
});


app.get("/sessions-mixte.json", requireMixteAuth, (req, res) => {
  const filePath = path.join(__dirname, "sessions-mixte.json");

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "sessions-mixte.json non généré" });
  }

  res.sendFile(filePath);
});

app.get("/api/saved-subjects", requireMixteAuth, (req, res) => {
  try {
    const filePath = path.join(__dirname, "saved-subjects.json");
    let items = [];
    if (fs.existsSync(filePath)) {
      items = JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
    }
    res.json({
      ok: true,
      items: Array.isArray(items) ? items : [],
      subjects: Array.isArray(items) ? items.map((item) => String(item?.subject || "").trim()).filter(Boolean) : []
    });
  } catch (err) {
    res.status(500).json({ ok: false, items: [], subjects: [], error: err.message || "Erreur chargement sujets enregistrés" });
  }
});

app.get("/api/sent-to-agon-items", requireMixteAuth, (req, res) => {
  try {
    const items = loadSentToAgonItems();
    res.json({
      ok: true,
      items,
      keys: items.map((item) => String(item?.question || item?.subject || "").trim()).filter(Boolean)
    });
  } catch (err) {
    res.status(500).json({ ok: false, items: [], keys: [], error: err.message || "Erreur chargement historique Agôn" });
  }
});

app.get("/saved", requireMixteAuth, (req, res) => {
  const savedFile = path.join(__dirname, "saved-subjects.json");
  let saved = [];
  if (fs.existsSync(savedFile)) {
    try { saved = JSON.parse(fs.readFileSync(savedFile, "utf8")); } catch {}
  }
  if (Array.isArray(saved)) {
    saved = saved.slice().sort((a, b) => {
      const bTime = new Date(b?.savedAt || 0).getTime() || 0;
      const aTime = new Date(a?.savedAt || 0).getTime() || 0;
      return bTime - aTime;
    });
  } else {
    saved = [];
  }

  function esc(t) {
    return String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function buildAiScoreHtml(s) {
    if (!s.debateScore) return `<div class="ai-score pending"><div><span class="score-label">Potentiel débat</span><strong>—/10</strong></div></div>`;
    return `<div class="ai-score"><div><span class="score-label">Potentiel débat</span><strong>${esc(String(s.debateScore))}/10</strong></div><span class="controversy">${esc(s.controversyLevel || "")}</span></div>`;
  }

  function buildKeywordsHtml(s) {
    const rawKeywords = Array.isArray(s.keywords) ? s.keywords.filter(Boolean) : [];
    const mainKeyword = String(s.mainKeyword || s.ai?.mainKeyword || rawKeywords[0] || "").trim();
    return `<div class="news-keywords"><div class="news-keywords-label">Tag principal</div>${mainKeyword ? `<span class="news-keyword-chip main-keyword-chip">${esc(mainKeyword)}</span>` : ""}</div>`;
  }

  function buildAiBoxHtml(s) {
    const score = Number(s.debateScore) || 0;
    if (!s.debateQuestion) {
      const subjectData = JSON.stringify({ subject: s.subject, sources: (s.sources || "").split(", ").filter(Boolean), contents: [] }).replace(/"/g, "&quot;");
      return `<div class="ai-box pending-analysis">
        <button class="analyze-btn" type="button" data-mode="positions" data-subject="${subjectData}">Générer arène à positions IA</button>
        <button class="analyze-btn analyze-btn-secondary" type="button" data-mode="libre" data-subject="${subjectData}">Générer arène libre IA</button>
      </div>`;
    }
    const optionsHtml = AGON_THEMES.map(theme =>
      `<option value="${esc(theme)}"${theme === normalizeAgonTheme(s.agonTheme) ? " selected" : ""}>${esc(theme)}</option>`
    ).join("");
    const positionsHtml = score >= 7 && (s.positionA || s.positionB)
      ? `<div class="positions-box"><p><strong>Positions proposées pour une arène à positions :</strong></p>${s.positionA ? `<p><strong>A —</strong> <span class="editable" contenteditable="true" spellcheck="false">${esc(s.positionA)}</span></p>` : ""}${s.positionB ? `<p><strong>B —</strong> <span class="editable" contenteditable="true" spellcheck="false">${esc(s.positionB)}</span></p>` : ""}</div>`
      : "";
    return `<div class="ai-box">
      <p class="debate-question" contenteditable="true" spellcheck="false">${esc(s.debateQuestion)}</p>
      ${s.resume ? `<p class="resume" contenteditable="true" spellcheck="false">${esc(s.resume)}</p>` : ""}
      ${buildKeywordsHtml(s)}
      <button type="button" class="tags-generate-btn">Générer tags</button>
      <p class="agon-theme"><strong>Thématique Agôn proposée :</strong><select class="agon-select">${optionsHtml}</select></p>
      ${positionsHtml}
    </div>`;
  }

  function buildSubjectHtml(s, i) {
    const articles = (s.contents || []).filter(c => c.type !== "youtube");
    const videos = (s.contents || []).filter(c => c.type === "youtube");
    let contentsHtml = "";
    if (articles.length) {
      contentsHtml += `<h4 style="margin:14px 0 8px;font-size:0.9rem;color:#555;">Presse</h4><ul style="list-style:none;padding:0;margin:0 0 10px;">`;
      contentsHtml += articles.map(c => `<li style="padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:0.88rem;"><strong>${esc(c.source)}</strong> — <a href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a></li>`).join("");
      contentsHtml += `</ul>`;
    }
    if (videos.length) {
      contentsHtml += `<h4 style="margin:14px 0 8px;font-size:0.9rem;color:#555;">YouTube</h4><ul style="list-style:none;padding:0;margin:0 0 10px;">`;
      contentsHtml += videos.map(c => `<li style="padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:0.88rem;display:flex;align-items:center;gap:10px;">${c.thumbnail ? `<img src="${esc(c.thumbnail)}" style="width:80px;height:45px;object-fit:cover;border-radius:4px;flex-shrink:0;">` : ""}<span><strong>${esc(c.source)}</strong> — <a href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a></span></li>`).join("");
      contentsHtml += `</ul>`;
    }
    const sourceCount = Array.isArray(s.sources)
      ? s.sources.length
      : String(s.sources || "").split(",").map(source => source.trim()).filter(Boolean).length;
    return `
    <section class="subject" data-index="${i}" data-subject-title="${esc(s.subject)}" data-score="${s.debateScore || 0}">
      <button class="arena-select-btn" type="button" aria-pressed="false">Sélectionner</button>
      ${buildAiScoreHtml(s)}
      <h3>${esc(s.subject)}</h3>
      ${buildAiBoxHtml(s)}
      <details class="sources-dropdown">
        <summary>Voir les sources (${sourceCount})</summary>
        <p class="sources">${esc(s.sources)}</p>
        ${contentsHtml}
      </details>
      ${s.storySelection?.matchedStoryTitle ? `<div class="story-badge">📖 Histoire : ${esc(s.storySelection.matchedStoryTitle)}</div>` : ""}
      <small class="date">Enregistré le ${new Date(s.savedAt).toLocaleString("fr-FR")}</small>
      <button class="unsave-btn" type="button" data-subject-title="${esc(s.subject)}">★ Supprimer</button>
    </section>`;
  }

  // Grouper par session
  const sessionMap = new Map();
  saved.forEach((s, i) => {
    const key = s.sessionLabel || "Sans session";
    if (!sessionMap.has(key)) sessionMap.set(key, []);
    sessionMap.get(key).push({ s, i });
  });
  const sessions = [...sessionMap.entries()];

  const sessionTabs = sessions.map(([label], idx) => `
    <button class="session-tab ${idx === 0 ? "active" : ""}" data-idx="${idx}">${idx === 0 ? "Dernière mise à jour" : esc(label)}</button>
  `).join("");

  const sessionBlocks = sessions.map(([label, entries], idx) => `
    <div class="session-block ${idx === 0 ? "active" : "hidden"}" data-idx="${idx}">
      <div class="session-header">
        <div>
          <h2>${idx === 0 ? "Dernière mise à jour" : "Mise à jour précédente"}</h2>
          <p>Session du <strong>${esc(label)}</strong></p>
        </div>
        <div style="font-size:0.9rem;color:#555;"><strong>${entries.length}</strong> sujet(s) enregistré(s)</div>
      </div>
      ${entries.map(({ s, i }) => buildSubjectHtml(s, i)).join("")}
    </div>
  `).join("");

  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Sujets enregistrés</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 980px; margin: 40px auto; padding: 0 16px; line-height: 1.5; background: #f7f7f7; color: #111; }
    h1 { margin-bottom: 4px; }
    .intro { color: #555; margin-bottom: 24px; }
    .nav { margin-bottom: 20px; }
    .nav a { display: inline-block; margin-right: 10px; padding: 8px 12px; background: white; border: 1px solid #ddd; border-radius: 999px; text-decoration: none; color: #111; font-size: 0.9rem; }
    .nav a:hover { background: #eee; }
    .subject { background: white; border: 1px solid #e0e0e0; border-radius: 16px; padding: 20px 24px; margin-bottom: 20px; position: relative; }
    .subject.selected { border-color: #111; box-shadow: 0 0 0 2px rgba(17,17,17,0.08); }
    h3 { margin: 8px 0 12px; font-size: 1.05rem; }
    .ai-score { display: flex; justify-content: space-between; align-items: center; background: #f5f5f5; border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; }
    .ai-score.pending { opacity: 0.5; }
    .score-label { font-size: 0.78rem; color: #777; display: block; }
    .ai-score strong { font-size: 1.1rem; }
    .controversy { font-size: 0.82rem; background: #eee; border-radius: 999px; padding: 3px 10px; }
    .ai-box { background: #f9f9f9; border: 1px solid #e8e8e8; border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; }
    .ai-box.pending-analysis { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 56px; flex-wrap: wrap; }
    .debate-question { font-weight: 600; margin: 0 0 10px; padding: 6px 8px; border-radius: 6px; outline: none; }
    .debate-question:hover, .debate-question:focus { background: #fff; box-shadow: 0 0 0 2px #ddd; }
    .resume { color: #444; font-size: 0.9rem; border-left: 3px solid #ddd; padding-left: 10px; margin: 8px 0; }
    .resume[contenteditable="true"] { border-radius: 8px; padding: 8px 10px; margin-left: -10px; outline: none; transition: background 0.15s; white-space: pre-wrap; }
    .resume[contenteditable="true"]:hover, .resume[contenteditable="true"]:focus { background: #fff; box-shadow: 0 0 0 2px #ddd; }
    .news-keywords { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 4px; }
    .news-keywords-label { width: 100%; font-size: 0.82rem; font-weight: 700; color: #555; }
    .news-keyword-chip { display: inline-flex; align-items: center; min-height: 30px; padding: 0 10px; border-radius: 999px; background: #f3f4f7; border: 1px solid #e2e4ea; color: #2b2e38; font-size: 0.82rem; font-weight: 600; line-height: 1.2; }
    .main-keyword-chip { background: #111; border-color: #111; color: #fff; font-weight: 800; box-shadow: 0 6px 16px rgba(0,0,0,0.12); }
    .main-keyword-chip::before { content: "Tag principal"; margin-right: 8px; font-size: 0.68rem; font-weight: 800; text-transform: uppercase; opacity: 0.72; }
    .agon-theme { font-size: 0.88rem; color: #555; margin: 10px 0 0; }
    .agon-select { margin-left: 6px; border: 1px solid #ddd; border-radius: 6px; padding: 3px 6px; font: inherit; font-size: 0.85rem; }
    .positions-box { background: white; border-radius: 8px; padding: 10px 14px; margin-top: 10px; border: 1px solid #eee; font-size: 0.9rem; }
    .positions-box p { margin: 4px 0; }
    .editable { display: inline; padding: 2px 4px; border-radius: 4px; outline: none; }
    .editable:hover, .editable:focus { background: #f0f0f0; box-shadow: 0 0 0 2px #ddd; }
    .analyze-btn { background: #111; color: white; border: none; border-radius: 999px; padding: 10px 22px; font: inherit; font-size: 0.95rem; font-weight: 700; cursor: pointer; }
    .analyze-btn:hover:not(:disabled) { background: #333; }
    .analyze-btn:disabled { opacity: 0.6; cursor: default; }
    .analyze-btn-secondary { background: white; color: #111; border: 1px solid #ddd; }
    .analyze-btn-secondary:hover:not(:disabled) { background: #f0f0f0; }
    .tags-generate-btn { margin: 8px 0 2px; background: white; color: #111; border: 1px solid #d7d7d7; border-radius: 999px; padding: 7px 13px; font: inherit; font-size: 0.82rem; font-weight: 700; cursor: pointer; }
    .tags-generate-btn:hover:not(:disabled) { background: #f0f0f0; }
    .tags-generate-btn:disabled { opacity: 0.55; cursor: default; }
    .sources { font-size: 0.8rem; color: #999; margin: 10px 0 6px; }
    .sources-dropdown { margin: 10px 0 12px; }
    .sources-dropdown summary { display: inline-flex; align-items: center; gap: 8px; width: fit-content; border: 1px solid #ddd; background: white; border-radius: 999px; padding: 7px 13px; color: #111; font: inherit; font-size: 0.86rem; font-weight: 700; cursor: pointer; user-select: none; }
    .sources-dropdown summary::-webkit-details-marker { display: none; }
    .sources-dropdown summary::after { content: "▾"; font-size: 0.78rem; color: #777; transition: transform 0.16s ease; }
    .sources-dropdown[open] summary::after { transform: rotate(180deg); }
    .sources-dropdown summary:hover { background: #f0f0f0; }
    .date { font-size: 0.78rem; color: #bbb; }
    .unsave-btn { margin-top: 12px; background: none; border: 1px solid #ddd; border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 0.85rem; cursor: pointer; color: #c0392b; }
    .unsave-btn:hover { background: #fdf0ee; border-color: #c0392b; }
    .saved-selection-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #fff; border: 1px solid #ddd; border-radius: 14px; padding: 12px 14px; margin: 0 0 18px; position: sticky; top: 10px; z-index: 5; }
    .saved-selection-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .select-all-arenas-btn, .clear-selection-btn, .arena-select-btn { border: 1px solid #ddd; background: #fff; border-radius: 999px; padding: 8px 14px; font: inherit; font-size: 0.86rem; font-weight: 700; cursor: pointer; color: #111; }
    .select-all-arenas-btn:hover, .clear-selection-btn:hover { opacity: 0.85; }
    .arena-select-btn:hover { background: #f0f0f0; }
    .arena-select-btn { position: absolute; top: 16px; left: 18px; }
    .subject { padding-top: 62px; }
    .subject.selected .arena-select-btn { background: #111; border-color: #111; color: #fff; }
    .selection-count { color: #555; font-size: 0.9rem; font-weight: 700; }
    .empty { color: #888; margin-top: 40px; }
    .session-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 24px; }
    .session-tab { border: 1px solid #ddd; background: white; border-radius: 999px; padding: 8px 16px; font: inherit; font-size: 0.88rem; cursor: pointer; color: #555; }
    .session-tab.active { background: #111; color: white; border-color: #111; font-weight: 700; }
    .session-block.hidden { display: none; }
    .session-header { display: flex; justify-content: space-between; align-items: flex-start; background: #111; color: white; border-radius: 14px; padding: 14px 18px; margin-bottom: 20px; }
    .session-header h2 { margin: 0 0 2px; font-size: 1rem; }
    .session-header p { margin: 0; font-size: 0.85rem; opacity: 0.75; }
  </style>
</head>
<body>
  <div class="nav">
    <a href="/mixte">Veille mixte</a>
    <a href="/mixte#saved">Sujets enregistrés</a>
    <a href="/admin">⚙ Admin</a>
  </div>
  <h1>Sujets enregistrés</h1>
  <p class="intro">${saved.length} sujet(s) enregistré(s) sur ${sessions.length} mise(s) à jour.</p>
  ${saved.length === 0 ? '<p class="empty">Aucun sujet enregistré pour le moment.</p>' : `
  <div class="saved-selection-bar">
    <div class="selection-count"><span id="selected-count">0</span> arène(s) sélectionnée(s)</div>
    <div class="saved-selection-actions">
      <button class="select-all-arenas-btn" type="button">Tout sélectionner</button>
      <button class="clear-selection-btn" type="button">Annuler la sélection</button>
    </div>
  </div>
  <div class="session-tabs">${sessionTabs}</div>
  <div id="subjects-list">${sessionBlocks}</div>
  `}
<script>
  const AGON_THEMES = ${JSON.stringify(AGON_THEMES)};

  document.querySelectorAll('.session-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const idx = tab.dataset.idx;
      document.querySelectorAll('.session-tab').forEach(t => t.classList.toggle('active', t.dataset.idx === idx));
      document.querySelectorAll('.session-block').forEach(b => b.classList.toggle('hidden', b.dataset.idx !== idx));
      updateSelectionCount();
    });
  });

  function getActiveSessionBlock() {
    return document.querySelector('.session-block:not(.hidden)');
  }

  function updateArenaSelectionButton(subject) {
    const btn = subject.querySelector('.arena-select-btn');
    const selected = subject.classList.contains('selected');
    if (!btn) return;
    btn.textContent = selected ? 'Sélectionné' : 'Sélectionner';
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }

  function updateSelectionCount() {
    const activeBlock = getActiveSessionBlock();
    const count = activeBlock ? activeBlock.querySelectorAll('.subject.selected').length : 0;
    const countEl = document.getElementById('selected-count');
    if (countEl) countEl.textContent = String(count);
  }

  document.addEventListener('click', (e) => {
    const selectBtn = e.target.closest('.arena-select-btn');
    if (selectBtn) {
      const subject = selectBtn.closest('.subject');
      if (subject) {
        subject.classList.toggle('selected');
        updateArenaSelectionButton(subject);
        updateSelectionCount();
      }
      return;
    }

    if (e.target.closest('.select-all-arenas-btn')) {
      const activeBlock = getActiveSessionBlock();
      if (activeBlock) {
        activeBlock.querySelectorAll('.subject').forEach(subject => {
          subject.classList.add('selected');
          updateArenaSelectionButton(subject);
        });
        updateSelectionCount();
      }
      const selectAllBtn = document.querySelector('.select-all-arenas-btn');
      const clearBtn = document.querySelector('.clear-selection-btn');
      if (selectAllBtn) { selectAllBtn.style.background = '#111'; selectAllBtn.style.borderColor = '#111'; selectAllBtn.style.color = '#fff'; }
      if (clearBtn) { clearBtn.style.background = ''; clearBtn.style.borderColor = ''; clearBtn.style.color = ''; }
      return;
    }

    if (e.target.closest('.clear-selection-btn')) {
      const activeBlock = getActiveSessionBlock();
      if (activeBlock) {
        activeBlock.querySelectorAll('.subject.selected').forEach(subject => {
          subject.classList.remove('selected');
          updateArenaSelectionButton(subject);
        });
        updateSelectionCount();
      }
      const selectAllBtn = document.querySelector('.select-all-arenas-btn');
      const clearBtn = document.querySelector('.clear-selection-btn');
      if (clearBtn) { clearBtn.style.background = '#111'; clearBtn.style.borderColor = '#111'; clearBtn.style.color = '#fff'; }
      if (selectAllBtn) { selectAllBtn.style.background = ''; selectAllBtn.style.borderColor = ''; selectAllBtn.style.color = ''; }
    }
  });

  function buildAiScoreHtml(ai) {
    return '<div class="ai-score">' +
      '<div><span class="score-label">Potentiel débat</span><strong>' + ai.debateScore + '/10</strong></div>' +
      '<span class="controversy">' + (ai.controversyLevel || "") + '</span>' +
      '</div>';
  }

  function escapeHtmlClient(value) {
    return String(value || '').replace(/[&<>"']/g, function(char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function buildKeywordsHtml(ai) {
    const rawKeywords = Array.isArray(ai && ai.keywords) ? ai.keywords.filter(Boolean) : [];
    const mainKeyword = String((ai && ai.mainKeyword) || rawKeywords[0] || '').trim();
    return '<div class="news-keywords"><div class="news-keywords-label">Tag principal</div>' +
      (mainKeyword ? '<span class="news-keyword-chip main-keyword-chip">' + escapeHtmlClient(mainKeyword) + '</span>' : '') +
      '</div>';
  }

  function renderKeywordsInEditor(subjectEl, mainKeyword) {
    const keywordsWrap = subjectEl && subjectEl.querySelector('.news-keywords');
    if (!keywordsWrap) return;
    const label = keywordsWrap.querySelector('.news-keywords-label');
    keywordsWrap.innerHTML = '';
    if (label) keywordsWrap.appendChild(label);
    const normalizedMainKeyword = String(mainKeyword || '').trim();
    if (normalizedMainKeyword) {
      const chip = document.createElement('span');
      chip.className = 'news-keyword-chip main-keyword-chip';
      chip.dataset.mainKeyword = normalizedMainKeyword;
      chip.textContent = normalizedMainKeyword;
      keywordsWrap.appendChild(chip);
    }
  }

  function getMainKeywordFromEditor(subjectEl) {
    const mainChip = subjectEl && subjectEl.querySelector('.main-keyword-chip');
    return mainChip ? mainChip.textContent.trim().replace(/^Tag principal\s*/i, '') : '';
  }

  function getSubjectTagsPayload(subjectEl) {
    const contents = Array.from((subjectEl && subjectEl.querySelectorAll('a[href]')) || []).map(function(link) {
      const li = link.closest('li');
      const source = li && li.querySelector('strong') ? li.querySelector('strong').textContent.trim() : '';
      return { title: link.textContent.trim(), link: link.href, source: source };
    });
    const sourcesText = subjectEl && subjectEl.querySelector('.sources') ? subjectEl.querySelector('.sources').textContent : '';
    return {
      subject: subjectEl ? subjectEl.dataset.subjectTitle : '',
      sources: sourcesText.split(',').map(function(source) { return source.trim(); }).filter(Boolean),
      contents: contents
    };
  }

  function buildAiBoxHtml(ai) {
    const score = Number(ai.debateScore) || 0;
    const optionsHtml = AGON_THEMES.map(theme =>
      '<option value="' + theme + '"' + (theme === normalizeAgonTheme(ai.agonTheme) ? ' selected' : '') + '>' + theme + '</option>'
    ).join('');
    const positionsHtml = score >= 7 && (ai.positionA || ai.positionB)
      ? '<div class="positions-box"><p><strong>Positions proposées pour une arène à positions :</strong></p>' +
        (ai.positionA ? '<p><strong>A —</strong> <span class="editable" contenteditable="true" spellcheck="false">' + ai.positionA + '</span></p>' : '') +
        (ai.positionB ? '<p><strong>B —</strong> <span class="editable" contenteditable="true" spellcheck="false">' + ai.positionB + '</span></p>' : '') +
        '</div>'
      : '';
    return '<div class="ai-box">' +
      '<p class="debate-question" contenteditable="true" spellcheck="false">' + (ai.debateQuestion || '') + '</p>' +
      (ai.resume ? '<p class="resume" contenteditable="true" spellcheck="false">' + ai.resume + '</p>' : '') +
      buildKeywordsHtml(ai) +
      '<button type="button" class="tags-generate-btn">Générer tags</button>' +
      '<p class="agon-theme"><strong>Thématique Agôn proposée :</strong><select class="agon-select">' + optionsHtml + '</select></p>' +
      positionsHtml +
      '</div>';
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.tags-generate-btn');
    if (!btn) return;
    const subjectEl = btn.closest('.subject');
    if (!subjectEl) return;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Tags en cours…';
    try {
      const payload = getSubjectTagsPayload(subjectEl);
      const response = await fetch('/generate-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error('Erreur génération tags');
      const data = await response.json();
      renderKeywordsInEditor(subjectEl, data.mainKeyword || '');
      await fetch('/save-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: payload.subject, mainKeyword: getMainKeywordFromEditor(subjectEl) })
      });
      btn.textContent = 'Tags générés';
      setTimeout(function() { btn.textContent = originalText; btn.disabled = false; }, 900);
    } catch (err) {
      btn.textContent = 'Réessayer tags';
      btn.disabled = false;
    }
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.analyze-btn');
    if (!btn) return;
    const subjectData = JSON.parse(btn.dataset.subject);
    subjectData.arenaMode = btn.dataset.mode || 'positions';
    const subjectEl = btn.closest('.subject');
    const aiBox = btn.closest('.ai-box');
    const aiScore = subjectEl.querySelector('.ai-score');
    aiBox.querySelectorAll('.analyze-btn').forEach(button => { button.disabled = true; });
    btn.disabled = true;
    btn.textContent = 'Analyse en cours…';
    try {
      const res = await fetch('/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subjectData)
      });
      if (!res.ok) throw new Error('Erreur serveur');
      const ai = await res.json();
      if (aiScore) aiScore.outerHTML = buildAiScoreHtml(ai);
      aiBox.outerHTML = buildAiBoxHtml(ai);
      await fetch('/save-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: subjectData.subject,
          debateScore: ai.debateScore,
          controversyLevel: ai.controversyLevel,
          debateQuestion: ai.debateQuestion,
          resume: ai.resume,
          agonTheme: normalizeAgonTheme(ai.agonTheme),
          positionA: ai.positionA,
          positionB: ai.positionB
        })
      });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Réessayer (erreur)';
    }
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.unsave-btn');
    if (!btn) return;
    const title = btn.dataset.subjectTitle;
    if (!confirm('Supprimer "' + title + '" des sujets enregistrés ?')) return;
    try {
      const res = await fetch('/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unsave', subject: title })
      });
      if (!res.ok) throw new Error();
      btn.closest('.subject').remove();
    } catch {
      alert('Erreur lors de la suppression.');
    }
  });

</script>
</body>
</html>`);
});

app.get("/sent-to-agon", requireMixteAuth, (req, res) => {
  const sent = loadSentToAgonItems()
    .slice()
    .sort((a, b) => new Date(b.sentAt || 0).getTime() - new Date(a.sentAt || 0).getTime());

  function esc(t) {
    return String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

	  const itemsHtml = sent.map((item) => {
	    const links = Array.isArray(item.links) ? item.links.filter((link) => link && link.url) : [];
	    const sourceNames = Array.isArray(item.sources)
	      ? item.sources.map(source => String(source || "").trim()).filter(Boolean)
	      : String(item.sources || "").split(/[,;\n]+/).map(source => source.trim()).filter(Boolean);
	    const sourceDetailsHtml = (links.length || sourceNames.length)
	      ? `<details class="sent-links"><summary>Voir les sources (${links.length || sourceNames.length})</summary>${sourceNames.length ? `<p class="sent-source-names">${esc(sourceNames.join(", "))}</p>` : ""}${links.length ? `<ul>${links.map((link) => `<li><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.title || link.url)}</a>${link.source ? ` — ${esc(link.source)}` : ""}</li>`).join("")}</ul>` : ""}</details>`
	      : "";
	    return `
	      <section class="sent-item">
        <div class="sent-head">
          <div>
            <p class="sent-subject">${esc(item.subject || "")}</p>
            <h3>${esc(item.question || item.subject || "Sans titre")}</h3>
          </div>
          <small class="sent-date">Envoyé le ${new Date(item.sentAt).toLocaleString("fr-FR")}</small>
        </div>
	        ${item.resume ? `<p class="sent-resume">${esc(item.resume)}</p>` : ""}
	        <div class="sent-meta">
	          ${item.theme ? `<span>${esc(normalizeAgonTheme(item.theme))}</span>` : ""}
	          ${item.sessionLabel ? `<span>${esc(item.sessionLabel)}</span>` : ""}
	        </div>
	        ${Array.isArray(item.keywords) && item.keywords.length ? `<div class="sent-keywords">${item.keywords.map((keyword) => `<span class="chip">${esc(keyword)}</span>`).join("")}</div>` : ""}
	        ${sourceDetailsHtml}
	      </section>
	    `;
	  }).join("");

  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Articles envoyés vers Agôn</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 980px; margin: 40px auto; padding: 0 16px; line-height: 1.5; background: #f7f7f7; color: #111; }
    h1 { margin-bottom: 4px; }
    .intro { color: #555; margin-bottom: 24px; }
    .nav { margin-bottom: 20px; }
    .nav a { display: inline-block; margin-right: 10px; padding: 8px 12px; background: white; border: 1px solid #ddd; border-radius: 999px; text-decoration: none; color: #111; font-size: 0.9rem; }
    .nav a:hover { background: #eee; }
    .sent-item { background: white; border: 1px solid #e5e7eb; border-radius: 16px; padding: 18px 20px; margin-bottom: 18px; }
    .sent-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .sent-subject { margin: 0 0 4px; font-size: 0.8rem; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; }
    .sent-head h3 { margin: 0; font-size: 1.02rem; }
    .sent-date { color: #9ca3af; font-size: 0.8rem; white-space: nowrap; }
    .sent-resume { color: #374151; white-space: pre-wrap; margin: 12px 0; }
    .sent-meta { display: flex; flex-wrap: wrap; gap: 8px; color: #6b7280; font-size: 0.84rem; margin-bottom: 10px; }
    .sent-meta span, .chip { display: inline-flex; align-items: center; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 999px; padding: 4px 9px; }
    .sent-keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
	    .sent-links summary { display: inline-flex; align-items: center; gap: 8px; border: 1px solid #ddd; background: white; border-radius: 999px; padding: 7px 13px; cursor: pointer; font-weight: 700; color: #1f2937; user-select: none; }
	    .sent-links summary::-webkit-details-marker { display: none; }
	    .sent-links summary::after { content: "▾"; font-size: 0.78rem; color: #777; transition: transform 0.16s ease; }
	    .sent-links[open] summary::after { transform: rotate(180deg); }
	    .sent-source-names { color: #6b7280; font-size: 0.86rem; margin: 10px 0 0; }
    .sent-links ul { margin: 10px 0 0; padding-left: 18px; }
    .sent-links li { margin-bottom: 6px; }
    .empty { color: #888; margin-top: 40px; }
  </style>
</head>
<body>
  <div class="nav">
    <a href="/mixte">Veille mixte</a>
    <a href="/saved">Sujets enregistrés</a>
    <a href="/sent-to-agon">Articles envoyés vers Agôn</a>
    <a href="/admin">⚙ Admin</a>
  </div>
  <h1>Articles envoyés vers Agôn</h1>
  <p class="intro">${sent.length} article(s) déjà envoyé(s) vers Agôn.</p>
  ${sent.length ? itemsHtml : '<p class="empty">Aucun article envoyé vers Agôn pour le moment.</p>'}
</body>
</html>`);
});

app.post("/save-update", requireMixteAuth, async (req, res) => {
  const savedFile = path.join(__dirname, "saved-subjects.json");
  try {
    try {
      await fetch("http://127.0.0.1:3002/save-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {})
      });
    } catch {}

    let saved = [];
    if (fs.existsSync(savedFile)) {
      saved = JSON.parse(fs.readFileSync(savedFile, "utf8"));
    }
    const { subject, ...updates } = req.body || {};
    const idx = saved.findIndex(s => s.subject === subject);
    if (idx !== -1) {
      const merged = { ...saved[idx], ...updates };
      if (updates.ai && saved[idx]?.ai) {
        merged.ai = { ...saved[idx].ai, ...updates.ai };
      }
      saved[idx] = merged;
      fs.writeFileSync(savedFile, JSON.stringify(saved, null, 2), "utf8");
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Admin : gestion des sources ---

app.get("/admin", (req, res) => {
  const isOnline = !!process.env.RENDER;
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Administration des sources</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 980px; margin: 40px auto; padding: 0 16px; background: #f7f7f7; color: #111; }
    h1 { margin-bottom: 4px; }
    .nav { margin-bottom: 28px; }
    .nav a { display: inline-block; margin-right: 10px; padding: 8px 12px; background: white; border: 1px solid #ddd; border-radius: 999px; text-decoration: none; color: #111; font-size: 0.9rem; }
    .nav a:hover { background: #f0f0f0; }
    .tabs { display: flex; gap: 8px; margin-bottom: 24px; }
    .tab-btn { padding: 10px 20px; border: 1px solid #ddd; border-radius: 999px; background: white; cursor: pointer; font: inherit; font-size: 0.95rem; color: #555; }
    .tab-btn.active { background: #111; color: white; border-color: #111; font-weight: 700; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
	    .source-list { list-style: none; padding: 0; margin: 0 0 32px; }
	    .source-list-dropdown { margin: 0 0 18px; }
	    .source-list-dropdown summary { display: inline-flex; align-items: center; gap: 8px; width: fit-content; border: 1px solid #ddd; background: white; border-radius: 999px; padding: 8px 14px; color: #111; font: inherit; font-size: 0.9rem; font-weight: 700; cursor: pointer; user-select: none; }
	    .source-list-dropdown summary::-webkit-details-marker { display: none; }
	    .source-list-dropdown summary::after { content: "▾"; font-size: 0.78rem; color: #777; transition: transform 0.16s ease; }
	    .source-list-dropdown[open] summary::after { transform: rotate(180deg); }
	    .source-list-dropdown summary:hover { background: #f0f0f0; }
	    .source-list-dropdown .source-list { margin-top: 12px; }
	    .source-item { background: white; border: 1px solid #e0e0e0; border-radius: 12px; padding: 14px 18px; margin-bottom: 10px; display: flex; align-items: flex-start; gap: 14px; }
    .source-info { flex: 1; min-width: 0; }
    .source-nom { font-weight: 700; font-size: 0.98rem; margin-bottom: 2px; }
    .source-orientation { font-size: 0.82rem; color: #666; margin-bottom: 4px; }
    .source-url { font-size: 0.78rem; color: #999; word-break: break-all; }
    .source-actions { display: flex; gap: 8px; flex-shrink: 0; }
    .btn { padding: 7px 14px; border-radius: 999px; border: 1px solid #ddd; background: white; cursor: pointer; font: inherit; font-size: 0.85rem; }
    .btn-edit { color: #0645ad; border-color: #0645ad; }
    .btn-edit:hover { background: #eef3ff; }
    .btn-del { color: #c0392b; border-color: #c0392b; }
    .btn-del:hover { background: #fdf0ee; }
    .btn-primary { background: #111; color: white; border-color: #111; font-weight: 700; }
    .btn-primary:hover { background: #333; }
    .btn-secondary { background: white; color: #111; border-color: #bbb; }
    .add-form { background: white; border: 1px solid #e0e0e0; border-radius: 14px; padding: 20px 24px; margin-top: 8px; }
    .add-form h3 { margin: 0 0 16px; font-size: 1rem; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
    .form-grid.three { grid-template-columns: 1fr 1fr 1fr; }
    label { display: block; font-size: 0.82rem; font-weight: 600; margin-bottom: 4px; color: #555; }
    input { width: 100%; padding: 9px 12px; border: 1px solid #ddd; border-radius: 8px; font: inherit; font-size: 0.9rem; }
    input:focus { outline: 2px solid #111; outline-offset: 1px; }
    .form-actions { display: flex; gap: 10px; }
    .toast { position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%); background: #111; color: white; padding: 12px 24px; border-radius: 999px; font-size: 0.9rem; opacity: 0; pointer-events: none; transition: opacity 0.3s; z-index: 999; }
    .toast.show { opacity: 1; }
    .group-header { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 6px 12px; border-radius: 999px; display: inline-block; margin: 18px 0 10px; }
    .orient-badge { display: inline-block; font-size: 0.72rem; font-weight: 600; padding: 2px 9px; border-radius: 999px; margin-left: 6px; vertical-align: middle; }
    .ac-panel { background: white; border: 1px solid #e0e0e0; border-radius: 14px; padding: 24px; margin-top: 8px; max-width: 560px; }
    .ac-toggle-row { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
    .ac-toggle { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
    .ac-toggle input { opacity: 0; width: 0; height: 0; }
    .ac-slider { position: absolute; inset: 0; background: #ccc; border-radius: 999px; cursor: pointer; transition: background 0.2s; }
    .ac-slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: white; border-radius: 50%; transition: transform 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
    .ac-toggle input:checked + .ac-slider { background: #111; }
    .ac-toggle input:checked + .ac-slider::before { transform: translateX(20px); }
    .ac-toggle-label { font-weight: 700; font-size: 1rem; }
    .ac-fields { display: flex; flex-direction: column; gap: 18px; }
    .ac-fields.hidden { display: none; }
    .ac-field { display: flex; flex-direction: column; gap: 5px; }
    .ac-field label { font-size: 0.82rem; font-weight: 600; color: #555; }
    .ac-field select, .ac-field input[type=time] { padding: 9px 12px; border: 1px solid #ddd; border-radius: 8px; font: inherit; font-size: 0.9rem; max-width: 220px; }
    .ac-times-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .ac-status { margin-top: 20px; padding: 12px 16px; border-radius: 10px; font-size: 0.88rem; background: #f7f7f7; color: #666; }
    .ac-status.active { background: #f0faf0; border: 1px solid #b0d8b0; color: #2d5a2d; }
    .ac-status ul { margin: 6px 0 0; padding-left: 18px; }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="/mixte">Veille mixte</a>
    <a href="/mixte#saved">Sujets enregistrés</a>
    <a href="/admin" style="background:#111;color:white;border-color:#111;">⚙ Admin</a>
  </nav>
  <h1>Administration des sources</h1>
  <p style="color:#555;margin-bottom:24px;">Gérez ici la liste des médias presse et des chaînes YouTube surveillées.</p>

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('presse')">📰 Médias presse</button>
    <button class="tab-btn" onclick="switchTab('youtube')">▶ Chaînes YouTube</button>
    <button class="tab-btn" onclick="switchTab('auto')">⏰ Collecte auto</button>
  </div>

	  <!-- Onglet Presse -->
	  <div id="tab-presse" class="tab-panel active">
	    <details class="source-list-dropdown">
	      <summary>Voir les médias presse</summary>
	      <ul class="source-list" id="list-presse"></ul>
	    </details>
	    ${isOnline
      ? `<p style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px 16px;color:#856404;font-size:0.9rem;margin-top:12px;">
          Pour ajouter ou modifier un média, passez en mode local.
        </p>`
      : `<details id="form-presse-wrap">
      <summary style="cursor:pointer;font-weight:600;color:#0645ad;margin-bottom:12px;">+ Ajouter un média presse</summary>
      <div class="add-form">
        <h3 id="form-presse-title">Nouveau média</h3>
        <div class="form-grid">
          <div><label>Nom</label><input id="p-nom" placeholder="Le Monde"></div>
          <div><label>Orientation</label><select id="p-orientation">
            <option value="généraliste">Généraliste</option>
            <option value="gauche">Gauche</option>
            <option value="droite">Droite</option>
            <option value="autre">Autre</option>
          </select></div>
        </div>
        <div style="margin-bottom:14px"><label>URL RSS</label><input id="p-rss" placeholder="https://..."></div>
        <div class="form-actions">
          <button class="btn btn-primary" onclick="submitPresse()">Enregistrer</button>
          <button class="btn btn-secondary" onclick="cancelPresse()">Annuler</button>
        </div>
      </div>
    </details>`}
  </div>

	  <!-- Onglet YouTube -->
	  <div id="tab-youtube" class="tab-panel">
	    <details class="source-list-dropdown">
	      <summary>Voir les chaînes YouTube</summary>
	      <ul class="source-list" id="list-youtube"></ul>
	    </details>
	    ${isOnline
      ? ''
      : `<details id="form-youtube-wrap">
      <summary style="cursor:pointer;font-weight:600;color:#c0392b;margin-bottom:12px;">+ Ajouter une chaîne YouTube</summary>
      <div class="add-form">
        <h3 id="form-youtube-title">Nouvelle chaîne</h3>
        <div class="form-grid">
          <div><label>Nom</label><input id="y-nom" placeholder="Blast"></div>
          <div><label>Orientation</label><select id="y-orientation">
            <option value="généraliste">Généraliste</option>
            <option value="gauche">Gauche</option>
            <option value="droite">Droite</option>
            <option value="autre">Autre</option>
          </select></div>
        </div>
        <div class="form-grid">
          <div><label>URL de la chaîne</label><input id="y-url" placeholder="https://www.youtube.com/@..."></div>
          <div><label>URL RSS</label><input id="y-rss" placeholder="https://www.youtube.com/feeds/videos.xml?channel_id=..."></div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" onclick="submitYoutube()">Enregistrer</button>
          <button class="btn btn-secondary" onclick="cancelYoutube()">Annuler</button>
        </div>
      </div>
    </details>`}
  </div>

  <!-- Onglet Collecte automatique -->
  <div id="tab-auto" class="tab-panel">
    <div class="ac-panel">
      <div class="ac-toggle-row">
        <label class="ac-toggle">
          <input type="checkbox" id="ac-enabled" onchange="onAcToggle()">
          <span class="ac-slider"></span>
        </label>
        <span class="ac-toggle-label">Collecte automatique</span>
      </div>
      <div class="ac-toggle-row">
        <label class="ac-toggle">
          <input type="checkbox" id="ap-enabled" onchange="onApToggle()">
          <span class="ac-slider"></span>
        </label>
        <span class="ac-toggle-label">Publication automatique sur Agôn</span>
        <button id="ap-run-btn" onclick="runAutoPublishNow()" style="margin-left:12px;padding:4px 14px;border-radius:999px;border:1px solid #111;background:#111;color:#fff;font:inherit;font-size:0.82rem;cursor:pointer;">Lancer maintenant</button>
      </div>
      <div class="ac-fields" id="ac-fields">
        <div class="ac-field">
          <label>Fréquence par jour</label>
          <select id="ac-freq" onchange="renderAcTimes()">
            <option value="1">1 fois par jour</option>
            <option value="2">2 fois par jour</option>
            <option value="3">3 fois par jour</option>
            <option value="4">4 fois par jour</option>
          </select>
        </div>
        <div class="ac-field">
          <label>Heure(s) de collecte (heure de la Réunion)</label>
          <div class="ac-times-grid" id="ac-times"></div>
        </div>
        <div>
          <button class="btn btn-primary" onclick="saveAutoCollect()">Enregistrer</button>
        </div>
      </div>
      <div class="ac-status" id="ac-status"></div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

<script>
const IS_ONLINE = ${isOnline};
let medias = [];
let chaines = [];
let editingPresse = null;
let editingYoutube = null;

function normalizeOrientationToSelect(val) {
  const v = (val || '').toLowerCase();
  if (v.includes('gauche')) return 'gauche';
  if (v.includes('droite') || v.includes('conservateur') || v.includes('souverainiste')) return 'droite';
  if (v.includes('généraliste') || v.includes('generaliste') || v.includes('centre') || v.includes('régional') || v.includes('regional') || v.includes('service public') || v.includes('institutionnel')) return 'généraliste';
  if (val && val.trim()) return 'autre';
  return 'généraliste';
}
let hasUnsavedFormChanges = false;

const ORIENT_GROUPS = [
  { key: 0, label: "Gauche",              bg: "#c0392b", color: "#fff" },
  { key: 1, label: "Centre-gauche",       bg: "#e67e22", color: "#fff" },
  { key: 2, label: "Généraliste / neutre",bg: "#7f8c8d", color: "#fff" },
  { key: 3, label: "Centre-droit",        bg: "#2980b9", color: "#fff" },
  { key: 4, label: "Droite",              bg: "#1a3a5c", color: "#fff" },
];

function getOrientationScore(orientation) {
  const o = (orientation || "").toLowerCase();
  // Droite en priorité absolue (avant tout terme neutre comme "info continue", "généraliste"…)
  if (o.includes("droite") && !o.includes("centre")) return 4;
  if (o.includes("souverainiste") || o.includes("conservateur") || o.includes("identitaire")) return 4;
  if (o.includes("républicain") && !o.includes("gauche")) return 4;
  // Centre-droit
  if (o.includes("centre-droit") || o.includes("droite-centre") || (o.includes("centre") && o.includes("droit"))) return 3;
  // Gauche (avant généraliste)
  if ((o.includes("gauche") || o.includes("écologie")) && !o.includes("centre")) return 0;
  // Centre-gauche
  if (o.includes("centre-gauche") || o.includes("satire")) return 1;
  // Généraliste / neutre (tout le reste)
  return 2;
}

function getOrientationGroup(score) {
  return ORIENT_GROUPS.find(g => g.key === score) || ORIENT_GROUPS[2];
}

function orientBadge(orientation) {
  const score = getOrientationScore(orientation);
  const g = getOrientationGroup(score);
  return \`<span class="orient-badge" style="background:\${g.bg};color:\${g.color}">\${g.label}</span>\`;
}

async function init() {
  const [r1, r2] = await Promise.all([
    fetch('/api/medias').then(r => r.json()),
    fetch('/api/youtube-chaines').then(r => r.json())
  ]);
  medias = r1;
  chaines = r2;
  renderPresse();
  renderYoutube();
  bindUnsavedFormWarning();
  await initAutoCollect();
  await initAutoPublish();
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', (i === 0 && name === 'presse') || (i === 1 && name === 'youtube') || (i === 2 && name === 'auto'));
  });
  document.getElementById('tab-presse').classList.toggle('active', name === 'presse');
  document.getElementById('tab-youtube').classList.toggle('active', name === 'youtube');
  document.getElementById('tab-auto').classList.toggle('active', name === 'auto');
}

let acConfig = { enabled: false, times: ['08:00'] };

async function initAutoCollect() {
  acConfig = await fetch('/api/auto-collect').then(r => r.json());
  document.getElementById('ac-enabled').checked = acConfig.enabled;
  document.getElementById('ac-freq').value = String(acConfig.times.length || 1);
  renderAcTimes();
  renderAcStatus();
}

function onAcToggle() {
  renderAcStatus();
}

function renderAcTimes() {
  const count = parseInt(document.getElementById('ac-freq').value);
  const existing = Array.from(document.querySelectorAll('.ac-time-input')).map(i => i.value);
  const times = acConfig.times.slice();
  while (times.length < count) times.push('08:00');
  const grid = document.getElementById('ac-times');
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const val = existing[i] || times[i] || '08:00';
    const inp = document.createElement('input');
    inp.type = 'time';
    inp.className = 'ac-time-input';
    inp.value = val;
    grid.appendChild(inp);
  }
}

function renderAcStatus() {
  const div = document.getElementById('ac-status');
  const enabled = document.getElementById('ac-enabled').checked;
  if (!enabled) { div.textContent = 'Collecte automatique désactivée.'; div.className = 'ac-status'; return; }
  const times = Array.from(document.querySelectorAll('.ac-time-input')).map(i => i.value);
  if (!times.length) { div.textContent = 'Aucune heure configurée.'; div.className = 'ac-status'; return; }
  div.className = 'ac-status active';
  div.innerHTML = \`<strong>Actif</strong> — \${times.length} collecte(s)/jour :<ul>\${times.map(t => \`<li>à \${t}</li>\`).join('')}</ul>\`;
}

async function initAutoPublish() {
  const config = await fetch('/api/auto-publish').then(r => r.json());
  document.getElementById('ap-enabled').checked = config.enabled;
}

async function onApToggle() {
  const enabled = document.getElementById('ap-enabled').checked;
  try {
    const r = await fetch('/api/auto-publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    const d = await r.json();
    if (d.ok) showToast(enabled ? 'Publication automatique activée ✓' : 'Publication automatique désactivée');
    else showError('Erreur : ' + d.error);
  } catch (err) {
    showError('Erreur réseau : ' + err.message);
  }
}

async function runAutoPublishNow() {
  const btn = document.getElementById('ap-run-btn');
  btn.disabled = true;
  btn.textContent = 'En cours…';
  try {
    const r = await fetch('/api/auto-publish/run', { method: 'POST' });
    const d = await r.json();
    if (d.ok) showToast('Pipeline terminé ✓');
    else showError('Erreur : ' + (d.error || 'inconnue'));
  } catch (err) {
    showError('Erreur réseau : ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Lancer maintenant';
  }
}

async function saveAutoCollect() {
  const enabled = document.getElementById('ac-enabled').checked;
  const times = Array.from(document.querySelectorAll('.ac-time-input')).map(i => i.value);
  if (!times.length) { alert('Ajoutez au moins une heure.'); return; }
  acConfig = { enabled, times };
  try {
    const r = await fetch('/api/auto-collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(acConfig) });
    const d = await r.json();
    if (d.ok) { showToast('Planification enregistrée ✓'); renderAcStatus(); }
    else showError('Erreur : ' + d.error);
  } catch (err) {
    showError('Erreur réseau : ' + err.message);
  }
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function markUnsavedFormChanges() {
  hasUnsavedFormChanges = true;
}

function clearUnsavedFormChanges() {
  hasUnsavedFormChanges = false;
}

function bindUnsavedFormWarning() {
  ['p-nom', 'p-rss', 'y-nom', 'y-url', 'y-rss'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.addEventListener('input', markUnsavedFormChanges);
  });
  ['p-orientation', 'y-orientation'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) sel.addEventListener('change', markUnsavedFormChanges);
  });

  window.addEventListener('beforeunload', event => {
    if (!hasUnsavedFormChanges) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

function sortedWithOriginalIndex(arr) {
  return arr
    .map((item, originalIndex) => ({ item, originalIndex, score: getOrientationScore(item.orientation) }))
    .sort((a, b) => a.score - b.score);
}

function renderPresse() {
  const ul = document.getElementById('list-presse');
  if (!medias.length) { ul.innerHTML = '<p style="color:#888">Aucun média.</p>'; return; }
  const sorted = sortedWithOriginalIndex(medias);
  let html = '';
  let lastScore = -1;
  sorted.forEach(({ item: m, originalIndex: i, score }) => {
    const g = getOrientationGroup(score);
    if (score !== lastScore) {
      html += \`<li style="list-style:none"><span class="group-header" style="background:\${g.bg};color:\${g.color}">\${g.label}</span></li>\`;
      lastScore = score;
    }
    html += \`
    <li class="source-item">
      <div class="source-info">
        <div class="source-nom">\${esc(m.nom)}</div>
        <div class="source-orientation" style="color:#666;font-size:0.82rem">\${esc(m.orientation)}</div>
        <div class="source-url">\${esc(m.rss)}</div>
      </div>
      \${IS_ONLINE ? '' : '<div class="source-actions"><button class="btn btn-edit" onclick="editPresse('+i+')">Modifier</button><button class="btn btn-del" onclick="deletePresse('+i+')">Supprimer</button></div>'}
    </li>\`;
  });
  ul.innerHTML = html;
}

function renderYoutube() {
  const ul = document.getElementById('list-youtube');
  if (!chaines.length) { ul.innerHTML = '<p style="color:#888">Aucune chaîne.</p>'; return; }
  const sorted = sortedWithOriginalIndex(chaines);
  let html = '';
  let lastScore = -1;
  sorted.forEach(({ item: c, originalIndex: i, score }) => {
    const g = getOrientationGroup(score);
    if (score !== lastScore) {
      html += \`<li style="list-style:none"><span class="group-header" style="background:\${g.bg};color:\${g.color}">\${g.label}</span></li>\`;
      lastScore = score;
    }
    html += \`
    <li class="source-item">
      <div class="source-info">
        <div class="source-nom">\${esc(c.nom)}</div>
        <div class="source-orientation" style="color:#666;font-size:0.82rem">\${esc(c.orientation)}</div>
        <div class="source-url">\${esc(c.url)}</div>
      </div>
      \${IS_ONLINE ? '' : '<div class="source-actions"><button class="btn btn-edit" onclick="editYoutube('+i+')">Modifier</button><button class="btn btn-del" onclick="deleteYoutube('+i+')">Supprimer</button></div>'}
    </li>\`;
  });
  ul.innerHTML = html;
}

function editPresse(i) {
  editingPresse = i;
  const m = medias[i];
  document.getElementById('p-nom').value = m.nom;
  document.getElementById('p-orientation').value = normalizeOrientationToSelect(m.orientation);
  document.getElementById('p-rss').value = m.rss;
  document.getElementById('form-presse-title').textContent = 'Modifier le média';
  document.getElementById('form-presse-wrap').open = true;
  document.getElementById('form-presse-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelPresse() {
  editingPresse = null;
  document.getElementById('p-nom').value = '';
  document.getElementById('p-orientation').value = 'généraliste';
  document.getElementById('p-rss').value = '';
  document.getElementById('form-presse-title').textContent = 'Nouveau média';
  document.getElementById('form-presse-wrap').open = false;
  clearUnsavedFormChanges();
}

async function submitPresse() {
  const nom = document.getElementById('p-nom').value.trim();
  const orientation = document.getElementById('p-orientation').value.trim();
  const rss = document.getElementById('p-rss').value.trim();
  if (!nom || !rss) { alert('Nom et URL RSS requis.'); return; }

  const previous = medias.slice();
  const entry = { nom, orientation, rss };
  if (editingPresse !== null) {
    medias[editingPresse] = entry;
  } else {
    medias.push(entry);
  }

  renderPresse();
  cancelPresse();

  const saved = await savePresse();
  if (!saved) {
    medias = previous;
    renderPresse();
    hasUnsavedFormChanges = true;
  } else {
    clearUnsavedFormChanges();
  }
}

async function deletePresse(i) {
  if (!confirm(\`Supprimer "\${medias[i].nom}" ?\`)) return;

  const previous = medias.slice();
  medias.splice(i, 1);
  renderPresse();

  const saved = await savePresse();
  if (!saved) {
    medias = previous;
    renderPresse();
  }
}

async function savePresse() {
  try {
    const r = await fetch('/api/medias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(medias) });
    const d = await r.json();
    if (d.ok) {
      showToast(\`Médias presse sauvegardés ✓ (\${d.count} médias)\`);
      return true;
    } else {
      showError('Échec de la sauvegarde : ' + d.error);
      return false;
    }
  } catch (err) {
    showError('Erreur réseau : ' + err.message);
    return false;
  }
}

function editYoutube(i) {
  editingYoutube = i;
  const c = chaines[i];
  document.getElementById('y-nom').value = c.nom;
  document.getElementById('y-orientation').value = normalizeOrientationToSelect(c.orientation);
  document.getElementById('y-url').value = c.url;
  document.getElementById('y-rss').value = c.rss;
  document.getElementById('form-youtube-title').textContent = 'Modifier la chaîne';
  document.getElementById('form-youtube-wrap').open = true;
  document.getElementById('form-youtube-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelYoutube() {
  editingYoutube = null;
  document.getElementById('y-nom').value = '';
  document.getElementById('y-orientation').value = 'généraliste';
  document.getElementById('y-url').value = '';
  document.getElementById('y-rss').value = '';
  document.getElementById('form-youtube-title').textContent = 'Nouvelle chaîne';
  document.getElementById('form-youtube-wrap').open = false;
  clearUnsavedFormChanges();
}

async function submitYoutube() {
  const nom = document.getElementById('y-nom').value.trim();
  const orientation = document.getElementById('y-orientation').value.trim();
  const url = document.getElementById('y-url').value.trim();
  const rss = document.getElementById('y-rss').value.trim();
  if (!nom || !url || !rss) { alert('Nom, URL chaîne et URL RSS requis.'); return; }

  const previous = chaines.slice();
  const entry = { nom, orientation, url, rss };
  if (editingYoutube !== null) {
    chaines[editingYoutube] = entry;
  } else {
    chaines.push(entry);
  }

  renderYoutube();
  cancelYoutube();

  const saved = await saveYoutube();
  if (!saved) {
    chaines = previous;
    renderYoutube();
    hasUnsavedFormChanges = true;
  } else {
    clearUnsavedFormChanges();
  }
}

async function deleteYoutube(i) {
  if (!confirm(\`Supprimer "\${chaines[i].nom}" ?\`)) return;

  const previous = chaines.slice();
  chaines.splice(i, 1);
  renderYoutube();

  const saved = await saveYoutube();
  if (!saved) {
    chaines = previous;
    renderYoutube();
  }
}

async function saveYoutube() {
  try {
    const r = await fetch('/api/youtube-chaines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chaines) });
    const d = await r.json();
    if (d.ok) {
      showToast(\`Chaînes YouTube sauvegardées ✓ (\${d.count} chaînes)\`);
      return true;
    } else {
      showError('Échec de la sauvegarde : ' + d.error);
      return false;
    }
  } catch (err) {
    showError('Erreur réseau : ' + err.message);
    return false;
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function showError(msg) {
  let banner = document.getElementById('error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'error-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#c0392b;color:white;padding:14px 20px;font-size:0.95rem;font-weight:600;z-index:9999;display:flex;justify-content:space-between;align-items:center;';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;color:white;font-size:1.2rem;cursor:pointer;padding:0 4px;';
    close.onclick = () => banner.remove();
    banner.appendChild(document.createTextNode(''));
    banner.appendChild(close);
    document.body.prepend(banner);
  }
  banner.firstChild.textContent = msg;
}

init();
</script>
</body>
</html>`);
});

app.get("/api/medias", (req, res) => {
  const filePath = path.join(__dirname, "medias.json");
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    res.json(data);
  } catch {
    res.json([]);
  }
});

app.post("/api/medias", (req, res) => {
  const filePath = path.join(__dirname, "medias.json");
  if (!Array.isArray(req.body)) {
    console.error("[admin] POST /api/medias : corps invalide :", req.body);
    return res.status(400).json({ ok: false, error: "Corps de requête invalide (tableau attendu). Rechargez la page et réessayez." });
  }
  try {
    const json = JSON.stringify(req.body, null, 2);
    fs.writeFileSync(filePath, json, "utf8");
    const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
    console.log(`[admin] medias.json mis à jour : ${written.length} média(s).`);
    res.json({ ok: true, count: written.length });
  } catch (err) {
    console.error("[admin] Erreur écriture medias.json :", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/youtube-chaines", (req, res) => {
  const filePath = path.join(__dirname, "youtube-chaines.json");
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    res.json(data);
  } catch {
    res.json([]);
  }
});

app.post("/api/youtube-chaines", (req, res) => {
  const filePath = path.join(__dirname, "youtube-chaines.json");
  if (!Array.isArray(req.body)) {
    console.error("[admin] POST /api/youtube-chaines : corps invalide :", req.body);
    return res.status(400).json({ ok: false, error: "Corps de requête invalide (tableau attendu). Rechargez la page et réessayez." });
  }
  try {
    const json = JSON.stringify(req.body, null, 2);
    fs.writeFileSync(filePath, json, "utf8");
    const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
    console.log(`[admin] youtube-chaines.json mis à jour : ${written.length} chaîne(s).`);
    res.json({ ok: true, count: written.length });
  } catch (err) {
    console.error("[admin] Erreur écriture youtube-chaines.json :", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/agon-stories", requireMixteAuth, async (req, res) => {
  try {
    const stories = await loadAgonStories();
    res.json({
      ok: true,
      stories: stories.map((story) => ({
        story_id: story.story_id,
        story_title: story.story_title,
        story_summary: story.story_summary || "",
        updated_at: story.updated_at || "",
        latest_episode_id: story.latest_episode_id || "",
        latest_episode_title: story.latest_episode_title || "",
        latest_episode_url: buildAgonDebateUrl(story.latest_episode_id || "")
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur chargement histoires" });
  }
});

app.get("/api/agon-stories/:storyId/debates", requireMixteAuth, async (req, res) => {
  try {
    const storyId = encodeURIComponent(String(req.params.storyId || "").trim());
    const r = await fetch(`${AGON_URL}/api/veille/stories/${storyId}/debates`);
    const data = await r.json().catch(() => ({ ok: false, debates: [], error: "Réponse invalide Agôn" }));
    if (!r.ok || data.ok === false) {
      return res.status(r.status || 500).json({
        ok: false,
        debates: Array.isArray(data?.debates) ? data.debates : [],
        error: data.error || "Erreur chargement articles de l'histoire"
      });
    }
    res.json({
      ok: true,
      story: data.story || null,
      debates: Array.isArray(data.debates) ? data.debates : []
    });
  } catch (err) {
    res.status(500).json({ ok: false, debates: [], error: err.message || "Erreur chargement articles de l'histoire" });
  }
});

app.post("/api/agon-stories", requireMixteAuth, async (req, res) => {
  try {
    const r = await fetch(`${AGON_URL}/api/veille/stories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        story_title: String(req.body?.story_title || "").trim(),
        story_summary: String(req.body?.story_summary || "").trim()
      })
    });
    const data = await r.json().catch(() => ({ ok: false, error: "Réponse invalide Agôn" }));
    if (!r.ok || data.ok === false) {
      return res.status(r.status || 500).json({ ok: false, error: data.error || "Erreur création histoire" });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur création histoire" });
  }
});

app.put("/api/agon-stories/:storyId", requireMixteAuth, async (req, res) => {
  try {
    const storyId = encodeURIComponent(String(req.params.storyId || "").trim());
    const r = await fetch(`${AGON_URL}/api/veille/stories/${storyId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        story_title: String(req.body?.story_title || "").trim(),
        story_summary: String(req.body?.story_summary || "").trim()
      })
    });
    const data = await r.json().catch(() => ({ ok: false, error: "Réponse invalide Agôn" }));
    if (!r.ok || data.ok === false) {
      return res.status(r.status || 500).json({ ok: false, error: data.error || "Erreur modification histoire" });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur modification histoire" });
  }
});

app.delete("/api/agon-stories/:storyId", requireMixteAuth, async (req, res) => {
  try {
    const storyId = encodeURIComponent(String(req.params.storyId || "").trim());
    const r = await fetch(`${AGON_URL}/api/veille/stories/${storyId}`, {
      method: "DELETE"
    });
    const data = await r.json().catch(() => ({ ok: false, error: "Réponse invalide Agôn" }));
    if (!r.ok || data.ok === false) {
      return res.status(r.status || 500).json({ ok: false, error: data.error || "Erreur suppression histoire" });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur suppression histoire" });
  }
});

const WEAK_OUTGOING_SINGLE_WORD_TAGS = new Set([
  "accord", "accords", "accident", "accidents", "accusation", "accusations",
  "attaque", "attaques", "baisse", "blocage", "blocages", "budget", "chute",
  "colere", "controle", "controles", "coupe", "coupes", "decision", "decret",
  "decrets", "defaite", "debat", "debats", "demission", "dette", "election",
  "elections", "enquete", "enquetes", "expulsion", "expulsions", "frappe",
  "frappes", "greve", "greves", "hausse", "loi", "manifestation",
  "manifestations", "mesure", "mesures", "mort", "morts", "motion", "plainte",
  "plaintes", "proces", "refere", "referendum", "refoule", "refoules",
  "reforme", "reformes", "rejet", "retrait", "sanction", "sanctions",
  "scrutin", "suppression", "tirs", "vote", "votes"
]);

function normalizeOutgoingKeywordKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function isWeakOutgoingSingleWordKeyword(keyword, context = {}) {
  const value = String(keyword || "").trim();
  if (!value || /\s/.test(value)) return false;

  const key = normalizeOutgoingKeywordKey(value);
  if (!key) return true;
  if (WEAK_OUTGOING_SINGLE_WORD_TAGS.has(key)) return true;
  if (/^[A-Z0-9][A-Z0-9-]{1,9}$/.test(value)) return false;
  if (!/^[A-ZÀ-ÖØ-Ý]/.test(value)) return true;

  const contents = Array.isArray(context?.contents) ? context.contents : [];
  const sourceText = [
    context?.subject || "",
    ...contents.slice(0, 10).flatMap((content) => [
      content?.title || "",
      content?.summary || ""
    ])
  ].join(" ");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !new RegExp(`(^|[^\\p{L}\\p{N}])${escapedValue}([^\\p{L}\\p{N}]|$)`, "u").test(sourceText);
}

function normalizeOutgoingKeywords(keywords, context = {}) {
  return [...new Set((Array.isArray(keywords) ? keywords : [])
    .map((keyword) => String(keyword || "").trim())
    .filter(Boolean)
    .filter((keyword) => {
      const wordCount = keyword.split(/\s+/).filter(Boolean).length;
      return wordCount !== 1 || !isWeakOutgoingSingleWordKeyword(keyword, context);
    }))]
    .slice(0, 10);
}

function normalizeOutgoingSources(sources, links) {
  if (Array.isArray(sources)) {
    return sources.map((source) => String(source || "").trim()).filter(Boolean);
  }
  if (typeof sources === "string") {
    return sources.split(/[,;\n]+/).map((source) => source.trim()).filter(Boolean);
  }
  return [...new Set((Array.isArray(links) ? links : [])
    .map((link) => String(link?.source || "").trim())
    .filter(Boolean))];
}

function buildTagGenerationPayload({ subject, question, sources, links }) {
  const normalizedLinks = Array.isArray(links) ? links : [];
  const contents = normalizedLinks.map((link) => ({
    type: link?.type || "article",
    source: link?.source || "",
    orientation: link?.orientation || "",
    title: link?.title || link?.text || "",
    link: link?.link || link?.url || "",
    summary: link?.summary || link?.description || ""
  }));
  const normalizedSources = normalizeOutgoingSources(sources, normalizedLinks);

  return {
    subject: String(subject || question || "").trim(),
    sources: normalizedSources,
    contents,
    articleCount: contents.filter((item) => item.type === "article").length,
    youtubeCount: contents.filter((item) => item.type === "youtube").length
  };
}

async function ensureKeywordsBeforeAgonSend({ subject, question, sources, links, keywords }) {
  const payload = buildTagGenerationPayload({ subject, question, sources, links });
  const currentKeywords = normalizeOutgoingKeywords(keywords, payload);
  if (currentKeywords.length) return currentKeywords;

  if (!payload.subject || !payload.contents.length) return currentKeywords;

  try {
    const response = await fetch("http://127.0.0.1:3002/generate-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || "Erreur génération tags");
    }
    const data = await response.json();
    return normalizeOutgoingKeywords([data?.mainKeyword], payload);
  } catch (error) {
    console.error("[send-to-agon] Tags absents et génération impossible:", error.message);
    return currentKeywords;
  }
}

app.post("/send-to-agon", requireMixteAuth, async (req, res) => {
  try {
    const { subject, sessionLabel, question, positionA, positionB, theme, resume, sources, links, storySelection, keywords, politicalOrientation } = req.body;
    const arenaMode = String(req.body?.arenaMode || "").trim() === "libre" ? "libre" : "positions";
    if (!question) return res.status(400).json({ ok: false, error: "question manquante" });
    const normalizedQuestion = limitDebateQuestion(question);
    const normalizedResume = ensureArticleOpeningSentenceBreak(resume);
    const resolvedKeywords = await ensureKeywordsBeforeAgonSend({ subject, question: normalizedQuestion, sources, links, keywords });
    console.log(`[send-to-agon] Envoi vers ${AGON_URL}/api/veille/receive`);
    const agonController = new AbortController();
    const agonTimeout = setTimeout(() => agonController.abort(), 15000);
    let r;
    try {
      r = await fetch(`${AGON_URL}/api/veille/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: normalizedQuestion, positionA, positionB, theme, resume: normalizedResume, sources, links: links || [], storySelection: storySelection || null, keywords: resolvedKeywords, politicalOrientation: politicalOrientation || null, arenaMode }),
        signal: agonController.signal
      });
    } finally {
      clearTimeout(agonTimeout);
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error(`[send-to-agon] Erreur ${r.status}: ${body}`);
      throw new Error(`Agôn a répondu ${r.status}: ${body}`);
    }
    upsertSentToAgonItem({
      subject,
      sessionLabel,
      question: normalizedQuestion,
      positionA,
      positionB,
      theme,
      resume: normalizedResume,
      sources,
      links: Array.isArray(links) ? links : [],
      storySelection: storySelection || null,
      keywords: resolvedKeywords,
      politicalOrientation: politicalOrientation || null,
      arenaMode,
      sentAt: new Date().toISOString()
    });
    console.log("[send-to-agon] Succès");
    res.json({ ok: true });
  } catch (err) {
    console.error("[send-to-agon] Exception:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================== ROUTES CERTAMEN ====================

const CERTAMEN_HTML = path.join(__dirname, "certamen.html");

app.get("/certamen", requireMixteAuth, (req, res) => {
  if (!fs.existsSync(CERTAMEN_HTML)) {
    return res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Certamen — Première analyse</title>
  <style>
    body { font-family: system-ui; max-width: 500px; margin: 80px auto; padding: 0 16px; text-align: center; color: #111; }
    nav { display: flex; gap: 16px; justify-content: center; margin-bottom: 40px; }
    nav a { color: #555; font-size: 0.9rem; text-decoration: none; }
    nav a:hover { color: #111; }
    h1 { font-size: 1.3rem; margin-bottom: 8px; }
    p { color: #555; margin-bottom: 24px; }
    #launch-btn { background: #111; color: #fff; border: none; border-radius: 999px; padding: 12px 28px; font: inherit; font-size: 1rem; font-weight: 700; cursor: pointer; margin-bottom: 12px; }
    #launch-btn:disabled { opacity: 0.5; cursor: wait; }
    #status { font-size: 0.88rem; color: #555; min-height: 20px; }
  </style>
</head>
<body>
  <nav><a href="/mixte">Veille mixte</a><a href="/admin">Admin</a></nav>
  <h1>Certamen</h1>
  <p>Le mode Certamen n'a pas encore été lancé.</p>
  <button id="launch-btn" onclick="launch()">Lancer la première analyse</button>
  <div id="status"></div>
  <script>
    (async function checkRunning() {
      try {
        var r = await fetch('/certamen/progress?t=' + Date.now());
        var p = await r.json();
        if (!p.running) return;
        var btn = document.getElementById('launch-btn');
        var status = document.getElementById('status');
        if (btn) { btn.disabled = true; btn.textContent = 'Analyse en cours…'; }
        if (status) status.textContent = 'Analyse déjà en cours, veuillez patienter…';
        var poll = setInterval(async function() {
          try {
            var r2 = await fetch('/certamen/progress?t=' + Date.now());
            var p2 = await r2.json();
            if (p2.step && status) status.textContent = 'Étape ' + p2.stepIndex + ' / ' + p2.stepTotal + ' — ' + p2.step + (p2.detail ? ' (' + p2.detail + ')' : '');
            if (!p2.running && p2.done) { clearInterval(poll); window.location.reload(); }
          } catch(e) {}
        }, 2000);
      } catch(e) {}
    })();
    async function launch() {
      var btn = document.getElementById('launch-btn');
      var status = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = 'Analyse en cours…';
      status.textContent = 'Collecte et analyse IA…';
      try {
        await fetch('/certamen/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        var seenRunning = false;
        var poll = setInterval(async function() {
          try {
            var r = await fetch('/certamen/progress?t=' + Date.now());
            var p = await r.json();
            if (p.running) seenRunning = true;
            if (p.step) status.textContent = 'Étape ' + p.stepIndex + ' / ' + p.stepTotal + ' — ' + p.step + (p.detail ? ' (' + p.detail + ')' : '');
            if (seenRunning && p.done) { clearInterval(poll); window.location.reload(); }
          } catch(e) {}
        }, 2000);
        setTimeout(function() { clearInterval(poll); window.location.reload(); }, 15 * 60 * 1000);
      } catch(e) {
        status.textContent = 'Erreur : ' + e.message;
        btn.disabled = false;
        btn.textContent = 'Réessayer';
      }
    }
  </script>
</body>
</html>`);
  }
  res.sendFile(CERTAMEN_HTML);
});

app.post("/certamen/refresh", requireMixteAuth, async (req, res) => {
  try {
    await fetch("http://127.0.0.1:3002/certamen/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {})
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/certamen/progress", requireMixteAuth, async (req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:3002/certamen/progress");
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.json({ running: false, done: false, stepIndex: 0, stepTotal: 4, step: "", detail: "" });
  }
});

// ==================== COLLECTE AUTOMATIQUE ====================

app.get("/api/auto-collect", (req, res) => {
  res.json(loadAutoCollectConfig());
});

app.post("/api/auto-collect", (req, res) => {
  const { enabled, times } = req.body || {};
  if (typeof enabled !== "boolean" || !Array.isArray(times) || times.length < 1 || times.length > 4) {
    return res.status(400).json({ ok: false, error: "Paramètres invalides" });
  }
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (times.some(t => !validTime.test(t))) {
    return res.status(400).json({ ok: false, error: "Format d'heure invalide (HH:MM attendu)" });
  }
  const config = { enabled, times };
  try {
    fs.writeFileSync(AUTO_COLLECT_FILE, JSON.stringify(config, null, 2), "utf8");
    scheduleAutoCollect(config);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Appelé périodiquement (ex: toutes les 15 min via GitHub Actions) pour déclencher
// la collecte si l'heure configurée dans l'admin (heure de la Réunion) est atteinte.
app.post("/api/auto-collect-tick", requireMixteAuth, async (req, res) => {
  const config = loadAutoCollectConfig();
  if (!config.enabled || !Array.isArray(config.times) || !config.times.length) {
    return res.json({ triggered: false, reason: "disabled" });
  }
  const nowMin = timeToMinutes(getReunionTimeHHMM());
  const today = getReunionDateStr();
  const TOLERANCE_MIN = 20;
  const due = config.times.find(t => {
    const tMin = timeToMinutes(t);
    return nowMin >= tMin && nowMin - tMin < TOLERANCE_MIN;
  });
  if (!due) return res.json({ triggered: false, reason: "no time due" });
  const runKey = `${today}_${due}`;
  if (config.lastRun === runKey) {
    return res.json({ triggered: false, reason: "already run" });
  }
  try {
    await fetch("http://127.0.0.1:3002/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minSources: config.minSources || 3 })
    });
    config.lastRun = runKey;
    fs.writeFileSync(AUTO_COLLECT_FILE, JSON.stringify(config, null, 2), "utf8");
    res.json({ triggered: true, time: due });

    // Publication auto une fois la collecte réellement terminée, en tâche de fond :
    // ne pas faire attendre la réponse HTTP (GitHub Actions a un --max-time de 60s).
    const autoPub = loadAutoPublishConfig();
    if (autoPub.enabled) {
      waitForVeilleMixteIdle().then((finished) => {
        if (finished) return runAutoPublishPipeline();
        console.warn("[auto-collect-tick] Délai d'attente dépassé, auto-publish annulé.");
      }).catch((err) => console.error("[auto-collect-tick] Erreur auto-publish :", err.message));
    }
  } catch (err) {
    res.status(500).json({ triggered: false, error: err.message });
  }
});

// ==================== PIPELINE AUTO-PUBLISH ====================

async function runAutoPublishPipeline() {
  console.log("[auto-publish] Démarrage du pipeline...");
  const sessionsFile = path.join(__dirname, "sessions-mixte.json");
  if (!fs.existsSync(sessionsFile)) {
    console.log("[auto-publish] Aucune session trouvée");
    return;
  }
  let sessions;
  try { sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf8")); } catch { return; }
  if (!sessions.length) return;

  const latestSession = sessions.find(s => (s.subjects || []).some(subj => subj.debateScore != null));
  if (!latestSession) { console.log("[auto-publish] Aucune session avec sujets analysés"); return; }
  const allSubjects = (latestSession.subjects || []).filter(s => s.debateScore != null);
  const maxSources = Math.max(...allSubjects.map(s => Number(s.sourceCount) || 0), 1);
  const top10 = allSubjects
    .slice()
    .sort((a, b) => {
      const rA = (Number(a.sourceCount) / maxSources) * 0.50 + (Number(a.debateScore) / 10) * 0.50;
      const rB = (Number(b.sourceCount) / maxSources) * 0.50 + (Number(b.debateScore) / 10) * 0.50;
      return rB - rA;
    })
    .slice(0, 10);

  console.log(`[auto-publish] ${top10.length} sujet(s) sélectionné(s) (session : ${latestSession.generatedAtLabel || "?"})`);

  const sentItems = loadSentToAgonItems();
  const sentSubjects = new Set(sentItems.map(i => i.subject));
  let sentCount = 0;

  for (const subj of top10) {
    const subjectTitle = subj.subject;
    if (sentSubjects.has(subjectTitle)) {
      console.log(`[auto-publish] Déjà envoyé : ${subjectTitle.slice(0, 60)}`);
      continue;
    }
    const score = Number(subj.debateScore) || 0;
    const arenaMode = score >= 8 ? "positions" : "libre";
    const contents = subj.contents || [];
    const sessionLabel = latestSession.generatedAtLabel || "";
    console.log(`[auto-publish] Traitement : "${subjectTitle.slice(0, 60)}" (score ${score}, mode ${arenaMode})`);

    try {
      const summary = await generateCompleteNarrativeContext({ subject: subjectTitle, contents, arenaMode }, null);
      let question = "", positionA = "", positionB = "", theme = "", resume = summary, politicalOrientation = null;

      if (arenaMode === "libre") {
        const freeResult = await generateFreeArenaArticle({ subject: subjectTitle, summary, arenaMode });
        question = limitDebateQuestion(freeResult.debateQuestion || subjectTitle);
        resume = freeResult.article || summary;
        try {
          const mottoSources = [...new Set(contents.map(c => c.source).filter(Boolean))];
          const mottoResult = await generateFreeArenaLatinMotto({ subject: question, summary, article: resume, sources: mottoSources, agonTheme: subj.ai?.agonTheme || "" });
          if (mottoResult.article) resume = mottoResult.article;
        } catch (mottoErr) {
          console.warn("[auto-publish] Devise latine ignorée :", mottoErr.message);
        }
      } else {
        const mediaResult = await generateMediaAnalysis({ subject: subjectTitle, summary, contents, arenaMode });
        question = limitDebateQuestion(mediaResult.debateQuestion || "");
        positionA = String(mediaResult.positionA || "").trim();
        positionB = String(mediaResult.positionB || "").trim();
        politicalOrientation = mediaResult.politicalOrientation || null;
        theme = normalizeAgonTheme(mediaResult.theme || subj.ai?.agonTheme || "");
        const styledResult = await generateStyledArticle({
          subject: subjectTitle, summary, debateAngle: mediaResult.debateAngle || "", debateQuestion: question,
          positionA, positionB, hasMediaContrast: false, mediaTreatment: "", mainIssue: mediaResult.mainIssue || "",
          narrativeTension: mediaResult.narrativeTension || "", possibleBiases: Array.isArray(mediaResult.possibleBiases) ? mediaResult.possibleBiases : [],
          debatePotential: mediaResult.debatePotential || "", editorialWarning: mediaResult.editorialWarning || "",
          editorialDecision: mediaResult.editorialDecision || "", questionQuality: mediaResult.questionQuality || "", arenaMode
        });
        if (styledResult.debateQuestion) question = limitDebateQuestion(styledResult.debateQuestion);
        if (styledResult.positionA) positionA = styledResult.positionA;
        if (styledResult.positionB) positionB = styledResult.positionB;
        if (styledResult.article) resume = styledResult.article;
      }

      if (!theme) theme = normalizeAgonTheme(subj.ai?.agonTheme || "");
      resume = ensureArticleOpeningSentenceBreak(resume);

      const links = (subj.selectedLinks || []).map(url => {
        const c = contents.find(x => x.link === url);
        return { title: c?.title || "", url, source: c?.source || "", type: c?.type || "article", date: c?.date || "", checked: true };
      }).filter(l => l.url);

      const sources = subj.sources || contents.map(c => c.source).filter(Boolean).join(", ");
      const resolvedKeywords = await ensureKeywordsBeforeAgonSend({ subject: subjectTitle, question, sources, links, keywords: [] });

      let storySelection = null;
      try {
        const suggestion = await suggestStoryLink({
          subject: subjectTitle,
          sources,
          contents,
          ai: { agonTheme: theme, debateQuestion: question, keywords: resolvedKeywords }
        });
        const storyDecision = suggestion.story_decision || "new_story";
        const matchedStoryId = suggestion.matched_story_id || null;
        if ((storyDecision === "existing_story" || storyDecision === "uncertain") && matchedStoryId) {
          storySelection = {
            storyDecision,
            matchedStoryId,
            matchedStoryTitle: suggestion.matched_story_title || "",
            previousEpisodeTitle: suggestion.previous_episode_title || "",
            previousEpisodeUrl: suggestion.previous_episode_url || "",
            confidence: Number(suggestion.confidence || 0),
            reason: suggestion.reason || "",
            criteria: suggestion.criteria || {},
            selectionMode: "existing"
          };
          console.log(`[auto-publish] Histoire associée : "${storySelection.matchedStoryTitle}" (confiance ${storySelection.confidence})`);
        } else {
          console.log("[auto-publish] Aucune histoire existante associée pour ce sujet");
        }
      } catch (storyErr) {
        console.warn("[auto-publish] Suggestion d'histoire ignorée :", storyErr.message);
      }

      const agonController = new AbortController();
      const agonTimeout = setTimeout(() => agonController.abort(), 15000);
      let r;
      try {
        r = await fetch(`${AGON_URL}/api/veille/receive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, positionA, positionB, theme, resume, sources, links, storySelection, keywords: resolvedKeywords, politicalOrientation, arenaMode }),
          signal: agonController.signal
        });
      } finally {
        clearTimeout(agonTimeout);
      }
      if (!r.ok) { const body = await r.text().catch(() => ""); throw new Error(`Agôn a répondu ${r.status}: ${body}`); }

      upsertSentToAgonItem({ subject: subjectTitle, sessionLabel, question, positionA, positionB, theme, resume, sources, links: Array.isArray(links) ? links : [], storySelection, keywords: resolvedKeywords, politicalOrientation, arenaMode, sentAt: new Date().toISOString() });
      console.log(`[auto-publish] ✓ Envoyé : "${subjectTitle.slice(0, 60)}"`);
      sentCount++;
    } catch (err) {
      console.error(`[auto-publish] ✗ Erreur sur "${subjectTitle.slice(0, 60)}" :`, err.message);
    }
  }

  console.log(`[auto-publish] Bilan envoi : ${sentCount}/${top10.length} sujet(s) envoyé(s) vers Agôn`);

  // Classer puis publier tous les sujets en attente
  await classifyAndPublishPending();

  try { const { uploadAll } = require("./storage-sync"); await uploadAll(); } catch {}
}

async function generateAndPostIdeas(debateId, question, positionA, positionB, adminHeaders) {
  if (!openai) { console.warn("[idées-ia] OPENAI_API_KEY absent"); return; }
  const isPositions = !!(positionA && positionB);
  const N = Math.floor(Math.random() * 3) + 7;

  const dateContext = buildCurrentDateContext();

  const styleInstructions = `
Consignes de style (OBLIGATOIRES) :
- RÈGLE ABSOLUE, valable pour TOUTES les idées sans exception : zéro ton d'IA. Interdits formels : "d'une part... d'autre part", "il est important de noter que", "en somme/en conclusion/pour conclure", "il convient de", "cela soulève la question de", toute phrase d'équilibrage qui valide les deux côtés à la fin, tout vocabulaire de dissertation scolaire. Personne n'écrit comme ça sur un réseau de débat. Chaque idée doit sonner comme un vrai message tapé par une vraie personne, avec ses tics propres.
- ${N - 4} idées doivent sembler écrites par des gens ordinaires, superficiels ou provocateurs : raisonnements approximatifs, raccourcis, opinions tranchées sans nuance, ton varié (agacés, naïfs, arrogants). Introduis des fautes d'orthographe et de frappe naturelles sur ces idées (ex: "sa" pour "ça", "j'ais", "voire" pour "voir", mots collés, etc.). Marque ces idées : "qualite": "mauvaise".
- 2 idées doivent être correctement écrites et plutôt sensées, mais sans plus : un avis simple, parfois un peu court ou pas totalement abouti, sans faute grossière mais pas littéraire non plus. Ça reste écrit à la manière de quelqu'un de normal, pas d'un assistant. Marque ces idées : "qualite": "moyenne".
- 2 idées doivent être bien écrites et bien raisonnées, sans fautes, mais TRANCHANTES : une position claire et affirmée, défendue avec un ou deux arguments concrets, pas un avis mou qui pèse le pour et le contre. Ça doit sonner comme une personne informée qui a un avis tranché et le dit cash, pas comme une copie bien sage. Varie le ton et la formulation d'une idée à l'autre (sec, mordant, énervé-mais-argumenté, froidement ironique...). Marque ces idées : "qualite": "bonne".`;

  const prompt = isPositions
    ? `Tu es un simulateur de commentaires citoyens sur un réseau de débat. Génère exactement ${N} idées pour alimenter ce débat.

${dateContext}

Question : ${question}
Camp A : ${positionA}
Camp B : ${positionB}

Répartis les idées : 4 pour le camp A et 3 pour le camp B (ou 3 pour A et 4 pour B, varie aléatoirement).
${styleInstructions}

Réponds en JSON : { "ideas": [ { "side": "A" ou "B", "qualite": "bonne" ou "moyenne" ou "mauvaise", "title": "...", "body": "..." }, ... ] }
- title : 1 phrase courte (max 120 caractères)
- body : longueur variable (mauvaises idées : 30-150 car. ; idées moyennes : 100-300 car. ; bonnes idées : 200-550 car.), peut être vide si l'idée se suffit`
    : `Tu es un simulateur de commentaires citoyens sur un réseau de débat. Génère exactement ${N} idées sur ce sujet.

${dateContext}

Sujet : ${question}
${styleInstructions}

Réponds en JSON : { "ideas": [ { "qualite": "bonne" ou "moyenne" ou "mauvaise", "title": "...", "body": "..." }, ... ] }
- title : 1 phrase courte (max 120 caractères)
- body : longueur variable (mauvaises idées : 30-150 car. ; idées moyennes : 100-300 car. ; bonnes idées : 200-550 car.), peut être vide`;

  let ideas;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 1.1,
      max_tokens: 2500
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    ideas = parsed.ideas;
    if (!Array.isArray(ideas) || !ideas.length) throw new Error("Format invalide");
  } catch (err) {
    console.error("[idées-ia] Erreur génération :", err.message);
    return;
  }

  console.log(`[idées-ia] ${ideas.length} idée(s) générée(s) pour débat ${debateId}`);

  for (let i = 0; i < ideas.length; i++) {
    const idea = ideas[i];
    const authorKey = Math.random().toString(36).slice(2, 14);
    try {
      const r = await fetch(`${AGON_URL}/api/arguments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          debate_id: debateId,
          side: isPositions ? (idea.side || "A") : (Math.random() < 0.5 ? "A" : "B"),
          title: String(idea.title || "").slice(0, 180),
          body: String(idea.body || "").slice(0, 2500),
          authorKey
        })
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.warn(`[idées-ia] Échec idée ${i + 1} :`, txt);
      } else {
        const { id: argId } = await r.json().catch(() => ({}));
        const isMauvaise = idea.qualite === "mauvaise";
        const votes = isMauvaise
          ? Math.floor(Math.random() * 26) + 5
          : Math.floor(Math.random() * 35) + 45;
        console.log(`[idées-ia] ✓ Idée ${i + 1}/${ideas.length} (${idea.qualite || "mauvaise"}, camp ${idea.side || "libre"}) → ${votes} voix`);
        if (argId && adminHeaders) {
          await fetch(`${AGON_URL}/api/admin/argument/${argId}/set-votes`, {
            method: "POST",
            headers: adminHeaders,
            body: JSON.stringify({ votes })
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn(`[idées-ia] Erreur idée ${i + 1} :`, err.message);
    }
    await new Promise(r => setTimeout(r, 7000));
  }
}

async function loginAgonAdmin(logLabel = "auto-publish") {
  const adminPassword = process.env.AGON_ADMIN_PASSWORD;
  if (!adminPassword) {
    console.log(`[${logLabel}] AGON_ADMIN_PASSWORD absent — classement/publication ignorés`);
    return null;
  }
  try {
    const loginRes = await fetch(`${AGON_URL}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPassword })
    });
    if (!loginRes.ok) { console.error(`[${logLabel}] Échec login admin Agôn`); return null; }
    const { token } = await loginRes.json();
    return { "Content-Type": "application/json", "x-admin-token": token };
  } catch (err) {
    console.error(`[${logLabel}] Erreur login Agôn :`, err.message);
    return null;
  }
}

// Reprend au démarrage les idées IA qui n'ont pas pu être générées (ex: redémarrage
// du serveur dans les 10 minutes suivant une publication, qui coupait le setTimeout
// en mémoire sans laisser de trace). Persisté dans pending-ideas.json.
function scheduleOnePendingIdea(item) {
  const delay = Math.max(0, new Date(item.runAt).getTime() - Date.now());
  setTimeout(async () => {
    const items = loadPendingIdeas();
    const match = items.find((i) => i.debateId === item.debateId && i.runAt === item.runAt && i.status === "pending");
    if (!match) return; // déjà traité (ex: par un autre process lors d'un chevauchement de déploiement)
    match.status = "done";
    savePendingIdeas(items);
    try {
      const adminHeaders = await loginAgonAdmin("idées-ia");
      await generateAndPostIdeas(match.debateId, match.question, match.positionA, match.positionB, adminHeaders);
    } catch (err) {
      console.error("[idées-ia] Erreur reprise idée :", err.message);
    }
  }, delay);
}

function persistAndScheduleIdeas(entries, delayMs) {
  const runAt = new Date(Date.now() + delayMs).toISOString();
  const items = loadPendingIdeas();
  for (const entry of entries) {
    const item = { ...entry, runAt, status: "pending" };
    items.push(item);
    scheduleOnePendingIdea(item);
  }
  savePendingIdeas(items);
}

function resumePendingIdeasOnStartup() {
  const items = loadPendingIdeas();
  const pending = items.filter((i) => i.status === "pending");
  if (pending.length) {
    console.log(`[idées-ia] Reprise de ${pending.length} idée(s) en attente après redémarrage`);
    pending.forEach(scheduleOnePendingIdea);
  }
}

async function classifyAndPublishPending() {
  const adminHeaders = await loginAgonAdmin();
  if (!adminHeaders) return;

  // Récupérer les sujets en attente
  let pending;
  try {
    const pendingRes = await fetch(`${AGON_URL}/api/admin/veille`, { headers: adminHeaders });
    if (!pendingRes.ok) { console.error("[auto-publish] Échec chargement sujets en attente"); return; }
    pending = await pendingRes.json();
  } catch (err) {
    console.error("[auto-publish] Erreur chargement pending :", err.message);
    return;
  }

  function countSources(item) {
    const names = new Set();
    (item.links || []).forEach(l => { const s = String(l.source || "").trim().toLowerCase(); if (s) names.add(s); });
    if (!names.size) String(item.sources || "").split(/[,;\n]+/).forEach(s => { const n = s.trim().toLowerCase(); if (n) names.add(n); });
    return names.size;
  }

  // Filtrer (exclure les fusionnés) et classer par sources croissantes
  const publishable = (pending || [])
    .filter(p => !p.linkedDebateId && Array.isArray(p.links) && p.links.length > 0)
    .sort((a, b) => countSources(a) - countSources(b));

  if (!publishable.length) { console.log("[auto-publish] Aucun sujet en attente à publier"); return; }
  console.log(`[auto-publish] Classement + publication de ${publishable.length} sujet(s)...`);

  let publishedCount = 0;
  const pendingIdeas = [];
  for (const item of publishable) {
    try {
      // Tentative de fusion automatique
      let autoMergedDebateId = "";
      try {
        const simRes = await fetch(`${AGON_URL}/api/admin/veille/check-similar`, {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ question: item.question, positionA: item.positionA || "", positionB: item.positionB || "", resume: item.resume || "" })
        });
        if (simRes.ok) {
          const { similar } = await simRes.json().catch(() => ({}));
          const best = (similar || []).find(s => s.confirmed === true && s.score >= 0.82);
          if (best) {
            const mergeRes = await fetch(`${AGON_URL}/api/admin/veille/merge`, {
              method: "POST",
              headers: adminHeaders,
              body: JSON.stringify({ id: item.id, debateId: best.id, question: item.question, positionA: item.positionA || "", positionB: item.positionB || "", resume: item.resume || "", links: item.links || [] })
            });
            if (mergeRes.ok) {
              const mergeData = await mergeRes.json().catch(() => ({}));
              autoMergedDebateId = mergeData.debateId || "";
              console.log(`[auto-publish] ⟳ Fusion automatique avec arène ${best.id} (score ${best.score}) : "${String(item.question || "").slice(0, 50)}"`);
            } else {
              const mergeErr = await mergeRes.json().catch(() => ({}));
              console.log(`[auto-publish] Fusion ignorée pour "${String(item.question || "").slice(0, 50)}" : ${mergeErr.error || "incompatible"}`);
            }
          }
        }
      } catch (mergeErr) {
        console.warn("[auto-publish] Erreur vérification fusion :", mergeErr.message);
      }

      const r = await fetch(`${AGON_URL}/api/admin/veille/publish`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          id: item.id,
          question: item.question,
          positionA: item.positionA || "",
          positionB: item.positionB || "",
          theme: item.theme || "",
          resume: item.resume || "",
          links: item.links || [],
          keywords: item.keywords || [],
          linkedDebateId: autoMergedDebateId,
          forcePublishOnAlignmentWarning: false
        })
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.error(`[auto-publish] Échec publication "${String(item.question || "").slice(0, 60)}" : ${body}`);
      } else {
        const publishData = await r.json().catch(() => ({}));
        console.log(`[auto-publish] ✓ Publié : "${String(item.question || "").slice(0, 60)}"`);
        publishedCount++;
        if (publishData.debateId) {
          pendingIdeas.push({ debateId: publishData.debateId, question: item.question, positionA: item.positionA || "", positionB: item.positionB || "" });
        }
      }
    } catch (err) {
      console.error(`[auto-publish] Erreur publication :`, err.message);
    }
  }

  if (pendingIdeas.length) {
    console.log(`[auto-publish] Idées IA programmées dans 10 minutes pour ${pendingIdeas.length} arène(s)`);
    persistAndScheduleIdeas(pendingIdeas, 10 * 60 * 1000);
  }
  console.log(`[auto-publish] ${publishedCount}/${publishable.length} sujet(s) publiés sur Agôn`);

  if (publishedCount === 0) return;

  // Arène du jour : push notifications
  try {
    const pushRes = await fetch(`${AGON_URL}/api/admin/push/broadcast-daily`, {
      method: "POST",
      headers: adminHeaders
    });
    if (!pushRes.ok) {
      console.warn("[auto-publish] Échec push arène du jour :", pushRes.status);
    } else {
      const pushData = await pushRes.json().catch(() => ({}));
      const sent = (pushData.results || []).filter(r => r.status === "sent").length;
      console.log(`[auto-publish] Arène du jour : push envoyé à ${sent}/${pushData.total || "?"} abonné(s)`);
    }
  } catch (err) {
    console.warn("[auto-publish] Erreur push arène du jour :", err.message);
  }
}

// ==================== PUBLICATION AUTOMATIQUE SUR AGÔN ====================

app.post("/api/auto-publish/run", requireMixteAuth, async (req, res) => {
  res.json({ ok: true });
  runAutoPublishPipeline().catch(err => console.error("[auto-publish/run] Erreur :", err.message));
});

app.get("/api/auto-publish", (req, res) => {
  res.json(loadAutoPublishConfig());
});

app.post("/api/auto-publish", (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "Paramètres invalides" });
  }
  const config = { enabled };
  try {
    fs.writeFileSync(AUTO_PUBLISH_FILE, JSON.stringify(config, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================== FIN ROUTES CERTAMEN ====================

app.get("/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

storageSync.init();
storageSync.downloadAll().then(() => {
  const httpServer = app.listen(PORT, () => {
    console.log(`Serveur lancé sur le port ${PORT}`);
    scheduleAutoCollect(loadAutoCollectConfig());
    resumePendingIdeasOnStartup();
    storageSync.startPeriodicSync();
  });

  httpServer.on("error", (error) => {
    console.error("Erreur serveur bot veille :", error.message);
  });
});
