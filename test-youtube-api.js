const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectApi, createApi, loadStore, saveStore, deliveryItems, acknowledge, consumeQuota, canonicalLink } = require('./youtube-api');
const now = Date.parse('2026-10-28T10:00:00Z');
const day = 86400000;
const channel = { nom: 'Chaîne', rss: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc' };
const playlist = { nom: 'Playlist', rss: 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLabc' };
const empty = () => ({ version: 1, sources: {}, videos: {} });
const entry = (id, age = 1) => ({ snippet: { title: id, description: 'Description' },
  contentDetails: { videoId: id, videoPublishedAt: new Date(now - age * day).toISOString() } });
const id1 = '71vqiiZzAV0', id2 = 'qusFby7PnJ0';
function stub(pages, calls = []) {
  return async (endpoint, params) => {
    calls.push({ endpoint, ...params });
    if (endpoint === 'channels') return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUabc' } } }] };
    const page = pages[params.pageToken || 'first'];
    if (page instanceof Error) throw page;
    assert.ok(page, `Unexpected page ${params.pageToken}`);
    return page;
  };
}

test('uploads are paginated beyond first 50 and cross-source duplicates share a durable identity', async () => {
  const store = empty(), calls = [];
  await collectApi([channel, playlist], { store, now, api: stub({
    first: { items: [entry(id1)], nextPageToken: 'next' }, next: { items: [entry(id2)] }
  }, calls) });
  assert.equal(Object.keys(store.videos).length, 2);
  assert.equal(store.videos[id1].sourceKeys.length, 2);
  assert.equal(calls.filter(x => x.endpoint === 'playlistItems').length, 4);
  assert.ok(calls.filter(x => x.endpoint === 'playlistItems').every(x => x.maxResults === 50));
});

test('failed second page retains videos and resumes the exact cursor, without marking success', async () => {
  const store = empty(), snapshots = [];
  await collectApi([channel], { store, now, api: stub({ first: { items: [entry(id1)], nextPageToken: 'next' },
    next: new Error('offline') }), persist: state => snapshots.push(JSON.parse(JSON.stringify(state))) });
  const state = store.sources[channel.rss];
  assert.equal(state.lastSuccessfulAt, undefined);
  assert.equal(state.nextPageToken, 'next');
  assert.ok(snapshots[0].videos[id1]);
  const calls = [];
  await collectApi([channel], { store, now: now + day, api: stub({ next: { items: [entry(id2, 0)] } }, calls) });
  assert.equal(calls[0].pageToken, 'next');
  assert.equal(Object.keys(store.videos).length, 2);
  assert.equal(state.nextPageToken, 'next'); // old snapshot wasn't mutated by replacement
  assert.equal(store.sources[channel.rss].nextPageToken, undefined);
  assert.ok(store.sources[channel.rss].lastSuccessfulAt);
});

test('page budget resumes on next cycle instead of declaring truncated catch-up successful', async () => {
  const store = empty();
  await collectApi([channel], { store, now, maxPages: 1,
    api: stub({ first: { items: [entry(id1)], nextPageToken: 'next' } }) });
  assert.equal(store.report[0].statut, 'rattrapage en cours');
  assert.equal(store.sources[channel.rss].lastSuccessfulAt, undefined);
  await collectApi([channel], { store, now, api: stub({ next: { items: [entry(id2)] } }) });
  assert.equal(store.report[0].statut, 'ok');
});

test('custom playlist scans past old videos to find recent videos on later pages', async () => {
  const store = empty();
  await collectApi([playlist], { store, now, api: stub({ first: { items: [entry(id1, 400)], nextPageToken: 'next' },
    next: { items: [entry(id2)] } }) });
  assert.equal(store.videos[id1], undefined);
  assert.ok(store.videos[id2]);
});

test('hourly polls are shallow for playlists and daily reconciliation traverses all pages', async () => {
  const store = empty();
  await collectApi([playlist], { store, now, api: stub({ first: { items: [entry(id1)] } }) });
  const calls = [];
  await collectApi([playlist], { store, now: now + 3600000, api: stub({ first: { items: [entry(id1)], nextPageToken: 'next' } }, calls) });
  assert.equal(calls.length, 1);
  assert.equal(store.sources[playlist.rss].lastSuccessfulAt, new Date(now).toISOString());
  await collectApi([playlist], { store, now: now + day, api: stub({ first: { items: [entry(id1)], nextPageToken: 'next' },
    next: { items: [entry(id2, 0)] } }) });
  assert.ok(store.videos[id2]);
});

test('long outage never expands collection beyond 24 hours', async () => {
  const store = empty();
  store.sources[channel.rss] = { playlistId: 'UUabc', lastSuccessfulAt: new Date(now - 60 * day).toISOString() };
  await collectApi([channel], { store, now, api: stub({ first: { items: [entry(id1, 45)] } }) });
  assert.equal(store.videos[id1], undefined);
});

test('pending videos never expire; confirmed videos remain deliverable after a session purge for 24 hours', async () => {
  const store = empty();
  await collectApi([channel], { store, now, api: stub({ first: { items: [entry(id1)] } }) });
  assert.equal(deliveryItems(store, { now: now + 90 * day }).length, 1);
  acknowledge(store, [{ link: `https://www.youtube.com/watch?v=${id1}` }], 'session-1', now);
  assert.equal(store.videos[id1].status, 'sent');
  assert.equal(deliveryItems(store, { now }).length, 1);
  assert.equal(deliveryItems(store, { now: now + 90 * day }).length, 0);
  assert.equal(deliveryItems(store, { now, publishedLinks: new Set([store.videos[id1].link]) }).length, 0);
});

test('quota exhaustion stops requests to all later sources without clearing pending videos', async () => {
  const store = empty();
  const error = Object.assign(new Error('quota'), { quota: true });
  let calls = 0;
  await collectApi([channel, playlist], { store, now, api: async () => { calls++; throw error; } });
  assert.equal(calls, 1);
  assert.equal(store.report[0].statut, 'erreur');
});

test('request retry uses a header secret, and errors never expose the key', async () => {
  let calls = 0;
  const api = createApi({ key: 'super-secret', sleep: async () => {}, fetchImpl: async (url, options) => {
    assert.ok(!String(url).includes('super-secret'));
    assert.equal(options.headers['X-Goog-Api-Key'], 'super-secret');
    calls++;
    if (calls < 3) throw new Error('network super-secret');
    return { ok: true, json: async () => ({ items: [] }) };
  } });
  assert.deepEqual(await api('channels', { id: 'UCabc' }), { items: [] });
  assert.equal(calls, 3);
  const bad = createApi({ key: 'super-secret', sleep: async () => {}, fetchImpl: async () => { throw new Error('super-secret'); } });
  await assert.rejects(bad('channels', {}), error => !error.message.includes('super-secret'));
});

test('API quota errors are not retried', async () => {
  let calls = 0;
  const api = createApi({ key: 'secret', fetchImpl: async () => {
    calls++; return { ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) };
  } });
  await assert.rejects(api('playlistItems', {}), error => error.quota);
  assert.equal(calls, 1);
});

test('quota counter resets at Pacific midnight rather than the server timezone', () => {
  const store = empty();
  consumeQuota(store, Date.parse('2026-10-28T06:59:00Z'), 1);
  assert.throws(() => consumeQuota(store, Date.parse('2026-10-28T06:59:59Z'), 1));
  consumeQuota(store, Date.parse('2026-10-28T07:00:00Z'), 1);
  assert.equal(store.quota.requests, 1);
});

test('state survives restart and corrupt state fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-test-'));
  const file = path.join(dir, 'state.json');
  try {
    const store = empty(); store.videos[id1] = { status: 'pending' };
    saveStore(store, file);
    assert.deepEqual(loadStore(file), store);
    fs.writeFileSync(file, 'broken');
    assert.throws(() => loadStore(file), /préserver/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

// Exercise the actual sender, without starting HTTP servers or publishing live.
const vm = require('node:vm');
const serverSource = fs.readFileSync(require.resolve('./server'), 'utf8');
function senderHarness({ store, session, responseOk = true, published = [], deferred = null }) {
  let requests = [], sent = { sessionKey: null, links: new Set() };
  const context = {
    Date: class extends Date { static now() { return now; } },
    path, __dirname: '/test', process: { env: { YOUTUBE_API_KEY: 'test' } },
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify([session]) },
    getYoutubeApiStore: () => store,
    youtubeApi: { canonicalLink, deliveryItems: (s, options) => deliveryItems(s, { ...options, now }), acknowledge, saveStore: () => {} },
    storageSync: { isRestored: () => true },
    loadSentToAgonItems: () => published, isSentToAgonPublishedItem: x => x.publishStatus !== 'queued',
    cleanSubjectKeyText: text => String(text || '').toLowerCase(),
    loadSentOpinionState: () => sent,
    saveSentOpinionState: (sessionKey, links) => { sent = { sessionKey, links: new Set(links) }; },
    AGON_URL: 'https://agon.test', botAuthHeaders: x => x,
    AbortSignal, setTimeout: fn => fn(), console: { log() {}, warn() {}, error() {} },
    fetch: async (url, opts) => {
      requests.push(JSON.parse(opts.body));
      if (deferred) await deferred;
      return { ok: responseOk, status: responseOk ? 200 : 500 };
    }
  };
  const start = serverSource.indexOf('let opinionPublishPromise = null;');
  const end = serverSource.indexOf('function normalizeSentToAgonKey', start);
  const send = vm.runInNewContext(serverSource.slice(start, end) + '\npublishOpinionItemsToAgon', context);
  return { send, requests };
}
async function deliveryStore() {
  const store = empty();
  await collectApi([channel], { store, now, api: stub({ first: { items: [entry(id1)] } }) });
  return store;
}

test('actual sender delivers queued videos with an empty editorial list, retries failures and re-sends after purge', async () => {
  const store = await deliveryStore();
  const session = { generatedAt: 'session-1', opinionItems: [] };
  const failed = senderHarness({ store, session, responseOk: false });
  await failed.send();
  assert.equal(store.videos[id1].status, 'pending');
  const h = senderHarness({ store, session });
  await h.send(); await h.send();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].sessionKey, 'session-1');
  assert.equal(store.videos[id1].status, 'sent');
  session.generatedAt = 'session-2';
  await h.send();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].sessionKey, 'session-2');
});

