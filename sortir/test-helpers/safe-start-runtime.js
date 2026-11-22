"use strict";
// Full application sources in an isolated VM. All fs writes, network, SDKs, processes
// and timers are fake. Never import the live entry points via Node's normal require.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
function fixtureRuntime(extraEnv = {}) {
  const env = { RENDER: 'true', OPENAI_API_KEY: 'offline-ai', YOUTUBE_API_KEY: 'offline-youtube',
    SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SECRET_KEY: 'offline-supabase',
    SORTIR_MONITOR_SUPABASE_URL:'https://monitor.invalid',SORTIR_MONITOR_PUBLISHABLE_KEY:'sb_publishable_offline',
    SORTIR_MONITOR_ACCESS_TOKEN:[{alg:'HS256'},{role:'sortir_monitor_reader',iss:'https://monitor.invalid/auth/v1',exp:Date.parse('2030-01-01')/1000}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.')+'.offline', ...extraEnv };
  let now = Date.parse('2026-11-20T00:05:00Z'), seq = 0;
  const timers = new Map(), contexts = [], apps = [], calls = [], fileWrites = [], children = [];
  const files = new Map(), restored = new Map();
  const allDays = [0,1,2,3,4,5,6];
  const pending = [{ id: 'pending-test', status: 'pending', runAt: '2026-11-19T00:00:00Z', debateId: 1, subject: 'Offline', judgment: {}, compactContents: [] }];
  for (const name of ['sessions-mixte.json','saved-subjects.json','sent-to-agon.json','sent-opinions-to-agon.json',
    'certamen-sessions.json','veille-mixte.json','youtube-chaines.json','medias.json']) files.set(name,'[]');
  for (const name of ['auto-collect-config.json','auto-collect-certamen-config.json']) files.set(name,JSON.stringify({ enabled:true, entries:[{time:'04:10',days:allDays}] }));
  for (const name of ['auto-publish-config.json','auto-publish-certamen-config.json']) files.set(name,'{"enabled":true}');
  for (const name of ['pending-ideas.json','certamen-pending-ideas.json','certamen-pending-creative.json']) files.set(name,JSON.stringify(pending));
  files.set('youtube-api-state.json','{"sources":{},"videos":{}}');
  const originalFiles = new Map(files);
  const businessCalls = () => calls.filter(c => !['storage-list','storage-download','sql-read','listen','spawn'].includes(c.kind));
  const virtualFs = {
    existsSync(p) { return files.has(path.basename(p)); },
    statSync(p) { const b=path.basename(p); if(!files.has(b))throw Error('ENOENT'); return {size:Buffer.byteLength(files.get(b)),mtimeMs:1}; },
    readFileSync(p,encoding) { const b=path.basename(p); if(!files.has(b))throw Error('ENOENT '+b); return encoding ? files.get(b) : Buffer.from(files.get(b)); },
    writeFileSync(p,content) {
      const b=path.basename(p), text=String(content), restore=restored.get(b)===text;
      fileWrites.push({name:b,restore,operational:['storage-sync-state.json','.bot-veille-runtime.json'].includes(b)});
      files.set(b,text); restored.delete(b);
    },
    appendFileSync(p) { calls.push({kind:'append-file',name:path.basename(p)}); },
    createWriteStream() { return {write(){},end(){}}; },
    renameSync(a,b) { files.set(path.basename(b),files.get(path.basename(a)));files.delete(path.basename(a)); },
    unlinkSync(p) { files.delete(path.basename(p)); }
  };
  const tables={sortir_sources:[],sortir_source_runs:[],sortir_ingestion_runs:[
    {id:'be127190-19a4-4f50-b615-7a9a78b8ff14',orchestrator_version:'sortir-scheduler-lock-v1',status:'completed',started_at:'2026-11-20T00:00:00Z'},
    {id:'caa4ae36-7a50-464a-aaed-52b1f14523e7',orchestrator_version:'sortir-ingestion-v1',status:'running',started_at:'2026-11-10T10:05:19.738Z'}]};
  function query(table) {
    const filters=[];let single=false,limit=Infinity;
    const q={retry(enabled){if(enabled!==false)throw Error('Monitoring retries must be disabled');return q;},select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},neq(k,v){filters.push(r=>r[k]!==v);return q;},
      gte(k,v){filters.push(r=>r[k]>=v);return q;},limit(n){limit=n;return q;},order(){return q;},maybeSingle(){single=true;return q;},abortSignal(){return q;},
      then(resolve,reject){calls.push({kind:'sql-read',table});const rows=(tables[table]||[]).filter(r=>filters.every(f=>f(r))).slice(0,limit);return Promise.resolve({data:single?rows[0]||null:rows,error:null}).then(resolve,reject);}};
    for(const method of ['insert','update','upsert','delete'])q[method]=()=>{calls.push({kind:'sql-write',table,method});throw Error('SQL write attempted in fake runtime');};
    return q;
  }
  const supabase={from:query,storage:{from(){return {
    async list(){calls.push({kind:'storage-list'});return {data:[...originalFiles.keys()].map(name=>({name,updated_at:'fixture-v1'})),error:null};},
    async download(name){calls.push({kind:'storage-download',name});const text=originalFiles.get(name)||'[]';restored.set(name,text);return {data:{text:async()=>text},error:null};},
    async upload(name){calls.push({kind:'storage-upload',name});return {error:null};}
  };}}};
  const routeApps=[];
  function express() {
    const app={middlewares:[],routes:[],use(...handlers){this.middlewares.push(...handlers.filter(h=>typeof h==='function'));return this;},
      listen(...args){const cb=args.at(-1);this.port=args[0];calls.push({kind:'listen',port:args[0]});if(typeof cb==='function')cb();return {on(){}};}};
    for(const method of ['get','post','put','delete','patch','options','head'])app[method]=function(route,...handlers){this.routes.push({method:method.toUpperCase(),route,handlers});return this;};
    routeApps.push(app);apps.push(app);return app;
  }
  const pass=(req,res,next)=>next();express.json=()=>pass;express.static=()=>pass;express.urlencoded=()=>pass;
  function setTimer(fn,delay=0,repeat=false) {const id=++seq;timers.set(id,{fn,at:now+Math.max(1,Number(delay)||0),repeat,delay:Math.max(1,Number(delay)||0)});return id;}
  const sandboxConsole={log(){},warn(){},error(){}};
  function loadProcess(entry,processEnv={...env}) {
    const cache=new Map();const appStart=routeApps.length;
    class ClockDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
    const fakeProcess={env:processEnv,argv:['node',path.join(ROOT,entry)],pid:100+contexts.length,ppid:99,cwd:()=>ROOT,
      on(){},kill(){throw Error('Unexpected process kill');},exit(code){throw Error('Unexpected process exit '+code);},memoryUsage:()=>({rss:1,heapUsed:1})};
    const context=vm.createContext({console:sandboxConsole,process:fakeProcess,Buffer,URL,URLSearchParams,Headers,Request,Response,AbortController,AbortSignal,
      Date:ClockDate,setTimeout:(fn,n)=>setTimer(fn,n),setInterval:(fn,n)=>setTimer(fn,n,true),clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),
      setImmediate:fn=>setTimer(fn,1),fetch:async(url,options)=>{calls.push({kind:'fetch',url:String(url),method:options?.method||'GET'});throw Error('Fake external network only');}});
    function load(filename) {
      filename=path.resolve(filename);if(cache.has(filename))return cache.get(filename).exports;
      if(filename.endsWith('.json'))return JSON.parse(fs.readFileSync(filename,'utf8'));
      const module={exports:{},filename};cache.set(filename,module);
      const req=name=>{
        if(name==='fs'||name==='node:fs')return virtualFs;
        if(name==='dotenv')return {config(){return{};}};
        if(name==='express')return express;
        if(name==='compression')return ()=>pass;
        if(name==='openai')return class {constructor(){this.responses={create:async()=>{calls.push({kind:'ai'});throw Error('Fake AI only');}};this.chat={completions:this.responses};}};
        if(name==='rss-parser')return class {async parseURL(){calls.push({kind:'rss'});return {items:[]};}};
        if(name==='@supabase/supabase-js')return {createClient:()=>supabase};
        if(name==='@extractus/article-extractor')return {extract:async()=>{calls.push({kind:'extract'});return null;}};
        if(name==='youtube-transcript')return {fetchTranscript:async()=>{calls.push({kind:'transcript'});return [];}};
        if(name==='child_process'||name==='node:child_process')return {execFileSync(){return '';},spawn(command,args,options){
          calls.push({kind:'spawn',command,args});const inherited={...(options.env||processEnv)},listeners=new Map();
          const child={pid:201+children.length,stdout:{setEncoding(){},on(){}},stderr:{setEncoding(){},on(){}},
            on(event,fn){listeners.set(event,fn);},emit(event,...values){return listeners.get(event)?.(...values);}};
          children.push({args,env:inherited,child});loadProcess(args.at(-1),inherited);return child;
        }};
        if(name.startsWith('.')) {
          const resolved=require.resolve(path.resolve(path.dirname(filename),name));
          if(resolved===path.join(ROOT,'youtube-api.js'))return {loadStore:()=>({videos:{},sources:{}}),createApi:()=>({}),collectApi:async()=>{calls.push({kind:'youtube-collect'});return[];},saveStore(){calls.push({kind:'youtube-save'});},consumeQuota(){calls.push({kind:'youtube-quota'});}};
          if(resolved===path.join(ROOT,'sortir-auto-ingest.js'))return {runSortirIngestTickIfDue:async()=>{calls.push({kind:'sortir-ingest'});return{};},
            OPENAGENDA_SOURCES:[{key:'senlis'}],REUNION_SOURCES:[{key:'reunion'}],PARIS_SOURCES:[{key:'paris'}]};
          return load(resolved);
        }
        if(['path','crypto','node:crypto','dayjs','string-similarity'].includes(name))return require(name);
        throw Error('Unexpected runtime dependency: '+name+' in '+filename);
      };
      req.resolve=name=>require.resolve(path.resolve(path.dirname(filename),name));
      const source=fs.readFileSync(filename,'utf8');
      vm.runInContext('(function(exports, require, module, __filename, __dirname){'+source+'\n})',context,{filename})(module.exports,req,module,filename,path.dirname(filename));
      return module.exports;
    }
    const exports=load(path.join(ROOT,entry));const result={entry,env:processEnv,load,exports,apps:routeApps.slice(appStart),context};contexts.push(result);return result;
  }
  async function settle(){for(let i=0;i<250;i++)await Promise.resolve();}
  async function advance(ms){const end=now+ms;let runs=0;while(true){await settle();const next=[...timers.entries()].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;if(++runs>10000)throw Error('Timer runaway');const[id,t]=next;now=t.at;timers.delete(id);if(t.repeat)timers.set(id,{...t,at:now+t.delay});await t.fn();}now=end;await settle();}
  async function request(app,method,url,{body={},query={},cookies={}}={}) {
    const parsed=new URL(url,'http://fixture.invalid'),pathname=parsed.pathname;
    const req={method,path:pathname,originalUrl:parsed.pathname+parsed.search,query:{...Object.fromEntries(parsed.searchParams),...query},body,cookies,headers:{},get:()=>''};
    const res={statusCode:200,headers:{},finished:false,set(k,v){this.headers[k]=v;return this;},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},
      json(value){this.payload=value;this.finished=true;return this;},send(value){this.payload=value;this.finished=true;return this;},redirect(url){this.statusCode=302;this.payload=url;this.finished=true;return this;}};
    const route=app.routes.find(r=>r.method===method&&r.route===pathname);
    const handlers=[...app.middlewares,...(route?.handlers||[])];
    let index=0;const next=async()=>{const handler=handlers[index++];if(handler&&!res.finished)await handler(req,res,next);};
    await next();await settle();return res;
  }
  return {env,calls,fileWrites,children,apps,tables,files,timers,contexts,businessCalls,loadProcess,settle,advance,request};
}
module.exports={fixtureRuntime};
