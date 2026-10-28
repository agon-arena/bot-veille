// Public uploads and configured playlists. No OAuth, search endpoint or RSS window.
const fs = require('node:fs');
const path = require('node:path');
const { videoId, sourceKey } = require('./youtube-collection');
const DAY = 86400000;
const STORE_FILE = path.join(__dirname, 'youtube-api-state.json');

function loadStore(file = STORE_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !data.sources || !data.videos) throw new Error('format invalide');
    return data;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('État YouTube illisible : collecte arrêtée pour préserver la mémoire');
    return { version: 1, sources: {}, videos: {} };
  }
}
function saveStore(store, file = STORE_FILE) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function createApi({ key, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), onRequest = () => {} }) {
  return async (endpoint, params) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      onRequest();
      let response, data;
      try {
        const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
        // Keep the secret out of URLs, errors and request logs.
        response = await fetchImpl(url, { headers: { 'X-Goog-Api-Key': key }, signal: AbortSignal.timeout(20000) });
        data = await response.json();
      } catch {
        if (attempt < 2) { await sleep(1000 * 2 ** attempt); continue; }
        throw new Error('YouTube API : connexion ou réponse invalide');
      }
      if (response.ok) {
        if (!Array.isArray(data.items)) throw new Error('YouTube API : liste absente');
        return data;
      }
      const reason = data?.error?.errors?.[0]?.reason || 'unknown';
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await sleep(1000 * 2 ** attempt); continue;
      }
      throw Object.assign(new Error(`YouTube API HTTP ${response.status} (${reason})`), {
        status: response.status, reason, quota: ['quotaExceeded', 'dailyLimitExceeded'].includes(reason)
      });
    }
  };
}

