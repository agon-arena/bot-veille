"use strict";

const { normalizedText, canonicalUrl } = require("./activity-deduplication");
const DAY = 86400000, HALF_DAY = DAY / 2;
function compact(row) {
  return { ...row, provenances: (row.provenances || []).map(p => ({ id: p.id, source_id: p.source_id, source_record_id: p.source_record_id,
    original_event_url: p.original_event_url, last_seen_at: p.last_seen_at, source: p.source })),
  external_ids: (row.external_ids || []).map(({ system, value }) => ({ system, value })) };
}
function add(index, key, id) { if (!index.has(key)) index.set(key, new Set()); index.get(key).add(id); }
function externalKeys(row) { return (row.external_ids || []).map(e => `${normalizedText(e.system)}\0${String(e.value || "").trim()}`); }
function urls(row) { return (row.provenances || []).map(p => canonicalUrl(p.original_event_url)).filter(Boolean); }

// Per-persist-call ordering, identical to Map insertion order. Only pairs proven
// DISTINCT are omitted: no common title token AND no shared identity, or city
// conflict with no shared identity. compareActivities itself is unchanged.
class TemporalCandidateIndex {
  constructor() { this.rows = new Map(); this.days = new Map(); this.order = 0; this.visited = 0; }
  set(id, row) {
    const old = this.rows.get(id); if (old) this.delete(id);
    const day = Math.floor(Date.parse(row.starts_at) / DAY);
    if (!this.days.has(day)) this.days.set(day, { title: new Map(), identity: new Map(), url: new Map() });
    const bucket = this.days.get(day), city = normalizedText(row.city), tokens = [...new Set(normalizedText(row.title).split(" ").filter(Boolean))];
    const entry = { row, day, time: Date.parse(row.starts_at), rank: old ? old.rank : this.order++, city, tokens, external: externalKeys(row), urls: urls(row) };
    this.rows.set(id, entry);
    for (const token of tokens) { add(bucket.title, JSON.stringify([token, city]), id); add(bucket.title, JSON.stringify([token, "*"]), id); }
    for (const key of entry.external) add(bucket.identity, key, id);
    for (const key of entry.urls) add(bucket.url, key, id);
    return this;
  }
  delete(id) {
    const old = this.rows.get(id); if (!old) return false;
    const bucket = this.days.get(old.day);
    for (const [index, keys] of [[bucket.title, old.tokens.flatMap(t => [JSON.stringify([t, old.city]), JSON.stringify([t, "*"])])], [bucket.identity, old.external], [bucket.url, old.urls]]) {
      for (const key of keys) { const ids = index.get(key); ids?.delete(id); if (!ids?.size) index.delete(key); }
    }
    this.rows.delete(id); return true;
  }
  matches(activity) {
    const time = Date.parse(activity.startsAt), ids = new Set(), city = normalizedText(activity.city);
    const tokens = [...new Set(normalizedText(activity.title).split(" ").filter(Boolean))];
    const external = externalKeys({ external_ids: activity.externalIds }), original = (activity.provenances || []).map(p => canonicalUrl(p.originalEventUrl)).filter(Boolean);
    for (let day = Math.floor((time - HALF_DAY) / DAY); day <= Math.floor((time + HALF_DAY) / DAY); day++) {
      const bucket = this.days.get(day); if (!bucket) continue;
      const collect = set => { if (set) for (const id of set) ids.add(id); };
      for (const token of tokens) for (const c of city ? [city, ""] : ["*"]) collect(bucket.title.get(JSON.stringify([token, c])));
      // New DT semantics can REVIEW a shared location with contradictory city labels.
      // Preserve those candidates too; transport/cache budgets and time bounds stay identical.
      if ((activity.externalIds || []).some(e => e.system === "datatourisme-poi")) for (const token of tokens) {
        for (const id of bucket.title.get(JSON.stringify([token, "*"])) || [])
          if ((this.rows.get(id)?.row.external_ids || []).some(e => e.system === "datatourisme-poi")) ids.add(id);
      }
      for (const key of external) collect(bucket.identity.get(key));
      for (const key of original) collect(bucket.url.get(key));
    }
    this.visited += ids.size;
    return [...ids].map(id => this.rows.get(id)).filter(e => ["active", "review"].includes(e.row.record_status) && Math.abs(e.time - time) <= HALF_DAY)
      .sort((a, b) => a.rank - b.rank).map(e => e.row);
  }
}

