"use strict";
function inspectTick(tick) {
  if(tick?.triggered===true && tick.status==='started' && typeof tick.cycleId==='string')return {action:'poll',cycleId:tick.cycleId,successConfirmed:false};
  // Toute absence de lancement doit être vérifiée dans le journal durable.
  if(tick?.triggered===false && ['not due','already run recently','retry spacing','scheduler locked','already running','another ingestion running'].includes(tick.reason))return {action:'verify',reason:tick.reason,successConfirmed:false};
  // Rattrapage épuisé : des producteurs restent en échec pour la journée, jamais un simple skip.
  if(tick?.triggered===false && tick.reason==='daily attempts exhausted')throw Error(`Cycle du jour inachevé après ${tick.attemptsToday} tentatives : producteurs en échec, intervention requise`);
  throw Error('Tick rejeté, configuration inactive ou résultat sans identifiant durable');
}
function inspectCycle(cycle) {
  if(cycle?.status==='running' && cycle.finished===false)return {action:'poll',successConfirmed:false};
  if(cycle?.status==='completed' && cycle.finished===true && cycle.successConfirmed===true && !cycle.inconsistent &&
    Number.isInteger(cycle.expectedCount) && cycle.expectedCount>0 && cycle.completedCount===cycle.expectedCount &&
    cycle.failedCount===0 && cycle.partialCount===0 && cycle.pendingCount===0)return {action:'success',successConfirmed:true};
  throw Error('Cycle échoué, partiel, incohérent ou non confirmé');
}
if(require.main===module){try{const value=JSON.parse(require('fs').readFileSync(process.argv[3],'utf8'));const result=process.argv[2]==='tick'?inspectTick(value):process.argv[2]==='cycle'?inspectCycle(value):(()=>{throw Error('Mode inconnu');})();console.log(JSON.stringify(result));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={inspectTick,inspectCycle};
