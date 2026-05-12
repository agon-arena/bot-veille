const express = require("express");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MIXTE_PASSWORD = process.env.MIXTE_PASSWORD || "";
const AGON_URL = (process.env.AGON_URL || "http://localhost:3001").trim();
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

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

function buildFallbackStoryTitle(subject, theme) {
  const topic = limitStoryText(subject || theme || "ce sujet", 70).replace(/[?!.]+$/g, "").trim();
  if (!topic) return "Quelle histoire politique est en train de se jouer ?";
  if (/peut|doit|faut|va|est|sont|reste|risque/i.test(topic)) {
    return limitStoryText(topic.endsWith("?") ? topic : `${topic} ?`, 90);
  }
  return limitStoryText(`Quel tournant se joue autour de ${topic} ?`, 90);
}

function buildFallbackStorySummary(subject, resume) {
  const base = String(resume || "").trim() || String(subject || "").trim();
  return limitStoryText(base || "Nouvel épisode à suivre.", 220);
}

function buildFallbackNarrativeContext(payload, storySuggestion) {
  const storySummary = String(
    storySuggestion?.matched_story_summary
      || storySuggestion?.new_story?.story_summary
      || payload.ai?.resume
      || ""
  ).trim();
  const previousEpisode = String(storySuggestion?.previous_episode_summary || "").trim();
  const latestEvent = String(payload.ai?.resume || payload.subject || "").trim();
  const opening = String(
    storySuggestion?.reason
      || "Le prochain mouvement des acteurs en présence dira si la tension retombe ou monte encore."
  ).trim();

  const historyLine = storySummary
    ? limitStoryText(storySummary, 180)
    : limitStoryText(`Le sujet met aux prises ${payload.sources?.slice(0, 2).join(" et ") || "plusieurs acteurs"} autour d'une tension encore mouvante.`, 180);
  const previousLine = previousEpisode
    ? limitStoryText(previousEpisode, 180)
    : "Épisode précédent : aucun épisode clairement établi n'était encore rattaché à cette histoire.";
  const latestLine = latestEvent
    ? limitStoryText(latestEvent, 800)
    : limitStoryText(String(payload.subject || "").trim(), 800);

  const parts = [
    `L’histoire jusqu’ici : ${historyLine}`,
    previousLine.startsWith("Épisode précédent :") ? previousLine : `Épisode précédent : ${previousLine}`,
    `Nouvel épisode : ${latestLine}`,
    `Ouverture : ${limitStoryText(opening, 140)}`
  ];
  return parts.join("\n");
}

