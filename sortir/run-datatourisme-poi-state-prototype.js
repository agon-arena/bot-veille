"use strict";

// Standalone read-only prototype. No Supabase client, ingestion, or scheduler import.
// --download FILE.jsonl reads the API into scratch; --input FILE.jsonl reuses it.
const fs = require("fs");
const readline = require("readline");
const { once } = require("events");
const { performance } = require("perf_hooks");
const { REQUIRED_FIELDS, stripApiKeyFromUrl } = require("./connectors/datatourisme");
const { calculatePoiStateBatch, comparePoiStates, STATE_BATCH_SIZE } = require("./datatourisme-poi-state");

async function download(file, now) {
  if (!process.env.DATATOURISME_API_KEY) throw new Error("DATATOURISME_API_KEY absente");
  const output = fs.createWriteStream(file, { flags: "wx" });
  // Attach immediately: prevent an unhandled stream error if the path already exists.
  let outputError;
  output.on("error", error => { outputError = error; });
  let url = new URL("https://api.datatourisme.fr/v1/entertainmentAndEvent");
  url.searchParams.set("fields", REQUIRED_FIELDS);
  url.searchParams.set("lang", "fr");
  url.searchParams.set("page_size", "100");
  url.searchParams.set("filters", `takesPlaceAt.endDate[gte]=${now.toISOString().slice(0, 10)}`);
  let requests = 0, count = 0;
  const started = performance.now();
  try {
    while (url) {
      const response = await fetch(url, { headers: { "X-API-Key": process.env.DATATOURISME_API_KEY }, signal: AbortSignal.timeout(30000) });
      requests++;
      if (!response.ok) throw new Error(`HTTP DATAtourisme ${response.status}`);
      const page = await response.json();
      if (!Array.isArray(page.objects)) throw new Error("Page invalide");
      for (const poi of page.objects) {
        if (outputError) throw outputError;
        if (!output.write(JSON.stringify(poi) + "\n")) await once(output, "drain");
      }
      count += page.objects.length;
      url = page.meta?.next ? stripApiKeyFromUrl(new URL(page.meta.next, url)) : null;
      if (requests % 100 === 0) console.log(JSON.stringify({ downloadRequests: requests, pois: count }));
      if (requests > 2000) throw new Error("Garde-fou pagination");
    }
    output.end();
    await once(output, "finish");
    console.log(JSON.stringify({ downloadComplete: true, requests, count, seconds: (performance.now() - started) / 1000 }));
  } catch (error) {
    output.destroy();
    throw error; // Incomplete file must never be treated as a completed national scan.
  }
}

async function simulate(file, now) {
  const reference = new Map();
  let reads = 0, writes = 0, observationWrites = 0, rowBytes = 0, maximumHeap = 0;
  const store = { async loadBatch(ids) { reads++; return ids.flatMap(id => reference.has(id) ? [reference.get(id)] : []); } };
  const scanId = "11111111-2222-3333-4444-555555555555";
  const report = { now: now.toISOString(), inputBytes: fs.statSync(file).size, batchSize: STATE_BATCH_SIZE, passes: [] };
  for (const [name, date] of [["FIRST", now], ["IDENTICAL", now], ["DAY_PLUS_ONE", new Date(+now + 86400000)]]) {
    const counts = { NEW: 0, CHANGED: 0, UNCHANGED: 0, ERROR: 0, KEEP: 0, DENY: 0, selectedOccurrences: 0 };
    let pending = [], calculationMs = 0, fingerprintMs = 0, errors = [], errorKinds = {};
    const start = performance.now(), cpu = process.cpuUsage(), readStart = reads, writeStart = writes, observationStart = observationWrites;
    const flush = async () => {
      if (!pending.length) return;
      const result = await comparePoiStates({ states: pending, store });
      for (const s of result.classified) {
        counts[s.classification]++;
        if (name === "FIRST") {
          // Success is simulated ONLY in this in-memory reference, never in Supabase.
          const row = { poi_uuid: s.uuid, fingerprint: s.fingerprint, algorithm_version: s.algorithm_version, last_observed_at: date.toISOString(), last_observed_scan_id: scanId };
          reference.set(s.uuid, row);
          rowBytes += Buffer.byteLength(JSON.stringify(row));
        }
      }
      writes += Math.ceil(result.toPersist.length / STATE_BATCH_SIZE);
      observationWrites += Math.ceil(result.unchanged.length / STATE_BATCH_SIZE);
      pending = [];
      maximumHeap = Math.max(maximumHeap, process.memoryUsage().heapUsed);
    };
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    const ids = new Set();
    for await (const line of lines) {
      if (!line.trim()) continue;
      const poi = JSON.parse(line);
      if (ids.has(poi.uuid)) throw new Error("UUID répété dans le snapshot national");
      ids.add(poi.uuid);
      const before = performance.now();
      const calculated = calculatePoiStateBatch([poi], { now: date, onFingerprintTiming: ms => { fingerprintMs += ms; } });
      calculationMs += performance.now() - before;
      for (const error of calculated.errors) {
        counts.ERROR++;
        const kind = error.codes.join(",");
        errorKinds[kind] = (errorKinds[kind] || 0) + 1;
        if (errors.length < 5) errors.push({ uuid: error.uuid, error: error.message });
      }
      for (const state of calculated.states) {
        counts[state.editorial]++;
        counts.selectedOccurrences += state.results.length;
        pending.push(state);
        if (pending.length === STATE_BATCH_SIZE) await flush();
      }
    }
    await flush();
    report.passes.push({ name, ...counts, totalPois: ids.size, seconds: (performance.now() - start) / 1000, calculationMs, fingerprintMs, cpu: process.cpuUsage(cpu), batchReads: reads - readStart, theoreticalFingerprintWrites: writes - writeStart,
      minimumGroupedFingerprintWrites: Math.ceil((counts.NEW + counts.CHANGED) / STATE_BATCH_SIZE),
      theoreticalObservationWrites: observationWrites - observationStart,
      minimumGroupedObservationWrites: Math.ceil(counts.UNCHANGED / STATE_BATCH_SIZE), peakRssMB: process.resourceUsage().maxRSS / 1024, errorKinds, errors });
    console.log(JSON.stringify(report.passes.at(-1)));
  }
  report.meanJsonRowBytes = rowBytes / reference.size;
  report.referenceRows = reference.size;
  report.stateJsonBytes = rowBytes;
  report.peakHeapMB = maximumHeap / 1048576;
  report.peakRssMB = process.resourceUsage().maxRSS / 1024;
  console.log(JSON.stringify({ report }));
  return report;
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const value = key => args[args.indexOf(key) + 1];
    if (!args.includes("--now")) throw new Error("--now ISO explicite obligatoire");
    const now = new Date(value("--now"));
    if (!Number.isFinite(+now)) throw new Error("--now invalide");
    if (args.includes("--download")) {
      require("dotenv").config({ quiet: true });
      const file = value("--download");
      await download(file, now);
      if (args.includes("--simulate")) await simulate(file, now);
    } else if (args.includes("--input")) await simulate(value("--input"), now);
    else throw new Error("--input ou --download obligatoire");
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { simulate };
