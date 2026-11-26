import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import handler from '../api/uni.mjs';
import {advanceUniTradeFeed,emptyUniTradeBook,uniTradeFeedView,validUniTradeBook,readAvailableUniTradeView} from '../api/_uni-trades.mjs';
import {validUniTradeFeed,savedUniTradeFeed,mergeUniTradeFeeds} from '../uni-history.mjs';
import {UNI_CHAINS} from '../api/_uni-config.mjs';
import {uniTradeFixture,H,hex} from './fixtures/uni-trades.mjs';
import {uniStrategyReview} from './fixtures/uni-strategy-review.mjs';
let n=0;const eq=(a,b,m)=>{assert.deepEqual(a,b,m);n++;},ok=(v,m)=>{assert.ok(v,m);n++;},fx={base:uniTradeFixture('base'),bnb:uniTradeFixture('bnb',{entries:[]})},now=()=>fx.base.now*1000;
function source(){const book=emptyUniTradeBook();for(const [key,f]of Object.entries(fx))book.chains[key]={chainId:f.chain.id,uni:f.chain.uni.address,startBlock:f.head-100,cursor:f.head-60,cursorHash:H(f.head-60),head:f.head-60,ts:f.now-120,recentStart:f.head-100,recentCursor:f.head-60,recentHash:H(f.head-60),recentOpeningUni:{combined:'0'}};return book;}
const original=source(),frozen=structuredClone(original),result=await advanceUniTradeFeed(original,{rpcFactory:c=>fx[c.key].rpc,now});
eq(original,frozen,'The fast view never mutates the committed ledger');eq(result.complete,true,'Both recent UNI transfer intervals reach a verified head');eq(result.book.trades.length,2,'A direct UNI interval finds verified buys and sells');validUniTradeBook(result.book);n++;
for(const key of ['base','bnb']){eq(result.book.chains[key].cursor,original.chains[key].cursor,'Wallet-wide sender checkpoints remain independent');eq(result.book.chains[key].recentOpeningUni,original.chains[key].recentOpeningUni,'Skipping wallet valuation does not invent inventory coverage');}
ok(Object.values(fx).every(f=>f.calls.every(c=>!['eth_getTransactionCount','eth_getCode'].includes(c.method))),'The table never searches unrelated wallet transactions');
ok(Object.values(fx).every(f=>f.calls.filter(c=>c.method==='eth_call').every(c=>c.params[0].to!==f.chain.uni.address)),'Current balance and quote discovery do not delay trade discovery');
const view=uniTradeFeedView(result);ok(validUniTradeFeed(view),'The lightweight response has the complete table contract');eq(view.historyComplete,false,'Recent success cannot claim an archive backfill is complete');
eq(Object.keys(view.trades[0]).sort(),['id','chain','side','ts','uni','usd','price','verified'].sort(),'The visible response omits gas, routes, full receipts and settlement calculations');
const bytes=Buffer.byteLength(JSON.stringify(view)),fullBytes=Buffer.byteLength(JSON.stringify({...result,book:result.book,trades:result.book.trades,flows:result.book.flows}));ok(bytes<fullBytes*.6,'The small table response is less than 60% of the legacy full view');
const repeated=await advanceUniTradeFeed(result.book,{rpcFactory:c=>fx[c.key].rpc,now});eq(repeated.book.trades,result.book.trades,'Polling never duplicates or reprices a fill');
const failed=await advanceUniTradeFeed(source(),{rpcFactory:c=>c.key==='bnb'?async()=>{throw Error('BNB offline');}:fx.base.rpc,now});
eq(failed.complete,false,'One failed network is not marked live');eq(failed.book.trades.length,2,'BNB failure does not hide verified Base buys');ok(failed.checked.base&&!failed.checked.bnb&&failed.errors.bnb,'Current coverage and errors are per network');
let heads=0,release;const gate=new Promise(r=>{release=r;});
const parallel=await Promise.race([advanceUniTradeFeed(source(),{now,rpcFactory:c=>async(method,params)=>{if(method==='eth_blockNumber'){if(++heads===2)release();await gate;}return fx[c.key].rpc(method,params);}}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Chains were not started together')),1000);timer.unref();})]);
eq(parallel.complete,true,'Both chains start concurrently');
const missing=await advanceUniTradeFeed(source(),{now,rpcFactory:c=>async(method,params)=>method==='eth_getTransactionReceipt'&&c.key==='base'?null:fx[c.key].rpc(method,params)});
eq(missing.book.chains.base.recentCursor,original.chains.base.recentCursor,'An unavailable receipt cannot advance the interval');eq(missing.book.trades.length,0,'Unproven fills remain retryable');
const reorgSource=source();reorgSource.chains.base.recentHash=H(5);const reorg=await advanceUniTradeFeed(reorgSource,{rpcFactory:c=>fx[c.key].rpc,now});ok(reorg.errors.base?.includes('checkpoint changed'),'A reorg keeps the last verified cursor');
const stale=await advanceUniTradeFeed(source(),{rpcFactory:c=>fx[c.key].rpc,now:()=>now()+600000});eq(stale.complete,false,'An old head cannot claim the history was just checked');
const behind=source();behind.chains.base.head=fx.base.head+1;const lag=await advanceUniTradeFeed(behind,{rpcFactory:c=>fx[c.key].rpc,now});ok(lag.errors.base?.includes('behind'),'A lagging provider cannot roll the checkpoint back');
const bounded=source();bounded.chains.base.recentStart=1;bounded.chains.base.recentCursor=0;bounded.chains.base.recentHash=null;
const prefix=await advanceUniTradeFeed(bounded,{rpcFactory:c=>fx[c.key].rpc,now,maxRecentWindows:1});eq(prefix.book.chains.base.recentCursor,50000,'A large backlog advances a bounded verified prefix');eq(prefix.checked.base,undefined,'A partial prefix does not claim current coverage');
const recovered=await advanceUniTradeFeed(missing.book,{rpcFactory:c=>fx[c.key].rpc,now});eq(recovered.book.trades,result.book.trades,'Receipt recovery finds each actual execution once');
const saved=savedUniTradeFeed({...result.book,lastAttempt:fx.base.now,historyComplete:false});ok(validUniTradeFeed(saved),'The saved book can paint confirmed rows immediately');eq(saved.complete,false,'A saved response never claims a new live check');
const partial=uniTradeFeedView(failed),merged=mergeUniTradeFeeds(saved,partial);eq(merged.trades.length,2,'Partial current coverage retains confirmed saved trades');eq(merged.coverage.bnb.current,false,'Merging rows does not turn failed coverage into success');
const conflict=structuredClone(partial);conflict.trades[0].usd+=1;conflict.trades[0].price=conflict.trades[0].usd/conflict.trades[0].uni;assert.throws(()=>mergeUniTradeFeeds(saved,conflict),/execution changed/);n++;
const noCost=structuredClone(partial);noCost.trades[0].verified=false;noCost.trades[0].usd=null;noCost.trades[0].price=null;
eq(mergeUniTradeFeeds(saved,noCost).trades,saved.trades,'A weaker response cannot erase verified costs');
for(const alter of [v=>v.trades.push(v.trades[0]),v=>v.trades[0].uni=-1,v=>v.trades[0].price=999,v=>v.coverage.bnb.current=false,v=>v.book.wallets[1]=v.book.wallets[0]]){const bad=structuredClone(view);alter(bad);ok(!validUniTradeFeed(bad),'Malformed or dishonest responses are rejected');}
for(const scenario of ['open','closed','reuse','topup','pending','partial'])ok(validUniTradeFeed(uniStrategyReview(scenario).history),'Local accounting examples use the same minimal history contract');
const originalFetch=globalThis.fetch,originalNow=Date.now;let reads=0,broken=false,book=source(),invalid=false;
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},end(value){this.body=value?JSON.parse(value):undefined;return this;}});
try{
 Date.now=now;globalThis.fetch=async(url,options)=>{if(new URL(url).pathname==='/uni-trades.json')return Response.json(invalid?{version:99}:book);
  reads++;if(broken)throw Error('Source offline');const c=Object.values(UNI_CHAINS).find(c=>c.rpcs.includes(url));if(!c)throw Error('Unexpected source');const q=JSON.parse(options.body);
  return Response.json(Array.isArray(q)?await Promise.all(q.map(async r=>({id:r.id,result:await fx[c.key].rpc(r.method,r.params)}))):{id:q.id,result:await fx[c.key].rpc(q.method,q.params)});};
 const req=host=>({method:'GET',query:{view:'history'},headers:{host}}),a=response(),b=response();await Promise.all([handler(req('feed.invalid'),a),handler(req('feed.invalid'),b)]);
 eq(a.statusCode,200,'History uses the existing public read-only endpoint');eq(a.body,b.body,'Concurrent visitors share one history check');ok(a.headers['cache-control'].includes('s-maxage=3')&&!a.headers['cache-control'].includes('stale-while-revalidate'),'A brief cache cannot serve old history as a new check');
 const before=reads;const cached=response();await handler(req('feed.invalid'),cached);eq(reads,before,'A complete history is briefly reused');
 const available=await readAvailableUniTradeView('https://feed.invalid');eq(available.trades.length,2,'The separate strategy reader can reuse newly verified raw fills');eq(reads,before,'Strategy reuse performs no extra chain scan');
 broken=true;book=result.book;const outage=response();await handler(req('retry-feed.invalid'),outage);eq(outage.body.trades.length,2,'An outage still returns confirmed saved fills');eq(outage.headers['cache-control'],'no-store','Failed checks cannot be cached as live');
 broken=false;const retry=response();await handler(req('retry-feed.invalid'),retry);eq(retry.body.complete,true,'An outage recovers on the next request');
 invalid=true;const bad=response();await handler(req('bad-feed.invalid'),bad);eq(bad.statusCode,502,'An invalid saved ledger cannot silently restart history');eq(bad.headers['cache-control'],'no-store','Invalid data cannot enter the edge cache');
}finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
const client=readFileSync(new URL('../uni-trade.js',import.meta.url),'utf8'),worker=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
ok(client.includes("'/api/uni?view=history',9000")&&client.includes('setInterval(loadTrades,10000)'),'History uses the short independent poll');
ok(!client.includes('replayUniTrades')&&!client.includes('Time · wallet'),'The table no longer waits for cost replay or renders wallet details');
ok(worker.includes('/uni-history.mjs?v=191'),'The small history validator is available in the offline shell');
console.log(`UNI lightweight history, accounting preservation, concurrent reads and recovery: ${n} assertions passed; ${bytes} vs ${fullBytes} bytes in fixture.`);