async function generateNarrativeContext(payload, storySuggestion) {
  const fallback = buildFallbackNarrativeContext(payload, storySuggestion);

  if (!openai) {
    return fallback;
  }

  const storyUntilNow = String(
    storySuggestion?.matched_story_summary
      || storySuggestion?.new_story?.story_summary
      || ""
  ).trim();
  const previousEpisode = String(storySuggestion?.previous_episode_summary || "").trim();

  const prompt = `
Tu es un redacteur d'actualite narrative.

Ta mission :
Transformer une actualite en episode court d'une histoire suivie.

Objectif :
Rendre l'actualite palpitante mais serieuse. Le lecteur doit avoir l'impression de suivre une serie du reel : une histoire avance, un nouvel episode vient de tomber, et la suite donne envie d'etre suivie.

Important :
Que l'arene finale soit une arene libre ou une arene a positions, tu rediges toujours ce contexte sous la meme forme narrative.

Regle absolue :
Le suspense doit venir uniquement des faits, des tensions reelles, des rapports de force et des incertitudes verifiables.
Ne jamais inventer, exagerer, dramatiser artificiellement ou faire du putaclic.

L'histoire jusqu'ici :
${storyUntilNow || "Pas d'histoire anterieure clairement etablie."}

Episode precedent :
${previousEpisode || "Pas d'episode precedent confirme."}

Nouvel episode :
${JSON.stringify({
  subject: payload.subject || "",
  currentArenaTitle: payload.ai?.debateQuestion || "",
  rawResume: payload.ai?.resume || "",
  theme: payload.ai?.agonTheme || "",
  sources: payload.sources || [],
  contents: (payload.contents || []).slice(0, 8).map((item) => ({
    source: item.source,
    title: item.title,
    type: item.type,
    summary: item.summary || ""
  }))
}, null, 2)}

Reponds uniquement en texte brut, sans puces, sous cette structure exacte :
L’histoire jusqu’ici : ...
Épisode précédent : ...
Nouvel épisode : ...
Ouverture : ...

Consignes de redaction :
- "L’histoire jusqu’ici" : 2 lignes maximum. Resume l'histoire generale avec les acteurs principaux et la tension centrale.
- "Épisode précédent" : 2 lignes maximum. Resume tres brievement ce qui s'etait passe juste avant.
- "Nouvel épisode" : 800 caracteres maximum. Raconte le nouvel article comme la suite logique de l'histoire : contexte immediat, evenement, acteurs, tension, ce qui change.
- "Ouverture" : 1 phrase courte qui donne envie de connaitre la suite : ce qui peut basculer, ce qu'il faut surveiller, ou la prochaine question concrete.

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
- priorite au nouvel episode : les rappels doivent rester tres courts ;
- si une information manque, rester vague plutot que completer ;
- le bloc "Nouvel épisode" doit rester le morceau le plus developpe.
`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.35,
      max_output_tokens: 900
    });
    return String(response.output_text || "").trim() || fallback;
  } catch (error) {
    return fallback;
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
  const keywords = [...new Set(getStoryKeywords(text))].slice(0, 6);
  const storyTitle = buildFallbackStoryTitle(payload.subject, payload.ai?.agonTheme);
  const newStory = {
    story_title: storyTitle,
    story_summary: buildFallbackStorySummary(payload.subject, payload.ai?.resume),
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

  let bestStory = null;
  let bestScore = 0;
  const sourceKeywords = new Set(keywords);
  for (const story of stories) {
    const storyKeywords = new Set(getStoryKeywords([
      story.story_title,
      story.story_summary,
      ...(story.main_actors || []),
      story.central_tension,
      ...(story.keywords || [])
    ].filter(Boolean).join(" ")));
    const shared = [...sourceKeywords].filter((word) => storyKeywords.has(word)).length;
    const score = storyKeywords.size ? shared / Math.max(3, Math.min(storyKeywords.size, sourceKeywords.size || 1)) : 0;
    if (score > bestScore) {
      bestScore = score;
      bestStory = story;
    }
  }

  if (bestStory && bestScore >= 0.55) {
    return {
      story_decision: bestScore >= 0.8 ? "existing_story" : "uncertain",
      matched_story_id: bestStory.story_id,
      matched_story_title: bestStory.story_title,
      matched_story_summary: bestStory.story_summary || "",
      previous_episode_title: bestStory.latest_episode_title || "",
      previous_episode_summary: bestStory.latest_episode_summary || "",
      confidence: Number(bestScore.toFixed(2)),
      reason: bestScore >= 0.8
        ? "Les mots-clés forts et la tension centrale recoupent nettement une histoire active."
        : "Le sujet semble proche d'une histoire active, mais la continuité narrative reste à confirmer.",
      criteria: {
        main_actors_match: bestScore >= 0.55,
        central_tension_match: bestScore >= 0.55,
        temporal_continuity: bestScore >= 0.7,
        editorial_theme_match: true,
        strong_keywords_match: bestScore >= 0.55
      },
      new_story: newStory
    };
  }

  return {
    story_decision: "new_story",
    matched_story_id: null,
    matched_story_title: null,
    confidence: Number(bestScore.toFixed(2)),
    reason: "Aucune continuité narrative nette n'a été détectée avec les histoires existantes.",
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

async function loadAgonStories() {
  try {
    const response = await fetch(`${AGON_URL}/api/veille/stories`);
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data?.stories) ? data.stories : [];
  } catch (error) {
    return [];
  }
}

async function suggestStoryLink(payload) {
  const stories = await loadAgonStories();
  const compactStories = stories.slice(0, 80).map((story) => ({
    story_id: story.story_id,
    story_title: story.story_title,
    story_summary: story.story_summary,
    main_actors: Array.isArray(story.main_actors) ? story.main_actors.slice(0, 5) : [],
    central_tension: story.central_tension || "",
    keywords: Array.isArray(story.keywords) ? story.keywords.slice(0, 8) : [],
    latest_episode_title: story.latest_episode_title || "",
    latest_episode_summary: story.latest_episode_summary || "",
    updated_at: story.updated_at || ""
  }));

  const fallback = buildFallbackStorySuggestion(payload, compactStories);

  if (!openai) {
    return fallback;
  }

  const compactContents = (payload.contents || []).slice(0, 8).map((item) => ({
    source: item.source,
    type: item.type,
    orientation: item.orientation,
    title: item.title
  }));

  const prompt = `
Tu aides a rattacher une actualite a une histoire suivie dans un bot de veille.

Regle absolue :
- Le meme theme general ne suffit pas.
- Il faut une vraie continuite narrative : memes forces en presence, meme tension centrale, nouveau developpement.
- Si tu hesites, reponds "uncertain".

Actualite a classer :
${JSON.stringify({
  subject: payload.subject || "",
  debate_question: payload.ai?.debateQuestion || "",
  resume: payload.ai?.resume || "",
  agon_theme: payload.ai?.agonTheme || "",
  sources: payload.sources || [],
  positions: {
    positionA: payload.ai?.positionA || "",
    positionB: payload.ai?.positionB || ""
  },
  contents: compactContents
}, null, 2)}

Histoires existantes :
${JSON.stringify(compactStories, null, 2)}

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
    "story_title": "question large",
    "story_summary": "resume court",
    "main_actors": ["..."],
    "central_tension": "...",
    "keywords": ["..."],
    "status": "active"
  }
}

Contraintes :
- story_title doit toujours etre une question.
- Si aucune histoire ne correspond clairement, cree une nouvelle histoire.
- Si confidence >= 0.80 et correspondance nette : existing_story.
- Si confidence entre 0.60 et 0.79 : uncertain.
- Si confidence < 0.60 : new_story.
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
    return {
      story_decision: ["existing_story", "new_story", "uncertain"].includes(parsed.story_decision) ? parsed.story_decision : fallback.story_decision,
      matched_story_id: matchedStory ? matchedStory.story_id : null,
      matched_story_title: matchedStory ? matchedStory.story_title : null,
      matched_story_summary: matchedStory ? matchedStory.story_summary || "" : "",
      previous_episode_title: matchedStory ? matchedStory.latest_episode_title || "" : "",
      previous_episode_summary: matchedStory ? matchedStory.latest_episode_summary || "" : "",
      confidence: Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : fallback.confidence,
      reason: String(parsed.reason || fallback.reason || "").trim(),
      criteria: {
        main_actors_match: Boolean(parsed.criteria?.main_actors_match),
        central_tension_match: Boolean(parsed.criteria?.central_tension_match),
        temporal_continuity: Boolean(parsed.criteria?.temporal_continuity),
        editorial_theme_match: Boolean(parsed.criteria?.editorial_theme_match),
        strong_keywords_match: Boolean(parsed.criteria?.strong_keywords_match)
      },
      new_story: {
        story_title: buildFallbackStoryTitle(parsed.new_story?.story_title || payload.subject, payload.ai?.agonTheme),
        story_summary: buildFallbackStorySummary(payload.subject, parsed.new_story?.story_summary || payload.ai?.resume),
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
const VEILLE_HTML = path.join(__dirname, "veille.html");
const VEILLE_YOUTUBE_HTML = path.join(__dirname, "veille-youtube.html");

function sendMissingPage(res, title, message) {
  return res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <title>${title}</title>
    </head>
    <body style="font-family: system-ui; max-width: 800px; margin: 40px auto; padding: 0 16px;">
      <h1>${title}</h1>
      <p>${message}</p>
      <p>Attends quelques instants puis rafraîchis la page.</p>
      <p><a href="/">Retour</a></p>
    </body>
    </html>
  `);
}

app.get("/", (req, res) => {
  if (!fs.existsSync(VEILLE_HTML)) {
    return sendMissingPage(res, "Veille presse", "La veille n'a pas encore été générée.");
  }
  res.sendFile(VEILLE_HTML);
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
      debateQuestion: isLibreMode
        ? limitStoryText(req.body?.subject || data.debateQuestion || "", 100)
        : String(data.debateQuestion || "").trim(),
      positionA: isLibreMode ? "" : String(data.positionA || ""),
      positionB: isLibreMode ? "" : String(data.positionB || "")
    };
    const storySuggestion = await suggestStoryLink({
      ...req.body,
      ai: normalizedData
    });
    normalizedData.resume = await generateNarrativeContext({
      ...req.body,
      ai: normalizedData
    }, storySuggestion);
    res.json({
      ...normalizedData,
      storyLink: storySuggestion
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/sessions-mixte.json", requireMixteAuth, (req, res) => {
  const filePath = path.join(__dirname, "sessions-mixte.json");

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "sessions-mixte.json non généré" });
  }

  res.sendFile(filePath);
});

