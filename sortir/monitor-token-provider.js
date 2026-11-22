'use strict';
const crypto=require('node:crypto');
const ROLE='sortir_monitor_reader';
const unavailable=()=>new Error('Authentification de supervision indisponible');
// Shared across route-created clients, but isolated for each environment object.
const providers=new WeakMap();
function createTokenProvider({config,request=globalThis.fetch,now=Date.now}={}) {
  let token=null,expires=0,pending=null,blockedUntil=0,stopped=false;
  const invalidate=()=>{token=null;expires=0;blockedUntil=now()+30000;};
  async function call(path,method='GET',body,accessToken) {
    try {
      const response=await request(config.url+path,{method,redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{'Content-Type':'application/json',apikey:config.key,...(accessToken?{Authorization:'Bearer '+accessToken}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(response.status===204)return {status:204};
      const value=await response.json();return {status:response.status,value};
    }catch{throw unavailable();}
  }
  async function renew() {
    let uncertainSession=false;
    try {
      // Fetch only public keys before creating a session; never retrieve a signing secret.
      const keys=await call('/auth/v1/.well-known/jwks.json');
      if(keys.status!==200||!Array.isArray(keys.value?.keys)||keys.value.keys.length>20)throw unavailable();
      uncertainSession=true;
      const login=await call('/auth/v1/token?grant_type=password','POST',{email:config.email,password:config.password});
      if(login.status>=400&&login.status<500)uncertainSession=false;
      const jwt=login.value?.access_token;
      if(login.status!==200||typeof jwt!=='string'||jwt.length>16384)throw unavailable();
      // No intervening network operation; refresh_token is never stored or reused.
      const logout=await call('/auth/v1/logout?scope=local','POST',{},jwt);
      if(logout.status!==204)throw unavailable();
      uncertainSession=false;
      const parts=jwt.split('.');if(parts.length!==3||!parts.every(x=>/^[\w-]+$/.test(x)))throw unavailable();
      const header=JSON.parse(Buffer.from(parts[0],'base64url')),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
      const key=keys.value.keys.find(k=>k.kid===header.kid&&k.alg==='ES256'&&k.kty==='EC'&&k.crv==='P-256'&&(!k.use||k.use==='sig'));
      if(header.alg!=='ES256'||!key||!crypto.verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{
        key:crypto.createPublicKey({key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url')))throw unavailable();
      if(claims.role!==ROLE||claims.sub!==config.userId||claims.iss!==config.url+'/auth/v1'||claims.aud!=='authenticated'||
        (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(claims.session_id||'')||claims.session_id==='00000000-0000-0000-0000-000000000000')||
        !Number.isFinite(claims.exp)||!Number.isFinite(claims.iat)||claims.exp-claims.iat>3600||claims.exp<=claims.iat||
        claims.iat*1000>now()+30000||claims.exp*1000<=now()+300000||
        (claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf*1000>now())))throw unavailable();
      const personal=await call('/auth/v1/user','GET',undefined,jwt);
      if(![401,403].includes(personal.status)||personal.value?.error_code!=='session_not_found'){uncertainSession=true;throw unavailable();}
      token=jwt;expires=claims.exp*1000;return token;
    }catch{invalidate();if(uncertainSession)stopped=true;throw unavailable();}
  }
  return Object.freeze({invalidate,async getToken(){
    if(stopped||now()<blockedUntil)throw unavailable();
    if(token&&expires-now()>300000)return token;
    if(!pending)pending=renew().finally(()=>{pending=null;});
    return pending;
  }});
}
function sharedTokenProvider(env,config,options={}) {
  let entry=providers.get(env);
  if(!entry){entry=createTokenProvider({config,...options});providers.set(env,entry);}
  return entry;
}
module.exports={createTokenProvider,sharedTokenProvider};