test('actual sender preserves session subject exclusion when merging durable queue', async () => {
  const store = await deliveryStore();
  const item = deliveryItems(store, { now })[0];
  const h = senderHarness({ store, session: { generatedAt: 's', opinionItems: [{ ...item, subjectKey: 'debate' }] },
    published: [{ subject: 'debate' }] });
  await h.send();
  assert.equal(h.requests.length, 0);
});

test('actual sender excludes links already used in published debates, but not queued debates', async () => {
  const store = await deliveryStore();
  const link = store.videos[id1].link;
  const session = { generatedAt: 's', opinionItems: [] };
  const h = senderHarness({ store, session, published: [{ subject: 'unrelated', links: [link] }] });
  await h.send(); assert.equal(h.requests.length, 0);
  const queued = senderHarness({ store, session, published: [{ subject: 'unrelated', links: [link], publishStatus: 'queued' }] });
  await queued.send(); assert.equal(queued.requests.length, 1);
});

test('actual sender serializes overlapping hourly and manual publication', async () => {
  const store = await deliveryStore();
  let release;
  const deferred = new Promise(resolve => { release = resolve; });
  const h = senderHarness({ store, session: { generatedAt: 's', opinionItems: [] }, deferred });
  const first = h.send(), second = h.send();
  assert.equal(first, second);
  release(); await Promise.all([first, second]);
  assert.equal(h.requests.length, 1);
});