app.get("/saved", requireMixteAuth, (req, res) => {
  const savedFile = path.join(__dirname, "saved-subjects.json");
  let saved = [];
  if (fs.existsSync(savedFile)) {
    try { saved = JSON.parse(fs.readFileSync(savedFile, "utf8")); } catch {}
  }

  const AGON_THEMES = [
    "Politique, économie et relations internationales",
    "Société, éducation et justice",
    "Sciences, technologies et environnement",
    "Culture, modes et médias",
    "Santé, corps et bien-être",
    "Sport, loisirs et passions",
    "Vie personnelle et modes de vie"
  ];

  function esc(t) {
    return String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function buildAiScoreHtml(s) {
    if (!s.debateScore) return `<div class="ai-score pending"><div><span class="score-label">Potentiel débat</span><strong>—/10</strong></div></div>`;
    return `<div class="ai-score"><div><span class="score-label">Potentiel débat</span><strong>${esc(String(s.debateScore))}/10</strong></div><span class="controversy">${esc(s.controversyLevel || "")}</span></div>`;
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
      `<option value="${esc(theme)}"${theme === (s.agonTheme || AGON_THEMES[0]) ? " selected" : ""}>${esc(theme)}</option>`
    ).join("");
    const positionsHtml = score >= 7 && (s.positionA || s.positionB)
      ? `<div class="positions-box"><p><strong>Positions proposées pour une arène à positions :</strong></p>${s.positionA ? `<p><strong>A —</strong> <span class="editable" contenteditable="true" spellcheck="false">${esc(s.positionA)}</span></p>` : ""}${s.positionB ? `<p><strong>B —</strong> <span class="editable" contenteditable="true" spellcheck="false">${esc(s.positionB)}</span></p>` : ""}</div>`
      : "";
    return `<div class="ai-box">
      <p class="debate-question" contenteditable="true" spellcheck="false">${esc(s.debateQuestion)}</p>
      ${s.resume ? `<p class="resume">${esc(s.resume)}</p>` : ""}
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
    .sources { font-size: 0.8rem; color: #999; margin: 10px 0 6px; }
    .date { font-size: 0.78rem; color: #bbb; }
    .unsave-btn { margin-top: 12px; background: none; border: 1px solid #ddd; border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 0.85rem; cursor: pointer; color: #c0392b; }
    .unsave-btn:hover { background: #fdf0ee; border-color: #c0392b; }
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
    <a href="/">Presse seule</a>
    <a href="/youtube">YouTube seul</a>
    <a href="/mixte">Veille mixte</a>
    <a href="/mixte#saved">Sujets enregistrés</a>
    <a href="/admin">⚙ Admin</a>
  </div>
  <h1>Sujets enregistrés</h1>
  <p class="intro">${saved.length} sujet(s) enregistré(s) sur ${sessions.length} mise(s) à jour.</p>
  ${saved.length === 0 ? '<p class="empty">Aucun sujet enregistré pour le moment.</p>' : `
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
    });
  });

  function buildAiScoreHtml(ai) {
    return '<div class="ai-score">' +
      '<div><span class="score-label">Potentiel débat</span><strong>' + ai.debateScore + '/10</strong></div>' +
      '<span class="controversy">' + (ai.controversyLevel || "") + '</span>' +
      '</div>';
  }

  function buildAiBoxHtml(ai) {
    const score = Number(ai.debateScore) || 0;
    const optionsHtml = AGON_THEMES.map(theme =>
      '<option value="' + theme + '"' + (theme === (ai.agonTheme || AGON_THEMES[0]) ? ' selected' : '') + '>' + theme + '</option>'
    ).join('');
    const positionsHtml = score >= 7 && (ai.positionA || ai.positionB)
      ? '<div class="positions-box"><p><strong>Positions proposées pour une arène à positions :</strong></p>' +
        (ai.positionA ? '<p><strong>A —</strong> <span class="editable" contenteditable="true" spellcheck="false">' + ai.positionA + '</span></p>' : '') +
        (ai.positionB ? '<p><strong>B —</strong> <span class="editable" contenteditable="true" spellcheck="false">' + ai.positionB + '</span></p>' : '') +
        '</div>'
      : '';
    return '<div class="ai-box">' +
      '<p class="debate-question" contenteditable="true" spellcheck="false">' + (ai.debateQuestion || '') + '</p>' +
      (ai.resume ? '<p class="resume">' + ai.resume + '</p>' : '') +
      '<p class="agon-theme"><strong>Thématique Agôn proposée :</strong><select class="agon-select">' + optionsHtml + '</select></p>' +
      positionsHtml +
      '</div>';
  }

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
          agonTheme: ai.agonTheme,
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

