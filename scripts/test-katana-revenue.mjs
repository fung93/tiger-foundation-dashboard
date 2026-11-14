/* Hand-worked source/day/fee examples. All HTTP/RPC providers are closed local
   fixtures; their amounts are hypothetical, not dashboard seed data. */
import assert from 'node:assert/strict';
import {emptyRevenueLedger,validateRevenueLedger,buildRevenueView,mergeRevenueObservations,
 reportingEnd,revenueDay,REVENUE_DAY,REVENUE_SOURCES,REVENUE_ANNOUNCEMENT,usdMicros} from '../katana-revenue-core.mjs';
import {PERPS_EXCHANGE,PERPS_TRADE_TOPIC,perpsTradeFees,llamaRevenueDays,readPerpsRevenueDays,collectKatanaRevenue,REVENUE_FEEDS} from '../api/_katana-revenue.mjs';
import {readSwapRevenueDays,swapProtocolAccrual,validateSwapRevenueCatalog} from '../api/_katana-swap-revenue.mjs';
import {CFG,keccakHex} from '../api/_core.mjs';
import {KATANA_ASSETS} from '../api/_katana-config.mjs';
let count=0;const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;},rejects=async(p,n)=>{await assert.rejects(p,n);count++;};
const now=Date.parse('2026-11-14T10:00:00Z')/1000,end=reportingEnd(now),day=revenueDay(end-REVENUE_DAY),
 row=(d,value)=>({day:revenueDay(end-d*REVENUE_DAY),usdMicros:usdMicros(value),observedAt:new Date(now*1000).toISOString(),evidenceUrl:'https://fixture.invalid/revenue'}),
 ledger=emptyRevenueLedger();let view=buildRevenueView(ledger,now);
