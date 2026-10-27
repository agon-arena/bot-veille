"use strict";
// Manual read-only command. Exit 2 blocks ingestion; no scheduler integration.
const { createClient } = require("@supabase/supabase-js");
const { createSupabaseDatatourismePreflightStore, runDatatourismePreflight } = require("./datatourisme-preflight");
async function main() {
  require("dotenv").config({ quiet: true });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options = {}) => {
      if ((options.method || "GET") !== "GET") throw new Error("Précontrôle strictement en lecture seule");
      return fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    } }
  });
  const { data, error } = await client.from("sortir_sources").select("id").eq("key", "datatourisme-national").eq("connector_type", "datatourisme").single();
  if (error) throw new Error(error.message);
  const result = await runDatatourismePreflight({ sourceId: data.id, store: createSupabaseDatatourismePreflightStore(client) });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ready ? 0 : 2;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
