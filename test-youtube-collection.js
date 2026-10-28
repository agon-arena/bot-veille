const test = require('node:test');
const assert = require('node:assert/strict');
const { collectWithRecovery, videoId, sourceKey } = require('./youtube-collection');
const now = Date.parse('2026-10-22T06:00:00Z');
const channel = { nom: 'Glupatate', rss: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCE38FJeWDQ-ViY6buSKWoJg' };
const item = (id, age = 1) => ({ type: 'youtube', source: channel.nom, title: id,
  link: `https://www.youtube.com/watch?v=${id}`, date: new Date(now - age * 86400000).toISOString() });
const error = httpStatus => Object.assign(new Error(`HTTP ${httpStatus}`), { httpStatus });
const options = { now, normalize: x => x, sleep: async () => {} };

test('Shorts, watch and short URLs share a video identity', () => {
  for (const url of ['https://www.youtube.com/shorts/71vqiiZzAV0', 'https://www.youtube.com/watch?v=71vqiiZzAV0', 'https://youtu.be/71vqiiZzAV0']) assert.equal(videoId(url), '71vqiiZzAV0');
  assert.equal(videoId('https://example.com/shorts/71vqiiZzAV0'), '');
});

test('intermittent 404 recovers and delays are shared between sources', async () => {
  const calls = {}, delays = [];
  const result = await collectWithRecovery([channel, { ...channel, nom: 'Blast', rss: 'blast' }], {
    ...options, sleep: async ms => delays.push(ms),
    fetchFeed: async c => { calls[c.nom] = (calls[c.nom] || 0) + 1; if (calls[c.nom] < 3) throw error(404); return { feed: { items: [item('71vqiiZzAV0')] } }; }
  });
  assert.deepEqual(delays, [30000, 90000]);
  assert.deepEqual(Object.values(calls), [3, 3]);
  assert.equal(result.contents.length, 1);
  assert.ok(result.report.sources.every(s => s.statut === 'ok' && s.attempts === 3));
});

test('failure preserves last success and recent videos, recovery catches missed dates', async () => {
  const key = sourceKey(channel), lastSuccessfulAt = '2026-10-18T06:00:00Z';
  const previousState = { [key]: { lastSuccessfulAt, items: [item('71vqiiZzAV0', 4), item('qusFby7PnJ0', 9)] } };
  const failed = await collectWithRecovery([channel], { ...options, previousState, fetchFeed: async () => { throw error(404); } });
  assert.equal(failed.state[key].lastSuccessfulAt, lastSuccessfulAt);
  assert.equal(failed.contents.length, 1);
  assert.equal(failed.report.sources[0].retained, 1);
  const recovered = await collectWithRecovery([channel], { ...options,
    previousState: JSON.parse(JSON.stringify(failed.state)),
    fetchFeed: async () => ({ feed: { items: [item('qusFby7PnJ0', 2)] } }) });
  assert.equal(recovered.contents.length, 2);
  assert.equal(recovered.state[key].lastSuccessfulAt, new Date(now).toISOString());
});

test('403 and 429 are never retried, even when another channel retries', async () => {
  const calls = {};
  await collectWithRecovery([channel, { nom: 'limited', rss: 'limited' }, { nom: 'retry', rss: 'retry' }], {
    ...options, fetchFeed: async c => { calls[c.nom] = (calls[c.nom] || 0) + 1; throw error(c.nom === 'limited' ? 429 : c.nom === 'retry' ? 503 : 403); }
  });
  assert.deepEqual(calls, { Glupatate: 1, limited: 1, retry: 3 });
});

test('old session bootstraps cache and paused source retains contents', async () => {
  const result = await collectWithRecovery([channel], { ...options, previousContents: [item('71vqiiZzAV0')],
    isPaused: () => true, fetchFeed: async () => { throw new Error('should not fetch'); } });
  assert.equal(result.contents.length, 1);
  assert.equal(result.report.sources[0].attempts, 0);
  assert.equal(result.report.sources[0].statut, 'pause');
});

test('same video in watch and Shorts format is not duplicated across sessions', async () => {
  const previousState = { [sourceKey(channel)]: { items: [item('71vqiiZzAV0')] } };
  const short = { ...item('71vqiiZzAV0'), link: 'https://www.youtube.com/shorts/71vqiiZzAV0' };
  const result = await collectWithRecovery([channel], { ...options, previousState,
    fetchFeed: async () => ({ feed: { items: [short, item('qusFby7PnJ0', 8), { link: 'bad', date: 'invalid' }] } }) });
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].link, short.link);
});