check(view.totals[30].usd,null,'No readings never means zero network revenue');
check(view.buybacks[30].allocated.usd,null,'An undisclosed budget is not a zero allocation');
check(view.buybacks[30].purchased.kat,null,'Unconnected execution evidence is not zero KAT bought');
check(swapProtocolAccrual([10n,20n],[3n,25n],[9n,0n]),[2n,5n],'Collected protocol fees are added back to counter changes; principal is absent');
assert.throws(()=>swapProtocolAccrual([10n,20n],[3n,25n],[0n,0n]),/Unreconciled/);count++;
check(REVENUE_ANNOUNCEMENT.revenueBuybackBps,null,'The article does not disclose the percentage of revenue for buybacks');
check(REVENUE_ANNOUNCEMENT.purchasedKatToAvkatBps,10000,'100% applies to purchased KAT, not to revenue');
check(REVENUE_ANNOUNCEMENT.feeFlowDate,'2026-11-17','The announced fee-flow date remains explicit');
check(REVENUE_ANNOUNCEMENT.buybackLaunchDate,null,'A fee-flow date is not a buyback launch date');
check(view.sources.map(s=>s.id),['swap','perps','vault_bridge','sequencer'],'The four article sources are separate');
ledger.observations.perps=[row(1,10)];view=buildRevenueView(ledger,now);
check(view.sources[1].periods[1].usd,10,'A complete recorded day shows its actual income');
check(view.sources[1].periods[7].usd,null,'One day is never multiplied into a verified weekly figure');
check(view.sources[1].periods[7].knownUsd,10,'Known partial income remains separately inspectable');
check(view.sources[1].periods[30].coveredDays,1,'Month coverage counts actual reporting days');
check(view.totals[1].usd,null,'One source cannot establish a full network total');
check(view.totals[1].knownUsd,10,'A partial network figure is explicitly a subtotal');
ledger.observations.perps=[row(1,0)];check(buildRevenueView(ledger,now).sources[1].periods[1].usd,0,'A fully read zero-fee day remains a real zero');
ledger.observations.perps=[row(1,-3)];check(buildRevenueView(ledger,now).sources[1].periods[1].usd,-3,'Net rebates cannot be filtered out of negative revenue');
for(const s of REVENUE_SOURCES){ledger.observations[s.id]=Array.from({length:30},(_,i)=>row(30-i,1));ledger.sourceState[s.id]={status:'reported',completeRevenue:true};}
view=buildRevenueView(ledger,now);check(view.totals[30].usd,120,'Thirty observed days across four sources reconcile to the full sum');
check(view.sources[0].periods[7].usd,7,'Weekly means seven completed reporting days');
ledger.sourceState.swap.completeRevenue=false;check(buildRevenueView(ledger,now).totals[30].complete,false,'A subset of a product cannot be called full network coverage');
ledger.observations.swap=[row(1,.1)];ledger.observations.perps=[row(1,.2)];ledger.observations.vault_bridge=[];ledger.observations.sequencer=[];
check(buildRevenueView(ledger,now).totals[1].knownUsd,.3,'Integer USD accounting prevents floating-point sum drift');
const rounded=emptyRevenueLedger();rounded.observations.swap=[row(1,3420.075968)];rounded.observations.perps=[row(1,251224.3789)];
check(buildRevenueView(rounded,now).totals[1].knownUsd,254644.46,'Displayed source dollars reconcile to the displayed subtotal to the cent');
check(buildRevenueView(rounded,now).totals[1].unroundedUsd,254644.454868,'The exact micro-dollar subtotal remains available without rewriting source data');
ledger.observations.swap.push(row(0,999));view=buildRevenueView(ledger,now);
check(view.sources[0].periods[1].usd,.1,'Today’s incomplete reporting day cannot enter yesterday’s income');
ledger.grossFees.sequencer=[row(1,500)];view=buildRevenueView(ledger,now);
check(view.totals[1].knownUsd,.3,'Gross gas fees are excluded from retained network revenue');
check(view.sources[3].grossPeriods[1].usd,500,'Gross fees remain available as separate context');
const old=[row(1,1)],merged=mergeRevenueObservations(old,[row(1,9),row(2,2)]);
check(merged.rows.at(-1).usdMicros,'1000000','A source revision cannot silently rewrite booked history');check(merged.conflicts,[day],'Revisions are flagged for review');
check(old.length,1,'Merging does not mutate the previous observations');
assert.throws(()=>validateRevenueLedger({...emptyRevenueLedger(),observations:{...emptyRevenueLedger().observations,swap:[row(1,1),row(1,2)]}}),/Invalid dated/);count++;
assert.throws(()=>usdMicros(NaN),/Invalid/);count++;
const funded=emptyRevenueLedger();funded.allocationCoverage={from:end-30*REVENUE_DAY,to:end,evidenceUrl:'https://fixture.invalid/budget'};
funded.allocations=[{id:'budget-1',ts:end-3600,usdMicros:'5000000',evidenceUrl:'https://fixture.invalid/budget'}];
funded.buybackCoverage={...funded.allocationCoverage};funded.buybacks=[{id:'buy-1',ts:end-1200,usdMicros:'2000000',katRaw:'500000000000000000000',
 evidenceUrl:'https://fixture.invalid/tx',transactionHash:'0x'+'a'.repeat(64),verified:true}];
view=buildRevenueView(funded,now);check(view.buybacks[1].allocated.usd,5,'An allocated budget is not spending');check(view.buybacks[1].purchased.usd,2,'Actual recorded spending stays separate');
check(view.buybacks[1].purchased.kat,500,'Only purchased KAT enters execution totals');
await rejects(Promise.resolve().then(()=>validateRevenueLedger({...funded,buybacks:[{...funded.buybacks[0],verified:false}]})),'An unverified transfer is not a verified buyback');
const response={name:'SushiSwap V3',chains:['Ethereum','Katana'],totalDataChart:[[end-REVENUE_DAY,999999]],totalDataChartBreakdown:[[end-REVENUE_DAY,{Ethereum:{V3:999},Katana:{V3:2.5}}]]};
check(llamaRevenueDays(response,'swap',now)[0].usdMicros,'2500000','Only the explicit Katana branch is used');
assert.throws(()=>llamaRevenueDays({...response,totalDataChartBreakdown:[]},'swap',now),/No verified/);count++;
assert.throws(()=>llamaRevenueDays({...response,totalDataChartBreakdown:[[end-REVENUE_DAY,999999]]},'swap',now),/All-chain/);count++;
assert.throws(()=>llamaRevenueDays({...response,chains:['Ethereum']},'swap',now),/No Katana/);count++;
assert.throws(()=>llamaRevenueDays({...response,name:'An unrelated app'},'swap',now),/identity/);count++;
check(llamaRevenueDays({...response,chains:['Katana'],totalDataChartBreakdown:[],totalDataChart:[[end-REVENUE_DAY,0]]},'swap',now)[0].usdMicros,'0','Declared single-chain zero data is retained');
const w=n=>BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0'),str=s=>w(s.length)+Buffer.from(s).toString('hex').padEnd(64,'0'),
 event=(maker=-10000000n,taker=20000000n,quote='USD')=>({address:PERPS_EXCHANGE,topics:[PERPS_TRADE_TOPIC],data:'0x'+[1,2,288,352,1,1,0,maker,taker].map(w).join('')+str('BTC')+str(quote)});
