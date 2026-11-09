"use strict";
const S=require('./historical-recovery-supervisor'),{classifyError}=require('./recovery-connection-guard');
const LIMITS=Object.freeze({batches:100,promotions:10000,hours:18,rssBytes:1.5*1024**3});
function fail(code,message){throw new S.RecoveryStop(code,message);}
function limitsFor(config={}){
  const limits={...LIMITS,...config.limits};
  if(config.limits&&Object.keys(config.limits).some(k=>!Object.hasOwn(LIMITS,k)))fail('AUTHORIZATION_LIMIT','Limite inconnue.');
  for(const k of Object.keys(LIMITS))if(!Number.isFinite(limits[k])||limits[k]<=0||limits[k]>LIMITS[k])fail('AUTHORIZATION_LIMIT','Une configuration ne peut qu’abaisser les plafonds.');
  if(!Number.isInteger(limits.batches)||!Number.isInteger(limits.promotions)||!Number.isInteger(limits.rssBytes))fail('AUTHORIZATION_LIMIT','Limites entières requises.');
  return limits;
}
function guard(state,config,entries,now=Date.now()){
  const limits=limitsFor(config);
  if(state.stopRequested||state.stopped)fail('INTERRUPTED','Arrêt demandé ou anomalie déjà enregistrée.');
  if(now>=Math.min(config.executionDeadline,Date.parse(S.DEADLINE)))fail('TIME_LIMIT','Durée ou échéance des plans atteinte.');
  if(!Number.isInteger(entries)||entries<1||entries>100)fail('BATCH_LIMIT','Taille de lot invalide.');
  const start=config.continueToEnd?(state.segmentStart||0):0;
  if(!Number.isInteger(start)||start<0||start>state.verified.length)fail('AUTHORIZATION_LIMIT','Compteur de tranche invalide.');
  if(config.continueToEnd){
    const scope=config.scope;
    if(!scope||!Number.isInteger(scope.batches)||!Number.isInteger(scope.promotions)||scope.batches<1||scope.batches>285||scope.promotions<1||scope.promotions>27832)
      fail('AUTHORIZATION_LIMIT','Autorisation cumulée invalide.');
    if(state.verified.length>=scope.batches||state.verified.reduce((n,b)=>n+b.entries,0)+entries>scope.promotions)
      fail('AUTHORIZATION_LIMIT','Périmètre historique autorisé épuisé.');
  }
  const window=state.verified.slice(start);
  if(window.length>=limits.batches||window.reduce((n,b)=>n+b.entries,0)+entries>limits.promotions)
    fail('AUTHORIZATION_LIMIT','Limites de l’autorisation atteintes.');
}
function advanceSegment(state,config,entries,now=Date.now()){
  if(!config.continueToEnd)return false;
  const limits=limitsFor(config),window=state.verified.slice(state.segmentStart||0);
  if(window.length<limits.batches&&window.reduce((n,b)=>n+b.entries,0)+entries<=limits.promotions)return false;
  if(state.pending||!window.length||window.some(b=>b.integrity!==true||b.duplicates!==false||b.errors!==0))
    fail('AUTHORIZATION_LIMIT','Tranche non entièrement vérifiée : poursuite interdite.');
  // Ne change ni les plafonds, ni l’échéance. Une tranche suivante n’est ouverte
  // qu’après le succès intégral de la précédente, jamais après une anomalie.
  guard({...state,segmentStart:state.verified.length},config,entries,now);
  state.segmentStart=state.verified.length;
  (state.segments||=[]).push({startIndex:state.segmentStart,at:new Date(now).toISOString()});
  return true;
}
function targets(bundle,anchors,requested=LIMITS){
  const limits=limitsFor({limits:requested});
  const result=[];let count=0;
  for(const p of bundle.plans)for(let n=0;n<p.batches;n++)if(!anchors.has(`${p.plan.planHash}:${n}`)){
    const size=S.entriesFor(p.plan,n).length;
    if(result.length===limits.batches||count+size>limits.promotions)return result;
    result.push({group:p.group,batchNumber:n,entries:size});count+=size;
  }
  return result;
}
function runTargets(bundle,anchors,config){
  if(!config.continueToEnd)return targets(bundle,anchors,limitsFor(config));
  const result=[];let promotions=0;
  for(const p of bundle.plans)for(let n=0;n<p.batches;n++)if(!anchors.has(`${p.plan.planHash}:${n}`)){
    const entries=S.entriesFor(p.plan,n).length;
    if(entries<1||entries>100)fail('BATCH_LIMIT','Lot historique non borné.');
    result.push({group:p.group,batchNumber:n,entries});promotions+=entries;
  }
  if(result.length!==config.scope?.batches||promotions!==config.scope?.promotions)
    fail('AUTHORIZATION_LIMIT','Le reliquat réel ne correspond pas au périmètre autorisé.');
  return result;
}
// Les retries du superviseur restent possibles AVANT toute tentative de COMMIT.
// Une réponse COMMIT perdue ou une erreur après COMMIT devient non retryable.
function protectedClient(client,context,onEvent=()=>{}){
  const query=client.query.bind(client);
  return {end:()=>client.end(),query:async(sql,...args)=>{
    const text=sql.trim(),writeBegin=/^begin$/i.test(text),commit=/^commit$/i.test(text);
    if(writeBegin){context.inWrite=true;context.commitSent=false;context.committed=false;}
    const writeCommit=commit&&context.inWrite;
    if(writeCommit)context.commitSent=true;
    const started=Date.now();context.lastQueryAt=started;context.queryTag=text.split(/\s+/).slice(0,3).join(' ');
    try{
      const result=await query(sql,...args);
      if(writeCommit){context.committed=true;context.inWrite=false;onEvent({event:'write_commit_acknowledged'});}
      else if(/^rollback$/i.test(text))context.inWrite=false;
      if(Date.now()-started>2500)onEvent({event:'slow_query',tag:context.queryTag,durationMs:Date.now()-started});
      return result;
    }catch(error){
      // Classement précis sans texte serveur (seuls les messages client connus de pg).
      const {code,...detail}=classifyError(error);
      onEvent({event:'query_error',tag:context.queryTag,code:code||'QUERY',...detail,durationMs:Date.now()-started});
      if(context.commitSent||context.committed)fail('COMMIT_UNCERTAIN','Incident pendant ou après COMMIT : réconciliation en lecture seule, aucun replay.');
      throw error;
    }
  }};
}
module.exports={LIMITS,limitsFor,guard,advanceSegment,targets,runTargets,protectedClient,fail};
