"use strict";
const { performance } = require("perf_hooks");
const { persistSortirIngestion } = require("./supabase-persistence");
const { TemporalCandidateCache } = require("./temporal-candidate-cache");
const H = require("./candidate-memory-harness");
async function benchmark(count, optimized) {
  const s = H.store(), cache = optimized ? new TemporalCandidateCache() : undefined;
  let peakHeap = 0; const start = performance.now(), cpu = process.cpuUsage();
  for (let from = 0; from < count; from += 100) {
    const rows = Array.from({ length: Math.min(100, count - from) }, (_, i) => {
      const n = from + i, day = n % 100 === 0 ? 4000 + (n % 97) : (n * 37) % 90;
      const startsAt = new Date(+H.NOW + day * 86400000).toISOString(), endsAt = new Date(Date.parse(startsAt) + 7200000).toISOString();
      return H.item(n, { startsAt, endsAt, city: `Ville ${n % 500}`, latitude: 48 + (n % 500) / 10000, address: `Adresse ${n % 500}` });
    });
    const result = await persistSortirIngestion({ sources: [H.descriptor(rows)], store: s, now: H.NOW, reconcileDisappearances: false, candidateCache: cache });
    if (result.status !== "completed") throw new Error(JSON.stringify(result.sources));
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  return { count, optimized, wallMs: performance.now() - start, cpu: process.cpuUsage(cpu), peakHeapMB: peakHeap / 1048576, peakRssMB: process.resourceUsage().maxRSS / 1024, ...s.metrics, cache: cache?.stats, comparisonsShortlisted: cache?.index.visited };
}
if (require.main === module) benchmark(Number(process.argv[2] || 100), process.argv[3] === "new").then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { benchmark };