test('static hub document is not mistaken for a healthy uploads feed', async () => {
  const result = await collectWithRecovery([channel], { ...options, fetchFeed: async () => ({ feed: { title: 'YouTube video feed', items: [] } }) });
  assert.equal(result.report.sources[0].statut, 'temporairement inaccessible');
  assert.equal(result.state[sourceKey(channel)].lastSuccessfulAt, null);
});

test('changed channel does not inherit another source cache', async () => {
  const result = await collectWithRecovery([{ ...channel, rss: 'changed' }], { ...options,
    previousState: { [sourceKey(channel)]: { items: [item('71vqiiZzAV0')] } },
    previousContents: [item('71vqiiZzAV0')], fetchFeed: async () => { throw error(404); } });
  assert.equal(result.contents.length, 0);
});

// Exercise actual app helpers without starting its HTTP server or AI clients.
const vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync(require.resolve('./veille-mixte'), 'utf8');
function appFunction(name, next, context) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(next, start);
  return vm.runInNewContext(source.slice(start, end) + `\n${name}`, context);
}
test('playlist error preserves original HTTP error without channel lookup', async () => {
  const original = error(404);
  const fn = appFunction('getWorkingYouTubeRssUrl', 'function extractYouTubeVideoId', {
    URL, collectionDiagnostics: { youtubeRssFetched: 0 },
    fetchFeedWithFallback: async () => { throw original; },
    getRssUrlFromYouTubeChannel: () => { throw new Error('unexpected channel lookup'); }
  });
  await assert.rejects(fn({ nom: 'playlist', url: 'https://www.youtube.com/playlist?list=PL123', rss: 'https://www.youtube.com/feeds/videos.xml?playlist_id=PL123' }), e => e === original);
});
test('YouTube 404 diagnostic stays temporary and other RSS 404 stays unchanged', async () => {
  const fn = appFunction('fetchFeedWithFallback', 'function cleanText', {
    FEED_TIMEOUT_MS: 15000, parseFeedWithTimeout: async () => { throw error(404); }, extractHttpStatus: e => e.httpStatus,
    createFeedError: (label, message, props) => Object.assign(new Error(message), props)
  });
  await assert.rejects(fn(channel.rss, 'YouTube'), /temporairement inaccessible/);
  await assert.rejects(fn('https://example.com/rss', 'RSS'), /URL RSS à remplacer/);
});

test('app collector catches up a six-hour-old Short within the 24-hour window', async () => {
  const dayjs = require('dayjs');
  const date = new Date(Date.now() - 6 * 3600000).toISOString();
  const fn = appFunction('collectYouTubeVideos', 'function groupContentsBySubject', {
    fs: { readFileSync: () => JSON.stringify([channel]) },
    CHANNELS_FILE: 'youtube-chaines.json', HISTORY_FILE: 'sessions-mixte.json', HOURS_BACK_YOUTUBE: 24,
    loadSessions: () => [{ generatedAt: new Date().toISOString() }],
    collectWithRecovery, isSourcePaused: () => false, extractHttpStatus: e => e.httpStatus,
    setProgress: () => {}, console: { log: () => {} }, dayjs,
    registerRssError: () => {}, pauseSource: () => {}, isRoundupTitle: () => false,
    stripHtmlAndDecodeEntities: x => x, cleanText: x => x.toLowerCase(), extractYouTubeVideoId: videoId,
    getWorkingYouTubeRssUrl: async () => ({ feed: { items: [
      { title: 'Short à rattraper', isoDate: date, link: 'https://www.youtube.com/shorts/71vqiiZzAV0' },
      { title: 'Sans date', link: 'https://www.youtube.com/watch?v=qusFby7PnJ0' }
    ] } })
  });
  const result = await fn(new Date(), new Set(['Glupatate']));
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].date, date);
  assert.equal(result.contents[0].thumbnail, 'https://i.ytimg.com/vi/71vqiiZzAV0/hqdefault.jpg');
  assert.ok(result.state[sourceKey(channel)].lastSuccessfulAt);
});
