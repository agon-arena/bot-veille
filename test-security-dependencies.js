'use strict';
// Local-only dependency integration checks: no .env, no application entry point,
// no production URL. The HTTP process binds exclusively to 127.0.0.1.
const test=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
test('real Express/compression parsers keep safe HTTP alive with compressed and malformed bodies',()=>{
 const source=String.raw`
  process.env.BOT_SAFE_START='on';
  const assert=require('node:assert/strict'),http=require('node:http'),zlib=require('node:zlib');
  const app=require('express')();app.use(require('./runtime-policy').safeStartMiddleware());
  app.use(require('compression')({threshold:0}));app.use(require('express').json());
  app.get('/probe',(q,r)=>r.json({ok:true,body:q.body||null,padding:'fixture '.repeat(1000)}));
  app.use((e,q,r,n)=>r.status(e.status||400).json({error:true}));
  const server=app.listen(0,'127.0.0.1',async()=>{
   function request(method,body,headers={}){return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/probe',method,headers:{...headers,...(body?{'Content-Length':body.length}:{})}},res=>{
     const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
    });req.on('error',reject);req.end(body);
   });}
   try{
    const payload=zlib.gzipSync(Buffer.from('{"fixture":true}'));
    const headers={'Content-Type':'application/json','Content-Encoding':'gzip'};
    const valid=await request('GET',payload,headers);assert.equal(valid.status,200);assert.equal(JSON.parse(valid.bytes).body.fixture,true);
    const blocked=await request('POST',payload,headers);assert.equal(blocked.status,503);assert.equal(JSON.parse(blocked.bytes).code,'BOT_SAFE_START');
    const malformed=await request('GET',Buffer.concat([payload,Buffer.from('invalid trailing bytes')]),headers);
    assert([200,400].includes(malformed.status));
    await new Promise(resolve=>setImmediate(resolve));
    const healthy=await request('GET',null,{'Accept-Encoding':'gzip'});assert.equal(healthy.status,200);
    assert.equal(healthy.headers['content-encoding'],'gzip');assert.equal(JSON.parse(zlib.gunzipSync(healthy.bytes)).ok,true);
   }catch(e){console.error(e.message);process.exitCode=1;}finally{server.close();}
  });`;
 const result=spawnSync(process.execPath,['-e',source],{cwd:__dirname,encoding:'utf8',timeout:10000,
  env:{PATH:process.env.PATH,BOT_SAFE_START:'on'}});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});
test('patched sanitizer preserves ordinary content and rejects dangerous markup and recursive iframe fallback',()=>{
 const sanitize=require('sanitize-html');
 const clean=sanitize('<p>Culture <strong>locale</strong></p><a href="javascript:alert(1)">lien</a><script>bad()</script>');
 assert(clean.includes('<strong>locale</strong>'));assert(!clean.includes('javascript:'));assert(!clean.includes('<script'));
 assert.doesNotThrow(()=>sanitize('<iframe>'.repeat(2000)));
 const qs=require('qs');assert.equal(qs.stringify({source:['reunion','paris']}),'source%5B0%5D=reunion&source%5B1%5D=paris');
});

test('actual article extraction keeps readable content with the patched HTML parser, without network',async()=>{
 const previous=globalThis.fetch;
 globalThis.fetch=async()=>{throw new Error('External network forbidden in this fixture');};
 try{
  const {extractFromHtml}=await import('@extractus/article-extractor');
  const text='Cette rencontre culturelle présente une exposition et une conférence au musée. Le public découvre les collections et échange avec les organisateurs. ';
  const html='<html><head><title>Rencontre au musée</title></head><body><article><h1>Rencontre au musée</h1>'+Array.from({length:12},()=>'<p>'+text+'</p>').join('')+'</article><script>bad()</script></body></html>';
  const article=await extractFromHtml(html,'https://fixture.invalid/culture');
  assert(article);assert(article.content.includes('Cette rencontre culturelle'));assert(!article.content.includes('<script'));
 }finally{globalThis.fetch=previous;}
});
