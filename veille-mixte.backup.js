const fs = require("fs");
const Parser = require("rss-parser");
const stringSimilarity = require("string-similarity");
const dayjs = require("dayjs");
const OpenAI = require("openai");

const parser = new Parser();

const MEDIA_FILE = "medias.json";
const CHANNELS_FILE = "youtube-chaines.json";

const OUTPUT_JSON = "veille-mixte.json";
const OUTPUT_HTML = "veille-mixte.html";
const HISTORY_FILE = "sessions-mixte.json";

const HOURS_BACK_ARTICLES = 24;
const HOURS_BACK_YOUTUBE = 168;

const SIMILARITY_THRESHOLD = 0.42;
const MIN_SHARED_KEYWORDS = 1;
const MIN_DISTINCT_SOURCES = 2;

const UPDATE_INTERVAL_MINUTES = 30;
const MAX_SESSIONS_TO_KEEP = 20;
const MAX_SUBJECTS_TO_ANALYZE_WITH_AI = 25;

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

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

async function getRssUrlFromYouTubeChannel(channel) {
  if (channel.rss) {
    return channel.rss;
  }

  if (!channel.url) {
    throw new Error("Aucun champ rss ou url fourni");
  }

  const response = await fetch(channel.url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Impossible d'ouvrir la chaîne YouTube : ${response.status}`);
  }

  const html = await response.text();

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

function extractYouTubeVideoId(link) {
  const value = String(link || "");
  const match = value.match(/[?&]v=([^&]+)/);

  if (match && match[1]) {
    return match[1];
  }

  return "";
}

async function collectArticles() {
  const medias = JSON.parse(fs.readFileSync(MEDIA_FILE, "utf8"));
  const contents = [];

  for (const media of medias) {
    try {
      console.log(`Article — lecture de ${media.nom}...`);

      const feed = await parser.parseURL(media.rss);

      for (const item of feed.items || []) {
        const date = getItemDate(item);

        if (!isRecent(date, HOURS_BACK_ARTICLES)) {
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

async function collectYouTubeVideos() {
  const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
  const contents = [];

  for (const channel of channels) {
    try {
      console.log(`YouTube — lecture de ${channel.nom}...`);

      const rssUrl = await getRssUrlFromYouTubeChannel(channel);
      const feed = await parser.parseURL(rssUrl);

      for (const item of feed.items || []) {
        const date = getItemDate(item);

        if (!isRecent(date, HOURS_BACK_YOUTUBE)) {
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
        contents: group.contents.sort((a, b) => new Date(b.date) - new Date(a.date))
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

function fallbackAiAnalysis(subject) {
  const hasBoth = subject.articleCount > 0 && subject.youtubeCount > 0;

  return {
    debateScore: hasBoth ? 6 : 4,
    controversyLevel: hasBoth ? "moyen" : "faible",
    debateQuestion: `Ce sujet mérite-t-il un débat public : ${subject.subject} ?`,
    whyDebatable: hasBoth
      ? "Ce sujet est repris à la fois par la presse et par YouTube, ce qui indique un potentiel de discussion publique."
      : "Ce sujet est repris par plusieurs sources, mais son potentiel polémique doit être vérifié.",
    angles: ["enjeux publics", "responsabilités", "effets concrets"],
    targetAudience: "grand public"
  };
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
    return fallbackAiAnalysis(subject);
  }

  const compactContents = subject.contents.slice(0, 10).map(content => ({
    type: content.type,
    source: content.source,
    orientation: content.orientation,
    title: content.title
  }));

  const prompt = `
Analyse ce sujet de veille et évalue son potentiel de débat public.

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
  "debateQuestion": "question de débat courte, claire et clivante",
  "whyDebatable": "explication en 1 ou 2 phrases",
  "angles": ["angle 1", "angle 2", "angle 3"],
  "targetAudience": "public le plus susceptible de réagir"
}

Critères :
- 0 à 3 : sujet informatif, peu clivant
- 4 à 6 : sujet débattable mais pas explosif
- 7 à 8 : sujet controversé, bon potentiel de débat
- 9 à 10 : sujet très clivant, fort potentiel de réactions
Favorise les sujets politiques, sociaux, économiques, éducatifs, écologiques, internationaux ou liés aux libertés publiques.
Pénalise les simples faits divers non politiques, résultats sportifs, annonces culturelles ou sujets purement descriptifs.
`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 500
    });

    const text = response.output_text;
    const parsed = safeJsonParse(text);

    return {
      debateScore: Number.isInteger(parsed.debateScore) ? parsed.debateScore : 0,
      controversyLevel: parsed.controversyLevel || "faible",
      debateQuestion: parsed.debateQuestion || `Faut-il débattre de ce sujet : ${subject.subject} ?`,
      whyDebatable: parsed.whyDebatable || "Analyse indisponible.",
      angles: Array.isArray(parsed.angles) ? parsed.angles.slice(0, 5) : [],
      targetAudience: parsed.targetAudience || "grand public"
    };
  } catch (error) {
    console.error(`Erreur IA pour le sujet "${subject.subject}" :`, error.message);
    return fallbackAiAnalysis(subject);
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
      ai
    });
  }

  const remainingSubjects = subjects.slice(MAX_SUBJECTS_TO_ANALYZE_WITH_AI).map(subject => ({
    ...subject,
    ai: fallbackAiAnalysis(subject)
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

  const sessionBlocks = sessions.map((session, index) => {
    const subjects = session.subjects || [];

    const subjectBlocks = subjects.map(subject => {
      const articles = subject.contents.filter(content => content.type === "article");
      const videos = subject.contents.filter(content => content.type === "youtube");
      const ai = subject.ai || fallbackAiAnalysis(subject);

      const angleItems = (ai.angles || []).map(angle => {
        return `<li>${escapeHtml(angle)}</li>`;
      }).join("");

      const articleItems = articles.map(article => {
        const date = dayjs(article.date).format("DD/MM/YYYY HH:mm");

        return `
          <li class="content-item">
            <span class="badge article">Article</span>
            <div>
              <strong>${escapeHtml(article.source)}</strong>
              ${
                article.orientation
                  ? `<span class="orientation"> — ${escapeHtml(article.orientation)}</span>`
                  : ""
              }
              <br>
              <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">
                ${escapeHtml(article.title)}
              </a>
              <br>
              <small>Publié le ${escapeHtml(date)}</small>
            </div>
          </li>
        `;
      }).join("");

      const videoItems = videos.map(video => {
        const date = dayjs(video.date).format("DD/MM/YYYY HH:mm");

        return `
          <li class="content-item video-item">
            ${
              video.thumbnail
                ? `<img src="${escapeHtml(video.thumbnail)}" alt="" class="thumb">`
                : `<span class="badge youtube">YouTube</span>`
            }
            <div>
              <strong>${escapeHtml(video.source)}</strong>
              ${
                video.orientation
                  ? `<span class="orientation"> — ${escapeHtml(video.orientation)}</span>`
                  : ""
              }
              <br>
              <a href="${escapeHtml(video.link)}" target="_blank" rel="noopener noreferrer">
                ${escapeHtml(video.title)}
              </a>
              <br>
              <small>Publié le ${escapeHtml(date)}</small>
            </div>
          </li>
        `;
      }).join("");

      return `
        <section class="subject">
          <div class="ai-score">
            <div>
              <span class="score-label">Potentiel débat</span>
              <strong>${escapeHtml(ai.debateScore)}/10</strong>
            </div>
            <span class="controversy">${escapeHtml(ai.controversyLevel)}</span>
          </div>

          <h3>${escapeHtml(subject.subject)}</h3>

          <div class="ai-box">
            <p class="debate-question">${escapeHtml(ai.debateQuestion)}</p>
            <p>${escapeHtml(ai.whyDebatable)}</p>
            ${
              angleItems
                ? `<p><strong>Angles possibles :</strong></p><ul class="angles">${angleItems}</ul>`
                : ""
            }
            <p class="target"><strong>Public susceptible de réagir :</strong> ${escapeHtml(ai.targetAudience)}</p>
          </div>

          <div class="subject-stats">
            <span>${subject.sourceCount} sources</span>
            <span>${subject.articleCount} article(s)</span>
            <span>${subject.youtubeCount} vidéo(s)</span>
          </div>

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
        </section>
      `;
    }).join("");

    const isLatest = index === 0;

    return `
      <section class="session ${isLatest ? "latest" : ""}">
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
    }

    .nav a {
      display: inline-block;
      margin-right: 10px;
      padding: 8px 12px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 999px;
      text-decoration: none;
      color: #111;
    }

    .status {
      background: #111;
      color: white;
      border-radius: 14px;
      padding: 14px 18px;
      margin-bottom: 24px;
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
    }

    .angles {
      margin-top: -8px;
      padding-left: 20px;
    }

    .target {
      color: #444;
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
      display: flex;
      gap: 14px;
      list-style: none;
      margin-bottom: 16px;
      align-items: flex-start;
    }

    .thumb {
      width: 160px;
      max-width: 35vw;
      border-radius: 10px;
      background: #ddd;
    }

    .badge {
      display: inline-block;
      min-width: 70px;
      text-align: center;
      font-size: 0.8rem;
      font-weight: 700;
      border-radius: 999px;
      padding: 5px 8px;
      background: #eee;
    }

    .badge.article {
      background: #e8eefc;
    }

    .badge.youtube {
      background: #ffe8e8;
    }

    .orientation {
      color: #666;
      font-size: 0.95rem;
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
  </div>

  <p class="intro">
    Les articles de presse et les vidéos YouTube sont regroupés dans les mêmes sujets.
    L’IA classe ensuite les sujets selon leur potentiel de controverse et de débat.
  </p>

  <div class="status">
    Dernière génération du fichier :
    <strong>${escapeHtml(generatedAt)}</strong>
    <br>
    Presse : dernières <strong>${HOURS_BACK_ARTICLES} h</strong> —
    YouTube : dernières <strong>${HOURS_BACK_YOUTUBE} h</strong>
    <br>
    Mise à jour automatique toutes les
    <strong>${UPDATE_INTERVAL_MINUTES} minutes</strong>.
  </div>

  ${
    sessions.length
      ? sessionBlocks
      : `<div class="empty">Aucune session mixte pour le moment.</div>`
  }
</body>
</html>
`;
}

async function runWatchSession() {
  const startedAt = dayjs();

  console.log("");
  console.log("======================================");
  console.log(`Nouvelle session mixte : ${startedAt.format("DD/MM/YYYY HH:mm:ss")}`);
  console.log("======================================");

  console.log("Collecte des articles...");
  const articles = await collectArticles();

  console.log("Collecte des vidéos YouTube...");
  const videos = await collectYouTubeVideos();

  const contents = [...articles, ...videos];

  console.log(`${articles.length} article(s) récupéré(s).`);
  console.log(`${videos.length} vidéo(s) récupérée(s).`);
  console.log(`${contents.length} contenu(s) au total.`);

  console.log("Regroupement des sujets mixtes...");
  const groups = groupContentsBySubject(contents);

  console.log(`${groups.length} groupe(s) détecté(s).`);

  const subjects = filterMultiSourceSubjects(groups);

  console.log(`${subjects.length} sujet(s) repris par plusieurs sources.`);

  const analyzedSubjects = await analyzeSubjectsWithAI(subjects);

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
  console.log(`Prochaine mise à jour mixte dans ${UPDATE_INTERVAL_MINUTES} minutes.`);
}

async function main() {
  await runWatchSession();

  setInterval(async () => {
    try {
      await runWatchSession();
    } catch (error) {
      console.error("Erreur pendant la mise à jour automatique mixte :", error.message);
    }
  }, UPDATE_INTERVAL_MINUTES * 60 * 1000);
}

main();
