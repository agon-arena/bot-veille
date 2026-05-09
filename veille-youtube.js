const fs = require("fs");
const Parser = require("rss-parser");
const stringSimilarity = require("string-similarity");
const dayjs = require("dayjs");

const parser = new Parser();

const CHANNELS_FILE = "youtube-chaines.json";
const OUTPUT_JSON = "veille-youtube.json";
const OUTPUT_HTML = "veille-youtube.html";
const HISTORY_FILE = "sessions-youtube.json";

const HOURS_BACK = 168;
const SIMILARITY_THRESHOLD = 0.52;
const MIN_SHARED_KEYWORDS = 2;
const MIN_DISTINCT_CHANNELS = 2;
const UPDATE_INTERVAL_MINUTES = 30;
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

function getVideoDate(item) {
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
    console.error("Erreur de lecture de l'historique YouTube :", error.message);
    return [];
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(sessions, null, 2), "utf8");
}

async function getRssUrlFromChannel(channel) {
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

async function collectVideos() {
  const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
  const videos = [];

  for (const channel of channels) {
    try {
      console.log(`Lecture de ${channel.nom}...`);

      const rssUrl = await getRssUrlFromChannel(channel);
      const feed = await parser.parseURL(rssUrl);

      for (const item of feed.items || []) {
        const date = getVideoDate(item);

        if (!isRecent(date)) {
          continue;
        }

        const title = item.title || "Sans titre";
        const summary = item.contentSnippet || item.content || item.summary || "";
        const link = item.link || "";
        const videoId = extractYouTubeVideoId(link);

        videos.push({
          channel: channel.nom,
          orientation: channel.orientation || "",
          title,
          link,
          videoId,
          thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
          date: date.toISOString(),
          summary,
          comparableText: cleanText(title)
        });
      }
    } catch (error) {
      console.error(`Erreur avec ${channel.nom}:`, error.message);
    }
  }

  return videos;
}

function groupVideosBySubject(videos) {
  const groups = [];

  for (const video of videos) {
    let bestGroup = null;
    let bestScore = 0;

    for (const group of groups) {
      const score = stringSimilarity.compareTwoStrings(
        video.comparableText,
        group.referenceText
      );

      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    }

    const sharedKeywords = bestGroup
      ? countSharedKeywords(video.title, bestGroup.subject)
      : 0;

    if (
      bestGroup &&
      bestScore >= SIMILARITY_THRESHOLD &&
      sharedKeywords >= MIN_SHARED_KEYWORDS
    ) {
      bestGroup.videos.push(video);

      if (video.comparableText.length > bestGroup.referenceText.length) {
        bestGroup.referenceText = video.comparableText;
      }
    } else {
      groups.push({
        subject: video.title,
        referenceText: video.comparableText,
        videos: [video]
      });
    }
  }

  return groups;
}

function filterMultiChannelSubjects(groups) {
  return groups
    .map(group => {
      const channels = [...new Set(group.videos.map(video => video.channel))];

      return {
        subject: group.subject,
        channels,
        channelCount: channels.length,
        videoCount: group.videos.length,
        videos: group.videos.sort((a, b) => new Date(b.date) - new Date(a.date))
      };
    })
    .filter(group => group.channelCount >= MIN_DISTINCT_CHANNELS)
    .sort((a, b) => {
      if (b.channelCount !== a.channelCount) {
        return b.channelCount - a.channelCount;
      }

      return b.videoCount - a.videoCount;
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
      const videos = subject.videos.map(video => {
        const date = dayjs(video.date).format("DD/MM/YYYY HH:mm");

        return `
          <li class="video-item">
            ${
              video.thumbnail
                ? `<img src="${escapeHtml(video.thumbnail)}" alt="" class="thumb">`
                : ""
            }
            <div>
              <strong>${escapeHtml(video.channel)}</strong>
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
          <h3>${escapeHtml(subject.subject)}</h3>
          <p>
            <strong>${subject.channelCount} chaînes</strong> —
            ${subject.videoCount} vidéo(s)
          </p>
          <p class="channels">${escapeHtml(subject.channels.join(", "))}</p>
          <ul>
            ${videos}
          </ul>
        </section>
      `;
    }).join("");

    const isLatest = index === 0;

    return `
      <section class="session ${isLatest ? "latest" : ""}">
        <div class="session-header">
          <div>
            <h2>${isLatest ? "Dernière mise à jour YouTube" : "Mise à jour YouTube précédente"}</h2>
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
  <title>Veille YouTube</title>
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

    .channels {
      color: #555;
      font-size: 0.95rem;
    }

    ul {
      padding-left: 0;
    }

    .video-item {
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

      .video-item {
        display: block;
      }

      .thumb {
        width: 100%;
        max-width: 100%;
        margin-bottom: 8px;
      }
    }
  </style>
</head>
<body>
  <h1>Veille YouTube</h1>

  <p class="intro">
    Seuls les sujets repris par au moins ${MIN_DISTINCT_CHANNELS} chaînes sont affichés.
    Analyse des vidéos publiées sur les dernières ${HOURS_BACK} heures.
  </p>

  <div class="status">
    Dernière génération du fichier :
    <strong>${escapeHtml(generatedAt)}</strong>
    <br>
    Mise à jour automatique toutes les
    <strong>${UPDATE_INTERVAL_MINUTES} minutes</strong>,
    tant que le service Render reste actif.
  </div>

  ${
    sessions.length
      ? sessionBlocks
      : `<div class="empty">Aucune session YouTube pour le moment.</div>`
  }
</body>
</html>
`;
}

async function runWatchSession() {
  const startedAt = dayjs();

  console.log("");
  console.log("======================================");
  console.log(`Nouvelle session YouTube : ${startedAt.format("DD/MM/YYYY HH:mm:ss")}`);
  console.log("======================================");

  console.log("Collecte des vidéos...");
  const videos = await collectVideos();

  console.log(`${videos.length} vidéo(s) récupérée(s).`);

  console.log("Regroupement des sujets YouTube...");
  const groups = groupVideosBySubject(videos);

  console.log(`${groups.length} groupe(s) détecté(s).`);

  const subjects = filterMultiChannelSubjects(groups);

  console.log(`${subjects.length} sujet(s) repris par plusieurs chaînes.`);

  const session = {
    generatedAt: startedAt.toISOString(),
    generatedAtLabel: startedAt.format("DD/MM/YYYY à HH:mm:ss"),
    videoCount: videos.length,
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
  console.log(`Prochaine mise à jour YouTube dans ${UPDATE_INTERVAL_MINUTES} minutes.`);
}

async function main() {
  await runWatchSession();

  setInterval(async () => {
    try {
      await runWatchSession();
    } catch (error) {
      console.error("Erreur pendant la mise à jour automatique YouTube :", error.message);
    }
  }, UPDATE_INTERVAL_MINUTES * 60 * 1000);
}

main();