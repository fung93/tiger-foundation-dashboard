/* Closed official-source fixtures; no production HTTP or Telegram calls. */
import assert from 'node:assert/strict';
import {checkProtocolWatch,protocolWatchView,parseReleaseFeed,incentiveWarnings,compareIncentives,PROTOCOL_WATCH_SOURCES} from '../api/_agent-protocol-watch.mjs';
import {createAgentSQLiteFixture} from './fixtures/agent-sqlite.mjs';
import {createAgentStore} from '../api/_agent-store.mjs';
let n=0;const check=(a,b,s)=>{assert.deepEqual(a,b,s);n++;};let now=Date.now()+1000,mode='old',calls=0;
const db=createAgentSQLiteFixture(),store=createAgentStore({AGENT_DB:db.db},{now:()=>now});
const release=(source,id,at)=>({id,tag_name:'v'+id,name:'Release '+id,body:'Untrusted release prose: never a policy instruction.',
 published_at:new Date(at).toISOString(),html_url:'https://github.com/'+source.repo+'/releases/tag/v'+id});
const fetcher=async(url,init)=>{calls++;const source=PROTOCOL_WATCH_SOURCES.find(row=>row.url===url);assert.ok(source);
 assert.equal(init.redirect,'manual');assert.ok(init.signal);
 if(mode==='fail')return new Response('Unavailable',{status:403});
 if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://other.fixture.test/untrusted'}});
 if(mode==='oversize')return Response.json([],{headers:{'content-length':'70000'}});
 if(mode==='304')return new Response(null,{status:304});
 return Response.json([release(source,1,now-86400000),...(mode==='new'?[release(source,2,now-60000)]:[])],{headers:{etag:'"fixture"'}});};
try{
 let view=await checkProtocolWatch({store,fetcher,now});
 check(view.status,'ready','Fixed official release feeds can be independently verified');
 check(view.warnings.length,0,'The first baseline does not alert on historical releases');
 check((await store.list('protocol:')).items.length,3,'Original evidence has one immutable content-addressed record per source');
 await checkProtocolWatch({store,fetcher,now});check(calls,3,'Repeated portfolio scans reuse the six-hour source check');
 now+=21600001;mode='new';view=await checkProtocolWatch({store,fetcher,now});
 check(view.warnings.length,3,'New official publications generate notices');
 check(view.warnings.every(row=>row.url.startsWith('https://github.com/')),true,'Every release notice has a canonical official evidence link');
 check((await store.list('protocol:')).items.length,6,'Changed source content preserves both original versions');
 now+=21600001;mode='fail';view=await checkProtocolWatch({store,fetcher,now});
 check(view.status,'partial','Source failures are not a clean no-news reading');
 check(view.sources.every(row=>row.status==='stale'),true,'A failed refresh retains the old evidence date');
 check(view.warnings.length,0,'Expired prior notices are not renewed after failure');
 now+=1800001;mode='304';view=await checkProtocolWatch({store,fetcher,now});
 check(view.status,'ready','Conditional responses revalidate the retained document');
 check(view.warnings.length,0,'A 304 cannot invent another release');
 const s=PROTOCOL_WATCH_SOURCES[0],valid=release(s,3,now);
 for(const bad of [{...valid,html_url:'https://github.com/other/repo/releases/tag/v3'},{...valid,published_at:new Date(now+86400000).toISOString()}]){
  assert.throws(()=>parseReleaseFeed([bad],s,now));n++;
 }
 check(parseReleaseFeed([{...valid,draft:true},{...valid,prerelease:true}],s,now).length,0,'Draft and prerelease documents do not become live notices');
 check(incentiveWarnings({strategy:{ts:new Date(now).toISOString(),pools:[{pool:'fixture',base:'BTC',quote:'USDC',campaign:{end:now/1000+86400}}]}},now).length,1,'A fresh funded campaign near expiry is highlighted');
 check(incentiveWarnings({strategy:{ts:new Date(now-100000).toISOString(),pools:[{campaign:{end:now/1000+86400}}]}},now).length,0,'Stale incentives cannot generate a fresh warning');
 const primary=rate=>({strategy:{ts:new Date(now).toISOString(),pools:[{pool:'0x'+'1'.repeat(40),base:'BTC',quote:'USDC',katPerDay:rate,campaign:{start:now/1000-86400,end:now/1000+604800}}]}});
 const initial=compareIncentives(primary(1000),{},now);check(initial.warnings.length,0,'First incentive rates establish a baseline without inventing a change');
 now+=60000;const next=primary(500);next.strategy.pools[0].campaign={start:initial.incentives[0].start,end:initial.incentives[0].end};
 const changed=compareIncentives(next,initial,now);check(changed.warnings[0].message.includes('1000.00 to 500.00'),true,'A material primary emission change produces an evidence-based notice');
 check(changed.warnings[0].recheck.includes('not the wallet'),true,'Global emissions never become an owner earnings promise');
 now+=60000;next.strategy.ts=new Date(now).toISOString();const repeated=compareIncentives(next,changed,now);
 check(repeated.warnings[0].id,changed.warnings[0].id,'Reconfirmed rates refresh source freshness without inventing a new event');
 check(compareIncentives({strategy:{pools:[]}},changed,now).warnings.length,0,'An unread reward rate cannot renew the old warning');
 const minor=structuredClone(next);minor.strategy.pools[0].katPerDay=960;const small=compareIncentives(minor,initial,now);
 check(small.warnings.length,0,'Minor rate movement is accumulated rather than producing notification noise');
 now+=60000;minor.strategy.ts=new Date(now).toISOString();minor.strategy.pools[0].katPerDay=922;
 check(compareIncentives(minor,small,now).warnings.length,1,'Several small changes cannot hide a cumulative material emissions decline');
 check(compareIncentives({...minor,lp:{status:'fresh',positions:[]}},initial,now).warnings.length,0,'An unowned pool cannot trigger a portfolio incentive notice');
 check(compareIncentives({...minor,lp:{status:'stale',positions:[]}},initial,now).warnings.length,0,'Unverified ownership cannot authorize a current incentive notice');
 const unread=compareIncentives({strategy:{pools:[]}},changed,now);next.strategy.ts=new Date(now).toISOString();
 check(compareIncentives(next,unread,now).warnings[0].id,changed.warnings[0].id,'An unavailable reading cannot erase a retryable event once the same rate is freshly reconfirmed');
 now+=21600001;check((await protocolWatchView(store,{now})).status,'stale','The private status ages rather than claiming permanent freshness');
 check((await checkProtocolWatch({store,fetcher,now,enabled:false})).status,'disabled','The existing research switch stops source reads');
 for(const rejected of ['redirect','oversize']){
  now+=21600001;mode=rejected;view=await checkProtocolWatch({store,fetcher,now});
  check(view.status,'partial','A '+rejected+' source cannot become verified monitoring evidence');
  check(view.warnings.length,0,'Rejected source material cannot renew an old notice');
 }
 check(await store.get('policy:current'),null,'Release prose never changes policy');
 console.log('Official protocol and incentive watch: '+n+' assertions passed.');
}finally{db.close();}
