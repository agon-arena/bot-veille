"use strict";
// Test-only adapter: execute the real scheduler-state builder against isolated
// PostgreSQL. No HTTP, production credentials or ingestion pipeline.
function schedulerPostgresClient(client) {
  return { from(table) {
    if (table !== 'sortir_ingestion_runs') throw Error('Unexpected scheduler test table');
    let action, payload; const filters = [];
    const q = {
      insert(row) { action = 'insert'; payload = row; return q; },
      update(row) { action = 'update'; payload = row; return q; },
      eq(key, value) { if (!['id', 'orchestrator_version', 'status'].includes(key)) throw Error('Unexpected filter'); filters.push([key, value]); return q; },
      select() { return q; },
      then(resolve, reject) {
        return (async () => {
          const keys = Object.keys(payload);
          if (keys.some(k => !['id', 'orchestrator_version', 'status', 'started_at', 'finished_at'].includes(k))) throw Error('Unexpected column');
          const values = Object.values(payload);
          const sql = action === 'insert'
            ? `insert into public.sortir_ingestion_runs (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning id`
            : `update public.sortir_ingestion_runs set ${keys.map((k, i) => k + '=$' + (i + 1)).join(',')} where ${filters.map(([k, v]) => { values.push(v); return k + '=$' + values.length; }).join(' and ')} returning id`;
          try { return { data: (await client.query(sql, values)).rows, error: null }; }
          catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
        })().then(resolve, reject);
      }
    }; return q;
  } };
}
module.exports = { schedulerPostgresClient };
