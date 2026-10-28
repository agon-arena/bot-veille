"use strict";
// Verrou partagé via la PK d'une ligne technique du journal existant : aucune migration.
// Pas d'expiration automatique : reprendre un verrou d'un process encore vivant serait dangereux.
const LOCK_ID = "be127190-19a4-4f50-b615-7a9a78b8ff14";
const LOCK_VERSION = "sortir-scheduler-lock-v1";
const CYCLE_VERSION = "sortir-scheduler-source-v1";
function createSchedulerState(client) {
  const checked = async query => { const r = await query; if (r.error) throw new Error(r.error.message); return r.data; };
  return {
    async acquire(now) {
      const row = { id: LOCK_ID, orchestrator_version: LOCK_VERSION, status: "running", started_at: now.toISOString(), finished_at: null };
      const inserted = await client.from("sortir_ingestion_runs").insert(row);
      if (!inserted.error) return true;
      if (inserted.error.code !== "23505") throw new Error(inserted.error.message);
      const won = await checked(client.from("sortir_ingestion_runs").update({ status: "running", started_at: row.started_at, finished_at: null })
        .eq("id", LOCK_ID).eq("orchestrator_version", LOCK_VERSION).eq("status", "completed").select("id"));
      return won.length === 1;
    },
    async release(now) {
      const rows = await checked(client.from("sortir_ingestion_runs").update({ status: "completed", finished_at: now.toISOString() })
        .eq("id", LOCK_ID).eq("orchestrator_version", LOCK_VERSION).eq("status", "running").select("id"));
      if (rows.length !== 1) throw new Error("Verrou scheduler perdu : contrôle opérateur nécessaire");
    },
    async hasOtherRunning() {
      const rows = await checked(client.from("sortir_ingestion_runs").select("id").eq("status", "running").neq("id", LOCK_ID).limit(1));
      if (rows.length) return true;
      const sourceRuns = await checked(client.from("sortir_source_runs").select("id").eq("status", "running").limit(1));
      return sourceRuns.length > 0;
    },
    async recent(key, since) {
      const source = await checked(client.from("sortir_sources").select("id").eq("key", key).maybeSingle());
      if (!source) return false;
      // Les runs de tranches ne certifient pas le producteur complet : seul son run enveloppe compte.
      const rows = await checked(client.from("sortir_source_runs")
        .select("id,ingestion:sortir_ingestion_runs!inner(orchestrator_version)").eq("source_id", source.id)
        .eq("ingestion.orchestrator_version", CYCLE_VERSION).eq("status", "completed").gte("started_at", since).limit(1));
      return rows.length > 0;
    }
  };
}
module.exports = { createSchedulerState, LOCK_ID, LOCK_VERSION, CYCLE_VERSION };
