require("dotenv").config();

const express = require("express");
const fs = require("fs");
const Parser = require("rss-parser");
const stringSimilarity = require("string-similarity");
const dayjs = require("dayjs");
const OpenAI = require("openai");
const path = require("path");
const { renderAutoCollectCertamenWidgetHtml } = require("./certamen-auto-collect-widget");
const { renderAutoCollectMixteWidgetHtml } = require("./auto-collect-mixte-widget");
const { renderCertamenPublishWidgetHtml } = require("./certamen-publish-widget");
const { MAX_CHECKED_SUBJECTS } = require("./certamen-checked-subjects");
const { cleanCertamenGeneratedText } = require("./certamen-text-cleanup");

const apiApp = express();
apiApp.use(express.json({ limit: "2mb" }));

const BOT_USER_AGENT = "AgonBot/1.0 (+contact: kevinbruyat@live.fr ; N'hésitez pas à me contacter.)";

const parser = new Parser({
  headers: { "User-Agent": BOT_USER_AGENT }
});

const MEDIA_FILE = "medias.json";
const CHANNELS_FILE = "youtube-chaines.json";
const MEDIA_FILE_CERTAMEN = "medias-certamen.json";
const CHANNELS_FILE_CERTAMEN = "youtube-chaines-certamen.json";

const OUTPUT_JSON = "veille-mixte.json";
const OUTPUT_HTML = "veille-mixte.html";
const HISTORY_FILE = "sessions-mixte.json";
const SAVED_FILE = "saved-subjects.json";
const SENT_TO_AGON_FILE = "sent-to-agon.json";
const API_PORT = 3002;

const HOURS_BACK_ARTICLES = 24;
const HOURS_BACK_YOUTUBE = 168;

// Mesure réelle (au lieu d'estimer) de la conso par appel IA, pour prioriser les
// leviers de coût sur des chiffres et non des suppositions. response.model est repris
// tel que renvoyé par l'API plutôt que retracké manuellement par site d'appel.
function logAiUsage(label, response) {
  const u = (response && response.usage) || {};
  const inputTokens = u.input_tokens ?? u.prompt_tokens ?? 0;
  const outputTokens = u.output_tokens ?? u.completion_tokens ?? 0;
  const model = (response && response.model) || "?";
  console.log(`[ai-usage] ${label} | ${model} | in=${inputTokens} out=${outputTokens}`);
}

const SIMILARITY_THRESHOLD = 0.52;
const MIN_SHARED_KEYWORDS = 2;
// Repli utilisé quand le titre seul ne matche pas assez (score sous SIMILARITY_THRESHOLD) :
// certains médias d'opinion (Causeur, Atlantico...) titrent avec un angle édito plutôt qu'un
// résumé factuel, donc leur titre seul ressemble peu au titre factuel des autres médias sur le
// même évènement — même quand leur chapô/résumé en parle explicitement. On retente alors la
// comparaison de mots-clés en incluant le résumé, avec un seuil plus strict (3 au lieu de 2)
// pour compenser l'absence de contrainte sur le score de similarité brute.
const STRONG_SHARED_KEYWORDS = 3;
const SUMMARY_MATCH_CHARS = 400;
const MIN_DISTINCT_SOURCES = 2;

const UPDATE_INTERVAL_MINUTES = 720;
const MAX_SESSIONS_TO_KEEP = 12;
const MAX_SUBJECTS_TO_ANALYZE_WITH_AI = 25;
// Les sessions réelles collectent entre 100 et 195 sujets bruts (contenus multi-sources)
// avant déduplication : un plafond de 80 laissait 20 à 115 sujets par session ne jamais
// être comparés à rien (silencieusement tronqués par le .slice() dans
// deduplicateSubjectsWithAI), donc jamais fusionnés même quand ils parlaient de la même
// actualité qu'un sujet resté sous le plafond (ex. session du 9 juil 2026 : subject_090
// sur les ambitions de Bardella, jamais comparé au cluster Le Pen subject_001, republié
// en doublon). Le payload envoyé à l'IA ne contient que id+titre+otherTitles par sujet
// (quelques dizaines de tokens chacun) : monter ce plafond a un coût négligeable comparé
// au scoring ou à la génération d'articles.
const MAX_SUBJECTS_TO_DEDUP_WITH_AI = 250;
const FEED_TIMEOUT_MS = 15000;
const DEFAULT_FETCH_HEADERS = {
  "User-Agent": BOT_USER_AGENT,
  "Accept": "application/rss+xml, application/xml, text/xml, application/atom+xml, */*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache"
};
const BROWSER_RSS_FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Accept": "application/rss+xml, application/xml, text/xml, text/html",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache"
};

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

const PAUSE_DURATIONS_MS = {
  403: 24 * 60 * 60 * 1000,
  429: 12 * 60 * 60 * 1000
};

const pausedSources = new Map();
const collectionDiagnostics = {
  mediaRssFetched: 0,
  youtubeRssFetched: 0,
  youtubeHtmlFetched: 0,
  rssErrors403: 0,
  rssErrors404: 0,
  rssErrors429: 0,
  rssFetchFailed: 0,
  rssNonXml: 0
};

function resetCollectionDiagnostics() {
  collectionDiagnostics.mediaRssFetched = 0;
  collectionDiagnostics.youtubeRssFetched = 0;
  collectionDiagnostics.youtubeHtmlFetched = 0;
  collectionDiagnostics.rssErrors403 = 0;
  collectionDiagnostics.rssErrors404 = 0;
  collectionDiagnostics.rssErrors429 = 0;
  collectionDiagnostics.rssFetchFailed = 0;
  collectionDiagnostics.rssNonXml = 0;
}

function logCollectionDiagnostics(label, preparedSubjects) {
  console.log(
    `[diagnostic collecte] ${label} — ` +
    `flux RSS médias fetchés=${collectionDiagnostics.mediaRssFetched}; ` +
    `flux RSS YouTube fetchés=${collectionDiagnostics.youtubeRssFetched}; ` +
    `pages HTML YouTube fetchées=${collectionDiagnostics.youtubeHtmlFetched}; ` +
    `pages d'articles complets fetchées=0; ` +
    `articles complets évités après 4 sources exploitables=0; ` +
    `sujets préparés=${preparedSubjects}; ` +
    `sujets publiés=0; ` +
    `erreurs RSS 403=${collectionDiagnostics.rssErrors403}; ` +
    `erreurs RSS 404=${collectionDiagnostics.rssErrors404}; ` +
    `erreurs RSS 429=${collectionDiagnostics.rssErrors429}; ` +
    `fetch failed=${collectionDiagnostics.rssFetchFailed}; ` +
    `flux non XML=${collectionDiagnostics.rssNonXml}`
  );
}

function extractHttpStatus(error) {
  const direct = Number(error?.httpStatus || error?.status || error?.statusCode || error?.response?.status || error?.response?.statusCode);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const message = String(error?.message || "");
  const match = message.match(/\b(403|404|429|5\d\d)\b/);
  return match ? Number(match[1]) : null;
}

function describeFetchFailure(error) {
  if (!error) return "cause inconnue";
  if (error.name === "AbortError" || error.code === "ETIMEDOUT") return "timeout/aborted";
  const cause = error.cause || {};
  const code = String(error.code || cause.code || "").trim();
  if (code) {
    if (code === "ENOTFOUND") return "DNS/host introuvable";
    if (code === "ECONNRESET") return "connexion réinitialisée";
    if (code === "ECONNREFUSED") return "connexion refusée";
    if (code === "ETIMEDOUT") return "timeout réseau";
    if (code.includes("CERT") || code.includes("TLS") || code.includes("SSL")) return `TLS/certificat (${code})`;
    if (code === "UND_ERR_TOO_MANY_REDIRECTS") return "trop de redirections";
    return code;
  }
  if (/redirect/i.test(String(error.message || ""))) return "redirect";
  if (/fetch failed/i.test(String(error.message || ""))) return "fetch failed";
  return String(error.message || "cause inconnue");
}

function createFeedError(label, message, props = {}) {
  const error = new Error(`${label} — ${message}`);
  Object.assign(error, props);
  return error;
}

function registerRssError(error) {
  const status = extractHttpStatus(error);
  if (status === 403) collectionDiagnostics.rssErrors403++;
  else if (status === 404) collectionDiagnostics.rssErrors404++;
  else if (status === 429) collectionDiagnostics.rssErrors429++;
  else if (error?.rssErrorKind === "fetch_failed") collectionDiagnostics.rssFetchFailed++;
  else if (error?.rssErrorKind === "non_xml") collectionDiagnostics.rssNonXml++;
}

function getRssErrorDetails(sourceName, error, options = {}) {
  const status = extractHttpStatus(error);
  const orientation = options.orientation || "";
  const rss = options.rss || "";
  const base = { nom: sourceName, orientation, rss, kept: 0, skipped: 0 };

  if (status === 404) {
    return {
      ...base,
      statut: "URL RSS à remplacer (HTTP 404)",
      message: error.message
    };
  }
  if (status === 403) {
    return {
      ...base,
      statut: "erreur HTTP 403",
      message: "Accès refusé après essai avec headers navigateur"
    };
  }
  if (status === 429) {
    return {
      ...base,
      statut: "erreur HTTP 429",
      message: "Rate limit, flux mis en pause temporaire"
    };
  }
  if (error?.rssErrorKind === "fetch_failed") {
    return {
      ...base,
      statut: "fetch failed",
      cause: error.fetchFailureCause || describeFetchFailure(error),
      message: error.message
    };
  }
  if (error?.rssErrorKind === "non_xml") {
    return {
      ...base,
      statut: "flux non XML",
      message: error.message
    };
  }

  return {
    ...base,
    statut: "erreur",
    message: error.message
  };
}

function logRssError(sourceName, error, options = {}) {
  const status = extractHttpStatus(error);
  const prefix = `[RSS] ${sourceName}${options.orientation ? ` (${options.orientation})` : ""}`;
  if (status === 404) {
    console.error(`${prefix} — URL RSS à remplacer: ${options.rss || "URL inconnue"}`);
  } else if (status === 403) {
    console.error(`${prefix} — HTTP 403 après essai avec headers navigateur: ${options.rss || "URL inconnue"}`);
  } else if (status === 429) {
    console.error(`${prefix} — HTTP 429, pause temporaire sans relance immédiate: ${options.rss || "URL inconnue"}`);
  } else if (error?.rssErrorKind === "fetch_failed") {
    console.error(`${prefix} — fetch failed (${error.fetchFailureCause || describeFetchFailure(error)}): ${options.rss || "URL inconnue"}`);
  } else if (error?.rssErrorKind === "non_xml") {
    console.error(`${prefix} — flux non XML: ${options.rss || "URL inconnue"}`);
  } else {
    console.error(`${prefix} — erreur: ${error.message}`);
  }
}

function isSourcePaused(sourceName) {
  const resumeAt = pausedSources.get(sourceName);
  if (!resumeAt) return false;
  if (Date.now() >= resumeAt) {
    pausedSources.delete(sourceName);
    return false;
  }
  return true;
}

function pauseSource(sourceName, httpStatus) {
  const durationMs = PAUSE_DURATIONS_MS[httpStatus] || PAUSE_DURATIONS_MS[403];
  const resumeAt = Date.now() + durationMs;
  pausedSources.set(sourceName, resumeAt);
  const hours = durationMs / (60 * 60 * 1000);
  console.log(`[pause] ${sourceName} mis en pause (HTTP ${httpStatus}) pour ${hours}h — reprise le ${new Date(resumeAt).toLocaleString("fr-FR")}.`);
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
      throw createFeedError(label, `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`, {
        httpStatus: response.status,
        rssErrorKind: "http_status",
        fetchUrl: url
      });
    }

    return await response.text();
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw createFeedError(label, `timeout après ${Math.round(timeoutMs / 1000)}s`, {
        rssErrorKind: "fetch_failed",
        fetchFailureCause: "timeout/aborted",
        fetchUrl: url
      });
    }
    if (error?.rssErrorKind || extractHttpStatus(error)) {
      throw error;
    }
    const failureCause = describeFetchFailure(error);
    throw createFeedError(label, `fetch failed (${failureCause})`, {
      rssErrorKind: "fetch_failed",
      fetchFailureCause: failureCause,
      fetchUrl: url,
      originalError: error
    });
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

// Certains médias (Le Point, Les Échos, Capital…) n'exposent plus de flux RSS
// mais publient un sitemap Google News (<urlset> + balises <news:…>) avec titre
// et date de publication : on le convertit au même format que rss-parser.
function looksLikeNewsSitemap(text) {
  const value = String(text || "");
  return value.includes("<urlset") && value.includes("<news:");
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseNewsSitemap(xmlText) {
  const items = [];
  for (const block of String(xmlText || "").match(/<url>[\s\S]*?<\/url>/g) || []) {
    const loc = block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/);
    const title = block.match(/<news:title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/news:title>/);
    const pubDate = block.match(/<news:publication_date>\s*([\s\S]*?)\s*<\/news:publication_date>/)
      || block.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/);
    if (!loc || !title) continue;
    const item = {
      title: decodeXmlEntities(title[1].trim()),
      link: decodeXmlEntities(loc[1].trim()),
      contentSnippet: ""
    };
    if (pubDate) item.isoDate = pubDate[1].trim();
    items.push(item);
  }
  return { items };
}

function getFeedUrlFilterRegexes(source) {
  return getSourceRegexes(source, "includeUrlPattern", "includeUrlPatterns");
}

function getSourceRegexes(source, singleKey, multipleKey) {
  const rawPatterns = [];
  if (source && source[singleKey]) rawPatterns.push(source[singleKey]);
  if (source && Array.isArray(source[multipleKey])) rawPatterns.push(...source[multipleKey]);
  return rawPatterns.map((pattern) => {
    try {
      return new RegExp(String(pattern), "i");
    } catch (error) {
      console.warn(`[source] filtre invalide ignoré pour ${source.nom || "source"}: ${pattern}`);
      return null;
    }
  }).filter(Boolean);
}

function applyFeedSourceFilters(feed, source) {
  const regexes = getFeedUrlFilterRegexes(source);
  if (!regexes.length) return feed;
  const items = (feed.items || []).filter((item) => {
    const url = String(item.link || item.guid || "");
    return regexes.some((regex) => regex.test(url));
  });
  return { ...feed, items };
}

function getFeedTitleExcludeRegexes(source) {
  return getSourceRegexes(source, "excludeTitlePattern", "excludeTitlePatterns");
}

function getFeedTitleStripRegexes(source) {
  return getSourceRegexes(source, "stripTitleSuffixPattern", "stripTitleSuffixPatterns");
}

function normalizeFeedItemTitle(title, source) {
  let nextTitle = String(title || "Sans titre").trim();
  for (const regex of getFeedTitleStripRegexes(source)) {
    nextTitle = nextTitle.replace(regex, "").trim();
  }
  return nextTitle || String(title || "Sans titre").trim() || "Sans titre";
}

function shouldSkipFeedItemTitle(title, source) {
  const value = String(title || "").trim();
  return getFeedTitleExcludeRegexes(source).some((regex) => regex.test(value));
}

function getMediaFeedCandidates(media) {
  const candidates = [];
  if (media.rss) {
    candidates.push({
      url: media.rss,
      label: `Flux RSS ${media.nom}`,
      fallback: false
    });
  }

  const fallbacks = [];
  if (media.rssFallback) fallbacks.push(media.rssFallback);
  if (Array.isArray(media.rssFallbacks)) fallbacks.push(...media.rssFallbacks);

  for (let index = 0; index < fallbacks.length; index++) {
    const fallback = fallbacks[index];
    const url = typeof fallback === "string" ? fallback : fallback?.url || fallback?.rss;
    if (!url) continue;
    candidates.push({
      url,
      label: typeof fallback === "object" && fallback.label ? fallback.label : `Fallback RSS ${media.nom} #${index + 1}`,
      fallback: true
    });
  }

  return candidates;
}

async function fetchMediaFeed(media) {
  const candidates = getMediaFeedCandidates(media);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      if (candidate.fallback) {
        console.log(`[fallback] ${media.nom} — essai via ${candidate.label}`);
      }
      collectionDiagnostics.mediaRssFetched++;
      const feed = await fetchFeedWithFallback(candidate.url, candidate.label);
      return {
        feed: applyFeedSourceFilters(feed, media),
        usedFallback: candidate.fallback,
        candidate
      };
    } catch (error) {
      lastError = error;
      if (!candidate.fallback && candidates.some((item) => item.fallback)) {
        console.warn(`[fallback] ${media.nom} — flux principal indisponible (${error.message}), tentative fallback.`);
      }
    }
  }

  throw lastError || new Error(`Aucun flux RSS utilisable pour ${media.nom}`);
}

async function fetchFeedWithFallback(url, label, timeoutMs = FEED_TIMEOUT_MS) {
  try {
    return await parseFeedWithTimeout(url, label, timeoutMs);
  } catch (initialError) {
    const initialStatus = extractHttpStatus(initialError);
    if (initialStatus === 404) {
      throw createFeedError(label, "URL RSS à remplacer (HTTP 404)", {
        httpStatus: 404,
        rssErrorKind: "http_status",
        fetchUrl: url,
        originalError: initialError
      });
    }
    if (initialStatus === 429) {
      throw createFeedError(label, "HTTP 429, flux mis en pause sans relance immédiate", {
        httpStatus: 429,
        rssErrorKind: "http_status",
        fetchUrl: url,
        originalError: initialError
      });
    }

    const feedText = await fetchTextWithTimeout(url, {
      headers: BROWSER_RSS_FETCH_HEADERS,
      redirect: "follow"
    }, label, timeoutMs);

    if (looksLikeNewsSitemap(feedText)) {
      return parseNewsSitemap(feedText);
    }

    if (!looksLikeXmlFeed(feedText)) {
      throw createFeedError(label, "flux non XML exploitable (probable HTML/anti-bot)", {
        rssErrorKind: "non_xml",
        fetchUrl: url
      });
    }

    try {
      return await parseFeedTextWithTimeout(feedText, label, timeoutMs);
    } catch (parseError) {
      throw createFeedError(label, `flux XML illisible (${parseError.message || initialError.message})`, {
        rssErrorKind: "parse_error",
        fetchUrl: url,
        originalError: parseError
      });
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

const HTML_NAMED_ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#039;": "'", "&apos;": "'",
  "&nbsp;": " ", "&hellip;": "\u2026", "&mdash;": "\u2014", "&ndash;": "\u2013",
  "&rsquo;": "\u2019", "&lsquo;": "\u2018", "&ldquo;": "\u201c", "&rdquo;": "\u201d"
};

// Certains flux RSS (WordPress notamment) mettent du HTML brut dans leur
// description, parfois echappe deux fois (balises et entites non decodees,
// ex: "&#8211;", "&amp;lt;p&amp;gt;") : le parseur XML laisse ca tel quel
// puisque c'est dans une section CDATA. Sans ce nettoyage, ces resumes
// ressortent avec des balises/entites visibles partout ou ils sont affiches
// (dashboard veille, page Tribunes d'Agon...).
function decodeHtmlEntitiesOnce(text) {
  return String(text || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-zA-Z]+;/g, (entity) => HTML_NAMED_ENTITIES[entity] || entity);
}

function stripHtmlAndDecodeEntities(text) {
  // Deux passes : un flux double-echappe revele de nouvelles balises/entites
  // apres un premier decodage (ex: "&amp;lt;p&amp;gt;" -> "<p>" seulement au 2e passage).
  let result = decodeHtmlEntitiesOnce(String(text || ""));
  result = decodeHtmlEntitiesOnce(result);
  return result
    .replace(/<[^>]*>/g, " ")
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
    "societe", "sport", "culture", "invite", "invites", "interview",
    "pourquoi", "comment", "quand", "voici", "bilan", "point", "zoom",
    "retour", "suite", "apres", "alors", "aussi", "encore", "toujours",
    "vraiment", "enfin", "moins", "plus", "bien", "meme", "autre", "autres",
    "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
    "janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout",
    "septembre", "octobre", "novembre", "decembre"
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

function getProperNouns(originalTitle) {
  const words = String(originalTitle || "").split(/\s+/);
  const result = new Set();
  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/[^\p{L}]/gu, "");
    if (word.length >= 3 && /^\p{Lu}/u.test(word)) {
      result.add(cleanText(word));
    }
  }
  return result;
}

