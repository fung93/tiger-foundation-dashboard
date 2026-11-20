import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import handler from '../api/uni.mjs';
import {createUniRpc} from '../api/_uni-reader.mjs';
import {emptyUniTradeBook,readUniTradeView} from '../api/_uni-trades.mjs';
import {UNI_CHAINS} from '../api/_uni-config.mjs';
import {uniTradeFixture} from './fixtures/uni-trades.mjs';
import {receiptUniTrade} from '../uni-trade-core.mjs';
import {CFG} from '../api/_core.mjs';
let checks=0;const eq=(a,b,n)=>{assert.deepEqual(a,b,n);checks++;},ok=(v,n)=>{assert.ok(v,n);checks++;};
const originalFetch=globalThis.fetch,originalNow=Date.now,started=Date.now(),fx={base:uniTradeFixture('base'),bnb:uniTradeFixture('bnb',{entries:[]})};
let badLedger=false,broken=false,reads=0,source=emptyUniTradeBook();
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},end(value){this.body=value?JSON.parse(value):undefined;return this;},json(value){this.body=value;return this;}});
try{
 Date.now=()=>fx.base.now*1000+originalNow()-started;
 globalThis.fetch=async(url,options)=>{
  const u=new URL(url);if(u.pathname==='/uni-trades.json')return Response.json(badLedger?{version:99}:source);
  reads++;if(broken)throw Error('Offline');const chain=Object.values(UNI_CHAINS).find(c=>c.rpcs.includes(url));if(!chain)throw Error('Unexpected external source');
  const request=JSON.parse(options.body);if(Array.isArray(request))return Response.json(await Promise.all(request.map(async q=>({jsonrpc:'2.0',id:q.id,result:await fx[chain.key].rpc(q.method,q.params)}))));return Response.json({jsonrpc:'2.0',id:1,result:await fx[chain.key].rpc(request.method,request.params)});
 };
 const a=response(),b=response();await Promise.all([handler({method:'GET',query:{view:'trades'},headers:{host:'uni-test.invalid'}},a),handler({method:'GET',query:{view:'trades'},headers:{host:'uni-test.invalid'}},b)]);
 eq(a.statusCode,200,'The existing UNI endpoint serves the independent trade view');eq(a.body.schemaVersion,'uni-trade-view-v1','Trade responses cannot be confused with pool-guide responses');eq(a.body,b.body,'Concurrent visitors share the same trade reading');eq(a.body.complete,true,'Both real-head-shaped fixtures are completely covered');eq(a.body.trades.length,2,'Buy and sell receipts reach the public API');eq(a.body.summary.qty,6,'API totals use the shared deterministic cost basis');ok(a.headers['cache-control'].includes('s-maxage=10'),'Only complete current readings receive a short cache');
 const before=reads,head=response();await handler({method:'HEAD',query:{view:'trades'},headers:{host:'uni-test.invalid'}},head);eq(reads,before,'HEAD shares the short complete cache');
 const post=response();await handler({method:'POST',query:{view:'trades'},headers:{host:'uni-test.invalid'}},post);eq(post.statusCode,405,'No transaction or mutation API is added');eq(reads,before,'Rejected mutation does not touch RPC');
 badLedger=true;const bad=response();await handler({method:'GET',query:{view:'trades'},headers:{host:'invalid-saved.invalid'}},bad);eq(bad.statusCode,502,'Invalid saved history cannot silently restart the book');eq(reads,before,'Invalid saved data fails before an external chain reading');eq(bad.headers['cache-control'],'no-store','Invalid history cannot enter the CDN');
 badLedger=false;broken=true;const fail=response();await handler({method:'GET',query:{view:'trades'},headers:{host:'failed-sources.invalid'}},fail);eq(fail.body.complete,false,'An outage cannot return a complete empty history');ok(fail.body.errors.base&&fail.body.errors.bnb,'Both source failures remain explicit');eq(fail.headers['cache-control'],'no-store','Unavailable sources are never cached as healthy');
 broken=false;const retry=response();await handler({method:'GET',query:{view:'trades'},headers:{host:'failed-sources.invalid'}},retry);eq(retry.body.complete,true,'The same origin recovers immediately after a failed read');eq(retry.body.trades.length,2,'Recovery returns each fill once');
 source={...retry.body.book,quotes:retry.body.quotes,walletReadings:retry.body.wallets};
 const warm=await readUniTradeView('https://warm-quote.invalid');
 source={...source,quotes:Object.fromEntries(Object.entries(source.quotes).map(([c,q])=>[c,{...q,ts:q.ts-3600,priceUsd:1}]))};broken=true;
 const warmFailure=await readUniTradeView('https://warm-quote.invalid');eq(warmFailure.quotes,warm.quotes,'A failed refresh retains the newest verified warm quotes, never older saved prices');
 source={...source,quotes:retry.body.quotes};broken=true;const retained=await readUniTradeView('https://saved-reading.invalid');eq(retained.trades,source.trades,'Live-source failure retains immutable saved trades');eq(retained.quotes,source.quotes,'Retained prices keep their original source timestamps');eq(retained.complete,false,'Retained values cannot claim a live refresh');
}finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
let capacityCalls=0;
const recoveringRpc=createUniRpc({...UNI_CHAINS.bnb,rpcs:['https://closed-bnb.invalid']},{rateRetries:1,retryDelayMs:1,minIntervalMs:1,fetcher:async(_url,options)=>{
 const q=JSON.parse(options.body);if(q.method==='eth_chainId')return Response.json({result:'0x38'});
 capacityCalls++;return Response.json(capacityCalls===1?{error:{code:-32005,message:'Your app has exceeded its compute units per second capacity'}}:{result:'0x7'});
}});
eq(await recoveringRpc('eth_getTransactionCount',[CFG.wallet,'latest']),'0x7','A temporary free-provider capacity error is retried before abandoning history');
eq(capacityCalls,2,'Capacity retries are bounded and settle after one recovery');
for(const key of ['base','bnb']){
 let calls=0;const rpc=createUniRpc(UNI_CHAINS[key],{fetcher:async()=>{calls++;throw Error('Should not be reached');}});
 for(const method of ['eth_sendTransaction','eth_sendRawTransaction','eth_sign','personal_sign','wallet_sendCalls']){await assert.rejects(()=>rpc(method,[]),/Read-only/);checks++;}
 eq(calls,0,'The UNI trade reader cannot send or sign wallet transactions');
}
const recorded=JSON.parse(readFileSync(new URL('./fixtures/uni-trades-recorded.json',import.meta.url),'utf8'));
for(const entry of recorded.entries){const found=receiptUniTrade({chain:UNI_CHAINS.base,wallets:CFG.wallets.map(w=>w.address),...entry});eq(found.trade,null,'Recorded Base approvals, transfers and LP operations remain outside UNI buy/sell history');}
const worker=readFileSync(new URL('../sw.js',import.meta.url),'utf8');for(const p of ['/uni-trade.html','/uni-trade.js?v=184','/uni-trade.css?v=184','/uni-trade-core.mjs?v=180'])ok(worker.includes(p),'The new page and modules are available in the refreshed app shell');
const apis=(await import('node:fs/promises')).readdir;eq((await apis(new URL('../api/',import.meta.url))).filter(p=>p.endsWith('.mjs')&&!p.startsWith('_')).length,12,'UNI Trade does not exceed Vercel Hobby’s function limit');
console.log(`UNI trade API isolation, source recovery, recorded receipts and read-only access: ${checks} assertions passed.`);