check(perpsTradeFees(event()),10000000n,'Maker rebates reduce rather than increase trading-fee revenue');
check(perpsTradeFees(event(10000000n,20000000n)),30000000n,'Positive maker/taker fees add once');
assert.throws(()=>perpsTradeFees(event(0n,1n,'ETH')),/quote/);count++;
assert.throws(()=>perpsTradeFees({...event(),address:'0x'+'f'.repeat(40)}),/Unsupported/);count++;
assert.throws(()=>perpsTradeFees({...event(),removed:true}),/Unsupported/);count++;
const head=2000000,base=now-head;let mode='split',requests=0;
async function rpc(method,params){requests++;
 if(method==='eth_blockNumber')return '0x'+head.toString(16);
 if(method==='eth_getBlockByNumber')return {timestamp:'0x'+(base+Number(BigInt(params[0]))).toString(16)};
 if(method!=='eth_getLogs')throw Error('No other method is allowed');
 const f=params[0],lo=Number(BigInt(f.fromBlock)),hi=Number(BigInt(f.toBlock));check(f.address,PERPS_EXCHANGE,'Only the fixed exchange is scanned');
 if(hi-lo>50000){if(mode==='cap')return Array(10000).fill({});throw Error('logs count limit exceeded (10000)');}
 if(mode==='failed-child'&&lo>head-(now-end)-REVENUE_DAY)throw Error('Child read failed');
 const log={...event(),blockNumber:f.fromBlock,blockTimestamp:'0x'+(base+lo).toString(16),transactionHash:'0x'+lo.toString(16).padStart(64,'0'),logIndex:'0x0'};
 return mode==='duplicate'?[log,log]:[log];
}
let rows=await readPerpsRevenueDays([],{now,maxDays:1,rpc});
check(rows[0].usdMicros,'200000','Both complete halves contribute once');check(rows[0].trades,2,'Every complete result contributes its event count');
mode='cap';rows=await readPerpsRevenueDays([],{now,maxDays:1,rpc});check(rows[0].usdMicros,'200000','A successful 10,000-result cap is also split');
mode='failed-child';await rejects(readPerpsRevenueDays([],{now,maxDays:1,rpc}),'One failed child invalidates the whole day');
mode='duplicate';await rejects(readPerpsRevenueDays([],{now,maxDays:1,rpc}),'Duplicate or overlapping log results cannot inflate income');
check(requests<100,true,'The test scans remain bounded and contain no real RPC requests');
const seed=emptyRevenueLedger();seed.observations.perps=[row(1,17)];const original=JSON.stringify(seed);
let result=await collectKatanaRevenue(seed,{now,getJson:async()=>{throw Error('Closed provider failure');},readPerps:async()=>{throw Error('Closed RPC failure');},readSwap:async()=>{throw Error('Closed Swap failure');}});
check(JSON.stringify(seed),original,'A failed refresh never mutates the saved ledger');
check(result.ledger.observations.perps[0].usdMicros,'17000000','Failed providers retain the last verified day');
check(result.ledger.observations.perps[0].observedAt,seed.observations.perps[0].observedAt,'A failed provider cannot renew an observation timestamp');
check(result.view.sources[1].state.status,'retained','Retained figures are explicitly identified');
result=await collectKatanaRevenue(emptyRevenueLedger(),{now,getJson:async url=>url===REVENUE_FEEDS.swap.url?response:{name:'Katana',chains:['Katana'],totalDataChart:[[end-REVENUE_DAY,900]]},readPerps:async()=>[row(1,3)],readSwap:async()=>{throw Error('Closed Swap failure');}});
check(result.view.totals[1].knownUsd,5.5,'Independent available income sources survive a missing source');
check(result.view.sources[3].periods[1].usd,null,'A gas fee feed cannot become sequencer retained income');
check(result.view.sources[2].state.status,'unconfigured','Unconnected Vault Bridge yield is not TVL times an advertised APY');
check(result.view.buybacks[30].purchased.usd,null,'Income never becomes an invented buyback purchase');
const pool='0x'+'1'.repeat(40),catalog={factory:CFG.factory.toLowerCase(),toBlock:head,totalPools:1,
 pools:[{pool,token0:KATANA_ASSETS.USDC.address,token1:KATANA_ASSETS.KAT.address,createdBlock:1}]},
 collectTopic='0x'+keccakHex(Buffer.from('CollectProtocol(address,address,uint128,uint128)').toString('hex')).replace(/^0x/,'');
