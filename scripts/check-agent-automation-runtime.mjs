/* Optional real workerd/Workflow/local-D1 acceptance test. All outbound APIs,
   wallet readings and Telegram deliveries are closed hypothetical fixtures. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reviewPool} from './fixtures/agent-review.mjs';
import {multipleLPFetcher,robinhoodLPFixture} from './fixtures/agent-auto-multiple.mjs';
import {fundingFixture} from './fixtures/agent-lp-autofill.mjs';
if(!process.argv[2])throw Error('Pass the validation node_modules directory.');
const runtime=createRequire(join(resolve(process.argv[2]),'__automatic_runtime__.cjs'));
const {Miniflare,convertV4MiniflareOptions,Log,LogLevel}=runtime('miniflare'),{build}=runtime('esbuild');
const root=fileURLToPath(new URL('../',import.meta.url)),config=JSON.parse(readFileSync(join(root,'cloudflare/wrangler.jsonc'),'utf8').replace(/^\s*\/\/.*$/gm,''));
const built=await build({stdin:{resolveDir:root,sourcefile:'automatic-native-fixture.mjs',contents:`
 import worker,{PortfolioReviewWorkflow as RealWorkflow} from './cloudflare/runtime.mjs';
 export class PortfolioReviewWorkflow extends RealWorkflow{
  async run(event,realStep){
   const db=this.env.AGENT_DB,originals=new WeakMap();let queries=0;
   const wrap=statement=>{const proxy=new Proxy(statement,{get(target,key){
    if(key==='bind')return(...args)=>wrap(target.bind(...args));
    if(['first','all','run'].includes(key))return(...args)=>{queries++;return target[key](...args);};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
   }});originals.set(proxy,statement);return proxy;};
   this.env.AGENT_DB={prepare:sql=>wrap(db.prepare(sql)),batch:values=>{queries++;return db.batch(values.map(value=>originals.get(value)||value));}};
   this.env.AI={run(){throw Error('An observational workflow must not invoke AI');}};
   const step={do:(name,options,operation)=>realStep.do(name,options,async()=>{queries=0;const value=await operation();
    if(queries>50)throw Error('Free D1 invocation budget exceeded');
    await db.prepare('INSERT INTO fixture_steps(name,queries) VALUES (?,?)').bind(name,queries).run();return value;})};
   return super.run(event,step);
  }
 }
 export default {...worker,async fetch(request,env,context){
  if(new URL(request.url).pathname==='/fixture/status')return Response.json(await(await env.PORTFOLIO_REVIEWS.get(new URL(request.url).searchParams.get('id'))).status());
  return worker.fetch(request,env,context);
 }};
`},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
const env={AGENT_ORIGIN:'https://review.fixture.test',AGENT_ACCESS_KEY:'fixture-automatic-owner-at-least-24',
 AGENT_GATEWAY_SECRET:'fixture-automatic-gateway-at-least-24',CRON_SECRET:'fixture-automatic-cron-at-least-24',TELEGRAM_BOT_TOKEN:'fixture-native-only'};
let count=0;const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;},calls=[],sent=[];
const options={modules:true,script:built.outputFiles[0].text,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
 bindings:env,d1Databases:['AGENT_DB'],workflows:convertV4MiniflareOptions?{PORTFOLIO_REVIEWS:{name:'tiger-portfolio-review',className:'PortfolioReviewWorkflow'}}
 :[{name:'tiger-portfolio-review',className:'PortfolioReviewWorkflow',bindingName:'PORTFOLIO_REVIEWS'}],log:new Log(LogLevel.ERROR),
 outboundService:async request=>{
  const url=new URL(request.url),now=Date.now();
  if(url.origin==='https://api.telegram.org'){check(url.pathname.endsWith('/sendMessage'),true,'Native delivery only sends a message; no webhook mutation');
   sent.push(JSON.parse(await request.text()));return Response.json({ok:true,result:{message_id:sent.length}});}
  if(url.origin!==env.AGENT_ORIGIN)throw Error('Unapproved fixture outbound origin');
  const view=url.searchParams.get('view');
  if(view==='agent-wallet'){const chain=url.searchParams.get('chain');return Response.json({schemaVersion:'agent-wallet-observation-v1',chain,status:'fresh',block:100,
   observedAt:new Date(now).toISOString(),balances:[{chain,owner:'0x'+'0'.repeat(38)+'10',symbol:'USD',raw:'1000000',decimals:6,amount:1,valueUsd:1,
    status:'observed',block:100,observedAt:new Date(now).toISOString()}]});}
  if(view==='agent-pool')return Response.json({...(url.searchParams.get('chain')==='robinhood'?robinhoodLPFixture(now).pool:reviewPool(now)),
   schemaVersion:'agent-pool-observation-v1',chain:url.searchParams.get('chain'),status:'fresh',
   observedAt:new Date(now).toISOString(),block:100,recent:{},accounting:{valuationBlockPinned:true}});
  if(view==='lp-funding')return Response.json(fundingFixture(url.searchParams.get('owner'),now));
  if(url.pathname==='/api/vkat')return Response.json({at:now/1000,head:100,head_ts:now/1000,health:{notes:[]},kat_usd:.01,
   locks:[],standing:[],book:{epochs:[],total_usd:0,claimed:false},network:{locked:0,locks:0,kat_supply:100,avkat_supply:0,avkat_kat:0,avkat_rate:1}});
  if(url.pathname==='/api/kat-trades')return Response.json({});
  if(url.pathname==='/api/fables')return Response.json({at:new Date(now).toISOString(),lps:[],locks:[],fables_usd:1});
  const source=await multipleLPFetcher(now,calls)(request.url);
  return url.pathname==='/api/strategy'?Response.json({...await source.json(),kat_usd:.01}):source;
 }};
const mf=new Miniflare(convertV4MiniflareOptions?{...convertV4MiniflareOptions(options),telemetry:{enabled:false}}:options);let cookie='';
const request=async body=>{const response=await mf.dispatchFetch('https://worker.fixture.test/api/agent',{method:'POST',headers:{origin:env.AGENT_ORIGIN,
 'content-type':'application/json','x-agent-gateway-secret':env.AGENT_GATEWAY_SECRET,...(cookie?{cookie}:{})},body:JSON.stringify(body)});
 return{status:response.status,headers:response.headers,value:await response.json()};};
try{
 const db=await mf.getD1Database('AGENT_DB');
 for(const name of ['0001_agent.sql','0002_agent_usage.sql','0003_agent_storage.sql'])for(const statement of readFileSync(join(root,'cloudflare/migrations',name),'utf8')
  .replace(/^\s*--.*$/gm,'').match(/\s*(?:CREATE TRIGGER[\s\S]*?END\s*;|[^;]+;)/gi)||[])await db.prepare(statement).run();
 await db.prepare('CREATE TABLE fixture_steps(name TEXT,queries INTEGER)').run();
 await db.prepare('INSERT INTO agent_state(key,value,expires_at) VALUES (?,?,NULL)').bind('tiger:agent:v1:telegram',JSON.stringify({chatId:'123456',userId:'123456'})).run();
 let response=await request({action:'automaticStatus'});check(response.status,401,'Automatic observations remain behind the actual owner session');
 response=await request({action:'automaticRun'});check(response.status,401,'An anonymous visitor cannot trigger background wallet reads');
 check(calls.length+sent.length,0,'Unauthenticated requests touch neither providers nor the bot');
 response=await request({action:'login',accessKey:env.AGENT_ACCESS_KEY});check(response.status,200,'The existing owner login works unchanged');
 cookie=response.headers.get('set-cookie').split(';')[0];
 response=await request({action:'automaticRun'});check(response.status,200,'The owner starts a check with no policy or financial form');
 check(response.value.status,'queued','The authenticated request queues the real Workflow instead of doing long work inline');
 const id=response.value.workflowId;let workflow;
 for(let i=0;i<150;i++){
  workflow=await(await mf.dispatchFetch('https://worker.fixture.test/fixture/status?id='+id)).json();
  if(['complete','errored','terminated'].includes(workflow.status))break;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 check(workflow.status,'complete','The actual automatic Workflow finishes in native workerd/local D1');
 response=await request({action:'automaticStatus'});
 check(response.value.lastScheduledAttempt,null,'A successful manual check never masquerades as a verified Cron invocation');
 if(response.value.latest?.positions?.length!==2)console.log(JSON.stringify({fixtureDiagnostic:{workflow:workflow.status,
   status:response.value.status,sources:response.value.latest?.sources,stages:(await db.prepare('SELECT name,queries FROM fixture_steps').all()).results,calls}}));
 check(response.value.latest.positions.length,2,'The native runtime detects both a staked Katana LP and a Robinhood LP');
 check(response.value.latest.reply.includes('katana #1001'),true,'The automatic brief visibly includes the staked Katana position');
 check(response.value.latest.reply.includes('robinhood #2002'),true,'The same brief visibly includes the Robinhood position');
 check(response.value.latest.wallets.length,4,'All configured wallet-chain adapters are polled');
 check(response.value.latest.positions.find(row=>row.position.chain==='katana').range.selected.days,14,'The real runtime uses labelled observational defaults');
 check(response.value.latest.reply.includes('before borrowing costs'),true,'Concise native replies retain financing scope');
 check(sent.length,1,'The original linked owner receives one short manual update');
 check(sent[0].chat_id,'123456','No pending result is addressed to another recipient');
 check(sent[0].text.includes('katana #1001')&&sent[0].text.includes('robinhood #2002'),true,'The actual outgoing Telegram brief includes both chains and LP identities');
 check((await db.prepare('SELECT COUNT(*) AS n FROM agent_usage').first()).n,0,'The real scheduled observation path reserves no AI inference');
 check((await db.prepare('SELECT COUNT(*) AS n FROM agent_state WHERE key=?').bind('tiger:agent:v1:policy:current').first()).n,0,'No default risk mandate is written to the real database');
 const stages=await db.prepare('SELECT name,queries FROM fixture_steps').all();
 check(stages.results.some(row=>row.name==='observe-other-defi'),true,'Separate staking and DeFi observations run in their own bounded step');
 check(stages.results.some(row=>row.name==='observe-position-0'),true,'Actual LP scenarios and durable range evidence are calculated');
 const peak=Math.max(...stages.results.map(row=>row.queries));check(peak<=50,true,'Each actual invocation stays within the Free D1 query ceiling');
 check((await db.prepare("SELECT COUNT(*) AS n FROM agent_state WHERE key LIKE 'tiger:agent:v1:automation:context:%'").first()).n,0,'The native runner cleans temporary payloads after success');
 response=await request({action:'automaticSettings',enabled:false,expectedRevision:0});check(response.value.status,'paused','The owner can pause without editing strategy policy');
 response=await request({action:'automaticRun'});check(response.value.status,'paused','An explicit operational pause is respected');
 console.log('Native automatic portfolio/LP workflow: '+count+' assertions passed; max '+peak+' D1 queries/stage. No real provider was contacted.');
}finally{await mf.dispose();}
