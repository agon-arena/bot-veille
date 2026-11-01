"use strict";
const fs=require('fs');
const {validatePlan,writeBatch}=require('./organizer-review-writer');
async function main(args, env=process.env) {
  const options={};while(args.length){const flag=args.shift();if(flag==='--apply')options.apply=true;else if(['--write-plan','--authorize-plan-sha256','--max-batches'].includes(flag)&&args.length)options[flag.slice(2)]=args.shift();else throw Error('Unknown option '+flag);}
  if(!options.apply||!options['write-plan']||!options['authorize-plan-sha256'])throw Error('Explicit --apply, --write-plan and --authorize-plan-sha256 required');
  if(env.SORTIR_RECOVERY_ALLOW_WRITE!=='I_AUTHORIZE_EXACT_PLAN')throw Error('Write mode disabled: explicit environment authorization required');
  const plan=JSON.parse(fs.readFileSync(options['write-plan'],'utf8'));validatePlan(plan,options['authorize-plan-sha256']);
  const limit=Number(options['max-batches']||1);if(!Number.isInteger(limit)||limit<1||limit>1000)throw Error('Invalid batch limit');
  // No dotenv or Supabase REST credential fallback. This connection must belong
  // to the dedicated database role provisioned after migration authorization.
  const {recoveryConnectionConfig}=require('./organizer-recovery-connection');
  const {Client}=require('pg'),client=new Client(recoveryConnectionConfig(env));
  try{await client.connect();await client.query('set role sortir_organizer_recovery_writer');let newBatches=0;for(let batchNumber=0;batchNumber<Math.ceil(plan.entries.length/plan.batchSize);batchNumber++){
    const r=await writeBatch({client,plan,batchNumber,authorization:plan.planHash,apply:true});console.log(JSON.stringify({...r,journal:undefined}));
    if(!r.replayed&&++newBatches>=limit)break;
  }}catch(e){console.error(JSON.stringify({status:'STOP',errors:1,message:'Transaction not confirmed; replay identical plan to reconcile durable checkpoint.'}));throw e;}finally{await client.end();}
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main};
