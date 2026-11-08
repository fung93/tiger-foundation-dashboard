/* Durable Telegram retry, fresh authorization and independent risk priority. */
import assert from 'node:assert/strict';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { deliverAutomaticNotices } from '../api/_agent-auto-delivery.mjs';
let count=0,now=Date.now()+86400000,failed=false,sent=0;
const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;},fixture=createAgentSQLiteFixture();
const store=createAgentStore({AGENT_DB:fixture.db},{now:()=>now}),env={AGENT_ORIGIN:'https://automatic-delivery.fixture.test',TELEGRAM_BOT_TOKEN:'fixture-only'};
const item=()=>({id:'fixture-risk',trigger:'alert',positionKey:'position-key',condition:'near_edge',text:'Fixture LP market alert',chatId:'123',userId:'123',
  controlsRevision:0,policyVersion:0,expiresAt:new Date(now+86400000).toISOString(),validUntil:new Date(now+90000).toISOString(),sentParts:0});
const reset=async()=>{
  await store.set('settings',{});await store.set('telegram',{chatId:'123',userId:'123'});await store.del('monitor:pending');
  await store.set('automation:pending',[item()]);await store.set('alerts',[{id:'fixture-risk',telegramSent:false}]);
  await store.set('automation:latest',{positions:[{key:'position-key',current:true,conditions:{near_edge:{active:true}},market:{ts:new Date(now).toISOString()}}]});
};
const fetcher=async(url,options)=>{check(String(url).startsWith('https://api.telegram.org/'),true,'Only the fixed Telegram API receives a delivery request');
  check(JSON.parse(options.body).chat_id,'123','A queued notice cannot choose a different recipient');
  sent++;if(failed)throw Error('Synthetic outage');return Response.json({ok:true,result:{message_id:sent}});};
const run=(extra={})=>deliverAutomaticNotices({store,env,fetcher,now:()=>now,...extra});
const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No real Telegram in delivery checks');};
try{
  await reset();failed=true;let result=await run();
  check(result.status,'queued','An unknown bot outcome preserves a retryable notice');
  check((await store.get('automation:pending')).length,1,'A provider failure does not discard the alert');
  check((await store.get('automation:pending'))[0].sentParts,0,'An unacknowledged external send is not recorded as delivered');
  failed=false;result=await run();check(result.status,'sent','The same notice is delivered after recovery');
  check((await store.get('automation:pending')).length,0,'A confirmed notice leaves the queue');
  check((await store.get('alerts'))[0].telegramSent,true,'The private alert records the acknowledged delivery');
  await reset();await store.set('telegram',{chatId:'456',userId:'456'});const before=sent;result=await run();
  check(result.status,'cancelled','Unlinking or replacing the recipient cancels old pending notices');check(sent,before,'A replacement never inherits another chat’s pending alert');
  await reset();await store.set('settings',{alertsEnabled:false});result=await run();
  check(result.status,'cancelled','Current notification preferences are rechecked before delivery');
  await reset();const latest=await store.get('automation:latest');latest.positions[0].conditions.near_edge.active=false;await store.set('automation:latest',latest);
  result=await run();check(result.status,'cancelled','A recovered market condition is never sent as a current warning');
  await reset();const old=item();old.validUntil=new Date(now-1).toISOString();await store.set('automation:pending',[old]);
  result=await run();check(result.status,'cancelled','An expired quote cannot authorize a queued market alert');
  await reset();await store.set('monitor:pending',{kind:'risk',items:[{}]});result=await run();
  check(result.status,'risk_delivery_first','Existing independent risk alerts keep delivery priority');
  check((await store.get('automation:pending')).length,1,'Yielding to a risk alert retains the automatic checkpoint');
  await reset();result=await run({env:{AGENT_ORIGIN:env.AGENT_ORIGIN}});
  check(result.status,'configuration_missing','A missing bot secret is identified without exposing its value');
  check((await store.get('automation:pending')).length,1,'A temporary missing bot configuration does not silently lose an alert');
  await reset();const acknowledged=item();acknowledged.sentParts=1;await store.set('automation:pending',[acknowledged]);
  const prior=sent;result=await run();check(sent,prior,'A saved acknowledgement avoids replaying an accepted part after restart');
  check(result.status,'sent','An already acknowledged notice can finish its durable bookkeeping');
  console.log('Automatic Telegram delivery and recovery: '+count+' assertions passed.');
}finally{fixture.close();globalThis.fetch=originalFetch;}
