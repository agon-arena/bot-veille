"use strict";
// Read-only deployment preflight. Does not import the scheduler or any store.
const {requireOpenAgendaKey}=require('./openagenda-auth');
const {loadAgendaSchema}=require('./openagenda-reunion-daily');
async function checkConfiguration({apiKey=process.env.OPENAGENDA_PUBLIC_KEY,loadSchema=loadAgendaSchema,uids=[56170473,26110493,60837943,2568169,50316469,4740352,40627992,1059482]}={}) {
  apiKey=requireOpenAgendaKey(apiKey);
  const results=[];
  for(const uid of uids){try{await loadSchema(uid,apiKey);results.push({agendaUid:uid,status:'accessible'});}catch(e){results.push({agendaUid:uid,status:'failed',errorCode:e.code||'OPENAGENDA_CONFIGURATION_ERROR',httpStatus:e.httpStatus||null});}}
  return {readOnly:true,keyPresent:true,allAccessible:results.every(r=>r.status==='accessible'),results};
}
if(require.main===module)checkConfiguration().then(r=>{console.log(JSON.stringify(r,null,2));if(!r.allAccessible)process.exitCode=1;}).catch(e=>{console.error(JSON.stringify({keyPresent:false,errorCode:e.code||'OPENAGENDA_CONFIGURATION_ERROR'}));process.exitCode=1;});
module.exports={checkConfiguration};
