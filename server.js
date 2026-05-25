require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");
const stringSimilarity = require("string-similarity");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MIXTE_PASSWORD = process.env.MIXTE_PASSWORD || "";
const AGON_URL = (process.env.AGON_URL || "http://localhost:3001").trim();
const SENT_TO_AGON_FILE = path.join(__dirname, "sent-to-agon.json");
const AGON_STORIES_FILE = process.env.AGON_STORIES_FILE
  || path.join(__dirname, "..", "SUPABASE copie 3", "data", "stories.json");
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const AGON_THEMES = [
  "Politique",
  "International",
  "Économie / emploi",
  "Société / éducation",
  "Sciences et technologie",
  "Climat - environnement",
  "Justice / faits divers",
  "Culture - tendances",
  "Médias - divertissements",
  "Sports - loisirs",
  "Santé - bien-être",
  "Vie personnelle et modes de vie",
  "Espace jeunes"
];

const AGON_THEME_ALIASES = {
  "Politique, économie et relations internationales": "Politique",
  "Société, éducation et justice": "Société / éducation",
  "Sciences, technologies et environnement": "Sciences et technologie",
  "Culture, modes et médias": "Culture - tendances",
  "Santé, corps et bien-être": "Santé - bien-être",
  "Sport, loisirs et passions": "Sports - loisirs",
  "Espace jeunes (collégiens - lycéens)": "Espace jeunes"
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
    throw new Error("Sujet ou question manquants pour l’historique Agôn.");
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

async function generateNarrativeContext(payload, storySuggestion) {
  const fallback = buildFallbackNarrativeContext(payload, storySuggestion);

  if (!openai) {
    return ensureNarrativeLength(fallback, payload, 600);
  }

  const prompt = `
Tu es un redacteur d'actualite narrative.

Ta mission :
Transformer une actualite en court article de contexte vivant et serieux.

Objectif :
Rendre l'actualite palpitante mais serieuse. Le lecteur doit sentir une tension reelle et avoir envie de suivre la suite, sans ton depeche et sans dramatisation artificielle.

Important :
Que l'arene finale soit une arene libre ou une arene a positions, tu rediges toujours ce contexte sous la meme forme narrative.
Au moment de cette generation, tu ne fais jamais de recapitulatif d'histoire, meme si une histoire associee existe. Tu te concentres uniquement sur l'actualite du jour.
${String(payload?.ai?.arenaMode || "").trim() === "positions" ? `Comme il s'agit d'une arene a positions, la penultieme ligne doit etre palpitante et tendue, sans point d'interrogation, puis la toute derniere ligne doit etre exactement ce titre, mot pour mot : ${payload.ai?.debateQuestion || ""}` : ""}

Regle absolue :
Le suspense doit venir uniquement des faits, des tensions reelles, des rapports de force et des incertitudes verifiables.
Ne jamais inventer, exagerer, dramatiser artificiellement ou faire du putaclic.

Nouvel episode :
${JSON.stringify({
  subject: payload.subject || "",
  currentArenaTitle: payload.ai?.debateQuestion || "",
  rawResume: payload.ai?.resume || "",
  theme: normalizeAgonTheme(payload.ai?.agonTheme),
  sources: payload.sources || [],
  contents: (payload.contents || []).slice(0, 8).map((item) => ({
    source: item.source,
    title: item.title,
    type: item.type,
    summary: item.summary || ""
  }))
}, null, 2)}

Reponds uniquement en texte brut, sans puces, sous cette structure exacte :
[un paragraphe principal tres coherent qui compare les sources et resume le sujet]
[une phrase de bascule courte]
${String(payload?.ai?.arenaMode || "").trim() === "positions" ? "[puis, sur sa propre ligne, le titre genere par IA exactement, mot pour mot]" : ""}

Consignes de redaction :
- N'ecris jamais "L’histoire jusqu’ici", "Épisode précédent", "Nouvel épisode" ni aucune autre etiquette equivalente.
- N'utilise jamais dans les paragraphes des formulations meta comme "aucune continuite narrative", "aucun episode rattache", "pas d'episode precedent confirme" ou tout autre commentaire de systeme.
- N'introduis aucun rappel d'histoire precedente.
- Tu dois d'abord comparer les sources entre elles, repérer ce qu'elles confirment en commun, puis faire ressortir la contradiction, la nuance ou la tension principale.
- Tu rediges un vrai article synthetique et coherent, pas une note de veille, pas une fiche de synthese et pas une juxtaposition de titres.
- N'ecris jamais des phrases comme "BFMTV met en avant...", "Franceinfo rapporte que...", "selon tel media..." ou toute enumeration de sources, sauf si la source elle-meme est indispensable a l'information.
- Fond les informations convergentes des sources dans une prose continue, naturelle et serree.
- Ne recopie pas les titres des articles tels quels : transforme-les en recit.
- Le coeur du texte est un seul paragraphe dense, clair et logique.
- Le contexte complet doit viser environ 600 caracteres, avec une marge raisonnable autour de cette taille.
- La phrase de bascule doit rester courte.
- Si le mode est "arene libre", cette derniere phrase peut prendre la forme d'une question breve et tendue.
- Si le mode est "arene a positions", la phrase de bascule doit rester sans question, puis la toute derniere ligne doit etre exactement le titre genere par IA, mot pour mot.
- Interdiction d'utiliser des tournures molles ou mecaniques comme "La suite se jouera maintenant...", "Tout se joue desormais..." ou "Le prochain mouvement dira si..."

Contraintes :
- tu ne rediges pas le titre ici, seulement le contexte ;
- le texte doit etre vivant, nerveux, clair, serieux ;
- ne jamais inventer d'information ;
- ne pas annoncer de catastrophe non etayee ;
- ne pas ecrire comme une depeche froide ;
- ne pas employer un ton complotiste ;
- eviter les formules vagues du type "affaire a suivre" ;
- utiliser des verbes d'action ;
- distinguer les faits confirmes des hypotheses ;
- priorite absolue a l'actualite du jour ;
- si une information manque, rester vague plutot que completer ;
- fais sentir le sujet et son enjeu, mais sans gonfler artificiellement le ton ;
- la phrase finale doit etre plus memorisable que generique ;
- n'ecris jamais les mots "Ouverture", "Épisode précédent", "Nouvel épisode" ou "L’histoire jusqu’ici" dans le texte final.
- si le mode est "arene a positions", la penultieme ligne ne doit jamais etre une vraie question ;
- si le mode est "arene a positions", termine toujours par le titre-question, exactement ;
`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.35,
      max_output_tokens: 1500
    });
    const tail = String(response.output_text || "").trim();
    if (!tail) return ensureNarrativeLength(fallback, payload, 600);
    const enrichedTail = ensureNarrativeLength(tail, payload, 600);
    const polishedTail = await polishNarrativeForm(enrichedTail, payload);
    const finalTail = ensureNarrativeLength(polishedTail || enrichedTail, payload, 600);
    return sanitizeNarrativeText(finalTail, { payload });
  } catch (error) {
    return ensureNarrativeLength(fallback, payload, 600);
  }
}

async function polishNarrativeForm(baseText, payload) {
  const draft = String(baseText || "").trim();
  if (!draft) return draft;
  if (!openai) return draft;

  const isPositionsArena = String(payload?.ai?.arenaMode || "").trim() === "positions";
  const debateQuestion = String(payload?.ai?.debateQuestion || "").trim();

  const prompt = `
Tu es un redacteur charge uniquement d'ameliorer la forme d'un article deja ecrit.

Mission :
- garder strictement le meme fond ;
- ne rien inventer ;
- ne rien retirer d'important ;
- rendre le texte plus fluide, plus naturel, plus vivant et plus elegant ;
- conserver un article court et coherent ;
- conserver une longueur finale d'au moins 600 caracteres si le texte de depart les atteint deja.

Interdictions absolues :
- ne pas ajouter d'information nouvelle ;
- ne pas transformer le texte en note ou en liste ;
- ne pas ajouter "selon tel media", "X met en avant", ou toute couture de veille ;
- ne pas ajouter de recapitulatif d'histoire ;
- ne pas finir par une question si la phrase de bascule ne doit pas en etre une.

${isPositionsArena ? `Comme il s'agit d'une arene a positions, l'avant-derniere ligne doit rester non interrogative, puis la derniere ligne doit etre exactement : ${debateQuestion}` : ""}

Texte a retravailler :
${draft}

Reecris uniquement le texte final en texte brut.`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 1200
    });
    return String(response.output_text || "").trim() || draft;
  } catch (error) {
    return draft;
  }
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
    ? `L’histoire jusqu’ici : ${injectedHistoryLine}`
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
      lower.startsWith("jusqu’ici, aucun") ||
      lower.startsWith("aucune histoire associee") ||
      lower.startsWith("aucune histoire associée") ||
      lower.startsWith("aucun article precedent") ||
      lower.startsWith("aucun article précédent") ||
      lower.startsWith("pas d'episode precedent") ||
      lower.startsWith("pas d’épisode précédent")
    ) {
      return;
    }

    if (lower.startsWith("l’histoire jusqu’ici :") || lower.startsWith("l'histoire jusqu'ici :")) {
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
      return lower.startsWith("l’histoire jusqu’ici :") || lower.startsWith("l'histoire jusqu'ici :");
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
    parts.push(`L’histoire jusqu’ici : ${historyLine}`);
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

async function generateCompleteNarrativeContext(payload, storySelection) {
  function cleanSummarySourceTitle(title) {
    return String(title || "")
      .replace(/\s*[•|-]\s*[A-Z0-9À-Ÿ'’ ]{2,}$/g, "")
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

  // Priorité à la diversité des sources : 1 article par source en premier, puis compléter
  const selectedContents = (() => {
    const seenSources = new Set();
    const picked = [];
    const rest = [];
    for (const item of allContents) {
      const key = item.source || item.url;
      if (!seenSources.has(key)) { seenSources.add(key); picked.push(item); }
      else { rest.push(item); }
    }
    return [...picked, ...rest].slice(0, 6);
  })();

  if (!selectedContents.length) {
    throw new Error("Aucune source sélectionnée pour générer le compte rendu.");
  }

  if (!openai) {
    throw new Error("OPENAI_API_KEY manquant pour générer le résumé.");
  }

  const prompt = `Tu es un assistant éditorial pour Agôn.

Ta mission : à partir des sources fournies, rédiger un résumé factuel, sobre et neutre du sujet.

Important :
Ce résumé sert uniquement à comprendre les faits. Il ne doit contenir aucune analyse éditoriale, aucune opinion, aucune question de débat et aucune comparaison entre médias.

Règles :
- Utilise au maximum 3 sources.
- Ne rien inventer.
- Ne pas extrapoler.
- Ne pas dramatiser.
- Ne pas employer un ton polémique.
- Ne pas poser de question.
- Ne pas analyser les différences de traitement médiatique.
- Expliquer simplement :
  1. de quoi parle le sujet ;
  2. qui est concerné ;
  3. ce qui s'est passé ;
  4. pourquoi le sujet est repris ou discuté.
- Ne pas écrire "les médias" en général si seulement quelques sources sont utilisées.
- Si une information est incertaine ou absente des sources, ne pas l'ajouter.

Sortie attendue :
Texte brut uniquement, sans titre, sans signature, sans liste.

Longueur :
600 à 1000 caractères.

Sujet :
${payload.subject || ""}

Sources sélectionnées :
${JSON.stringify({
  contents: selectedContents.slice(0, 3).map((item) => ({
    title: item.title,
    type: item.type,
    date: item.date,
    summary: item.summary || ""
  }))
}, null, 2)}`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.35,
      max_output_tokens: 900
    });
    const text = String(response.output_text || "").trim();
    if (!text) throw new Error("Réponse vide de l'IA pour le résumé.");
    return limitStoryText(text, 1500);
  } catch (error) {
    throw new Error(error.message || "Erreur génération résumé");
  }
}

async function generateMediaAnalysis(payload) {
  const summary = String(payload?.summary || "").trim();
  const subject = String(payload?.subject || "").trim();
  const contents = Array.isArray(payload?.contents) ? payload.contents : [];

  if (!summary) {
    throw new Error("Résumé manquant pour l'analyse médiatique.");
  }

  if (!openai) {
    return { hasMediaContrast: false, mediaTreatment: "" };
  }

  const allSourcesList = contents.map(c => ({
    source: c.source,
    orientation: c.orientation || "généraliste",
    title: c.title,
    type: c.type,
    summary: c.summary || ""
  }));

  const prompt = `Tu es un assistant d'analyse médiatique pour Agôn.

Tu reçois :
1. un résumé factuel brut du sujet ;
2. toutes les sources utilisées, pas uniquement les 3 sources du résumé factuel.

Ta mission :
Analyser uniquement le traitement médiatique du sujet dans toutes les sources retenues, seulement s'il existe une différence significative entre les sources.

Tu ne dois pas rédiger l'article final.
Tu ne dois pas créer de question de débat.
Tu ne dois pas créer de positions.
Tu ne dois pas reformuler tout le résumé.
Tu ne dois pas ajouter de faits nouveaux.

Objectif :
Déterminer si les sources traitent le sujet de manière réellement différente.

Règle prioritaire :
Tu dois seulement signaler une différence de traitement médiatique si elle est réelle, significative et directement visible dans les sources.

Si la différence est faible, minime, vague, incertaine ou forcée, tu dois considérer qu'il n'y a pas de contraste médiatique significatif.

Attention :
Ne confonds jamais les divergences entre acteurs de l'actualité avec une différence de traitement médiatique.

Exemples :
- Si une source cite l'optimisme d'un responsable politique et une autre cite les réserves d'un autre acteur, ce n'est pas forcément une différence de traitement médiatique.
- Si plusieurs sources rapportent des positions différentes d'acteurs concernés, cela peut simplement refléter la complexité du sujet.
- Il y a contraste médiatique seulement si les sources cadrent réellement le sujet différemment : angle principal différent, vocabulaire nettement différent, hiérarchisation différente, insistance différente ou lecture éditoriale différente.

Champ "hasMediaContrast" :
- true uniquement s'il existe une vraie différence significative de cadrage, d'angle, d'insistance, de vocabulaire ou de hiérarchisation entre les sources.
- false dans tous les autres cas.

Champ "mediaTreatment" :
- Si hasMediaContrast = true : expliquer brièvement la différence observée.
- Si hasMediaContrast = false : écrire une chaîne vide "".

Règles :
- Compare les angles choisis par les sources.
- Compare les mots employés, si cela est visible.
- Compare ce que chaque source met en avant ou laisse au second plan.
- Ne pas inventer de différence de traitement.
- Ne pas supposer une orientation politique si elle n'est pas explicitement visible.
- Ne jamais écrire "les médias de gauche" ou "les médias de droite" sauf si les sources fournies permettent clairement de l'établir.
- Ne pas écrire "certains médias" ou "d'autres médias" de manière vague.
- Si les sources racontent globalement la même chose, considérer qu'il n'y a pas de contraste médiatique significatif.
- Si seulement une source est exploitable, considérer qu'il n'y a pas de contraste médiatique significatif.
- Si mediaTreatment est produit, il doit être précis, concret et directement exploitable dans l'article final.

JSON attendu uniquement :
{
  "hasMediaContrast": true/false,
  "mediaTreatment": "..."
}

Sujet : ${subject}

Résumé factuel :
${summary}

Sources disponibles :
${JSON.stringify(allSourcesList, null, 2)}

Réponds UNIQUEMENT en JSON valide, sans balises markdown.`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    temperature: 0.2,
    max_output_tokens: 600
  });

  let parsed = {};
  try {
    parsed = safeJsonParse(response.output_text || "");
  } catch (error) {
    parsed = { hasMediaContrast: false, mediaTreatment: "" };
  }

  const hasMediaContrast = parsed.hasMediaContrast === true;
  return {
    hasMediaContrast,
    mediaTreatment: hasMediaContrast ? String(parsed.mediaTreatment || "").trim() : ""
  };
}

async function generateProblematique(payload) {
  const summary = String(payload?.summary || "").trim();
  const subject = String(payload?.subject || "").trim();
  const hasMediaContrast = payload?.hasMediaContrast === true;
  const mediaTreatment = String(payload?.mediaTreatment || "").trim();

  if (!summary) {
    throw new Error("Résumé manquant pour générer la problématique.");
  }

  if (!openai) {
    return {
      debateAngle: limitStoryText(subject, 180),
      debateQuestion: limitStoryText(subject, 99),
      positionA: "Pour",
      positionB: "Contre"
    };
  }

  const mediaSection = hasMediaContrast && mediaTreatment
    ? `\nAnalyse du traitement médiatique :\n${mediaTreatment}`
    : "";

  const prompt = `Tu es un assistant éditorial pour Agôn.

Tu reçois :
1. un résumé factuel brut du sujet ;
2. éventuellement l'analyse du traitement médiatique.

Ta mission :
Transformer le sujet d'actualité en débat clair, compréhensible et clivant pour Agôn.

Tu ne dois pas rédiger l'article final.
Tu ne dois pas réécrire le résumé factuel.
Tu ne dois pas ajouter de faits nouveaux.
Tu dois uniquement produire :
1. un angle de débat ;
2. une question claire ;
3. deux positions opposées.

Objectif :
Faire comprendre immédiatement le sujet de l'actualité et ce qui peut diviser les lecteurs.

Règles :
- Identifier l'enjeu de débat contenu dans l'actualité.
- La problématique doit venir des faits, pas d'un enjeu inventé.
- Ne pas forcer une polémique si le sujet ne s'y prête pas.
- La question doit rendre clair ce qui peut diviser les lecteurs.
- La question doit permettre de comprendre le sujet de l'actualité sans lire l'article.
- Les deux positions doivent répondre directement à la question.
- Les deux positions doivent être équilibrées : ne pas rendre un camp ridicule ou évident.
- Si une analyse du traitement médiatique existe, elle peut aider à formuler l'angle, mais elle ne doit pas remplacer les faits.

Champ "debateAngle" :
- Résumer en une phrase l'enjeu central du débat.
- Maximum 180 caractères, espaces compris.
- Ne pas poser une question ici.

Champ "debateQuestion" :
- Une seule question claire, directe et clivante.
- Maximum 99 caractères, espaces compris. Ne jamais dépasser 99 caractères, sans exception.
- La question doit permettre de comprendre le sujet de l'actualité sans lire l'article.
- Elle doit contenir l'objet précis du débat : mesure, décision, événement, acteur ou problème concerné.
- Elle doit partir du sujet réel.
- Elle ne doit pas ajouter d'enjeu absent du résumé.
- Éviter les questions trop vagues comme "faut-il s'inquiéter ?", "est-ce une bonne chose ?" ou "qui a raison ?".
- Préférer une formulation concrète : "Faut-il…", "Doit-on…", "La France doit-elle…", "Cette mesure peut-elle…".

Champ "positionA" et "positionB" :
- Deux positions opposées.
- Maximum 80 caractères chacune, espaces compris.
- Formulations courtes, nettes et débattables.
- Ne pas utiliser "car", "parce que" ou de justification longue.
- Les positions doivent répondre directement à la question.
- Les positions doivent être compréhensibles seules.
- Les positions doivent rester liées au sujet précis de l'actualité.

JSON attendu uniquement :
{
  "debateAngle": "...",
  "debateQuestion": "...",
  "positionA": "...",
  "positionB": "..."
}

Sujet : ${subject}

Résumé factuel :
${summary}
${mediaSection}

Réponds UNIQUEMENT en JSON valide, sans balises markdown.`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    temperature: 0.3,
    max_output_tokens: 600
  });

  let parsed = {};
  try {
    parsed = safeJsonParse(response.output_text || "");
  } catch (error) {
    parsed = {};
  }

  return {
    debateAngle: limitStoryText(parsed.debateAngle || subject, 180),
    debateQuestion: limitStoryText(parsed.debateQuestion || subject, 99),
    positionA: limitStoryText(parsed.positionA || "Pour", 80),
    positionB: limitStoryText(parsed.positionB || "Contre", 80)
  };
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

  if (!summary) {
    throw new Error("Résumé manquant pour générer l'article final.");
  }

  if (!openai) {
    return {
      article: limitStoryText(summary, 1600),
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
      mediaTreatment: hasMediaContrast ? mediaTreatment : ""
    },
    elementsDebat: {
      debateAngle,
      debateQuestion,
      positionA,
      positionB
    }
  }, null, 2);

  const prompt = `Tu es éditeur pour Agôn.

Tu reçois :
1. un résumé factuel brut du sujet ;
2. l'analyse du traitement médiatique, contenant :
   - hasMediaContrast ;
   - mediaTreatment ;
3. les éléments de débat Agôn, contenant :
   - debateAngle ;
   - debateQuestion ;
   - positionA ;
   - positionB.

Ta mission :
Rédiger l'article final affiché dans Agôn.

Règles absolues :
- Ne rien inventer.
- Ne pas ajouter de fait absent du résumé factuel.
- Ne pas extrapoler.
- Ne pas dramatiser.
- Ne pas écrire de titre.
- Ne pas ajouter de signature.
- Le résumé factuel doit rester prioritaire.
- L'article doit se terminer par debateQuestion.
- debateQuestion doit être la toute dernière phrase du champ "article".
- debateQuestion doit apparaître une seule fois dans l'article.
- Aucune autre question ne doit apparaître dans l'article.
- Recopier debateQuestion strictement à l'identique dans la dernière phrase de l'article.
- La phrase précédente doit être affirmative et préparer naturellement debateQuestion.
- Ne pas coller la question brutalement à la fin.
- Si hasMediaContrast = false, ne pas évoquer les médias ni le traitement médiatique.
- Si hasMediaContrast = true, intégrer brièvement mediaTreatment, sans dépasser 30 % de l'article.
- Même si hasMediaContrast = true, ne pas écrire de paragraphe général sur "le traitement médiatique".
- Ne mentionner le traitement médiatique que si mediaTreatment contient une différence précise, concrète et directement exploitable.
- Ne jamais écrire "les médias de gauche", "les médias de droite" ou "les médias généralistes" si cela n'est pas explicitement présent dans mediaTreatment.
- Ne pas confondre divergence entre acteurs politiques, économiques, sociaux ou diplomatiques et différence de traitement entre médias.

Références aux articles :
- Tu peux faire référence aux articles ou aux sources lorsqu'elles apportent une précision utile.
- Les références doivent rester sobres et intégrées naturellement au texte.
- Tu peux écrire par exemple : "selon les articles analysés", "plusieurs sources rappellent que", "les articles consultés soulignent que".
- Ne pas multiplier ces formules.
- Ne pas transformer l'article en revue de presse.
- Ne pas citer longuement les sources.
- Ne pas écrire "les médias disent" de manière vague.
- Ne pas utiliser les références aux articles pour créer artificiellement un traitement médiatique différent.

Structure obligatoire de l'article :
1. Un chapeau d'introduction de 2 phrases courtes maximum.
2. Un saut de ligne.
3. Deux ou trois paragraphes développés.
4. Chaque paragraphe doit être séparé par une ligne vide.
5. Le dernier paragraphe doit conduire naturellement à debateQuestion.
6. Après le dernier paragraphe, ajouter une ligne vide.
7. La dernière ligne de l'article doit être exactement debateQuestion, seule sur sa ligne.

Contenu attendu :
- Le chapeau doit accrocher le lecteur sans exagérer. Maximum 2 phrases courtes.
- Il doit présenter rapidement le sujet, les acteurs concernés et l'enjeu principal.
- Les paragraphes doivent expliquer clairement les faits, le contexte immédiat et pourquoi le sujet est repris.
- Si une différence significative de traitement médiatique existe, l'évoquer sobrement dans le dernier paragraphe.
- Si la différence de traitement médiatique est absente, minime, vague ou incertaine, ne rien écrire à ce sujet.
- La fin de l'article doit créer une transition logique entre les faits, les enjeux et debateQuestion.
- La phrase juste avant debateQuestion doit être affirmative, pas interrogative.
- debateQuestion doit apparaître seule, séparée du reste par une ligne vide.

Style :
- Clair.
- Fluide.
- Sobre.
- Accessible.
- Captivant sans être sensationnaliste.
- Ton éditorial, mais neutre.
- Formulations vivantes, avec des phrases qui donnent envie de lire.
- Légère touche d'ironie ou d'humour possible, seulement si le sujet s'y prête.
- L'humour doit rester fin, discret et jamais moqueur envers les personnes concernées.
- Aucun humour sur les drames, accidents, violences, décès, maladies ou situations de détresse.
- Pas d'effet dramatique artificiel.
- Pas de vocabulaire alarmiste si les faits ne le justifient pas.
- Éviter les tournures plates comme "ce sujet fait débat" ou "cette affaire suscite des réactions", sauf si elles sont vraiment nécessaires.

Longueur :
900 à 1600 caractères.

JSON attendu uniquement :
{
  "article": "...",
  "debateQuestion": "...",
  "positionA": "...",
  "positionB": "..."
}

Règle finale :
- Recopier debateQuestion, positionA et positionB strictement à l'identique depuis les éléments de débat Agôn.
- Dans le champ "article", debateQuestion doit aussi apparaître strictement à l'identique en dernière phrase.

JSON à traiter :
${inputJson}

Réponds UNIQUEMENT en JSON valide, sans balises markdown.`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
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

  return {
    article: limitStoryText(parsed.article || summary, 1600),
    debateQuestion: String(parsed.debateQuestion || debateQuestion).trim(),
    positionA: String(parsed.positionA || positionA).trim(),
    positionB: String(parsed.positionB || positionB).trim()
  };
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
    const clean = req.path;
    return res.redirect(clean);
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
            await fetch('/refresh', { method: 'POST' });
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

app.get("/youtube", (req, res) => {
  if (!fs.existsSync(VEILLE_YOUTUBE_HTML)) {
    return sendMissingPage(res, "Veille YouTube", "La veille YouTube n'a pas encore été générée.");
  }
  res.sendFile(VEILLE_YOUTUBE_HTML);
});

app.get("/mixte", requireMixteAuth, (req, res) => {
  if (!fs.existsSync(VEILLE_MIXTE_HTML)) {
    return sendMissingPage(res, "Veille mixte", "La veille mixte n'a pas encore été générée.");
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
    await fetch("http://127.0.0.1:3002/refresh", { method: "POST" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.post("/generate-problematique", requireMixteAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await generateProblematique(payload);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur génération problématique" });
  }
});

app.post("/generate-styled-article", requireMixteAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await generateStyledArticle(payload);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Erreur génération article définitif" });
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

  function esc(t) {
    return String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function buildAiScoreHtml(s) {
    if (!s.debateScore) return `<div class="ai-score pending"><div><span class="score-label">Potentiel débat</span><strong>—/10</strong></div></div>`;
    return `<div class="ai-score"><div><span class="score-label">Potentiel débat</span><strong>${esc(String(s.debateScore))}/10</strong></div><span class="controversy">${esc(s.controversyLevel || "")}</span></div>`;
  }

  function buildKeywordsHtml(s) {
    const rawKeywords = Array.isArray(s.keywords) ? s.keywords.filter(Boolean) : [];
    const mainKeyword = String(s.mainKeyword || rawKeywords[0] || "").trim();
    const keywords = rawKeywords.filter(keyword => keyword && keyword !== mainKeyword);
    return `<div class="news-keywords"><div class="news-keywords-label">Mots-clés relevés</div>${mainKeyword ? `<span class="news-keyword-chip main-keyword-chip">${esc(mainKeyword)}</span>` : ""}${keywords.map((keyword) => `<span class="news-keyword-chip">${esc(keyword)}</span>`).join("")}</div>`;
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
    return `
    <section class="subject" data-index="${i}" data-subject-title="${esc(s.subject)}" data-score="${s.debateScore || 0}">
      <button class="arena-select-btn" type="button" aria-pressed="false">Sélectionner</button>
      ${buildAiScoreHtml(s)}
      <h3>${esc(s.subject)}</h3>
      ${buildAiBoxHtml(s)}
      <p class="sources">${esc(s.sources)}</p>
      ${contentsHtml}
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
    const keywords = rawKeywords.filter(function(keyword) { return keyword && keyword !== mainKeyword; });
    return '<div class="news-keywords"><div class="news-keywords-label">Mots-clés relevés</div>' +
      (mainKeyword ? '<span class="news-keyword-chip main-keyword-chip">' + escapeHtmlClient(mainKeyword) + '</span>' : '') +
      keywords.map(function(keyword) {
        return '<span class="news-keyword-chip">' + escapeHtmlClient(keyword) + '</span>';
      }).join('') +
      '</div>';
  }

  function renderKeywordsInEditor(subjectEl, keywords, mainKeyword) {
    const keywordsWrap = subjectEl && subjectEl.querySelector('.news-keywords');
    if (!keywordsWrap) return;
    const label = keywordsWrap.querySelector('.news-keywords-label');
    keywordsWrap.innerHTML = '';
    if (label) keywordsWrap.appendChild(label);
    const normalizedMainKeyword = String(mainKeyword || (Array.isArray(keywords) ? keywords[0] : '') || '').trim();
    if (normalizedMainKeyword) {
      const chip = document.createElement('span');
      chip.className = 'news-keyword-chip main-keyword-chip';
      chip.dataset.mainKeyword = normalizedMainKeyword;
      chip.textContent = normalizedMainKeyword;
      keywordsWrap.appendChild(chip);
    }
    (Array.isArray(keywords) ? keywords : []).filter(Boolean).filter(function(keyword) { return keyword !== normalizedMainKeyword; }).slice(0, 10).forEach(function(keyword) {
      const chip = document.createElement('span');
      chip.className = 'news-keyword-chip';
      chip.textContent = keyword;
      keywordsWrap.appendChild(chip);
    });
  }

  function getKeywordsFromEditor(subjectEl) {
    return Array.from((subjectEl && subjectEl.querySelectorAll('.news-keyword-chip')) || [])
      .map(function(chip) { return chip.textContent.trim(); })
      .filter(function(keyword) { return keyword && keyword !== getMainKeywordFromEditor(subjectEl); })
      .filter(Boolean);
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
      const keywords = Array.isArray(data.keywords) ? data.keywords : [];
      renderKeywordsInEditor(subjectEl, keywords, data.mainKeyword || '');
      await fetch('/save-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: payload.subject, mainKeyword: getMainKeywordFromEditor(subjectEl), keywords: getKeywordsFromEditor(subjectEl) })
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
          ${item.sources ? `<span>${esc(item.sources)}</span>` : ""}
          ${item.sessionLabel ? `<span>${esc(item.sessionLabel)}</span>` : ""}
        </div>
        ${Array.isArray(item.keywords) && item.keywords.length ? `<div class="sent-keywords">${item.keywords.map((keyword) => `<span class="chip">${esc(keyword)}</span>`).join("")}</div>` : ""}
        ${links.length ? `<details class="sent-links"><summary>Sources envoyées (${links.length})</summary><ul>${links.map((link) => `<li><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.title || link.url)}</a>${link.source ? ` — ${esc(link.source)}` : ""}</li>`).join("")}</ul></details>` : ""}
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
    .sent-links summary { cursor: pointer; font-weight: 700; color: #1f2937; }
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
  </div>

  <!-- Onglet Presse -->
  <div id="tab-presse" class="tab-panel active">
    <ul class="source-list" id="list-presse"></ul>
    <details id="form-presse-wrap">
      <summary style="cursor:pointer;font-weight:600;color:#0645ad;margin-bottom:12px;">+ Ajouter un média presse</summary>
      <div class="add-form">
        <h3 id="form-presse-title">Nouveau média</h3>
        <div class="form-grid">
          <div><label>Nom</label><input id="p-nom" placeholder="Le Monde"></div>
          <div><label>Orientation</label><input id="p-orientation" placeholder="centre-gauche / généraliste"></div>
        </div>
        <div style="margin-bottom:14px"><label>URL RSS</label><input id="p-rss" placeholder="https://..."></div>
        <div class="form-actions">
          <button class="btn btn-primary" onclick="submitPresse()">Enregistrer</button>
          <button class="btn btn-secondary" onclick="cancelPresse()">Annuler</button>
        </div>
      </div>
    </details>
  </div>

  <!-- Onglet YouTube -->
  <div id="tab-youtube" class="tab-panel">
    <ul class="source-list" id="list-youtube"></ul>
    <details id="form-youtube-wrap">
      <summary style="cursor:pointer;font-weight:600;color:#c0392b;margin-bottom:12px;">+ Ajouter une chaîne YouTube</summary>
      <div class="add-form">
        <h3 id="form-youtube-title">Nouvelle chaîne</h3>
        <div class="form-grid">
          <div><label>Nom</label><input id="y-nom" placeholder="Blast"></div>
          <div><label>Orientation</label><input id="y-orientation" placeholder="gauche / critique sociale"></div>
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
    </details>
  </div>

  <div class="toast" id="toast"></div>

<script>
let medias = [];
let chaines = [];
let editingPresse = null;
let editingYoutube = null;
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
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', (i === 0 && name === 'presse') || (i === 1 && name === 'youtube'));
  });
  document.getElementById('tab-presse').classList.toggle('active', name === 'presse');
  document.getElementById('tab-youtube').classList.toggle('active', name === 'youtube');
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
  ['p-nom', 'p-orientation', 'p-rss', 'y-nom', 'y-orientation', 'y-url', 'y-rss'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.addEventListener('input', markUnsavedFormChanges);
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
      <div class="source-actions">
        <button class="btn btn-edit" onclick="editPresse(\${i})">Modifier</button>
        <button class="btn btn-del" onclick="deletePresse(\${i})">Supprimer</button>
      </div>
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
      <div class="source-actions">
        <button class="btn btn-edit" onclick="editYoutube(\${i})">Modifier</button>
        <button class="btn btn-del" onclick="deleteYoutube(\${i})">Supprimer</button>
      </div>
    </li>\`;
  });
  ul.innerHTML = html;
}

function editPresse(i) {
  editingPresse = i;
  const m = medias[i];
  document.getElementById('p-nom').value = m.nom;
  document.getElementById('p-orientation').value = m.orientation;
  document.getElementById('p-rss').value = m.rss;
  document.getElementById('form-presse-title').textContent = 'Modifier le média';
  document.getElementById('form-presse-wrap').open = true;
  document.getElementById('form-presse-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelPresse() {
  editingPresse = null;
  document.getElementById('p-nom').value = '';
  document.getElementById('p-orientation').value = '';
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
  document.getElementById('y-orientation').value = c.orientation;
  document.getElementById('y-url').value = c.url;
  document.getElementById('y-rss').value = c.rss;
  document.getElementById('form-youtube-title').textContent = 'Modifier la chaîne';
  document.getElementById('form-youtube-wrap').open = true;
  document.getElementById('form-youtube-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelYoutube() {
  editingYoutube = null;
  document.getElementById('y-nom').value = '';
  document.getElementById('y-orientation').value = '';
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
        error: data.error || "Erreur chargement articles de l’histoire"
      });
    }
    res.json({
      ok: true,
      story: data.story || null,
      debates: Array.isArray(data.debates) ? data.debates : []
    });
  } catch (err) {
    res.status(500).json({ ok: false, debates: [], error: err.message || "Erreur chargement articles de l’histoire" });
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

app.post("/send-to-agon", requireMixteAuth, async (req, res) => {
  try {
    const { subject, sessionLabel, question, positionA, positionB, theme, resume, sources, links, storySelection, keywords } = req.body;
    if (!question) return res.status(400).json({ ok: false, error: "question manquante" });
    console.log(`[send-to-agon] Envoi vers ${AGON_URL}/api/veille/receive`);
    const agonController = new AbortController();
    const agonTimeout = setTimeout(() => agonController.abort(), 15000);
    let r;
    try {
      r = await fetch(`${AGON_URL}/api/veille/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, positionA, positionB, theme, resume, sources, links: links || [], storySelection: storySelection || null, keywords: Array.isArray(keywords) ? keywords : [] }),
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
      question,
      positionA,
      positionB,
      theme,
      resume,
      sources,
      links: Array.isArray(links) ? links : [],
      storySelection: storySelection || null,
      keywords: Array.isArray(keywords) ? keywords : [],
      sentAt: new Date().toISOString()
    });
    console.log("[send-to-agon] Succès");
    res.json({ ok: true });
  } catch (err) {
    console.error("[send-to-agon] Exception:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const httpServer = app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});

httpServer.on("error", (error) => {
  console.error("Erreur serveur bot veille :", error.message);
});