function hasConflictingProperNouns(titleA, titleB) {
  const a = getProperNouns(titleA);
  const b = getProperNouns(titleB);
  if (a.size === 0 || b.size === 0) return false;
  for (const noun of a) {
    if (b.has(noun)) return false;
  }
  return true;
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

function getPreviousSessionSources() {
  const sessions = loadSessions();
  if (!Array.isArray(sessions) || !sessions.length) return new Set();
  const sources = new Set();
  for (const subject of (sessions[0].subjects || [])) {
    for (const source of (subject.sources || [])) {
      sources.add(source);
    }
  }
  return sources;
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

function loadSentToAgonItems() {
  if (!fs.existsSync(SENT_TO_AGON_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SENT_TO_AGON_FILE, "utf8"));
  } catch {
    return [];
  }
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

  const isNew = existingIndex === -1;
  const nextItem = {
    ...(isNew ? {} : saved[existingIndex]),
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

  collectionDiagnostics.youtubeHtmlFetched++;
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
  let lastError = null;
  if (channel.rss) {
    try {
      collectionDiagnostics.youtubeRssFetched++;
      const feed = await fetchFeedWithFallback(channel.rss, `Flux YouTube ${channel.nom}`);
      return { rssUrl: channel.rss, feed };
    } catch (error) {
      lastError = error;
    }
  }

  if (channel.url) {
    try {
      const rebuilt = await getRssUrlFromYouTubeChannel({ ...channel, rss: "" });
      collectionDiagnostics.youtubeRssFetched++;
      const feed = await fetchFeedWithFallback(rebuilt, `Flux YouTube ${channel.nom}`);
      persistYoutubeRssUrl(channel.nom, rebuilt);
      return { rssUrl: rebuilt, feed };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Aucun flux YouTube utilisable n'a pu être déterminé");
}

function extractYouTubeVideoId(link) {
  const value = String(link || "");
  const match = value.match(/[?&]v=([^&]+)/);

  if (match && match[1]) {
    return match[1];
  }

  return "";
}

const ROUNDUP_TITLE_PATTERNS = [
  /ce qu['’]?(il|on) (faut|sait)/i,
  /l['’]essentiel (de|du|des|à retenir)/i,
  /\ben bref\b/i,
  /faits marquants/i,
  /r[ée]sum[ée] de la (journ[ée]e|semaine|soir[ée]e)/i,
  /retour sur (la|le|les) (journ[ée]e|semaine)/i,
  /toute l['’]actualit[ée]/i,
  /revue de presse/i
];

function isRoundupTitle(title) {
  const text = String(title || "");
  return ROUNDUP_TITLE_PATTERNS.some((pattern) => pattern.test(text));
}

async function collectArticles(lastSessionCutoff = null, knownSources = new Set(), sourceFile = MEDIA_FILE) {
  const medias = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  const contents = [];
  const report = { sources: [] };

  for (let _mi = 0; _mi < medias.length; _mi++) {
    const media = medias[_mi];
    setProgress(1, "Collecte des articles", `${_mi + 1} / ${medias.length} — ${media.nom}`);

    if (isSourcePaused(media.nom)) {
      console.log(`[pause] ${media.nom} ignoré (en pause).`);
      report.sources.push({ nom: media.nom, statut: "pause", kept: 0, skipped: 0 });
      continue;
    }

    try {
      console.log(`Article — lecture de ${media.nom}...`);
      const { feed, usedFallback, candidate } = await fetchMediaFeed(media);
      const isNewSource = knownSources.size > 0 && !knownSources.has(media.nom);
      let kept = 0, skipped = 0;

      for (const item of feed.items || []) {
        const date = getItemDate(item);
        if (!isRecent(date, HOURS_BACK_ARTICLES)) { skipped++; continue; }
        if (!isNewSource && !isFreshSinceLastSession(date, lastSessionCutoff)) { skipped++; continue; }
        const rawTitle = item.title || "Sans titre";
        const title = normalizeFeedItemTitle(rawTitle, media);
        if (shouldSkipFeedItemTitle(rawTitle, media) || shouldSkipFeedItemTitle(title, media)) { skipped++; continue; }
        if (isRoundupTitle(title)) { skipped++; continue; }
        const summary = stripHtmlAndDecodeEntities(item.contentSnippet || item.content || item.summary || "");
        contents.push({ type: "article", source: media.nom, orientation: media.orientation || "", title, link: item.link || "", date: date.toISOString(), summary, thumbnail: "", comparableText: cleanText(title) });
        kept++;
      }
      report.sources.push({
        nom: media.nom,
        statut: "ok",
        kept,
        skipped,
        message: usedFallback ? `fallback ${candidate.label}` : ""
      });
    } catch (error) {
      registerRssError(error);
      logRssError(media.nom, error, { orientation: media.orientation || "", rss: media.rss });
      const status = extractHttpStatus(error);
      if (status === 403 || status === 429) {
        pauseSource(media.nom, status);
        report.sources.push(getRssErrorDetails(media.nom, error, { orientation: media.orientation || "", rss: media.rss }));
      } else {
        report.sources.push(getRssErrorDetails(media.nom, error, { orientation: media.orientation || "", rss: media.rss }));
      }
    }
  }

  return { contents, report };
}

async function collectYouTubeVideos(lastSessionCutoff = null, knownSources = new Set(), sourceFile = CHANNELS_FILE) {
  const channels = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  const contents = [];
  const report = { sources: [] };

  for (let _ci = 0; _ci < channels.length; _ci++) {
    const channel = channels[_ci];
    setProgress(2, "Collecte des vidéos YouTube", `${_ci + 1} / ${channels.length} — ${channel.nom}`);

    if (isSourcePaused(channel.nom)) {
      console.log(`[pause] ${channel.nom} ignoré (en pause).`);
      report.sources.push({ nom: channel.nom, statut: "pause", kept: 0, skipped: 0 });
      continue;
    }

    try {
      console.log(`YouTube — lecture de ${channel.nom}...`);
      const { feed } = await getWorkingYouTubeRssUrl(channel);
      const isNewSource = knownSources.size > 0 && !knownSources.has(channel.nom);
      let kept = 0, skipped = 0;

      for (const item of feed.items || []) {
        const date = getItemDate(item);
        if (!isRecent(date, HOURS_BACK_YOUTUBE)) { skipped++; continue; }
        if (!isNewSource && !isFreshSinceLastSession(date, lastSessionCutoff)) { skipped++; continue; }
        const title = item.title || "Sans titre";
        if (isRoundupTitle(title)) { skipped++; continue; }
        const summary = stripHtmlAndDecodeEntities(item.contentSnippet || item.content || item.summary || "");
        const link = item.link || "";
        const videoId = extractYouTubeVideoId(link);
        contents.push({ type: "youtube", source: channel.nom, orientation: channel.orientation || "", title, link, date: date.toISOString(), summary, thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "", comparableText: cleanText(title) });
        kept++;
      }
      report.sources.push({ nom: channel.nom, statut: "ok", kept, skipped });
    } catch (error) {
      registerRssError(error);
      logRssError(channel.nom, error, { orientation: channel.orientation || "", rss: channel.rss || channel.url || "" });
      const status = extractHttpStatus(error);
      if (status === 403 || status === 429) {
        pauseSource(channel.nom, status);
        report.sources.push(getRssErrorDetails(channel.nom, error, { orientation: channel.orientation || "", rss: channel.rss || channel.url || "" }));
      } else {
        report.sources.push(getRssErrorDetails(channel.nom, error, { orientation: channel.orientation || "", rss: channel.rss || channel.url || "" }));
      }
    }
  }

  return { contents, report };
}

function groupContentsBySubject(contents) {
  const groups = [];

  for (const content of contents) {
    let bestGroup = null;
    let bestScore = 0;

    for (const group of groups) {
      let score = stringSimilarity.compareTwoStrings(
        content.comparableText,
        group.referenceText
      );

      if (group.originalText !== group.referenceText) {
        score = Math.max(
          score,
          stringSimilarity.compareTwoStrings(content.comparableText, group.originalText)
        );
      }

      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    }

    const sharedKeywords = bestGroup
      ? countSharedKeywords(content.title, bestGroup.referenceText)
      : 0;

    const conflicting = bestGroup
      ? hasConflictingProperNouns(content.title, bestGroup.subject)
      : false;

    let matched =
      bestGroup &&
      bestScore >= SIMILARITY_THRESHOLD &&
      sharedKeywords >= MIN_SHARED_KEYWORDS &&
      !conflicting;

    // Repli résumé : le titre seul ne matche pas (cas fréquent pour les médias d'opinion,
    // dont le titre est un angle édito plutôt qu'un résumé factuel de l'évènement), mais le
    // chapô/résumé de l'article, lui, partage clairement le sujet avec le groupe pressenti.
    if (!matched && bestGroup) {
      const candidateText = `${content.title} ${(content.summary || "").slice(0, SUMMARY_MATCH_CHARS)}`;
      const strongSharedKeywords = countSharedKeywords(candidateText, bestGroup.subject);
      const strongConflicting = hasConflictingProperNouns(candidateText, bestGroup.subject);

      if (strongSharedKeywords >= STRONG_SHARED_KEYWORDS && !strongConflicting) {
        matched = true;
      }
    }

    if (matched) {
      bestGroup.contents.push(content);

      if (content.comparableText.length > bestGroup.referenceText.length) {
        bestGroup.referenceText = content.comparableText;
      }
    } else {
      groups.push({
        subject: content.title,
        originalText: content.comparableText,
        referenceText: content.comparableText,
        contents: [content]
      });
    }
  }

  return groups;
}

function filterMultiSourceSubjects(groups, minSources = MIN_DISTINCT_SOURCES) {
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
    .filter(group => group.sourceCount >= minSources)
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

// Sujets déjà envoyés vers Agôn comme débat (sent-to-agon.json, tenu à jour par
// server.js) — sert à ne pas republier dans Tribunes un sujet devenu une arène.
// Comparaison sur le titre nettoyé (cf. normalizeSentToAgonKey côté server.js, même
// logique que cleanText ici) : les deux systèmes vivent dans des process séparés
// (veille-mixte.js sur le port 3002, server.js sur le 3000) mais partagent le fichier.
function loadPublishedSubjectKeys() {
  const filePath = path.join(__dirname, "sent-to-agon.json");
  try {
    if (!fs.existsSync(filePath)) return new Set();
    const items = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return new Set(items.map(item => cleanText(item.subject || "")).filter(Boolean));
  } catch (error) {
    console.error("Erreur de lecture de sent-to-agon.json :", error.message);
    return new Set();
  }
}

// Repêche tous les contenus (articles + vidéos, tous médias confondus) dont le sujet n'a
// pas déjà été publié comme débat sur Agôn — pour le flux "Tribunes", qui affiche tout ce
// qui n'est pas (encore) devenu une arène, article par article plutôt que groupé par sujet.
// L'onglet Général y montre tout ; les onglets Gauche/Droite filtrent ensuite côté client
// sur le champ orientation de chaque contenu (cf. tribunes.html).
function extractOpinionItems(groups, publishedSubjectKeys) {
  const items = [];
  for (const group of groups) {
    if (publishedSubjectKeys.has(cleanText(group.subject))) continue;
    items.push(...group.contents);
  }

  return items.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function fallbackAiAnalysis(subject, arenaMode = "positions") {
  const hasBoth = subject.articleCount > 0 && subject.youtubeCount > 0;
  const fallbackText = arenaMode === "libre"
    ? limitDebateQuestionText(subject.subject)
    : limitDebateQuestionText(`Ce sujet mérite-t-il un débat public : ${subject.subject}`);
  return {
    arenaMode,
    debateScore: hasBoth ? 6 : 4,
    controversyLevel: hasBoth ? "moyen" : "faible",
    debateQuestion: fallbackText,
    resume: "",
    agonTheme: AGON_THEMES[0],
    positionA: "",
    positionB: "",
    keywords: extractNewsKeywords(subject),
    selectedLinks: applyExcludedLinks(subject, [])
  };
}

function limitText(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1).trimEnd() + "…";
}

function limitDebateQuestionText(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const maxLength = 110;
  const danglingWords = /(?:\s+(?:le|la|les|l|un|une|des|du|de|d|à|au|aux|et|ou|pour|par|avec|sans|malgré|face|contre|sur))$/i;

  function finalizeQuestion(value) {
    let stem = String(value || "")
      .replace(/[?？]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[,:;.!?…-]+$/g, "")
      .trim();
    stem = stem.replace(danglingWords, "").trim();
    if (!stem) return "";
    return `${stem} ?`;
  }

  const base = finalizeQuestion(raw);
  if (base.length <= maxLength) return base;

  const withoutQuestionMark = raw.replace(/[?？]+$/g, "").trim();
  const compactAlternative = finalizeQuestion(withoutQuestionMark.replace(/\s+(?:pour|afin de)\s+.+?\s+ou\s+/i, " ou "));
  return compactAlternative.length <= maxLength ? compactAlternative : base;
}

function makeSubjectId(index) {
  return `subject_${String(index + 1).padStart(3, "0")}`;
}

function ensureSubjectIds(subjects) {
  return (Array.isArray(subjects) ? subjects : []).map((subject, index) => ({
    ...subject,
    subjectId: String(subject?.subjectId || makeSubjectId(index))
  }));
}

function normalizeKeywordList(values, max = 8) {
  const seen = new Set();
  const results = [];
  const tokens = [];

  (Array.isArray(values) ? values : []).forEach((value) => {
    const keyword = String(value || "")
      .replace(/^[-–—•\s]+/, "")
      .replace(/[?!.;,:\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!keyword) return;
    tokens.push(keyword);
  });

  tokens.forEach((keyword) => {
    if (!keyword) return;
    if (keyword.length < 2 || keyword.length > 28) return;
    const lower = keyword.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    results.push(keyword);
  });

  return results.slice(0, max);
}

function looksLikeBrokenKeyword(keyword, subject) {
  const value = String(keyword || "").trim();
  if (!value) return true;
  if (/\S\s{2,}\S/.test(value)) return true;
  if (/[A-Za-zÀ-ÖØ-öø-ÿ]\s{2,}[A-Za-zÀ-ÖØ-öø-ÿ]/.test(value)) return true;
  if (/\b[A-Za-zÀ-ÖØ-öø-ÿ]\b\s+[A-Za-zÀ-ÖØ-öø-ÿ]{3,}/.test(value)) return true;
  if (subject && looksTruncatedKeyword(value, subject)) return true;
  return false;
}

// Détecte un tag coupé en cours de mot (ex. "Indemnit" pour "Indemnité"),
// fréquent quand la réponse IA est tronquée : le dernier mot du tag n'existe
// nulle part tel quel dans les sources, mais un mot plus long commençant par
// le même préfixe, lui, y figure.
function looksTruncatedKeyword(keyword, subject) {
  const words = String(keyword || "").trim().split(/\s+/).filter(Boolean);
  const lastWord = words[words.length - 1] || "";
  if (lastWord.length < 4) return false;

  const lastKey = normalizeKeywordRepairKey(lastWord);
  if (!lastKey) return false;

  const sourceWords = [
    subject?.subject || "",
    ...((Array.isArray(subject?.contents) ? subject.contents : []).slice(0, 10).flatMap((content) => [
      content?.title || "",
      content?.summary || ""
    ]))
  ].join(" ")
    .split(/[^\p{L}\p{N}'’-]+/u)
    .map(normalizeKeywordRepairKey)
    .filter(Boolean);

  if (sourceWords.includes(lastKey)) return false;
  return sourceWords.some((word) => word.length > lastKey.length && word.startsWith(lastKey));
}

function normalizeKeywordRepairKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function getKeywordRepairCandidates(subject) {
  const chunks = [
    subject?.subject || "",
    ...((Array.isArray(subject?.contents) ? subject.contents : []).slice(0, 10).flatMap((content) => [
      content?.title || "",
      content?.summary || ""
    ]))
  ].filter(Boolean);

  const candidates = [];

  chunks.forEach((chunk) => {
    const words = String(chunk || "")
      .replace(/[“”"«»()[\]{}]/g, " ")
      .split(/\s+/)
      .map((word) => word.replace(/^[-–—•,.;:!?]+|[-–—•,.;:!?]+$/g, "").trim())
      .filter(Boolean);

    for (let start = 0; start < words.length; start += 1) {
      for (let length = 1; length <= 5 && start + length <= words.length; length += 1) {
        const phrase = words.slice(start, start + length).join(" ").trim();
        if (phrase.length >= 2 && phrase.length <= 60) candidates.push(phrase);
      }
    }
  });

  return candidates;
}

function repairKeywordFromSources(subject, keyword) {
  const value = String(keyword || "").replace(/\s+/g, " ").trim();
  if (!value) return value;

  if (!looksLikeBrokenKeyword(value, subject)) {
    return value;
  }

  const brokenKey = normalizeKeywordRepairKey(value);
  if (!brokenKey) return value;

  const candidates = getKeywordRepairCandidates(subject);
  const match = candidates
    .map((candidate) => {
      const candidateValue = String(candidate || "").replace(/\s+/g, " ").trim();
      if (!candidateValue || looksLikeBrokenKeyword(candidateValue)) return null;

      const candidateKey = normalizeKeywordRepairKey(candidateValue);
      if (!candidateKey) return null;

      const lengthDelta = Math.abs(candidateKey.length - brokenKey.length);
      if (lengthDelta > 4) return null;

      const score = stringSimilarity.compareTwoStrings(candidateKey, brokenKey);
      const strongSubstringMatch = candidateKey.includes(brokenKey) || brokenKey.includes(candidateKey);
      if (!strongSubstringMatch && score < 0.78) return null;

      return { candidate: candidateValue, score, lengthDelta };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.lengthDelta - b.lengthDelta || a.candidate.length - b.candidate.length)[0];

  return match?.candidate || value;
}

function filterKeywordNoise(subject, values, max = 8) {
  const sourceNames = new Set(
    (Array.isArray(subject?.contents) ? subject.contents : [])
      .map((content) => String(content?.source || "").trim().toLowerCase())
      .filter(Boolean)
  );

  // Tags vus passer alors qu'ils sont incompréhensibles seuls : pays/villes/
  // institutions trop génériques pour "définir le mieux l'actualité" (cf. la
  // règle du prompt) — on l'impose ici plutôt que d'espérer que l'IA la suive.
  const genericStandalone = new Set([
    // noms communs vagues interdits par le prompt mais non enforced côté code
    "guerre", "guerres", "crise", "crises", "conflit", "conflits",
    "tensions", "tension", "polemique", "scandale", "incident", "tragedie",
    "evenement", "actualite", "information", "nouvelles", "faits", "dossier",
    // nationalité / gentilés isolés
    "france", "francais", "francaise", "europeen", "europeenne", "international",
    // pays — liste étendue pour couvrir les cas courants en veille francophone
    "chine", "etatsunis", "usa", "russie", "ukraine", "israel", "iran", "irak",
    "syrie", "liban", "palestine", "allemagne", "espagne", "italie", "royaumeuni",
    "japon", "bresil", "inde", "canada", "mexique", "portugal", "belgique", "suisse",
    "turquie", "grece", "pologne", "maroc", "algerie", "tunisie", "egypte",
    "arabie", "afghanistan", "pakistan", "nigeria", "senegal", "venezuela",
    "colombie", "argentine", "taiwan", "coree", "philippines", "australie",
    "suede", "norvege", "danemark", "finlande", "autriche", "hongrie",
    "roumanie", "serbie",
    // grandes villes seules
    "paris", "londres", "berlin", "madrid", "rome", "pekin", "newyork", "moscou",
    "washington", "tokyo", "bruxelles", "geneve", "vienne", "varsovie",
    "istanbul", "teheran", "bagdad", "beyrouth", "damas", "kaboul", "islamabad",
    "caire", "riyad", "lagos", "nairobi",
    // institutions trop génériques seules
    "assemblee", "senat", "gouvernement", "parlement", "elysee", "matignon",
    "onu", "otan", "omc", "fmi", "ue", "unioneuropeenne", "conseileuropeen",
    "conseilconstitutionnel"
  ]);

  const weakSingleWordTags = new Set([
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

  const repairedValues = (Array.isArray(values) ? values : []).map((keyword) => repairKeywordFromSources(subject, keyword));

  return normalizeKeywordList(repairedValues, max).filter((keyword) => {
    const trimmed = String(keyword || "").trim();
    const lower = trimmed.toLowerCase();
    if (!lower) return false;
    // Volontairement sans `subject` ici : la détection de troncature ne doit
    // servir qu'à déclencher une réparation (cf. repairKeywordFromSources,
    // appelé juste au-dessus) — l'utiliser pour rejeter ferait passer un
    // simple écart grammatical AI/source (singulier vs pluriel, etc.) pour
    // une troncature et jetterait un tag tout à fait correct.
    if (looksLikeBrokenKeyword(keyword)) return false;
    if (sourceNames.has(lower)) return false;
    // un chiffre suivi d'un décompte humain ne nomme rien ("24 morts", "300 blessés") ;
    // on cible ce motif précis pour ne pas bloquer des tags datés légitimes ("1er mai", "11-Septembre")
    if (/^\d+\s*(?:e|er|ère|ème)?\s+(morts?|blessés?|victimes?|décès|tués?|disparus?|interpellations?|arrestations?|otages?|personnes?)\b/i.test(trimmed)) return false;

    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount === 1 && genericStandalone.has(normalizeKeywordRepairKey(trimmed))) return false;
    if (wordCount === 1 && isWeakSingleWordKeyword(subject, trimmed, weakSingleWordTags)) return false;

    return true;
  }).slice(0, max);
}

function isWeakSingleWordKeyword(subject, keyword, weakSingleWordTags) {
  const value = String(keyword || "").trim();
  if (!value || /\s/.test(value)) return false;

  const key = normalizeKeywordRepairKey(value);
  if (!key) return true;
  if (weakSingleWordTags.has(key)) return true;

  // Un mot seul est fragile : on ne le garde que s'il ressemble clairement a un
  // nom propre, une marque, un sigle ou un phenomene nomme present dans les sources.
  if (/^[A-Z0-9][A-Z0-9-]{1,9}$/.test(value)) return false;
  if (!/^[A-ZÀ-ÖØ-Ý]/.test(value)) return true;

  const sourceText = [
    subject?.subject || "",
    ...((Array.isArray(subject?.contents) ? subject.contents : []).slice(0, 10).flatMap((content) => [
      content?.title || "",
      content?.summary || ""
    ]))
  ].join(" ");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !new RegExp(`(^|[^\\p{L}\\p{N}])${escapedValue}([^\\p{L}\\p{N}]|$)`, "u").test(sourceText);
}

function extractNewsKeywords(subject) {
  const text = [
    subject.subject || "",
    ...((subject.contents || []).slice(0, 10).map((content) => content.title || ""))
  ].join(" ");
  const rawMatches = String(text).match(/(?<![\p{L}\p{N}])(?:[A-ZÀ-ÖØ-Ý][\p{L}''\-]+(?:\s+[A-ZÀ-ÖØ-Ý][\p{L}''\-]+){0,2}|[A-Z]{2,}(?:\s+[A-Z]{2,})*)(?![\p{L}\p{N}])/gu) || [];
  const blacklist = new Set([
    "EN DIRECT",
    "DIRECT",
    "France",
    "Français",
    "Française",
    "Mardi",
    "Mercredi",
    "Jeudi",
    "Vendredi",
    "Samedi",
    "Dimanche",
    "Lundi"
  ].map((item) => item.toLowerCase()));

  const cleaned = rawMatches.filter((item) => !blacklist.has(String(item || "").trim().toLowerCase()));
  return filterKeywordNoise(subject, cleaned, 8);
}

function normalizeUrl(url) {
  const withoutHash = String(url || "").trim().split("#")[0];
  const [base, query = ""] = withoutHash.split("?");
  const cleanedBase = base.replace(/\/+$/, "");

  // Sur YouTube, l'identifiant de la vidéo vit dans la query string (?v=...) :
  // le tronquer ferait correspondre toutes les vidéos "watch" entre elles.
  const videoIdMatch = query.match(/(?:^|&)v=([^&]+)/);
  if (videoIdMatch && /youtube\.com\/watch/i.test(cleanedBase)) {
    return `${cleanedBase}?v=${videoIdMatch[1]}`;
  }

  return cleanedBase;
}

// Toutes les sources sont gardées par défaut ; l'IA ne renvoie que les liens
// à exclure (hors sujet). Une URL d'exclusion qui ne correspond à aucun
// contenu réel est ignorée : l'erreur joue toujours dans le sens "garder".
// Copie de getMediaOrientationGroup (server.js) : les deux fichiers tournent en
// processus séparés (server.js / veille-mixte.js), sans require croisé.
function getMediaOrientationGroup(orientation) {
  const o = String(orientation || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (
    o.includes("gauche") || o.includes("ecolog") || o.includes("ecolo") || o.includes("libertaire") ||
    o.includes("altermondialiste") || o.includes("alter-mondialiste") || o.includes("anticapitaliste") ||
    o.includes("anti-capitaliste") || o.includes("socialiste") || o.includes("social-democrate") ||
    o.includes("social democrate") || o.includes("progressiste") || o.includes("insoumis") ||
    o.includes("insoumission") || o.includes("communiste") || o.includes("marxiste") ||
    o.includes("feministe") || o.includes("syndical") || o.includes("alternatif") || o.includes("alternative")
  ) return "left";
  if (
    o.includes("droite") || o.includes("centre-droit") || o.includes("centre droit") ||
    o.includes("droite-centre") || o.includes("droite centre") || o.includes("conservateur") ||
    o.includes("souverainiste") || o.includes("liberal") || o.includes("republicain") || o.includes("identitaire")
  ) return "right";
  return "center";
}

function applyExcludedLinks(subject, excludedLinks) {
  const contents = Array.isArray(subject?.contents) ? subject.contents : [];
  const validLinks = contents.map((content) => String(content.link || "").trim()).filter(Boolean);

  const excluded = new Set(
    (Array.isArray(excludedLinks) ? excludedLinks : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .map((aiLink) => {
        if (validLinks.includes(aiLink)) return aiLink;
        const normAi = normalizeUrl(aiLink);
        return validLinks.find((vl) => normalizeUrl(vl) === normAi
          || vl.startsWith(aiLink)
          || aiLink.startsWith(vl)
        ) || null;
      })
      .filter(Boolean)
  );

  // Garde-fou : ne jamais exclure la SEULE source d'un bord politique (gauche/droite)
  // sur ce sujet. medias.json a beaucoup moins de titres classés "droite" que
  // gauche/centre : un sujet n'a très souvent qu'une unique source de droite (voire
  // aucune), donc la moindre exclusion — même légitime — fait tomber ce bord à zéro et
  // rend la bulle correspondante impubliable (aucune source du bon camp). Mesuré sur
  // 12 sessions réelles (5-9 juillet 2026) : 14 sujets ont perdu toute source droite
  // après exclusion contre seulement 2 pour la gauche, alors que les deux bords avaient
  // un nombre comparable de sujets éligibles (365 vs 338) — la gauche encaisse ces
  // exclusions grâce à ses sources de secours, la droite n'en a généralement pas.
  for (const group of ["left", "right"]) {
    const groupContents = contents.filter((c) => getMediaOrientationGroup(c.orientation) === group);
    if (groupContents.length !== 1) continue;
    const soleLink = String(groupContents[0].link || "").trim();
    if (soleLink) excluded.delete(soleLink);
  }

  return validLinks.filter((link) => !excluded.has(link));
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

async function generateAgonThemeWithAI(payload) {
  const subject = String(payload?.subject || "").trim();
  if (!openai || !subject) return { agonTheme: AGON_THEMES[0] };

  const question = String(payload?.question || "").trim();
  const resume = String(payload?.resume || "").trim();
  const sources = Array.isArray(payload?.sources) ? payload.sources.filter(Boolean) : [];
  const keywords = Array.isArray(payload?.keywords) ? payload.keywords.filter(Boolean) : [];

  const prompt = `Tu choisis la thématique éditoriale Agôn la plus adaptée à cette actualité, une fois l'article et les mots-clés déjà finalisés.

Sujet :
${subject}

Question de débat ou titre :
${question || "(non précisé)"}

Article :
${resume.slice(0, 2000) || "(non précisé)"}

Mots-clés : ${keywords.join(", ") || "aucun"}
Sources : ${sources.join(", ") || "aucune"}

Choisis uniquement une valeur exacte dans cette liste :
${AGON_THEMES.map(theme => `- ${theme}`).join("\n")}

Ne crée jamais une autre thématique.

Réponds uniquement en JSON valide, sans texte autour :
{ "agonTheme": "une thématique Agôn exacte" }`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
      temperature: 0.1,
      max_output_tokens: 200
    });
    logAiUsage("theme-agon", response);
    const parsed = safeJsonParse(response.output_text);
    return { agonTheme: normalizeAgonTheme(parsed.agonTheme) };
  } catch (error) {
    console.error(`Erreur IA thématique pour "${subject}" :`, error.message);
    return { agonTheme: AGON_THEMES[0] };
  }
}

async function generateSubjectTagsWithAI(subject, compactContents = null) {
  // Tag sentinelle volontairement reconnaissable : quand la génération échoue
  // (IA non configurée, tag rejeté par les filtres, erreur API), on sort
  // "Actu" plutôt qu'un mot-clé regex médiocre — voir "Actu" en production
  // signale immédiatement un bug à corriger, là où l'ancien fallback masquait
  // le problème.
  const fallbackMainKeyword = "Actu";
  if (!openai) return { mainKeyword: fallbackMainKeyword };

  const articleText = String(subject.articleText || "").trim();

  let sourceSection;
  if (articleText) {
    sourceSection = `Article généré :\n${articleText.slice(0, 4000)}`;
  } else {
    const contents = Array.isArray(compactContents)
      ? compactContents
      : subject.contents.slice(0, 10).map(content => ({
          type: content.type,
          source: content.source,
          orientation: content.orientation,
          title: content.title,
          summary: content.summary || "",
          link: content.link || ""
        }));
    sourceSection = `Contenus :\n${JSON.stringify(contents, null, 2)}`;
  }

  // Sans cette date, le modèle devine l'année depuis ses données d'entraînement
  // et produit des tags faussement datés (ex. "Grève SNCF juin 2024" pour une
  // actualité courante).
  const todayLabel = new Date().toLocaleDateString("fr-FR", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris"
  });

  const prompt = `
Tu es chargé d'extraire le tag éditorial principal d'une actualité pour une plateforme de débat.

Date du jour : ${todayLabel}. L'actualité traitée est récente.

Réponds uniquement en JSON valide avec cette structure :
{
  "mainKeyword": "le tag principal",
  "alternatives": ["variante plus courte", "variante encore plus courte"]
}

Règle centrale :
- "mainKeyword" est obligatoire ;
- "alternatives" contient exactement 2 reformulations du même tag, de plus en plus courtes, classées de la plus précise à la plus compacte ; chaque alternative doit respecter toutes les règles ci-dessous au même titre que "mainKeyword" ;
- il doit définir le mieux l'actualité ;
- il doit être immédiatement compréhensible seul, sans lire le titre ;
- il doit nommer l'objet central de l'actualité : acteur, pays, institution, lieu, événement, loi, conflit, affaire ou phénomène précis ;
- il ne doit pas être trop générique : proscris les mots vagues seuls comme "Tensions", "Crise", "Conflit", "Polémique", "Scandale", "Tensions diplomatiques" — ils ne nomment rien de précis ; s'ils apparaissent, associe-les obligatoirement à l'acteur, le pays, le lieu ou l'événement concerné (ex. "Tensions Chine-Taïwan" plutôt que "Tensions") ;
  Exemple insuffisant : "Tensions commerciales" — ne nomme aucun acteur ni pays précis, applicable à n'importe quel conflit commercial.
  Exemple valable : "Tensions commerciales USA-Chine" — nomme les deux acteurs concernés, compréhensible immédiatement sans lire le titre.
- il ne doit pas se limiter à un nom de pays seul (France, Chine, États-Unis, Russie, Allemagne, etc.) ni à une grande ville seule (Paris, New York, Pékin, Londres, etc.) ; en revanche, un pays ou une ville peut apparaître associé à l'événement, l'acteur ou l'institution concerné (ex. "Émeutes Paris", "Élections Allemagne") ;
- il ne doit jamais être un nom d'institution seul (Assemblée, Sénat, Gouvernement, ONU…) ni un chiffre seul (24 morts, 300 blessés…) : ces formulations ne nomment rien de précis ;
- si l'actualité s'inscrit dans un conflit ou une série déjà traitée ailleurs (ex. guerre au Moyen-Orient, guerre en Ukraine), ne reprends jamais l'intitulé générique du conflit : nomme l'épisode précis de cette actualité (l'attaque, le lieu, les acteurs de ce jour précis) pour qu'il se distingue des autres tags du même conflit ;
- n'inclus jamais de date (année, mois) dans le tag, sauf si elle figure explicitement dans le sujet ou les sources fournies ; n'invente jamais une date à partir de tes connaissances générales — un tag sans date vaut toujours mieux qu'un tag avec une date erronée ;
- évite les tags d'un seul mot sauf s'il s'agit clairement d'un nom propre, d'une marque, d'un acteur, d'un sigle ou d'un événement immédiatement identifiable ; refuse les mots seuls faibles comme "Coupe", "Refoulés", "Réforme", "Vote", "Attaque", "Grève" : associe-les à l'objet précis ("Coupe du monde", "Migrants refoulés", "Réforme des retraites", etc.) ;
- il doit faire 28 caractères maximum, espaces compris ; ne tronque jamais un mot en cours de route — choisis un tag plus court plutôt qu'un mot coupé.

Exemples de tags refusés sur cette plateforme, à ne jamais reproduire :
- "Paris" pour un article sur le sacre du PSG en Ligue des champions → nom de ville seul, hors-sujet ; il fallait nommer le club ou l'événement ("Sacre du PSG en C1") ;
- "Assemblée" pour un vote à l'Assemblée nationale → institution seule, ne dit rien du texte voté ;
- "24 morts" pour un attentat ferroviaire → un chiffre seul ne nomme ni le lieu ni l'événement ;
- "Machghara" pour des bombardements au Liban → nom de lieu isolé et inconnu du lecteur, incompréhensible seul ; il fallait l'associer au fait ("Frappes à Machghara, Liban") ;
- "guerre au Moyen-Orient" recopié à l'identique sur plusieurs actualités différentes du même conflit → pas assez précis pour distinguer cet épisode des autres ; il fallait nommer l'épisode exact ("frappe israélienne à Tyr", "frappes USA-Iran sur Natanz") ;
- "Grève SNCF juin 2024" pour une grève en cours → date inventée, absente des sources ; il fallait "Grève SNCF" ou préciser l'objet du mouvement ("Grève SNCF des contrôleurs").

Sujet principal :
${subject.subject}

Sources :
${subject.sources.slice(0, SCORING_MAX_SOURCE_NAMES).join(", ")}

${sourceSection}
`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.15,
      // Budget calibré pour 3 tags accentués + la structure JSON ; trop juste,
      // il couperait la réponse en plein mot (ex. "Indemnit" au lieu
      // d'"Indemnité") — la marge supplémentaire coûte peu sur un appel
      // aussi court.
      max_output_tokens: 300
    });
    logAiUsage("tags-sujet", response);

    const parsed = safeJsonParse(response.output_text);
    const candidates = [
      parsed.mainKeyword,
      ...(Array.isArray(parsed.alternatives) ? parsed.alternatives : [])
    ];
    // On garde le premier candidat qui survit aux filtres : si le tag
    // principal est rejeté (trop long, trop générique…), une variante plus
    // courte prend sa place au lieu de tomber sur le tag sentinelle "Actu".
    // max = candidates.length, sinon normalizeKeywordList tronquerait la
    // liste avant le filtrage et jetterait les variantes de secours.
    const mainKeyword = filterKeywordNoise(subject, candidates, candidates.length)[0] || "";
    return { mainKeyword: mainKeyword || fallbackMainKeyword };
  } catch (error) {
    console.error(`Erreur IA tags pour le sujet "${subject.subject}" :`, error.message);
    return { mainKeyword: fallbackMainKeyword };
  }
}

async function analyzeOneSubjectWithAI(subject) {
  if (!openai) {
    const fallback = fallbackAiAnalysis(subject, subject.arenaMode);
    return {
      ...fallback,
      debateQuestion: "",
      resume: "",
      positionA: "",
      positionB: ""
    };
  }

  const compactContents = (Array.isArray(subject.contents) ? subject.contents : []).slice(0, SCORING_MAX_CONTENTS).map(content => ({
    type: content.type,
    source: content.source,
    orientation: content.orientation,
    title: content.title,
    summary: String(content.summary || "").slice(0, 1200),
    link: content.link || ""
  }));

  const arenaMode = subject.arenaMode === "libre" ? "libre" : "positions";
  const prompt = `
Analyse ce sujet de veille et évalue son potentiel de débat public.

Mode d'arène demandé :
${arenaMode === "libre" ? "arène libre" : "arène à positions"}

Tu dois répondre uniquement en JSON valide avec ces champs :
{
  "debateScore": nombre entier de 0 à 10,
  "controversyLevel": "faible" | "moyen" | "fort" | "très fort",
  "excludedLinks": ["URLs des seuls contenus qui ne parlent pas du tout de ce sujet"],
  "agonTheme": "une thématique Agôn exacte"
}

Critères pour debateScore — sois exigeant, la note haute se mérite :
- 0 à 3 : sujet factuel, pas débattable — fait divers, drame, accident, meurtre, disparition, catastrophe, sujet people, événement purement factuel, guerre racontée seulement par ses faits (attaque, bombardement, bilan, avancée militaire, morts, opération) ;
- 4 à 5 : débat faible ou forcé — un désaccord est imaginable mais le titre et les contenus ne le montrent pas ;
- 6 à 7 : débat possible — une décision publique, une réforme, une loi ou une controverse est présente, avec deux positions envisageables ;
- 8 à 10 : vrai sujet clivant, politique ou polémique — désaccord explicite dans les contenus : réforme contestée, décision gouvernementale critiquée, opposition majorité/opposition, polémique publique, tension de valeurs nommée (liberté/sécurité, écologie/économie, justice/coût, souveraineté/Europe…), avec deux positions clairement possibles.

Favorise fortement : débat politique, polémique, controverse, désaccord public, réforme contestée, décision gouvernementale critiquée, opposition majorité/opposition, tensions entre valeurs (liberté/sécurité, écologie/économie, justice/coût, souveraineté/Europe).
Baisse fortement : faits divers, drames, accidents, meurtres, disparitions, catastrophes, sujets people, événements purement factuels, sujets de guerre uniquement factuels (attaque, bombardement, bilan, avancée militaire, morts, opération).

Règle essentielle : un sujet choquant ou triste n'est pas forcément débattable. Un fait divers ou une guerre ne mérite un bon score que si les contenus contiennent explicitement un vrai débat public plus large : justice, sécurité, récidive, politique pénale, intervention militaire, sanctions, livraison d'armes, reconnaissance d'un État, responsabilité d'un gouvernement, etc.
Ne jamais inventer un clivage : si le titre ou les résumés ne montrent pas clairement un désaccord, mets un score bas.

Exemples de scores bas : "Le corps d'une adolescente retrouvé", "Trois morts dans un accident", "Bombardements en Ukraine", "Incendie dans un immeuble".
Exemples de scores hauts : "Immigration : une réforme contestée", "Budget : l'opposition dénonce des coupes", "Sécurité : faut-il étendre la vidéosurveillance ?", "Ukraine : la livraison d'armes divise les alliés".

Pour le champ "agonTheme", choisis uniquement une valeur exacte dans cette liste :
${AGON_THEMES.map(theme => `- ${theme}`).join("\n")}

Ne crée jamais une autre thématique.

Pour "excludedLinks" :
- toutes les sources sont gardées par défaut : renvoie uniquement les URLs des contenus qui ne parlent pas du tout du sujet principal ;
- exclus uniquement les sources qui traitent d'un sujet réellement différent ou sans lien avec cette affaire/cet événement, même si elles concernent les mêmes acteurs, le même pays ou la même institution ;
- si le sujet est une affaire ou un feuilleton d'actualité qui regroupe plusieurs rebondissements (auditions, propositions de loi, réactions politiques, gardes à vue, mesures annoncées, etc.), ne renvoie pas les sources qui couvrent un de ces rebondissements : elles parlent bien du sujet ;
- en cas de doute, ne renvoie pas la source : l'exclusion est réservée aux hors-sujet manifestes ;
- si toutes les sources parlent du sujet, renvoie une liste vide ;
- n'invente jamais d'URL ;
- utilise uniquement les valeurs exactes du champ "link" dans les contenus.

Ne génère pas de tags, pas de question de débat, pas de positions A/B et pas de résumé narratif à cette étape.

Sujet principal :
${subject.subject}

Sources :
${subject.sources.slice(0, SCORING_MAX_SOURCE_NAMES).join(", ")}

Contenus :
${JSON.stringify(compactContents, null, 2)}
`;


  try {
    const response = await openai.responses.create({
      model: SCORING_AI_MODEL,
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 1500
    });
    logAiUsage("analyze-sujet", response);

    const text = response.output_text;
    const parsed = safeJsonParse(text);

    const selectedLinks = applyExcludedLinks(subject, parsed.excludedLinks);
    return {
      arenaMode,
      debateScore: Number.isInteger(parsed.debateScore) ? parsed.debateScore : 0,
      controversyLevel: parsed.controversyLevel || "faible",
      debateQuestion: "",
      resume: "",
      keywords: [],
      selectedLinks,
      agonTheme: normalizeAgonTheme(parsed.agonTheme),
      positionA: "",
      positionB: ""
    };
  } catch (error) {
    console.error(`Erreur IA pour le sujet "${subject.subject}" :`, error.message);
    const fallback = fallbackAiAnalysis(subject, arenaMode);
    return {
      ...fallback,
      debateQuestion: "",
      resume: "",
      positionA: "",
      positionB: ""
    };
  }
}

// Modèle des appels de scoring (classification pure) — gpt-4o-mini est ~2,7×
// moins cher que gpt-4.1-mini en entrée et suffit pour noter un potentiel de débat.
const SCORING_AI_MODEL = "gpt-4o-mini";

// Plafonds des prompts de scoring/vérification : la fusion inter-sessions fait grossir
// les sujets feuilletons (jusqu'à 327 contenus observés le 06/07/2026), et chaque appel
// embarquait la totalité. 30 contenus suffisent largement à noter un potentiel de débat.
// Les contenus au-delà du plafond ne sont pas montrés au modèle : ils sont gardés par
// défaut, applyExcludedLinks n'exclut que les URLs explicitement listées.
const SCORING_MAX_CONTENTS = 30;
const SCORING_MAX_SOURCE_NAMES = 40;

// Chaque résumé est plafonné dans le payload de scoring : au-delà, il n'apporte
// plus rien à une note de 0 à 10 mais gonfle la facture (outlier observé : un
// sujet à 32 000 caractères de contenus).
function compactContentsForScoring(subject) {
  return (Array.isArray(subject.contents) ? subject.contents : []).slice(0, SCORING_MAX_CONTENTS).map(content => ({
    type: content.type,
    source: content.source,
    orientation: content.orientation,
    title: content.title,
    summary: String(content.summary || "").slice(0, 1200),
    link: content.link || ""
  }));
}

// Règles partagées entre le scoring unitaire et le scoring par lot. Elles ouvrent
// le prompt (partie statique) pour que le cache automatique d'OpenAI s'applique
// d'un appel au suivant ; les données variables vont en fin de prompt.
const SCORING_RULES = `Critères pour debateScore — sois exigeant, la note haute se mérite :
- 0 à 3 : sujet factuel, pas débattable — fait divers, drame, accident, meurtre, disparition, catastrophe, sujet people, événement purement factuel, guerre racontée seulement par ses faits (attaque, bombardement, bilan, avancée militaire, morts, opération)
- 4 à 5 : débat faible ou forcé — un désaccord est imaginable mais le titre et les contenus ne le montrent pas
- 6 à 7 : débat possible — une décision publique, une réforme, une loi ou une controverse est présente, avec deux positions envisageables
- 8 à 10 : vrai sujet clivant, politique ou polémique — désaccord explicite dans les contenus : réforme contestée, décision gouvernementale critiquée, opposition majorité/opposition, polémique publique, tension de valeurs nommée (liberté/sécurité, écologie/économie, justice/coût, souveraineté/Europe…), avec deux positions clairement possibles

Favorise fortement : débat politique, polémique, controverse, désaccord public, réforme contestée, décision gouvernementale critiquée, opposition majorité/opposition, tensions entre valeurs (liberté/sécurité, écologie/économie, justice/coût, souveraineté/Europe).
Baisse fortement : faits divers, drames, accidents, meurtres, disparitions, catastrophes, sujets people, événements purement factuels, sujets de guerre uniquement factuels (attaque, bombardement, bilan, avancée militaire, morts, opération).

Règle essentielle : un sujet choquant ou triste n'est pas forcément débattable. Un fait divers ou une guerre ne mérite un bon score que si les contenus contiennent explicitement un vrai débat public plus large : justice, sécurité, récidive, politique pénale, intervention militaire, sanctions, livraison d'armes, reconnaissance d'un État, responsabilité d'un gouvernement, etc.
Ne jamais inventer un clivage : si le titre ou les résumés ne montrent pas clairement un désaccord, mets un score bas.

Exemples de scores bas : "Le corps d'une adolescente retrouvé", "Trois morts dans un accident", "Bombardements en Ukraine", "Incendie dans un immeuble".
Exemples de scores hauts : "Immigration : une réforme contestée", "Budget : l'opposition dénonce des coupes", "Sécurité : faut-il étendre la vidéosurveillance ?", "Ukraine : la livraison d'armes divise les alliés".

Pour "excludedLinks" :
- toutes les sources sont gardées par défaut : renvoie uniquement les URLs des contenus qui ne parlent pas du tout du sujet principal ;
- exclus uniquement les sources qui traitent d'un sujet réellement différent ou sans lien avec cette affaire/cet événement, même si elles concernent les mêmes acteurs, le même pays ou la même institution ;
- si le sujet est une affaire ou un feuilleton d'actualité qui regroupe plusieurs rebondissements (auditions, propositions de loi, réactions politiques, gardes à vue, mesures annoncées, etc.), ne renvoie pas les sources qui couvrent un de ces rebondissements : elles parlent bien du sujet ;
- en cas de doute, ne renvoie pas la source : l'exclusion est réservée aux hors-sujet manifestes ;
- si toutes les sources parlent du sujet, renvoie une liste vide ;
- n'invente jamais d'URL ; utilise uniquement les valeurs exactes du champ "link" dans les contenus.`;

async function analyzeOneScoreWithAI(subject) {
  if (!openai) {
    const fb = fallbackAiAnalysis(subject);
    return { debateScore: fb.debateScore, controversyLevel: fb.controversyLevel };
  }

  const prompt = `
Analyse ce sujet de veille et évalue son potentiel.

Tu dois répondre uniquement en JSON valide avec ces champs :
{
  "debateScore": nombre entier de 0 à 10,
  "controversyLevel": "faible" | "moyen" | "fort" | "très fort",
  "excludedLinks": ["URLs des seuls contenus qui ne parlent pas du tout du sujet"]
}

${SCORING_RULES}

Sujet principal :
${subject.subject}

Sources :
${subject.sources.slice(0, SCORING_MAX_SOURCE_NAMES).join(", ")}

Contenus :
${JSON.stringify(compactContentsForScoring(subject), null, 2)}
`;

  try {
    const response = await openai.responses.create({
      model: SCORING_AI_MODEL,
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 2000
    });
    logAiUsage("score-unitaire", response);

    const parsed = safeJsonParse(response.output_text);
    const selectedLinks = applyExcludedLinks(subject, parsed.excludedLinks);
    return {
      debateScore: Number.isInteger(parsed.debateScore) ? parsed.debateScore : 0,
      controversyLevel: parsed.controversyLevel || "faible",
      selectedLinks
    };
  } catch (error) {
    console.error(`Erreur IA (score) pour "${subject.subject}" :`, error.message);
    const fb = fallbackAiAnalysis(subject);
    return { debateScore: fb.debateScore, controversyLevel: fb.controversyLevel, selectedLinks: applyExcludedLinks(subject, []) };
  }
}

async function verifySourcesWithAI(subject) {
  if (!openai) return applyExcludedLinks(subject, []);

  const compactContents = subject.contents.slice(0, SCORING_MAX_CONTENTS).map(content => ({
    source: content.source,
    title: content.title,
    summary: String(content.summary || "").slice(0, 1200),
    link: content.link || ""
  }));

  const prompt = `Vérifie quelles sources parlent réellement du sujet suivant.

Sujet : ${subject.subject}

Contenus :
${JSON.stringify(compactContents, null, 2)}

Réponds uniquement en JSON valide :
{ "excludedLinks": ["URLs des seuls contenus qui ne parlent pas du tout du sujet"] }

Règles :
- toutes les sources sont gardées par défaut : renvoie uniquement les URLs des contenus qui ne parlent pas du tout du sujet principal ;
- exclus uniquement les sources qui traitent d'un sujet réellement différent ou sans lien avec cette affaire/cet événement, même si elles concernent les mêmes acteurs, le même pays ou la même institution ;
- si le sujet est une affaire ou un feuilleton d'actualité qui regroupe plusieurs rebondissements (auditions, propositions de loi, réactions politiques, gardes à vue, mesures annoncées, etc.), ne renvoie pas les sources qui couvrent un de ces rebondissements : elles parlent bien du sujet ;
- en cas de doute, ne renvoie pas la source : l'exclusion est réservée aux hors-sujet manifestes ;
- si toutes les sources parlent du sujet, renvoie une liste vide ;
- n'invente jamais d'URL ; utilise uniquement les valeurs exactes du champ "link" dans les contenus.`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.1,
      max_output_tokens: 2000
    });
    logAiUsage("verif-sources", response);
    const parsed = safeJsonParse(response.output_text);
    return applyExcludedLinks(subject, parsed.excludedLinks);
  } catch (error) {
    console.error(`Erreur IA (vérification sources) pour "${subject.subject}" :`, error.message);
    return applyExcludedLinks(subject, []);
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
    articleText: String(body?.articleText || "").trim(),
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

apiApp.post("/verify-sources", async (req, res) => {
  try {
    const payload = buildAnalyzePayload(req.body);
    if (!payload.subject) return res.status(400).json({ error: "Sujet manquant" });
    const selectedLinks = await verifySourcesWithAI(payload);
    res.json({ selectedLinks });
  } catch (error) {
    res.status(500).json({ error: error.message || "Erreur vérification sources" });
  }
});

apiApp.post("/generate-tags", async (req, res) => {
  try {
    const payload = buildAnalyzePayload(req.body);
    if (!payload.subject) {
      return res.status(400).json({ ok: false, error: "Sujet manquant" });
    }

    const tags = await generateSubjectTagsWithAI(payload);
    res.json({ ok: true, mainKeyword: tags.mainKeyword || "" });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Erreur génération tags" });
  }
});

apiApp.post("/generate-theme", async (req, res) => {
  try {
    const body = req.body || {};
    if (!String(body.subject || "").trim()) {
      return res.status(400).json({ ok: false, error: "Sujet manquant" });
    }
    const result = await generateAgonThemeWithAI(body);
    res.json({ ok: true, agonTheme: result.agonTheme });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Erreur génération thématique" });
  }
});

apiApp.post("/refresh", async (req, res) => {
  if (isRunning) {
    return res.json({ ok: true, running: true });
  }

  const rawMin = Number((req.body || {}).minSources);
  const minSources = Number.isInteger(rawMin) && rawMin >= 1 && rawMin <= 10 ? rawMin : MIN_DISTINCT_SOURCES;

  main(minSources).catch((error) => {
    console.error("Erreur refresh mixte :", error.message);
  });

  res.json({ ok: true, started: true });
});

apiApp.post("/save", (req, res) => {
  try {
    const body = req.body || {};
    const result = upsertSavedSubject(body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Erreur sauvegarde" });
  }
});

apiApp.post("/save-update", (req, res) => {
  try {
    const body = req.body || {};
    const subjectTitle = String(body.subject || "").trim();
    if (!subjectTitle) {
      return res.status(400).json({ ok: false, error: "Sujet manquant" });
    }

    const nextAi = body.ai && typeof body.ai === "object" ? body.ai : null;

    function applySubjectUpdate(subject) {
      const nextScore = Number.isFinite(Number(body.debateScore)) ? Number(body.debateScore) : Number(subject.debateScore || nextAi?.debateScore || 0);
      const nextControversy = String(body.controversyLevel || subject.controversyLevel || nextAi?.controversyLevel || "").trim();
      subject.debateScore = nextScore;
      subject.controversyLevel = nextControversy;
      subject.scoreAnalyzed = true;
      subject.aiAnalyzed = true;
      subject.ai = {
        ...(subject.ai || {}),
        ...(nextAi || {}),
        debateScore: nextScore,
        controversyLevel: nextControversy
      };
    }

    const sessions = loadSessions();
    let updated = false;

    sessions.forEach((session) => {
      const subjects = Array.isArray(session?.subjects) ? session.subjects : [];
      subjects.forEach((subject) => {
        if (String(subject?.subject || "").trim() !== subjectTitle) return;
        applySubjectUpdate(subject);
        updated = true;
      });
    });

    if (updated) {
      saveSessions(sessions);
      fs.writeFileSync(OUTPUT_HTML, generateHtml(sessions.slice(0, MAX_SESSIONS_TO_KEEP)), "utf8");
      return res.json({ ok: true, updated });
    }

    // Sujet introuvable dans la veille mixte : peut venir de Certamen, dont les
    // arènes générées par IA sont persistées dans certamen-sessions.json.
    const certamenSessions = loadCertamenSessions();
    let certamenUpdated = false;

    certamenSessions.forEach((session) => {
      const subjects = Array.isArray(session?.subjects) ? session.subjects : [];
      subjects.forEach((subject) => {
        if (String(subject?.subject || "").trim() !== subjectTitle) return;
        applySubjectUpdate(subject);
        certamenUpdated = true;
      });
    });

    if (certamenUpdated) {
      saveCertamenSessions(certamenSessions);
      fs.writeFileSync(CERTAMEN_OUTPUT_HTML, generateCertamenHtml(certamenSessions.slice(0, CERTAMEN_MAX_SESSIONS)), "utf8");
    }

    res.json({ ok: true, updated: certamenUpdated });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Erreur mise à jour session" });
  }
});

// Scoring par lot : un appel pour plusieurs sujets au lieu d'un appel par sujet.
// Le préambule (règles ~1100 tokens) n'est payé qu'une fois par lot au lieu
// d'une fois par sujet, et comme il ouvre le prompt, le cache OpenAI le facture
// à moitié prix d'un lot au suivant.
const SCORING_BATCH_SIZE = 8;
const SCORING_BATCH_MAX_CONTENT_CHARS = 26000;

async function analyzeScoreBatchWithAI(batch) {
  const payload = batch.map((subject, index) => ({
    id: index,
    subject: subject.subject,
    sources: subject.sources,
    contents: compactContentsForScoring(subject)
  }));

  const prompt = `
Analyse chaque sujet de veille de la liste et évalue son potentiel.

Tu dois répondre uniquement en JSON valide avec cette structure :
{
  "subjects": [
    { "id": 0, "debateScore": nombre entier de 0 à 10, "controversyLevel": "faible" | "moyen" | "fort" | "très fort", "excludedLinks": ["URLs des seuls contenus qui ne parlent pas du tout du sujet"] }
  ]
}
Rends exactement un objet par sujet fourni, dans le même ordre, en reprenant son "id" exact.
Évalue chaque sujet indépendamment des autres, avec les critères ci-dessous ; les règles "excludedLinks" s'appliquent aux contenus du sujet concerné uniquement.

${SCORING_RULES}

Sujets à analyser :
${JSON.stringify(payload, null, 2)}
`;

  const response = await openai.responses.create({
    model: SCORING_AI_MODEL,
    input: prompt,
    temperature: 0.2,
    max_output_tokens: 2500
  });
  logAiUsage("score-lot", response);
  if (response.status === "incomplete") throw new Error("réponse tronquée (max_output_tokens)");

  const parsed = safeJsonParse(response.output_text);
  const rows = Array.isArray(parsed.subjects) ? parsed.subjects : [];
  const byId = new Map(rows.map(row => [Number(row.id), row]));

  return batch.map((subject, index) => {
    const row = byId.get(index);
    if (!row || !Number.isInteger(row.debateScore)) {
      throw new Error(`sujet ${index} absent ou invalide dans la réponse du lot`);
    }
    return {
      debateScore: row.debateScore,
      controversyLevel: row.controversyLevel || "faible",
      selectedLinks: applyExcludedLinks(subject, row.excludedLinks)
    };
  });
}

async function analyzeScoresWithAI(subjects) {
  console.log(`${subjects.length} sujet(s) envoyés à l'analyse de score IA.`);
  const results = [];

  // Lots bornés en nombre ET en volume : un sujet aux contenus énormes ne doit
  // pas faire déborder le prompt du lot.
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const subject of subjects) {
    const chars = JSON.stringify(compactContentsForScoring(subject)).length;
    if (current.length && (current.length >= SCORING_BATCH_SIZE || currentChars + chars > SCORING_BATCH_MAX_CONTENT_CHARS)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(subject);
    currentChars += chars;
  }
  if (current.length) batches.push(current);

  let done = 0;
  for (const batch of batches) {
    setProgress(5, "Analyse IA", `${done} / ${subjects.length} sujets`);
    console.log(`Score IA (lot de ${batch.length}) : ${batch.map(s => s.subject).join(" | ")}`);
    let scores;
    try {
      scores = await analyzeScoreBatchWithAI(batch);
    } catch (error) {
      // Lot illisible ou incomplet : repli sujet par sujet pour ne rien perdre.
      console.warn(`Score IA : lot en échec (${error.message}), repli sujet par sujet.`);
      scores = [];
      for (const subject of batch) {
        scores.push(await analyzeOneScoreWithAI(subject));
      }
    }
    batch.forEach((subject, i) => {
      results.push({
        ...subject,
        debateScore: scores[i].debateScore,
        controversyLevel: scores[i].controversyLevel,
        selectedLinks: scores[i].selectedLinks,
        scoreAnalyzed: true,
        ai: null,
        aiAnalyzed: false
      });
    });
    done += batch.length;
  }

  return results.sort((a, b) => {
    if (b.debateScore !== a.debateScore) return b.debateScore - a.debateScore;
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    return b.contentCount - a.contentCount;
  });
}

function getControversyRank(level) {
  const value = String(level || "").trim().toLowerCase();
  if (value === "très fort" || value === "tres fort") return 4;
  if (value === "fort") return 3;
  if (value === "moyen") return 2;
  if (value === "faible") return 1;
  return 0;
}

function mergeSubjectRecords(keepSubject, mergeSubjects, suggestedTitle = "") {
  const group = [keepSubject, ...mergeSubjects].filter(Boolean);
  const contentsByKey = new Map();

  group.forEach((subject) => {
    (Array.isArray(subject.contents) ? subject.contents : []).forEach((content) => {
      const key = String(content?.link || "").trim() || `${content?.source || ""}::${content?.title || ""}`;
      if (!key) return;
      if (!contentsByKey.has(key)) contentsByKey.set(key, content);
    });
  });

  const contents = Array.from(contentsByKey.values()).sort((a, b) => {
    const order = { left: 0, center: 1, right: 2 };
    const oA = order[getOrientationGroup(a.orientation)] ?? 1;
    const oB = order[getOrientationGroup(b.orientation)] ?? 1;
    if (oA !== oB) return oA - oB;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  const sources = [...new Set(contents.map((content) => String(content?.source || "").trim()).filter(Boolean))];
  const bestScoreSubject = group
    .slice()
    .sort((a, b) => Number(b?.debateScore || 0) - Number(a?.debateScore || 0))[0] || keepSubject;
  const bestControversySubject = group
    .slice()
    .sort((a, b) => getControversyRank(b?.controversyLevel) - getControversyRank(a?.controversyLevel))[0] || keepSubject;

  const mergedSubjectIds = [...new Set(group.map((subject) => String(subject?.subjectId || "").trim()).filter(Boolean))];
  const mergedSubjectTitles = [...new Set(group.map((subject) => String(subject?.subject || "").trim()).filter(Boolean))];

  return {
    ...keepSubject,
    subject: String(suggestedTitle || keepSubject.subject || "").trim() || keepSubject.subject,
    sources,
    sourceCount: sources.length,
    contentCount: contents.length,
    articleCount: contents.filter((content) => content.type === "article").length,
    youtubeCount: contents.filter((content) => content.type === "youtube").length,
    contents,
    debateScore: Number(bestScoreSubject?.debateScore || keepSubject.debateScore || 0),
    controversyLevel: bestControversySubject?.controversyLevel || keepSubject.controversyLevel,
    mergedSubjectIds,
    mergedSubjectTitles,
    mergeTrace: {
      keepSubjectId: keepSubject.subjectId,
      mergedSubjectIds: mergedSubjectIds.filter((id) => id !== keepSubject.subjectId),
      originalTitles: mergedSubjectTitles
    }
  };
}

function applySubjectMergeGroups(subjects, mergeResult) {
  const safeSubjects = ensureSubjectIds(subjects);
  const byId = new Map(safeSubjects.map((subject) => [String(subject.subjectId), subject]));
  const consumed = new Set();
  const merged = [];
  const appliedGroups = [];

  const groups = Array.isArray(mergeResult?.mergeGroups) ? mergeResult.mergeGroups : [];
  groups.forEach((group) => {
    const confidence = Number(group?.confidence || 0);
    if (confidence < 0.8) return;

    const keepId = String(group?.keepSubjectId || "").trim();
    const mergeIds = (Array.isArray(group?.mergeSubjectIds) ? group.mergeSubjectIds : [])
      .map((id) => String(id || "").trim())
      .filter((id) => id && id !== keepId);
    if (!keepId || !mergeIds.length || consumed.has(keepId)) return;

    const keepSubject = byId.get(keepId);
    const mergeSubjects = mergeIds
      .filter((id) => !consumed.has(id))
      .map((id) => byId.get(id))
      .filter(Boolean);
    if (!keepSubject || !mergeSubjects.length) return;

    const mergedSubject = mergeSubjectRecords(keepSubject, mergeSubjects, group?.suggestedTitle || "");
    merged.push(mergedSubject);
    consumed.add(keepId);
    mergeSubjects.forEach((subject) => consumed.add(String(subject.subjectId)));
    appliedGroups.push({
      keepSubjectId: keepId,
      mergeSubjectIds: mergeSubjects.map((subject) => String(subject.subjectId)),
      suggestedTitle: String(group?.suggestedTitle || "").trim(),
      confidence,
      reason: String(group?.reason || "").trim()
    });
  });

  safeSubjects.forEach((subject) => {
    if (!consumed.has(String(subject.subjectId))) merged.push(subject);
  });

  merged.sort((a, b) => {
    if (Number(b.debateScore || 0) !== Number(a.debateScore || 0)) return Number(b.debateScore || 0) - Number(a.debateScore || 0);
    if (Number(b.sourceCount || 0) !== Number(a.sourceCount || 0)) return Number(b.sourceCount || 0) - Number(a.sourceCount || 0);
    return Number(b.contentCount || 0) - Number(a.contentCount || 0);
  });

  return {
    subjects: merged,
    appliedGroups,
    doNotMerge: Array.isArray(mergeResult?.doNotMerge) ? mergeResult.doNotMerge : []
  };
}

async function deduplicateSubjectsWithAI(subjects) {
  const safeSubjects = ensureSubjectIds(subjects);
  if (!openai || safeSubjects.length < 2) {
    return { subjects: safeSubjects, mergeResult: { mergeGroups: [], doNotMerge: [] } };
  }

  const freshCandidates = safeSubjects.slice(0, MAX_SUBJECTS_TO_DEDUP_WITH_AI).map((subject) => {
    // Un seul titre représentatif (celui du premier article collecté pour ce sujet)
    // suffisait rarement à reconnaître la même actualité couverte par des sources qui la
    // formulent très différemment (ex. arènes 1519/1536 sur la même affaire judiciaire) :
    // on donne aussi les autres formulations vues dans le groupe, quand elles existent.
    const otherTitles = [...new Set((subject.contents || [])
      .map((content) => String(content?.title || "").trim())
      .filter((title) => title && title !== subject.subject))].slice(0, 3);
    return {
      subjectId: subject.subjectId,
      subjectTitle: subject.subject,
      ...(otherTitles.length ? { otherTitles } : {})
    };
  });
  const candidates = freshCandidates;

  const prompt = `
Tu dois proposer une déduplication de sujets d'actualité.

Objectif :
éviter d'avoir plusieurs sujets séparés qui parlent en réalité de la même actualité, du même événement, de la même affaire, de la même décision ou de la même polémique.

Attention :
il ne faut surtout pas fusionner des sujets simplement parce qu'ils appartiennent à la même thématique générale.

Exemples :
- “Trump annonce de nouveaux droits de douane contre la Chine” et “Washington durcit sa politique commerciale face à Pékin” peuvent être fusionnés si les titres désignent bien la même séquence d'actualité.
- “Trump”, “Commerce mondial” et “Rivalité Chine-États-Unis” ne doivent pas être fusionnés seulement parce qu'ils sont liés.
- “Violences sexuelles dans le cinéma” et “Affaire Depardieu” ne doivent être fusionnés que si les titres parlent clairement de la même affaire précise, pas juste du même thème.

Données disponibles :
tu travailles uniquement à partir des sujets existants, avec :
- subjectId
- subjectTitle
- otherTitles (optionnel) : d'autres formulations du même sujet vues dans d'autres sources — sers-t'en activement pour reconnaître deux sujets qui couvrent la même actualité alors que leurs subjectTitle respectifs sont très différents.

Tu ne disposes pas des articles complets, ni des résumés, ni du contenu détaillé.

Règle de prudence :
comme tu ne vois que les titres, tu dois être conservateur.
Tu ne proposes une fusion que si les titres indiquent clairement le même fait d'actualité, le même événement, la même affaire, la même décision, la même polémique ou la même séquence médiatique.

Critères pour fusionner :
- mêmes acteurs principaux ;
- même événement ou même décision ;
- même lieu ou zone directement concernée ;
- même enjeu central précis ;
- formulations différentes mais même actualité évidente ;
- un lecteur trouverait étrange de voir ces sujets séparés.

Cas particulier — conflit ou affaire en cours :
si les deux sujets se rapportent manifestement au même conflit armé, à la même crise géopolitique ou à la même affaire judiciaire en cours (même zone géographique, même belligérants ou protagonistes, même séquence temporelle), fusionne-les même si les formulations sont très différentes.
Exemples : "Frappe à Téhéran : 9 morts" et "Guerre en Iran : les attaques ont repris" → même conflit, même zone, fusion justifiée. "Bombe à Gaza" et "Négociations sur le cessez-le-feu à Gaza" → même conflit mais événements de nature différente, ne pas fusionner.

Cas particulier — même personnalité, même procédure judiciaire ou politique :
deux sujets qui décrivent des angles différents de la même procédure visant la même personne (condamnation, pourvoi en cassation, appel, éligibilité, candidature) désignent la même actualité même si l'un se concentre sur la décision judiciaire et l'autre sur ses conséquences politiques ou électorales. Fusionne-les.
Exemple : "Une candidate condamnée en appel peut-elle se présenter malgré son pourvoi en cassation ?" et "Faut-il admettre ou restreindre la candidature d'une personne condamnée ?" → même personne, même procédure judiciaire en cours, même enjeu d'éligibilité : fusion justifiée même si aucun mot n'est partagé.

Cas particulier — deux sous-angles qui mèneraient au même dilemme :
chaque sujet sera transformé plus tard en une question de débat qui oppose deux camps. Si deux sujets, bien que centrés sur des faits distincts, posent en réalité le même dilemme de fond (la même décision collective à prendre, sur le même épisode chaud d'un conflit ou d'une séquence politique en cours), fusionne-les : sinon deux débats presque identiques seront publiés côte à côte. Ce cas est plus large que "même conflit" : il s'applique même quand les faits déclencheurs diffèrent (une frappe et une menace, une candidature et le rôle d'un possible successeur), du moment que le dilemme qui en découlerait pour le lecteur est le même.
Exemple à fusionner : "Frappes américaines en Iran : poursuivre ou cesser ?" et "Menaces et tensions de Trump au Moyen-Orient : quelle réponse ?" → deux facettes de la même séquence d'escalade militaire en cours, le lecteur se verrait proposer deux fois le même choix (poursuivre la fermeté ou désescalader) ; fusion justifiée même si l'une parle d'une frappe déjà survenue et l'autre de menaces.
Exemple à fusionner : "Candidature de Marine Le Pen malgré sa condamnation" et "Les ambitions contrariées de Jordan Bardella derrière la candidature de Marine Le Pen" → même dilemme de fond (qui doit porter la candidature du RN malgré la condamnation), fusion justifiée même si le second se concentre sur Bardella.
Exemple à ne pas fusionner : "Bombe à Gaza" et "Négociations sur le cessez-le-feu à Gaza" → un lecteur se verrait proposer deux dilemmes réellement différents (comment réagir à une frappe / comment juger une négociation en cours), pas de fusion.

Critères pour ne pas fusionner :
- simple proximité thématique ;
- sujets trop vagues ;
- titres qui peuvent désigner deux événements clairement distincts ;
- besoin d'inventer du contexte pour relier les sujets ;
- fusion trop large qui ferait perdre la précision du sujet.

Seuil de confiance :
ne propose une fusion que si la confiance est supérieure ou égale à 0.7. (Abaissé de 0.8 à 0.7
le 12/07/2026 : des doublons bien réels mais aux détails divergents, ex. un même incendie
rapporté avec un bilan de 11 puis 12 morts selon les sources, restaient sous 0.8 et repartaient
en génération séparée au lieu d'être fusionnés en amont.)

Concision (OBLIGATOIRE, la réponse est parsée automatiquement et ne doit pas être tronquée) :
- chaque "reason" fait une seule phrase courte (15 mots maximum) ;
- ne recopie jamais les titres complets dans les raisons ;
- "doNotMerge" liste au maximum les 8 paires les plus ambiguës — ce champ sert uniquement au diagnostic.

Sujet principal :
pour chaque groupe fusionné, choisir comme sujet principal :
- soit le subjectTitle le plus clair, précis et compréhensible ;
- soit proposer un suggestedTitle court, clair et précis si aucun titre existant n'est satisfaisant.

Après fusion :
le système recalculera les sources distinctes associées au sujet fusionné.
Les anciens subjectId fusionnés resteront traçables.

Sujets à analyser :
${JSON.stringify(candidates, null, 2)}

Réponds uniquement en JSON valide, sans texte autour.

Format JSON attendu :
{
  "mergeGroups": [
    {
      "keepSubjectId": "id_du_sujet_principal",
      "mergeSubjectIds": ["id_sujet_a_fusionner_1", "id_sujet_a_fusionner_2"],
      "suggestedTitle": "titre court et précis du sujet fusionné",
      "confidence": 0.92,
      "reason": "Les titres désignent clairement la même actualité, avec les mêmes acteurs et le même événement."
    }
  ],
  "doNotMerge": [
    {
      "subjectIds": ["id_1", "id_2"],
      "reason": "Sujets proches thématiquement mais événements différents ou trop peu précis."
    }
  ]
}
`;

  try {
    console.log(`${candidates.length} sujet(s) envoyés à la déduplication IA.`);
    // Une sortie tronquée (plafond max_output_tokens atteint) rend le JSON illisible et
    // faisait silencieusement retomber la session à 0 fusion (sessions Certamen des 2 et
    // 3 juillet 2026, doublon sondages 1251/1254) : budget large, et un unique retry avec
    // budget doublé si l'API signale explicitement une réponse incomplète.
    let response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.1,
      max_output_tokens: 6000
    });
    logAiUsage("dedup", response);
    if (response.status === "incomplete") {
      console.warn("Déduplication IA : réponse tronquée (max_output_tokens), nouvelle tentative avec budget doublé.");
      response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: prompt,
        temperature: 0.1,
        max_output_tokens: 12000
      });
      logAiUsage("dedup-retry", response);
      if (response.status === "incomplete") throw new Error("réponse encore tronquée après retry (max_output_tokens)");
    }
    const parsed = safeJsonParse(response.output_text);
    const applied = applySubjectMergeGroups(safeSubjects, parsed);
    return {
      subjects: applied.subjects,
      mergeResult: {
        mergeGroups: applied.appliedGroups,
        doNotMerge: applied.doNotMerge
      }
    };
  } catch (error) {
    console.error("Erreur déduplication IA :", error.message);
    return { subjects: safeSubjects, mergeResult: { mergeGroups: [], doNotMerge: [], error: error.message } };
  }
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
  const o = String(orientation || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (
    o.includes("gauche") ||
    o.includes("ecolog") ||
    o.includes("ecolo") ||
    o.includes("libertaire") ||
    o.includes("altermondialiste") ||
    o.includes("alter-mondialiste") ||
    o.includes("anticapitaliste") ||
    o.includes("anti-capitaliste") ||
    o.includes("socialiste") ||
    o.includes("social-democrate") ||
    o.includes("social democrate") ||
    o.includes("progressiste") ||
    o.includes("insoumis") ||
    o.includes("insoumission") ||
    o.includes("communiste") ||
    o.includes("marxiste") ||
    o.includes("feministe") ||
    o.includes("syndical") ||
    o.includes("alternatif") ||
    o.includes("alternative")
  ) return "left";
  if (
    o.includes("droite") ||
    o.includes("centre-droit") ||
    o.includes("centre droit") ||
    o.includes("droite-centre") ||
    o.includes("droite centre") ||
    o.includes("conservateur") ||
    o.includes("souverainiste") ||
    o.includes("liberal") ||
    o.includes("republicain") ||
    o.includes("identitaire")
  ) return "right";
  return "center";
}

// Sélectionne un sous-ensemble représentatif des contenus (en alternant gauche/centre/droite)
// pour éviter qu'une simple troncature n'exclue systématiquement un groupe entier.
function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildSubjectInteractionScriptHtml(opts = {}) {
  const topTenSorts = opts.topTenSorts || ["ranked"];
  // Sur /certamen, l'envoi vers Agôn (bouton individuel et "Tout générer") doit utiliser
  // le chemin Certamen dédié (visuel arène communauté, certamen-bot) et jamais le chemin
  // veille mixte officiel (/send-to-agon → is_official=true) — cf. certamen-agon-publish.js.
  const sendToAgonEndpoint = opts.certamen ? "/certamen/send-to-agon" : "/send-to-agon";
  return `
  <script>
    const TOP10_BAR_SORTS = ${JSON.stringify(topTenSorts)};
    const SEND_TO_AGON_ENDPOINT = ${JSON.stringify(sendToAgonEndpoint)};
    // Sur /certamen, "Tout générer" doit publier directement (question/positions/thème déjà
    // calculés à la collecte), jamais régénérer un résumé/article — cf. la branche
    // CERTAMEN_MODE dans le handler ".generate-all-btn" ci-dessous. Sur la veille mixte, ce
    // flag reste à false et le bouton continue d'utiliser generateSubjectPipeline() en entier.
    const CERTAMEN_MODE = ${JSON.stringify(!!opts.certamen)};
    const AGON_THEMES = ${JSON.stringify(AGON_THEMES)};
    const AGON_THEME_ALIASES = ${JSON.stringify(AGON_THEME_ALIASES)};
    function normalizeAgonTheme(theme) {
      const value = String(theme || "").trim();
      return AGON_THEMES.includes(value) ? value : (AGON_THEME_ALIASES[value] || AGON_THEMES[0]);
    }

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
    const agonStoryDebatesCache = new Map();

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

    async function loadStoryDebatesClient(storyId) {
      const key = String(storyId || "").trim();
      if (!key) return [];
      if (agonStoryDebatesCache.has(key)) return agonStoryDebatesCache.get(key);
      const response = await fetch("/api/agon-stories/" + encodeURIComponent(key) + "/debates");
      const data = await response.json().catch(function() { return { ok: false, debates: [] }; });
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Impossible de charger les articles de cette histoire.");
      }
      const debates = Array.isArray(data.debates) ? data.debates : [];
      agonStoryDebatesCache.set(key, debates);
      return debates;
    }

    function buildStoryPickerHtml(initialLabel, initialMeta) {
      const label = initialLabel || 'Sans histoire associée';
      const meta = initialMeta || '';
      return '<div class="story-manual-picker">' +
        '<label>Histoire associée</label>' +
        '<div class="story-picker-row">' +
          '<select class="story-manual-select" hidden>' +
            '<option value="">Sans histoire associée</option>' +
            '<option value="__new__">Créer une nouvelle histoire</option>' +
          '</select>' +
          '<button type="button" class="story-picker-trigger" aria-expanded="false">' +
            '<span class="story-picker-trigger-label">' + label + '</span>' +
            '<span class="story-picker-trigger-caret">▾</span>' +
          '</button>' +
          '<div class="story-dropdown hidden">' +
            '<div class="story-dropdown-create-row">' +
              '<button type="button" class="story-create-inline-btn">+ Créer une nouvelle histoire</button>' +
            '</div>' +
            '<div class="story-dropdown-search-row"><input type="text" class="story-search-input" placeholder="Rechercher une histoire"></div>' +
            '<div class="story-dropdown-list"></div>' +
          '</div>' +
        '</div>' +
        '<small class="story-manual-meta">' + meta + '</small>' +
      '</div>';
    }

    function formatStoryArticleDate(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleString("fr-FR");
    }

    function ensureStoryArticlesModal() {
      let modal = document.querySelector(".story-articles-modal");
      if (modal) return modal;
      modal = document.createElement("div");
      modal.className = "story-articles-modal hidden";
      modal.innerHTML = '<div class="story-articles-dialog" role="dialog" aria-modal="true" aria-labelledby="story-articles-title">' +
        '<div class="story-articles-header">' +
          '<div>' +
            '<h3 id="story-articles-title" class="story-articles-title">Articles de l&#39;histoire</h3>' +
          '</div>' +
          '<button type="button" class="story-articles-close" aria-label="Fermer">×</button>' +
        '</div>' +
        '<div class="story-articles-body"></div>' +
      '</div>';
      document.body.appendChild(modal);
      return modal;
    }

    function closeStoryArticlesModal() {
      const modal = document.querySelector(".story-articles-modal");
      if (!modal) return;
      modal.classList.add("hidden");
      const body = modal.querySelector(".story-articles-body");
      if (body) body.innerHTML = "";
    }

    function renderStoryArticlesModal(storyTitle, debates) {
      const modal = ensureStoryArticlesModal();
      const body = modal.querySelector(".story-articles-body");
      const title = modal.querySelector(".story-articles-title");
      if (title) {
        title.textContent = storyTitle ? "Articles de " + storyTitle : "Articles de l'histoire";
      }
      if (body) {
        if (!debates.length) {
          body.innerHTML = '<p class="story-article-content">Aucun autre article n&#39;est encore rattaché à cette histoire.</p>';
        } else {
          body.innerHTML = '<div class="story-articles-list">' + debates.map(function(debate) {
            const meta = [];
            if (debate.id) meta.push("Arène #" + debate.id);
            const formattedDate = formatStoryArticleDate(debate.created_at);
            if (formattedDate) meta.push(formattedDate);
            return '<div class="story-article-item">' +
              '<p class="story-article-title">' + escapeHtmlClient(debate.question || "Sans titre") + '</p>' +
              (meta.length ? '<div class="story-article-meta">' + escapeHtmlClient(meta.join(" • ")) + '</div>' : "") +
              (debate.content ? '<p class="story-article-content">' + escapeHtmlClient(String(debate.content).slice(0, 240)) + (String(debate.content).length > 240 ? "..." : "") + '</p>' : "") +
              (debate.url ? '<a class="story-article-link" href="' + escapeHtmlClient(debate.url) + '" target="_blank" rel="noopener noreferrer">Ouvrir l&#39;arène</a>' : "") +
            '</div>';
          }).join("") + '</div>';
        }
      }
      modal.classList.remove("hidden");
    }

    function buildKeywordsHtml(ai) {
      // Pas de repli sur ai.keywords (mots-clés regex) : seul un vrai
      // mainKeyword s'affiche comme tag principal ; sinon, pas de chip.
      const mainKeyword = String((ai && ai.mainKeyword) || "").trim();
      return '<div class="news-keywords">' +
        '<div class="news-keywords-label">Tag principal</div>' +
        (mainKeyword ? '<span class="news-keyword-chip main-keyword-chip" data-main-keyword="' + escapeHtmlClient(mainKeyword) + '">' + escapeHtmlClient(mainKeyword) + '<button type="button" class="news-keyword-remove-btn" aria-label="Supprimer le tag principal">×</button></span>' : '') +
      '</div>';
    }

    function getMainKeywordFromEditor(subjectEl) {
      return String(subjectEl?.querySelector(".news-keyword-chip[data-main-keyword]")?.dataset.mainKeyword || "").trim();
    }

    function renderKeywordsInEditor(subjectEl, mainKeyword) {
      const keywordsWrap = subjectEl?.querySelector(".news-keywords");
      if (!keywordsWrap) return;
      const rawMain = String(mainKeyword || "").trim();
      const normalizedMainKeyword = rawMain.slice(0, 28);
      keywordsWrap.querySelectorAll(".news-keyword-chip").forEach(function(chip) { chip.remove(); });
      if (normalizedMainKeyword) {
        const chip = document.createElement("span");
        chip.className = "news-keyword-chip main-keyword-chip";
        chip.dataset.mainKeyword = normalizedMainKeyword;
        chip.innerHTML = escapeHtmlClient(normalizedMainKeyword) + '<button type="button" class="news-keyword-remove-btn" aria-label="Supprimer le tag principal">×</button>';
        keywordsWrap.appendChild(chip);
      }
    }

    function buildStoryLinkHtml(storyLink) {
      storyLink = storyLink || {};

      const storyDecision = storyLink.story_decision || "new_story";
      const confidence = Number(storyLink.confidence || 0);
      const matchedTitle = escapeHtmlClient(storyLink.matched_story_title || "");
      const previousEpisodeTitle = escapeHtmlClient(storyLink.previous_episode_title || "");
      const previousEpisodeUrl = escapeHtmlClient(storyLink.previous_episode_url || "");
      const reason = escapeHtmlClient(storyLink.reason || "");
      const newStory = storyLink.new_story || {};
      const encodedCriteria = escapeHtmlClient(encodeStoryData(storyLink.criteria || {}));
      const encodedNewStory = escapeHtmlClient(encodeStoryData(newStory));
      const hasMatchedStory = Boolean(storyLink.matched_story_id && matchedTitle);
      const pickerLabel = hasMatchedStory ? matchedTitle : 'Sans histoire associée';
      const pickerMeta = hasMatchedStory && previousEpisodeTitle ? 'Dernier épisode : ' + previousEpisodeTitle : '';
      const manualPickerHtml = buildStoryPickerHtml(pickerLabel, pickerMeta);

      const existingStoryFields = '<div class="story-draft-fields story-existing-fields-empty">' +
        '<p class="story-existing-note">Cette histoire sera seulement associée à l&#39;actualité. Aucun résumé d&#39;histoire n&#39;est généré à cette étape.</p>' +
      '</div>';

      const newStoryFields = '<div class="story-draft-fields story-new-fields">' +
        '<label>Titre de la nouvelle histoire</label>' +
        '<input type="text" class="story-title-input" value="' + escapeHtmlClient(newStory.story_title || "") + '" placeholder="Titre court et général de l&#39;histoire">' +
        '<div class="story-save-actions"><button type="button" class="story-save-btn">Enregistrer les modifications</button><span class="story-save-feedback hidden">Modifications enregistrées</span></div>' +
      '</div>';

      const selectedMode = hasMatchedStory ? "existing" : "";
      const currentStoryId = escapeHtmlClient(storyLink.matched_story_id || "");
      const currentStoryTitle = matchedTitle;
      const statusReason = reason ? '<div class="story-link-header">' + reason + '</div>' : '';

      return '<div class="story-link-box" data-story-decision="' + escapeHtmlClient(storyDecision) + '" data-selected-mode="' + selectedMode + '" data-default-mode="' + selectedMode + '" data-matched-story-id="' + currentStoryId + '" data-matched-story-title="' + matchedTitle + '" data-current-story-id="' + currentStoryId + '" data-current-story-title="' + currentStoryTitle + '" data-current-story-summary="" data-previous-episode-title="' + previousEpisodeTitle + '" data-previous-episode-url="' + previousEpisodeUrl + '" data-confidence="' + confidence + '" data-reason="' + reason + '" data-criteria="' + encodedCriteria + '" data-new-story="' + encodedNewStory + '">' +
          statusReason +
          manualPickerHtml +
          '<div class="story-existing-fields">' + existingStoryFields + '</div>' +
          newStoryFields +
      '</div>';
    }

    function syncStoryChoiceUi(box) {
      if (!box) return;
      const mode = box.dataset.selectedMode || "";
      const hasExisting = mode === "existing" && String(box.dataset.currentStoryId || "").trim();
      const existingPreview = box.querySelector(".story-existing-fields");
      const newPreview = box.querySelector(".story-new-fields");
      box.classList.toggle("story-link-disabled", !mode);
      if (existingPreview) existingPreview.classList.toggle("hidden", !hasExisting);
      if (newPreview) newPreview.classList.toggle("hidden", mode !== "new");
    }

    async function populateManualStoryPicker(box) {
      if (!box) return;
      const select = box.querySelector(".story-manual-select");
      const dropdownList = box.querySelector(".story-dropdown-list");
      if (!select || select.dataset.loaded === "true") return;
      const stories = await loadAgonStoriesClient();
      const options = [
        '<option value="">Sans histoire associée</option>',
        '<option value="__new__">Créer une nouvelle histoire</option>'
      ];
      const matchedId = String(box.dataset.matchedStoryId || "").trim();
      stories.forEach(function(story) {
        const storyId = escapeHtmlClient(story.story_id || "");
        const title = escapeHtmlClient(story.story_title || "Histoire sans titre");
        const summary = escapeHtmlClient(story.story_summary || "");
        const latest = escapeHtmlClient(story.latest_episode_title || "");
        const selected = matchedId && String(story.story_id || "") === matchedId ? ' selected' : '';
        options.push('<option value="' + storyId + '"' + selected + ' data-title="' + title + '" data-summary="' + summary + '" data-latest="' + latest + '" data-url="' + escapeHtmlClient(story.latest_episode_url || "") + '">' + title + '</option>');
      });
      select.innerHTML = options.join("");
      select.dataset.loaded = "true";
      if (dropdownList) {
        dropdownList.innerHTML = '<div class="story-library-row story-row-simple" data-story-id="">' +
          '<button type="button" class="story-library-select-btn">Sans histoire associée</button>' +
        '</div>' + stories.map(function(story) {
          const storyId = escapeHtmlClient(story.story_id || "");
          const title = escapeHtmlClient(story.story_title || "Histoire sans titre");
          return '<div class="story-library-row" data-story-id="' + storyId + '">' +
            '<button type="button" class="story-library-select-btn story-library-title">' + title + '</button>' +
            '<div class="story-library-actions">' +
              '<button type="button" class="story-library-btn story-library-view-btn story-view-btn">Voir les articles</button>' +
              '<button type="button" class="story-library-btn story-edit-btn">Modifier</button>' +
              '<button type="button" class="story-library-btn story-delete-btn">Supprimer</button>' +
            '</div>' +
          '</div>';
        }).join("");
      }
      if (matchedId) {
        select.value = matchedId;
        if (String(select.value || "") !== matchedId) {
          const triggerLabel = box.querySelector(".story-picker-trigger-label");
          const storedTitle = String(box.dataset.currentStoryTitle || box.dataset.matchedStoryTitle || "").trim();
          if (triggerLabel) triggerLabel.textContent = storedTitle || "Histoire associée";
          syncStoryChoiceUi(box);
          filterStoryDropdown(box, "");
          const searchInput = box.querySelector(".story-search-input");
          if (searchInput && !searchInput.dataset.bound) {
            searchInput.addEventListener("input", function() { filterStoryDropdown(box, searchInput.value || ""); });
            searchInput.dataset.bound = "true";
          }
          return;
        }
      } else {
        select.value = "";
      }
      const searchInput = box.querySelector('.story-search-input');
      if (searchInput) {
        searchInput.value = "";
        if (!searchInput.dataset.bound) {
          searchInput.addEventListener('input', function() {
            filterStoryDropdown(box, searchInput.value || '');
          });
          searchInput.dataset.bound = 'true';
        }
      }
      filterStoryDropdown(box, '');
      updateManualStorySelection(box);
    }

    async function refreshStoryPicker(box) {
      if (!box) return;
      agonStoriesCache = null;
      agonStoryDebatesCache.clear();
      const select = box.querySelector(".story-manual-select");
      if (select) select.dataset.loaded = "false";
      const dropdownList = box.querySelector('.story-dropdown-list');
      if (dropdownList) dropdownList.innerHTML = '';
      await populateManualStoryPicker(box);
    }

    function filterStoryDropdown(box, query) {
      if (!box) return;
      const normalizedQuery = String(query || "").trim().toLowerCase();
      const rows = [...box.querySelectorAll('.story-library-row')];
      rows.forEach(function(row) {
        const title = String(row.querySelector('.story-library-select-btn')?.textContent || '').toLowerCase();
        const shouldShow = !normalizedQuery || title.includes(normalizedQuery);
        row.classList.toggle('hidden', !shouldShow);
      });
    }

    function updateManualStorySelection(box) {
      if (!box) return;
      const select = box.querySelector(".story-manual-select");
      const meta = box.querySelector(".story-manual-meta");
      const triggerLabel = box.querySelector(".story-picker-trigger-label");
      const trigger = box.querySelector(".story-picker-trigger");
      if (!select || !meta) return;
      const option = select.options[select.selectedIndex];
      const value = String(select.value || "").trim();
      const rows = [...box.querySelectorAll('.story-library-row')];
      rows.forEach(function(row) {
        row.classList.toggle('is-selected', String(row.dataset.storyId || '') === value || (!value && String(row.dataset.storyId || '') === ''));
      });
      if (!value) {
        box.dataset.selectedMode = "";
        box.dataset.currentStoryId = "";
        box.dataset.currentStoryTitle = "";
        box.dataset.currentStorySummary = "";
        box.dataset.previousEpisodeTitle = "";
        box.dataset.previousEpisodeUrl = "";
        meta.textContent = "";
        if (triggerLabel) triggerLabel.textContent = "Sans histoire associée";
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        const dropdown = box.querySelector('.story-dropdown');
        if (dropdown) dropdown.classList.add('hidden');
        const searchInput = box.querySelector('.story-search-input');
        if (searchInput) searchInput.value = '';
        filterStoryDropdown(box, '');
        syncStoryChoiceUi(box);
        return;
      }
      if (value === "__new__") {
        box.dataset.selectedMode = "new";
        box.dataset.currentStoryId = "";
        box.dataset.currentStoryTitle = "";
        box.dataset.currentStorySummary = "";
        box.dataset.previousEpisodeTitle = "";
        box.dataset.previousEpisodeUrl = "";
        meta.textContent = "Nouvelle histoire";
        if (triggerLabel) triggerLabel.textContent = "Créer une nouvelle histoire";
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        const dropdown = box.querySelector('.story-dropdown');
        if (dropdown) dropdown.classList.add('hidden');
        const searchInput = box.querySelector('.story-search-input');
        if (searchInput) searchInput.value = '';
        filterStoryDropdown(box, '');
        syncStoryChoiceUi(box);
        return;
      }
      box.dataset.selectedMode = "existing";
      box.dataset.currentStoryId = value;
      box.dataset.currentStoryTitle = option?.dataset.title || "";
      box.dataset.currentStorySummary = option?.dataset.summary || "";
      box.dataset.previousEpisodeTitle = option?.dataset.latest || "";
      box.dataset.previousEpisodeUrl = option?.dataset.url || "";
      meta.textContent = option?.dataset.latest ? "Dernier épisode : " + option.dataset.latest : "";
      if (triggerLabel) triggerLabel.textContent = option?.dataset.title || 'Histoire sans titre';
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      const dropdown = box.querySelector('.story-dropdown');
      if (dropdown) dropdown.classList.add('hidden');
      syncStoryChoiceUi(box);
    }

    async function openNewStoryPrompt(box) {
      if (!box) return;
      const newStory = decodeStoryData(box.dataset.newStory) || {};
      const currentTitle = String(newStory.story_title || "").trim();
      const enteredTitle = window.prompt("Titre de la nouvelle histoire", currentTitle);
      if (enteredTitle === null) return;
      const title = String(enteredTitle || "").trim();
      if (!title) return;

      const response = await fetch("/api/agon-stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          story_title: title,
          story_summary: ""
        })
      });
      const data = await response.json().catch(function() { return { ok: false, error: "Erreur création histoire" }; });
      if (!response.ok || data.ok === false || !data.story) {
        throw new Error(data.error || "Erreur création histoire");
      }

      const createdStory = data.story;
      newStory.story_title = String(createdStory.story_title || title).trim();
      box.dataset.newStory = encodeStoryData(newStory);
      box.dataset.selectedMode = "existing";
      box.dataset.currentStoryId = String(createdStory.story_id || "").trim();
      box.dataset.currentStoryTitle = String(createdStory.story_title || title).trim();
      box.dataset.currentStorySummary = String(createdStory.story_summary || "").trim();
      box.dataset.previousEpisodeTitle = "";
      box.dataset.previousEpisodeUrl = "";

      const titleInput = box.querySelector(".story-title-input");
      if (titleInput) titleInput.value = "";

      await refreshStoryPicker(box);
      const select = box.querySelector(".story-manual-select");
      if (select && createdStory.story_id) {
        select.value = String(createdStory.story_id);
      }
      updateManualStorySelection(box);
    }

    async function editExistingStory(box, storyId) {
      if (!box || !storyId) return;
      const stories = await loadAgonStoriesClient();
      const story = stories.find(function(item) { return String(item.story_id || "") === String(storyId); });
      if (!story) return;
      const nextTitle = window.prompt("Modifier le titre de l'histoire", String(story.story_title || "").trim());
      if (nextTitle === null) return;
      const title = String(nextTitle || "").trim();
      if (!title) return;
      const response = await fetch("/api/agon-stories/" + encodeURIComponent(storyId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          story_title: title,
          story_summary: String(story.story_summary || "")
        })
      });
      const data = await response.json().catch(function() { return { ok: false, error: "Erreur modification histoire" }; });
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Erreur modification histoire");
      }
      await refreshStoryPicker(box);
      updateManualStorySelection(box);
    }

    async function deleteExistingStory(box, storyId) {
      if (!box || !storyId) return;
      const shouldDelete = window.confirm("Supprimer cette histoire ?");
      if (!shouldDelete) return;
      const response = await fetch("/api/agon-stories/" + encodeURIComponent(storyId), {
        method: "DELETE"
      });
      const data = await response.json().catch(function() { return { ok: false, error: "Erreur suppression histoire" }; });
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Erreur suppression histoire");
      }
      if (String(box.dataset.currentStoryId || "") === String(storyId)) {
        box.dataset.selectedMode = "";
        box.dataset.currentStoryId = "";
        box.dataset.currentStoryTitle = "";
        box.dataset.currentStorySummary = "";
      }
      await refreshStoryPicker(box);
      updateManualStorySelection(box);
    }

    async function openStoryArticles(box, storyId) {
      if (!box || !storyId) return;
      const stories = await loadAgonStoriesClient();
      const story = stories.find(function(item) { return String(item.story_id || "") === String(storyId); });
      const storyTitle = String(story?.story_title || "").trim();
      const debates = await loadStoryDebatesClient(storyId);
      renderStoryArticlesModal(storyTitle, debates);
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
      const selectedMode = box.dataset.selectedMode || "";
      const titleInput = box.querySelector(".story-title-input");
      const newStory = decodeStoryData(box.dataset.newStory) || {};

      if (titleInput && selectedMode === "new") {
        newStory.story_title = titleInput.value.trim();
        box.dataset.newStory = encodeStoryData(newStory);
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

      const storyDecision = box.dataset.storyDecision || "";
      const matchedStoryId = box.dataset.currentStoryId || box.dataset.matchedStoryId || null;
      const matchedStoryTitle = box.dataset.currentStoryTitle || box.dataset.matchedStoryTitle || "";
      const previousEpisodeTitle = box.dataset.previousEpisodeTitle || "";
      const previousEpisodeUrl = box.dataset.previousEpisodeUrl || "";
      const confidence = Number(box.dataset.confidence || 0);
      const reason = box.dataset.reason || "";
      const criteria = decodeStoryData(box.dataset.criteria) || {};
      const baseNewStory = decodeStoryData(box.dataset.newStory) || {};
      const manualSelect = box.querySelector(".story-manual-select");
      const manualOption = manualSelect?.options[manualSelect.selectedIndex] || null;
      let selectionMode = box.dataset.selectedMode || "";
      if (!selectionMode) {
        const decision = box.dataset.storyDecision || "";
        const fallbackId = box.dataset.matchedStoryId || box.dataset.currentStoryId || "";
        if ((decision === "existing_story" || decision === "uncertain") && fallbackId) {
          selectionMode = "existing";
        }
      }
      if (!selectionMode) return null;

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

      if (selectionMode === "existing") {
        if (!matchedStoryId) return null;
        payload.reason = manualSelect && manualSelect.value ? "Histoire choisie manuellement." : reason;
      }

      if (selectionMode === "new") {
        const title = box.querySelector(".story-title-input")?.value.trim() || "";
        if (!title) {
          throw new Error("Renseigne le titre de la nouvelle histoire avant l'envoi.");
        }
        payload.newStory = {
          story_title: title,
          story_summary: "",
          main_actors: Array.isArray(baseNewStory.main_actors) ? baseNewStory.main_actors : [],
          central_tension: baseNewStory.central_tension || "",
          keywords: Array.isArray(baseNewStory.keywords) ? baseNewStory.keywords : [],
          status: "active"
        };
      }

      return payload;
    }

    async function applyStorySuggestion(box, suggestion) {
      if (!box || !suggestion) return;
      const matchedId = String(suggestion.matched_story_id || "").trim();
      box.dataset.storyDecision = suggestion.story_decision || "new_story";
      box.dataset.confidence = String(suggestion.confidence || 0);
      box.dataset.reason = suggestion.reason || "";
      box.dataset.matchedStoryId = matchedId;
      box.dataset.currentStoryId = matchedId;
      box.dataset.matchedStoryTitle = suggestion.matched_story_title || "";
      box.dataset.currentStoryTitle = suggestion.matched_story_title || "";
      box.dataset.previousEpisodeTitle = suggestion.previous_episode_title || "";
      box.dataset.previousEpisodeUrl = suggestion.previous_episode_url || "";
      const header = box.querySelector(".story-link-header");
      if (header) header.textContent = suggestion.reason || "";
      const select = box.querySelector(".story-manual-select");
      const isLoaded = select && select.dataset.loaded === "true";
      if (!isLoaded) {
        await populateManualStoryPicker(box);
      } else {
        if (select && matchedId) {
          select.value = matchedId;
          if (String(select.value || "") !== matchedId) {
            const triggerLabel = box.querySelector(".story-picker-trigger-label");
            if (triggerLabel) triggerLabel.textContent = suggestion.matched_story_title || "Histoire associée";
            syncStoryChoiceUi(box);
            return;
          }
        } else if (select) {
          select.value = "";
        }
        updateManualStorySelection(box);
      }
    }

    async function suggestStoryForSubject(subjectEl, setStatus) {
      const box = subjectEl.querySelector(".story-link-box");
      if (!box) return;
      if (box.dataset.storySuggested === "true") return;
      if (setStatus) setStatus("Histoire associée…");
      const subjectTitle = subjectEl.querySelector("h3")?.textContent.trim() || "";
      const agonTheme = subjectEl.querySelector(".agon-select")?.value || "";
      const debateQuestion = subjectEl.querySelector(".debate-question")?.textContent.trim() || "";
      const keywords = [getMainKeywordFromEditor(subjectEl)].filter(Boolean);
      const contents = [...subjectEl.querySelectorAll(".content-item[data-link]")].map(function(item) {
        return {
          type: item.dataset.type || "article",
          source: item.querySelector("strong")?.textContent.trim() || "",
          orientation: item.dataset.orientation || "",
          title: item.querySelector("a")?.textContent.trim() || "",
          link: item.dataset.link || ""
        };
      }).filter(function(c) { return c.link || c.title; });
      const sources = [...new Set(contents.map(function(c) { return c.source; }).filter(Boolean))];
      try {
        const response = await fetchWithTimeout("/suggest-story", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: subjectTitle, sources, contents, ai: { agonTheme, debateQuestion, keywords } })
        });
        if (!response.ok) return;
        const data = await response.json().catch(function() { return null; });
        if (!data || !data.ok || !data.suggestion) return;
        box.dataset.storySuggested = "true";
        await applyStorySuggestion(box, data.suggestion);
        if (subjectTitle) {
          fetch("/save-update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subject: subjectTitle, ai: { storyLink: data.suggestion } })
          }).catch(function() {});
        }
      } catch (error) {
        console.error("Erreur suggestion histoire :", error.message);
      }
    }

    const PIPELINE_FETCH_TIMEOUT_MS = 90000;

    function fetchWithTimeout(url, options = {}, timeoutMs = PIPELINE_FETCH_TIMEOUT_MS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetch(url, { ...options, signal: controller.signal })
        .catch(err => {
          if (err.name === "AbortError") throw new Error("Délai dépassé (" + Math.round(timeoutMs / 1000) + "s) : " + url);
          throw err;
        })
        .finally(() => clearTimeout(timer));
    }

    const AI_TITLE_MAX = 110;
    const AI_RESUME_MAX = 1800;

    function limitClientDebateQuestion(text) {
      const raw = String(text || "").replace(/\\s+/g, " ").trim();
      if (!raw) return "";
      const danglingWords = /(?:\\s+(?:le|la|les|l|un|une|des|du|de|d|à|au|aux|et|ou|pour|par|avec|sans|malgré|face|contre|sur))$/i;

      function finalizeQuestion(value) {
        let stem = String(value || "")
          .replace(/[?？]+$/g, "")
          .replace(/\\s+/g, " ")
          .trim()
          .replace(/[,:;.!?…-]+$/g, "")
          .trim();
        stem = stem.replace(danglingWords, "").trim();
        if (!stem) return "";
        return stem + " ?";
      }

      function shortenAtWord(value) {
        let stem = String(value || "").slice(0, AI_TITLE_MAX - 1).trimEnd();
        const lastSpace = stem.lastIndexOf(" ");
        if (lastSpace > 48) stem = stem.slice(0, lastSpace);
        return finalizeQuestion(stem);
      }

      const base = finalizeQuestion(raw);
      if (base.length <= AI_TITLE_MAX) return base;
      const withoutQuestionMark = raw.replace(/[?？]+$/g, "").trim();
      const compactAlternative = finalizeQuestion(withoutQuestionMark.replace(/\\s+(?:pour|afin de)\\s+.+?\\s+ou\\s+/i, " ou "));
      return compactAlternative.length <= AI_TITLE_MAX ? compactAlternative : base;
    }

    // Variante pour l'arène libre : nettoie et tronque un titre factuel SANS jamais le transformer en question.
    function limitClientFactualTitle(text) {
      const raw = String(text || "").replace(/\\s+/g, " ").trim().replace(/[?？]+$/g, "").replace(/[,:;.!…-]+$/g, "").trim();
      if (raw.length <= AI_TITLE_MAX) return raw;
      let stem = raw.slice(0, AI_TITLE_MAX - 1).trimEnd();
      const lastSpace = stem.lastIndexOf(" ");
      if (lastSpace > 48) stem = stem.slice(0, lastSpace);
      return stem.replace(/[,:;.!…-]+$/g, "").trim();
    }

    function splitArticleOpeningSentenceParts(parts) {
      const cleanParts = Array.isArray(parts)
        ? parts.map(function(part) { return String(part || "").trim(); }).filter(Boolean)
        : [];
      if (!cleanParts.length) return [];
      const match = cleanParts[0].match(/^(.+?[.!?…])\\s+(\\S[\\s\\S]*)$/);
      if (!match) return cleanParts;
      const opening = match[1].trim();
      const rest = match[2].trim();
      if (!opening || !rest) return cleanParts;
      return [opening, rest].concat(cleanParts.slice(1));
    }

    // Détection par contenu d'une ligne latine (devise ou question) — miroir de
    // looksLikeLatinPhrase côté serveur. La position seule ne suffit pas : si la
    // ligne latine manque, le style gras tomberait sur le paragraphe précédent.
    const FRENCH_FUNCTION_WORDS_CLIENT = ["le","la","les","un","une","des","du","de","en","au","aux","et","est","sont","avec","pour","sur","sous","par","dans","vers","qui","que","dont","mais","car","ni","ou","donc","ce","se","il","elle","ils","elles","on","nous","vous","leur","leurs","à","ne","pas","plus","sa","son","ses","cette"];
    function looksLikeLatinLineClient(line) {
      const cleaned = String(line || "").replace(/[.,;:!?'"«»]+/g, " ").replace(/\\s+/g, " ").trim();
      if (!/^[A-ZÀ-Ÿ]/.test(cleaned)) return false;
      const words = cleaned.split(" ").filter(Boolean);
      if (words.length < 2 || words.length > 6) return false;
      // Une initiale d'une lettre (ex. signature "J.L Grasso") n'est jamais du latin
      if (!words.every(function(w) { return /^[A-Za-zÀ-ÿ]{2,}$/.test(w); })) return false;
      // "et" est commun au latin et au français (ex. "Memoria et iustitia") : neutre
      return !words.some(function(w) { const lw = w.toLowerCase(); return lw !== "et" && FRENCH_FUNCTION_WORDS_CLIENT.indexOf(lw) !== -1; });
    }

    function renderArticleHtml(articleText, options) {
      const opts = options || {};
      const parts = String(articleText || "").split(/\\n\\n/)
        .map(function(p) { return p.trim(); })
        .filter(Boolean);

      if (opts.arenaMode === "libre") {
        // Arène libre : pas de question de débat dans le corps — structure [...corps, devise latine ?, signature]
        if (parts.length < 2) {
          return parts.map(function(p) { return "<p>" + escapeHtmlClient(p) + "</p>"; }).join("");
        }
        const signature = parts[parts.length - 1];
        const mottoCandidate = parts.length >= 3 ? parts[parts.length - 2] : "";
        const hasMotto = !!mottoCandidate && looksLikeLatinLineClient(mottoCandidate);
        const motto = hasMotto ? mottoCandidate : "";
        const bodyParts = parts.slice(0, parts.length - (hasMotto ? 2 : 1));
        const formattedBodyParts = splitArticleOpeningSentenceParts(bodyParts);
        const lastBodyIndex = formattedBodyParts.length - 1;
        const bodyHtml = formattedBodyParts.map(function(p, idx) {
          // Le dernier paragraphe du corps est la conclusion qui "ouvre la réflexion" : italique, non centrée
          const cssClass = (idx === lastBodyIndex) ? "article-reflection-line" : "";
          return cssClass ? '<p class="' + cssClass + '">' + escapeHtmlClient(p) + "</p>" : "<p>" + escapeHtmlClient(p) + "</p>";
        }).join("");
        return bodyHtml
          + (motto ? '<p class="article-latin-question">' + escapeHtmlClient(motto) + "</p>" : "")
          + '<p class="article-signature">' + escapeHtmlClient(signature) + "</p>";
      }

      if (parts.length < 3) {
        return parts.map(function(p) { return "<p>" + escapeHtmlClient(p) + "</p>"; }).join("");
      }
      const signature = parts[parts.length - 1];
      const question = parts[parts.length - 2];
      const latinCandidate = parts.length >= 4 ? parts[parts.length - 3] : "";
      const hasLatinQuestion = !!latinCandidate && looksLikeLatinLineClient(latinCandidate);
      const latinQuestion = hasLatinQuestion ? latinCandidate : "";
      const bodyParts = parts.slice(0, parts.length - (hasLatinQuestion ? 3 : 2));
      const formattedBodyParts = splitArticleOpeningSentenceParts(bodyParts);
      const bodyHtml = formattedBodyParts.map(function(p) { return "<p>" + escapeHtmlClient(p) + "</p>"; }).join("");
      return bodyHtml
        + (latinQuestion ? '<p class="article-latin-question">' + escapeHtmlClient(latinQuestion) + "</p>" : "")
        + '<p class="article-debate-question">' + escapeHtmlClient(question) + "</p>"
        + '<p class="article-signature">' + escapeHtmlClient(signature) + "</p>";
    }

    function getDefinitiveArticleButtonLabel(button, state) {
      const isLatinButton = button && button.classList.contains("latin-article-btn");
      if (state === "loading") return isLatinButton ? "Article + latin en cours…" : "Article définitif en cours…";
      if (state === "story") return "Histoire associée…";
      if (state === "done") return isLatinButton ? "✓ Article + question latine" : "✓ Article définitif";
      return isLatinButton ? "Générer article + question latine" : "Article définitif";
    }

    function setDefinitiveArticleButtons(subjectEl, options) {
      const opts = options || {};
      subjectEl.querySelectorAll(".definitive-article-btn").forEach(function(button) {
        if (opts.hidden === true) button.classList.add("hidden");
        if (opts.hidden === false) button.classList.remove("hidden");
        if (typeof opts.disabled === "boolean") button.disabled = opts.disabled;
        if (opts.state) button.textContent = getDefinitiveArticleButtonLabel(button, opts.state);
      });
    }

    function syncDefinitiveArticleButtonsFromState(subjectEl) {
      // En arène libre, l'article définitif (avec question de débat / formule latine) ne s'applique pas : ces boutons restent masqués.
      if (subjectEl.dataset.arenaMode === "libre") {
        setDefinitiveArticleButtons(subjectEl, { hidden: true });
        return;
      }
      const state = String(subjectEl.querySelector(".full-article-state")?.value || "").trim();
      if (state === "full") {
        setDefinitiveArticleButtons(subjectEl, { hidden: false, disabled: false, state: "done" });
      } else if (state === "problematique") {
        setDefinitiveArticleButtons(subjectEl, { hidden: false, disabled: false, state: "idle" });
      }
    }

    const GENERATION_BUTTON_SELECTOR = ".tags-generate-btn, .full-article-btn, .final-article-btn, .problematique-btn, .definitive-article-btn";

    function ensureArticleGenerationPanel(subjectEl) {
      if (!subjectEl) return;
      const buttons = Array.from(subjectEl.querySelectorAll(GENERATION_BUTTON_SELECTOR));
      if (!buttons.length) return;

      let panel = subjectEl.querySelector(".article-generation-panel");
      if (!panel) {
        panel = document.createElement("details");
        panel.className = "article-generation-panel";
        panel.innerHTML = '<summary>Génération article</summary><div class="article-generation-actions"></div>';
        buttons[0].insertAdjacentElement("beforebegin", panel);
      }

      const actions = panel.querySelector(".article-generation-actions") || panel.appendChild(document.createElement("div"));
      actions.className = "article-generation-actions";
      buttons.forEach(function(button) {
        if (!button.closest(".article-generation-actions")) {
          actions.appendChild(button);
        }
      });
    }

    function buildAiBoxHtml(ai) {
      const score = Number(ai.debateScore) || 0;
      const optionsHtml = AGON_THEMES.map(theme =>
        '<option value="' + theme + '"' + (theme === normalizeAgonTheme(ai.agonTheme) ? " selected" : "") + ">" + theme + "</option>"
      ).join("");

      const positionsHtml = score >= 7 && (ai.positionA || ai.positionB) && ai.arenaMode !== "libre"
        ? '<div class="positions-box">' +
            "<p><strong>Positions proposées pour une arène à positions :</strong></p>" +
            (ai.positionA ? '<p><strong>A —</strong> <span class="editable" contenteditable="true" spellcheck="false">' + ai.positionA + "</span></p>" : "") +
            (ai.positionB ? '<p><strong>B —</strong> <span class="editable" contenteditable="true" spellcheck="false">' + ai.positionB + "</span></p>" : "") +
          "</div>"
        : "";

      return '<div class="ai-box">' +
        '<input type="hidden" class="full-article-state" value="short">' +
        '<p class="generated-title-label">Titre généré par IA</p>' +
        '<p class="debate-question" contenteditable="true" spellcheck="false">' + (ai.debateQuestion || "") + "</p>" +
        '<div class="field-counter question-counter">0 / 110</div>' +
        positionsHtml +
        '<p class="resume" contenteditable="true" spellcheck="false">' + (ai.resume || "") + "</p>" +
        '<div class="field-counter resume-counter">0 / 1500</div>' +
        '<div class="story-save-actions"><button type="button" class="story-save-btn context-save-btn">Enregistrer les modifications</button><span class="story-save-feedback context-save-feedback hidden">Modifications enregistrées</span></div>' +
        buildKeywordsHtml(ai) +
        '<p class="agon-theme"><strong>Thématique Agôn proposée :</strong>' +
          '<select class="agon-select">' + optionsHtml + "</select>" +
        "</p>" +
        buildStoryLinkHtml(ai.storyLink || {}) +
        '<button type="button" class="tags-generate-btn">Générer tags</button>' +
        '<button type="button" class="full-article-btn">Générer résumé de l&#39;article</button>' +
        '<button type="button" class="final-article-btn hidden">Analyser les médias</button>' +
        '<button type="button" class="problematique-btn hidden">Générer problématique</button>' +
        '<button type="button" class="definitive-article-btn hidden" disabled>Article définitif</button>' +
        '<button type="button" class="definitive-article-btn latin-article-btn" disabled>Générer article + question latine</button>' +
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

    function saveContextEdits(subjectEl) {
      if (!subjectEl) return;
      const feedback = subjectEl.querySelector(".context-save-feedback");
      const questionEl = subjectEl.querySelector(".debate-question");
      const resumeEl = subjectEl.querySelector(".resume");
      updateAiEditorCounters(subjectEl);
      if (questionEl) {
        questionEl.dataset.savedValue = questionEl.textContent.trim();
      }
      if (resumeEl) {
        resumeEl.dataset.savedValue = resumeEl.textContent.trim();
      }
      const fullArticleState = subjectEl.querySelector(".full-article-state");
      if (fullArticleState) {
        fullArticleState.value = "custom";
      }
      if (feedback) {
        feedback.classList.remove("hidden");
        clearTimeout(feedback._timer);
        feedback._timer = setTimeout(function() {
          feedback.classList.add("hidden");
        }, 1800);
      }
    }

    function getOrientationGroupClient(orientation) {
      const o = String(orientation || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      if (
        o.indexOf("gauche") !== -1 ||
        o.indexOf("ecolog") !== -1 ||
        o.indexOf("ecolo") !== -1 ||
        o.indexOf("libertaire") !== -1 ||
        o.indexOf("altermondialiste") !== -1 ||
        o.indexOf("alter-mondialiste") !== -1 ||
        o.indexOf("anticapitaliste") !== -1 ||
        o.indexOf("anti-capitaliste") !== -1 ||
        o.indexOf("socialiste") !== -1 ||
        o.indexOf("social-democrate") !== -1 ||
        o.indexOf("social democrate") !== -1 ||
        o.indexOf("progressiste") !== -1 ||
        o.indexOf("insoumis") !== -1 ||
        o.indexOf("insoumission") !== -1 ||
        o.indexOf("communiste") !== -1 ||
        o.indexOf("marxiste") !== -1 ||
        o.indexOf("feministe") !== -1 ||
        o.indexOf("syndical") !== -1 ||
        o.indexOf("alternatif") !== -1 ||
        o.indexOf("alternative") !== -1
      ) return "left";
      if (
        o.indexOf("droite") !== -1 ||
        o.indexOf("centre-droit") !== -1 ||
        o.indexOf("centre droit") !== -1 ||
        o.indexOf("droite-centre") !== -1 ||
        o.indexOf("droite centre") !== -1 ||
        o.indexOf("conservateur") !== -1 ||
        o.indexOf("souverainiste") !== -1 ||
        o.indexOf("liberal") !== -1 ||
        o.indexOf("republicain") !== -1 ||
        o.indexOf("identitaire") !== -1
      ) return "right";
      return "center";
    }

    function clampEditableText(element, maxLength) {
      if (!element) return "";
      const safeValue = (element.textContent || "").trim().slice(0, maxLength);
      if ((element.textContent || "").trim() !== safeValue) {
        element.textContent = safeValue;
      }
      return safeValue;
    }

    function updateCounter(subjectEl, selector, counterSelector, maxLength) {
      const element = subjectEl.querySelector(selector);
      const counter = subjectEl.querySelector(counterSelector);
      if (!element || !counter) return;
      const safeValue = clampEditableText(element, maxLength);
      counter.textContent = safeValue.length + " / " + maxLength;
      counter.style.color = safeValue.length >= maxLength ? "#b42318" : "#6b7280";
    }

    function updateAiEditorCounters(subjectEl) {
      if (!subjectEl) return;
      updateCounter(subjectEl, ".debate-question", ".question-counter", AI_TITLE_MAX);
      updateCounter(subjectEl, ".resume", ".resume-counter", AI_RESUME_MAX);
    }

    function getSelectedContents(subjectEl) {
      return [...subjectEl.querySelectorAll(".content-item[data-link]")]
        .filter(function(item) {
          return item.querySelector('input[type="checkbox"]')?.checked ?? true;
        })
        .map(function(item) {
          return {
            type: item.dataset.type || "article",
            link: item.dataset.link || "",
            source: item.querySelector("strong")?.textContent.trim() || "",
            title: item.querySelector("a")?.textContent.trim() || "",
            summary: item.dataset.summary || "",
            date: item.querySelector("small")?.textContent.trim() || ""
          };
        })
        .filter(function(item) { return item.link || item.title; });
    }

    function getSubjectAnalyzePayloadFromEditor(subjectEl) {
      const basePayload = decodeStoryData(subjectEl?.dataset.subjectPayload || "") || {};
      const contents = [...subjectEl.querySelectorAll(".content-item[data-link]")].map(function(item) {
        return {
          type: item.dataset.type || "article",
          source: item.querySelector("strong")?.textContent.trim() || "",
          orientation: item.dataset.orientation || "",
          title: item.querySelector("a")?.textContent.trim() || "",
          link: item.dataset.link || "",
          summary: item.dataset.summary || ""
        };
      }).filter(function(item) { return item.link || item.title; });
      const sources = [...new Set(contents.map(function(item) { return item.source; }).filter(Boolean))];
      const resumeElForTags = subjectEl.querySelector(".resume");
      const articleText = (resumeElForTags?.dataset.rawText || resumeElForTags?.textContent || "").trim();
      return {
        subject: basePayload.subject || subjectEl.querySelector("h3")?.textContent.trim() || "",
        sources,
        contents,
        articleText,
        arenaMode: basePayload.arenaMode || "positions"
      };
    }

    function updatePoliticalTag(subjectEl, isPolitical) {
      const box = subjectEl && subjectEl.querySelector(".positions-box");
      if (!box) return;
      let tag = box.querySelector(".political-tag");
      if (isPolitical) {
        if (!tag) { tag = document.createElement("span"); tag.className = "political-tag"; box.appendChild(tag); }
        tag.textContent = "Débat politique détecté";
      } else if (tag) {
        tag.remove();
      }
    }

    function ensurePositionsBox(subjectEl, positionA, positionB) {
      if (!subjectEl) return;
      let box = subjectEl.querySelector(".positions-box");
      if (!box) {
        box = document.createElement("div");
        box.className = "positions-box";
        const counter = subjectEl.querySelector(".question-counter");
        if (counter) {
          counter.insertAdjacentElement("afterend", box);
        } else {
          subjectEl.querySelector(".debate-question")?.insertAdjacentElement("afterend", box);
        }
      }
      box.innerHTML =
        "<p><strong>Positions proposées pour une arène à positions :</strong></p>" +
        '<p><strong>A —</strong> <span class="editable" contenteditable="true" spellcheck="false">' + escapeHtmlClient(positionA || "") + "</span></p>" +
        '<p><strong>B —</strong> <span class="editable" contenteditable="true" spellcheck="false">' + escapeHtmlClient(positionB || "") + "</span></p>";
    }

    function removePositionsBox(subjectEl) {
      const box = subjectEl && subjectEl.querySelector(".positions-box");
      if (box) box.remove();
    }

    document.addEventListener("click", (e) => {
      const modeBtn = e.target.closest(".arena-mode-btn");
      if (!modeBtn) return;
      const subjectEl = modeBtn.closest(".subject");
      if (!subjectEl) return;
      const mode = modeBtn.dataset.mode === "libre" ? "libre" : "positions";
      subjectEl.dataset.arenaMode = mode;
      subjectEl.querySelectorAll(".arena-mode-btn").forEach(function(b) { b.classList.toggle("active", b.dataset.mode === mode); });
      const modeLabelPicker = subjectEl.querySelector(".arena-mode-label");
      if (modeLabelPicker) modeLabelPicker.textContent = mode === "libre" ? "Arène libre" : "Arène à positions";
    });

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest(".analyze-btn");
      if (!btn) return;

      const subjectData = JSON.parse(btn.dataset.subject);
      subjectData.arenaMode = btn.dataset.mode || "positions";
      const subjectEl = btn.closest(".subject");
      const aiBox = btn.closest(".ai-box");
      const aiScore = subjectEl.querySelector(".ai-score.pending");

      subjectEl.dataset.arenaMode = subjectData.arenaMode;
      const modeLabel = subjectEl.querySelector(".arena-mode-label");
      if (modeLabel) modeLabel.textContent = subjectData.arenaMode === "libre" ? "Arène libre" : "Arène à positions";

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
        ai.sourceSubject = subjectData.subject || "";
        if (subjectData.arenaMode === "libre") {
          ai.arenaMode = "libre";
          ai.debateQuestion = subjectData.subject || ai.debateQuestion || "";
          ai.positionA = "";
          ai.positionB = "";
        }
        subjectEl.dataset.subjectPayload = encodeStoryData(subjectData);

        if (aiScore) aiScore.outerHTML = buildAiScoreHtml(ai);
        aiBox.outerHTML = buildAiBoxHtml(ai);
        ensureArticleGenerationPanel(subjectEl);
        updateAiEditorCounters(subjectEl);
        initializeStoryBoxes(subjectEl);

        const agonBtn = subjectEl.querySelector(".agon-btn");
        if (agonBtn) {
          agonBtn.dataset.question = limitClientDebateQuestion(ai.debateQuestion || subjectData.subject || "");
          agonBtn.dataset.positionA = ai.positionA || "";
          agonBtn.dataset.positionB = ai.positionB || "";
          agonBtn.dataset.theme = normalizeAgonTheme(ai.agonTheme);
        }

        const preselectedLinks = new Set(
          Array.isArray(ai.selectedLinks)
            ? ai.selectedLinks.map(function(link) { return String(link || "").trim(); }).filter(Boolean)
            : []
        );
        subjectEl.querySelectorAll(".content-item[data-link]").forEach(function(item) {
          const link = item.dataset.link;
          const checkbox = item.querySelector('input[type="checkbox"]');
          // Liste vide = aucune info d'exclusion exploitable : tout reste coché
          const isSelected = preselectedLinks.size === 0 || preselectedLinks.has(link);
          if (checkbox) checkbox.checked = isSelected;
          item.classList.toggle("preselected", isSelected);
        });

        await fetch("/save-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: subjectData.subject,
            debateScore: ai.debateScore,
            controversyLevel: ai.controversyLevel,
            ai: {
              ...ai,
              fullArticleState: "short"
            }
          })
        });

        await suggestStoryForSubject(subjectEl);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Réessayer (erreur)";
      }
    });

    document.addEventListener("click", async function(e) {
      const tagsGenerateBtn = e.target.closest(".tags-generate-btn");
      if (tagsGenerateBtn) {
        const subjectEl = tagsGenerateBtn.closest(".subject");
        const payload = getSubjectAnalyzePayloadFromEditor(subjectEl);
        if (!payload.subject) return;

        tagsGenerateBtn.disabled = true;
        tagsGenerateBtn.textContent = "Tags en cours…";
        try {
          const response = await fetch("/generate-tags", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const data = await response.json().catch(function() { return { ok: false, error: "Erreur génération tags" }; });
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || "Erreur génération tags");
          }
          renderKeywordsInEditor(subjectEl, data.mainKeyword || "");
          await fetch("/save-update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subject: payload.subject, ai: { mainKeyword: getMainKeywordFromEditor(subjectEl) } })
          });
          tagsGenerateBtn.textContent = "✓ Tags générés";
        } catch (error) {
          alert(error.message || "Erreur génération tags");
          tagsGenerateBtn.textContent = "Générer tags";
        } finally {
          tagsGenerateBtn.disabled = false;
        }
        return;
      }

      const fullArticleBtn = e.target.closest(".full-article-btn");
      if (fullArticleBtn) {
        const subjectEl = fullArticleBtn.closest(".subject");
        const basePayload = decodeStoryData(subjectEl?.dataset.subjectPayload || "") || {};
        const selectedContents = getSelectedContents(subjectEl);
        const payload = {
          subject: basePayload.subject || subjectEl.querySelector("h3")?.textContent.trim() || "",
          contents: selectedContents
        };

        fullArticleBtn.disabled = true;
        fullArticleBtn.textContent = "Résumé en cours…";
        try {
          const response = await fetch("/generate-full-article", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const data = await response.json().catch(function() { return { ok: false, error: "Erreur génération résumé" }; });
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || "Erreur génération résumé");
          }
          const resumeEl = subjectEl.querySelector(".resume");
          if (resumeEl) {
            resumeEl.textContent = String(data.article || "").trim();
            updateAiEditorCounters(subjectEl);
          }
          subjectEl.dataset.rawSummary = String(data.article || "").trim();
          const fullArticleState = subjectEl.querySelector(".full-article-state");
          if (fullArticleState) {
            fullArticleState.value = "summary";
          }
          subjectEl.querySelector(".final-article-btn")?.classList.remove("hidden");
          fullArticleBtn.textContent = "✓ Résumé généré";
        } catch (error) {
          alert(error.message || "Erreur génération résumé");
          fullArticleBtn.textContent = "Générer résumé de l'article";
        } finally {
          fullArticleBtn.disabled = false;
        }
        return;
      }

      const finalArticleBtn = e.target.closest(".final-article-btn");
      if (finalArticleBtn) {
        const subjectEl = finalArticleBtn.closest(".subject");
        const basePayload = decodeStoryData(subjectEl?.dataset.subjectPayload || "") || {};
        const resumeEl = subjectEl.querySelector(".resume");
        const summary = (subjectEl.dataset.rawSummary || resumeEl?.textContent.trim() || "").slice(0, AI_RESUME_MAX);
        if (!summary) {
          alert("Génère d'abord le résumé de l'article.");
          return;
        }
        const subjectTitle = basePayload.subject || subjectEl.querySelector("h3")?.textContent.trim() || "";
        const fallbackContents = (() => {
          const btn = subjectEl.querySelector(".analyze-btn[data-mode='positions']");
          if (btn) { try { return (JSON.parse(btn.dataset.subject) || {}).contents || []; } catch(e) {} }
          return [];
        })();
        const contents = (basePayload.contents && basePayload.contents.length) ? basePayload.contents : fallbackContents;

        finalArticleBtn.disabled = true;
        finalArticleBtn.textContent = "Analyse en cours…";
        try {
          const response = await fetch("/generate-final-article", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subject: subjectTitle, summary, contents })
          });
          const data = await response.json().catch(function() { return { ok: false, error: "Erreur analyse médiatique" }; });
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || "Erreur analyse médiatique");
          }

          subjectEl.dataset.hasMediaContrast = "false";
          subjectEl.dataset.mediaTreatment = "";
          subjectEl.dataset.mainIssue = String(data.mainIssue || "");
          subjectEl.dataset.narrativeTension = String(data.narrativeTension || "");
          subjectEl.dataset.debatePotential = String(data.debatePotential || "");
          subjectEl.dataset.editorialWarning = String(data.editorialWarning || "");
          subjectEl.dataset.possibleBiases = JSON.stringify(Array.isArray(data.possibleBiases) ? data.possibleBiases : []);
          subjectEl.dataset.debateAngle = String(data.debateAngle || "");
          const limitedQuestion = limitClientDebateQuestion(data.debateQuestion || "");
          const questionEl = subjectEl.querySelector(".debate-question");
          if (questionEl) questionEl.textContent = limitedQuestion;
          ensurePositionsBox(subjectEl, data.positionA || "", data.positionB || "");
          updatePoliticalTag(subjectEl, !!(data.politicalOrientation && data.politicalOrientation.isPolitical));
          updateAiEditorCounters(subjectEl);
          const agonBtn = subjectEl.querySelector(".agon-btn");
          const republishBtn = subjectEl.querySelector(".republish-btn");
          if (agonBtn) { agonBtn.dataset.question = limitedQuestion; agonBtn.dataset.positionA = String(data.positionA || "").trim(); agonBtn.dataset.positionB = String(data.positionB || "").trim(); agonBtn.dataset.politicalOrientation = data.politicalOrientation ? JSON.stringify(data.politicalOrientation) : ""; }
          if (republishBtn) { republishBtn.dataset.question = limitedQuestion; republishBtn.dataset.positionA = String(data.positionA || "").trim(); republishBtn.dataset.positionB = String(data.positionB || "").trim(); republishBtn.dataset.politicalOrientation = data.politicalOrientation ? JSON.stringify(data.politicalOrientation) : ""; }
          const fullArticleState = subjectEl.querySelector(".full-article-state");
          if (fullArticleState) fullArticleState.value = "problematique";
          setDefinitiveArticleButtons(subjectEl, { hidden: false, disabled: false, state: "idle" });
          finalArticleBtn.textContent = "✓ Angle & question générés";
        } catch (error) {
          alert(error.message || "Erreur analyse médiatique");
          finalArticleBtn.textContent = "Analyser les médias";
        } finally {
          finalArticleBtn.disabled = false;
        }
        return;
      }

      const definitiveArticleBtn = e.target.closest(".definitive-article-btn");
      if (definitiveArticleBtn) {
        const subjectEl = definitiveArticleBtn.closest(".subject");
        const resumeEl = subjectEl.querySelector(".resume");
        const summary = (subjectEl.dataset.rawSummary || resumeEl?.textContent.trim() || "").slice(0, AI_RESUME_MAX);
        if (!summary) {
          alert("Génère d'abord le résumé et la problématique.");
          return;
        }

        setDefinitiveArticleButtons(subjectEl, { disabled: true, state: "story" });
        try {
          await suggestStoryForSubject(subjectEl);
          setDefinitiveArticleButtons(subjectEl, { disabled: true, state: "loading" });
          const questionEl = subjectEl.querySelector(".debate-question");
          const editables = subjectEl.querySelectorAll(".positions-box .editable");
          const debateQuestion = questionEl?.textContent.trim() || "";
          const positionA = editables[0]?.textContent.trim() || "";
          const positionB = editables[1]?.textContent.trim() || "";
          const response = await fetch("/generate-styled-article", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              subject: subjectEl.querySelector("h3")?.textContent.trim() || "",
              summary,
              debateAngle: subjectEl.dataset.debateAngle || "",
              debateQuestion,
              positionA,
              positionB,
              hasMediaContrast: subjectEl.dataset.hasMediaContrast === "true",
              mediaTreatment: subjectEl.dataset.mediaTreatment || "",
              mainIssue: subjectEl.dataset.mainIssue || "",
              narrativeTension: subjectEl.dataset.narrativeTension || "",
              possibleBiases: JSON.parse(subjectEl.dataset.possibleBiases || "[]"),
              debatePotential: subjectEl.dataset.debatePotential || "",
              editorialWarning: subjectEl.dataset.editorialWarning || ""
            })
          });
          const data = await response.json().catch(function() { return { ok: false, error: "Erreur génération article définitif" }; });
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || "Erreur génération article définitif");
          }

          const styledArticle = String(data.article || "").trim();
          if (resumeEl && styledArticle) {
            resumeEl.dataset.rawText = styledArticle;
            resumeEl.innerHTML = renderArticleHtml(styledArticle);
          }
          if (questionEl && data.debateQuestion) {
            questionEl.textContent = limitClientDebateQuestion(data.debateQuestion);
          }
          if (data.positionA || data.positionB) {
            ensurePositionsBox(subjectEl, data.positionA || positionA, data.positionB || positionB);
          }
          updateAiEditorCounters(subjectEl);
          const fullArticleState = subjectEl.querySelector(".full-article-state");
          if (fullArticleState) fullArticleState.value = "full";
          setDefinitiveArticleButtons(subjectEl, { hidden: false, disabled: false, state: "done" });
        } catch (error) {
          alert(error.message || "Erreur génération article définitif");
          setDefinitiveArticleButtons(subjectEl, { disabled: false, state: "idle" });
        } finally {
          setDefinitiveArticleButtons(subjectEl, { disabled: false });
        }
        return;
      }

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
      updateAiEditorCounters(subjectEl);
      const mainKeyword = getMainKeywordFromEditor(subjectEl);
      const agonEl = subjectEl.querySelector(".agon-select");
      const editables = subjectEl.querySelectorAll(".editable");
      const sourcesEl = subjectEl.querySelector(".sources");
      let storySelection = null;
      try { storySelection = collectStorySelection(subjectEl); } catch (storyErr) { console.warn("Story selection ignorée :", storyErr.message); }

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
        debateQuestion: questionEl ? limitClientDebateQuestion(questionEl.textContent) : "",
        resume: resumeEl ? (resumeEl.dataset.rawText || resumeEl.textContent.trim()).slice(0, AI_RESUME_MAX) : "",
        mainKeyword,
        agonTheme: agonEl ? agonEl.value : "",
        positionA: editables[0] ? editables[0].textContent.trim() : "",
        positionB: editables[1] ? editables[1].textContent.trim() : "",
        sources: sourcesEl ? sourcesEl.textContent.trim() : "",
        contents: contentItems,
        sessionLabel,
        storySelection,
        politicalGroup: subjectEl.dataset.politicalGroup || "mixed"
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
        rehydratePersistentStates();
      } catch (err) {
        console.error("Erreur save :", err);
      }
    });

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest(".agon-btn, .republish-btn");
      if (!btn) return;
      const isRepublish = btn.classList.contains("republish-btn");
      btn.disabled = true;
      btn.textContent = isRepublish ? "Republication…" : "Envoi…";
      try {
        const subjectEl = btn.closest(".subject");
        let storySelection = null;
        try { storySelection = collectStorySelection(subjectEl); } catch (storyErr) { console.warn("Story selection ignorée :", storyErr.message); }
        updateAiEditorCounters(subjectEl);
        const subject = subjectEl.querySelector("h3")?.textContent.trim() || "";
        const sessionEl = subjectEl.closest(".session");
        const sessionLabel = sessionEl ? (sessionEl.querySelector(".session-header strong") || {}).textContent?.trim() || "" : "";
        const fullArticleState = subjectEl.querySelector(".full-article-state");
        const fullArticleMode = String(fullArticleState?.value || "short").trim();
        if (fullArticleMode !== "full") {
          const shouldContinue = window.confirm("Tu n'as pas généré l'article définitif. Tu peux continuer quand même, mais veux-tu vraiment envoyer cette version sur Agôn ?");
          if (!shouldContinue) {
            btn.disabled = false;
            btn.textContent = isRepublish ? "↺ Republier" : "→ Agôn";
            return;
          }
        }
        const question = limitClientDebateQuestion(subjectEl.querySelector(".debate-question")?.textContent.trim() || btn.dataset.question || "");
        const editables = subjectEl.querySelectorAll(".editable");
        const positionA = editables[0]?.textContent.trim() || btn.dataset.positionA;
        const positionB = editables[1]?.textContent.trim() || btn.dataset.positionB;
        const theme = subjectEl.querySelector(".agon-select")?.value || btn.dataset.theme;
        const resumeEl3 = subjectEl.querySelector(".resume");
        const resume = (resumeEl3?.dataset.rawText || resumeEl3?.textContent.trim() || "").slice(0, AI_RESUME_MAX);
        const keywords = [getMainKeywordFromEditor(subjectEl)].filter(Boolean);
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
        const politicalGroup = (subjectEl.dataset.politicalGroup === "left" || subjectEl.dataset.politicalGroup === "right") ? subjectEl.dataset.politicalGroup : "mixed";

        const res = await fetch(SEND_TO_AGON_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject, sessionLabel, question, positionA, positionB, theme, resume, sources, links, storySelection, keywords, politicalOrientation: btn.dataset.politicalOrientation ? JSON.parse(btn.dataset.politicalOrientation) : null, politicalGroup, force: isRepublish })
        });
        if (!res.ok) {
          let serverMessage = "";
          try { serverMessage = (await res.json()).error || ""; } catch (parseErr) {}
          throw new Error(serverMessage || "Échec de l'envoi vers Agôn");
        }
        const subjectElBtn = btn.closest(".subject");
        const primaryBtn = subjectElBtn?.querySelector(".agon-btn");
        const republishBtn = subjectElBtn?.querySelector(".republish-btn");
        if (primaryBtn) {
          primaryBtn.classList.add("sent");
          primaryBtn.textContent = "✓ Envoyé";
        }
        if (republishBtn) {
          republishBtn.classList.remove("hidden");
          republishBtn.disabled = false;
          republishBtn.textContent = "↺ Republier";
        }
        rehydratePersistentStates();
      } catch (error) {
        btn.disabled = false;
        btn.textContent = isRepublish ? "↺ Republier" : "→ Agôn";
        if (error && error.message) {
          alert(error.message);
        }
      }
    });

    document.addEventListener("change", function(e) {
      if (e.target.classList.contains("story-manual-select")) {
        updateManualStorySelection(e.target.closest(".story-link-box"));
        return;
      }
    });

    document.addEventListener("input", function(e) {
      if (e.target.classList.contains("debate-question") || e.target.classList.contains("resume")) {
        updateAiEditorCounters(e.target.closest(".subject"));
      }
    });

    document.addEventListener("click", function(e) {
      if (e.target.classList.contains("story-articles-modal") || e.target.closest(".story-articles-close")) {
        closeStoryArticlesModal();
        return;
      }
      if (!e.target.closest('.story-picker-row')) {
        document.querySelectorAll('.story-dropdown').forEach(function(dropdown) { dropdown.classList.add('hidden'); });
        document.querySelectorAll('.story-picker-trigger').forEach(function(trigger) { trigger.setAttribute('aria-expanded', 'false'); });
      }
      const saveBtn = e.target.closest(".story-save-btn");
      if (saveBtn && !saveBtn.classList.contains("context-save-btn")) {
        saveStoryEdits(saveBtn.closest(".story-link-box"));
        return;
      }
      const storyTrigger = e.target.closest('.story-picker-trigger');
      if (storyTrigger) {
        const row = storyTrigger.closest('.story-picker-row');
        const dropdown = row?.querySelector('.story-dropdown');
        if (dropdown) {
          const nextHidden = !dropdown.classList.contains('hidden');
          document.querySelectorAll('.story-dropdown').forEach(function(item) { if (item !== dropdown) item.classList.add('hidden'); });
          document.querySelectorAll('.story-picker-trigger').forEach(function(trigger) { if (trigger !== storyTrigger) trigger.setAttribute('aria-expanded', 'false'); });
          dropdown.classList.toggle('hidden', nextHidden);
          storyTrigger.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
          const box = storyTrigger.closest('.story-link-box');
          const searchInput = row?.querySelector('.story-search-input');
          if (searchInput) {
            if (nextHidden) {
              searchInput.value = '';
              filterStoryDropdown(box, '');
            } else {
              searchInput.focus();
            }
          }
        }
        return;
      }
      const createStoryInlineBtn = e.target.closest(".story-create-inline-btn");
      if (createStoryInlineBtn) {
        openNewStoryPrompt(createStoryInlineBtn.closest(".story-link-box"));
        return;
      }
      const selectStoryBtn = e.target.closest(".story-library-select-btn");
      if (selectStoryBtn) {
        const box = selectStoryBtn.closest(".story-link-box");
        const row = selectStoryBtn.closest(".story-library-row");
        const storyId = String(row?.dataset.storyId || "");
        const select = box?.querySelector(".story-manual-select");
        if (select) {
          select.value = storyId;
          updateManualStorySelection(box);
        }
        return;
      }
      const viewStoryBtn = e.target.closest(".story-view-btn");
      if (viewStoryBtn) {
        const box = viewStoryBtn.closest(".story-link-box");
        const row = viewStoryBtn.closest(".story-library-row");
        const storyId = row?.dataset.storyId || "";
        openStoryArticles(box, storyId).catch(function(error) {
          alert(error.message || "Erreur chargement articles de l'histoire");
        });
        return;
      }
      const editStoryBtn = e.target.closest(".story-edit-btn");
      if (editStoryBtn) {
        const box = editStoryBtn.closest(".story-link-box");
        const row = editStoryBtn.closest(".story-library-row");
        const storyId = row?.dataset.storyId || "";
        editExistingStory(box, storyId).catch(function(error) {
          alert(error.message || "Erreur modification histoire");
        });
        return;
      }
      const deleteStoryBtn = e.target.closest(".story-delete-btn");
      if (deleteStoryBtn) {
        const box = deleteStoryBtn.closest(".story-link-box");
        const row = deleteStoryBtn.closest(".story-library-row");
        const storyId = row?.dataset.storyId || "";
        deleteExistingStory(box, storyId).catch(function(error) {
          alert(error.message || "Erreur suppression histoire");
        });
        return;
      }
      const contextSaveBtn = e.target.closest(".context-save-btn");
      if (contextSaveBtn) {
        saveContextEdits(contextSaveBtn.closest(".subject"));
        return;
      }
      const removeBtn = e.target.closest(".news-keyword-remove-btn");
      if (!removeBtn) return;
      const chip = removeBtn.closest(".news-keyword-chip");
      if (chip) chip.remove();
    });

    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape" && document.querySelector(".story-articles-modal:not(.hidden)")) {
        closeStoryArticlesModal();
        return;
      }
    });

    async function rehydratePersistentStates() {
      try {
        const [savedRes, sentRes] = await Promise.all([
          fetch("/api/saved-subjects?t=" + Date.now()),
          fetch("/api/sent-to-agon-items?t=" + Date.now())
        ]);
        const savedData = await savedRes.json().catch(function() { return { ok: false, subjects: [], items: [] }; });
        const sentData = await sentRes.json().catch(function() { return { ok: false, items: [], keys: [] }; });

        const savedSubjects = new Set(Array.isArray(savedData.subjects) ? savedData.subjects.map(function(item) { return String(item || "").trim(); }).filter(Boolean) : []);
        const sentKeys = new Set(Array.isArray(sentData.keys) ? sentData.keys.map(function(item) { return String(item || "").trim(); }).filter(Boolean) : []);
        // politicalGroup posé par "Cocher les 10" n'existe qu'en mémoire (dataset) tant
        // que generateSubjectPipeline() ne l'a pas envoyé — sans cette restauration, un
        // rechargement de page entre "Cocher les 10" et "Tout générer" le ferait
        // silencieusement retomber sur "mixed", même pour un sujet enregistré.
        const savedPoliticalGroupByTitle = new Map(
          (Array.isArray(savedData.items) ? savedData.items : []).map(function(item) {
            const group = (item?.politicalGroup === "left" || item?.politicalGroup === "right") ? item.politicalGroup : "mixed";
            return [String(item?.subject || "").trim(), group];
          })
        );

        document.querySelectorAll('.subject').forEach(function(subjectEl) {
          const saveBtn = subjectEl.querySelector('.save-btn');
          const agonBtn = subjectEl.querySelector('.agon-btn');
          const republishBtn = subjectEl.querySelector('.republish-btn');
          const subjectTitle = saveBtn?.dataset.subjectTitle || agonBtn?.dataset.subjectTitle || subjectEl.querySelector('h3')?.textContent.trim() || "";
          const question = agonBtn?.dataset.question || subjectEl.querySelector('.debate-question')?.textContent.trim() || "";
          ensureArticleGenerationPanel(subjectEl);
          syncDefinitiveArticleButtonsFromState(subjectEl);

          if (saveBtn) {
            const isSaved = savedSubjects.has(String(subjectTitle || "").trim());
            saveBtn.classList.toggle('saved', isSaved);
            saveBtn.textContent = isSaved ? '★ Enregistré' : '☆ Enregistrer';
            const savedGroup = savedPoliticalGroupByTitle.get(String(subjectTitle || "").trim());
            if (savedGroup) subjectEl.dataset.politicalGroup = savedGroup;
          }

          if (agonBtn) {
            const isSent = sentKeys.has(String(question || "").trim()) || sentKeys.has(String(subjectTitle || "").trim());
            agonBtn.classList.toggle('sent', isSent);
            agonBtn.textContent = isSent ? '✓ Envoyé' : '→ Agôn';
            if (republishBtn) {
              republishBtn.classList.toggle('hidden', !isSent);
            }
          }
        });

        sortSubjects();
      } catch (error) {
        console.error('Erreur réhydratation états persistants :', error);
      }
    }

    let currentSort = "score";

    function getActiveSession() {
      return document.querySelector(".session.active-session");
    }

    function updateArenaSelectionButton(subject) {
      const btn = subject.querySelector(".arena-select-btn");
      const selected = subject.classList.contains("selected");
      if (!btn) return;
      btn.textContent = selected ? "Sélectionné" : "Sélectionner";
      btn.setAttribute("aria-pressed", selected ? "true" : "false");
    }

    function updateSavedSelectionUi() {
      const isSavedMode = currentSort === "saved";
      const bar = document.getElementById("saved-selection-bar");
      document.body.classList.toggle("saved-selection-mode", isSavedMode);
      if (bar) bar.classList.toggle("visible", isSavedMode);
      const rankedBar = document.getElementById("ranked-action-bar");
      if (rankedBar) rankedBar.classList.toggle("visible", TOP10_BAR_SORTS.includes(currentSort));

      const activeSession = getActiveSession();
      const count = isSavedMode && activeSession ? activeSession.querySelectorAll(".subject.selected").length : 0;
      const countEl = document.getElementById("selected-count");
      if (countEl) countEl.textContent = String(count);
    }

    function clearThemeHeaders(session) {
      session.querySelectorAll(":scope > .theme-header").forEach(h => h.remove());
    }

    function applyThemeGrouping(activeSession) {
      if (!activeSession) return;
      clearThemeHeaders(activeSession);
      const subjects = [...activeSession.querySelectorAll(":scope > .subject")];
      subjects.forEach(s => { s.style.display = ""; });

      const byTheme = new Map();
      [...AGON_THEMES, "Non analysé"].forEach(t => byTheme.set(t, []));
      subjects.forEach(s => {
        const t = s.dataset.theme || "Non analysé";
        (byTheme.has(t) ? byTheme.get(t) : byTheme.get("Non analysé")).push(s);
      });

      let visibleCount = 0;
      byTheme.forEach((themeSubjects, theme) => {
        if (!themeSubjects.length) return;
        themeSubjects.sort((a, b) => Number(b.dataset.score) - Number(a.dataset.score));
        const header = document.createElement("div");
        header.className = "theme-header";
        header.textContent = theme;
        activeSession.appendChild(header);
        themeSubjects.forEach((s, i) => {
          activeSession.appendChild(s);
          visibleCount++;
          const badge = s.querySelector(".subject-number");
          if (badge) badge.textContent = visibleCount + "/" + subjects.length;
        });
      });
      updateSavedSelectionUi();
    }

    function setSubjectStatCounts(s, sourceCount, articleCount, videoCount) {
      const sourcesEl = s.querySelector(".stat-sources-count");
      const sourcesDropdownEl = s.querySelector(".stat-sources-dropdown-count");
      const articlesEl = s.querySelector(".stat-articles-count");
      const videosEl = s.querySelector(".stat-videos-count");
      if (sourcesEl) sourcesEl.textContent = String(sourceCount);
      if (sourcesDropdownEl) sourcesDropdownEl.textContent = String(sourceCount);
      if (articlesEl) articlesEl.textContent = String(articleCount);
      if (videosEl) videosEl.textContent = String(videoCount);
    }

    function resetOrientationFilter(activeSession) {
      activeSession.querySelectorAll(".content-item[data-orientation]").forEach(item => {
        item.style.display = "";
        const checkbox = item.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = item.classList.contains("preselected");
      });
      activeSession.querySelectorAll(".sources-dropdown h4, .sources-dropdown h4 + ul").forEach(el => {
        el.style.display = "";
      });
      activeSession.querySelectorAll(":scope > .subject").forEach(s => {
        const totalArticles = s.querySelectorAll(".content-item[data-type='article']").length;
        const totalVideos = s.querySelectorAll(".content-item[data-type='youtube']").length;
        setSubjectStatCounts(s, Number(s.dataset.sources) || 0, totalArticles, totalVideos);
      });
    }

    function sortSubjects() {
      const activeSession = getActiveSession();
      if (!activeSession) return;

      if (currentSort !== "left" && currentSort !== "right") {
        resetOrientationFilter(activeSession);
      }

      if (currentSort === "left" || currentSort === "right") {
        clearThemeHeaders(activeSession);
        const subjects = [...activeSession.querySelectorAll(":scope > .subject")];
        const counts = new Map();
        subjects.forEach(s => {
          let articleCount = 0;
          let videoCount = 0;
          const matchingSources = new Set();
          s.querySelectorAll(".content-item[data-orientation]").forEach(item => {
            const matches = getOrientationGroupClient(item.dataset.orientation) === currentSort;
            item.style.display = matches ? "" : "none";
            const cb = item.querySelector('input[type="checkbox"]');
            if (cb) cb.checked = matches;
            if (matches) {
              if (item.dataset.type === "article") articleCount++;
              if (item.dataset.type === "youtube") videoCount++;
              const sourceName = item.querySelector("strong")?.textContent.trim();
              if (sourceName) matchingSources.add(sourceName);
            }
          });
          s.querySelectorAll(".sources-dropdown h4").forEach(h4 => {
            const ul = h4.nextElementSibling;
            if (!ul || ul.tagName !== "UL") return;
            const anyVisible = [...ul.querySelectorAll(".content-item")].some(li => li.style.display !== "none");
            h4.style.display = anyVisible ? "" : "none";
            ul.style.display = anyVisible ? "" : "none";
          });
          setSubjectStatCounts(s, matchingSources.size, articleCount, videoCount);
          counts.set(s, matchingSources.size);
        });
        subjects.sort((a, b) => counts.get(b) - counts.get(a));
        const visible = [];
        subjects.forEach(s => {
          activeSession.appendChild(s);
          const hide = counts.get(s) === 0;
          s.style.display = hide ? "none" : "";
          if (!hide) visible.push(s);
        });
        visible.forEach((s, i) => {
          const badge = s.querySelector(".subject-number");
          if (badge) badge.textContent = (i + 1) + "/" + visible.length;
        });
        updateSavedSelectionUi();
        return;
      }

      if (currentSort === "ranked") {
        clearThemeHeaders(activeSession);
        const subjects = [...activeSession.querySelectorAll(":scope > .subject")];
        const maxSources = Math.max(...subjects.map(s => Number(s.dataset.sources) || 0), 1);
        subjects.sort((a, b) => {
          const sA = (Number(a.dataset.sources) / maxSources) * 0.50 + (Number(a.dataset.score) / 10) * 0.50;
          const sB = (Number(b.dataset.sources) / maxSources) * 0.50 + (Number(b.dataset.score) / 10) * 0.50;
          return sB - sA;
        });
        subjects.forEach((s, i) => {
          s.style.display = "";
          activeSession.appendChild(s);
          const badge = s.querySelector(".subject-number");
          if (badge) badge.textContent = (i + 1) + "/" + subjects.length;
        });
        updateSavedSelectionUi();
        return;
      }

      if (currentSort === "theme") {
        applyThemeGrouping(activeSession);
        return;
      }
      clearThemeHeaders(activeSession);
      const subjects = [...activeSession.querySelectorAll(":scope > .subject")];
      if (currentSort !== "saved") {
        subjects.sort((a, b) => Number(b.dataset[currentSort]) - Number(a.dataset[currentSort]));
      }
      const visible = [];
      subjects.forEach((s) => {
        activeSession.appendChild(s);
        const isSaved = s.querySelector(".save-btn")?.classList.contains("saved");
        const hide = currentSort === "saved" && !isSaved;
        s.style.display = hide ? "none" : "";
        if (!hide) visible.push(s);
      });
      visible.forEach((s, i) => {
        const badge = s.querySelector(".subject-number");
        if (badge) badge.textContent = (i + 1) + "/" + visible.length;
      });
      updateSavedSelectionUi();
    }

    document.addEventListener("click", (e) => {
      const selectBtn = e.target.closest(".arena-select-btn");
      if (selectBtn) {
        const subject = selectBtn.closest(".subject");
        if (subject) {
          subject.classList.toggle("selected");
          updateArenaSelectionButton(subject);
          updateSavedSelectionUi();
        }
        return;
      }

      if (e.target.closest(".select-all-arenas-btn")) {
        const activeSession = getActiveSession();
        if (activeSession) {
          activeSession.querySelectorAll(".subject").forEach(subject => {
            const isVisible = subject.style.display !== "none";
            subject.classList.toggle("selected", isVisible);
            updateArenaSelectionButton(subject);
          });
          updateSavedSelectionUi();
        }
        const selectAllBtn = document.querySelector(".select-all-arenas-btn");
        const clearBtn = document.querySelector(".clear-selection-btn");
        if (selectAllBtn) { selectAllBtn.style.background = "#111"; selectAllBtn.style.borderColor = "#111"; selectAllBtn.style.color = "#fff"; }
        if (clearBtn) { clearBtn.style.background = ""; clearBtn.style.borderColor = ""; clearBtn.style.color = ""; }
        return;
      }

      if (e.target.closest(".clear-selection-btn")) {
        const activeSession = getActiveSession();
        if (activeSession) {
          activeSession.querySelectorAll(".subject.selected").forEach(subject => {
            subject.classList.remove("selected");
            updateArenaSelectionButton(subject);
          });
          updateSavedSelectionUi();
        }
        const selectAllBtn = document.querySelector(".select-all-arenas-btn");
        const clearBtn = document.querySelector(".clear-selection-btn");
        if (clearBtn) { clearBtn.style.background = "#111"; clearBtn.style.borderColor = "#111"; clearBtn.style.color = "#fff"; }
        if (selectAllBtn) { selectAllBtn.style.background = ""; selectAllBtn.style.borderColor = ""; selectAllBtn.style.color = ""; }
      }

    });

    async function generateSubjectPipeline(subjectEl, setStatus) {
      // Mode d'arène choisi pour ce sujet (source de vérité = subjectEl.dataset.arenaMode, "positions" par défaut)
      const arenaMode = subjectEl.dataset.arenaMode === "libre" ? "libre" : "positions";
      // Groupe politique (source de vérité = subjectEl.dataset.politicalGroup, posé par "Cocher les 10" sur les filtres Médias de gauche/droite ; "mixed" sinon)
      const politicalGroup = (subjectEl.dataset.politicalGroup === "left" || subjectEl.dataset.politicalGroup === "right") ? subjectEl.dataset.politicalGroup : "mixed";

      // Étape 1 : Analyse IA (si pas encore fait), dans le mode choisi
      const analyzeBtn = subjectEl.querySelector(".analyze-btn[data-mode='positions']") || subjectEl.querySelector(".analyze-btn");
      if (analyzeBtn) {
        setStatus("Analyse IA…");
        const subjectData = JSON.parse(analyzeBtn.dataset.subject);
        subjectData.arenaMode = arenaMode;
        const aiBox = analyzeBtn.closest(".ai-box");
        const aiScore = subjectEl.querySelector(".ai-score.pending");
        const res = await fetchWithTimeout("/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subjectData) });
        if (!res.ok) throw new Error("Erreur analyse");
        const ai = await res.json();
        ai.sourceSubject = subjectData.subject || "";
        if (subjectData.arenaMode === "libre") {
          // Même normalisation que le clic manuel sur "Générer arène libre IA" : pas de question de débat ni de positions à ce stade.
          ai.arenaMode = "libre";
          ai.debateQuestion = subjectData.subject || ai.debateQuestion || "";
          ai.positionA = "";
          ai.positionB = "";
        }
        subjectEl.dataset.subjectPayload = encodeStoryData(subjectData);
        subjectEl.dataset.arenaMode = ai.arenaMode === "libre" ? "libre" : "positions";
        const modeLabelStep1 = subjectEl.querySelector(".arena-mode-label");
        if (modeLabelStep1) modeLabelStep1.textContent = subjectEl.dataset.arenaMode === "libre" ? "Arène libre" : "Arène à positions";
        if (aiScore) aiScore.outerHTML = buildAiScoreHtml(ai);
        if (aiBox) aiBox.outerHTML = buildAiBoxHtml(ai);
        ensureArticleGenerationPanel(subjectEl);
        updateAiEditorCounters(subjectEl);
        initializeStoryBoxes(subjectEl);
        const agonBtnStep1 = subjectEl.querySelector(".agon-btn");
        if (agonBtnStep1) { agonBtnStep1.dataset.question = limitClientDebateQuestion(ai.debateQuestion || subjectData.subject || ""); agonBtnStep1.dataset.positionA = ai.positionA || ""; agonBtnStep1.dataset.positionB = ai.positionB || ""; agonBtnStep1.dataset.theme = normalizeAgonTheme(ai.agonTheme); }
        const preselectedLinks = new Set(Array.isArray(ai.selectedLinks) ? ai.selectedLinks.map(l => String(l || "").trim()).filter(Boolean) : []);
        subjectEl.querySelectorAll(".content-item[data-link]").forEach(item => { const cb = item.querySelector('input[type="checkbox"]'); const sel = preselectedLinks.size === 0 || preselectedLinks.has(item.dataset.link); if (cb) cb.checked = sel; item.classList.toggle("preselected", sel); });
        await fetch("/save-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: subjectData.subject, debateScore: ai.debateScore, controversyLevel: ai.controversyLevel, ai: { ...ai, fullArticleState: "short" } }) });
      }

      const basePayload = decodeStoryData(subjectEl.dataset.subjectPayload || "") || {};
      const subjectTitle = basePayload.subject || subjectEl.querySelector("h3")?.textContent.trim() || "";
      // Fallback contents depuis le bouton Analyser si basePayload vide
      const pipelineFallbackContents = (() => {
        const btn = subjectEl.querySelector(".analyze-btn[data-mode='positions']");
        if (btn) { try { return (JSON.parse(btn.dataset.subject) || {}).contents || []; } catch(e) {} }
        return [];
      })();
      const pipelineContents = (basePayload.contents && basePayload.contents.length) ? basePayload.contents : pipelineFallbackContents;
      const fullArticleState = subjectEl.querySelector(".full-article-state");
      const alreadyFull = String(fullArticleState?.value || "short").trim() === "full";
      let resumeEl = subjectEl.querySelector(".resume");
      let questionEl = subjectEl.querySelector(".debate-question");
      let genErrorMessage = "";

      if (!alreadyFull) {
        try {
          // Étape 2 : Résumé factuel
          setStatus("Résumé…");
          const allContentItems = [...subjectEl.querySelectorAll(".content-item[data-link]")];
          const anyChecked = allContentItems.some(item => item.querySelector('input[type="checkbox"]')?.checked);
          if (!anyChecked && allContentItems.length > 0) {
            allContentItems.forEach(item => { const cb = item.querySelector('input[type="checkbox"]'); if (cb) cb.checked = true; });
          }
          const fullRes = await fetchWithTimeout("/generate-full-article", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: subjectTitle, contents: getSelectedContents(subjectEl), arenaMode }) });
          const fullData = await fullRes.json().catch(() => ({}));
          if (!fullRes.ok || fullData.ok === false) throw new Error(fullData.error || "Erreur résumé");
          const summaryText = String(fullData.article || "").trim();
          subjectEl.dataset.rawSummary = summaryText;
          resumeEl = subjectEl.querySelector(".resume");
          if (resumeEl) { resumeEl.textContent = summaryText; updateAiEditorCounters(subjectEl); }
          if (fullArticleState) fullArticleState.value = "summary";
          subjectEl.querySelector(".final-article-btn")?.classList.remove("hidden");
          const fullBtn = subjectEl.querySelector(".full-article-btn");
          if (fullBtn) fullBtn.textContent = "✓ Résumé généré";

          if (arenaMode === "libre") {
            // ---- Pipeline ARÈNE LIBRE : titre factuel + article factuel, sans question ni positions ----
            setStatus("Titre & article factuels…");
            subjectEl.dataset.hasMediaContrast = "false";
            subjectEl.dataset.mediaTreatment = "";
            subjectEl.dataset.mainIssue = "";
            subjectEl.dataset.narrativeTension = "";
            subjectEl.dataset.debatePotential = "";
            subjectEl.dataset.editorialWarning = "";
            subjectEl.dataset.possibleBiases = "[]";
            subjectEl.dataset.debateAngle = "";

            const freeRes = await fetchWithTimeout("/generate-free-article", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: subjectTitle, summary: summaryText, arenaMode }) });
            const freeData = await freeRes.json().catch(() => ({}));
            if (!freeRes.ok || freeData.ok === false) throw new Error(freeData.error || "Erreur article factuel");

            const factualTitle = limitClientFactualTitle(freeData.debateQuestion || subjectTitle);
            questionEl = subjectEl.querySelector(".debate-question");
            if (questionEl) questionEl.textContent = factualTitle;
            removePositionsBox(subjectEl);

            const freeArticle = String(freeData.article || "").trim();
            resumeEl = subjectEl.querySelector(".resume");
            if (resumeEl && freeArticle) { resumeEl.dataset.rawText = freeArticle; resumeEl.innerHTML = renderArticleHtml(freeArticle, { arenaMode: "libre" }); }
            updateAiEditorCounters(subjectEl);

            const agonBtnLibre = subjectEl.querySelector(".agon-btn");
            if (agonBtnLibre) { agonBtnLibre.dataset.question = factualTitle; agonBtnLibre.dataset.positionA = ""; agonBtnLibre.dataset.positionB = ""; agonBtnLibre.dataset.politicalOrientation = ""; }
            if (fullArticleState) fullArticleState.value = "full";
            const finalBtnLibre = subjectEl.querySelector(".final-article-btn");
            if (finalBtnLibre) finalBtnLibre.textContent = "✓ Titre & article générés";

            // Suggestion d'histoire
            await suggestStoryForSubject(subjectEl, setStatus);

            // Devise latine de synthèse — prompt dédié à l'arène libre, exécuté en dernier sur l'article final
            setStatus("Devise latine…");
            const mottoArticleText = (resumeEl?.dataset.rawText || resumeEl?.textContent || "").trim();
            if (mottoArticleText) {
              try {
                const mottoSources = [...new Set(pipelineContents.map(c => c.source).filter(Boolean))];
                const mottoRes = await fetchWithTimeout("/generate-latin-motto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: factualTitle || subjectTitle, summary: summaryText, article: mottoArticleText, sources: mottoSources, agonTheme: agonBtnLibre?.dataset.theme || "" }) });
                const mottoData = await mottoRes.json().catch(() => ({}));
                if (mottoRes.ok && mottoData.ok !== false && mottoData.article) {
                  const articleWithMotto = String(mottoData.article).trim();
                  resumeEl = subjectEl.querySelector(".resume");
                  if (resumeEl && articleWithMotto) { resumeEl.dataset.rawText = articleWithMotto; resumeEl.innerHTML = renderArticleHtml(articleWithMotto, { arenaMode: "libre" }); }
                  updateAiEditorCounters(subjectEl);
                }
              } catch (mottoErr) {
                console.error("Erreur devise latine (arène libre) :", mottoErr.message);
              }
            }
          } else {
            // ---- Pipeline ARÈNE À POSITIONS (comportement actuel, inchangé) ----
            // Étape 3 : Angle de débat + question
            setStatus("Angle & question…");
            const mediaRes = await fetchWithTimeout("/generate-final-article", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: subjectTitle, summary: summaryText, contents: pipelineContents, arenaMode }) });
            const mediaData = await mediaRes.json().catch(() => ({}));
            if (!mediaRes.ok || mediaData.ok === false) throw new Error(mediaData.error || "Erreur angle & question");
            subjectEl.dataset.hasMediaContrast = "false";
            subjectEl.dataset.mediaTreatment = "";
            subjectEl.dataset.mainIssue = String(mediaData.mainIssue || "");
            subjectEl.dataset.narrativeTension = String(mediaData.narrativeTension || "");
            subjectEl.dataset.debatePotential = String(mediaData.debatePotential || "");
            subjectEl.dataset.editorialWarning = String(mediaData.editorialWarning || "");
            subjectEl.dataset.possibleBiases = JSON.stringify(Array.isArray(mediaData.possibleBiases) ? mediaData.possibleBiases : []);
            subjectEl.dataset.debateAngle = String(mediaData.debateAngle || "");
            questionEl = subjectEl.querySelector(".debate-question");
            const limitedQuestion = limitClientDebateQuestion(mediaData.debateQuestion || "");
            if (questionEl) questionEl.textContent = limitedQuestion;
            ensurePositionsBox(subjectEl, mediaData.positionA || "", mediaData.positionB || "");
            updatePoliticalTag(subjectEl, !!(mediaData.politicalOrientation && mediaData.politicalOrientation.isPolitical));
            updateAiEditorCounters(subjectEl);
            const agonBtnStep3 = subjectEl.querySelector(".agon-btn");
            if (agonBtnStep3) { agonBtnStep3.dataset.question = limitedQuestion; agonBtnStep3.dataset.positionA = String(mediaData.positionA || "").trim(); agonBtnStep3.dataset.positionB = String(mediaData.positionB || "").trim(); agonBtnStep3.dataset.politicalOrientation = mediaData.politicalOrientation ? JSON.stringify(mediaData.politicalOrientation) : ""; }
            if (fullArticleState) fullArticleState.value = "problematique";
            const finalBtn = subjectEl.querySelector(".final-article-btn");
            if (finalBtn) finalBtn.textContent = "✓ Angle & question générés";
            setDefinitiveArticleButtons(subjectEl, { hidden: false, disabled: false, state: "idle" });

            // Suggestion d'histoire
            await suggestStoryForSubject(subjectEl, setStatus);

            // Étape 5 : Article définitif
            setStatus("Article définitif…");
            const debateQuestion = questionEl?.textContent.trim() || "";
            const editables = subjectEl.querySelectorAll(".positions-box .editable");
            const posA = editables[0]?.textContent.trim() || "";
            const posB = editables[1]?.textContent.trim() || "";
            const styledRes = await fetchWithTimeout("/generate-styled-article", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: subjectTitle, summary: summaryText, debateAngle: mediaData.debateAngle || "", debateQuestion, positionA: posA, positionB: posB, hasMediaContrast: false, mediaTreatment: "", mainIssue: mediaData.mainIssue || "", narrativeTension: mediaData.narrativeTension || "", possibleBiases: Array.isArray(mediaData.possibleBiases) ? mediaData.possibleBiases : [], debatePotential: mediaData.debatePotential || "", editorialWarning: mediaData.editorialWarning || "", editorialDecision: mediaData.editorialDecision || "", questionQuality: mediaData.questionQuality || "", arenaMode }) });
            const styledData = await styledRes.json().catch(() => ({}));
            if (!styledRes.ok || styledData.ok === false) throw new Error(styledData.error || "Erreur article définitif");
            const styledArticle = String(styledData.article || "").trim();
            resumeEl = subjectEl.querySelector(".resume");
            if (resumeEl && styledArticle) { resumeEl.dataset.rawText = styledArticle; resumeEl.innerHTML = renderArticleHtml(styledArticle); }
            questionEl = subjectEl.querySelector(".debate-question");
            if (questionEl && styledData.debateQuestion) questionEl.textContent = limitClientDebateQuestion(styledData.debateQuestion);
            if (styledData.positionA || styledData.positionB) ensurePositionsBox(subjectEl, styledData.positionA || posA, styledData.positionB || posB);
            updateAiEditorCounters(subjectEl);
            if (fullArticleState) fullArticleState.value = "full";
            setDefinitiveArticleButtons(subjectEl, { hidden: false, disabled: false, state: "done" });
          }

        } catch (genErr) {
          console.error("Erreur génération :", genErr.message);
          genErrorMessage = genErr.message || "Erreur génération inconnue";
        }
      } else {
        // Article déjà complet — suggestion histoire seulement
        await suggestStoryForSubject(subjectEl, setStatus);
      }

      if (!getMainKeywordFromEditor(subjectEl)) {
        const tagsPayload = getSubjectAnalyzePayloadFromEditor(subjectEl);
        // Ne génère le tag que si l'article est disponible — sans article,
        // l'IA n'a que le titre brut du sujet et produit des tags génériques
        // (ex. "Philippines" pour un sujet sur une éruption aux Philippines).
        if (tagsPayload.articleText) {
          setStatus("Tags…");
          const tagsRes = await fetchWithTimeout("/generate-tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tagsPayload) });
          const tagsData = await tagsRes.json().catch(() => ({}));
          if (!tagsRes.ok || tagsData.ok === false) throw new Error(tagsData.error || "Erreur tags");
          renderKeywordsInEditor(subjectEl, tagsData.mainKeyword || "");
          const tagsBtn = subjectEl.querySelector(".tags-generate-btn");
          if (tagsBtn) tagsBtn.textContent = "✓ Tags générés";
          await fetch("/save-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: tagsPayload.subject, ai: { mainKeyword: getMainKeywordFromEditor(subjectEl) } }) });
        }
      }

      // Étape 5 : Envoi vers Agôn (toujours tenté)
      setStatus("Envoi vers Agôn…");
      const agonBtnFinal = subjectEl.querySelector(".agon-btn:not(.sent)");
      if (!agonBtnFinal) return { status: "skipped-sent" };
      resumeEl = subjectEl.querySelector(".resume");
      questionEl = subjectEl.querySelector(".debate-question");
      const resumeText = (resumeEl?.dataset.rawText || resumeEl?.textContent.trim() || "").trim();
      if (!resumeText) return { status: "skipped-no-article", error: genErrorMessage };
      let storySelection = null;
      try { storySelection = collectStorySelection(subjectEl); } catch (e) { console.warn("Story selection ignorée :", e.message); }
      updateAiEditorCounters(subjectEl);
      const sessionEl = subjectEl.closest(".session");
      const sessionLabel = sessionEl ? (sessionEl.querySelector(".session-header strong") || {}).textContent?.trim() || "" : "";
      const rawFinalTitle = subjectEl.querySelector(".debate-question")?.textContent.trim() || agonBtnFinal.dataset.question || "";
      const finalQuestion = arenaMode === "libre" ? limitClientFactualTitle(rawFinalTitle) : limitClientDebateQuestion(rawFinalTitle);
      const finalEditables = subjectEl.querySelectorAll(".editable");
      const finalPosA = finalEditables[0]?.textContent.trim() || agonBtnFinal.dataset.positionA;
      const finalPosB = finalEditables[1]?.textContent.trim() || agonBtnFinal.dataset.positionB;
      const theme = subjectEl.querySelector(".agon-select")?.value || agonBtnFinal.dataset.theme;
      const resumeForSend = resumeText.slice(0, AI_RESUME_MAX);
      const keywords = [getMainKeywordFromEditor(subjectEl)].filter(Boolean);
      const links = [...subjectEl.querySelectorAll(".content-item[data-link]")].map(item => {
        const dateMatch = (item.querySelector("small")?.textContent || "").match(/(\\d{2}\\/\\d{2}\\/\\d{4})/);
        return { title: item.querySelector("a")?.textContent.trim() || "", url: item.dataset.link || "", source: item.querySelector("strong")?.textContent.trim() || "", type: item.dataset.type || "article", date: dateMatch ? dateMatch[1] : "", checked: item.querySelector('input[type="checkbox"]')?.checked ?? true };
      }).filter(l => l.url);
      const sendRes = await fetchWithTimeout(SEND_TO_AGON_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: subjectTitle, sessionLabel, question: finalQuestion, positionA: finalPosA, positionB: finalPosB, theme, resume: resumeForSend, sources: agonBtnFinal.dataset.sources, links, storySelection, keywords, politicalOrientation: agonBtnFinal.dataset.politicalOrientation ? JSON.parse(agonBtnFinal.dataset.politicalOrientation) : null, arenaMode, politicalGroup }) });
      if (sendRes.status === 409) {
        const sendErrData = await sendRes.json().catch(() => ({}));
        if (sendErrData.similarDebate) {
          // Un débat existant très proche a été détecté (formulation différente de la
          // même actualité) : on n'envoie pas, mais on ne le marque pas non plus comme
          // "déjà envoyé" — l'humain doit choisir Republier (force) ou aller fusionner
          // manuellement depuis l'admin Agôn.
          alert("Débat très proche déjà publié sur Agôn : " + (sendErrData.error || "vérifie l'admin Agôn avant d'envoyer."));
          const republishBtnSim = subjectEl.querySelector(".republish-btn");
          if (republishBtnSim) { republishBtnSim.classList.remove("hidden"); republishBtnSim.disabled = false; republishBtnSim.textContent = "↺ Envoyer quand même"; }
          return { status: "skipped-similar", error: sendErrData.error || "" };
        }
        // Déjà envoyé (ex: pipeline auto passé avant ce lot) : on marque comme envoyé
        // au lieu de créer un doublon ou d'afficher une erreur.
        agonBtnFinal.classList.add("sent");
        agonBtnFinal.textContent = "✓ Déjà envoyé";
        const republishBtnDup = subjectEl.querySelector(".republish-btn");
        if (republishBtnDup) { republishBtnDup.classList.remove("hidden"); republishBtnDup.disabled = false; republishBtnDup.textContent = "↺ Republier"; }
        rehydratePersistentStates();
        return { status: "skipped-sent" };
      }
      if (!sendRes.ok) throw new Error("Erreur envoi Agôn");
      agonBtnFinal.classList.add("sent");
      agonBtnFinal.textContent = "✓ Envoyé";
      const republishBtn = subjectEl.querySelector(".republish-btn");
      if (republishBtn) { republishBtn.classList.remove("hidden"); republishBtn.disabled = false; republishBtn.textContent = "↺ Republier"; }
      rehydratePersistentStates();
      return { status: "sent" };
    }

    // Publication directe pour Certamen ("Tout générer" sur /certamen) : aucun appel IA,
    // aucun résumé/article — uniquement les champs déjà calculés à la collecte
    // (subject.certamen.* : question, positions, thème). Cf. POST /certamen/publish-selected
    // dans server.js et certamen-agon-publish.js::publishSelectedCertamenSubjectsToAgon.
    async function publishSelectedCertamenSubjects(subjects, generateBtn) {
      const titles = subjects.map(s => s.querySelector("h3")?.textContent.trim()).filter(Boolean);
      console.log("[Tout générer] " + titles.length + " sujet(s) — pipeline Certamen (publication directe)");
      subjects.forEach(s => { s.classList.remove("batch-skipped", "batch-error"); s.querySelector(".batch-outcome")?.remove(); });
      generateBtn.disabled = true;
      generateBtn.textContent = "Publication en cours…";
      try {
        const res = await fetchWithTimeout("/certamen/publish-selected", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subjects: titles }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || "Erreur publication Certamen");
        const results = Array.isArray(data.results) ? data.results : [];
        const byTitle = new Map(results.map(r => [r.subject, r]));
        const outcomes = subjects.map((el, i) => {
          const title = titles[i] || ("sujet " + (i + 1));
          const r = byTitle.get(title);
          if (!r) return { el, title, status: "error", error: "résultat manquant" };
          if (r.ok && r.skipped) return { el, title, status: "skipped-sent" };
          if (r.ok) return { el, title, status: "sent" };
          return { el, title, status: "error", error: r.error };
        });
        outcomes.filter(o => o.status === "sent").forEach(o => {
          const agonBtn = o.el.querySelector(".agon-btn");
          if (agonBtn) { agonBtn.classList.add("sent"); agonBtn.textContent = "✓ Envoyé"; }
        });
        const sentCount = outcomes.filter(o => o.status === "sent").length;
        const issues = outcomes.filter(o => o.status !== "sent");
        issues.forEach(o => {
          const isError = o.status === "error";
          o.el.classList.add(isError ? "batch-error" : "batch-skipped");
          const note = document.createElement("div");
          note.className = "batch-outcome";
          note.textContent = isError ? "⚠ Non envoyé — " + (o.error || "erreur inconnue") : "⏭ Non renvoyé : déjà envoyé";
          o.el.prepend(note);
        });
        rehydratePersistentStates();
        generateBtn.textContent = issues.length ? (sentCount + "/" + outcomes.length + " envoyés — " + issues.length + " non envoyé(s)") : "Tout générer";
        if (issues.length) {
          alert("Tout générer : " + sentCount + "/" + outcomes.length + " envoyé(s) vers Agôn.\\n\\nNon envoyé(s) :\\n"
            + issues.map(o => "• " + o.title + (o.status === "skipped-sent" ? " (déjà envoyé)" : " (" + (o.error || "erreur") + ")")).join("\\n"));
        }
      } catch (err) {
        console.error("[Tout générer] Erreur publication Certamen :", err.message);
        alert("Erreur publication Certamen : " + err.message);
        generateBtn.textContent = "Tout générer";
      } finally {
        generateBtn.disabled = false;
      }
    }

    document.addEventListener("click", async (e) => {
      if (!e.target.closest(".generate-all-btn")) return;
      const generateBtn = e.target.closest(".generate-all-btn");
      let subjects = [...document.querySelectorAll(".subject.selected")];
      if (subjects.length === 0) {
        const activeSession = getActiveSession();
        if (activeSession) subjects = [...activeSession.querySelectorAll(".subject")].filter(s => s.style.display !== "none");
      }
      if (subjects.length === 0) return;
      if (CERTAMEN_MODE) {
        await publishSelectedCertamenSubjects(subjects, generateBtn);
        return;
      }
      console.log("[Tout générer] " + subjects.length + " sujet(s) sélectionné(s)");
      subjects.forEach(s => { s.classList.remove("batch-skipped", "batch-error"); s.querySelector(".batch-outcome")?.remove(); });
      generateBtn.disabled = true;
      const outcomes = [];
      for (let i = 0; i < subjects.length; i++) {
        const subjectTitle = subjects[i].querySelector("h3")?.textContent.trim() || ("sujet " + (i + 1));
        try {
          const out = await generateSubjectPipeline(subjects[i], status => {
            generateBtn.textContent = \`\${i + 1} / \${subjects.length} — \${status}\`;
          });
          outcomes.push({ el: subjects[i], title: subjectTitle, status: (out && out.status) || "sent", error: out && out.error });
        } catch (err) {
          console.error("Erreur pipeline sujet " + (i + 1) + " :", err.message);
          outcomes.push({ el: subjects[i], title: subjectTitle, status: "error", error: err.message });
        }
      }
      const sentCount = outcomes.filter(o => o.status === "sent").length;
      const issues = outcomes.filter(o => o.status !== "sent");
      issues.forEach(o => {
        const isError = o.status === "error";
        o.el.classList.add(isError ? "batch-error" : "batch-skipped");
        const note = document.createElement("div");
        note.className = "batch-outcome";
        note.textContent = isError
          ? "⚠ Non envoyé — erreur : " + (o.error || "inconnue")
          : (o.status === "skipped-sent"
            ? "⏭ Non renvoyé : déjà marqué « Envoyé » (utilise ↺ Republier pour forcer)"
            : "⚠ Non envoyé : article manquant" + (o.error ? " — erreur : " + o.error : ""));
        o.el.prepend(note);
      });
      console.log("[Tout générer] Bilan : " + sentCount + "/" + outcomes.length + " envoyé(s) vers Agôn"
        + (issues.length ? " — non envoyés : " + issues.map(o => o.title).join(" | ") : ""));
      generateBtn.disabled = false;
      if (issues.length) {
        generateBtn.textContent = sentCount + "/" + outcomes.length + " envoyés — " + issues.length + " non envoyé(s)";
        alert("Tout générer : " + sentCount + "/" + outcomes.length + " envoyé(s) vers Agôn.\\n\\nNon envoyé(s) :\\n"
          + issues.map(o => "• " + o.title + (o.status === "skipped-sent" ? " (déjà envoyé)" : (o.status === "skipped-no-article" ? " (article manquant" + (o.error ? " — erreur : " + o.error : "") + ")" : " (erreur : " + (o.error || "?") + ")"))).join("\\n"));
      } else {
        generateBtn.textContent = "Tout générer";
      }
    });

    document.addEventListener("click", async (e) => {
      if (!e.target.closest(".verify-sources-btn")) return;
      const btn = e.target.closest(".verify-sources-btn");
      const subjectEl = btn.closest(".subject");
      if (!subjectEl) return;

      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = "Vérification…";

      try {
        let subjectData;
        const rawData = btn.dataset.subject;
        if (rawData) {
          subjectData = JSON.parse(rawData);
        } else {
          const payload = decodeStoryData(subjectEl.dataset.subjectPayload || "") || {};
          const analyzeBtn = subjectEl.querySelector(".analyze-btn[data-mode='positions']");
          subjectData = analyzeBtn
            ? JSON.parse(analyzeBtn.dataset.subject)
            : { subject: payload.subject || "", contents: payload.contents || [], sources: payload.sources || [] };
        }

        const res = await fetch("/verify-sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subjectData)
        });
        if (!res.ok) throw new Error("Erreur serveur");
        const data = await res.json();

        const preselectedLinks = new Set(
          Array.isArray(data.selectedLinks)
            ? data.selectedLinks.map(l => String(l || "").trim()).filter(Boolean)
            : []
        );
        subjectEl.querySelectorAll(".content-item[data-link]").forEach(item => {
          const cb = item.querySelector('input[type="checkbox"]');
          // Liste vide = aucune info d'exclusion exploitable : tout reste coché
          const sel = preselectedLinks.size === 0 || preselectedLinks.has(item.dataset.link);
          if (cb) cb.checked = sel;
          item.classList.toggle("preselected", sel);
        });

        btn.textContent = "✓ Sources vérifiées";
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
      } catch (err) {
        console.error("Erreur vérification sources :", err.message);
        btn.textContent = "Erreur";
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
      }
    });

    document.querySelectorAll(".filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentSort = btn.dataset.sort;
        sortSubjects();
      });
    });

    const checkTop10Btn = document.getElementById("check-top10-btn");
    if (checkTop10Btn) {
      checkTop10Btn.addEventListener("click", async () => {
        const activeSession = getActiveSession();
        if (!activeSession) return;
        const subjects = [...activeSession.querySelectorAll(":scope > .subject")]
          .filter(s => s.style.display !== "none")
          .slice(0, 10);
        checkTop10Btn.disabled = true;
        checkTop10Btn.textContent = "En cours…";
        for (const subjectEl of subjects) {
          const score = Number(subjectEl.dataset.score) || 0;
          const mode = score >= 8 ? "positions" : "libre";
          subjectEl.dataset.arenaMode = mode;
          subjectEl.dataset.politicalGroup = (currentSort === "left" || currentSort === "right") ? currentSort : "mixed";
          subjectEl.querySelectorAll(".arena-mode-btn").forEach(b => {
            b.classList.toggle("active", b.dataset.mode === mode);
          });
          const modeLabel = subjectEl.querySelector(".arena-mode-label");
          if (modeLabel) modeLabel.textContent = mode === "libre" ? "Arène libre" : "Arène à positions";
          const saveBtn = subjectEl.querySelector(".save-btn");
          if (saveBtn && !saveBtn.classList.contains("saved")) {
            saveBtn.click();
            await new Promise(r => setTimeout(r, 120));
          }
        }
        checkTop10Btn.disabled = false;
        checkTop10Btn.textContent = "Cocher les 10";
      });
    }

    const sortSourcesBtn = document.querySelector(".sort-sources-btn");
    if (sortSourcesBtn) {
      sortSourcesBtn.addEventListener("click", () => {
        currentSort = "sources";
        document.querySelectorAll(".filter-btn").forEach((button) => {
          button.classList.toggle("active", button.dataset.sort === "sources");
        });
        sortSubjects();
      });
    }


    document.querySelectorAll(".subject").forEach(ensureArticleGenerationPanel);
    rehydratePersistentStates();

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

  </script>
  `;
}

function buildVeilleStylesHtml() {
  return `<style>
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

    .refresh-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .min-sources-select {
      padding: 8px 10px;
      border: 1px solid #ddd;
      border-radius: 999px;
      font: inherit;
      font-size: 0.85rem;
      background: white;
      color: #111;
      cursor: pointer;
    }

    .refresh-btn,
    .sort-sources-btn {
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

    .refresh-btn:hover:not(:disabled),
    .sort-sources-btn:hover {
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

    #progress-panel {
      display: none;
      background: #1e293b;
      border-radius: 14px;
      padding: 14px 18px;
      margin-bottom: 16px;
      color: white;
    }
    .progress-step-label {
      font-size: 0.88rem;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .progress-bar-track {
      background: rgba(255,255,255,0.15);
      border-radius: 999px;
      height: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .progress-bar-fill {
      background: #60a5fa;
      height: 100%;
      border-radius: 999px;
      transition: width 0.5s ease;
      width: 0%;
    }
    .progress-detail-text {
      font-size: 0.78rem;
      color: rgba(255,255,255,0.55);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #collect-report-panel { display: none; margin-bottom: 16px; }
    #collect-report-panel .collect-report { margin: 0; }
    .collect-report { margin: 12px 0 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #f8fafc; font-size: 0.82rem; }
    .collect-report summary { padding: 8px 14px; cursor: pointer; font-weight: 600; color: #374151; user-select: none; }
    .collect-report summary:hover { color: #111; }
    .cr-body { padding: 0 14px 12px; display: flex; gap: 24px; flex-wrap: wrap; }
    .cr-section { flex: 1; min-width: 220px; }
    .cr-section-label { font-weight: 700; font-size: 0.8rem; color: #374151; margin-bottom: 6px; padding-top: 8px; }
    .cr-summary { font-weight: 400; color: #6b7280; }
    .cr-table { width: 100%; border-collapse: collapse; }
    .cr-table td { padding: 3px 6px; vertical-align: top; font-size: 0.78rem; }
    .cr-icon { width: 18px; font-size: 0.72rem; }
    .cr-ok { color: #16a34a; }
    .cr-pause { color: #d97706; }
    .cr-err { color: #dc2626; }
    .cr-name { color: #111; font-weight: 500; white-space: nowrap; padding-right: 8px; }
    .cr-detail { color: #6b7280; }

    .opinion-section { margin: 20px 0; border: 1px solid #e5e7eb; border-radius: 8px; background: #fafafa; }
    .opinion-section summary { padding: 10px 14px; cursor: pointer; font-weight: 600; color: #374151; user-select: none; }
    .opinion-section summary:hover { color: #111; }
    .opinion-list { list-style: none; margin: 0; padding: 0 14px 14px; display: grid; gap: 10px; }
    .opinion-list .content-item { border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; background: #fff; font-size: 0.85rem; }
    .opinion-summary { margin: 6px 0 0; color: #4b5563; font-size: 0.82rem; }

    .filter-bar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }

    .filter-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 9px 16px;
      border: 1px solid #ddd;
      border-radius: 999px;
      background: white;
      color: #555;
      text-decoration: none;
      font: inherit;
      font-size: 0.88rem;
      font-weight: 700;
    }

    .filter-link:hover {
      background: #f3f4f6;
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

	    .filter-btn[data-sort="saved"] {
	      background: #fff7ed;
	      color: #9a3412;
	      border: 1.5px solid #f59e0b;
	      box-shadow: 0 2px 8px rgba(245, 158, 11, 0.18);
	      font-weight: 800;
	    }

	    .filter-btn[data-sort="saved"]::before {
	      content: "★";
	      margin-right: 7px;
	      color: #d97706;
	    }

	    .filter-btn[data-sort="saved"]:hover {
	      background: #ffedd5;
	      border-color: #d97706;
	    }

	    .filter-btn[data-sort="saved"].active {
	      background: #9a3412;
	      color: #fff;
	      border-color: #9a3412;
	      box-shadow: 0 3px 12px rgba(154, 52, 18, 0.28);
	    }

	    .filter-btn[data-sort="saved"].active::before {
	      color: #fff;
	    }

	    .filter-btn[data-sort="left"] {
	      color: #b30000;
	      border-color: #ffb3b3;
	    }

	    .filter-btn[data-sort="left"].active {
	      background: #b30000;
	      color: #fff;
	      border-color: #b30000;
	    }

	    .filter-btn[data-sort="right"] {
	      color: #003399;
	      border-color: #b3c2ff;
	    }

	    .filter-btn[data-sort="right"].active {
	      background: #003399;
	      color: #fff;
	      border-color: #003399;
	    }

    .theme-header {
      font-size: 1rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #555;
      border-top: 2px solid #ddd;
      padding: 18px 0 6px;
      margin-top: 8px;
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
      position: relative;
    }

    .subject.selected {
      border-color: #111;
      box-shadow: 0 0 0 2px rgba(17,17,17,0.08), 0 2px 8px rgba(0,0,0,0.04);
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

    .story-selected-row {
      margin-bottom: 10px;
    }

    .story-selected-tag {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 36px;
      padding: 7px 12px;
      border-radius: 999px;
      background: #eef4ff;
      border: 1px solid #b8cae8;
      color: #2157a5;
      font-size: 0.84rem;
      font-weight: 700;
    }

    .story-selected-remove-btn,
    .story-create-btn {
      border: 1px solid #d7dbe2;
      background: white;
      color: #223;
      border-radius: 999px;
      padding: 7px 12px;
      font: inherit;
      font-size: 0.82rem;
      font-weight: 700;
      cursor: pointer;
    }

    .story-selected-remove-btn {
      border: none;
      background: transparent;
      color: #2157a5;
      padding: 0;
      font-size: 1rem;
      line-height: 1;
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

    .saved-selection-bar {
      display: none;
      flex-direction: column;
      gap: 10px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 14px;
      padding: 12px 14px;
      margin: 0 0 18px;
      position: sticky;
      top: 10px;
      z-index: 5;
    }

    .saved-selection-bar.visible {
      display: flex;
    }

    .ranked-action-bar {
      display: none;
      align-items: center;
      gap: 10px;
      margin: 0 0 18px;
    }

    .ranked-action-bar.visible {
      display: flex;
    }

    .check-top10-btn {
      border: 1px solid #ddd;
      background: white;
      border-radius: 999px;
      padding: 8px 16px;
      font: inherit;
      font-size: 0.86rem;
      font-weight: 700;
      cursor: pointer;
      color: #111;
    }

    .check-top10-btn:hover {
      background: #f0f0f0;
    }

    .saved-selection-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .generate-all-btn {
      width: 100%;
      padding: 13px 20px;
      background: #111;
      color: white;
      border: none;
      border-radius: 999px;
      font: inherit;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      letter-spacing: 0.02em;
    }

    .generate-all-btn:hover:not(:disabled) {
      background: #333;
    }

    .generate-all-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* Bilan "Tout générer" : sujets sautés ou en erreur */
    .subject.batch-skipped { outline: 2px solid #e67e22; }
    .subject.batch-error { outline: 2px solid #c0392b; }
    .batch-outcome {
      background: #fff3e0;
      border: 1px solid #e67e22;
      color: #7a3e00;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 10px;
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .subject.batch-error .batch-outcome {
      background: #fdecea;
      border-color: #c0392b;
      color: #7b241c;
    }

    .saved-selection-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .select-all-arenas-btn,
    .clear-selection-btn,
    .arena-select-btn {
      border: 1px solid #ddd;
      background: white;
      border-radius: 999px;
      padding: 8px 14px;
      font: inherit;
      font-size: 0.86rem;
      font-weight: 700;
      cursor: pointer;
      color: #111;
    }

    .select-all-arenas-btn:hover,
    .clear-selection-btn:hover {
      opacity: 0.85;
    }

    .arena-select-btn:hover {
      background: #f0f0f0;
    }

    .arena-select-btn {
      display: none;
      position: absolute;
      top: 16px;
      left: 18px;
    }

    body.saved-selection-mode .subject .arena-select-btn {
      display: inline-flex;
    }

    body.saved-selection-mode .subject {
      padding-top: 62px;
    }

    .subject.selected .arena-select-btn {
      background: #111;
      border-color: #111;
      color: white;
    }

    .selection-count {
      color: #555;
      font-size: 0.9rem;
      font-weight: 700;
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

    .republish-btn {
      background: #fff;
      border: 1px solid #1d4ed8;
      border-radius: 999px;
      padding: 4px 12px;
      font: inherit;
      font-size: 0.82rem;
      cursor: pointer;
      color: #1d4ed8;
      margin-top: 10px;
      margin-left: 6px;
    }

    .republish-btn:hover { background: #eff6ff; }

    .verify-sources-btn {
      background: #fff;
      border: 1px solid #059669;
      border-radius: 999px;
      padding: 4px 12px;
      font: inherit;
      font-size: 0.82rem;
      cursor: pointer;
      color: #059669;
      margin-top: 10px;
      margin-left: 6px;
    }
    .verify-sources-btn:hover { background: #ecfdf5; }
    .verify-sources-btn:disabled { opacity: 0.5; cursor: wait; }

    .ai-box {
      background: #f5f5f5;
      border: 1px solid #e1e1e1;
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 14px;
    }

    .news-keywords {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 10px 0 4px;
    }

    .news-keywords-label {
      width: 100%;
      font-size: 0.82rem;
      font-weight: 700;
      color: #555;
    }

    .news-keyword-chip {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      padding: 0 10px;
      border-radius: 999px;
      background: #f3f4f7;
      border: 1px solid #e2e4ea;
      color: #2b2e38;
      font-size: 0.82rem;
      font-weight: 600;
      line-height: 1.2;
    }
    .main-keyword-chip {
      background: #111;
      border-color: #111;
      color: #fff;
      font-weight: 800;
      box-shadow: 0 6px 16px rgba(0,0,0,0.12);
    }
    .main-keyword-chip::before {
      content: "Tag principal";
      margin-right: 8px;
      font-size: 0.68rem;
      font-weight: 800;
      text-transform: uppercase;
      opacity: 0.72;
    }
    .news-keyword-chip button {
      margin-left: 8px;
      border: none;
      background: transparent;
      color: #666;
      cursor: pointer;
      font: inherit;
      font-size: 0.9rem;
      line-height: 1;
      padding: 0;
    }
    .main-keyword-chip button { color: #fff; opacity: 0.75; }

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

    .source-subject-title {
      margin: 0 0 8px 0;
      font-size: 1rem;
      font-weight: 800;
      line-height: 1.3;
      color: #1f2937;
    }

    .generated-title-label {
      margin: 0 0 4px 0;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: #6b7280;
    }

    .story-picker-row {
      position: relative;
      margin-top: 6px;
    }

    .story-picker-trigger {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border: 1px solid #d1d5db;
      background: #fff;
      color: #111827;
      border-radius: 12px;
      padding: 10px 12px;
      font: inherit;
      font-size: 0.88rem;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
    }

    .story-picker-trigger-label {
      min-width: 0;
      flex: 1;
    }

    .story-picker-trigger-caret {
      flex-shrink: 0;
      color: #6b7280;
      font-size: 0.8rem;
    }

    .story-dropdown.hidden {
      display: none;
    }

    .story-dropdown {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      width: min(860px, calc(100vw - 48px));
      max-width: 100%;
      background: #ffffff !important;
      background-color: #ffffff !important;
      opacity: 1 !important;
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      box-shadow: 0 20px 50px rgba(15, 23, 42, 0.16);
      z-index: 40;
      padding: 10px;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    .story-dropdown-create-row {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 8px;
    }

    .story-create-inline-btn {
      border: 1px solid #d1d5db;
      background: #fff;
      color: #111827;
      border-radius: 999px;
      padding: 6px 10px;
      font: inherit;
      font-size: 0.82rem;
      font-weight: 700;
      cursor: pointer;
    }

    .story-dropdown-search-row {
      padding: 0 4px 10px;
      background: #ffffff !important;
      opacity: 1 !important;
    }

    .story-search-input {
      width: 100%;
      padding: 9px 12px;
      border: 1px solid #d6dae2;
      border-radius: 8px;
      font: inherit;
      font-size: 0.9rem;
      background: #ffffff;
      color: #111827;
    }

    .story-dropdown-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 320px;
      overflow: auto;
      background: #ffffff !important;
      opacity: 1 !important;
    }

    .story-library-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: #ffffff !important;
      background-color: #ffffff !important;
      opacity: 1 !important;
    }

    .story-library-title {
      font-size: 0.84rem;
      font-weight: 600;
      color: #1f2937;
      min-width: 0;
      flex: 1;
    }

    .story-library-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .story-library-btn {
      border: 1px solid #d1d5db;
      background: #fff;
      color: #111827;
      border-radius: 999px;
      padding: 5px 9px;
      font: inherit;
      font-size: 0.76rem;
      font-weight: 700;
      cursor: pointer;
    }

    .story-library-select-btn {
      border: 0;
      background: transparent;
      padding: 0;
      color: inherit;
      font: inherit;
      font-weight: inherit;
      text-align: left;
      cursor: pointer;
      width: 100%;
    }

    .story-library-row.is-selected {
      border-color: #93c5fd;
      background: #eff6ff;
    }

    .story-row-simple {
      justify-content: flex-start;
    }

    .story-library-view-btn {
      background: #eff6ff;
      border-color: rgba(37, 99, 235, 0.18);
      color: #1d4ed8;
    }

    .story-articles-modal.hidden {
      display: none;
    }

    .story-articles-modal {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.52);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .story-articles-dialog {
      width: min(720px, 100%);
      max-height: min(80vh, 760px);
      overflow: auto;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.26);
      padding: 18px 18px 16px;
    }

    .story-articles-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .story-articles-title {
      font-size: 16px;
      font-weight: 700;
      color: #111827;
      margin: 0;
    }

    .story-articles-close {
      border: 0;
      background: #f3f4f6;
      color: #374151;
      border-radius: 999px;
      width: 32px;
      height: 32px;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }

    .story-articles-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 10px;
    }

    .story-article-item {
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 12px;
      padding: 12px;
      background: #f8fafc;
    }

    .story-article-title {
      margin: 0 0 6px;
      font-size: 14px;
      font-weight: 700;
      color: #111827;
    }

    .story-article-meta {
      font-size: 12px;
      color: #6b7280;
      margin-bottom: 6px;
    }

    .story-article-content {
      font-size: 13px;
      line-height: 1.45;
      color: #374151;
      margin: 0 0 8px;
    }

    .story-article-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      color: #1d4ed8;
      text-decoration: none;
    }

    .tags-generate-btn,
    .full-article-btn {
      margin-top: 14px;
      border: 1px solid rgba(37, 99, 235, 0.22);
      background: #eff6ff;
      color: #1d4ed8;
      border-radius: 10px;
      padding: 10px 12px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    .tags-generate-btn {
      margin-top: 10px;
      border-color: rgba(17, 24, 39, 0.18);
      background: #f8fafc;
      color: #111827;
    }

    .final-article-btn {
      margin-top: 10px;
      border: 1px solid rgba(17, 24, 39, 0.2);
      background: #111827;
      color: white;
      border-radius: 999px;
      padding: 8px 14px;
      font: inherit;
      font-size: 0.84rem;
      font-weight: 700;
      cursor: pointer;
    }

    .problematique-btn {
      margin-top: 10px;
      border: 1px solid rgba(109, 40, 217, 0.25);
      background: #f5f3ff;
      color: #5b21b6;
      border-radius: 999px;
      padding: 8px 14px;
      font: inherit;
      font-size: 0.84rem;
      font-weight: 700;
      cursor: pointer;
    }

    .definitive-article-btn {
      margin-top: 10px;
      margin-left: 8px;
      border: 1px solid rgba(17, 24, 39, 0.16);
      background: #ffffff;
      color: #111827;
      border-radius: 999px;
      padding: 8px 14px;
      font: inherit;
      font-size: 0.84rem;
      font-weight: 700;
      cursor: pointer;
    }

    .latin-article-btn {
      border-color: #111827;
      background: #111827;
      color: #ffffff;
      box-shadow: 0 8px 20px rgba(17, 24, 39, 0.16);
    }

    .article-generation-panel {
      margin-top: 14px;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      background: #ffffff;
      overflow: hidden;
    }

    .article-generation-panel summary {
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 11px 14px;
      color: #111827;
      font-size: 0.88rem;
      font-weight: 800;
      cursor: pointer;
      user-select: none;
    }

    .article-generation-panel summary::-webkit-details-marker {
      display: none;
    }

    .article-generation-panel summary::after {
      content: "▾";
      font-size: 0.8rem;
      transition: transform 0.16s ease;
    }

    .article-generation-panel:not([open]) summary::after {
      transform: rotate(-90deg);
    }

    .article-generation-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 0 14px 14px;
    }

    .article-generation-actions .tags-generate-btn,
    .article-generation-actions .full-article-btn,
    .article-generation-actions .final-article-btn,
    .article-generation-actions .problematique-btn,
    .article-generation-actions .definitive-article-btn {
      margin-top: 0;
      margin-left: 0;
    }

    .resume[contenteditable="true"] {
      border-radius: 8px;
      padding: 8px 10px;
      margin-left: -10px;
      outline: none;
      transition: background 0.15s;
    }

    .resume[contenteditable="true"]:hover,
    .resume[contenteditable="true"]:focus {
      background: #e8e8e8;
    }

    .article-reflection-line {
      font-style: italic;
    }

    .article-latin-question {
      text-align: center;
      font-weight: 700;
      margin-top: 1em;
    }

    .article-debate-question {
      text-align: center;
      font-style: italic;
      margin-top: 1em;
    }

    .article-signature {
      text-align: left;
      font-weight: 400;
    }

    .field-counter {
      margin-top: 4px;
      font-size: 0.78rem;
      color: #6b7280;
      text-align: right;
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

    .positions-box p + p {
      margin-top: 0;
    }

    .political-tag {
      display: inline-block;
      margin-top: 8px;
      font-size: 0.72rem;
      color: #7a5c9e;
      background: #f0eaf8;
      border: 1px solid #d0bfea;
      border-radius: 10px;
      padding: 2px 9px;
    }

    .arena-mode-tag {
      display: inline-block;
      margin: 0 0 8px 0;
      font-size: 0.72rem;
      font-weight: 600;
      color: #475569;
      background: #eef2f7;
      border: 1px solid #d7dee8;
      border-radius: 10px;
      padding: 2px 9px;
    }

    .arena-mode-picker {
      display: flex;
      gap: 6px;
      margin: 0 0 8px 0;
    }

    .arena-mode-btn {
      background: white;
      color: #475569;
      border: 1px solid #d7dee8;
      border-radius: 999px;
      padding: 4px 12px;
      font: inherit;
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
    }

    .arena-mode-btn:hover {
      background: #f3f6fa;
    }

    .arena-mode-btn.active {
      background: #111;
      color: white;
      border-color: #111;
    }

    .merge-notice {
      background: #fff7ed;
      border: 1px solid #fdba74;
      border-radius: 10px;
      padding: 10px 14px;
      margin: 6px 0 12px;
      font-size: 0.85rem;
      color: #7c2d12;
    }
    .merge-notice strong { display: block; margin-bottom: 4px; }
    .merge-notice ul { margin: 0; padding-left: 20px; }
    .merge-notice .merge-reason { margin: 6px 0 0; font-style: italic; opacity: 0.85; }

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

	    .sources-dropdown {
	      margin: 10px 0 12px;
	    }

	    .sources-dropdown summary {
	      display: inline-flex;
	      align-items: center;
	      gap: 8px;
	      width: fit-content;
	      border: 1px solid #ddd;
	      background: white;
	      border-radius: 999px;
	      padding: 7px 13px;
	      color: #111;
	      font: inherit;
	      font-size: 0.86rem;
	      font-weight: 700;
	      cursor: pointer;
	      user-select: none;
	    }

	    .sources-dropdown summary::-webkit-details-marker {
	      display: none;
	    }

	    .sources-dropdown summary::after {
	      content: "▾";
	      font-size: 0.78rem;
	      color: #777;
	      transition: transform 0.16s ease;
	    }

	    .sources-dropdown[open] summary::after {
	      transform: rotate(180deg);
	    }

	    .sources-dropdown summary:hover {
	      background: #f0f0f0;
	    }

	    .sources-dropdown .sources {
	      margin: 10px 0 8px;
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
  </style>`;
}

  function encodeStoryDataServer(value) {
    return encodeURIComponent(JSON.stringify(value || {}));
  }


  function buildKeywordsStaticHtml(ai) {
    // Pas de repli sur ai.keywords (mots-clés regex) : seul un vrai
    // mainKeyword s'affiche comme tag principal ; sinon, pas de chip.
    const mainKeyword = String(ai?.mainKeyword || "").trim();
    return '<div class="news-keywords">' +
      '<div class="news-keywords-label">Tag principal</div>' +
      (mainKeyword ? '<span class="news-keyword-chip main-keyword-chip" data-main-keyword="' + escapeHtml(mainKeyword) + '">' + escapeHtml(mainKeyword) + '<button type="button" class="news-keyword-remove-btn" aria-label="Supprimer le tag principal">×</button></span>' : '') +
    '</div>';
  }

  function buildStoryLinkStaticHtml(storyLink) {
    if (storyLink === undefined) storyLink = null;
    storyLink = storyLink || {};
    const storyDecision = storyLink.story_decision || "new_story";
    const confidence = Number(storyLink.confidence || 0);
    const matchedTitle = escapeHtml(storyLink.matched_story_title || "");
    const previousEpisodeTitle = escapeHtml(storyLink.previous_episode_title || "");
    const previousEpisodeUrl = escapeHtml(storyLink.previous_episode_url || "");
    const reason = escapeHtml(storyLink.reason || "");
    const newStory = storyLink.new_story || {};
    const encodedCriteria = escapeHtml(encodeStoryDataServer(storyLink.criteria || {}));
    const encodedNewStory = escapeHtml(encodeStoryDataServer(newStory));
    const hasMatchedStory = Boolean(storyLink.matched_story_id && matchedTitle);
    const selectedMode = hasMatchedStory ? "existing" : "";
    const currentStoryId = escapeHtml(storyLink.matched_story_id || "");
    const currentStoryTitle = matchedTitle;
    const statusReason = reason ? '<div class="story-link-header">' + reason + '</div>' : '';
    return '<div class="story-link-box" data-story-decision="' + escapeHtml(storyDecision) + '" data-selected-mode="' + selectedMode + '" data-default-mode="' + selectedMode + '" data-matched-story-id="' + currentStoryId + '" data-matched-story-title="' + matchedTitle + '" data-current-story-id="' + currentStoryId + '" data-current-story-title="' + currentStoryTitle + '" data-current-story-summary="" data-previous-episode-title="' + previousEpisodeTitle + '" data-previous-episode-url="' + previousEpisodeUrl + '" data-confidence="' + confidence + '" data-reason="' + reason + '" data-criteria="' + encodedCriteria + '" data-new-story="' + encodedNewStory + '">' +
      statusReason +
      '<div class="story-manual-picker"><label>Histoire associée</label><div class="story-picker-row"><select class="story-manual-select" hidden><option value="">Sans histoire associée</option><option value="__new__">Créer une nouvelle histoire</option></select><button type="button" class="story-picker-trigger" aria-expanded="false"><span class="story-picker-trigger-label">' + (hasMatchedStory ? matchedTitle : 'Sans histoire associée') + '</span><span class="story-picker-trigger-caret">▾</span></button><div class="story-dropdown hidden"><div class="story-dropdown-create-row"><button type="button" class="story-create-inline-btn">+ Créer une nouvelle histoire</button></div><div class="story-dropdown-search-row"><input type="text" class="story-search-input" placeholder="Rechercher une histoire"></div><div class="story-dropdown-list"></div></div></div><small class="story-manual-meta">' + (hasMatchedStory && previousEpisodeTitle ? 'Dernier épisode : ' + previousEpisodeTitle : '') + '</small></div>' +
      '<div class="story-existing-fields"><div class="story-draft-fields story-existing-fields-empty"><p class="story-existing-note">Cette histoire sera seulement associée à l\'actualité. Aucun résumé d\'histoire n\'est généré à cette étape.</p></div></div>' +
      '<div class="story-draft-fields story-new-fields hidden"><label>Titre de la nouvelle histoire</label><input type="text" class="story-title-input" value="" placeholder="Titre court et général de l\'histoire"><div class="story-save-actions"><button type="button" class="story-save-btn">Enregistrer les modifications</button><span class="story-save-feedback hidden">Modifications enregistrées</span></div></div>' +
    '</div>';
  }


function buildSubjectCardHtml(subject, ctx) {
  const savedTitles = (ctx && ctx.savedTitles) || new Set();
  const sentKeys = (ctx && ctx.sentKeys) || new Set();
  const mergeGroupByKeepId = (ctx && ctx.mergeGroupByKeepId) || new Map();

      const articles = subject.contents.filter(content => content.type === "article");
      const videos = subject.contents.filter(content => content.type === "youtube");
      const ai = subject.ai || {};
      const isAnalyzed = subject.aiAnalyzed === true;
      const scoreAnalyzed = subject.scoreAnalyzed === true;
      const arenaModeValue = ai.arenaMode === "libre" ? "libre" : "positions";
      const arenaModeLabel = arenaModeValue === "libre" ? "Arène libre" : "Arène à positions";

      const debateScore = scoreAnalyzed ? (Number(subject.debateScore) || 0) : 0;
      const isSaved = savedTitles.has(subject.subject);
      const sentKey = String(ai ? (ai.debateQuestion || subject.subject) : subject.subject).trim() || String(subject.subject || "").trim();
      const isSent = sentKeys.has(sentKey) || sentKeys.has(String(subject.subject || "").trim());

      const mergedTitles = Array.isArray(subject.mergedSubjectTitles) ? subject.mergedSubjectTitles.filter(Boolean) : [];
      const mergeGroupInfo = mergeGroupByKeepId.get(String(subject.subjectId || ""));
      const mergeNoticeHtml = mergedTitles.length > 1
        ? `<div class="merge-notice">
            <strong>Sujets fusionnés ici par l'IA :</strong>
            <ul>${mergedTitles.map((title) => `<li>${escapeHtml(title)}</li>`).join("")}</ul>
            ${mergeGroupInfo?.reason ? `<p class="merge-reason">${escapeHtml(mergeGroupInfo.reason)}</p>` : ""}
          </div>`
        : "";

      // Toutes les sources sont cochées par défaut. Si une sélection IA existe
      // (analyse complète ou scoring batch), elle ne sert qu'à décocher les
      // contenus jugés hors sujet ; sans sélection, tout reste coché.
      const preselectedSet = new Set([
        ...(Array.isArray(ai.selectedLinks) ? ai.selectedLinks : []),
        ...(Array.isArray(subject.selectedLinks) ? subject.selectedLinks : [])
      ].map(l => String(l || "").trim()).filter(Boolean));
      const isContentChecked = link => preselectedSet.size === 0 || preselectedSet.has(link);

      const articleItems = articles.map(article => {
        const date = dayjs(article.date).format("DD/MM/YYYY HH:mm");
        const orientationGroup = getOrientationGroup(article.orientation);
        const orientationTag = article.orientation
          ? `<span class="source-tag ${orientationGroup}">${escapeHtml(article.orientation)}</span>`
          : "";

        return `
          <li class="content-item${isContentChecked(article.link) ? " preselected" : ""}" data-link="${escapeHtml(article.link)}" data-orientation="${escapeHtml(article.orientation)}" data-type="article">
            <label class="article-label">
              <input type="checkbox"${isContentChecked(article.link) ? " checked" : ""}>
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
        const videoOrientationGroup = getOrientationGroup(video.orientation);
        const videoOrientationTag = video.orientation
          ? `<span class="source-tag ${videoOrientationGroup}">${escapeHtml(video.orientation)}</span>`
          : "";

        return `
          <li class="content-item video-item${isContentChecked(video.link) ? " preselected" : ""}" data-link="${escapeHtml(video.link)}" data-orientation="${escapeHtml(video.orientation)}" data-type="youtube">
            <label class="article-label">
              <input type="checkbox"${isContentChecked(video.link) ? " checked" : ""}>
              <div>
                ${
                  video.thumbnail
                    ? `<a href="${escapeHtml(video.link)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(video.thumbnail)}" alt="" class="thumb"></a>`
                    : ""
                }
                <strong>${escapeHtml(video.source)}</strong>
                <span class="source-tag youtube">YouTube</span>
                ${videoOrientationTag}
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
        contents: subject.contents.map(c => ({
          type: c.type,
          source: c.source,
          orientation: c.orientation,
          title: c.title,
          summary: c.summary || "",
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
            <input type="hidden" class="full-article-state" value="${escapeHtml(ai.fullArticleState || "short")}">
            <p class="generated-title-label">Titre généré par IA</p>
            <p class="debate-question" contenteditable="true" spellcheck="false">${escapeHtml(ai.debateQuestion || "")}</p>
            <div class="field-counter question-counter">0 / 110</div>
            ${
              debateScore >= 7 && (ai.positionA || ai.positionB) && ai.arenaMode !== "libre"
                ? `<div class="positions-box">
                    <p><strong>Positions proposées pour une arène à positions :</strong></p>
                    ${ai.positionA ? `<p><strong>A —</strong> <span class="editable" contenteditable="true" spellcheck="false">${escapeHtml(ai.positionA)}</span></p>` : ""}
                    ${ai.positionB ? `<p><strong>B —</strong> <span class="editable" contenteditable="true" spellcheck="false">${escapeHtml(ai.positionB)}</span></p>` : ""}
                  </div>`
                : ""
            }
            <p class="resume" contenteditable="true" spellcheck="false">${escapeHtml(ai.resume || "")}</p>
            <div class="field-counter resume-counter">0 / 1500</div>
            <div class="story-save-actions"><button type="button" class="story-save-btn context-save-btn">Enregistrer les modifications</button><span class="story-save-feedback context-save-feedback hidden">Modifications enregistrées</span></div>
            ${buildKeywordsStaticHtml(ai)}
            <p class="agon-theme"><strong>Thématique Agôn proposée :</strong>
              <select class="agon-select">
                ${AGON_THEMES.map(theme => `<option value="${escapeHtml(theme)}"${theme === normalizeAgonTheme(ai.agonTheme) ? " selected" : ""}>${escapeHtml(theme)}</option>`).join("")}
              </select>
            </p>
            ${buildStoryLinkStaticHtml(ai.storyLink || null)}
            <button type="button" class="tags-generate-btn">Générer tags</button>
            <button type="button" class="full-article-btn">${["summary", "media", "problematique", "full"].includes(String(ai.fullArticleState || "")) ? "✓ Résumé généré" : "Générer résumé de l'article"}</button>
            <button type="button" class="final-article-btn${ai.arenaMode !== "libre" && ["summary", "media", "problematique", "full"].includes(String(ai.fullArticleState || "")) ? "" : " hidden"}">${["media", "problematique", "full"].includes(String(ai.fullArticleState || "")) ? "✓ Médias analysés" : "Analyser les médias"}</button>
            <button type="button" class="problematique-btn hidden">Générer problématique</button>
            <button type="button" class="definitive-article-btn${ai.arenaMode !== "libre" && ["problematique", "full"].includes(String(ai.fullArticleState || "")) ? "" : " hidden"}"${String(ai.fullArticleState || "") === "full" ? "" : " disabled"}>Article définitif</button>
            <button type="button" class="definitive-article-btn latin-article-btn"${ai.arenaMode !== "libre" && ["problematique", "full"].includes(String(ai.fullArticleState || "")) ? "" : " disabled"}>Générer article + question latine</button>
          </div>`
        : `<div class="ai-box pending-analysis">
            <details class="article-generation-panel">
              <summary>Génération article</summary>
              <div class="article-generation-actions">
                <button class="analyze-btn" type="button" data-mode="positions" data-subject="${subjectDataForBtn}">
                  Générer arène à positions IA
                </button>
                <button class="analyze-btn analyze-btn-secondary" type="button" data-mode="libre" data-subject="${subjectDataForBtn}">
                  Générer arène libre IA
                </button>
              </div>
            </details>
          </div>`;

      return `
        <section class="subject" data-score="${debateScore}" data-sources="${subject.sourceCount}" data-theme="${escapeHtml(isAnalyzed ? normalizeAgonTheme(ai.agonTheme) : "Non analysé")}" data-arena-mode="${arenaModeValue}">
          <div class="subject-number"></div>
          ${aiScoreHtml}

          <h3>${escapeHtml(subject.subject)}</h3>
          ${isAnalyzed
            ? `<p class="arena-mode-tag">Mode sélectionné : <span class="arena-mode-label">${arenaModeLabel}</span></p>`
            : `<div class="arena-mode-picker" role="group" aria-label="Choisir le mode d'arène">
                <button type="button" class="arena-mode-btn${arenaModeValue === "positions" ? " active" : ""}" data-mode="positions">Arène à positions</button>
                <button type="button" class="arena-mode-btn${arenaModeValue === "libre" ? " active" : ""}" data-mode="libre">Arène libre</button>
                <span class="arena-mode-label hidden">${arenaModeLabel}</span>
              </div>`
          }

          ${mergeNoticeHtml}

          ${aiBoxHtml}

          <div class="subject-stats">
            <span><span class="stat-sources-count">${subject.sourceCount}</span> sources</span>
            <span><span class="stat-articles-count">${subject.articleCount}</span> article(s)</span>
            <span><span class="stat-videos-count">${subject.youtubeCount}</span> vidéo(s)</span>
          </div>

	          <details class="sources-dropdown">
	            <summary>Voir les sources (<span class="stat-sources-dropdown-count">${subject.sourceCount}</span>)</summary>
	            <p class="sources">${escapeHtml(subject.sources.join(", "))}</p>
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
	          </details>

	          <button class="arena-select-btn" type="button" aria-pressed="false">Sélectionner</button>
	          <button class="save-btn${isSaved ? " saved" : ""}" type="button" data-subject-title="${escapeHtml(subject.subject)}">${isSaved ? "★ Enregistré" : "☆ Enregistrer"}</button>
	          <button class="agon-btn${isSent ? " sent" : ""}" type="button" data-subject-title="${escapeHtml(subject.subject)}" data-question="${escapeHtml(ai ? (ai.debateQuestion || subject.subject) : subject.subject)}" data-position-a="${escapeHtml(ai ? (ai.positionA || "") : "")}" data-position-b="${escapeHtml(ai ? (ai.positionB || "") : "")}" data-theme="${escapeHtml(ai ? normalizeAgonTheme(ai.agonTheme) : "")}" data-sources="${escapeHtml(subject.sources.join(", "))}">${isSent ? "✓ Envoyé" : "→ Agôn"}</button>
	          <button class="republish-btn${isSent ? "" : " hidden"}" type="button" data-subject-title="${escapeHtml(subject.subject)}" data-question="${escapeHtml(ai ? (ai.debateQuestion || subject.subject) : subject.subject)}" data-position-a="${escapeHtml(ai ? (ai.positionA || "") : "")}" data-position-b="${escapeHtml(ai ? (ai.positionB || "") : "")}" data-theme="${escapeHtml(ai ? normalizeAgonTheme(ai.agonTheme) : "")}" data-sources="${escapeHtml(subject.sources.join(", "))}">↺ Republier</button>
	          <button class="verify-sources-btn" type="button" data-subject="${subjectDataForBtn}">Vérifier sources</button>
	        </section>
	      `;
}

// Carte simplifiée pour un article de presse d'opinion à source unique (cf.
// extractOpinionItems) : pas de checkbox/sélection ni de bouton Agôn, ces articles ne
// passent pas par le pipeline de débat (une seule source = rien à confronter).
function buildOpinionItemCardHtml(item) {
  const date = dayjs(item.date).format("DD/MM/YYYY HH:mm");
  const orientationGroup = getOrientationGroup(item.orientation);
  const orientationTag = item.orientation
    ? `<span class="source-tag ${orientationGroup}">${escapeHtml(item.orientation)}</span>`
    : "";
  const summary = String(item.summary || "").trim();

  return `
    <li class="content-item opinion-item" data-orientation="${escapeHtml(item.orientation)}">
      <strong>${escapeHtml(item.source)}</strong> ${orientationTag}
      <br>
      <a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
      <br>
      <small>Publié le ${escapeHtml(date)}</small>
      ${summary ? `<p class="opinion-summary">${escapeHtml(summary.slice(0, 220))}${summary.length > 220 ? "…" : ""}</p>` : ""}
    </li>
  `;
}

function buildOpinionSectionHtml(opinionItems) {
  if (!Array.isArray(opinionItems) || !opinionItems.length) return "";
  return `
    <details class="opinion-section">
      <summary>Presse d'opinion (${opinionItems.length} article${opinionItems.length > 1 ? "s" : ""} à source unique, hors sujets ci-dessus)</summary>
      <ul class="opinion-list">${opinionItems.map(buildOpinionItemCardHtml).join("")}</ul>
    </details>
  `;
}

function generateHtml(sessions) {
  const generatedAt = dayjs().format("DD/MM/YYYY HH:mm:ss");

  const savedTitles = new Set(loadSavedSubjects().map(s => s.subject));
  const sentKeys = new Set(loadSentToAgonItems().map((item) => String(item?.question || item?.subject || "").trim()).filter(Boolean));

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

  function buildCollectReportHtml(collectReport) {
    if (!collectReport) return "";
    const sections = [
      { label: "Presse", sources: (collectReport.articles || {}).sources || [] },
      { label: "YouTube", sources: (collectReport.youtube || {}).sources || [] }
    ].filter(s => s.sources.length > 0);
    if (!sections.length) return "";

    const renderRow = (s) => {
      const isOk = s.statut === "ok";
      const isPause = s.statut === "pause";
      const icon = isOk ? "✓" : isPause ? "⏸" : "✗";
      const cls = isOk ? "cr-ok" : isPause ? "cr-pause" : "cr-err";
      const detail = isOk ? `${s.kept} retenu(s), ${s.skipped} ignoré(s)${s.message ? ` — ${s.message}` : ""}` : (s.message ? `${s.statut} — ${s.message}` : s.statut);
      return `<tr class="${cls}"><td class="cr-icon">${icon}</td><td class="cr-name">${escapeHtml(s.nom)}</td><td class="cr-detail">${escapeHtml(detail)}</td></tr>`;
    };

    const body = sections.map(sec => {
      const totalKept = sec.sources.reduce((acc, s) => acc + (s.kept || 0), 0);
      const errors = sec.sources.filter(s => s.statut.startsWith("erreur") || s.statut === "pause").length;
      const errNote = errors ? ` · <span class="cr-err">${errors} en erreur/pause</span>` : "";
      return `<div class="cr-section">
        <div class="cr-section-label">${escapeHtml(sec.label)} <span class="cr-summary">— ${totalKept} collecté(s)${errNote}</span></div>
        <table class="cr-table"><tbody>${sec.sources.map(renderRow).join("")}</tbody></table>
      </div>`;
    }).join("");

    return `<details class="collect-report"><summary>Rapport de collecte</summary><div class="cr-body">${body}</div></details>`;
  }

  const olderTabsButton = sessions.length > visibleTabCount
    ? `
      <button class="show-older-tabs" type="button">
        Voir les anciennes mises à jour
      </button>
    `
    : "";

  const sessionBlocks = sessions.map((session, index) => {
    const subjects = session.subjects || [];
    const mergeGroupByKeepId = new Map(
      (session.deduplication?.mergeGroups || []).map((group) => [String(group?.keepSubjectId || ""), group])
    );

    const subjectBlocks = subjects.map(subject => buildSubjectCardHtml(subject, { savedTitles, sentKeys, mergeGroupByKeepId })).join("");

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
        ${buildCollectReportHtml(session.collectReport)}

        ${
          subjects.length
            ? subjectBlocks
            : `<div class="empty">Aucun sujet commun détecté pendant cette session.</div>`
        }
        ${buildOpinionSectionHtml(session.opinionItems)}
      </section>
    `;
  }).join("");

  const rankedListHtml = "";

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <script>if (window.location.search.includes('token')) history.replaceState({}, '', window.location.pathname);</script>
  <title>Veille mixte presse + YouTube</title>
  ${buildVeilleStylesHtml()}
</head>
<body>
  <h1>Veille mixte presse + YouTube</h1>

  <div class="nav">
    <a href="/mixte">Veille mixte</a>
    <a href="/certamen">Certamen</a>
    <a href="/admin">⚙ Admin</a>
    <button class="nav-refresh-btn" onclick="startRefresh()">↻ Actualiser</button>
  </div>

  <p class="intro">
    Les nouveaux articles de presse et les nouvelles vidéos YouTube sont regroupés dans les mêmes sujets.
    L'IA analyse uniquement les nouveautés jamais vues auparavant et classe les sujets selon leur potentiel de controverse et de débat.
  </p>

  <div class="status">
    <div>
      Dernière génération du fichier :
      <strong>${escapeHtml(generatedAt)}</strong>
      <br>
      Presse : dernières <strong>${HOURS_BACK_ARTICLES} h</strong> —
      YouTube : dernières <strong>${HOURS_BACK_YOUTUBE} h</strong>
    </div>
    <div class="refresh-row">
      <select class="min-sources-select" id="min-sources-select" title="Sources minimum par sujet">
        <option value="2" selected>2 sources min.</option>
        <option value="3">3 sources min.</option>
        <option value="4">4 sources min.</option>
        <option value="5">5 sources min.</option>
        <option value="6">6 sources min.</option>
      </select>
      <button class="refresh-btn" type="button">Mettre à jour</button>
    </div>
    <div class="ptr-indicator" id="ptr-indicator"></div>
    <button class="update-banner" id="update-banner" onclick="window.location.reload()">Nouvelle session disponible — Charger</button>
  </div>

  ${renderAutoCollectMixteWidgetHtml()}

  <div id="progress-panel">
    <div class="progress-step-label">Étape <span id="prog-step">…</span> / 6 — <span id="prog-name">Démarrage…</span></div>
    <div class="progress-bar-track"><div class="progress-bar-fill" id="prog-bar"></div></div>
    <div class="progress-detail-text" id="prog-detail"></div>
  </div>

  <div id="collect-report-panel"></div>

  <div class="filter-bar">
    <button class="filter-btn active" data-sort="score">Sujets clivants</button>
    <button class="filter-btn" data-sort="sources">Sujets majeurs</button>
    <button class="filter-btn" data-sort="ranked">Classement mixte</button>
    <button class="filter-btn" data-sort="left">Médias de gauche</button>
    <button class="filter-btn" data-sort="right">Médias de droite</button>
    <button class="filter-btn" data-sort="saved">Sujets enregistrés</button>
    <a class="filter-link" href="/sent-to-agon">Articles envoyés vers Agôn</a>
  </div>

  <div class="saved-selection-bar" id="saved-selection-bar">
    <div class="saved-selection-top">
      <div class="selection-count"><span id="selected-count">0</span> arène(s) sélectionnée(s)</div>
      <div class="saved-selection-actions">
        <button class="select-all-arenas-btn" type="button">Tout sélectionner</button>
        <button class="clear-selection-btn" type="button">Annuler la sélection</button>
      </div>
    </div>
    <button class="generate-all-btn" type="button">Tout générer</button>
  </div>

  <div class="ranked-action-bar" id="ranked-action-bar">
    <button class="check-top10-btn" type="button" id="check-top10-btn">Cocher les 10</button>
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

  ${buildSubjectInteractionScriptHtml({ topTenSorts: ["ranked", "left", "right"] })}
  <script>
    var ptrIsRefreshing = false;
    var ptrBaseTimestamp = null;

    function showUpdateBanner() {
      var banner = document.getElementById("update-banner");
      if (banner) banner.style.display = "block";
    }

    function renderCollectReport(report) {
      var container = document.getElementById('collect-report-panel');
      if (!container || !report) return;
      var sections = [
        { label: 'Presse', sources: (report.articles || {}).sources || [] },
        { label: 'YouTube', sources: (report.youtube || {}).sources || [] }
      ].filter(function(s) { return s.sources.length > 0; });
      if (!sections.length) return;

      function row(s) {
        var isOk = s.statut === 'ok';
        var isPause = s.statut === 'pause';
        var icon = isOk ? '✓' : isPause ? '⏸' : '✗';
        var cls = isOk ? 'cr-ok' : isPause ? 'cr-pause' : 'cr-err';
        var detail = isOk ? (s.kept + ' retenu(s), ' + s.skipped + ' ignoré(s)' + (s.message ? ' — ' + s.message : '')) : (s.message ? s.statut + ' — ' + s.message : s.statut);
        return '<tr class="' + cls + '"><td class="cr-icon">' + icon + '</td><td class="cr-name">' + s.nom + '</td><td class="cr-detail">' + detail + '</td></tr>';
      }

      var body = sections.map(function(sec) {
        var totalKept = sec.sources.reduce(function(acc, s) { return acc + (s.kept || 0); }, 0);
        var errors = sec.sources.filter(function(s) { return s.statut.startsWith('erreur') || s.statut === 'pause'; }).length;
        var errNote = errors ? ' · <span class="cr-err">' + errors + ' en erreur/pause</span>' : '';
        return '<div class="cr-section"><div class="cr-section-label">' + sec.label + ' <span class="cr-summary">— ' + totalKept + ' collecté(s)' + errNote + '</span></div><table class="cr-table"><tbody>' + sec.sources.map(row).join('') + '</tbody></table></div>';
      }).join('');

      container.innerHTML = '<details class="collect-report" open><summary>Rapport de collecte</summary><div class="cr-body">' + body + '</div></details>';
      container.style.display = 'block';
    }

    function setPtrIndicator(text) {
      var el = document.getElementById("ptr-indicator");
      if (!el) return;
      if (text) { el.textContent = text; el.classList.add("visible"); }
      else { el.classList.remove("visible"); }
    }

    function renderProgress(prog) {
      var pct = prog.stepTotal > 0 ? Math.min(100, Math.round((prog.stepIndex / prog.stepTotal) * 100)) : 0;
      var bar = document.getElementById("prog-bar");
      var step = document.getElementById("prog-step");
      var name = document.getElementById("prog-name");
      var detail = document.getElementById("prog-detail");
      if (bar) bar.style.width = pct + "%";
      if (step) step.textContent = prog.stepIndex || "…";
      if (name) name.textContent = prog.step || "Démarrage…";
      if (detail) detail.textContent = prog.detail || "";
    }

    async function startRefresh() {
      if (ptrIsRefreshing) return;
      ptrIsRefreshing = true;

      var refreshBtn = document.querySelector(".refresh-btn");
      if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = "En cours…"; }

      var panel = document.getElementById("progress-panel");
      if (panel) { panel.style.display = "block"; }
      var reportPanel = document.getElementById("collect-report-panel");
      if (reportPanel) { reportPanel.style.display = "none"; reportPanel.innerHTML = ""; }
      renderProgress({ stepIndex: 0, stepTotal: 6, step: "Démarrage…", detail: "" });

      try {
        var r0 = await fetch("/sessions-mixte.json");
        var s0 = await r0.json();
        if (s0.length > 0) ptrBaseTimestamp = s0[0].generatedAt;
      } catch (e) {}

      var minSourcesVal = Number(document.getElementById("min-sources-select")?.value) || 2;

      async function finishRefresh() {
        clearInterval(progressPoll);
        clearInterval(completionPoll);
        clearTimeout(timeoutId);
        ptrIsRefreshing = false;
        setPtrIndicator(null);
        if (panel) panel.style.display = "none";
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "Mettre à jour"; }
        try {
          var rp = await fetch("/progress?t=" + Date.now());
          var prog = await rp.json();
          if (prog.collectReport) renderCollectReport(prog.collectReport);
        } catch (e) {}
        showUpdateBanner();
      }

      function failRefresh(message) {
        clearInterval(progressPoll);
        clearInterval(completionPoll);
        clearTimeout(timeoutId);
        ptrIsRefreshing = false;
        setPtrIndicator(null);
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "Mettre à jour"; }
        renderProgress({ stepIndex: 0, stepTotal: 6, step: "Erreur lancement collecte", detail: message || "" });
      }

      var completionPoll = null;
      var progressPoll = setInterval(async function() {
        try {
          var r = await fetch("/progress?t=" + Date.now());
          var prog = await r.json();
          renderProgress(prog);
          if (prog.done) finishRefresh();
        } catch (e) {}
      }, 1500);

      var timeoutId = setTimeout(finishRefresh, 15 * 60 * 1000);

      try {
        var launchRes = await fetch("/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minSources: minSourcesVal }) });
        var launchData = await launchRes.json().catch(function() { return {}; });
        if (!launchRes.ok || launchData.error) throw new Error(launchData.error || "Réponse serveur invalide");
      } catch (e) {
        failRefresh(e && e.message ? e.message : "Impossible de démarrer la collecte");
      }
    }

    var refreshBtn = document.querySelector(".refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function() { startRefresh(); });
    }

    initializeStoryBoxes(document);

    (function autoSuggestMissingStories() {
      var subjectsNeedingStory = Array.from(document.querySelectorAll(".subject")).filter(function(el) {
        var resume = el.querySelector(".resume");
        var hasResume = resume && (resume.dataset.rawText || resume.textContent.trim());
        var box = el.querySelector(".story-link-box");
        var hasStory = box && (box.dataset.selectedMode === "existing" || box.dataset.storyDecision === "existing_story" || box.dataset.storyDecision === "uncertain");
        return hasResume && !hasStory;
      });
      var delay = 0;
      subjectsNeedingStory.forEach(function(el) {
        setTimeout(function() { suggestStoryForSubject(el); }, delay);
        delay += 800;
      });
    })();

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

async function runWatchSession(minSources = MIN_DISTINCT_SOURCES) {
  const startedAt = dayjs();
  const lastSessionCutoff = getLastSessionCutoff();

  console.log("");
  console.log("======================================");
  console.log(`Nouvelle session mixte : ${startedAt.format("DD/MM/YYYY HH:mm:ss")}`);
  console.log("======================================");
  resetCollectionDiagnostics();
  if (lastSessionCutoff) {
    console.log("Filtre fraîcheur actif : seulement les contenus publiés après " + lastSessionCutoff.format("DD/MM/YYYY HH:mm:ss") + ".");
  } else {
    console.log("Aucune session précédente : première collecte sur la fenêtre récente habituelle.");
  }

  const previousSources = getPreviousSessionSources();

  setProgress(1, "Collecte des articles", "Démarrage…");
  console.log("Collecte des articles...");
  const { contents: articles, report: articlesReport } = await collectArticles(lastSessionCutoff, previousSources);

  setProgress(2, "Collecte des vidéos YouTube", "Démarrage…");
  console.log("Collecte des vidéos YouTube...");
  const { contents: videos, report: videosReport } = await collectYouTubeVideos(lastSessionCutoff, previousSources);

  const contents = [...articles, ...videos];

  console.log(`${articles.length} article(s) récupéré(s) dans les flux.`);
  console.log(`${videos.length} vidéo(s) récupérée(s) dans les flux.`);
  console.log(`${contents.length} contenu(s) récent(s) au total.`);

  setProgress(3, "Regroupement des sujets", `${contents.length} contenus`);
  console.log("Regroupement des nouveaux sujets mixtes...");
  const groups = groupContentsBySubject(contents);

  console.log(`${groups.length} groupe(s) détecté(s).`);

  const rawSubjects = filterMultiSourceSubjects(groups, minSources);

  console.log(`${rawSubjects.length} sujet(s) repris par plusieurs sources.`);

  const opinionItems = extractOpinionItems(groups, loadPublishedSubjectKeys());

  console.log(`${opinionItems.length} article(s) retenus pour Tribunes (hors sujets déjà publiés sur Agôn).`);

  setProgress(4, "Déduplication IA", "");
  const deduplication = await deduplicateSubjectsWithAI(rawSubjects);
  const dedupedSubjects = deduplication.subjects;

  console.log(`${dedupedSubjects.length} sujet(s) après déduplication.`);

  let analyzedSubjects;

  if (openai) {
    setProgress(5, "Analyse IA", `0 / ${dedupedSubjects.length} sujets`);
    analyzedSubjects = await analyzeScoresWithAI(ensureSubjectIds(dedupedSubjects));
  } else {
    analyzedSubjects = ensureSubjectIds(dedupedSubjects).map(subject => {
      const fb = fallbackAiAnalysis(subject);
      return {
        ...subject,
        debateScore: fb.debateScore,
        controversyLevel: fb.controversyLevel,
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
    mergeCount: deduplication.mergeResult.mergeGroups.length,
    dedupError: deduplication.mergeResult.error || null,
    deduplication: deduplication.mergeResult,
    aiEnabled: Boolean(openai),
    collectReport: { articles: articlesReport, youtube: videosReport },
    subjects: analyzedSubjects,
    opinionItems
  };

  const sessions = loadSessions();

  sessions.unshift(session);

  const limitedSessions = sessions.slice(0, MAX_SESSIONS_TO_KEEP);

  saveSessions(limitedSessions);

  setProgress(6, "Génération de la page", "");
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(analyzedSubjects, null, 2), "utf8");
  fs.writeFileSync(OUTPUT_HTML, generateHtml(limitedSessions), "utf8");

  console.log(`Fichier généré : ${OUTPUT_HTML}`);
  console.log(`Historique généré : ${HISTORY_FILE}`);
  console.log(`Analyse IA : ${openai ? "activée" : "désactivée, clé API absente"}`);
  logCollectionDiagnostics("mixte", analyzedSubjects.length);
}

let isRunning = false;
let collectProgress = { running: false, done: false, stepIndex: 0, stepTotal: 6, step: "", detail: "" };

function setProgress(stepIndex, step, detail) {
  collectProgress = { running: true, done: false, stepIndex, stepTotal: 6, step, detail: detail || "" };
}

apiApp.get("/progress", (req, res) => {
  res.json(collectProgress);
});

async function main(minSources = MIN_DISTINCT_SOURCES) {
  isRunning = true;
  collectProgress = { running: true, done: false, stepIndex: 0, stepTotal: 6, step: "Démarrage…", detail: "" };
  try {
    await runWatchSession(minSources);
  } finally {
    isRunning = false;
    const historyPath = path.join(__dirname, HISTORY_FILE);
    let lastReport = null;
    try {
      const sessions = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      if (sessions && sessions[0] && sessions[0].collectReport) lastReport = sessions[0].collectReport;
    } catch (_) {}
    collectProgress = { ...collectProgress, running: false, done: true, collectReport: lastReport };
  }
}

// ==================== MODE CERTAMEN ====================

const CERTAMEN_OUTPUT_HTML = "certamen.html";
const CERTAMEN_HISTORY_FILE = "certamen-sessions.json";
const CERTAMEN_MAX_SESSIONS = 6;
const MAX_CERTAMEN_SUBJECTS_FOR_AI = (() => {
  const env = Number(process.env.CERTAMEN_AI_LIMIT);
  return Number.isFinite(env) && env > 0 ? Math.round(env) : 120;
})();

const CERTAMEN_DEBATE_MARKERS = [
  "faut-il", "doit-on", "peut-on", "interdire", "autoriser", "réformer",
  "taxer", "supprimer", "maintenir", "renforcer", "assouplir", "durcir",
  "limiter", "obliger", "sanctionner", "contrôler", "réguler",
  "débat", "inquiète", "critique", "tribune", "sondage", "opposition",
  "désaccord", "affrontement", "tension"
];

// Marqueurs forts : vocabulaire explicitement polémique/clivant (poids double dans le score),
// pour privilégier les vrais sujets clivants face aux sujets simplement informatifs et repris.
const CERTAMEN_STRONG_DEBATE_MARKERS = [
  "polémique", "controverse", "scandale", "scandaleux", "indignation",
  "tollé", "colère", "fronde", "contestation", "manifestation", "grève",
  "boycott", "dénonce", "accuse", "accusé", "accusée", "plainte", "procès",
  "clivage", "clivant", "divise", "révolte", "injustice", "discrimination"
];

// Sigles de partis : poids fort, mais matchés avec limites de mot SUR LE TEXTE NON MIS EN
// MINUSCULE (sensible à la casse), sinon "rn"/"ps"/"lr" déclenchent dans n'importe quel mot
// courant (gouve-RN-ement, cor-PS, va-LeuR...). Ne matche donc que le sigle réellement écrit
// en majuscules, isolé.
const CERTAMEN_POLITICAL_PARTY_ACRONYMS = ["RN", "LFI", "LR", "PS", "EELV"];

// Noms de personnalités politiques : insensible à la casse comme les autres marqueurs (noms
// propres assez longs/distinctifs pour ne pas faire de faux positifs). Liste volontairement
// équilibrée sur le spectre politique — à compléter ici au besoin.
const CERTAMEN_POLITICAL_NAMES = [
  "bardella", "mélenchon", "tondelier", "le pen", "macron", "attal", "lecornu",
  "borne", "philippe", "bayrou", "darmanin", "retailleau", "wauquiez", "ciotti",
  "zemmour", "faure", "glucksmann", "roussel", "ruffin"
];

const CERTAMEN_EXCLUDE_KEYWORDS = [
  "mort de", "décès de", "tué", "décédée", "décédé", "deuil",
  "collision", "carambolage", "crash aérien", "naufrage",
  "météo du", "températures prévues", "canicule attendue",
  "résultats du match", "victoire de", "défaite de",
  "programme tv", "ce soir à la télé",
  "en direct :", "live :", "direct :"
];

function certamenComputeScore(subject) {
  const rawText = [
    subject.subject,
    ...((subject.contents || []).map(function(c) {
      return [c.title || "", c.summary || ""].join(" ");
    }))
  ].join(" ");
  const text = rawText.toLowerCase();

  const weakMarkerCount = CERTAMEN_DEBATE_MARKERS.filter(function(m) {
    return text.includes(m);
  }).length;

  const strongMarkerCount = CERTAMEN_STRONG_DEBATE_MARKERS.filter(function(m) {
    return text.includes(m);
  }).length;

  const politicalAcronymCount = CERTAMEN_POLITICAL_PARTY_ACRONYMS.filter(function(a) {
    return new RegExp("\\b" + a + "\\b").test(rawText);
  }).length;

  const politicalNameCount = CERTAMEN_POLITICAL_NAMES.filter(function(n) {
    return text.includes(n);
  }).length;

  const politicalMarkerCount = politicalAcronymCount + politicalNameCount;

  const markerCount = weakMarkerCount + strongMarkerCount + politicalMarkerCount;

  const excludeCount = CERTAMEN_EXCLUDE_KEYWORDS.filter(function(k) {
    return text.includes(k);
  }).length;

  const sourceCount = Number(subject.sourceCount || 1);
  const hasMultiSources = sourceCount > 1;
  const hasMixedTypes = subject.articleCount > 0 && subject.youtubeCount > 0;

  // Score automatique : les marqueurs de débat restent le signal principal, les marqueurs
  // forts (vocabulaire explicitement polémique) comptent double, les marqueurs politiques
  // (partis, personnalités) comptent comme les marqueurs forts pour être conservés en
  // priorité. Le bonus sources/mixte est volontairement plafonné bas pour qu'il ne fasse
  // jamais passer un sujet non polémique devant un sujet avec au moins un marqueur (voir tri
  // par hasMarker dans runCertamenSession).
  const score = (weakMarkerCount * 3) + (strongMarkerCount * 6) + (politicalMarkerCount * 6)
    + (hasMultiSources ? Math.min(sourceCount, 5) * 0.3 : 0)
    + (hasMixedTypes ? 0.5 : 0);

  // Exclure si : mots d'exclusion présents ET aucun marqueur débat
  const excluded = excludeCount > 0 && markerCount === 0;

  return { text, markerCount, strongMarkerCount, politicalMarkerCount, score, excludeCount, excluded };
}

function certamenPrefilter(subjects) {
  return subjects
    .map(function(subject) {
      const { markerCount, strongMarkerCount, score, excluded } = certamenComputeScore(subject);
      return Object.assign({}, subject, {
        _certamenMarkers: markerCount,
        _certamenStrongMarkers: strongMarkerCount,
        _certamenScore: score,
        _certamenHasMarker: markerCount > 0,
        _certamenExcluded: excluded
      });
    })
    .filter(function(s) { return !s._certamenExcluded; });
}

// Formes de question proposées au modèle pour éviter le tic "Faut-il … ?" : chaque appel
// tire 3 formes au hasard et les impose en priorité. La variété entre arènes d'une même
// session vient de ce tirage (les appels étant indépendants, une simple consigne "varie"
// ne suffit pas — le modèle retombe sur "Faut-il" quand rien ne l'oriente).
const CERTAMEN_QUESTION_FORMS = [
  "\"[acteur] doit-il/doit-elle [décision] ?\" — ex : \"Le Sénat doit-il assouplir les règles sur les pesticides ?\"",
  "\"[acteur] a-t-il raison de [action] ?\" — ex : \"Ruffin a-t-il raison de vouloir bloquer le lobbying des ex-ministres ?\"",
  "\"La décision de [acteur] est-elle [qualificatif] ?\" — ex : \"La condamnation d'Epson est-elle un tournant pour les consommateurs ?\"",
  "\"Qui doit [responsabilité] ?\" — ex : \"Qui doit payer l'adaptation à la canicule ?\"",
  "\"[mesure/décision] : [option] ou [option] ?\" — ex : \"Sondages en campagne : outil démocratique ou poison du débat ?\"",
  "\"[sujet] menace-t-il/elle [enjeu] ?\" — ex : \"Les sondages menacent-ils la sincérité du vote ?\"",
  "\"Peut-on [action débattue] ?\" — ex : \"Peut-on faire campagne sous contrôle judiciaire ?\"",
  "\"Jusqu'où [action/tolérance] ?\" — ex : \"Jusqu'où restreindre la cigarette pour les jeunes générations ?\"",
  "\"Pourquoi pas [proposition] ?\" — ex : \"Pourquoi pas un mécénat obligatoire pour les grandes fortunes ?\"",
  "\"[acteur] va-t-il trop loin avec [mesure] ?\" — ex : \"L'Assurance maladie va-t-elle trop loin avec l'interdiction du tabac ?\""
];

function pickCertamenQuestionForms(count = 3) {
  const shuffled = CERTAMEN_QUESTION_FORMS.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

async function analyzeCertamenSubjectWithAI(subject) {
  if (!openai) {
    return {
      isDebatable: subject._certamenMarkers > 0,
      debatePotentialScore: subject._certamenMarkers > 0 ? 5 : 2,
      editorialDecision: subject._certamenMarkers > 0 ? "reformulate" : "avoid",
      reason: "Analyse IA non disponible.",
      suggestedQuestion: subject.subject,
      positionA: "Pour",
      positionB: "Contre",
      theme: AGON_THEMES[0],
      risk: "medium",
      politicalOrientation: { isPolitical: false, positionA: null, positionB: null }
    };
  }

  const compactContents = (subject.contents || []).slice(0, 6).map(function(c) {
    return {
      source: c.source,
      title: c.title,
      summary: (c.summary || "").slice(0, 300),
      type: c.type
    };
  });

  const prompt = `Tu es un éditeur pour Agôn, une plateforme de débat public.

Ta mission : évaluer si cette actualité peut devenir une bonne arène Agôn.

Critères d'un bon sujet Agôn :
- deux positions défendables ;
- question non évidente ;
- enjeu collectif réel ;
- sujet compréhensible sans expertise ;
- pas seulement informatif ;
- pas une tragédie exploitée à chaud ;
- opposition de valeurs, de responsabilités, de solutions ou de priorités.

Sujet :
${subject.subject}

Sources (${(subject.sources || []).join(", ")}) :
${JSON.stringify(compactContents, null, 2)}

Réponds uniquement en JSON valide :
{
  "isDebatable": true/false,
  "debatePotentialScore": entier de 0 à 10,
  "editorialDecision": "arena" | "understand" | "reformulate" | "avoid",
  "reason": "explication courte (max 120 caractères)",
  "suggestedQuestion": "question Agôn (max 98 caractères, espaces et tirets compris)",
  "positionA": "camp A (max 55 caractères)",
  "positionB": "camp B (max 55 caractères)",
  "theme": "thème exact parmi : ${AGON_THEMES.join(" / ")}",
  "risk": "low" | "medium" | "high"
}

STYLE pour suggestedQuestion et positionA/positionB :
Écris comme un vrai utilisateur d'Agôn : clair, direct, naturel, pas comme un assistant.
Le français doit rester globalement correct, mais pas trop scolaire.
La plupart des questions doivent être propres. Parfois, environ 1 fois sur 5, tu peux laisser une petite imperfection naturelle : minuscule en début de phrase, accent secondaire oublié, tournure orale.
Tu peux garder un style oral léger dans les positions ("oui", "non", "faut"), avec parfois une petite faute légère, mais sans fautes grossières.

À éviter absolument :
* fautes visibles dans la question ("faut t'il", "lextrme", "pouvouir", mots oubliés) ;
* accents manquants sur les mots importants ;
* conjugaisons ou accords cassés ;
* ponctuation doublée ou absence de point d'interrogation pour suggestedQuestion.

Exemples de bon rendu :
* suggestedQuestion: "La justice est-elle trop laxiste face à la récidive ?"
* positionA: "oui, il faut protéger les victimes"
* positionB: "non, la prison ne règle pas tout"
Exemples acceptables de petites imperfections rares :
* suggestedQuestion: "faut-il limiter les pouvoirs du président ?"
* positionA: "oui faut éviter les abus"
* positionB: "non, ça bloque l'action"

Règles pour suggestedQuestion :
- question concrète et débattable ;
- ancrée dans le sujet précis ;
- mentionne si possible l'acteur, le dispositif, le lieu ou la décision au coeur du sujet ;
- évite les formulations génériques qui pourraient s'appliquer à dix autres articles ;
- FORME IMPOSÉE : formule la question selon l'une de ces formes, dans cet ordre de préférence :
${pickCertamenQuestionForms(3).map((form, i) => `  ${i + 1}. ${form}`).join("\n")}
- INTERDIT de commencer par "Faut-il" sauf si aucune des formes ci-dessus ne peut convenir ET que le sujet porte sur une interdiction, une obligation ou une réforme à trancher ;
- pas de question évidente ("faut-il éviter les accidents ?") ;
- les deux camps doivent sembler défendables.

Règles pour positionA/positionB :
- étiquettes de camp courtes, directes, parfois passionnées ;
- pas d'arguments longs, pas de "car", "pour que", "afin de" ;
- symétriques et défendables.

Règles pour editorialDecision :
- "arena" : peut devenir une arène Agôn immédiatement ;
- "understand" : intéressant mais pas vraiment clivant ;
- "reformulate" : potentiel mais question trop évidente ou fragile ;
- "avoid" : trop sensible, tragique ou peu débattable.

Ne force jamais un débat. Si le sujet ne s'y prête pas, réponds "avoid".`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.9,
      max_output_tokens: 600
    });
    logAiUsage("certamen-analyze", response);
    const parsed = safeJsonParse(response.output_text || "");
    const allowedDecisions = new Set(["arena", "understand", "reformulate", "avoid"]);
    const allowedRisks = new Set(["low", "medium", "high"]);
    const isDebatable = parsed.isDebatable === true;
    const editorialDecision = allowedDecisions.has(String(parsed.editorialDecision || ""))
      ? parsed.editorialDecision : "avoid";
    const suggestedQuestion = limitDebateQuestionText(cleanCertamenGeneratedText(parsed.suggestedQuestion || ""));
    let positionA = cleanCertamenGeneratedText(parsed.positionA || "").slice(0, 55);
    let positionB = cleanCertamenGeneratedText(parsed.positionB || "").slice(0, 55);

    // Détection du clivage gauche/droite et réassignation positionA=gauche/positionB=droite,
    // seulement pour les sujets retenus (évite un appel IA superflu sur les ~120 candidats
    // écartés par session) — même logique que alignPositionsByPolitics() dans server.js
    // (veille mixte), nécessaire pour que la jauge politique d'Agôn s'affiche sur Certamen.
    let politicalOrientation = { isPolitical: false, positionA: null, positionB: null };
    if (editorialDecision !== "avoid" && positionA && positionB) {
      const aligned = await alignCertamenPositionsByPolitics({ debateQuestion: suggestedQuestion, positionA, positionB });
      positionA = aligned.positionA;
      positionB = aligned.positionB;
      politicalOrientation = aligned.politicalOrientation;
    }

    return {
      isDebatable,
      debatePotentialScore: Number.isFinite(Number(parsed.debatePotentialScore))
        ? Math.max(0, Math.min(10, Number(parsed.debatePotentialScore))) : 0,
      editorialDecision,
      reason: String(parsed.reason || "").slice(0, 200),
      suggestedQuestion,
      positionA,
      positionB,
      theme: normalizeAgonTheme(parsed.theme),
      risk: allowedRisks.has(String(parsed.risk || "")) ? parsed.risk : "medium",
      politicalOrientation
    };
  } catch (error) {
    console.error(`Erreur IA Certamen pour "${subject.subject}" :`, error.message);
    return {
      isDebatable: false,
      debatePotentialScore: 0,
      editorialDecision: "avoid",
      reason: "Erreur d'analyse IA.",
      suggestedQuestion: subject.subject,
      positionA: "",
      positionB: "",
      theme: AGON_THEMES[0],
      risk: "medium",
      politicalOrientation: { isPolitical: false, positionA: null, positionB: null }
    };
  }
}

// Identique à alignPositionsByPolitics() de server.js (même prompt, mêmes règles) —
// dupliqué ici car veille-mixte.js et server.js sont deux process Node séparés.
async function alignCertamenPositionsByPolitics({ debateQuestion, positionA, positionB }) {
  if (!openai || !debateQuestion || !positionA || !positionB) {
    return { positionA, positionB, politicalOrientation: { isPolitical: false, positionA: null, positionB: null } };
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
    logAiUsage("certamen-align-positions", response);
    const parsed = safeJsonParse(response.output_text || "");
    if (parsed.hasPoliticalOrientation && parsed.leftPosition && parsed.rightPosition) {
      return {
        positionA: String(parsed.leftPosition).trim().slice(0, 55),
        positionB: String(parsed.rightPosition).trim().slice(0, 55),
        politicalOrientation: { isPolitical: true, positionA: "left", positionB: "right" }
      };
    }
  } catch (error) {
    console.error("Erreur alignement politique Certamen :", error.message);
  }
  return { positionA, positionB, politicalOrientation: { isPolitical: false, positionA: null, positionB: null } };
}

function certamenRiskToControversyLevel(risk) {
  if (risk === "low") return "faible";
  if (risk === "high") return "fort";
  return "moyen";
}

function loadCertamenSessions() {
  if (!fs.existsSync(CERTAMEN_HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CERTAMEN_HISTORY_FILE, "utf8"));
  } catch { return []; }
}

function saveCertamenSessions(sessions) {
  fs.writeFileSync(CERTAMEN_HISTORY_FILE, JSON.stringify(sessions, null, 2), "utf8");
}

function generateCertamenHtml(sessions) {
  const generatedAt = dayjs().format("DD/MM/YYYY HH:mm:ss");

  const savedTitles = new Set(loadSavedSubjects().map(s => s.subject));
  const sentKeys = new Set(loadSentToAgonItems().map((item) => String(item?.question || item?.subject || "").trim()).filter(Boolean));

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
        Voir les anciennes analyses
      </button>
    `
    : "";

  const sessionBlocks = sessions.map((session, index) => {
    const subjects = session.subjects || [];
    const mergeGroupByKeepId = new Map(
      (session.deduplication?.mergeGroups || []).map((group) => [String(group?.keepSubjectId || ""), group])
    );
    const subjectBlocks = subjects.map(subject => buildSubjectCardHtml(subject, { savedTitles, sentKeys, mergeGroupByKeepId })).join("");

    const isLatest = index === 0;

    return `
      <section
        class="session ${isLatest ? "latest active-session" : "hidden-session"}"
        data-session-index="${index}"
      >
        <div class="session-header">
          <div>
            <h2>${isLatest ? "Dernière analyse Certamen" : "Analyse Certamen précédente"}</h2>
            <p>Session du <strong>${escapeHtml(session.generatedAtLabel)}</strong></p>
          </div>
          <div class="session-stats">
            <strong>${subjects.length}</strong>
            <span>sujet(s) débattable(s)</span>
          </div>
        </div>

        ${
          subjects.length
            ? subjectBlocks
            : `<div class="empty">Aucun sujet débattable détecté pendant cette session.</div>`
        }
      </section>
    `;
  }).join("");

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <script>if (window.location.search.includes('token')) history.replaceState({}, '', window.location.pathname);</script>
  <title>Certamen — Sujets débattables</title>
  ${buildVeilleStylesHtml()}
</head>
<body>
  <h1>Certamen — Sujets débattables</h1>

  <div class="nav">
    <a href="/mixte">Veille mixte</a>
    <a href="/certamen">Certamen</a>
    <a href="/admin">⚙ Admin</a>
    <button class="nav-refresh-btn" onclick="startRefresh()">↻ Actualiser</button>
  </div>

  <p class="intro">
    L'IA explore les actualités collectées et repère celles qui présentent un fort potentiel de débat pour Agôn.
    Chaque sujet retenu peut ensuite être transformé en arène (question, positions, résumé) puis envoyé vers Agôn — exactement comme en veille mixte.
  </p>

  <div class="status">
    <div>
      Dernière génération du fichier :
      <strong>${escapeHtml(generatedAt)}</strong>
    </div>
    <div class="refresh-row">
      <button class="refresh-btn" type="button">Mettre à jour</button>
    </div>
    <div class="ptr-indicator" id="ptr-indicator"></div>
    <button class="update-banner" id="update-banner" onclick="window.location.reload()">Nouvelle analyse disponible — Charger</button>
  </div>

  ${renderAutoCollectCertamenWidgetHtml()}
  ${renderCertamenPublishWidgetHtml()}

  <div id="progress-panel">
    <div class="progress-step-label">Étape <span id="prog-step">…</span> / 4 — <span id="prog-name">Démarrage…</span></div>
    <div class="progress-bar-track"><div class="progress-bar-fill" id="prog-bar"></div></div>
    <div class="progress-detail-text" id="prog-detail"></div>
  </div>

  <div class="filter-bar">
    <button class="filter-btn active" data-sort="score">Sujets clivants</button>
    <button class="filter-btn" data-sort="sources">Sujets majeurs</button>
    <button class="filter-btn" data-sort="ranked">Classement</button>
    <button class="filter-btn" data-sort="saved">Sujets enregistrés</button>
    <a class="filter-link" href="/sent-to-agon">Articles envoyés vers Agôn</a>
  </div>

  <div class="saved-selection-bar" id="saved-selection-bar">
    <div class="saved-selection-top">
      <div class="selection-count"><span id="selected-count">0</span> arène(s) sélectionnée(s)</div>
      <div class="saved-selection-actions">
        <button class="select-all-arenas-btn" type="button">Tout sélectionner</button>
        <button class="clear-selection-btn" type="button">Annuler la sélection</button>
      </div>
    </div>
    <button class="generate-all-btn" type="button">Tout générer</button>
  </div>

  <div class="ranked-action-bar" id="ranked-action-bar">
    <button class="check-top10-btn" type="button" id="check-top10-btn">Cocher les 10</button>
  </div>

  ${
    sessions.length
      ? `
        <div class="session-tabs-wrapper">
          <h2>Historique des analyses</h2>
          <p>Choisis une session pour voir uniquement les sujets détectés à cette heure-là.</p>
          <div class="session-tabs">
            ${sessionTabs}
          </div>
          ${olderTabsButton}
        </div>

        ${sessionBlocks}
      `
      : `<div class="empty">Aucune session Certamen générée pour le moment.</div>`
  }

  ${buildSubjectInteractionScriptHtml({ topTenSorts: ["ranked", "score"], certamen: true })}
  <script>
    var ptrIsRefreshing = false;

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

    function renderProgress(prog) {
      var pct = prog.stepTotal > 0 ? Math.min(100, Math.round((prog.stepIndex / prog.stepTotal) * 100)) : 0;
      var bar = document.getElementById("prog-bar");
      var step = document.getElementById("prog-step");
      var name = document.getElementById("prog-name");
      var detail = document.getElementById("prog-detail");
      if (bar) bar.style.width = pct + "%";
      if (step) step.textContent = prog.stepIndex || "…";
      if (name) name.textContent = prog.step || "Démarrage…";
      if (detail) detail.textContent = prog.detail || "";
    }

    async function startRefresh() {
      if (ptrIsRefreshing) return;
      ptrIsRefreshing = true;

      var refreshBtn = document.querySelector(".refresh-btn");
      if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = "En cours…"; }

      var panel = document.getElementById("progress-panel");
      if (panel) { panel.style.display = "block"; }
      renderProgress({ stepIndex: 0, stepTotal: 4, step: "Démarrage…", detail: "" });

      function finishRefresh() {
        clearInterval(progressPoll);
        clearTimeout(timeoutId);
        ptrIsRefreshing = false;
        setPtrIndicator(null);
        if (panel) panel.style.display = "none";
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "Mettre à jour"; }
        showUpdateBanner();
      }

      function failRefresh(message) {
        clearInterval(progressPoll);
        clearTimeout(timeoutId);
        ptrIsRefreshing = false;
        setPtrIndicator(null);
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "Mettre à jour"; }
        renderProgress({ stepIndex: 0, stepTotal: 4, step: "Erreur lancement de l'analyse", detail: message || "" });
      }

      var progressPoll = setInterval(async function() {
        try {
          var r = await fetch("/certamen/progress?t=" + Date.now());
          var prog = await r.json();
          renderProgress(prog);
          if (!prog.running && prog.done) finishRefresh();
        } catch (e) {}
      }, 1500);

      var timeoutId = setTimeout(finishRefresh, 15 * 60 * 1000);

      try {
        var launchRes = await fetch("/certamen/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        var launchData = await launchRes.json().catch(function() { return {}; });
        if (!launchRes.ok || launchData.error) throw new Error(launchData.error || "Réponse serveur invalide");
      } catch (e) {
        failRefresh(e && e.message ? e.message : "Impossible de démarrer l'analyse");
      }
    }

    var refreshBtn = document.querySelector(".refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function() { startRefresh(); });
    }

    initializeStoryBoxes(document);

    (function autoSuggestMissingStories() {
      var subjectsNeedingStory = Array.from(document.querySelectorAll(".subject")).filter(function(el) {
        var resume = el.querySelector(".resume");
        var hasResume = resume && (resume.dataset.rawText || resume.textContent.trim());
        var box = el.querySelector(".story-link-box");
        var hasStory = box && (box.dataset.selectedMode === "existing" || box.dataset.storyDecision === "existing_story" || box.dataset.storyDecision === "uncertain");
        return hasResume && !hasStory;
      });
      var delay = 0;
      subjectsNeedingStory.forEach(function(el) {
        setTimeout(function() { suggestStoryForSubject(el); }, delay);
        delay += 800;
      });
    })();

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

let certamenIsRunning = false;
let certamenProgress = { running: false, done: false, stepIndex: 0, stepTotal: 4, step: "", detail: "" };

function setCertamenProgress(stepIndex, step, detail) {
  certamenProgress = { running: true, done: false, stepIndex, stepTotal: 4, step, detail: detail || "" };
}

async function runCertamenSession() {
  const startedAt = dayjs();
  console.log("");
  console.log("======================================");
  console.log(`Nouvelle session Certamen : ${startedAt.format("DD/MM/YYYY HH:mm:ss")}`);
  console.log("======================================");
  resetCollectionDiagnostics();

  setCertamenProgress(1, "Collecte des articles", "Démarrage…");
  const { contents: articles } = await collectArticles(null, new Set(), MEDIA_FILE_CERTAMEN);

  setCertamenProgress(2, "Collecte des vidéos YouTube", "Démarrage…");
  const { contents: videos } = await collectYouTubeVideos(null, new Set(), CHANNELS_FILE_CERTAMEN);

  const contents = [...articles, ...videos];
  console.log(`Certamen : ${contents.length} contenu(s) collecté(s).`);

  setCertamenProgress(3, "Regroupement et préfiltrage", "");
  const groups = groupContentsBySubject(contents);
  const rawSubjects = filterMultiSourceSubjects(groups, 1); // min 1 source (vs 4 en mode mixte)
  console.log(`Certamen : ${rawSubjects.length} sujet(s) après regroupement (seuil 1 source).`);

  // Même déduplication IA que la veille mixte (deduplicateSubjectsWithAI, appelée avant le
  // scoring) : fusionne les sujets bruts qui parlent du même fait d'actualité avant de les
  // noter, pour qu'un sujet repéré sous deux titres différents ne soit pas scoré/affiché en double.
  const deduplication = await deduplicateSubjectsWithAI(rawSubjects);
  const dedupedSubjects = deduplication.subjects;
  console.log(`Certamen : ${dedupedSubjects.length} sujet(s) après déduplication (${deduplication.mergeResult.mergeGroups.length} fusion(s)).`);

  const prefiltered = certamenPrefilter(dedupedSubjects);
  console.log(`Certamen : ${prefiltered.length} sujet(s) après préfiltrage sans IA.`);

  // Tri avant envoi à l'IA : priorité absolue aux sujets ayant au moins un marqueur de débat
  // (polémique/clivant), pour qu'un sujet purement informatif mais multi-sources ne passe
  // jamais devant un sujet clivant même peu repris. À l'intérieur de chaque groupe, tri par
  // score décroissant.
  const sortedCandidates = prefiltered.slice().sort(function(a, b) {
    const aHasMarker = a._certamenHasMarker ? 1 : 0;
    const bHasMarker = b._certamenHasMarker ? 1 : 0;
    if (aHasMarker !== bHasMarker) return bHasMarker - aHasMarker;
    return (b._certamenScore || 0) - (a._certamenScore || 0);
  });

  const limit = MAX_CERTAMEN_SUBJECTS_FOR_AI;
  const candidates = sortedCandidates.slice(0, limit);
  console.log(`Certamen : ${candidates.length} sujet(s) envoyés à l'IA sur limite ${limit}.`);

  setCertamenProgress(4, "Analyse IA Certamen", `0 / ${candidates.length}`);
  const analyzed = [];

  for (let i = 0; i < candidates.length; i++) {
    const subject = candidates[i];
    setCertamenProgress(4, "Analyse IA Certamen", `${i + 1} / ${candidates.length}`);
    console.log(`Certamen IA : ${subject.subject}`);
    const certamen = await analyzeCertamenSubjectWithAI(subject);
    // Champs au format des sujets veille mixte : permet de réutiliser telles quelles
    // les cartes d'arène, la génération IA et la persistance (/save-update). subjectId
    // n'est volontairement pas réécrit ici : il provient de deduplicateSubjectsWithAI()
    // (via ensureSubjectIds) et doit rester stable pour que mergeGroupByKeepId (affichage
    // du bandeau "Sujets fusionnés ici par l'IA") retrouve le bon sujet.
    analyzed.push(Object.assign({}, subject, {
      certamen,
      mergedSubjectTitles: subject.mergedSubjectTitles || [],
      scoreAnalyzed: true,
      debateScore: certamen.debatePotentialScore || 0,
      controversyLevel: certamenRiskToControversyLevel(certamen.risk),
      aiAnalyzed: false,
      ai: null
    }));
  }

  const debatables = analyzed
    .filter(function(s) { return s.certamen.editorialDecision !== "avoid"; })
    .sort(function(a, b) { return (b.certamen.debatePotentialScore || 0) - (a.certamen.debatePotentialScore || 0); });

  console.log(`Certamen : ${debatables.length} sujet(s) débattable(s) retenu(s).`);

  const session = {
    generatedAt: startedAt.toISOString(),
    generatedAtLabel: startedAt.format("DD/MM/YYYY à HH:mm"),
    subjectCount: debatables.length,
    mergeCount: deduplication.mergeResult.mergeGroups.length,
    dedupError: deduplication.mergeResult.error || null,
    deduplication: deduplication.mergeResult,
    subjects: debatables
  };

  const sessions = loadCertamenSessions();
  sessions.unshift(session);
  const trimmed = sessions.slice(0, CERTAMEN_MAX_SESSIONS);
  saveCertamenSessions(trimmed);
  fs.writeFileSync(CERTAMEN_OUTPUT_HTML, generateCertamenHtml(trimmed), "utf8");
  console.log(`Certamen : session sauvegardée.`);
  logCollectionDiagnostics("Certamen", debatables.length);

  autoCheckTopCertamenSubjects(debatables);
}

// Remplace le clic manuel sur "Cocher les 10" : sélectionne automatiquement les
// MAX_CHECKED_SUBJECTS sujets au score IA le plus élevé de la session qui vient d'être
// générée et les enregistre dans saved-subjects.json (même chemin que le bouton "Sauvegarder"
// individuel), pour que getCheckedCertamenSubjects() les retienne sans intervention humaine.
function autoCheckTopCertamenSubjects(debatables) {
  const top = debatables.slice(0, MAX_CHECKED_SUBJECTS);
  let checked = 0;
  for (const subject of top) {
    const c = subject.certamen || {};
    try {
      upsertSavedSubject({
        action: "save",
        subject: subject.subject,
        debateScore: c.debatePotentialScore || subject.debateScore || 0,
        debateQuestion: c.suggestedQuestion || "",
        resume: "",
        mainKeyword: "",
        agonTheme: c.theme || "",
        positionA: c.positionA || "",
        positionB: c.positionB || "",
        sources: Array.isArray(subject.sources) ? subject.sources.join(", ") : "",
        contents: Array.isArray(subject.contents)
          ? subject.contents.map(function(ct) {
              return {
                type: ct.type || "article",
                link: ct.link || "",
                source: ct.source || "",
                title: ct.title || "",
                thumbnail: ct.thumbnail || ""
              };
            })
          : [],
        sessionLabel: "",
        storySelection: null
      });
      checked += 1;
    } catch (err) {
      console.error(`Certamen auto-cochage : erreur pour "${subject.subject}" :`, err.message);
    }
  }
  console.log(`Certamen : ${checked}/${top.length} sujet(s) auto-coché(s) (top score IA).`);
}

apiApp.get("/certamen/progress", function(req, res) {
  res.json(certamenProgress);
});

apiApp.post("/certamen/refresh", async function(req, res) {
  if (certamenIsRunning) {
    return res.json({ ok: true, running: true });
  }
  certamenIsRunning = true;
  certamenProgress = { running: true, done: false, stepIndex: 0, stepTotal: 4, step: "Démarrage…", detail: "" };

  runCertamenSession().catch(function(err) {
    console.error("Erreur session Certamen :", err.message);
  }).finally(function() {
    certamenIsRunning = false;
    certamenProgress = Object.assign({}, certamenProgress, { running: false, done: true });
  });

  res.json({ ok: true, started: true });
});

// ==================== FIN MODE CERTAMEN ====================

function renderMixteHtmlFromHistory() {
  const existingSessions = loadSessions().slice(0, MAX_SESSIONS_TO_KEEP);
  fs.writeFileSync(OUTPUT_HTML, generateHtml(existingSessions), "utf8");
  console.log(`veille-mixte.html régénéré (${existingSessions.length} session(s)).`);
}

if (process.argv.includes("--render-html")) {
  renderMixteHtmlFromHistory();
  process.exit(0);
}

if (!fs.existsSync(OUTPUT_HTML)) {
  const existingSessions = loadSessions();
  if (existingSessions.length > 0) {
    renderMixteHtmlFromHistory();
  }
}

const localApiServer = apiApp.listen(API_PORT, "127.0.0.1", () => {
  console.log(`API mixte lancée sur 127.0.0.1:${API_PORT}`);
});

localApiServer.on("error", (error) => {
  console.error("Erreur API mixte locale :", error.message);
});

console.log("Bot veille prêt — collecte manuelle uniquement (bouton Mise à jour).");
