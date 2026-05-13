require("dotenv").config();

const express = require("express");
const fs = require("fs");
const Parser = require("rss-parser");
const stringSimilarity = require("string-similarity");
const dayjs = require("dayjs");
const OpenAI = require("openai");

const apiApp = express();
apiApp.use(express.json({ limit: "2mb" }));

const parser = new Parser();

const MEDIA_FILE = "medias.json";
const CHANNELS_FILE = "youtube-chaines.json";

const OUTPUT_JSON = "veille-mixte.json";
const OUTPUT_HTML = "veille-mixte.html";
const HISTORY_FILE = "sessions-mixte.json";
const SAVED_FILE = "saved-subjects.json";
const API_PORT = 3002;

const HOURS_BACK_ARTICLES = 24;
const HOURS_BACK_YOUTUBE = 168;

const SIMILARITY_THRESHOLD = 0.42;
const MIN_SHARED_KEYWORDS = 1;
const MIN_DISTINCT_SOURCES = 2;

const UPDATE_INTERVAL_MINUTES = 720;
const MAX_SESSIONS_TO_KEEP = 12;
const MAX_SUBJECTS_TO_ANALYZE_WITH_AI = 25;
const FEED_TIMEOUT_MS = 15000;
const DEFAULT_FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Accept": "application/rss+xml, application/xml, text/xml, application/atom+xml, text/html;q=0.9, */*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache"
};

const AGON_THEMES = [
  "Politique, économie et relations internationales",
  "Société, éducation et justice",
  "Sciences, technologies et environnement",
  "Culture, modes et médias",
  "Santé, corps et bien-être",
  "Sport, loisirs et passions",
  "Vie personnelle et modes de vie"
];

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} a dépassé ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

async function fetchTextWithTimeout(url, options, label, timeoutMs = FEED_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${label} a répondu ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`${label} a dépassé ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseFeedWithTimeout(url, label, timeoutMs = FEED_TIMEOUT_MS) {
  return withTimeout(parser.parseURL(url), timeoutMs, label);
}

function parseFeedTextWithTimeout(feedText, label, timeoutMs = FEED_TIMEOUT_MS) {
  return withTimeout(parser.parseString(feedText), timeoutMs, label);
}

function looksLikeXmlFeed(text) {
  const value = String(text || "").trimStart();
  if (!value) return false;
  return value.startsWith("<?xml") || value.startsWith("<rss") || value.startsWith("<feed");
}

async function fetchFeedWithFallback(url, label, timeoutMs = FEED_TIMEOUT_MS) {
  try {
    return await parseFeedWithTimeout(url, label, timeoutMs);
  } catch (initialError) {
    const feedText = await fetchTextWithTimeout(url, {
      headers: DEFAULT_FETCH_HEADERS
    }, label, timeoutMs);

    if (!looksLikeXmlFeed(feedText)) {
      throw new Error(`${label} ne renvoie pas un flux XML exploitable`);
    }

    try {
      return await parseFeedTextWithTimeout(feedText, label, timeoutMs);
    } catch (parseError) {
      throw new Error(`${label} n'a pas pu être analysé (${parseError.message || initialError.message})`);
    }
  }
}

function cleanText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getKeywords(text) {
  const stopWords = new Set([
    "avec", "dans", "pour", "sur", "aux", "des", "les", "une", "est", "sont",
    "qui", "que", "quoi", "dont", "plus", "mais", "par", "pas", "son", "ses",
    "ces", "cet", "cette", "leurs", "leur", "apres", "avant", "entre", "chez",
    "comme", "face", "contre", "vers", "depuis", "selon", "fait", "faire",
    "ete", "etre", "avoir", "tout", "tous", "toute", "toutes", "nouveau",
    "nouvelle", "nouvelles", "direct", "video", "videos", "youtube", "short",
    "shorts", "replay", "live", "emission", "debat", "analyse", "actualite",
    "actualites", "france", "monde", "politique", "international", "economie",
    "societe", "sport", "culture", "invite", "invites", "interview"
  ]);

  return cleanText(text)
    .split(" ")
    .filter(word => word.length >= 4)
    .filter(word => !stopWords.has(word));
}

function countSharedKeywords(textA, textB) {
  const wordsA = new Set(getKeywords(textA));
  const wordsB = new Set(getKeywords(textB));

  let count = 0;

  for (const word of wordsA) {
    if (wordsB.has(word)) {
      count++;
    }
  }

  return count;
}

function getItemDate(item) {
  const rawDate = item.isoDate || item.pubDate || item.date;
  const parsed = dayjs(rawDate);

  if (parsed.isValid()) {
    return parsed;
  }

  return dayjs();
}

function isRecent(date, hoursBack) {
  return date.isAfter(dayjs().subtract(hoursBack, "hour"));
}

function getLastSessionCutoff() {
  const sessions = loadSessions();
  if (!Array.isArray(sessions) || !sessions.length) {
    return null;
  }

  const lastGeneratedAt = sessions[0] && sessions[0].generatedAt;
  if (!lastGeneratedAt) {
    return null;
  }

  const parsed = dayjs(lastGeneratedAt);
  return parsed.isValid() ? parsed : null;
}

function isFreshSinceLastSession(date, lastSessionCutoff) {
  if (!lastSessionCutoff) {
    return true;
  }

  return date.isAfter(lastSessionCutoff);
}

function loadSessions() {
  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch (error) {
    console.error("Erreur de lecture de l'historique mixte :", error.message);
    return [];
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(sessions, null, 2), "utf8");
}

function loadSavedSubjects() {
  if (!fs.existsSync(SAVED_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SAVED_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSavedSubjects(items) {
  fs.writeFileSync(SAVED_FILE, JSON.stringify(items, null, 2), "utf8");
}

function upsertSavedSubject(payload) {
  const saved = loadSavedSubjects();
  const subject = String(payload?.subject || "").trim();
  if (!subject) {
    throw new Error("Sujet manquant");
  }

  const action = String(payload?.action || "save").trim();
  const existingIndex = saved.findIndex((item) => item.subject === subject);

  if (action === "unsave") {
    if (existingIndex !== -1) {
      saved.splice(existingIndex, 1);
      saveSavedSubjects(saved);
    }
    return { ok: true, saved: false };
  }

  const nextItem = {
    ...(existingIndex !== -1 ? saved[existingIndex] : {}),
    ...payload,
    subject
  };

  if (existingIndex !== -1) {
    saved[existingIndex] = nextItem;
  } else {
    saved.unshift(nextItem);
  }

  saveSavedSubjects(saved);
  return { ok: true, saved: true };
}

async function getRssUrlFromYouTubeChannel(channel) {
  if (channel.rss) {
    return channel.rss;
  }

  if (!channel.url) {
    throw new Error("Aucun champ rss ou url fourni");
  }

  const html = await fetchTextWithTimeout(channel.url, {
    headers: DEFAULT_FETCH_HEADERS
  }, `Lecture de la chaîne YouTube ${channel.nom || channel.url}`);

  const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([^"]+)"/);

  if (canonicalMatch && canonicalMatch[1]) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${canonicalMatch[1]}`;
  }

  const channelIdMatch = html.match(/"channelId":"(UC[^"]+)"/);

  if (channelIdMatch && channelIdMatch[1]) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelIdMatch[1]}`;
  }

  const externalIdMatch = html.match(/"externalId":"(UC[^"]+)"/);

  if (externalIdMatch && externalIdMatch[1]) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${externalIdMatch[1]}`;
  }

  throw new Error("Impossible de trouver le channel_id YouTube");
}

function persistYoutubeRssUrl(channelName, rssUrl) {
  if (!channelName || !rssUrl) return;
  try {
    const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    const index = channels.findIndex((item) => String(item.nom || "").trim() === String(channelName).trim());
    if (index === -1) return;
    if (channels[index].rss === rssUrl) return;
    channels[index].rss = rssUrl;
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), "utf8");
  } catch (error) {
    console.error(`Impossible de mettre à jour le flux YouTube pour ${channelName}:`, error.message);
  }
}

async function getWorkingYouTubeRssUrl(channel) {
  const attempts = [];
  if (channel.rss) {
    attempts.push({ kind: "stored", url: channel.rss });
  }

  if (channel.url) {
    try {
      const rebuilt = await getRssUrlFromYouTubeChannel({ ...channel, rss: "" });
      if (!attempts.some((item) => item.url === rebuilt)) {
        attempts.push({ kind: "rebuilt", url: rebuilt });
      }
    } catch (error) {
      if (!attempts.length) {
        throw error;
      }
    }
  }

  if (!attempts.length) {
    throw new Error("Aucun flux YouTube utilisable n'a pu être déterminé");
  }

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const feed = await fetchFeedWithFallback(attempt.url, `Flux YouTube ${channel.nom}`);
      if (attempt.kind === "rebuilt") {
        persistYoutubeRssUrl(channel.nom, attempt.url);
      }
      return { rssUrl: attempt.url, feed };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Impossible de lire le flux YouTube");
}

function extractYouTubeVideoId(link) {
  const value = String(link || "");
  const match = value.match(/[?&]v=([^&]+)/);

  if (match && match[1]) {
    return match[1];
  }

  return "";
}

async function collectArticles(lastSessionCutoff = null) {
  const medias = JSON.parse(fs.readFileSync(MEDIA_FILE, "utf8"));
  const contents = [];

  for (const media of medias) {
    try {
      console.log(`Article — lecture de ${media.nom}...`);

      const feed = await fetchFeedWithFallback(media.rss, `Flux RSS ${media.nom}`);

      for (const item of feed.items || []) {
        const date = getItemDate(item);

        if (!isRecent(date, HOURS_BACK_ARTICLES)) {
          continue;
        }

        if (!isFreshSinceLastSession(date, lastSessionCutoff)) {
          continue;
        }

        const title = item.title || "Sans titre";
        const summary = item.contentSnippet || item.content || item.summary || "";

        contents.push({
          type: "article",
          source: media.nom,
          orientation: media.orientation || "",
          title,
          link: item.link || "",
          date: date.toISOString(),
          summary,
          thumbnail: "",
          comparableText: cleanText(title)
        });
      }
    } catch (error) {
      console.error(`Erreur article avec ${media.nom}:`, error.message);
    }
  }

  return contents;
}

async function collectYouTubeVideos(lastSessionCutoff = null) {
  const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
  const contents = [];

  for (const channel of channels) {
    try {
      console.log(`YouTube — lecture de ${channel.nom}...`);

      const { feed } = await getWorkingYouTubeRssUrl(channel);

      for (const item of feed.items || []) {
        const date = getItemDate(item);

        if (!isRecent(date, HOURS_BACK_YOUTUBE)) {
          continue;
        }

        if (!isFreshSinceLastSession(date, lastSessionCutoff)) {
          continue;
        }

        const title = item.title || "Sans titre";
        const summary = item.contentSnippet || item.content || item.summary || "";
        const link = item.link || "";
        const videoId = extractYouTubeVideoId(link);

        contents.push({
          type: "youtube",
          source: channel.nom,
          orientation: channel.orientation || "",
          title,
          link,
          date: date.toISOString(),
          summary,
          thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
          comparableText: cleanText(title)
        });
      }
    } catch (error) {
      console.error(`Erreur YouTube avec ${channel.nom}:`, error.message);
    }
  }

  return contents;
}

function groupContentsBySubject(contents) {
  const groups = [];

  for (const content of contents) {
    let bestGroup = null;
    let bestScore = 0;

    for (const group of groups) {
      const score = stringSimilarity.compareTwoStrings(
        content.comparableText,
        group.referenceText
      );

      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    }

    const sharedKeywords = bestGroup
      ? countSharedKeywords(content.title, bestGroup.subject)
      : 0;

    if (
      bestGroup &&
      bestScore >= SIMILARITY_THRESHOLD &&
      sharedKeywords >= MIN_SHARED_KEYWORDS
    ) {
      bestGroup.contents.push(content);

      if (content.comparableText.length > bestGroup.referenceText.length) {
        bestGroup.referenceText = content.comparableText;
      }
    } else {
      groups.push({
        subject: content.title,
        referenceText: content.comparableText,
        contents: [content]
      });
    }
  }

  return groups;
}

function filterMultiSourceSubjects(groups) {
  return groups
    .map(group => {
      const sources = [...new Set(group.contents.map(content => content.source))];
      const articleCount = group.contents.filter(content => content.type === "article").length;
      const youtubeCount = group.contents.filter(content => content.type === "youtube").length;

      return {
        subject: group.subject,
        sources,
        sourceCount: sources.length,
        contentCount: group.contents.length,
        articleCount,
        youtubeCount,
        ai: null,
        contents: group.contents.sort((a, b) => {
          const order = { left: 0, center: 1, right: 2 };
          const oA = order[getOrientationGroup(a.orientation)] ?? 1;
          const oB = order[getOrientationGroup(b.orientation)] ?? 1;
          if (oA !== oB) return oA - oB;
          return new Date(b.date) - new Date(a.date);
        })
      };
    })
    .filter(group => group.sourceCount >= MIN_DISTINCT_SOURCES)
    .sort((a, b) => {
      const bHasBoth = b.articleCount > 0 && b.youtubeCount > 0 ? 1 : 0;
      const aHasBoth = a.articleCount > 0 && a.youtubeCount > 0 ? 1 : 0;

      if (bHasBoth !== aHasBoth) {
        return bHasBoth - aHasBoth;
      }

      if (b.sourceCount !== a.sourceCount) {
        return b.sourceCount - a.sourceCount;
      }

      return b.contentCount - a.contentCount;
    });
}

function fallbackAiAnalysis(subject, arenaMode = "positions") {
  const hasBoth = subject.articleCount > 0 && subject.youtubeCount > 0;
  const leftSourceCount = (subject.contents || []).filter(c => getOrientationGroup(c.orientation) === "left").length;
  const fallbackText = arenaMode === "libre"
    ? limitText(subject.subject, 100)
    : `Ce sujet mérite-t-il un débat public : ${subject.subject} ?`;
  return {
    arenaMode,
    debateScore: hasBoth ? 6 : 4,
    controversyLevel: hasBoth ? "moyen" : "faible",
    debateQuestion: fallbackText,
    resume: "",
    agonTheme: "Politique, économie et relations internationales",
    positionA: "",
    positionB: "",
    leftScore: Math.min(10, 3 + leftSourceCount * 2)
  };
}

function limitText(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1).trimEnd() + "…";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const match = String(text || "").match(/\{[\s\S]*\}/);

    if (match) {
      return JSON.parse(match[0]);
    }

    throw error;
  }
}

async function analyzeOneSubjectWithAI(subject) {
  if (!openai) {
    return fallbackAiAnalysis(subject, subject.arenaMode);
  }

  const compactContents = subject.contents.slice(0, 10).map(content => ({
    type: content.type,
    source: content.source,
    orientation: content.orientation,
    title: content.title
  }));

  const arenaMode = subject.arenaMode === "libre" ? "libre" : "positions";
  const prompt = `
Analyse ce sujet de veille et évalue son potentiel de débat public.

Mode d'arène demandé :
${arenaMode === "libre" ? "arène libre" : "arène à positions"}

Sujet principal :
${subject.subject}

Sources :
${subject.sources.join(", ")}

Contenus :
${JSON.stringify(compactContents, null, 2)}


Tu dois répondre uniquement en JSON valide avec ces champs :
{
  "debateScore": nombre entier de 0 à 10,
  "controversyLevel": "faible" | "moyen" | "fort" | "très fort",
  "debateQuestion": "si le mode demandé est arène à positions : une seule ligne de 100 caractères maximum, espaces compris. Elle doit résumer le sujet en quelques mots puis poser une question très clivante. Si le mode demandé est arène libre : une seule ligne de 100 caractères maximum, espaces compris, qui résume factuellement le sujet sans question.",
  "resume": "si debateScore >= 7 : matière factuelle brève pour écrire ensuite un contexte narratif d'actualité. Donne 2 ou 3 phrases maximum, concrètes, utiles, sans effet de style artificiel. Sinon : chaîne vide",
  "agonTheme": "une thématique Agôn exacte",
  "positionA": "position franche, très courte, sans argument. MAX 60 CARACTÈRES. Si debateScore < 7, chaîne vide.",
  "positionB": "position opposée franche, très courte, sans argument. MAX 60 CARACTÈRES. Si debateScore < 7, chaîne vide.",
  "leftScore": nombre entier de 0 à 10 indiquant l'intérêt du sujet pour un public de gauche progressiste
}

Critères pour leftScore :
- 8 à 10 : sujet central pour la gauche progressiste ;
- 5 à 7 : sujet d’intérêt général avec dimension sociale ou politique ;
- 0 à 4 : sujet peu pertinent pour ce public.

Critères pour debateScore :
- 0 à 3 : sujet informatif, peu clivant ;
- 4 à 6 : sujet débattable mais peu explosif ;
- 7 à 8 : sujet controversé, bon potentiel de débat ;
- 9 à 10 : sujet très clivant, fort potentiel de réactions.

Favorise les sujets politiques, sociaux, économiques, éducatifs, écologiques, internationaux ou liés aux libertés publiques.
Pénalise les faits divers non politiques, résultats sportifs, annonces culturelles neutres ou sujets purement descriptifs.

Pour le champ "agonTheme", choisis uniquement une valeur exacte dans cette liste :
${AGON_THEMES.map(theme => `- ${theme}`).join("\n")}

Ne crée jamais une autre thématique.

Pour "debateQuestion" :
- écris une seule ligne ;
- maximum 100 caractères, espaces compris ;
- ne mets pas les mots "Résumé" ou "Question".

Si le mode demandé est "arène à positions" :
- commence par un mini-résumé concret du sujet ;
- termine par une question très clivante ;
- évite les questions molles ou trop neutres ;
- la question doit opposer deux camps clairement ;
- varie fortement la forme des questions d’un sujet à l’autre ;
- n’utilise pas toujours "Faut-il..." ;
- alterne entre plusieurs formes : "Faut-il...", "Est-ce que...", "Peut-on...", "Doit-on...", "Qui doit...", "Jusqu’où...", "Encore...", "Trop...", "Vrai scandale ou...", "Mesure juste ou..." ;
- évite de répéter deux fois de suite la même structure de question.

Bons exemples en arène à positions :
- Macron coupe un discours au sommet Afrique-France : respect ou mépris ?
- Trump menace l’Iran, le pétrole grimpe : fermeté ou folie ?
- Fièvre après une croisière : faut-il isoler les contacts ?
- Le PS se déchire encore : qui peut encore y croire ?
- Pétrole en hausse : doit-on craindre une crise mondiale ?

Si le mode demandé est "arène libre" :
- résume factuellement le sujet ;
- n’écris aucune question ;
- n’oppose pas deux camps ;
- reste neutre et concret ;
- vise une phrase courte, claire, immédiatement compréhensible.

Bons exemples en arène libre :
- Macron interrompt un discours au sommet Afrique-France
- Trump relance les tensions avec l’Iran et fait grimper le pétrole
- Une fièvre après une croisière déclenche un suivi sanitaire

Pour "positionA" et "positionB" :
- si le mode demandé est "arène libre", renvoie "" pour les deux champs ;
- si debateScore < 7, renvoie "" pour les deux champs ;
- si le mode demandé est "arène à positions" et debateScore >= 7, propose deux camps opposés ;
- chaque position doit être une étiquette de camp, pas un argument ;
- aucune justification, aucune explication ;
- pas de "car", "parce que", "afin de", "pour éviter" ;
- maximum 60 caractères chacune ;
- positionA et positionB doivent pouvoir servir de noms de colonnes dans Agôn.

Bons exemples :
- Isolement obligatoire
- Liberté de circulation
- Fermeté assumée
- Provocation dangereuse
- Sanction immédiate
- Défense des libertés

Mauvais exemples :
- Isoler les contacts pour protéger la population
- Refuser l’isolement car il menace les libertés
- Il faut agir vite avant que la situation empire
`;


  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 600
    });

    const text = response.output_text;
    const parsed = safeJsonParse(text);

    const fallbackQuestion = arenaMode === "libre"
      ? limitText(subject.subject, 100)
      : `Faut-il débattre de ce sujet : ${subject.subject} ?`;

    return {
      arenaMode,
      debateScore: Number.isInteger(parsed.debateScore) ? parsed.debateScore : 0,
      controversyLevel: parsed.controversyLevel || "faible",
      debateQuestion: arenaMode === "libre"
        ? limitText(subject.subject || String(parsed.debateQuestion || fallbackQuestion).replace(/\?+$/g, "").trim(), 100)
        : String(parsed.debateQuestion || fallbackQuestion).trim(),
      resume: parsed.resume || "",
      agonTheme: AGON_THEMES.includes(parsed.agonTheme)
        ? parsed.agonTheme
        : "Politique, économie et relations internationales",
      positionA: arenaMode === "positions" && parsed.debateScore >= 7 && typeof parsed.positionA === "string"
        ? parsed.positionA.trim()
        : "",
      positionB: arenaMode === "positions" && parsed.debateScore >= 7 && typeof parsed.positionB === "string"
        ? parsed.positionB.trim()
        : "",
      leftScore: Number.isInteger(parsed.leftScore) ? parsed.leftScore : 5
    };
  } catch (error) {
    console.error(`Erreur IA pour le sujet "${subject.subject}" :`, error.message);
    return fallbackAiAnalysis(subject, arenaMode);
  }
}

async function analyzeOneScoreWithAI(subject) {
  if (!openai) {
    const fb = fallbackAiAnalysis(subject);
    return { debateScore: fb.debateScore, controversyLevel: fb.controversyLevel, leftScore: fb.leftScore };
  }

  const compactContents = subject.contents.slice(0, 10).map(content => ({
    type: content.type,
    source: content.source,
    orientation: content.orientation,
    title: content.title
  }));

  const prompt = `
Analyse ce sujet de veille et évalue son potentiel.

Sujet principal :
${subject.subject}

Sources :
${subject.sources.join(", ")}

Contenus :
${JSON.stringify(compactContents, null, 2)}

Tu dois répondre uniquement en JSON valide avec ces champs :
{
  "debateScore": nombre entier de 0 à 10,
  "controversyLevel": "faible" | "moyen" | "fort" | "très fort",
  "leftScore": nombre entier de 0 à 10 indiquant l'intérêt du sujet pour un public de gauche progressiste
}

Critères pour debateScore :
- 0 à 3 : sujet informatif, peu clivant
- 4 à 6 : sujet débattable mais pas explosif
- 7 à 8 : sujet controversé, bon potentiel de débat
- 9 à 10 : sujet très clivant, fort potentiel de réactions
Favorise les sujets politiques, sociaux, économiques, éducatifs, écologiques, internationaux ou liés aux libertés publiques.
Pénalise les simples faits divers non politiques, résultats sportifs, annonces culturelles ou sujets purement descriptifs.

Critères pour leftScore (INDÉPENDANT du debateScore) :
- 8 à 10 : sujet central pour la gauche (droits sociaux, inégalités, écologie, services publics, droits des travailleur·ses, libertés publiques, lutte contre les discriminations, annonce de politique sociale, rapport sur les inégalités, actualité syndicale ou climatique)
- 5 à 7 : sujet d'intérêt général avec une dimension sociale ou politique pertinente
- 0 à 4 : sujet peu pertinent pour un public de gauche (fait divers apolitique, résultat sportif, annonce culturelle neutre)
`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 80
    });

    const parsed = safeJsonParse(response.output_text);
    return {
      debateScore: Number.isInteger(parsed.debateScore) ? parsed.debateScore : 0,
      controversyLevel: parsed.controversyLevel || "faible",
      leftScore: Number.isInteger(parsed.leftScore) ? parsed.leftScore : 5
    };
  } catch (error) {
    console.error(`Erreur IA (score) pour "${subject.subject}" :`, error.message);
    const fb = fallbackAiAnalysis(subject);
    return { debateScore: fb.debateScore, controversyLevel: fb.controversyLevel, leftScore: fb.leftScore };
  }
}

function buildAnalyzePayload(body) {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  const articleCount = Number.isFinite(Number(body?.articleCount))
    ? Number(body.articleCount)
    : contents.filter((item) => item.type === "article").length;
  const youtubeCount = Number.isFinite(Number(body?.youtubeCount))
    ? Number(body.youtubeCount)
    : contents.filter((item) => item.type === "youtube").length;
  const sources = Array.isArray(body?.sources)
    ? body.sources
    : [...new Set(contents.map((item) => item.source).filter(Boolean))];

  return {
    subject: String(body?.subject || "").trim(),
    sources,
    articleCount,
    youtubeCount,
    contents: contents.map((item) => ({
      type: item.type || "article",
      source: item.source || "",
      orientation: item.orientation || "",
      title: item.title || "",
      link: item.link || "",
      summary: item.summary || ""
    })),
    arenaMode: body?.arenaMode === "libre" ? "libre" : "positions"
  };
}

apiApp.post("/analyze", async (req, res) => {
  try {
    const payload = buildAnalyzePayload(req.body);
    if (!payload.subject) {
      return res.status(400).json({ error: "Sujet manquant" });
    }

    const ai = await analyzeOneSubjectWithAI(payload);
    res.json(ai);
  } catch (error) {
    res.status(500).json({ error: error.message || "Erreur analyse IA" });
  }
});

apiApp.post("/refresh", async (req, res) => {
  if (isRunning) {
    return res.json({ ok: true, running: true });
  }

  main().catch((error) => {
    console.error("Erreur refresh mixte :", error.message);
  });

  res.json({ ok: true, started: true });
});

apiApp.post("/save", (req, res) => {
  try {
    res.json(upsertSavedSubject(req.body || {}));
  } catch (error) {
    res.status(500).json({ error: error.message || "Erreur sauvegarde" });
  }
});

async function analyzeScoresWithAI(subjects) {
  console.log(`${subjects.length} sujet(s) envoyés à l'analyse de score IA.`);
  const results = [];

  for (const subject of subjects) {
    console.log(`Score IA : ${subject.subject}`);
    const score = await analyzeOneScoreWithAI(subject);
    results.push({
      ...subject,
      debateScore: score.debateScore,
      controversyLevel: score.controversyLevel,
      leftScore: score.leftScore,
      scoreAnalyzed: true,
      ai: null,
      aiAnalyzed: false
    });
  }

  return results.sort((a, b) => {
    if (b.debateScore !== a.debateScore) return b.debateScore - a.debateScore;
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    return b.contentCount - a.contentCount;
  });
}

async function analyzeSubjectsWithAI(subjects) {
  const subjectsToAnalyze = subjects.slice(0, MAX_SUBJECTS_TO_ANALYZE_WITH_AI);

  console.log(`${subjectsToAnalyze.length} sujet(s) envoyés à l'analyse IA.`);

  const analyzedSubjects = [];

  for (const subject of subjectsToAnalyze) {
    console.log(`Analyse IA : ${subject.subject}`);
    const ai = await analyzeOneSubjectWithAI(subject);

    analyzedSubjects.push({
      ...subject,
      ai,
      aiAnalyzed: true
    });
  }

  const remainingSubjects = subjects.slice(MAX_SUBJECTS_TO_ANALYZE_WITH_AI).map(subject => ({
    ...subject,
    ai: fallbackAiAnalysis(subject),
    aiAnalyzed: false
  }));

  return [...analyzedSubjects, ...remainingSubjects].sort((a, b) => {
    const scoreA = a.ai?.debateScore || 0;
    const scoreB = b.ai?.debateScore || 0;

    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }

    if (b.sourceCount !== a.sourceCount) {
      return b.sourceCount - a.sourceCount;
    }

    return b.contentCount - a.contentCount;
  });
}

function getOrientationGroup(orientation) {
  const o = (orientation || "").toLowerCase();
  if (o.includes("gauche")) return "left";
  if (o.includes("droite") || o.includes("conservateur") || o.includes("souverainiste")) return "right";
  return "center";
}

function selectPreselectedContents(contents, debateScore) {
  if (debateScore < 7) return new Set();

  const selected = new Set();

  const youtube = contents.find(c => c.type === "youtube");
  if (youtube) selected.add(youtube.link);

  const pressItems = contents.filter(c => c.type === "article");
  const leftItem = pressItems.find(c => getOrientationGroup(c.orientation) === "left");
  const rightItem = pressItems.find(c => getOrientationGroup(c.orientation) === "right");

  if (leftItem) selected.add(leftItem.link);
  if (rightItem) selected.add(rightItem.link);

  if (selected.size < 2) {
    for (const item of pressItems) {
      if (!selected.has(item.link)) {
        selected.add(item.link);
        if (selected.size >= (youtube ? 3 : 2)) break;
      }
    }
  }

  return selected;
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function generateHtml(sessions) {
  const generatedAt = dayjs().format("DD/MM/YYYY HH:mm:ss");

  const savedTitles = new Set(loadSavedSubjects().map(s => s.subject));

  const visibleTabCount = 6;

  const sessionTabs = sessions.map((session, index) => {
    const label = session.generatedAtLabel || `Session ${index + 1}`;
    const shortLabel = label
      .replace(" à ", " ")
      .replace(/:\d{2}$/, "");

    return `
      <button
        class="session-tab ${index === 0 ? "active" : ""} ${index >= visibleTabCount ? "older-tab hidden-tab" : ""}"
        type="button"
        data-session-index="${index}"
      >
        ${index === 0 ? "Dernière · " : ""}${escapeHtml(shortLabel)}
      </button>
    `;
  }).join("");

  const olderTabsButton = sessions.length > visibleTabCount
    ? `
      <button class="show-older-tabs" type="button">
        Voir les anciennes mises à jour
      </button>
    `
    : "";

  const sessionBlocks = sessions.map((session, index) => {
    const subjects = session.subjects || [];

    const subjectBlocks = subjects.map(subject => {
      const articles = subject.contents.filter(content => content.type === "article");
      const videos = subject.contents.filter(content => content.type === "youtube");
      const ai = subject.ai || {};
      const isAnalyzed = subject.aiAnalyzed === true;
      const scoreAnalyzed = subject.scoreAnalyzed === true;

      const debateScore = scoreAnalyzed ? (Number(subject.debateScore) || 0) : 0;
      const leftScore = scoreAnalyzed ? (Number(subject.leftScore) || 0) : 0;
      const isSaved = savedTitles.has(subject.subject);

      const articleItems = articles.map(article => {
        const date = dayjs(article.date).format("DD/MM/YYYY HH:mm");
        const orientationGroup = getOrientationGroup(article.orientation);
        const orientationTag = article.orientation
          ? `<span class="source-tag ${orientationGroup}">${escapeHtml(article.orientation)}</span>`
          : "";

        return `
          <li class="content-item" data-link="${escapeHtml(article.link)}" data-orientation="${escapeHtml(article.orientation)}" data-type="article">
            <label class="article-label">
              <input type="checkbox">
              <div>
                <strong>${escapeHtml(article.source)}</strong> ${orientationTag}
                <br>
                <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">
                  ${escapeHtml(article.title)}
                </a>
                <br>
                <small>Publié le ${escapeHtml(date)}</small>
              </div>
            </label>
          </li>
        `;
      }).join("");

      const videoItems = videos.map(video => {
        const date = dayjs(video.date).format("DD/MM/YYYY HH:mm");

        return `
          <li class="content-item video-item" data-link="${escapeHtml(video.link)}" data-type="youtube">
            <label class="article-label">
              <input type="checkbox">
              <div>
                ${
                  video.thumbnail
                    ? `<a href="${escapeHtml(video.link)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(video.thumbnail)}" alt="" class="thumb"></a>`
                    : ""
                }
                <strong>${escapeHtml(video.source)}</strong>
                <span class="source-tag youtube">YouTube</span>
                <br>
                <a href="${escapeHtml(video.link)}" target="_blank" rel="noopener noreferrer">
                  ${escapeHtml(video.title)}
                </a>
                <br>
                <small>Publié le ${escapeHtml(date)}</small>
              </div>
            </label>
          </li>
        `;
      }).join("");

      const subjectDataForBtn = escapeHtml(JSON.stringify({
        subject: subject.subject,
        sources: subject.sources,
        articleCount: subject.articleCount,
        youtubeCount: subject.youtubeCount,
        contents: subject.contents.slice(0, 10).map(c => ({
          type: c.type,
          source: c.source,
          orientation: c.orientation,
          title: c.title,
          link: c.link
        }))
      }));

      const aiScoreHtml = scoreAnalyzed
        ? `<div class="ai-score">
            <div>
              <span class="score-label">Potentiel débat</span>
              <strong>${escapeHtml(String(subject.debateScore))}/10</strong>
            </div>
            <span class="controversy">${escapeHtml(subject.controversyLevel)}</span>
          </div>`
        : `<div class="ai-score pending">
            <span class="score-label">Analyse IA non effectuée</span>
          </div>`;

      const aiBoxHtml = isAnalyzed
        ? `<div class="ai-box">
            <p class="debate-question" contenteditable="true" spellcheck="false">${escapeHtml(ai.debateQuestion)}</p>
            ${ai.resume ? `<p class="resume">${escapeHtml(ai.resume)}</p>` : ""}
            <p class="agon-theme"><strong>Thématique Agôn proposée :</strong>
              <select class="agon-select">
                ${AGON_THEMES.map(theme => `<option value="${escapeHtml(theme)}"${theme === (ai.agonTheme || AGON_THEMES[0]) ? " selected" : ""}>${escapeHtml(theme)}</option>`).join("")}
              </select>
            </p>
            ${
              debateScore >= 7 && (ai.positionA || ai.positionB) && ai.arenaMode !== "libre"
                ? `<div class="positions-box">
                    <p><strong>Positions proposées pour une arène à positions :</strong></p>
                    ${ai.positionA ? `<p><strong>A —</strong> <span class="editable" contenteditable="true" spellcheck="false">${escapeHtml(ai.positionA)}</span></p>` : ""}
                    ${ai.positionB ? `<p><strong>B —</strong> <span class="editable" contenteditable="true" spellcheck="false">${escapeHtml(ai.positionB)}</span></p>` : ""}
                  </div>`
                : ""
            }
          </div>`
        : `<div class="ai-box pending-analysis">
            <button class="analyze-btn" type="button" data-mode="positions" data-subject="${subjectDataForBtn}">
              Générer arène à positions IA
            </button>
            <button class="analyze-btn analyze-btn-secondary" type="button" data-mode="libre" data-subject="${subjectDataForBtn}">
              Générer arène libre IA
            </button>
          </div>`;

      return `
        <section class="subject" data-score="${debateScore}" data-sources="${subject.sourceCount}" data-left="${leftScore}">
          <div class="subject-number"></div>
          ${aiScoreHtml}

          <h3>${escapeHtml(subject.subject)}</h3>

          ${aiBoxHtml}

          <div class="subject-stats">
            <span>${subject.sourceCount} sources</span>
            <span>${subject.articleCount} article(s)</span>
            <span>${subject.youtubeCount} vidéo(s)</span>
          </div>

          <p class="sources">${escapeHtml(subject.sources.join(", "))}</p>

          <button class="save-btn${isSaved ? " saved" : ""}" type="button" data-subject-title="${escapeHtml(subject.subject)}">${isSaved ? "★ Enregistré" : "☆ Enregistrer"}</button>
          <button class="agon-btn" type="button" data-question="${escapeHtml(ai ? (ai.debateQuestion || subject.subject) : subject.subject)}" data-position-a="${escapeHtml(ai ? (ai.positionA || "") : "")}" data-position-b="${escapeHtml(ai ? (ai.positionB || "") : "")}" data-theme="${escapeHtml(ai ? (ai.agonTheme || "") : "")}" data-sources="${escapeHtml(subject.sources.join(", "))}">→ Agôn</button>

          ${
            articles.length
              ? `<h4>Presse</h4><ul>${articleItems}</ul>`
              : ""
          }

          ${
            videos.length
              ? `<h4>YouTube</h4><ul>${videoItems}</ul>`
              : ""
          }
        </section>
      `;
    }).join("");

    const isLatest = index === 0;

    return `
      <section
        class="session ${isLatest ? "latest active-session" : "hidden-session"}"
        data-session-index="${index}"
      >
        <div class="session-header">
          <div>
            <h2>${isLatest ? "Dernière mise à jour mixte" : "Mise à jour mixte précédente"}</h2>
            <p>Session du <strong>${escapeHtml(session.generatedAtLabel)}</strong></p>
          </div>
          <div class="session-stats">
            <strong>${subjects.length}</strong>
            <span>sujet(s) commun(s)</span>
          </div>
        </div>

        ${
          subjects.length
            ? subjectBlocks
            : `<div class="empty">Aucun sujet commun détecté pendant cette session.</div>`
        }
      </section>
    `;
  }).join("");

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Veille mixte presse + YouTube</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-width: 980px;
      margin: 40px auto;
      padding: 0 16px;
      line-height: 1.5;
      background: #f7f7f7;
      color: #111;
    }

    h1 {
      margin-bottom: 4px;
    }

    .intro {
      color: #555;
      margin-bottom: 24px;
    }

    .nav {
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .nav a {
      display: inline-block;
      padding: 8px 12px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 999px;
      text-decoration: none;
      color: #111;
    }

    .nav-refresh-btn {
      margin-left: auto;
      background: #111;
      color: white;
      border: none;
      border-radius: 999px;
      padding: 8px 14px;
      font: inherit;
      font-size: 0.9rem;
      cursor: pointer;
      display: none;
    }

    @media (max-width: 600px) {
      .nav-refresh-btn { display: inline-block; }
    }

    .status {
      background: #111;
      color: white;
      border-radius: 14px;
      padding: 14px 18px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }

    .refresh-btn {
      flex-shrink: 0;
      background: white;
      color: #111;
      border: none;
      border-radius: 999px;
      padding: 10px 18px;
      font: inherit;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }

    .refresh-btn:hover:not(:disabled) {
      background: #e8e8e8;
    }

    .refresh-btn:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .ptr-indicator {
      position: fixed; top: -60px; left: 50%; transform: translateX(-50%);
      background: #333; color: white; padding: 10px 20px; border-radius: 999px;
      font-size: 0.85rem; transition: top 0.25s ease; z-index: 200; white-space: nowrap;
      pointer-events: none;
    }
    .ptr-indicator.visible { top: 16px; }

    .update-banner {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      background: #2563eb; color: white; padding: 13px 26px; border-radius: 999px;
      font-size: 0.9rem; font-weight: 700; cursor: pointer; z-index: 200;
      box-shadow: 0 4px 20px rgba(0,0,0,0.22); display: none; white-space: nowrap;
      border: none; font-family: inherit;
    }
    .update-banner:hover { background: #1d4ed8; }

    .filter-bar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }

    .filter-btn {
      border: 1px solid #ddd;
      background: white;
      color: #111;
      border-radius: 999px;
      padding: 9px 16px;
      font: inherit;
      font-size: 0.95rem;
      cursor: pointer;
    }

    .filter-btn:hover {
      background: #eee;
    }

    .filter-btn.active {
      background: #111;
      color: white;
      border-color: #111;
      font-weight: 700;
    }

    .session-tabs-wrapper {
      background: white;
      border: 1px solid #ddd;
      border-radius: 14px;
      padding: 18px;
      margin-bottom: 24px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    }

    .session-tabs-wrapper h2 {
      margin: 0 0 4px;
      font-size: 1.2rem;
    }

    .session-tabs-wrapper p {
      margin: 0 0 14px;
      color: #555;
    }

    .session-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .session-tab {
      border: 1px solid #ddd;
      background: #f7f7f7;
      color: #111;
      border-radius: 999px;
      padding: 9px 13px;
      font: inherit;
      font-size: 0.95rem;
      cursor: pointer;
    }

    .session-tab:hover {
      background: #eee;
    }

    .session-tab.active {
      background: #111;
      color: white;
      border-color: #111;
      font-weight: 700;
    }

    .hidden-tab {
      display: none;
    }

    .show-older-tabs {
      margin-top: 12px;
      border: 1px solid #ddd;
      background: white;
      color: #111;
      border-radius: 999px;
      padding: 9px 13px;
      font: inherit;
      font-size: 0.95rem;
      cursor: pointer;
    }

    .show-older-tabs:hover {
      background: #eee;
    }

    .show-older-tabs.hidden {
      display: none;
    }

    .hidden-session {
      display: none;
    }

    .active-session {
      display: block;
    }

    .session {
      border-top: 4px solid #ccc;
      padding-top: 20px;
      margin-bottom: 44px;
    }

    .session.latest {
      border-top-color: #111;
    }

    .session-header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      background: white;
      border: 1px solid #ddd;
      border-radius: 14px;
      padding: 18px;
      margin-bottom: 18px;
    }

    .session-header h2 {
      margin: 0 0 4px;
    }

    .session-header p {
      margin: 0;
      color: #555;
    }

    .session-stats {
      min-width: 130px;
      text-align: center;
      border-left: 1px solid #ddd;
      padding-left: 16px;
    }

    .session-stats strong {
      display: block;
      font-size: 2rem;
    }

    .session-stats span {
      color: #555;
      font-size: 0.9rem;
    }

    .subject {
      background: white;
      border: 1px solid #ddd;
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    }

    .subject h3 {
      margin-top: 14px;
      font-size: 1.25rem;
    }

    .subject h4 {
      margin-bottom: 8px;
      border-top: 1px solid #eee;
      padding-top: 14px;
    }

    .ai-score {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      background: #111;
      color: white;
      border-radius: 12px;
      padding: 12px 14px;
    }

    .ai-score strong {
      display: block;
      font-size: 1.8rem;
    }

    .score-label {
      font-size: 0.85rem;
      color: #ddd;
    }

    .controversy {
      background: white;
      color: #111;
      border-radius: 999px;
      padding: 6px 10px;
      font-weight: 700;
      font-size: 0.9rem;
    }

    .ai-score.pending {
      background: #888;
      justify-content: flex-start;
    }

    .ai-box.pending-analysis {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      flex-wrap: wrap;
      min-height: 56px;
    }

    .analyze-btn {
      background: #111;
      color: white;
      border: none;
      border-radius: 999px;
      padding: 10px 20px;
      font: inherit;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
    }

    .analyze-btn:hover:not(:disabled) {
      background: #333;
    }

    .analyze-btn:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .analyze-btn-secondary {
      background: white;
      color: #111;
      border: 1px solid #ddd;
    }

    .analyze-btn-secondary:hover:not(:disabled) {
      background: #f0f0f0;
    }

    .story-link-box {
      margin-top: 12px;
      background: white;
      border: 1px solid #d8dee8;
      border-radius: 12px;
      padding: 12px;
    }

    .story-link-header {
      font-size: 0.82rem;
      font-weight: 700;
      color: #555;
      margin-bottom: 8px;
    }

    .story-link-status {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 7px 12px;
      border-radius: 999px;
      font-size: 0.84rem;
      font-weight: 700;
      margin-bottom: 10px;
    }

    .story-link-status.is-existing {
      background: #e8f7ee;
      color: #196a42;
    }

    .story-link-status.is-uncertain {
      background: #fff4e5;
      color: #9a5b00;
    }

    .story-link-status.is-new {
      background: #eef4ff;
      color: #2157a5;
    }

    .story-link-card {
      border: 1px solid #e6eaf0;
      border-radius: 10px;
      padding: 10px 12px;
      background: #fafbfd;
    }

    .story-link-card.selected {
      border-color: #b8cae8;
      background: #eef4ff;
    }

    .story-link-card p,
    .story-link-card small {
      display: block;
      margin: 6px 0 0;
      color: #555;
    }

    .story-choice-row {
      margin-top: 10px;
      font-size: 0.92rem;
    }

    .story-choice-row input {
      margin-right: 6px;
    }

    .story-draft-fields {
      margin-top: 10px;
      display: grid;
      gap: 8px;
    }

    .story-draft-fields label {
      font-size: 0.82rem;
      font-weight: 700;
      color: #555;
    }

    .story-draft-fields input,
    .story-draft-fields textarea {
      width: 100%;
      border: 1px solid #d7dbe2;
      border-radius: 10px;
      padding: 9px 10px;
      font: inherit;
      background: white;
    }

    .story-link-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px 0 12px;
      font-size: 0.9rem;
      font-weight: 600;
      color: #333;
    }

    .story-link-toggle input {
      width: 16px;
      height: 16px;
      margin: 0;
    }

    .story-link-disabled {
      opacity: 0.55;
    }

    .story-manual-picker {
      margin-top: 12px;
      border-top: 1px solid #e7ebf2;
      padding-top: 12px;
    }

    .story-manual-picker label {
      display: block;
      font-size: 0.82rem;
      font-weight: 700;
      color: #555;
      margin-bottom: 6px;
    }

    .story-manual-picker select,
    .story-manual-picker textarea {
      width: 100%;
      border: 1px solid #d7dbe2;
      border-radius: 10px;
      padding: 9px 10px;
      font: inherit;
      background: white;
    }

    .story-manual-summary {
      margin-top: 10px;
    }

    .story-manual-picker small {
      display: block;
      margin-top: 6px;
      color: #666;
    }

    .story-save-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 8px;
      flex-wrap: wrap;
    }

    .story-save-btn {
      border: 1px solid #d7dbe2;
      background: #f7f9fc;
      color: #223;
      border-radius: 999px;
      padding: 8px 12px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    .story-save-btn:hover {
      background: #eef3fb;
    }

    .story-save-feedback {
      font-size: 0.82rem;
      color: #196a42;
      font-weight: 600;
    }

    .episode-nav-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 10px;
      padding: 9px 12px;
      border-radius: 999px;
      border: 1px solid #d7dbe2;
      background: #fff;
      color: #223;
      font-size: 0.84rem;
      font-weight: 700;
      text-decoration: none;
    }

    .episode-nav-link:hover {
      background: #f5f8fd;
    }

    .hidden {
      display: none !important;
      color: #111;
    }

    .story-draft-fields textarea {
      resize: vertical;
      min-height: 84px;
    }

    .hidden {
      display: none !important;
    }

    .subject-number {
      font-size: 0.75rem;
      color: #aaa;
      font-weight: 600;
      margin-bottom: 6px;
    }

    .save-btn {
      background: none;
      border: 1px solid #ccc;
      border-radius: 999px;
      padding: 4px 12px;
      font: inherit;
      font-size: 0.82rem;
      cursor: pointer;
      color: #555;
      margin-top: 10px;
    }

    .save-btn:hover {
      border-color: #888;
      color: #111;
    }

    .save-btn.saved {
      background: #111;
      color: white;
      border-color: #111;
    }

    .agon-btn {
      background: none;
      border: 1px solid #c0392b;
      border-radius: 999px;
      padding: 4px 12px;
      font: inherit;
      font-size: 0.82rem;
      cursor: pointer;
      color: #c0392b;
      margin-top: 10px;
      margin-left: 6px;
    }

    .agon-btn:hover { background: #fdf0ee; }
    .agon-btn.sent { background: #c0392b; color: white; }

    .ai-box {
      background: #f5f5f5;
      border: 1px solid #e1e1e1;
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 14px;
    }

    .debate-question {
      font-size: 1.1rem;
      font-weight: 800;
      margin-top: 0;
      border-radius: 6px;
      padding: 4px 6px;
      margin-left: -6px;
      outline: none;
      transition: background 0.15s;
    }

    .debate-question:hover,
    .debate-question:focus {
      background: #e8e8e8;
    }

    .editable {
      border-radius: 4px;
      padding: 2px 4px;
      margin-left: -4px;
      outline: none;
      transition: background 0.15s;
    }

    .editable:hover,
    .editable:focus {
      background: #e8e8e8;
    }

    .agon-theme {
      margin: 4px 0 0;
      font-size: 0.95rem;
    }

    .agon-select {
      background: white;
      border: 1px solid #ddd;
      border-radius: 999px;
      padding: 5px 10px;
      color: #111;
      font-size: 0.95rem;
      cursor: pointer;
      outline: none;
    }

    .agon-select:hover,
    .agon-select:focus {
      border-color: #999;
    }

    .positions-box {
      margin-top: 12px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 12px;
      padding: 12px;
    }

    .positions-box p {
      margin: 6px 0;
    }

    .subject-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
    }

    .subject-stats span {
      background: #f1f1f1;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 0.9rem;
    }

    .sources {
      color: #555;
      font-size: 0.95rem;
    }

    ul {
      padding-left: 0;
    }

    .content-item {
      list-style: none;
      margin-bottom: 16px;
    }

    .content-item.preselected {
      background: #f0f7ff;
      border-left: 3px solid #0645ad;
      border-radius: 6px;
      padding: 6px 10px;
      margin-left: -13px;
    }

    .article-label {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      cursor: pointer;
    }

    .article-label input[type="checkbox"] {
      margin-top: 3px;
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      cursor: pointer;
    }

    .source-tag {
      display: inline-block;
      background: #f1f1f1;
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 0.78rem;
      color: #555;
      vertical-align: middle;
    }

    .source-tag.youtube {
      background: #ff0000;
      color: white;
    }

    .source-tag.left {
      background: #ffe8e8;
      color: #b30000;
    }

    .source-tag.center {
      background: #f1f1f1;
      color: #555;
    }

    .source-tag.right {
      background: #e8eeff;
      color: #003399;
    }

    .thumb {
      display: block;
      width: 160px;
      max-width: 35vw;
      border-radius: 6px;
      margin-bottom: 6px;
    }

    a {
      color: #0645ad;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .empty {
      background: white;
      border: 1px solid #ddd;
      border-radius: 14px;
      padding: 20px;
      color: #555;
    }

    @media (max-width: 700px) {
      body {
        margin: 20px auto;
      }

      .session-tabs {
        display: grid;
        grid-template-columns: 1fr;
      }

      .session-tab {
        width: 100%;
        text-align: left;
      }

      .session-header {
        display: block;
      }

      .session-stats {
        border-left: none;
        border-top: 1px solid #ddd;
        margin-top: 14px;
        padding-left: 0;
        padding-top: 14px;
      }

      .content-item {
        display: block;
      }

      .thumb {
        width: 100%;
        max-width: 100%;
        margin-bottom: 8px;
      }

      .badge {
        margin-bottom: 8px;
      }
    }
  </style>
</head>
<body>
  <h1>Veille mixte presse + YouTube</h1>

  <div class="nav">
    <a href="/">Presse seule</a>
    <a href="/youtube">YouTube seul</a>
    <a href="/mixte">Veille mixte</a>
    <a href="/admin">⚙ Admin</a>
    <button class="nav-refresh-btn" onclick="startRefresh()">↻ Actualiser</button>
  </div>

  <p class="intro">
    Les nouveaux articles de presse et les nouvelles vidéos YouTube sont regroupés dans les mêmes sujets.
    L’IA analyse uniquement les nouveautés jamais vues auparavant et classe les sujets selon leur potentiel de controverse et de débat.
  </p>

  <div class="status">
    <div>
      Dernière génération du fichier :
      <strong>${escapeHtml(generatedAt)}</strong>
      <br>
      Presse : dernières <strong>${HOURS_BACK_ARTICLES} h</strong> —
      YouTube : dernières <strong>${HOURS_BACK_YOUTUBE} h</strong>
    </div>
    <button class="refresh-btn" type="button">Mettre à jour</button>
    <div class="ptr-indicator" id="ptr-indicator"></div>
    <button class="update-banner" id="update-banner" onclick="window.location.reload()">Nouvelle session disponible — Charger</button>
  </div>

  <div class="filter-bar">
    <button class="filter-btn active" data-sort="score">Sujets clivants</button>
    <button class="filter-btn" data-sort="sources">Sujets majeurs</button>
    <button class="filter-btn" data-sort="left">Sujets avec fort intérêt</button>
    <button class="filter-btn" data-sort="saved">Sujets enregistrés</button>
  </div>

  ${
    sessions.length
      ? `
        <div class="session-tabs-wrapper">
          <h2>Historique des mises à jour</h2>
          <p>Choisis une session pour voir uniquement les nouveautés détectées à cette heure-là.</p>
          <div class="session-tabs">
            ${sessionTabs}
          </div>
          ${olderTabsButton}
        </div>

        ${sessionBlocks}
      `
      : `<div class="empty">Aucune session mixte pour le moment.</div>`
  }

  <script>
    const AGON_THEMES = ${JSON.stringify(AGON_THEMES)};

    function escapeHtmlClient(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function encodeStoryData(value) {
      return encodeURIComponent(JSON.stringify(value || {}));
    }

    function decodeStoryData(value) {
      if (!value) return null;
      try {
        return JSON.parse(decodeURIComponent(value));
      } catch (error) {
        return null;
      }
    }

    let agonStoriesCache = null;

    async function loadAgonStoriesClient() {
      if (agonStoriesCache) return agonStoriesCache;
      const response = await fetch("/api/agon-stories");
      const data = await response.json().catch(function() { return { ok: false, stories: [] }; });
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Impossible de charger les histoires existantes.");
      }
      agonStoriesCache = Array.isArray(data.stories) ? data.stories : [];
      return agonStoriesCache;
    }

    function buildManualStoryPickerHtml() {
      return '<div class="story-manual-picker">' +
        '<label>Choisir manuellement une autre histoire existante</label>' +
        '<select class="story-manual-select">' +
          '<option value="">Conserver le rattachement proposé</option>' +
        '</select>' +
        '<div class="story-manual-summary hidden">' +
          '<label>Résumé de l’histoire choisie</label>' +
          '<textarea class="story-manual-summary-input" rows="3" placeholder="Résumé stable des grands enjeux de l’histoire"></textarea>' +
          '<small class="story-manual-meta"></small>' +
        '</div>' +
      '</div>';
    }

    function buildPreviousEpisodeLinkHtml(storyLink) {
      const previousUrl = String(storyLink?.previous_episode_url || "").trim();
      if (!previousUrl) return "";
      const previousTitle = escapeHtmlClient(storyLink?.previous_episode_title || "Épisode précédent");
      return '<a class="episode-nav-link" href="' + escapeHtmlClient(previousUrl) + '" target="_blank" rel="noopener noreferrer" title="' + previousTitle + '">Voir l’épisode précédent</a>';
    }

    function buildStoryLinkHtml(storyLink) {
      if (!storyLink) return "";

      const storyDecision = storyLink.story_decision || "new_story";
      const confidence = Number(storyLink.confidence || 0);
      const matchedTitle = escapeHtmlClient(storyLink.matched_story_title || "");
      const matchedSummary = escapeHtmlClient(storyLink.matched_story_summary || "");
      const previousEpisodeTitle = escapeHtmlClient(storyLink.previous_episode_title || "");
      const previousEpisodeUrl = escapeHtmlClient(storyLink.previous_episode_url || "");
      const reason = escapeHtmlClient(storyLink.reason || "");
      const newStory = storyLink.new_story || {};
      const groupName = "story-choice-" + Math.random().toString(36).slice(2, 9);
      const encodedCriteria = escapeHtmlClient(encodeStoryData(storyLink.criteria || {}));
      const encodedNewStory = escapeHtmlClient(encodeStoryData(newStory));
      const storyStatusHtml = storyDecision === "existing_story"
        ? '<div class="story-link-status is-existing">Histoire liée : ' + matchedTitle + '</div>'
        : storyDecision === "uncertain"
          ? '<div class="story-link-status is-uncertain">Histoire possible : choix requis</div>'
          : '<div class="story-link-status is-new">Nouvelle histoire proposée</div>';
      const storyToggleHtml = '<label class="story-link-toggle"><input type="checkbox" class="story-enabled-input" checked> Relier cette arène à une histoire</label>';
      const manualPickerHtml = buildManualStoryPickerHtml();

      const existingStoryFields = '<div class="story-draft-fields">' +
        '<label>Résumé de l’histoire</label>' +
        '<textarea class="story-summary-input" rows="3" placeholder="Résumé stable des grands enjeux de l’histoire">' + matchedSummary + '</textarea>' +
        '<div class="story-save-actions"><button type="button" class="story-save-btn">Enregistrer les modifications</button><span class="story-save-feedback hidden">Modifications enregistrées</span></div>' +
      '</div>';

      if (storyDecision === "existing_story") {
        return '<div class="story-link-box" data-story-decision="existing_story" data-matched-story-id="' + escapeHtmlClient(storyLink.matched_story_id || "") + '" data-matched-story-title="' + matchedTitle + '" data-previous-episode-title="' + previousEpisodeTitle + '" data-previous-episode-url="' + previousEpisodeUrl + '" data-confidence="' + confidence + '" data-reason="' + reason + '" data-criteria="' + encodedCriteria + '" data-new-story="' + encodedNewStory + '">' +
          storyStatusHtml +
          storyToggleHtml +
          '<div class="story-link-header">Histoire proposée</div>' +
          '<div class="story-link-card selected">' +
            '<strong>' + matchedTitle + '</strong>' +
            (matchedSummary ? '<p>' + matchedSummary + '</p>' : "") +
            '<small>Sélectionnée par défaut.</small>' +
          '</div>' +
          existingStoryFields +
          manualPickerHtml +
        '</div>';
      }

      const newStoryFields = '<div class="story-draft-fields">' +
        '<label>Titre de la nouvelle histoire</label>' +
        '<input type="text" class="story-title-input" value="' + escapeHtmlClient(newStory.story_title || "") + '" placeholder="Titre court et général de l’histoire">' +
        '<label>Résumé de la nouvelle histoire</label>' +
        '<textarea class="story-summary-input" rows="3" placeholder="Résumé stable des grands enjeux de l’histoire">' + escapeHtmlClient(newStory.story_summary || "") + '</textarea>' +
        '<div class="story-save-actions"><button type="button" class="story-save-btn">Enregistrer les modifications</button><span class="story-save-feedback hidden">Modifications enregistrées</span></div>' +
      '</div>';

      if (storyDecision === "uncertain") {
        return '<div class="story-link-box" data-story-decision="uncertain" data-matched-story-id="' + escapeHtmlClient(storyLink.matched_story_id || "") + '" data-matched-story-title="' + matchedTitle + '" data-previous-episode-title="' + previousEpisodeTitle + '" data-previous-episode-url="' + previousEpisodeUrl + '" data-confidence="' + confidence + '" data-reason="' + reason + '" data-criteria="' + encodedCriteria + '" data-new-story="' + encodedNewStory + '">' +
          storyStatusHtml +
          storyToggleHtml +
          '<div class="story-link-header">Lien avec une histoire existante incertain</div>' +
          '<div class="story-link-card">' +
            '<strong>L’IA propose :</strong> ' + matchedTitle +
            (matchedSummary ? '<p>' + matchedSummary + '</p>' : "") +
            (reason ? '<small>Raison : ' + reason + '</small>' : "") +
          '</div>' +
          '<div class="story-choice-row"><label><input type="radio" class="story-choice-input" name="' + groupName + '" value="existing"> Rattacher à cette histoire existante</label></div>' +
          '<div class="story-choice-row"><label><input type="radio" class="story-choice-input" name="' + groupName + '" value="new"> Créer une nouvelle histoire</label></div>' +
          '<div class="story-link-card story-existing-preview hidden">' +
            '<strong>Histoire existante</strong>' +
            existingStoryFields +
          '</div>' +
          '<div class="story-link-card story-new-preview hidden">' +
            '<strong>Nouvelle histoire proposée</strong>' +
            newStoryFields +
          '</div>' +
          manualPickerHtml +
        '</div>';
      }

      return '<div class="story-link-box" data-story-decision="new_story" data-previous-episode-title="' + previousEpisodeTitle + '" data-previous-episode-url="' + previousEpisodeUrl + '" data-confidence="' + confidence + '" data-reason="' + reason + '" data-criteria="' + encodedCriteria + '" data-new-story="' + encodedNewStory + '">' +
        storyStatusHtml +
        storyToggleHtml +
        '<div class="story-link-header">Nouvelle histoire proposée</div>' +
        newStoryFields +
        manualPickerHtml +
      '</div>';
    }

    function syncStoryChoiceUi(box) {
      if (!box) return;
      const enabled = box.querySelector(".story-enabled-input")?.checked !== false;
      const newPreview = box.querySelector(".story-new-preview");
      const existingPreview = box.querySelector(".story-existing-preview");
      const picker = box.querySelector(".story-manual-picker");
      const selectedValue = box.querySelector(".story-choice-input:checked")?.value || "";
      const manualSelect = box.querySelector(".story-manual-select");
      const hasManualChoice = Boolean(manualSelect && manualSelect.value);
      box.classList.toggle("story-link-disabled", !enabled);
      if (picker) picker.classList.toggle("hidden", !enabled);
      if (newPreview) newPreview.classList.toggle("hidden", !enabled || hasManualChoice || selectedValue !== "new");
      if (existingPreview) existingPreview.classList.toggle("hidden", !enabled || hasManualChoice || selectedValue !== "existing");
      const manualSummary = box.querySelector(".story-manual-summary");
      if (manualSummary) manualSummary.classList.toggle("hidden", !(enabled && hasManualChoice));
    }

    async function populateManualStoryPicker(box) {
      if (!box) return;
      const select = box.querySelector(".story-manual-select");
      if (!select || select.dataset.loaded === "true") return;
      const stories = await loadAgonStoriesClient();
      const options = ['<option value="">Conserver le rattachement proposé</option>'];
      stories.forEach(function(story) {
        const storyId = escapeHtmlClient(story.story_id || "");
        const title = escapeHtmlClient(story.story_title || "Histoire sans titre");
        const summary = escapeHtmlClient(story.story_summary || "");
        const latest = escapeHtmlClient(story.latest_episode_title || "");
        options.push('<option value="' + storyId + '" data-title="' + title + '" data-summary="' + summary + '" data-latest="' + latest + '" data-url="' + escapeHtmlClient(story.latest_episode_url || "") + '">' + title + (latest ? ' - ' + latest : '') + '</option>');
      });
      select.innerHTML = options.join("");
      select.dataset.loaded = "true";
    }

    function updateManualStorySelection(box) {
      if (!box) return;
      const select = box.querySelector(".story-manual-select");
      const summaryWrap = box.querySelector(".story-manual-summary");
      const summaryInput = box.querySelector(".story-manual-summary-input");
      const meta = box.querySelector(".story-manual-meta");
      if (!select || !summaryWrap || !summaryInput || !meta) return;
      const option = select.options[select.selectedIndex];
      const hasValue = Boolean(select.value);
      if (!hasValue) {
        summaryInput.value = "";
        meta.textContent = "";
        syncStoryChoiceUi(box);
        return;
      }
      summaryInput.value = option?.dataset.summary || "";
      meta.textContent = option?.dataset.latest ? "Dernier épisode : " + option.dataset.latest : "";
      syncStoryChoiceUi(box);
    }

    function initializeStoryBoxes(root) {
      (root || document).querySelectorAll(".story-link-box").forEach(function(box) {
        syncStoryChoiceUi(box);
        void populateManualStoryPicker(box).catch(function(error) {
          console.error("Erreur chargement histoires :", error);
        });
      });
    }

    function saveStoryEdits(box) {
      if (!box) return;
      const feedback = box.querySelector(".story-save-feedback");
      const selectedMode = box.querySelector(".story-choice-input:checked")?.value || "";
      const existingSummaryInput = box.querySelector(".story-existing-preview .story-summary-input, .story-summary-input");
      const titleInput = box.querySelector(".story-title-input");
      const newSummaryInput = box.querySelector(".story-new-preview .story-summary-input, .story-draft-fields .story-summary-input");
      const newStory = decodeStoryData(box.dataset.newStory) || {};

      if (titleInput) {
        newStory.story_title = titleInput.value.trim();
      }
      if (newSummaryInput && (box.dataset.storyDecision === "new_story" || selectedMode === "new")) {
        newStory.story_summary = newSummaryInput.value.trim();
        box.dataset.newStory = encodeStoryData(newStory);
      }

      const selectedCard = box.querySelector(".story-link-card.selected");
      if (selectedCard && existingSummaryInput && box.dataset.storyDecision === "existing_story") {
        const paragraph = selectedCard.querySelector("p");
        if (paragraph) {
          paragraph.textContent = existingSummaryInput.value.trim();
        }
      }

      if (feedback) {
        feedback.classList.remove("hidden");
        clearTimeout(feedback._timer);
        feedback._timer = setTimeout(function() {
          feedback.classList.add("hidden");
        }, 1800);
      }
    }

    function collectStorySelection(subjectEl) {
      const box = subjectEl.querySelector(".story-link-box");
      if (!box) return null;
      if (box.querySelector(".story-enabled-input")?.checked === false) {
        return null;
      }

      const storyDecision = box.dataset.storyDecision || "";
      const matchedStoryId = box.dataset.matchedStoryId || null;
      const matchedStoryTitle = box.dataset.matchedStoryTitle || "";
      const previousEpisodeTitle = box.dataset.previousEpisodeTitle || "";
      const previousEpisodeUrl = box.dataset.previousEpisodeUrl || "";
      const confidence = Number(box.dataset.confidence || 0);
      const reason = box.dataset.reason || "";
      const criteria = decodeStoryData(box.dataset.criteria) || {};
      const baseNewStory = decodeStoryData(box.dataset.newStory) || {};
      const manualSelect = box.querySelector(".story-manual-select");
      const manualOption = manualSelect?.options[manualSelect.selectedIndex] || null;

      if (manualSelect && manualSelect.value) {
        const manualSummary = box.querySelector(".story-manual-summary-input")?.value.trim() || "";
        if (!manualSummary) {
          throw new Error("Renseigne le résumé de l’histoire choisie avant l'envoi.");
        }
        return {
          storyDecision: "existing_story",
          matchedStoryId: manualSelect.value,
          matchedStoryTitle: manualOption?.dataset.title || "",
          previousEpisodeTitle: manualOption?.dataset.latest || "",
          previousEpisodeUrl: manualOption?.dataset.url || "",
          confidence: 1,
          reason: "Histoire choisie manuellement.",
          criteria,
          selectionMode: "existing",
          storySummary: manualSummary
        };
      }

      let selectionMode = storyDecision === "existing_story"
        ? "existing"
        : storyDecision === "new_story"
          ? "new"
          : (box.querySelector(".story-choice-input:checked")?.value || "");

      if (!selectionMode) {
        throw new Error("Choisis d'abord si cette arène doit être rattachée à l'histoire proposée ou à une nouvelle histoire.");
      }

      const payload = {
        storyDecision,
        matchedStoryId,
        matchedStoryTitle,
        previousEpisodeTitle,
        previousEpisodeUrl,
        confidence,
        reason,
        criteria,
        selectionMode
      };

      const newSummary = box.querySelector(".story-new-preview .story-summary-input, .story-draft-fields .story-summary-input")?.value.trim() || "";
      const existingSummary = box.querySelector(".story-existing-preview .story-summary-input, .story-summary-input")?.value.trim() || "";

      if (selectionMode === "existing") {
        payload.storySummary = existingSummary;
      }

      if (selectionMode === "new") {
        const title = box.querySelector(".story-title-input")?.value.trim() || "";
        if (!title) {
          throw new Error("Renseigne le titre de la nouvelle histoire avant l'envoi.");
        }
        if (!newSummary) {
          throw new Error("Renseigne le résumé de la nouvelle histoire avant l'envoi.");
        }
        payload.newStory = {
          story_title: title,
          story_summary: newSummary,
          main_actors: Array.isArray(baseNewStory.main_actors) ? baseNewStory.main_actors : [],
          central_tension: baseNewStory.central_tension || "",
          keywords: Array.isArray(baseNewStory.keywords) ? baseNewStory.keywords : [],
          status: "active"
        };
      }

      return payload;
    }

    function buildAiBoxHtml(ai) {
      const score = Number(ai.debateScore) || 0;
      const optionsHtml = AGON_THEMES.map(theme =>
        '<option value="' + theme + '"' + (theme === (ai.agonTheme || AGON_THEMES[0]) ? " selected" : "") + ">" + theme + "</option>"
      ).join("");

      const positionsHtml = score >= 7 && (ai.positionA || ai.positionB) && ai.arenaMode !== "libre"
        ? '<div class="positions-box">' +
            "<p><strong>Positions proposées pour une arène à positions :</strong></p>" +
            (ai.positionA ? '<p><strong>A —</strong> <span class="editable" contenteditable="true" spellcheck="false">' + ai.positionA + "</span></p>" : "") +
            (ai.positionB ? '<p><strong>B —</strong> <span class="editable" contenteditable="true" spellcheck="false">' + ai.positionB + "</span></p>" : "") +
          "</div>"
        : "";

      return '<div class="ai-box">' +
        '<p class="debate-question" contenteditable="true" spellcheck="false">' + (ai.debateQuestion || "") + "</p>" +
        (ai.resume ? '<p class="resume">' + ai.resume + "</p>" : "") +
        buildPreviousEpisodeLinkHtml(ai.storyLink) +
        '<p class="agon-theme"><strong>Thématique Agôn proposée :</strong>' +
          '<select class="agon-select">' + optionsHtml + "</select>" +
        "</p>" +
        buildStoryLinkHtml(ai.storyLink) +
        positionsHtml +
        "</div>";
    }

    function buildAiScoreHtml(ai) {
      return '<div class="ai-score">' +
        "<div>" +
          '<span class="score-label">Potentiel débat</span>' +
          "<strong>" + ai.debateScore + "/10</strong>" +
        "</div>" +
        '<span class="controversy">' + ai.controversyLevel + "</span>" +
        "</div>";
    }

    function getOrientationGroupClient(orientation) {
      const o = (orientation || "").toLowerCase();
      if (o.indexOf("gauche") !== -1) return "left";
      if (o.indexOf("droite") !== -1 || o.indexOf("conservateur") !== -1 || o.indexOf("souverainiste") !== -1) return "right";
      return "center";
    }

    function selectPreselectedLinks(contents, debateScore) {
      if (debateScore < 7) return new Set();
      const selected = new Set();
      const youtube = contents.find(function(c) { return c.type === "youtube"; });
      if (youtube && youtube.link) selected.add(youtube.link);
      const pressItems = contents.filter(function(c) { return c.type === "article"; });
      const leftItem = pressItems.find(function(c) { return getOrientationGroupClient(c.orientation) === "left"; });
      const rightItem = pressItems.find(function(c) { return getOrientationGroupClient(c.orientation) === "right"; });
      if (leftItem && leftItem.link) selected.add(leftItem.link);
      if (rightItem && rightItem.link) selected.add(rightItem.link);
      if (selected.size < 2) {
        for (let i = 0; i < pressItems.length; i++) {
          if (pressItems[i].link && !selected.has(pressItems[i].link)) {
            selected.add(pressItems[i].link);
            if (selected.size >= (youtube ? 3 : 2)) break;
          }
        }
      }
      return selected;
    }

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest(".analyze-btn");
      if (!btn) return;

      const subjectData = JSON.parse(btn.dataset.subject);
      subjectData.arenaMode = btn.dataset.mode || "positions";
      const subjectEl = btn.closest(".subject");
      const aiBox = btn.closest(".ai-box");
      const aiScore = subjectEl.querySelector(".ai-score.pending");

      aiBox.querySelectorAll(".analyze-btn").forEach(function(button) {
        button.disabled = true;
      });
      btn.disabled = true;
      btn.textContent = "Analyse en cours…";

      try {
        const res = await fetch("/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subjectData)
        });

        if (!res.ok) throw new Error("Erreur serveur");
        const ai = await res.json();
        if (subjectData.arenaMode === "libre") {
          ai.arenaMode = "libre";
          ai.debateQuestion = subjectData.subject || ai.debateQuestion || "";
          ai.positionA = "";
          ai.positionB = "";
        }

        if (aiScore) aiScore.outerHTML = buildAiScoreHtml(ai);
        aiBox.outerHTML = buildAiBoxHtml(ai);
        initializeStoryBoxes(subjectEl);

        const agonBtn = subjectEl.querySelector(".agon-btn");
        if (agonBtn) {
          agonBtn.dataset.question = ai.debateQuestion || subjectData.subject || "";
          agonBtn.dataset.positionA = ai.positionA || "";
          agonBtn.dataset.positionB = ai.positionB || "";
          agonBtn.dataset.theme = ai.agonTheme || "";
        }

        const preselectedLinks = selectPreselectedLinks(subjectData.contents, Number(ai.debateScore) || 0);
        subjectEl.querySelectorAll(".content-item[data-link]").forEach(function(item) {
          const link = item.dataset.link;
          const checkbox = item.querySelector('input[type="checkbox"]');
          const isSelected = preselectedLinks.has(link);
          if (checkbox) checkbox.checked = isSelected;
          item.classList.toggle("preselected", isSelected);
        });
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Réessayer (erreur)";
      }
    });

    document.addEventListener("click", async function(e) {
      const btn = e.target.closest(".save-btn");
      if (!btn) return;

      const subjectEl = btn.closest(".subject");
      const isSaved = btn.classList.contains("saved");
      const title = subjectEl.querySelector("h3").textContent.trim();
      const sessionEl = subjectEl.closest(".session");
      const sessionLabel = sessionEl ? (sessionEl.querySelector(".session-header strong") || {}).textContent?.trim() || "" : "";
      const score = Number(subjectEl.dataset.score) || 0;
      const questionEl = subjectEl.querySelector(".debate-question");
      const resumeEl = subjectEl.querySelector(".resume");
      const agonEl = subjectEl.querySelector(".agon-select");
      const editables = subjectEl.querySelectorAll(".editable");
      const sourcesEl = subjectEl.querySelector(".sources");

      const contentItems = [...subjectEl.querySelectorAll(".content-item[data-link]")].map(item => ({
        type: item.dataset.type || "article",
        link: item.dataset.link,
        source: (item.querySelector("strong") || {}).textContent?.trim() || "",
        title: (item.querySelector("a") || {}).textContent?.trim() || "",
        thumbnail: item.dataset.type === "youtube" ? (item.querySelector("img") || {}).src || "" : ""
      }));

      const payload = {
        action: isSaved ? "unsave" : "save",
        subject: title,
        debateScore: score,
        debateQuestion: questionEl ? questionEl.textContent.trim() : "",
        resume: resumeEl ? resumeEl.textContent.trim() : "",
        agonTheme: agonEl ? agonEl.value : "",
        positionA: editables[0] ? editables[0].textContent.trim() : "",
        positionB: editables[1] ? editables[1].textContent.trim() : "",
        sources: sourcesEl ? sourcesEl.textContent.trim() : "",
        contents: contentItems,
        sessionLabel
      };

      try {
        const res = await fetch("/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error("Erreur");
        btn.classList.toggle("saved");
        btn.textContent = btn.classList.contains("saved") ? "★ Enregistré" : "☆ Enregistrer";
      } catch (err) {
        console.error("Erreur save :", err);
      }
    });

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest(".agon-btn");
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = "Envoi…";
      try {
        const subjectEl = btn.closest(".subject");
        const storySelection = collectStorySelection(subjectEl);
        const question = subjectEl.querySelector(".debate-question")?.textContent.trim() || btn.dataset.question;
        const editables = subjectEl.querySelectorAll(".editable");
        const positionA = editables[0]?.textContent.trim() || btn.dataset.positionA;
        const positionB = editables[1]?.textContent.trim() || btn.dataset.positionB;
        const theme = subjectEl.querySelector(".agon-select")?.value || btn.dataset.theme;
        const resume = subjectEl.querySelector(".resume")?.textContent.trim() || "";
        const sources = btn.dataset.sources;
        const links = [...subjectEl.querySelectorAll(".content-item[data-link]")].map(item => {
          const dateText = item.querySelector("small")?.textContent || "";
          const dateMatch = dateText.match(/(\\d{2}\\/\\d{2}\\/\\d{4})/);
          return {
            title: item.querySelector("a")?.textContent.trim() || "",
            url: item.dataset.link || "",
            source: item.querySelector("strong")?.textContent.trim() || "",
            type: item.dataset.type || "article",
            date: dateMatch ? dateMatch[1] : "",
            checked: item.querySelector('input[type="checkbox"]')?.checked ?? true
          };
        }).filter(l => l.url);

        const res = await fetch("/send-to-agon", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, positionA, positionB, theme, resume, sources, links, storySelection })
        });
        if (!res.ok) throw new Error();
        btn.classList.add("sent");
        btn.textContent = "✓ Envoyé";
      } catch (error) {
        btn.disabled = false;
        btn.textContent = "→ Agôn";
        if (error && error.message) {
          alert(error.message);
        }
      }
    });

    document.addEventListener("change", function(e) {
      if (e.target.classList.contains("story-choice-input") || e.target.classList.contains("story-enabled-input")) {
        syncStoryChoiceUi(e.target.closest(".story-link-box"));
        return;
      }
      if (e.target.classList.contains("story-manual-select")) {
        updateManualStorySelection(e.target.closest(".story-link-box"));
      }
    });

    document.addEventListener("click", function(e) {
      const saveBtn = e.target.closest(".story-save-btn");
      if (!saveBtn) return;
      saveStoryEdits(saveBtn.closest(".story-link-box"));
    });

    let currentSort = "score";

    function sortSubjects() {
      const activeSession = document.querySelector(".session.active-session");
      if (!activeSession) return;
      const subjects = [...activeSession.querySelectorAll(":scope > .subject")];
      if (currentSort !== "saved") {
        subjects.sort((a, b) => Number(b.dataset[currentSort]) - Number(a.dataset[currentSort]));
      }
      const visible = [];
      subjects.forEach((s, i) => {
        activeSession.appendChild(s);
        const isSaved = s.querySelector(".save-btn")?.classList.contains("saved");
        const hide = (currentSort === "sources" && i >= 5)
          || (currentSort === "left" && i >= 10)
          || (currentSort === "saved" && !isSaved);
        s.style.display = hide ? "none" : "";
        if (!hide) visible.push(s);
      });
      visible.forEach((s, i) => {
        const badge = s.querySelector(".subject-number");
        if (badge) badge.textContent = (i + 1) + " / " + visible.length;
      });
    }

    document.querySelectorAll(".filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentSort = btn.dataset.sort;
        sortSubjects();
      });
    });

    document.querySelectorAll(".session-tab").forEach((button) => {
      button.addEventListener("click", () => {
        const index = button.dataset.sessionIndex;

        document.querySelectorAll(".session-tab").forEach((tab) => {
          tab.classList.toggle("active", tab.dataset.sessionIndex === index);
        });

        document.querySelectorAll(".session").forEach((session) => {
          const isActive = session.dataset.sessionIndex === index;
          session.classList.toggle("active-session", isActive);
          session.classList.toggle("hidden-session", !isActive);
        });

        sortSubjects();

        window.scrollTo({
          top: 0,
          behavior: "smooth"
        });
      });
    });

    const showOlderButton = document.querySelector(".show-older-tabs");

    if (showOlderButton) {
      showOlderButton.addEventListener("click", () => {
        document.querySelectorAll(".older-tab").forEach((tab) => {
          tab.classList.remove("hidden-tab");
        });

        showOlderButton.classList.add("hidden");
      });
    }

    var ptrIsRefreshing = false;
    var ptrBaseTimestamp = null;

    function showUpdateBanner() {
      var banner = document.getElementById("update-banner");
      if (banner) banner.style.display = "block";
    }

    function setPtrIndicator(text) {
      var el = document.getElementById("ptr-indicator");
      if (!el) return;
      if (text) { el.textContent = text; el.classList.add("visible"); }
      else { el.classList.remove("visible"); }
    }

    async function startRefresh() {
      if (ptrIsRefreshing) return;
      ptrIsRefreshing = true;

      var refreshBtn = document.querySelector(".refresh-btn");
      if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = "En cours…"; }
      setPtrIndicator("↻ Génération en cours…");

      try {
        var r0 = await fetch("/sessions-mixte.json");
        var s0 = await r0.json();
        if (s0.length > 0) ptrBaseTimestamp = s0[0].generatedAt;
      } catch (e) {}

      try { await fetch("/refresh", { method: "POST" }); } catch (e) {}

      var poll = setInterval(async function() {
        try {
          var r = await fetch("/sessions-mixte.json?t=" + Date.now());
          var s = await r.json();
          if (s.length > 0 && s[0].generatedAt !== ptrBaseTimestamp) {
            clearInterval(poll);
            ptrIsRefreshing = false;
            setPtrIndicator(null);
            if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "Mettre à jour"; }
            showUpdateBanner();
          }
        } catch (e) {}
      }, 5000);

      setTimeout(function() {
        clearInterval(poll);
        ptrIsRefreshing = false;
        setPtrIndicator(null);
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "Mettre à jour"; }
        showUpdateBanner();
      }, 10 * 60 * 1000);
    }

    var refreshBtn = document.querySelector(".refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function() { startRefresh(); });
    }

    initializeStoryBoxes(document);

    var ptrTouchStartY = 0;
    var ptrPullDist = 0;
    var PTR_THRESHOLD = 80;

    document.addEventListener("touchstart", function(e) {
      ptrTouchStartY = window.scrollY === 0 ? e.touches[0].clientY : 0;
      ptrPullDist = 0;
    }, { passive: true });

    document.addEventListener("touchmove", function(e) {
      if (ptrTouchStartY === 0 || ptrIsRefreshing) return;
      ptrPullDist = e.touches[0].clientY - ptrTouchStartY;
      if (ptrPullDist > 0 && window.scrollY === 0) {
        setPtrIndicator(ptrPullDist > PTR_THRESHOLD ? "↑ Relâchez pour actualiser" : "↓ Tirez pour actualiser");
      }
    }, { passive: true });

    document.addEventListener("touchend", function() {
      if (ptrTouchStartY === 0) return;
      if (ptrPullDist > PTR_THRESHOLD && window.scrollY === 0 && !ptrIsRefreshing) {
        startRefresh();
      } else {
        setPtrIndicator(null);
      }
      ptrTouchStartY = 0;
      ptrPullDist = 0;
    }, { passive: true });
  </script>
</body>
</html>
`;
}

async function runWatchSession() {
  const startedAt = dayjs();
  const lastSessionCutoff = getLastSessionCutoff();

  console.log("");
  console.log("======================================");
  console.log(`Nouvelle session mixte : ${startedAt.format("DD/MM/YYYY HH:mm:ss")}`);
  console.log("======================================");
  if (lastSessionCutoff) {
    console.log("Filtre fraîcheur actif : seulement les contenus publiés après " + lastSessionCutoff.format("DD/MM/YYYY HH:mm:ss") + ".");
  } else {
    console.log("Aucune session précédente : première collecte sur la fenêtre récente habituelle.");
  }

  console.log("Collecte des articles...");
  const articles = await collectArticles(lastSessionCutoff);

  console.log("Collecte des vidéos YouTube...");
  const videos = await collectYouTubeVideos(lastSessionCutoff);

  const contents = [...articles, ...videos];

  console.log(`${articles.length} article(s) récupéré(s) dans les flux.`);
  console.log(`${videos.length} vidéo(s) récupérée(s) dans les flux.`);
  console.log(`${contents.length} contenu(s) récent(s) au total.`);

  console.log("Regroupement des nouveaux sujets mixtes...");
  const groups = groupContentsBySubject(contents);

  console.log(`${groups.length} groupe(s) détecté(s).`);

  const subjects = filterMultiSourceSubjects(groups);

  console.log(`${subjects.length} sujet(s) repris par plusieurs sources.`);

  let analyzedSubjects;

  if (openai) {
    analyzedSubjects = await analyzeScoresWithAI(subjects);
  } else {
    analyzedSubjects = subjects.map(subject => {
      const fb = fallbackAiAnalysis(subject);
      return {
        ...subject,
        debateScore: fb.debateScore,
        controversyLevel: fb.controversyLevel,
        leftScore: fb.leftScore,
        scoreAnalyzed: false,
        ai: null,
        aiAnalyzed: false
      };
    });
  }

  const session = {
    generatedAt: startedAt.toISOString(),
    generatedAtLabel: startedAt.format("DD/MM/YYYY à HH:mm:ss"),
    articleCount: articles.length,
    youtubeCount: videos.length,
    contentCount: contents.length,
    groupCount: groups.length,
    subjectCount: analyzedSubjects.length,
    aiEnabled: Boolean(openai),
    subjects: analyzedSubjects
  };

  const sessions = loadSessions();

  sessions.unshift(session);

  const limitedSessions = sessions.slice(0, MAX_SESSIONS_TO_KEEP);

  saveSessions(limitedSessions);

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(analyzedSubjects, null, 2), "utf8");
  fs.writeFileSync(OUTPUT_HTML, generateHtml(limitedSessions), "utf8");

  console.log(`Fichier généré : ${OUTPUT_HTML}`);
  console.log(`Historique généré : ${HISTORY_FILE}`);
  console.log(`Analyse IA : ${openai ? "activée" : "désactivée, clé API absente"}`);
}

let isRunning = false;

async function main() {
  isRunning = true;
  try {
    await runWatchSession();
  } finally {
    isRunning = false;
  }
}

const localApiServer = apiApp.listen(API_PORT, "127.0.0.1", () => {
  console.log(`API mixte lancée sur 127.0.0.1:${API_PORT}`);
});

localApiServer.on("error", (error) => {
  console.error("Erreur API mixte locale :", error.message);
});

main();