test('actual sender merges Shorts and watch links into one canonical video', async () => {
  const store = await deliveryStore();
  const item = deliveryItems(store, { now })[0];
  const h = senderHarness({ store, session: { generatedAt: 's', opinionItems: [
    { ...item, link: `https://www.youtube.com/shorts/${id1}` }
  ] } });
  await h.send();
  assert.equal(h.requests[0].items.length, 1);
  assert.equal(h.requests[0].items[0].link, item.link);
});


test('first collection ignores videos older than 24 hours', async () => {
  const store = empty();
  await collectApi([channel], { store, now, api: stub({ first: { items: [entry(id1, 0.5), entry(id2, 2)] } }) });
  assert.ok(store.videos[id1]);
  assert.equal(store.videos[id2], undefined);
});

test('old saved catch-up cutoff cannot import videos older than 24 hours', async () => {
  const store = empty();
  store.sources[channel.rss] = { playlistId: 'UUabc', nextPageToken: 'next',
    scanCutoff: new Date(now - 30 * day).toISOString(), scanDeep: true };
  await collectApi([channel], { store, now, api: stub({ next: { items: [entry(id1, 2), entry(id2, 0.5)] } }) });
  assert.equal(store.videos[id1], undefined);
  assert.ok(store.videos[id2]);
});

test('confirmed videos older than 24 hours are not re-sent in another session', async () => {
  const store = await deliveryStore();
  acknowledge(store, [{ link: store.videos[id1].link }], 'previous', now);
  assert.equal(deliveryItems(store, { now: now + 1 }).length, 0);
});

test('old session videos are not reintroduced by the editorial list', async () => {
  const store = empty();
  const h = senderHarness({ store, session: { generatedAt: 's', opinionItems: [{
    type: 'youtube', title: 'Old video', date: new Date(now - 2 * day).toISOString(),
    link: `https://www.youtube.com/watch?v=${id1}`
  }] } });
  await h.send();
  assert.equal(h.requests.length, 0);
});
