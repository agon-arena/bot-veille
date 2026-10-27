"use strict";

const { randomUUID } = require("crypto");
const { REQUIRED_FIELDS, stripApiKeyFromUrl } = require("./connectors/datatourisme");
const { processReceivedPoiBatch } = require("./datatourisme-poi-reconciliation");
const ENDPOINT = "https://api.datatourisme.fr/v1/entertainmentAndEvent";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function nationalUrl(now) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("fields", REQUIRED_FIELDS);
  url.searchParams.set("lang", "fr");
  url.searchParams.set("page_size", "100");
  url.searchParams.set("filters", `takesPlaceAt.endDate[gte]=${now.toISOString().slice(0, 10)}`);
  return url.toString();
}
function nextUrl(value, initial) {
  if (value == null) return null;
  const url = stripApiKeyFromUrl(new URL(value, ENDPOINT)), root = new URL(initial);
  if (url.origin !== root.origin || url.pathname !== root.pathname || url.username || url.password || url.hash) throw new Error("Pagination hors catalogue national");
  for (const key of ["fields", "lang", "page_size", "filters"]) if (url.searchParams.get(key) !== root.searchParams.get(key)) throw new Error("Périmètre national modifié pendant la pagination");
  for (const key of url.searchParams.keys()) if (!["fields", "lang", "page_size", "filters", "page", "cursor", "search_after", "crs"].includes(key)) throw new Error("Paramètre de pagination non reconnu");
  return url.toString();
}

