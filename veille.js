const fs = require("fs");
const Parser = require("rss-parser");
const stringSimilarity = require("string-similarity");
const dayjs = require("dayjs");

const parser = new Parser();

const MEDIA_FILE = "medias.json";
const OUTPUT_JSON = "veille.json";
const OUTPUT_HTML = "veille.html";
const HISTORY_FILE = "sessions-veille.json";

const HOURS_BACK = 24;
const SIMILARITY_THRESHOLD = 0.58;
const MIN_SHARED_KEYWORDS = 2;
const MIN_DISTINCT_MEDIAS = 2;

// Mise à jour automatique toutes les 30 minutes
const UPDATE_INTERVAL_MINUTES = 30;

// Nombre maximum de sessions gardées dans veille.html
const MAX_SESSIONS_TO_KEEP = 20;

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
        articles: group.articles.sort((a, b) => new Date(b.date) - new Date(a.date))
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
      const articles = subject.articles.map(article => {
        const date = dayjs(article.date).format("DD/MM/YYYY HH:mm");

        return `
          <li>
            <strong>${escapeHtml(article.media)}</strong> —
            <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">
              ${escapeHtml(article.title)}
            </a>
            <br>
            <small>Publié le ${escapeHtml(date)}</small>
          </li>
        `;
      }).join("");

      return `
        <section class="subject">
          <h3>${escapeHtml(subject.subject)}</h3>
          <p>
            <strong>${subject.mediaCount} médias</strong> —
            ${subject.articleCount} article(s)
          </p>
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
      margin-top: 0;
      font-size: 1.2rem;
    }

    .medias {
      color: #555;
      font-size: 0.95rem;
    }

    li {
      margin-bottom: 12px;
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
  <h1>Veille médias</h1>

  <p class="intro">
    Seuls les sujets repris par au moins ${MIN_DISTINCT_MEDIAS} médias sont affichés.
    Analyse des articles publiés sur les dernières ${HOURS_BACK} heures.
  </p>

  <div class="status">
    Dernière génération du fichier :
    <strong>${escapeHtml(generatedAt)}</strong>
    <br>
    Mise à jour automatique toutes les
    <strong>${UPDATE_INTERVAL_MINUTES} minutes</strong>,
    tant que le bot reste lancé dans le Terminal.
  </div>

  ${
    sessions.length
      ? sessionBlocks
      : `<div class="empty">Aucune session de veille pour le moment.</div>`
  }
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

  const session = {
    generatedAt: startedAt.toISOString(),
    generatedAtLabel: startedAt.format("DD/MM/YYYY à HH:mm:ss"),
    articleCount: articles.length,
    groupCount: groups.length,
    subjectCount: subjects.length,
    subjects
  };

  const sessions = loadSessions();

  sessions.unshift(session);

  const limitedSessions = sessions.slice(0, MAX_SESSIONS_TO_KEEP);

  saveSessions(limitedSessions);

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(subjects, null, 2), "utf8");
  fs.writeFileSync(OUTPUT_HTML, generateHtml(limitedSessions), "utf8");

  console.log(`Fichier généré : ${OUTPUT_HTML}`);
  console.log(`Historique généré : ${HISTORY_FILE}`);
  console.log(`Prochaine mise à jour dans ${UPDATE_INTERVAL_MINUTES} minutes.`);
}

async function main() {
  await runWatchSession();

  setInterval(async () => {
    try {
      await runWatchSession();
    } catch (error) {
      console.error("Erreur pendant la mise à jour automatique :", error.message);
    }
  }, UPDATE_INTERVAL_MINUTES * 60 * 1000);
}

main();