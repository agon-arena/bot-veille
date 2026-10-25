// Retry rounds share their delay across all failing sources, rather than sleeping
// after each channel. State is committed with the session, never on a failed fetch.
const RETRY_DELAYS_MS = [30_000, 90_000];

function videoId(link) {
  try {
    const url = new URL(link);
    if (!/(^|\.)youtube\.com$/.test(url.hostname) && url.hostname !== 'youtu.be') return '';
    const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) :
      url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed|v)\/([^/]+)/)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : '';
  } catch { return ''; }
}

function sourceKey(channel) {
  // A renamed source can keep its history; a changed channel/playlist cannot inherit it.
  return channel.rss || channel.url || channel.nom;
}

async function collectWithRecovery(channels, {
  fetchFeed, normalize, previousState = {}, previousContents = [], now = Date.now(),
  hoursBack = 168, retryDelays = RETRY_DELAYS_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  statusOf = error => error.httpStatus,
  onAttempt = () => {}, onFailure = () => {}, isPaused = () => false
}) {
  const minimumDate = now - hoursBack * 3_600_000;
  const isRecent = item => Number.isFinite(Date.parse(item.date)) &&
    Date.parse(item.date) >= minimumDate && Date.parse(item.date) <= now;
  const identity = item => videoId(item.link) || item.link;
  const contents = [];
  const state = {};
  const results = channels.map(channel => {
    const old = previousState[sourceKey(channel)] || {};
    // Bootstrap older sessions which did not store recovery state.
    const cached = old.items || (Object.keys(previousState).length ? [] :
      previousContents.filter(item => item.type === 'youtube' && item.source === channel.nom));
    const items = new Map(cached.filter(isRecent).map(item => [identity(item), { ...item, source: channel.nom }]));
    return { channel, old, items, attempts: 0, error: null, paused: isPaused(channel.nom), fetched: false, kept: 0, skipped: 0 };
  });
  for (let round = 0; round <= retryDelays.length; round++) {
    const pending = results.filter(result => !result.paused && !result.fetched &&
      (round === 0 || [404, 500, 502, 503, 504].includes(statusOf(result.error)) || result.error?.rssErrorKind === 'fetch_failed'));
    if (!pending.length) break;
    if (round) await sleep(retryDelays[round - 1]);
    for (const result of pending) {
      result.attempts++;
      onAttempt(result.channel, result.attempts);
      try {
        const { feed } = await fetchFeed(result.channel);
        if (!Array.isArray(feed?.items)) throw new Error('Réponse RSS sans liste de contenus');
        // /xml/feeds/videos.xml is a static hub document, not an uploads feed.
        if (!feed.items.length && feed.title === 'YouTube video feed') throw new Error('Document statique YouTube sans vidéos');
        for (const item of feed.items) {
          const normalized = normalize(item, result.channel);
          if (!normalized || !isRecent(normalized) || !identity(normalized)) { result.skipped++; continue; }
          result.items.set(identity(normalized), normalized);
          result.kept++;
        }
        result.fetched = true;
        result.error = null;
      } catch (error) { result.error = error; }
    }
  }
  const sources = results.map(result => {
    const { channel, old, items, attempts, fetched, error, paused, kept, skipped } = result;
    const lastSuccessfulAt = fetched ? new Date(now).toISOString() : old.lastSuccessfulAt || null;
    const retained = [...items.values()];
    contents.push(...retained);
    state[sourceKey(channel)] = { lastSuccessfulAt, items: retained };
    if (error) onFailure(channel, error);
    return {
      nom: channel.nom, orientation: channel.orientation || '', rss: channel.rss || channel.url || '',
      statut: fetched ? 'ok' : paused ? 'pause' : 'temporairement inaccessible',
      kept, skipped, available: retained.length, retained: fetched ? Math.max(0, retained.length - kept) : retained.length,
      attempts, lastSuccessfulAt, httpStatus: error ? statusOf(error) || null : null,
      message: fetched ? (attempts > 1 ? `Flux récupéré après ${attempts} tentatives` : '') :
        `${error?.message || 'Source en pause'}. ${retained.length} vidéo(s) récente(s) conservée(s).`
    };
  });
  // Multiple configured playlists/channels can expose the same video.
  return { contents: [...new Map(contents.map(item => [identity(item), item])).values()], report: { sources }, state };
}

module.exports = { videoId, sourceKey, collectWithRecovery };