// Virtual original Map ordering without rebuilding all cached rows every chunk.
class TemporalCandidateView {
  constructor(cache) { this.cache = cache; this.late = new Map(); this.seen = new Set(); this.known = new Map(); this.min = Infinity; this.max = -Infinity; }
  prepare(min, max, known) { this.min = Date.parse(min); this.max = Date.parse(max); this.known = new Map(known.map(r => [r.id, r])); }
  set(id) {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    const initial = this.known.get(id) || this.cache.rows.get(id)?.row, t = Date.parse(initial?.starts_at);
    if (!initial || !["active", "review"].includes(initial.record_status) || !(t >= this.min && t <= this.max)) this.late.set(id, this.late.size);
  }
  delete(id) { this.cache.invalidate([id]); }
  matches(activity) {
    return this.cache.index.matches(activity).sort((a, b) => {
      const x = this.late.get(a.id), y = this.late.get(b.id);
      if (x !== undefined || y !== undefined) return x === undefined ? -1 : y === undefined ? 1 : x - y;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
}

class TemporalCandidateCache {
  constructor({ maxRows = 100000, maxBytes = 256 * 1048576 } = {}) {
    this.maxRows = maxRows; this.maxBytes = maxBytes; this.clear(); this.stats = { loadedRows: 0, windows: 0, refreshRows: 0, peakRows: 0, peakBytes: 0 };
  }
  clear() { this.rows = new Map(); this.days = new Map(); this.index = new TemporalCandidateIndex(); this.covered = new Set(); this.dirty = new Set(); this.bytes = 0; this.store = null; }
  set(row, dirty = true) {
    row = compact(row); const old = this.rows.get(row.id), day = Math.floor(Date.parse(row.starts_at) / DAY), bytes = Buffer.byteLength(JSON.stringify(row));
    if (this.rows.size + (old ? 0 : 1) > this.maxRows || this.bytes - (old?.bytes || 0) + bytes > this.maxBytes) throw new Error("Budget du cache candidats dépassé : arrêt sûr, aucune éviction/relecture quadratique");
    if (old) this.days.get(old.day)?.delete(row.id);
    if (!this.days.has(day)) this.days.set(day, new Set());
    this.days.get(day).add(row.id); this.rows.set(row.id, { row, day, bytes }); this.bytes += bytes - (old?.bytes || 0);
    this.index.set(row.id, row);
    if (dirty) this.dirty.add(row.id);
    this.stats.peakRows = Math.max(this.stats.peakRows, this.rows.size); this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes);
  }
  invalidate(ids) {
    const days = new Set(ids.map(id => this.rows.get(id)?.day).filter(d => d !== undefined));
    for (const day of days) {
      this.covered.delete(day);
      for (const id of this.days.get(day) || []) { this.bytes -= this.rows.get(id).bytes; this.rows.delete(id); this.index.delete(id); this.dirty.delete(id); }
      this.days.delete(day);
    }
  }
  async load(times, store) {
    // Ownership = the underlying store (a write-behind envelope per persister shares it): the same
    // cache may serve successive persisters of one run, never two different stores/writers.
    const owner = store.candidateCacheNamespace || store;
    if (this.store && this.store !== owner) throw new Error("Un cache candidat appartient à un seul store/writer");
    this.store = owner;
    const needed = new Set();
    for (const t of times) for (let d = Math.floor((t - HALF_DAY) / DAY); d <= Math.floor((t + HALF_DAY) / DAY); d++) needed.add(d);
    const missing = [...needed].filter(d => !this.covered.has(d)).sort((a, b) => a - b), windows = [];
    for (const day of missing) {
      const last = windows.at(-1);
      if (last && last.end === day * DAY) last.end += DAY; else windows.push({ start: day * DAY, end: (day + 1) * DAY });
    }
    if (windows.length) {
      let rows;
      if (store.listCandidateActivitiesInWindows) rows = await store.listCandidateActivitiesInWindows(windows, { maxRows: this.maxRows, maxBytes: this.maxBytes });
      else { rows = []; for (const w of windows) rows.push(...await store.listCandidateActivitiesInRange(new Date(w.start).toISOString(), new Date(w.end - 1).toISOString())); }
      for (const row of rows) this.set(row, false);
      for (const day of missing) this.covered.add(day);
      this.stats.loadedRows += rows.length; this.stats.windows += windows.length;
    }
  }
  async refresh(store) {
    const ids = [...this.dirty]; this.dirty.clear();
    // Authoritative read after writes: last_seen/provenance touches affect merge
    // freshness and must not leak stale snapshots into the NEXT persist call.
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100), rows = await store.getActivitiesBatch(part);
      if (rows.length !== part.length) throw new Error("Rafraîchissement du cache incomplet");
      for (const row of rows) this.set(row, false);
      this.stats.refreshRows += rows.length;
    }
  }
}

module.exports = { TemporalCandidateCache, TemporalCandidateIndex, TemporalCandidateView };
