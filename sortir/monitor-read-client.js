'use strict';
// Separate read-only monitoring transport. Never falls back to business credentials.
const TABLES=Object.freeze({
  sortir_ingestion_runs:new Set(['id','status','orchestrator_version','started_at','finished_at','error_summary']),
  sortir_source_runs:new Set(['id','started_at','status'])
});
const ROLE='sortir_monitor_reader';
const fail=()=>{throw new Error('Configuration de supervision dédiée absente ou invalide');};
function readConfiguration(env=process.env,now=Date.now()) {
  const raw=env.SORTIR_MONITOR_SUPABASE_URL,key=env.SORTIR_MONITOR_PUBLISHABLE_KEY,token=env.SORTIR_MONITOR_ACCESS_TOKEN;
  if(!raw||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key||'')||typeof token!=='string')fail();
  let url,header,claims;
  try{
    url=new URL(raw);
    const parts=token.split('.');if(parts.length!==3||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))fail();
    header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
  }catch{fail();}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.port)fail();
  if(!['HS256','ES256','RS256'].includes(header.alg)||claims.role!==ROLE||!Number.isFinite(claims.exp)||claims.exp*1000<=now||
    (claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf*1000>now))||claims.iss!==url.origin+'/auth/v1')fail();
  // These claim checks are fail-closed configuration checks. The Supabase server,
  // not this decoder, must validate the signature and apply the database role/RLS.
  return {url:url.origin,key,token};
}
function monitoringConfigured(env=process.env) {try{readConfiguration(env);return true;}catch{return false;}}
function createMonitorReadClient({env=process.env,createClient,request=globalThis.fetch,now=Date.now}={}) {
  const config=readConfiguration(env,now());
  const checkedToken=()=>readConfiguration(env,now()).token;
  const guardedFetch=async(input,options={})=>{
    let url;try{url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);}catch{fail();}
    const method=String(options.method||(input instanceof Request?input.method:'GET')).toUpperCase();
    const table=url.pathname.slice('/rest/v1/'.length);
    if(url.origin!==config.url||!url.pathname.startsWith('/rest/v1/')||!Object.hasOwn(TABLES,table)||
      !['GET','HEAD'].includes(method)||options.body!=null||url.username||url.password)throw new Error('Requête hors périmètre de supervision');
    const headers=new Headers(options.headers||(input instanceof Request?input.headers:undefined));
    if((headers.get('Accept-Profile')||'public')!=='public')throw new Error('Schéma hors périmètre de supervision');
    headers.set('Authorization','Bearer '+checkedToken());headers.set('apikey',config.key);
    const timeout=AbortSignal.timeout(10000),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
    return request(url.toString(),{...options,method,headers,redirect:'error',signal});
  };
  const sdk=(createClient||require('@supabase/supabase-js').createClient)(config.url,config.key,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    accessToken:async()=>checkedToken(),global:{fetch:guardedFetch}
  });
  const allowed=new Set(['eq','neq','gte','limit','maybeSingle','abortSignal']);
  function wrap(query,columns) {
    return new Proxy(query,{get(target,name){
      if(name==='then'||name==='catch'||name==='finally')return target[name]?.bind(target);
      if(!allowed.has(name))throw new Error('Opération hors périmètre de supervision');
      return (...args)=>{
        if(['eq','neq','gte'].includes(name)&&!columns.has(args[0]))throw new Error('Colonne hors périmètre de supervision');
        if(name==='limit'&&(!Number.isInteger(args[0])||args[0]<1||args[0]>51))throw new Error('Limite de supervision invalide');
        return wrap(target[name](...args),columns);
      };
    }});
  }
  return Object.freeze({from(table){
    const columns=Object.hasOwn(TABLES,table)&&TABLES[table];if(!columns)throw new Error('Table hors périmètre de supervision');
    return Object.freeze({select(list){
      if(typeof list!=='string'||!list.split(',').every(c=>columns.has(c.trim())))throw new Error('Projection hors périmètre de supervision');
      return wrap(sdk.from(table).select(list),columns);
    }});
  }});
}
module.exports={createMonitorReadClient,monitoringConfigured,readConfiguration,ROLE};