app.post("/save-update", (req, res) => {
  const savedFile = path.join(__dirname, "saved-subjects.json");
  try {
    let saved = [];
    if (fs.existsSync(savedFile)) {
      saved = JSON.parse(fs.readFileSync(savedFile, "utf8"));
    }
    const { subject, ...updates } = req.body;
    const idx = saved.findIndex(s => s.subject === subject);
    if (idx !== -1) {
      saved[idx] = { ...saved[idx], ...updates };
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
    <a href="/">Presse seule</a>
    <a href="/youtube">YouTube seul</a>
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
    showToast(d.ok ? 'Médias presse sauvegardés ✓' : 'Erreur : ' + d.error);
    return !!d.ok;
  } catch (err) {
    showToast('Erreur : ' + err.message);
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
    showToast(d.ok ? 'Chaînes YouTube sauvegardées ✓' : 'Erreur : ' + d.error);
    return !!d.ok;
  } catch (err) {
    showToast('Erreur : ' + err.message);
    return false;
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
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
  try {
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
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
  try {
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/send-to-agon", requireMixteAuth, async (req, res) => {
  try {
    const { question, positionA, positionB, theme, resume, sources, links, storySelection } = req.body;
    if (!question) return res.status(400).json({ ok: false, error: "question manquante" });
    console.log(`[send-to-agon] Envoi vers ${AGON_URL}/api/veille/receive`);
    const r = await fetch(`${AGON_URL}/api/veille/receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, positionA, positionB, theme, resume, sources, links: links || [], storySelection: storySelection || null })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error(`[send-to-agon] Erreur ${r.status}: ${body}`);
      throw new Error(`Agôn a répondu ${r.status}: ${body}`);
    }
    console.log("[send-to-agon] Succès");
    res.json({ ok: true });
  } catch (err) {
    console.error("[send-to-agon] Exception:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
