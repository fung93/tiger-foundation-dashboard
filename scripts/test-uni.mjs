import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {uniDefaultInput,uniEstimate,uniPoolLink,uniPriceFromSqrt} from '../uni-core.mjs';
import {readUniChain,readUniPools,createUniRpc,completeUniLogs,uniObservedTrading,UNI_PROTOCOL_TOPIC,UNI_SWAP_TOPIC} from '../api/_uni-reader.mjs';
import {UNI_CHAINS} from '../api/_uni-config.mjs';
import {uniFixture} from './fixtures/uni.mjs';
import uniHandler from '../api/uni.mjs';
let checks=0;const ok=(v,n)=>{assert.ok(v,n);checks++;},eq=(a,b,n)=>{assert.deepEqual(a,b,n);checks++;},near=(a,b,n)=>{ok(Math.abs(a-b)<=Math.max(1e-8,Math.abs(b)*1e-8),n+': '+a+' vs '+b);};
const pad=v=>BigInt.asUintN(256,BigInt(v)).toString(16).padStart(64,'0');
const data=(...v)=>'0x'+v.map(pad).join('');
eq(UNI_SWAP_TOPIC,'0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67','The derived Swap topic matches the independently used V3 ABI');
const readings=[];
for(const key of ['base','bnb']){
  const f=uniFixture(key),v=await readUniChain(f.chain,f);readings.push(v);
  eq(v.status,'fresh','A complete pinned reading is fresh');eq(v.pools.length,1,'Only a verified funded pool is shown');
  const p=v.pools[0];near(p.price,8,'UNI is quoted stablecoin per token');eq(p.chain,key,'Pool chain identity is retained');
  near(p.tvlUsd,18000,'TVL uses the correct token decimals');near(p.volume24hUsd,1000,'Each swap input counts once');near(p.fees24hUsd,.5,'Pool fees exclude neither trade direction nor decimals');
  near(p.apr,.5*365/18000,'Pool APR uses recent fees over TVL');ok(p.feeWindow.verified,'Fee history is verified');eq(p.feeWindow.seconds,86400,'Uses actual block timestamps');
  ok(f.requests.every(r=>r.method!=='eth_sendTransaction'),'Every chain request is read-only');
  ok(f.requests.filter(r=>r.method==='eth_call').every(r=>r.params[1]!=='latest'),'All contract reads are pinned');
  ok(p.link.includes('/'+key+'/'),'Uniswap link uses the correct network');
  for(const reversed of [false,true]){
    const q=reversed?{...p,baseIndex:1-p.baseIndex,token0:p.token1,token1:p.token0,sqrtPrice:1/p.sqrtPrice,tick:Math.floor(Math.log((1/p.sqrtPrice)**2)/Math.log(1.0001)),
      feeWindow:{...p.feeWindow,perL0Day:p.feeWindow.perL1Day,perL1Day:p.feeWindow.perL0Day}}:p;
    near(uniPriceFromSqrt(q.sqrtPrice*2**96,q),8,'Price orientation is independent of token order');
    for(const mode of ['uni','stable','balanced']){
      const input=uniDefaultInput(q,mode),r=uniEstimate(q,input);ok(!r.error,'Valid '+mode+' deposit works with either token order');
      near(r.capitalUsd,1000,'Default illustration uses $1,000');near(r.deposit.uni*q.price+r.deposit.stable,1000,'Deposit amounts conserve initial capital');
      ok(r.edges.upper.valueUsd>=r.edges.lower.valueUsd,'The upper edge is never worth less than the lower edge');
      ok(r.range.lowerPrice<r.range.upperPrice,'Display range is ordered after tick rounding');
      near(r.edges.upper.pnlUsd,r.edges.upper.valueUsd-1000,'Upper P&L excludes imagined fees');near(r.edges.lower.pnlUsd,r.edges.lower.valueUsd-1000,'Lower P&L uses the same initial capital');
      if(mode==='balanced'){ok(r.inRange,'A two-token position starts in range');ok(r.deposit.uni>0&&r.deposit.stable>0,'Balance uses both tokens');ok(r.feesPerDay>0,'Verified in-range fees produce an estimate');near(r.apr,r.feesPerDay*365/1000,'Personal APR uses personal capital');
        const larger=uniEstimate(q,{...input,amount:2000});ok(larger.feesPerDay<2*r.feesPerDay,'Added liquidity dilutes fees rather than multiplying without limit');
        const unavailable=uniEstimate({...q,feeWindow:null},input);eq(unavailable.feesPerDay,null,'A missing fee history is not zero');eq(unavailable.apr,null,'Missing fee history cannot promise an APR');
        eq(uniEstimate({...q,activeLiquidity:0},input).feesPerDay,null,'No active liquidity cannot give a conditional fee quote');
      }else{eq(r.inRange,false,'A single-sided position starts outside the range');eq(r.feesPerDay,0,'An out-of-range deposit earns zero now');eq(r.apr,0,'APR is zero while waiting');
        near(mode==='uni'?r.deposit.stable:r.deposit.uni,0,'The unselected asset is not silently required');}
    }
    const d=uniDefaultInput(q,'balanced');
    ok(uniEstimate(q,{...d,mode:'uni'}).error,'An in-range band cannot claim to accept UNI only');
    ok(uniEstimate(q,{...d,mode:'stable'}).error,'An in-range band cannot claim to accept stablecoin only');
    ok(uniEstimate(q,{...d,lowerPrice:10,upperPrice:12}).error,'Balance cannot be outside the current range');
    for(const amount of [0,-1,NaN,Infinity])ok(uniEstimate(q,{...d,amount}).error,'Invalid capital is rejected');
    for(const edge of ['lowerPrice','upperPrice'])for(const value of [0,-1,NaN,Infinity])ok(uniEstimate(q,{...d,[edge]:value}).error,'Invalid range prices are rejected');
    ok(uniEstimate(q,{...d,lowerPrice:9,upperPrice:7}).error,'Reversed prices are rejected');
  }
}
const f=uniFixture(),p=readings[0].pools[0];
// Official IUniswapV3PoolEvents ABI orders both old values, then both new values.
const protocol={...f.swap,logIndex:'0x2',blockNumber:'0x'+(p.block-9).toString(16),topics:[UNI_PROTOCOL_TOPIC],data:data(0,0,4,5)};
const second={...f.swap,logIndex:'0x3',blockNumber:'0x'+(p.block-8).toString(16)};
near(uniObservedTrading([second,protocol,f.swap],p,p.block-100,p.block,0).feesUsd,.875,'Protocol-fee changes are applied in event order');
eq(uniObservedTrading([protocol],p,p.block-100,p.block,0).feeProtocol,84,'The ABI new0/new1 values encode as 4 + (5 << 4)');
assert.throws(()=>uniObservedTrading([f.swap,f.swap],p,p.block-100,p.block,0));checks++;
assert.throws(()=>uniObservedTrading([{...f.swap,removed:true}],p,p.block-100,p.block,0));checks++;
assert.throws(()=>uniObservedTrading([{...f.swap,address:'0x'+'9'.repeat(40)}],p,p.block-100,p.block,0));checks++;
const badArchive=uniFixture('base',{archiveFailure:true}),partial=await readUniChain(badArchive.chain,badArchive);
eq(partial.pools[0].feeWindow,null,'Failed archive calls are never a zero fee baseline');near(partial.pools[0].price,8,'The independent current price survives archive failure');
const badLogs=uniFixture('base',{logsFailure:true}),noTrading=await readUniChain(badLogs.chain,badLogs);
eq(noTrading.pools[0].volume24hUsd,null,'Incomplete trading logs do not create a zero-volume day');ok(noTrading.pools[0].feeWindow.verified,'Verified fee growth survives an independent log failure');
const missing=uniFixture('base',{missingDiscovery:true});eq((await readUniChain(missing.chain,missing)).status,'partial','Failed fee tiers are not declared completely discovered');
const empty=uniFixture('base',{empty:true});eq((await readUniChain(empty.chain,empty)).pools,[],'A confirmed absent pool is not fabricated');
const reorg=uniFixture('base',{reorg:true});await assert.rejects(readUniChain(reorg.chain,reorg),/block changed/);checks++;
const old=uniFixture();await assert.rejects(readUniChain(old.chain,{...old,now:old.now+181}),/behind/);checks++;
const independent=await readUniPools({now:f.now,readChain:async c=>{if(c.key==='bnb')throw Error('offline');return readings[0];}});
eq(independent.chains[1].status,'unavailable','An unavailable network is explicit');eq(independent.pools.length,1,'Another network keeps its reading');
let scans=0;const split=await completeUniLogs(async(_,params)=>{scans++;const a=Number(BigInt(params[0].fromBlock)),b=Number(BigInt(params[0].toBlock));return b>a?Array(10000).fill({}):[{n:a}];},[p.pool],1,2);
eq(split,[{n:1},{n:2}],'A successful capped log query splits into disjoint complete ranges');eq(scans,3,'The cap is not silently accepted');
let attempts=0;await assert.rejects(completeUniLogs(async()=>{attempts++;throw Error('Pool reading limit reached');},[p.pool],1,1000),/reading limit/);checks++;eq(attempts,1,'A budget failure must not recurse as a log-size limit');
let sent=0;const rpc=createUniRpc(UNI_CHAINS.base,{maxRequests:1,fetcher:async()=>{sent++;return {ok:true,json:async()=>({result:'0x2105'})};}});
await assert.rejects(rpc('eth_sendTransaction',[]),/Read-only/);checks++;eq(sent,0,'Signing methods are rejected before any outbound call');
await assert.rejects(rpc('eth_blockNumber',[]),/limit/);checks++;eq(sent,1,'The RPC budget is a hard bound');
eq(uniPoolLink('bnb','0x'+'A'.repeat(40)),'https://app.uniswap.org/explore/pools/bnb/0x'+'a'.repeat(40),'Links are normalized and fixed to Uniswap');
for(const chain of ['ethereum','https://evil.example']){assert.throws(()=>uniPoolLink(chain,p.pool));checks++;}
for(const chain of Object.values(UNI_CHAINS))for(const token of [chain.uni,...chain.stables])ok(/^0x[0-9a-f]{40}$/.test(token.address),'Every configured token address is well formed');
const html=readFileSync(new URL('../uni.html',import.meta.url),'utf8');ok(html.includes('src="/uni.js?v=169"'),'The UNI page loads its versioned module');
// Exercise the actual public handler, its JSON-safe results and its cache through
// closed RPC transports. Concurrent visitors must not duplicate a full chain scan.
const originalFetch=globalThis.fetch,originalNow=Date.now,apiFixtures=Object.fromEntries(['base','bnb'].map(key=>[key,uniFixture(key,{now:Math.floor(Date.now()/1000)})]));
let offline=false,requests=0;
const response=()=>({statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(v){this.body=JSON.parse(JSON.stringify(v));return this;}});
try{
  globalThis.fetch=async(url,options)=>{requests++;if(offline)return new Response('',{status:503});
    const fixture=Object.values(apiFixtures).find(f=>f.chain.rpcs.includes(url));if(!fixture)throw Error('Unexpected API source');
    const body=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:1,result:await fixture.rpc(body.method,body.params)});};
  const a=response(),b=response();await Promise.all([uniHandler({method:'GET',query:{rpc:'https://untrusted.example'}},a),uniHandler({method:'GET'},b)]);
  eq(a.statusCode,200,'The real handler returns a healthy reading');eq(a.body.pools.length,2,'The handler combines independently verified networks');eq(a.body,b.body,'Concurrent visitors share one observation');
  ok(a.headers['cache-control'].includes('s-maxage=30'),'Fresh readings receive the bounded public cache');
  for(const f of Object.values(apiFixtures))eq(f.requests.filter(r=>r.method==='eth_blockNumber').length,1,'A concurrent visitor cannot duplicate '+f.chain.key+' discovery');
  const countBefore=requests,head=response();await uniHandler({method:'HEAD'},head);eq(head.statusCode,200,'HEAD uses the same cached reading');eq(requests,countBefore,'A warm cache performs no external read');
  const post=response();await uniHandler({method:'POST'},post);eq(post.statusCode,405,'Mutation requests are rejected');eq(requests,countBefore,'Rejected methods do not read or write a chain');
  offline=true;Date.now=()=>originalNow()+31000;const fail=response();await uniHandler({method:'GET'},fail);
  eq(fail.statusCode,503,'A cold failure is not a successful empty pool list');eq(fail.headers['cache-control'],'no-store','Provider failures cannot poison the CDN cache');
  ok(fail.body.chains.every(c=>c.status==='unavailable'),'Every failed source is explicit');
}finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
console.log(`UNI pool discovery, live fee readings and beginner position maths: ${checks} assertions passed.`);
