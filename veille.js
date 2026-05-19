require("dotenv").config();

const fs = require("fs");
const Parser = require("rss-parser");
const stringSimilarity = require("string-similarity");
const dayjs = require("dayjs");
const OpenAI = require("openai");

const parser = new Parser();

const MEDIA_FILE = "medias.json";
const YOUTUBE_FILE = "youtube-chaines.json";
const OUTPUT_JSON = "veille.json";
const OUTPUT_HTML = "veille.html";
const HISTORY_FILE = "sessions-veille.json";

const HOURS_BACK = 24;
const SIMILARITY_THRESHOLD = 0.58;
const MIN_SHARED_KEYWORDS = 2;
const MIN_DISTINCT_MEDIAS = 2;

const UPDATE_INTERVAL_MINUTES = 720;
const MAX_SESSIONS_TO_KEEP = 20;
const MAX_SUBJECTS_TO_ANALYZE_WITH_AI = 25;

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
    "nouvelle", "nouvelles", "direct", "video", "photos", "actualite",
    "actualites", "france", "monde", "politique", "international", "economie",
    "societe", "sport", "culture"
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

function getArticleDate(item) {
  const rawDate = item.isoDate || item.pubDate || item.date;
  const parsed = dayjs(rawDate);

  if (parsed.isValid()) {
    return parsed;
  }

  return dayjs();
}

function isRecent(date) {
  return date.isAfter(dayjs().subtract(HOURS_BACK, "hour"));
}

function loadSessions() {
  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch (error) {
    console.error("Erreur de lecture de l'historique :", error.message);
    return [];
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(sessions, null, 2), "utf8");
}

async function getRssUrlFromChannel(channel) {
  if (channel.rss) return channel.rss;

  const response = await fetch(channel.url, { headers: { "User-Agent": "Mozilla/5.0" } });

  if (!response.ok) throw new Error(`Impossible d'ouvrir la chaîne YouTube : ${response.status}`);

  const html = await response.text();

  for (const pattern of [
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([^"]+)"/,
    /"channelId":"(UC[^"]+)"/,
    /"externalId":"(UC[^"]+)"/
  ]) {
    const match = html.match(pattern);
    if (match) return `https://www.youtube.com/feeds/videos.xml?channel_id=${match[1]}`;
  }

  throw new Error("Impossible de trouver le channel_id YouTube");
}

async function collectArticles() {
  const medias = JSON.parse(fs.readFileSync(MEDIA_FILE, "utf8"));
  const articles = [];

  for (const media of medias) {
    try {
      console.log(`Lecture de ${media.nom}...`);

      const feed = await parser.parseURL(media.rss);

      for (const item of feed.items || []) {
        const date = getArticleDate(item);

        if (!isRecent(date)) {
          continue;
        }

        const title = item.title || "Sans titre";
        const summary = item.contentSnippet || item.content || item.summary || "";

        articles.push({
          media: media.nom,
          orientation: media.orientation || "",
          type: media.type || "press",
          title,
          link: item.link || "",
          date: date.toISOString(),
          summary,
          comparableText: cleanText(title)
        });
      }
    } catch (error) {
      console.error(`Erreur avec ${media.nom}:`, error.message);
    }
  }

  const channels = JSON.parse(fs.readFileSync(YOUTUBE_FILE, "utf8"));

  for (const channel of channels) {
    try {
      console.log(`YouTube : lecture de ${channel.nom}...`);

      const rssUrl = await getRssUrlFromChannel(channel);
      const feed = await parser.parseURL(rssUrl);

      for (const item of feed.items || []) {
        const date = getArticleDate(item);

        if (!isRecent(date)) continue;

        const title = item.title || "Sans titre";
        const link = item.link || "";
        const videoIdMatch = link.match(/[?&]v=([^&]+)/);
        const videoId = videoIdMatch ? videoIdMatch[1] : "";

        articles.push({
          media: channel.nom,
          orientation: channel.orientation || "",
          type: "youtube",
          title,
          link,
          thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
          date: date.toISOString(),
          summary: item.contentSnippet || item.summary || "",
          comparableText: cleanText(title)
        });
      }
    } catch (error) {
      console.error(`Erreur YouTube avec ${channel.nom}:`, error.message);
    }
  }

  return articles;
}