// Explicit read-only transport, never constructed/called by a scheduler here.
function createNationalPageFetcher({ apiKey, request = globalThis.fetch }) {
  if (!apiKey) throw new Error("Clé API explicite obligatoire");
  return async value => {
    const url = stripApiKeyFromUrl(new URL(value));
    if (url.origin + url.pathname !== ENDPOINT || url.username || url.password) throw new Error("Endpoint national invalide");
    const response = await request(url.toString(), { headers: { "X-API-Key": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    if (response.status !== 200) throw new Error(`API DATAtourisme HTTP ${response.status}`);
    return response.json();
  };
}

// Explicit, offline-testable runner. No default fetch, Supabase client, or scheduler.
// Returning COMPLETE does NOT finalize absences. Call finalizeNationalScan separately.
async function runNationalScan({ store, sourceId, fetchPage, processPage, now, scanId = randomUUID(), maxPages = Infinity }) {
  const date = new Date(now);
  if (now == null || !Number.isFinite(+date) || !UUID.test(scanId) || !UUID.test(sourceId)) throw new Error("Scan/instant/source invalide");
  if (typeof fetchPage !== "function" || typeof processPage !== "function") throw new Error("Callbacks explicites requis");
  const initial = nationalUrl(date);
  await store.beginScan({ sourceId, scanId, now: date.toISOString(), initialUrl: initial });
  const stats = { pages: 0, received: 0, invalid: 0, errorCodes: {} };
  let url = initial;
  const visited = new Set();
  let expectedTotal = null;
  try {
    while (url) {
      if (stats.pages >= maxPages || visited.has(url)) throw new Error("Scan tronqué ou pagination cyclique");
      visited.add(url);
      const page = await fetchPage(url);
      if (!page || !Array.isArray(page.objects) || !Number.isInteger(page.meta?.total) || page.meta.total <= 0 || page.objects.length > 100) throw new Error("Page nationale invalide ou vide");
      if (expectedTotal !== null && expectedTotal !== page.meta.total) throw new Error("Total national instable");
      expectedTotal = page.meta.total;
      const next = nextUrl(page.meta.next, initial);
      const ids = page.objects.map(p => p?.uuid?.toLowerCase());
      if (ids.some(id => !UUID.test(id || "")) || new Set(ids).size !== ids.length) throw new Error("Identité de POI absente ou dupliquée");
      if (stats.received + ids.length > expectedTotal || (next === null && stats.received + ids.length !== expectedTotal) || (next !== null && (!ids.length || stats.received + ids.length >= expectedTotal))) throw new Error("Pagination incomplète ou limitée");
      // Raw receipt is durable BEFORE conversion: invalid POIs are present too.
      await store.observePage({ sourceId, scanId, url, nextUrl: next, total: expectedTotal, ids, now: date.toISOString() });
      const result = await processPage(page.objects, { sourceId, scanId, now: date });
      const classified = result?.classified, errors = result?.errors, committed = new Set(result?.committed);
      if (!Array.isArray(classified) || !Array.isArray(errors) || !Array.isArray(result.committed)) throw new Error("Résultat de chunk absent");
      const accounted = [...classified.map(s => s.uuid), ...errors.map(e => typeof e.uuid === "string" ? e.uuid.toLowerCase() : null)];
      if (accounted.length !== ids.length || new Set(accounted).size !== ids.length || accounted.some(id => !ids.includes(id)) ||
        classified.some(s => !["NEW", "CHANGED", "UNCHANGED"].includes(s.classification) || (s.classification !== "UNCHANGED" && !committed.has(s.uuid)))) throw new Error("Chunk non terminé : finalisation interdite");
      await store.finishPage({ sourceId, scanId, url });
      stats.pages++; stats.received += ids.length; stats.invalid += errors.length;
      for (const error of errors) for (const code of error.codes || ["conversion_error"]) stats.errorCodes[code] = (stats.errorCodes[code] || 0) + 1;
      url = next;
    }
    return { scanId, status: "complete", ...stats };
  } catch (error) {
    // If this RPC also fails (network/crash), the checkpoint stays RUNNING, never COMPLETE.
    try { await store.failScan({ sourceId, scanId }); } catch (_) {}
    throw error;
  }
}

// A cursor ending before its initial meta.total is accepted ONLY with structural proof: a
// valid page whose meta has no next, contiguous meta.page from the scan start, every earlier
// page full, and a fresh catalogue count no greater than what the cursor returned. Errors
// (timeout, HTTP, invalid JSON) throw before reaching this point and never mean "end".
function terminalDriftProof(metas, { pagesBefore, receivedBefore, received, total }) {
  const last = metas.at(-1), pageSize = last?.meta?.page_size;
  if (receivedBefore !== pagesBefore * 100 || pageSize !== 100 || received >= total || last.meta.next != null || last.count < 1 || last.count > pageSize) return null;
  if (metas.some((m, i) => m.meta.page !== pagesBefore + i + 1 || (i < metas.length - 1 && m.count !== pageSize))) return null;
  if (received !== (last.meta.page - 1) * pageSize + last.count) return null;
  return { terminalPage: last.meta.page, pageSize, terminalCount: last.count };
}

// Opt-in batched runner. Pending observations survive conversion/persistence errors.
// Resume always refetches the entire unacknowledged block, using its original now.
async function runNationalScanBatched({ store, sourceId, fetchPage, processPage, now,
  scanId = randomUUID(), checkpointSize = 1000, resume = false, maxPages = Infinity, sourceDrift = null }) {
  if (![500, 1000].includes(checkpointSize) || !UUID.test(scanId) || !UUID.test(sourceId) || typeof fetchPage !== "function" || typeof processPage !== "function") throw new Error("Paramètres de scan invalides");
  const currentNow = new Date(now);
  if (now == null || !Number.isFinite(+currentNow)) throw new Error("Instant de reprise explicite obligatoire");
  let checkpoint;
  if (resume) checkpoint = await store.resumeBatchScan({ sourceId, scanId });
  else {
    const date = new Date(now);
    if (now == null || !Number.isFinite(+date)) throw new Error("Instant invalide");
    checkpoint = { id: scanId, started_at: date.toISOString(), initial_url: nationalUrl(date), next_url: nationalUrl(date), pages: 0, received: 0, total: null, invalid: 0, error_codes: {}, batch_size: checkpointSize, status: "running" };
    await store.beginBatchScan({ sourceId, scanId, now: checkpoint.started_at, initialUrl: checkpoint.initial_url, checkpointSize });
  }
  if (!checkpoint || checkpoint.id !== scanId || !["running", "complete"].includes(checkpoint.status) || ![500, 1000].includes(checkpoint.batch_size)) throw new Error("Checkpoint non reprenable");
  const date = new Date(checkpoint.started_at), initial = nationalUrl(date);
  if (checkpoint.initial_url !== initial) throw new Error("Périmètre de reprise invalide");
  const stats = { pages: checkpoint.pages, received: checkpoint.received, invalid: checkpoint.invalid || 0, errorCodes: { ...checkpoint.error_codes } };
  let url = checkpoint.next_url, total = checkpoint.total;
  const visited = new Set();
  while (url) {
    const first = url, objects = [], ids = new Set(), metas = []; let pages = 0, terminal = null;
    do {
      if (stats.pages + pages >= maxPages || visited.has(url)) throw new Error("Scan tronqué ou pagination cyclique");
      visited.add(url);
      const page = await fetchPage(url);
      if (!page || !Array.isArray(page.objects) || !Number.isInteger(page.meta?.total) || page.meta.total <= 0 || page.objects.length > 100) throw new Error("Page nationale invalide");
      if (total !== null && total !== page.meta.total) throw new Error("Total national instable");
      total = page.meta.total;
      const next = nextUrl(page.meta.next, initial);
      for (const poi of page.objects) {
        const id = poi?.uuid?.toLowerCase();
        if (!UUID.test(id || "") || ids.has(id)) throw new Error("Identité absente ou dupliquée");
        ids.add(id); objects.push(poi);
      }
      const received = stats.received + objects.length;
      metas.push({ meta: page.meta, count: page.objects.length });
      if (next === null && received < total && sourceDrift) terminal = terminalDriftProof(metas, { pagesBefore: stats.pages, receivedBefore: stats.received, received, total });
      if (received > total || (next === null && received !== total && !terminal) || (next !== null && (!page.objects.length || received >= total))) throw new Error("Pagination incomplète ou limitée");
      pages++; url = next;
    } while (url && pages < checkpoint.batch_size / 100);
    // The catalog cursor retains its original filter; selection has its own durable clock.
    // Old checkpoints predate selection_now: only THEIR pending batch uses started_at.
    const historical = checkpoint.pending && checkpoint.pending.url === first;
    const selectionNow = historical ? new Date(checkpoint.pending.selection_now || checkpoint.started_at) : currentNow;
    if (!Number.isFinite(+selectionNow)) throw new Error("Instant du lot invalide");
    if (terminal) {
      const received = stats.received + objects.length, controlTotal = await sourceDrift.controlTotal({ initialUrl: initial });
      if (!Number.isInteger(controlTotal) || controlTotal <= 0 || controlTotal > received) throw new Error("Dérive de source non expliquée par le contrôle frais");
      terminal = { ...terminal, initialTotal: total, receivedTotal: received, controlTotal, controlAt: new Date().toISOString() };
      await store.observeTerminalDriftBatch({ sourceId, scanId, url: first, total, ids: [...ids], pages, now: date.toISOString(),
        selectionNow: selectionNow.toISOString(), terminalPage: terminal.terminalPage, pageSize: terminal.pageSize,
        terminalCount: terminal.terminalCount, controlTotal, controlAt: terminal.controlAt });
      stats.sourceDrift = terminal;
    } else await store.observeBatch({ sourceId, scanId, url: first, nextUrl: url, total, ids: [...ids], pages,
      now: date.toISOString(), selectionNow: selectionNow.toISOString() });
    const result = await processPage(objects, { sourceId, scanId, now: selectionNow, historical: !!historical });
    const classified = result?.classified, errors = result?.errors, committed = new Set(result?.committed);
    if (!Array.isArray(classified) || !Array.isArray(errors) || !Array.isArray(result.committed)) throw new Error("Résultat de lot absent");
    const accounted = [...classified.map(s => s.uuid), ...errors.map(e => e.uuid?.toLowerCase())];
    if (accounted.length !== ids.size || new Set(accounted).size !== ids.size || accounted.some(id => !ids.has(id)) || classified.some(s => !["NEW", "CHANGED", "UNCHANGED"].includes(s.classification) || (s.classification !== "UNCHANGED" && !committed.has(s.uuid)))) throw new Error("Lot non terminé : finalisation interdite");
    const errorCodes = {};
    for (const error of errors) for (const code of error.codes || ["conversion_error"]) errorCodes[code] = (errorCodes[code] || 0) + 1;
    await store.finishBatch({ sourceId, scanId, url: first, invalid: errors.length, errorCodes });
    stats.pages += pages; stats.received += objects.length; stats.invalid += errors.length;
    for (const [code, count] of Object.entries(errorCodes)) stats.errorCodes[code] = (stats.errorCodes[code] || 0) + count;
  }
  return { scanId, status: "complete", ...stats };
}

function receivedPoiProcessor({ stateStore, activityStore, persistOccurrences }) {
  return (pois, context) => processReceivedPoiBatch({ pois, ...context, stateStore, activityStore, catalogObserved: true, candidateCache: persistOccurrences.candidateCache, persistOccurrences: states => persistOccurrences(states, context) });
}

function finalizeNationalScan({ store, sourceId, scanId, now }) {
  if (!UUID.test(scanId) || !UUID.test(sourceId) || now == null || !Number.isFinite(+new Date(now))) throw new Error("Finalisation invalide");
  return store.finalizeScan({ sourceId, scanId, now: new Date(now).toISOString() });
}

function createSupabaseNationalScanStore(client) {
  const rpc = async (name, args) => { const { data, error } = await client.rpc(name, args); if (error) throw new Error(error.message); return data; };
  return {
    beginBatchScan: s => rpc("sortir_dt_begin_batch_scan", { p_source_id: s.sourceId, p_scan_id: s.scanId, p_now: s.now, p_initial_url: s.initialUrl, p_size: s.checkpointSize }),
    resumeBatchScan: s => rpc("sortir_dt_resume_batch_scan", { p_source_id: s.sourceId, p_scan_id: s.scanId }),
    observeBatch: s => rpc("sortir_dt_observe_national_batch_v2", { p_source_id: s.sourceId, p_scan_id: s.scanId, p_url: s.url, p_next: s.nextUrl, p_total: s.total, p_uuids: s.ids, p_pages: s.pages, p_now: s.now, p_selection_now: s.selectionNow }),
    observeTerminalDriftBatch: s => rpc("sortir_dt_observe_terminal_drift_batch", { p_source_id: s.sourceId, p_scan_id: s.scanId, p_url: s.url, p_total: s.total, p_uuids: s.ids, p_pages: s.pages, p_now: s.now, p_selection_now: s.selectionNow,
      p_terminal_page: s.terminalPage, p_page_size: s.pageSize, p_terminal_count: s.terminalCount, p_control_total: s.controlTotal, p_control_at: s.controlAt }),
    finishBatch: s => rpc("sortir_dt_finish_national_batch", { p_source_id: s.sourceId, p_scan_id: s.scanId, p_url: s.url, p_invalid: s.invalid, p_errors: s.errorCodes }),
    beginScan: s => rpc("sortir_dt_begin_national_scan", { p_source_id: s.sourceId, p_scan_id: s.scanId, p_now: s.now, p_initial_url: s.initialUrl }),
    observePage: s => rpc("sortir_dt_observe_national_page", { p_source_id: s.sourceId, p_scan_id: s.scanId, p_url: s.url, p_next: s.nextUrl, p_total: s.total, p_uuids: s.ids, p_now: s.now }),
    finishPage: s => rpc("sortir_dt_finish_national_page", { p_source_id: s.sourceId, p_scan_id: s.scanId, p_url: s.url }),
    failScan: s => rpc("sortir_dt_fail_national_scan", { p_source_id: s.sourceId, p_scan_id: s.scanId }),
    finalizeScan: s => rpc("sortir_dt_finalize_national_scan", { p_source_id: s.sourceId, p_scan_id: s.scanId, p_now: s.now })
  };
}

module.exports = { terminalDriftProof, runNationalScanBatched, nationalUrl, createNationalPageFetcher, runNationalScan, receivedPoiProcessor, finalizeNationalScan, createSupabaseNationalScanStore };
