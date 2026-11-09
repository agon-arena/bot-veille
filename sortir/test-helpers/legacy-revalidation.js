"use strict";
// Référence figée de revalidateBatch telle qu'exécutée le 05/11/2026 (groupes de 25,
// horloge serveur à chaque page, provenances et identifiants en deux requêtes).
// Utilisée UNIQUEMENT par les tests d'équivalence ; seul ajout : le hook `observe`.
const W = require('../organizer-review-writer');
const { evaluateOrganizerRecovery } = require('../organizer-review-recovery');
const { TemporalCandidateIndex } = require('../temporal-candidate-cache');
const { rowToActivity } = require('../supabase-persistence');
const { readOnly } = require('../recovery-control-reads');
const S = require('../historical-recovery-supervisor');
async function legacyRevalidateBatch(client, plan, batchNumber, deadline, { observe } = {}) {
  const entries=S.entriesFor(plan,batchNumber); let pages=0;
  await readOnly(client,async()=>{
    const asOf=await S.serverTime(client,deadline); await S.assertIdle(client);
    const sources=new Map((await client.query('SELECT id,key,connector_type,base_url FROM public.sortir_sources')).rows.map(s=>[s.id,s]));
    async function hydrate(rows) {
      const ids=rows.map(r=>r.id), byId=new Map(rows.map(r=>[r.id,{...r,provenances:[],external_ids:[]} ]));
      if (!ids.length) return [];
      const ps=await client.query('SELECT to_jsonb(p) AS row FROM public.sortir_provenances p WHERE activity_id=ANY($1::uuid[])',[ids]);
      for(const {row:p} of ps.rows) byId.get(p.activity_id).provenances.push({...p,source:sources.get(p.source_id)});
      const es=await client.query('SELECT to_jsonb(e) AS row FROM public.sortir_external_ids e WHERE activity_id=ANY($1::uuid[])',[ids]);
      for(const {row:e} of es.rows) byId.get(e.activity_id).external_ids.push(e);
      return [...byId.values()];
    }
    for(let offset=0;offset<entries.length;offset+=25) {
      const part=entries.slice(offset,offset+25), ids=part.map(e=>e.id);
      const targets=await hydrate((await client.query('SELECT to_jsonb(a) AS row FROM public.sortir_activities a WHERE id=ANY($1::uuid[])',[ids])).rows.map(r=>r.row));
      const items=(await client.query('SELECT to_jsonb(i) AS row FROM public.sortir_collection_items i WHERE activity_id=ANY($1::uuid[])',[ids])).rows.map(r=>r.row);
      const decisions=(await client.query('SELECT to_jsonb(d) AS row FROM public.sortir_dedup_decisions d WHERE left_activity_id=ANY($1::uuid[]) OR right_activity_id=ANY($1::uuid[])',[ids])).rows.map(r=>r.row);
      if(targets.length!==ids.length) S.stop('BUSINESS','Cible historique absente.');
      const check=(row,candidates)=>{
        const entry=part.find(e=>e.id===row.id);
        if(!entry || W.fingerprint(row,items,decisions)!==entry.expectedHash) S.stop('BUSINESS','Empreinte modifiée depuis le scellement.');
        const hasDiagnostic=items.some(i=>i.activity_id===row.id&&[...(i.diagnostics?.warnings||[]),...(i.diagnostics?.errors||[])].some(w=>w.code==='organizer_name_missing'));
        const r=evaluateOrganizerRecovery({row,candidates,decisions,hasDiagnostic,asOf});
        observe?.({id:row.id,candidates:candidates.map(c=>c.id),decision:r.decision,reason:r.reason});
        if(r.decision!==entry.decision) S.stop('BUSINESS',`Éligibilité modifiée : ${r.reason}.`);
      };
      for(const row of targets) check(row,[]);
      let after=null;
      while(true) {
        await S.serverTime(client,deadline);
        const raw=(await client.query(`SELECT to_jsonb(a) AS row FROM public.sortir_activities a
          WHERE a.record_status IN ('active','review') AND ($2::uuid IS NULL OR a.id>$2::uuid)
          AND EXISTS(SELECT 1 FROM public.sortir_activities t WHERE t.id=ANY($1::uuid[])
            AND a.starts_at BETWEEN t.starts_at-interval '12 hours' AND t.starts_at+interval '12 hours')
          ORDER BY a.id LIMIT 100`,[ids,after])).rows.map(r=>r.row);
        if(raw.some((r,i)=>!r.id || (i ? r.id<=raw[i-1].id : after && r.id<=after))) S.stop('BUSINESS','Pagination des candidats incohérente.');
        const index=new TemporalCandidateIndex(); for(const row of await hydrate(raw)) index.set(row.id,row);
        for(const row of targets) check(row,index.matches(rowToActivity(row)));
        pages++; if(raw.length<100) break; after=raw.at(-1).id;
      }
    }
    await S.serverTime(client,deadline);
  });
  return { targets:entries.length,candidatePages:pages };
}
module.exports = { legacyRevalidateBatch };