function groupArticlesBySubject(articles) {
  const groups = [];

  for (const article of articles) {
    let bestGroup = null;
    let bestScore = 0;

    for (const group of groups) {
      const score = stringSimilarity.compareTwoStrings(
        article.comparableText,
        group.referenceText
      );

      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    }

    const sharedKeywords = bestGroup
      ? countSharedKeywords(article.title, bestGroup.subject)
      : 0;

    if (
      bestGroup &&
      bestScore >= SIMILARITY_THRESHOLD &&
      sharedKeywords >= MIN_SHARED_KEYWORDS
    ) {
      bestGroup.articles.push(article);

      if (article.comparableText.length > bestGroup.referenceText.length) {
        bestGroup.referenceText = article.comparableText;
      }
    } else {
      groups.push({
        subject: article.title,
        referenceText: article.comparableText,
        articles: [article]
      });
    }
  }

  return groups;
}

function filterMultiSourceSubjects(groups) {
  return groups
    .map(group => {
      const medias = [...new Set(group.articles.map(article => article.media))];

      return {
        subject: group.subject,
        medias,
        mediaCount: medias.length,
        articleCount: group.articles.length,
        articles: group.articles.sort((a, b) => {
          const order = { left: 0, center: 1, right: 2 };
          const oA = order[getOrientationGroup(a.orientation)] ?? 1;
          const oB = order[getOrientationGroup(b.orientation)] ?? 1;
          if (oA !== oB) return oA - oB;
          return new Date(b.date) - new Date(a.date);
        })
      };
    })
    .filter(group => group.mediaCount >= MIN_DISTINCT_MEDIAS)
    .sort((a, b) => {
      if (b.mediaCount !== a.mediaCount) {
        return b.mediaCount - a.mediaCount;
      }

      return b.articleCount - a.articleCount;
    });
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

function fallbackAiAnalysis(subject) {
  const leftSourceCount = (subject.articles || []).filter(a => getOrientationGroup(a.orientation) === "left").length;
  return {
    debateScore: subject.mediaCount >= 4 ? 6 : 4,
    controversyLevel: subject.mediaCount >= 4 ? "moyen" : "faible",
    debateQuestion: `Ce sujet mérite-t-il un débat public : ${subject.subject} ?`,
    resume: "",
    agonTheme: AGON_THEMES[0],
    positionA: "",
    positionB: "",
    leftScore: Math.min(10, 3 + leftSourceCount * 2)
  };
}

async function analyzeOneSubjectWithAI(subject) {
  if (!openai) {
    return fallbackAiAnalysis(subject);
  }

  const compactArticles = subject.articles.slice(0, 10).map(article => ({
    media: article.media,
    title: article.title
  }));

  const prompt = `
Analyse ce sujet de veille presse et évalue son potentiel de débat public.

Sujet principal :
${subject.subject}

Médias :
${subject.medias.join(", ")}

Articles :
${JSON.stringify(compactArticles, null, 2)}

Tu dois répondre uniquement en JSON valide avec ces champs :
{
  "debateScore": nombre entier de 0 à 10,
  "controversyLevel": "faible" | "moyen" | "fort" | "très fort",
  "debateQuestion": "si debateScore >= 7 : question très clivante, provocatrice, qui force à choisir un camp. Si debateScore < 7 : question neutre et ouverte. 90 caractères maximum.",
  "resume": "si debateScore >= 7 : résumé factuel de l'actualité en 2 ou 3 phrases (ce qui s'est passé, le contexte, les acteurs). Sinon : chaîne vide",
  "agonTheme": "une thématique Agôn exacte",
  "positionA": "position favorable courte si debateScore >= 7, sinon chaîne vide. 90 caractères maximum.",
  "positionB": "position opposée courte si debateScore >= 7, sinon chaîne vide. 90 caractères maximum.",
  "leftScore": nombre entier de 0 à 10 indiquant l'intérêt du sujet pour un public de gauche progressiste
}

Critères pour leftScore (INDÉPENDANT du debateScore — un sujet peut avoir un leftScore élevé même si son debateScore est faible) :
- 8 à 10 : sujet central pour la gauche (droits sociaux, inégalités, écologie, services publics, droits des travailleur·ses, libertés publiques, lutte contre les discriminations, annonce de politique sociale, rapport sur les inégalités, actualité syndicale ou climatique)
- 5 à 7 : sujet d'intérêt général avec une dimension sociale ou politique pertinente
- 0 à 4 : sujet peu pertinent pour un public de gauche (fait divers apolitique, résultat sportif, annonce culturelle neutre)

Critères pour debateScore :
- 0 à 3 : sujet informatif, peu clivant
- 4 à 6 : sujet débattable mais pas explosif
- 7 à 8 : sujet controversé, bon potentiel de débat
- 9 à 10 : sujet très clivant, fort potentiel de réactions
Favorise les sujets politiques, sociaux, économiques, éducatifs, écologiques, internationaux ou liés aux libertés publiques.
Pénalise les simples faits divers non politiques, résultats sportifs, annonces culturelles ou sujets purement descriptifs.

Pour le champ "agonTheme", tu dois choisir uniquement une valeur exacte dans cette liste :
${AGON_THEMES.map(theme => `- ${theme}`).join("\n")}

Ne crée jamais une autre thématique.

Pour les champs "positionA" et "positionB" :
- si debateScore est inférieur à 7, renvoie "" pour les deux champs ;
- si debateScore est supérieur ou égal à 7, propose deux positions tranchées, affirmées, provocatrices, directement opposées l'une à l'autre, utilisables dans une arène à positions ;
- positionA défend une réponse clairement affirmative ou favorable à la question, sans nuance ;
- positionB défend une réponse clairement négative ou opposée à la question, sans nuance ;
- les deux positions doivent incarner deux camps irréconciliables, pas deux nuances du même avis ;
- si debateScore >= 7, la question de débat doit être très clivante : formulée de façon tranchée, provocatrice, qui oblige à choisir un camp. Elle ne doit pas être neutre ou ouverte ;
- si debateScore < 7, la question peut être neutre et descriptive ;

IMPORTANT sur le cadrage politique :
- La question de débat doit être formulée avec un cadrage progressiste, de gauche, favorable aux droits sociaux, à la justice sociale, à l'écologie et aux libertés publiques.
- positionA doit incarner la position de gauche (favorable au progrès social, à l'intervention publique, aux droits des travailleurs, à la transition écologique).
- positionB doit incarner la position adverse (libérale, conservatrice ou de droite).
- Le choix des mots dans la question ne doit jamais reprendre le cadrage lexical de la droite ou de l'extrême droite (ex : éviter "assistanat", "communautarisme", "ensauvagement", etc.).
- Favorise les questions qui mettent en lumière les inégalités, les rapports de pouvoir, les enjeux climatiques et les droits des minorités.
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

    return {
      debateScore: Number.isInteger(parsed.debateScore) ? parsed.debateScore : 0,
      controversyLevel: parsed.controversyLevel || "faible",
      debateQuestion: limitText(parsed.debateQuestion || `Faut-il débattre de ce sujet : ${subject.subject} ?`, 90),
      resume: parsed.resume || "",
      agonTheme: normalizeAgonTheme(parsed.agonTheme),
      positionA: parsed.debateScore >= 7 && typeof parsed.positionA === "string"
        ? limitText(parsed.positionA, 90)
        : "",
      positionB: parsed.debateScore >= 7 && typeof parsed.positionB === "string"
        ? limitText(parsed.positionB, 90)
        : "",
      leftScore: Number.isInteger(parsed.leftScore) ? parsed.leftScore : 5
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

    if (b.mediaCount !== a.mediaCount) {
      return b.mediaCount - a.mediaCount;
    }

    return b.articleCount - a.articleCount;
  });
}

function getOrientationGroup(orientation) {
  const o = (orientation || "").toLowerCase();
  if (o.includes("gauche")) return "left";
  if (o.includes("droite") || o.includes("conservateur") || o.includes("souverainiste")) return "right";
  return "center";
}

function selectPreselectedArticles(articles, debateScore) {
  if (debateScore < 7) return new Set();

  const selected = new Set();

  const youtube = articles.find(a => a.type === "youtube");
  if (youtube) selected.add(youtube.link);

  const pressArticles = articles.filter(a => a.type !== "youtube");
  const leftArticle = pressArticles.find(a => getOrientationGroup(a.orientation) === "left");
  const rightArticle = pressArticles.find(a => getOrientationGroup(a.orientation) === "right");

  if (leftArticle) selected.add(leftArticle.link);
  if (rightArticle) selected.add(rightArticle.link);

  if (selected.size < 2) {
    for (const article of pressArticles) {
      if (!selected.has(article.link)) {
        selected.add(article.link);
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

  const sessionBlocks = sessions.map((session, index) => {
    const subjects = session.subjects || [];

    const subjectBlocks = subjects.map(subject => {
      const ai = subject.ai || fallbackAiAnalysis(subject);

      const debateScore = Number(ai.debateScore) || 0;
      const preselected = selectPreselectedArticles(subject.articles, debateScore);

      const articles = subject.articles.map(article => {
        const date = dayjs(article.date).format("DD/MM/YYYY HH:mm");
        const isChecked = preselected.has(article.link);
        const isYoutube = article.type === "youtube";
        const orientationGroup = isYoutube ? "" : getOrientationGroup(article.orientation);
        const tag = isYoutube
          ? `<span class="source-tag youtube">YouTube</span>`
          : `<span class="source-tag ${orientationGroup}">${escapeHtml(article.orientation || "")}</span>`;

        const thumbnail = isYoutube && article.thumbnail
          ? `<a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer"><img class="yt-thumb" src="${escapeHtml(article.thumbnail)}" alt=""></a>`
          : "";

        return `
          <li class="${isChecked ? "preselected" : ""}">
            <label class="article-label">
              <input type="checkbox"${isChecked ? " checked" : ""}>
              <span>
                ${thumbnail}
                <strong>${escapeHtml(article.media)}</strong> ${tag} —
                <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">
                  ${escapeHtml(article.title)}
                </a>
                <br>
                <small>Publié le ${escapeHtml(date)}</small>
              </span>
            </label>
          </li>
        `;
      }).join("");

      return `
        <section class="subject" data-score="${debateScore}" data-medias="${subject.mediaCount}" data-left="${ai.leftScore || 0}">
          <div class="ai-score">
            <div>
              <span class="score-label">Potentiel débat</span>
              <strong>${escapeHtml(ai.debateScore)}/10</strong>
            </div>
            <span class="controversy">${escapeHtml(ai.controversyLevel)}</span>
          </div>

          <h3>${escapeHtml(subject.subject)}</h3>

          <div class="ai-box">
            <p class="debate-question" contenteditable="true" spellcheck="false">${escapeHtml(ai.debateQuestion)}</p>
            ${Number(ai.debateScore) >= 7 && ai.resume ? `<p class="resume">${escapeHtml(ai.resume)}</p>` : ""}
            <p class="agon-theme"><strong>Thématique Agôn proposée :</strong>
              <select class="agon-select">
                ${AGON_THEMES.map(theme => `<option value="${escapeHtml(theme)}"${theme === normalizeAgonTheme(ai.agonTheme) ? " selected" : ""}>${escapeHtml(theme)}</option>`).join("")}
              </select>
            </p>
            ${
              Number(ai.debateScore) >= 7 && (ai.positionA || ai.positionB)
                ? `
                  <div class="positions-box">
                    <p><strong>Positions proposées pour une arène à positions :</strong></p>
                    ${ai.positionA ? `<p><strong>A —</strong> <span class="editable" contenteditable="true" spellcheck="false">${escapeHtml(ai.positionA)}</span></p>` : ""}
                    ${ai.positionB ? `<p><strong>B —</strong> <span class="editable" contenteditable="true" spellcheck="false">${escapeHtml(ai.positionB)}</span></p>` : ""}
                  </div>
                `
                : ""
            }
          </div>

          <div class="subject-stats">
            <span>${subject.mediaCount} médias</span>
            <span>${subject.articleCount} article(s)</span>
          </div>

          <p class="medias">${escapeHtml(subject.medias.join(", "))}</p>
          <ul>
            ${articles}
          </ul>
        </section>
      `;
    }).join("");

    const isLatest = index === 0;

    return `
      <section class="session ${isLatest ? "latest" : ""}">
        <div class="session-header">
          <div>
            <h2>
              ${isLatest ? "Dernière mise à jour" : "Mise à jour précédente"}
            </h2>
            <p>
              Session du <strong>${escapeHtml(session.generatedAtLabel)}</strong>
            </p>
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
  <title>Veille médias</title>
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

    .status {
      background: #111;
      color: white;
      border-radius: 14px;
      padding: 14px 18px;
      margin-bottom: 24px;
    }

    .status strong {
      color: #fff;
    }

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
      font-size: 1.2rem;
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
      font-size: 1.05rem;
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

    .medias {
      color: #555;
      font-size: 0.95rem;
    }

    li {
      margin-bottom: 12px;
    }

    li.preselected {
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

    .yt-thumb {
      display: block;
      width: 160px;
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
    }
  </style>
</head>
<body>
  <nav style="margin-bottom:20px;">
    <a href="/" style="display:inline-block;margin-right:10px;padding:8px 12px;background:white;border:1px solid #ddd;border-radius:999px;text-decoration:none;color:#111;font-size:0.9rem;">Presse seule</a>
    <a href="/youtube" style="display:inline-block;margin-right:10px;padding:8px 12px;background:white;border:1px solid #ddd;border-radius:999px;text-decoration:none;color:#111;font-size:0.9rem;">YouTube seul</a>
    <a href="/mixte" style="display:inline-block;margin-right:10px;padding:8px 12px;background:white;border:1px solid #ddd;border-radius:999px;text-decoration:none;color:#111;font-size:0.9rem;">Veille mixte</a>
    <a href="/mixte#saved" style="display:inline-block;margin-right:10px;padding:8px 12px;background:white;border:1px solid #ddd;border-radius:999px;text-decoration:none;color:#111;font-size:0.9rem;">Sujets enregistrés</a>
    <a href="/admin" style="display:inline-block;margin-right:10px;padding:8px 12px;background:#111;border:1px solid #111;border-radius:999px;text-decoration:none;color:white;font-size:0.9rem;">⚙ Admin</a>
  </nav>

  <h1>Veille médias</h1>

  <p class="intro">
    Seuls les sujets repris par au moins ${MIN_DISTINCT_MEDIAS} médias sont affichés.
    Analyse des articles publiés sur les dernières ${HOURS_BACK} heures.
  </p>

  <div class="status">
    Dernière génération du fichier :
    <strong>${escapeHtml(generatedAt)}</strong>
    <br>
    Mise à jour manuelle uniquement via le bouton.
  </div>

  <div class="filter-bar">
    <button class="filter-btn active" data-sort="score">Sujets clivants</button>
    <button class="filter-btn" data-sort="medias">Sujets majeurs</button>
    <button class="filter-btn" data-sort="left">Sujets avec fort intérêt</button>
  </div>

  ${
    sessions.length
      ? sessionBlocks
      : `<div class="empty">Aucune session de veille pour le moment.</div>`
  }

  <script>
    function applyFilter(sortKey) {
      document.querySelectorAll(".session").forEach(session => {
        const subjects = [...session.querySelectorAll(":scope > .subject")];
        subjects.sort((a, b) => Number(b.dataset[sortKey]) - Number(a.dataset[sortKey]));
        subjects.forEach((s, i) => {
          session.appendChild(s);
          const hide = (sortKey === "medias" && i >= 5) || (sortKey === "left" && i >= 10);
          s.style.display = hide ? "none" : "";
        });
      });
    }

    document.querySelectorAll(".filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        applyFilter(btn.dataset.sort);
      });
    });
  </script>
</body>
</html>
`;
}

async function runWatchSession() {
  const startedAt = dayjs();

  console.log("");
  console.log("======================================");
  console.log(`Nouvelle session : ${startedAt.format("DD/MM/YYYY HH:mm:ss")}`);
  console.log("======================================");

  console.log("Collecte des articles...");
  const articles = await collectArticles();

  console.log(`${articles.length} article(s) récupéré(s).`);

  console.log("Regroupement des sujets...");
  const groups = groupArticlesBySubject(articles);

  console.log(`${groups.length} groupe(s) détecté(s).`);

  const subjects = filterMultiSourceSubjects(groups);

  console.log(`${subjects.length} sujet(s) repris par plusieurs médias.`);

  const analyzedSubjects = await analyzeSubjectsWithAI(subjects);

  const session = {
    generatedAt: startedAt.toISOString(),
    generatedAtLabel: startedAt.format("DD/MM/YYYY à HH:mm:ss"),
    articleCount: articles.length,
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

async function main() {
  await runWatchSession();
}

main();
