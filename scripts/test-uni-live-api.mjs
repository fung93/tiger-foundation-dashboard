import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {uniFixture} from './fixtures/uni.mjs';
import handler from '../api/uni.mjs';
let n=0;const eq=(a,b,m)=>{assert.deepEqual(a,b,m);n++;},ok=(v,m)=>{assert.ok(v,m);n++;};
const originalFetch=globalThis.fetch,originalNow=Date.now,now=Math.floor(Date.now()/1000),fixtures=Object.fromEntries(['base','bnb'].map(k=>[k,uniFixture(k,{now})]));
let offset=0,offline=false,requests=0,logs=0,started,release;
const historyStarted=new Promise(r=>{started=r;}),historyWait=new Promise(r=>{release=r;});
const res=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(v){this.body=JSON.parse(JSON.stringify(v));return this;}});
try{
 Date.now=()=>originalNow()+offset;
 globalThis.fetch=async(url,options)=>{
  requests++;if(offline)return new Response('',{status:503});const f=Object.values(fixtures).find(f=>f.chain.rpcs.includes(url));if(!f)throw Error('Unexpected UNI source');
  const q=JSON.parse(options.body);if(q.method==='eth_getLogs'){logs++;started();await historyWait;}
  return Response.json({result:await f.rpc(q.method,q.params)});
 };
 const slow=res(),history=handler({method:'GET',query:{}},slow);await historyStarted;
 const before=logs,a=res(),b=res();
 await Promise.race([Promise.all([handler({method:'GET',query:{view:'live'}},a),handler({method:'GET',query:{view:'live'}},b)]),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Fast UNI request waited for history')),1000);t.unref();})]);
 eq(a.statusCode,200,'The public fast view works while the legacy history request is still running');eq(a.body,b.body,'Concurrent fast requests share one current reading');ok(a.body.chains.every(c=>c.quoteComplete),'Both source proofs are complete despite the waiting history');eq(logs,before,'The fast endpoint starts no additional archive/log scan');
 ok(a.headers['cache-control'].includes('s-maxage=3'),'Only three seconds of edge caching on live reads');ok(!a.headers['cache-control'].includes('stale-while-revalidate'),'Live replies cannot spend another stale window at the edge');
 const market=res();await handler({method:'GET',query:{view:'market'}},market);eq(market.body.schemaVersion,'uni-market-view-v1','Trade has a dedicated current-only envelope');eq(market.body.complete,true,'Wallet/quote refresh is independent of pending trade history');eq(market.body.wallets.length,4,'Both configured wallets on each network are included');
 const count=requests,again=res();await handler({method:'HEAD',query:{view:'market'}},again);eq(requests,count,'A short complete market cache protects public RPCs');
 const post=res();await handler({method:'POST',query:{view:'market'}},post);eq(post.statusCode,405,'Fast routes cannot mutate or sign');eq(requests,count,'A rejected mutation never reaches RPC');
 release();await history;eq(slow.statusCode,200,'The independent history request can finish normally');
 offset=4000;const withFees=res();await handler({method:'GET',query:{view:'live'}},withFees);ok(withFees.body.pools.every(p=>p.feeWindow?.verified),'Warm fee evidence reaches later fast reads');eq(withFees.body.pools[0].feeWindow.toTs,now,'Fee evidence keeps the observed period, not client time');
 offline=true;offset=8000;const fail=res();await handler({method:'GET',query:{view:'live'}},fail);eq(fail.statusCode,503,'A full source outage is explicit');eq(fail.headers['cache-control'],'no-store','Failures do not poison live caches');ok(fail.body.pools.every(p=>p.retained&&p.at===now),'Last good prices survive with their original timestamps');
 offline=false;const recovered=res();await handler({method:'GET',query:{view:'live'}},recovered);eq(recovered.statusCode,200,'The next request recovers immediately without waiting for a failure cache');ok(recovered.body.chains.every(c=>c.quoteComplete),'Recovery clears both current-source failure states');
}finally{release();globalThis.fetch=originalFetch;Date.now=originalNow;}
const listeners={},puts=[],cached=new Map(),origin='https://uni-worker.test';let workerOffline=false,workerReads=0;
vm.runInNewContext(readFileSync(new URL('../sw.js',import.meta.url),'utf8'),{
 self:{location:{origin},addEventListener:(name,fn)=>{listeners[name]=fn;}},URL,Response,Promise,
 caches:{open:async()=>({put:(key,value)=>{puts.push(key);cached.set(key,value);}}),match:async key=>cached.get(key)?.clone()},
 fetch:async req=>{workerReads++;if(workerOffline)throw Error('Offline');return Response.json({source:'network',at:456,path:req.url});},
});
async function workerRead(path){let answer;listeners.fetch({request:{method:'GET',mode:'cors',url:origin+path},respondWith:value=>{answer=value;}});return (await answer).json();}
for(const path of ['/uni-pools.json','/uni-strategy.json']){
 cached.set(origin+path,Response.json({source:'saved',at:123}));const value=await workerRead(path);
 eq(value.source,'network','UNI saved JSON is network-first, not frozen in the shell cache: '+path);
}
for(const view of ['live','market','trades','strategy'])await workerRead('/api/uni?view='+view);
eq(new Set(puts.filter(k=>k.includes('/api/uni?'))).size,4,'Offline cache keys preserve each distinct UNI response format');
workerOffline=true;const retained=await workerRead('/uni-pools.json');eq(retained.at,456,'Offline fallback keeps the actual saved source clock');ok(workerReads>=7,'Data and API requests attempted the network before fallback');
console.log(`UNI fast API isolation, three-second cache, history concurrency and recovery: ${n} assertions passed.`);
