"use strict";
// Contrôles en autocommit READ ONLY sur une connexion directe/session dédiée.
// Aucun BEGIN : une attente réseau/client entre deux lectures ne garde pas de transaction.
const active=new WeakSet();
class ControlReadError extends Error{constructor(code,message){super(message);this.code=code;}}
function assertSessionConnection(config){
  if(Number(config.port)===6543||(/pooler\.supabase\.com$/i.test(config.host||'')&&Number(config.port)!==5432))
    throw new ControlReadError('SESSION_CONNECTION_REQUIRED','Les contrôles nécessitent le mode session, pas le pooling transactionnel.');
}
const SETTINGS=`SELECT pg_backend_pid() AS backend_pid,
 current_setting('default_transaction_read_only') AS read_control_read_only,
 current_setting('statement_timeout') AS statement_timeout,
 current_setting('idle_in_transaction_session_timeout') AS idle_timeout`;
const CONFIGURE=`SELECT pg_catalog.set_config('default_transaction_read_only',$1,false),
 pg_catalog.set_config('statement_timeout',$2,false),
 pg_catalog.set_config('idle_in_transaction_session_timeout',$3,false)`;
async function readOnly(client,work){
  if(active.has(client))throw new ControlReadError('NESTED_CONTROL_READ','Contrôles imbriqués/concurrents sur une même connexion interdits.');
  active.add(client);const original=client.query,query=original.bind(client);let saved,value,primary,configured=false;
  try{
    saved=(await query(SETTINGS)).rows[0];
    if(!saved||!['on','off'].includes(saved.read_control_read_only)||!Number.isInteger(saved.backend_pid))
      throw new ControlReadError('CONTROL_SESSION','Paramètres de session non vérifiables.');
    configured=true;
    await query(CONFIGURE,['on','15s','15s']);
    const check=(await query("SELECT pg_backend_pid() AS backend_pid,current_setting('transaction_read_only') AS read_control_read_only")).rows[0];
    if(check?.backend_pid!==saved.backend_pid||check?.read_control_read_only!=='on')
      throw new ControlReadError('CONTROL_SESSION','READ ONLY ou session stable non garanti.');
    client.query=(sql,...args)=>{
      // Les contrôles internes ne contiennent que des lectures simples. Empêche
      // notamment BEGIN, SET, COMMIT et les commandes multiples dans un callback.
      if(typeof sql!=='string'||!/^(SELECT|SHOW|EXPLAIN)\b/i.test(sql.trim())||sql.trim().replace(/;$/,'').includes(';'))
        return Promise.reject(new ControlReadError('CONTROL_SQL','Commande hors périmètre de lecture.'));
      return query(sql,...args);
    };
    value=await work();
  }catch(error){primary=error;}
  finally{
    client.query=original;
    try{
      if(configured)await query(CONFIGURE,[saved.read_control_read_only,saved.statement_timeout,saved.idle_timeout]);
    }catch(error){
      // Une session dont les paramètres ne peuvent être restaurés n'est jamais
      // rendue au writer. L'erreur initiale (25P03, par exemple) reste prioritaire.
      try{await client.end?.();}catch{}
      if(!primary)primary=new ControlReadError('CONTROL_RESTORE','Restauration de session impossible : connexion fermée.');
    }
    active.delete(client);
  }
  if(primary)throw primary;return value;
}
// Empreinte sha256 d'un checkpoint calculée par le serveur, dans la même instruction que
// sa lecture : couvre toutes les colonnes (jsonb::text est canonique, l'horodatage est
// rendu en secondes epoch exactes, indépendamment du fuseau de session).
const ROW_DIGEST=`encode(sha256(convert_to(plan_hash||'|'||batch_number::text||'|'||request_hash||'|'||result::text||'|'||extract(epoch FROM committed_at)::text,'UTF8')),'hex')`;
async function journalRows(client,planHash,batches,includeCommittedAt=false,includeDigest=false){
  const rows=[];let after=null;
  while(rows.length<batches+1){
    const limit=Math.min(5,batches+1-rows.length);
    let page;
    try{page=(await client.query(`SELECT plan_hash,batch_number,request_hash,result${includeCommittedAt?',committed_at':''}${includeDigest?`,${ROW_DIGEST} AS row_digest`:''}
      FROM public.sortir_organizer_recovery_batches WHERE plan_hash=$1
      AND ($2::integer IS NULL OR batch_number>$2) ORDER BY batch_number LIMIT $3`,[planHash,after,limit])).rows;
    }catch(error){error.controlRead={kind:'checkpoint_page',planHash,after,limit};throw error;}
    if(page.length>limit||page.some((r,i)=>!Number.isInteger(r.batch_number)||(i?r.batch_number<=page[i-1].batch_number:after!==null&&r.batch_number<=after)))
      throw new ControlReadError('CHECKPOINT','Pagination du journal incohérente.');
    rows.push(...page);if(page.length<limit)break;after=page.at(-1).batch_number;
  }
  return rows;
}
// Empreintes de tout le journal des plans du manifeste en une requête, bornée au nombre
// de lots du manifeste (une ligne de plus signale un journal trop long).
async function journalDigests(client,planHashes,maxRows){
  let rows;
  try{rows=(await client.query(`SELECT plan_hash,batch_number,${ROW_DIGEST} AS row_digest
    FROM public.sortir_organizer_recovery_batches WHERE plan_hash=ANY($1::text[]) ORDER BY plan_hash,batch_number LIMIT $2`,[planHashes,maxRows+1])).rows;
  }catch(error){error.controlRead={kind:'checkpoint_digests',plans:planHashes.length};throw error;}
  if(rows.length>maxRows)throw new ControlReadError('CHECKPOINT','Journal plus long que le manifeste.');
  return rows;
}
module.exports={readOnly,journalRows,journalDigests,ROW_DIGEST,assertSessionConnection,ControlReadError};