async function resolvePlaylist(channel, old, api) {
  const url = new URL(channel.rss || channel.url);
  const playlist = url.searchParams.get('playlist_id') || url.searchParams.get('list');
  if (playlist) return { playlistId: playlist, customPlaylist: true };
  if (old.playlistId) return { playlistId: old.playlistId, customPlaylist: false };
  const id = url.searchParams.get('channel_id') || url.pathname.match(/\/channel\/(UC[\w-]+)/)?.[1];
  const handle = url.pathname.match(/\/@([^/]+)/)?.[1];
  if (!id && !handle) throw new Error('Identifiant de chaîne ou playlist absent');
  const data = await api('channels', { part: 'contentDetails', ...(id ? { id } : { forHandle: handle }) });
  const playlistId = data.items[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error('Chaîne introuvable ou liste de publications absente');
  return { playlistId, customPlaylist: false };
}

// One process owns this file (server.js). Save after EACH page, including an
// unfinished catch-up, before advancing any successful-source checkpoint.
async function collectApi(channels, { store, api, now = Date.now(), persist = () => {}, maxPages = 25 }) {
  const report = [];
  for (const channel of channels) {
    const key = sourceKey(channel);
    const old = store.sources[key] || {};
    try {
      const resolved = await resolvePlaylist(channel, old, api);
      const source = store.sources[key] = { ...old, ...resolved, nom: channel.nom };
      const deepScan = source.nextPageToken ? source.scanDeep !== false :
        (!source.lastFullScanAt || now - Date.parse(source.lastFullScanAt) >= DAY);
      // A resumed scan must also respect the current 24-hour window.
      const cutoff = new Date(now - DAY).toISOString();
      let token = source.nextPageToken || '';
      let completed = false, pages = 0, discovered = 0;
      // Custom playlists aren't ordered by publication date: always traverse all
      // pages. Uploads lists can stop once an entire page predates the overlap.
      while (pages < maxPages) {
        let data;
        try {
          data = await api('playlistItems', { part: 'snippet,contentDetails', playlistId: source.playlistId,
            maxResults: 50, ...(token ? { pageToken: token } : {}) });
        } catch (error) {
          if (error.reason === 'invalidPageToken') { delete source.nextPageToken; delete source.scanCutoff; delete source.scanDeep; }
          throw error;
        }
        pages++;
        let allOlder = data.items.length > 0;
        for (const entry of data.items) {
          const id = entry.contentDetails?.videoId;
          const snippet = entry.snippet || {};
          const date = entry.contentDetails?.videoPublishedAt;
          if (!id || !Number.isFinite(Date.parse(date))) { allOlder = false; continue; }
          if (Date.parse(date) >= Date.parse(cutoff)) allOlder = false;
          if (Date.parse(date) < Date.parse(cutoff) || Date.parse(date) > now) continue;
          const existing = store.videos[id];
          if (!existing) discovered++;
          store.videos[id] = {
            ...existing, id, type: 'youtube', source: existing?.source || channel.nom,
            orientation: existing?.orientation || channel.orientation || '',
            title: snippet.title || 'Sans titre', summary: (snippet.description || '').slice(0, 1500),
            link: `https://www.youtube.com/watch?v=${id}`, date,
            thumbnail: snippet.thumbnails?.high?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            discoveredAt: existing?.discoveredAt || new Date(now).toISOString(),
            sourceKeys: [...new Set([...(existing?.sourceKeys || []), key])],
            status: existing?.status || 'pending'
          };
        }
        token = data.nextPageToken || '';
        completed = !token || (!source.customPlaylist && allOlder) || (source.customPlaylist && !deepScan);
        source.lastPolledAt = new Date(now).toISOString();
        if (completed) {
          // A first-page playlist poll is not proof that the whole list was read.
          if (!source.customPlaylist || deepScan) source.lastSuccessfulAt = new Date(now).toISOString();
          if (deepScan) source.lastFullScanAt = new Date(now).toISOString();
          delete source.nextPageToken; delete source.scanCutoff; delete source.scanDeep;
        } else {
          source.nextPageToken = token; source.scanCutoff = cutoff; source.scanDeep = deepScan;
        }
        source.lastError = null;
        persist(store);
        if (completed) break;
      }
      report.push({ nom: channel.nom, statut: completed ? 'ok' : 'rattrapage en cours', pages, discovered,
        lastSuccessfulAt: source.lastSuccessfulAt || null });
    } catch (error) {
      store.sources[key] = { ...(store.sources[key] || old), nom: channel.nom,
        lastError: error.message, lastAttemptAt: new Date(now).toISOString() };
      persist(store);
      report.push({ nom: channel.nom, statut: 'erreur', message: error.message });
      // A project-wide exhausted quota affects every remaining source.
      if (error.quota) break;
    }
  }
  // Keep delivery identities, without retaining years of large descriptions.
  for (const [id, item] of Object.entries(store.videos)) {
    if (item.status === 'sent' && Date.parse(item.date) < now - DAY) {
      store.videos[id] = { id, link: item.link, date: item.date, status: 'sent',
        sentAt: item.sentAt, sentSessionKey: item.sentSessionKey, sourceKeys: item.sourceKeys };
    }
  }
  store.lastRunAt = new Date(now).toISOString();
  store.report = report;
  persist(store);
  return report;
}

function deliveryItems(store, { now = Date.now(), publishedLinks = new Set() } = {}) {
  return Object.values(store.videos).filter(item => !publishedLinks.has(item.link) &&
    (item.status !== 'sent' || Date.parse(item.date) >= now - DAY))
    .map(({ id, status, discoveredAt, sourceKeys, sentAt, sentSessionKey, ...item }) => item);
}
function acknowledge(store, items, sessionKey, now = Date.now()) {
  for (const item of items) {
    const entry = store.videos[videoId(item.link)];
    if (entry) Object.assign(entry, { status: 'sent', sentSessionKey: sessionKey, sentAt: new Date(now).toISOString() });
  }
}

function consumeQuota(store, now = Date.now(), limit = 8000) {
  // YouTube's quota resets at midnight Pacific, including DST changes.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(now));
  if (store.quota?.day !== day) store.quota = { day, requests: 0 };
  if (store.quota.requests >= limit) throw Object.assign(new Error('Budget YouTube journalier atteint ; reprise au prochain jour Pacific'), { quota: true });
  store.quota.requests++;
}

function canonicalLink(link) {
  const id = videoId(link);
  return id ? `https://www.youtube.com/watch?v=${id}` : link;
}

module.exports = { canonicalLink, consumeQuota, STORE_FILE, loadStore, saveStore, createApi, collectApi, deliveryItems, acknowledge };