function aggregate(values){let tails='',offsets='';for(const r of values){const bytes=r.data.slice(2);offsets+=w(values.length*32+tails.length/2);
 tails+=w(r.ok?1:0)+w(64)+w(bytes.length/2)+bytes.padEnd(Math.ceil(bytes.length/64)*64,'0');}return'0x'+w(32)+w(values.length)+offsets+tails;}
const abi=(...ns)=>'0x'+ns.map(w).join(''),q=(price,scale=1e12)=>BigInt(Math.floor(Math.sqrt(scale/price)*2**96));let swapMode='normal';
async function swapRpc(method,params){
 if(method==='eth_blockNumber')return'0x'+head.toString(16);
 if(method==='eth_getBlockByNumber')return{timestamp:'0x'+(base+Number(BigInt(params[0]))).toString(16)};
 if(method==='eth_call'){
  check(params[0].to,CFG.multicall,'Swap source uses the shared validated Multicall codec');const after=Number(BigInt(params[1]))===head-(now-end)-1;
  const amounts=swapMode==='zero'?[10n*10n**6n,2n*10n**18n]:after?[7n*10n**6n,3n*10n**18n]:[10n*10n**6n,2n*10n**18n];
  return aggregate([{ok:swapMode!=='failed-counter',data:abi(...amounts)},
   ...[q(.004),q(2500),BigInt(Math.floor(Math.sqrt(70000/100)*2**96))].map(sqrt=>({ok:true,data:abi(sqrt,0)})),
   ...[1,1,1].map(n=>({ok:true,data:abi(swapMode==='unpriced'?0:n)})),{ok:true,data:abi(14n*10n**17n)}]);
 }
 if(method==='eth_getLogs'){const f=params[0];check(f.address,[pool],'Only the catalog’s priced pools supply protocol collections');
  if(swapMode==='zero'||swapMode==='missing-collection')return[];
  return[{address:pool,topics:[collectTopic],blockNumber:f.fromBlock,data:abi(5n*10n**6n,0),transactionHash:'0x'+'b'.repeat(64),logIndex:'0x0'}];}
 throw Error('Unexpected Swap test RPC '+method);
}
let swapResult=await readSwapRevenueDays([],catalog,{now,maxDays:1,rpc:swapRpc});
check(swapResult.rows[0].usdMicros,'2004000','Historical protocol counter growth plus collections is valued at that day’s closing quotes');
check(swapResult.rows[0].trackedPools,1,'The revenue row retains its exact pool coverage');
check(swapResult.rows[0].tokenAmounts[KATANA_ASSETS.USDC.address],'2000000','Protocol fees cannot contain LP principal or fee legs');
for(swapMode of ['failed-counter','unpriced','missing-collection'])await rejects(readSwapRevenueDays([],catalog,{now,maxDays:1,rpc:swapRpc}),swapMode+' cannot become zero Swap revenue');
swapMode='zero';swapResult=await readSwapRevenueDays([],catalog,{now,maxDays:1,rpc:swapRpc});
check(swapResult.rows[0].usdMicros,'0','A fully verified no-growth day is zero for its declared pool scope');
assert.throws(()=>validateSwapRevenueCatalog({...catalog,pools:[catalog.pools[0],catalog.pools[0]],totalPools:2}),/Invalid/);count++;
console.log('Katana revenue, reporting periods and buyback separation: '+count+' assertions passed.');
