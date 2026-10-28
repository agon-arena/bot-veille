"use strict";
// Mini client factice : applique les mutations au moment du await, y compris la CAS du verrou.
function schedulerClient(db) {
  const calls = [];
  const tables = { sortir_sources: db.sources, sortir_ingestion_runs: db.ingestions, sortir_source_runs: db.sourceRuns };
  return { calls, from(table) {
    const filters = []; let action = "select", payload, cap = Infinity, single = false;
    const q = {
      select() { return q; }, insert(row) { action = "insert"; payload = row; return q; }, update(row) { action = "update"; payload = row; return q; },
      eq(k,v) { filters.push(row => k === "ingestion.orchestrator_version" ? db.ingestions.find(r=>r.id===row.ingestion_run_id)?.orchestrator_version === v : row[k] === v); return q; },
      neq(k,v) { filters.push(row=>row[k]!==v); return q; }, gte(k,v) { filters.push(row=>row[k]>=v); return q; }, limit(n) { cap=n;return q; }, maybeSingle() { single=true;return q; },
      then(resolve,reject) { return Promise.resolve().then(()=> {
        calls.push({table,action,payload}); const rows=tables[table]; if(!rows)throw Error('Table factice interdite '+table);
        if(action==='insert') { if(rows.some(r=>r.id===payload.id))return{data:null,error:{code:'23505',message:'PK en conflit'}}; rows.push({...payload}); return{data:[payload],error:null}; }
        const matches=rows.filter(row=>filters.every(fn=>fn(row))).slice(0,cap);if(action==='update')for(const row of matches)Object.assign(row,payload);
        return{data:single?(matches[0]||null):matches.map(r=>({...r})),error:null};
      }).then(resolve,reject); }
    }; return q;
  } };
}
module.exports={schedulerClient};
