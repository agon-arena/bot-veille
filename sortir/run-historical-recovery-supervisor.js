"use strict";
const path=require('node:path');
const S=require('./historical-recovery-supervisor');
function options(args,env){
  const out={mode:null,maxBatches:1};
  for(let i=0;i<args.length;i++){
    const a=args[i];
    if(['--validate-files','--check','--apply'].includes(a)){
      if(out.mode)throw new S.RecoveryStop('CONFIG','Un seul mode explicite requis.');
      out.mode=a;
    }else if(a==='--max-batches')out.maxBatches=Number(args[++i]);
    else if(a==='--authorize-manifest-sha256')out.authorization=args[++i];
    else throw new S.RecoveryStop('CONFIG','Option inconnue.');
  }
  if(!out.mode||!Number.isInteger(out.maxBatches)||out.maxBatches<1||out.maxBatches>285)
    throw new S.RecoveryStop('CONFIG','Mode explicite et limite de lots 1–285 requis.');
  if(out.mode==='--apply'&&(out.authorization!==S.MANIFEST_SHA256||env.SORTIR_RECOVERY_ALLOW_WRITE!=='I_AUTHORIZE_EXACT_PLAN'))
    throw new S.RecoveryStop('AUTH','Double autorisation explicite requise avant connexion.');
  return out;
}
async function main(args=process.argv.slice(2),env=process.env){
  const o=options(args,env);
  const bundle=S.loadBundle(path.join(__dirname,'recovery-data/2026-11-02-national/plans-index.json'));
  if(o.mode==='--validate-files'){
    console.log(JSON.stringify({event:'local_files_valid',manifestHash:bundle.manifestHash,deadline:bundle.deadline,plans:bundle.plans.length}));return;
  }
  const controller=new AbortController(),abort=()=>controller.abort();
  process.on('SIGINT',abort);process.on('SIGTERM',abort);
  try{
    const result=await S.supervise({bundle,connect:()=>S.connectRecovery(env),apply:o.mode==='--apply',
      authorization:o.authorization,maxBatches:o.maxBatches,signal:controller.signal});
    console.log(JSON.stringify({event:'supervision_finished',...result}));
  }finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
if(require.main===module)main().catch(e=>{
  console.error(JSON.stringify({event:'supervision_stopped',code:e instanceof S.RecoveryStop?e.code:'DATABASE_OR_WRITER',
    message:e instanceof S.RecoveryStop?e.message:'Erreur SQL, réseau ou métier : arrêt ; consulter le journal durable avant reprise.',databaseCode:e.code}));
  process.exitCode=1;
});
module.exports={options,main};
