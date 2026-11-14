/* Fixed, free, read-only sources. No wallet addresses, keys, trade execution or
   fabricated revenue shares. Missing providers leave their own source missing. */
import {CFG,keccakHex} from './_core.mjs';
import {readSwapRevenueDays} from './_katana-swap-revenue.mjs';
import {buildRevenueView,emptyRevenueLedger,validateRevenueLedger,mergeRevenueObservations,
 REVENUE_DAY,REVENUE_SOURCES,reportingEnd,revenueDay,usdMicros} from '../katana-revenue-core.mjs';

export const PERPS_EXCHANGE='0x62230cea619f734cc215bb8074bbf07be4eb633e';
export const PERPS_TRADE_TOPIC='0x'+keccakHex(Buffer.from('TradeExecuted(address,address,string,string,uint64,uint64,uint8,int64,uint64)').toString('hex')).replace(/^0x/,'');
export const REVENUE_FEEDS=Object.freeze({
 swap:{url:'https://api.llama.fi/summary/fees/sushiswap-v3?dataType=dailyRevenue',metric:'dailyRevenue',names:['SushiSwap V3','SushiSwap','Katana Swap'],
  methodology:'https://github.com/DefiLlama/dimension-adapters/blob/9fef43d/dexs/sushiswap-v3.ts'},
 sequencer:{url:'https://api.llama.fi/summary/fees/katana-chain?dataType=dailyFees',metric:'dailyFees',names:['Katana','Katana (Chain)'],
  methodology:'https://github.com/DefiLlama/dimension-adapters/blob/9fef43d/fees/katana-chain.ts'},
});
const PERPS_EVIDENCE='https://github.com/DefiLlama/dimension-adapters/blob/9fef43d/dexs/katana-perps.ts';
const word=(h,i)=>BigInt('0x'+h.slice(2+i*64,66+i*64)),hex=n=>'0x'+n.toString(16);

/* Fee quantities are signed maker / unsigned taker pips (8 decimals), not
   6-decimal ERC-20 amounts. A maker rebate reduces exchange revenue. */
export function perpsTradeFees(log){
 if(log.address?.toLowerCase()!==PERPS_EXCHANGE||log.topics?.[0]!==PERPS_TRADE_TOPIC||log.removed
   ||!/^0x[0-9a-f]+$/i.test(log.data||'')||log.data.length<2+9*64)throw Error('Unsupported Perps fee event');
 const offset=Number(word(log.data,3)),bytes=log.data.slice(2),length=Number(BigInt('0x'+bytes.slice(offset*2,offset*2+64)));
 if(!Number.isSafeInteger(offset)||offset<9*32||offset%32||!Number.isSafeInteger(length)||length>16
  ||(offset+32+length)*2>bytes.length)throw Error('Incomplete Perps quote symbol');
 const quote=Buffer.from(bytes.slice((offset+32)*2,(offset+32+length)*2),'hex').toString();
 if(!['USD','USDC','vbUSDC'].includes(quote))throw Error('Unverified Perps quote asset');
 const maker=BigInt.asIntN(256,word(log.data,7)),taker=word(log.data,8);
 if(maker<-(2n**63n)||maker>=2n**63n||taker>=2n**64n)throw Error('Invalid Perps fee units');
 return maker+taker;
}
function sumNumbers(value){
 if(typeof value==='number'&&Number.isFinite(value))return value;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100)throw Error('Unverified revenue breakdown');
 const values=Object.values(value);if(!values.length||values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('Unverified revenue breakdown');
 return values.reduce((sum,v)=>sum+v,0);
}
/* A multi-chain aggregate is never a Katana reading. No fallback to global TVL,
   volume, annualised rates, all-chain revenue or missing-day zeroes. */
export function llamaRevenueDays(data,id,now){
 const feed=REVENUE_FEEDS[id];if(!feed||!feed.names.includes(data?.name)||!Array.isArray(data.chains))throw Error('Unverified revenue provider identity');
 const chains=data.chains.map(c=>String(c).toLowerCase()),single=chains.length===1&&chains[0]==='katana';
 if(!chains.includes('katana'))throw Error('No Katana revenue coverage');
 const series=Array.isArray(data.totalDataChartBreakdown)&&data.totalDataChartBreakdown.length?data.totalDataChartBreakdown:single?data.totalDataChart:null;
 if(!Array.isArray(series))throw Error('No verified Katana daily breakdown');
 const rows=new Map(),end=reportingEnd(now),start=end-30*REVENUE_DAY,observedAt=new Date(now*1000).toISOString();
 for(const row of series){
  if(!Array.isArray(row)||row.length!==2)throw Error('Invalid revenue series');const ts=Number(row[0]);
  if(!Number.isSafeInteger(ts)||ts%REVENUE_DAY)throw Error('Unverified revenue reporting boundary');if(ts<start||ts>=end)continue;
  const value=row[1];let amount;
  if(typeof value==='number'){if(!single)throw Error('All-chain revenue is not Katana revenue');amount=value;}
  else{const key=value&&Object.keys(value).find(k=>k.toLowerCase()==='katana');if(!key)continue;amount=sumNumbers(value[key]);}
  const next={day:revenueDay(ts),usdMicros:usdMicros(amount),observedAt,evidenceUrl:feed.url,metric:feed.metric};
  const old=rows.get(next.day);if(old&&old.usdMicros!==next.usdMicros)throw Error('Conflicting daily revenue');rows.set(next.day,next);
 }
 if(!rows.size)throw Error('No completed Katana reporting days');return [...rows.values()].sort((a,b)=>a.day.localeCompare(b.day));
}
async function jsonGet(url){
 const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error('Revenue source HTTP '+r.status);return r.json();
}
function createRpcBudget({maxRequests=64,timeoutMs=22000}={}){
 let used=0;const deadline=Date.now()+timeoutMs;
 return async(method,params)=>{
  if(++used>maxRequests||Date.now()>=deadline)throw Error('Perps reading budget reached; no partial day was saved');
  const r=await fetch(CFG.katRpc,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(Math.max(1,Math.min(8000,deadline-Date.now())))});
  if(!r.ok)throw Error('Katana RPC HTTP '+r.status);const j=await r.json();if(j.error)throw Error(j.error.message);if(!Object.hasOwn(j,'result'))throw Error('Missing Katana RPC result');return j.result;
 };
}
export async function readPerpsRevenueDays(existing,{now=Math.floor(Date.now()/1000),maxDays=1,maxRequests=64,timeoutMs=22000,rpc=createRpcBudget({maxRequests,timeoutMs})}={}){
 const head=Number(BigInt(await rpc('eth_blockNumber',[]))),blocks=new Map();
 async function stamp(n){if(!blocks.has(n)){const b=await rpc('eth_getBlockByNumber',[hex(n),false]);if(!b?.timestamp)throw Error('Missing reporting block time');blocks.set(n,Number(BigInt(b.timestamp)));}return blocks.get(n);}
 const headTs=await stamp(head),end=reportingEnd(Math.min(now,headTs));
 async function firstBlock(ts){
  let guess=Math.max(0,head-(headTs-ts)),time=await stamp(guess);if(time===ts)return guess;
  let lo=time<ts?guess+1:0,hi=time<ts?head:guess;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(await stamp(mid)<ts)lo=mid+1;else hi=mid;}
  if(await stamp(lo)<ts)throw Error('Reporting interval is ahead of the RPC');return lo;
 }
 const known=new Set(existing.map(r=>r.day)),rows=[];
 for(let day=0;day<30&&rows.length<maxDays;day++){
  const to=end-day*REVENUE_DAY,from=to-REVENUE_DAY,date=revenueDay(from);if(known.has(date))continue;
  try{
  const [a,b]=[await firstBlock(from),await firstBlock(to)],seen=new Set();let pips=0n,count=0;
  async function scan(lo,hi){
   let logs;try{logs=await rpc('eth_getLogs',[{address:PERPS_EXCHANGE,topics:[PERPS_TRADE_TOPIC],fromBlock:hex(lo),toBlock:hex(hi)}]);
    if(!Array.isArray(logs))throw Error('Malformed Perps logs');if(logs.length>=10000)throw Error('Perps log count limit exceeded');
   }catch(e){if(!/log.*(?:count.*)?limit|limit.*(?:exceeded|results)|more than.*results/i.test(e.message)||lo>=hi)throw e;
    const mid=Math.floor((lo+hi)/2);await scan(lo,mid);await scan(mid+1,hi);return;}
   for(const l of logs){const block=Number(BigInt(l.blockNumber)),ts=l.blockTimestamp&&l.blockTimestamp!=='0x0'?Number(BigInt(l.blockTimestamp)):await stamp(block),
     key=l.transactionHash+':'+l.logIndex;
    if(!/^0x[0-9a-f]{64}$/i.test(l.transactionHash||'')||!/^0x[0-9a-f]+$/i.test(l.logIndex||'')||block<lo||block>hi||ts<from||ts>=to||seen.has(key))throw Error('Incomplete or duplicate Perps fee interval');
    seen.add(key);pips+=perpsTradeFees(l);count++;
   }
  }
  await scan(a,b-1);
  const micro=pips>=0n?(pips+50n)/100n:-((-pips+50n)/100n);
  rows.push({day:date,usdMicros:micro.toString(),observedAt:new Date(now*1000).toISOString(),evidenceUrl:PERPS_EVIDENCE,
   metric:'net_normal_trade_fees',quote:'vbUSDC valued at $1',quotePips:pips.toString(),trades:count,fromBlock:a,toBlock:b-1});
  }catch(error){if(!rows.length)throw error;break;}
 }
 return rows.sort((a,b)=>a.day.localeCompare(b.day));
}

export async function collectKatanaRevenue(input,{now=Math.floor(Date.now()/1000),maxPerpsDays=1,maxRequests=64,timeoutMs=22000,
 maxSwapDays=maxPerpsDays,getJson=jsonGet,readPerps=readPerpsRevenueDays,readSwap=readSwapRevenueDays}={}){
 const ledger=structuredClone(validateRevenueLedger(input||emptyRevenueLedger())),notes=[];
 await Promise.all(REVENUE_SOURCES.map(async s=>{
  const state={checkedAt:new Date(now*1000).toISOString(),completeRevenue:false};
  try{
   let rows,gross=false;
   if(s.id==='vault_bridge'){ledger.sourceState[s.id]={...state,status:'unconfigured',note:'A verified Vault Bridge revenue feed is not connected. The advertised extra yield is not network revenue.'};return;}
   if(s.id==='swap'){
    try{const result=await readSwap(ledger.observations.swap,ledger.swapCatalog||null,{now,maxDays:maxSwapDays,maxRequests,timeoutMs});
     rows=result.rows;ledger.swapCatalog=result.catalog;
     state.note=`Protocol fees from ${result.catalog?.pools.length??0} priced V3 pools out of ${result.catalog?.totalPools??0} discovered pools. Other tokens/deployments are excluded. Each day uses its closing token prices, before operating costs.`;
    }catch{rows=llamaRevenueDays(await getJson(REVENUE_FEEDS.swap.url),'swap',now);
     state.note='Provider-reported Katana V3 protocol fees only. LP fees and other Swap deployments are outside this reading.';}
   }else if(s.id==='perps'){
    rows=await readPerps(ledger.observations.perps,{now,maxDays:maxPerpsDays,maxRequests,timeoutMs});
    state.note='Normal-trade fees less maker rebates, in vbUSDC at $1; excludes funding, liquidation/withdrawal fees and operating costs.';
   }else{rows=llamaRevenueDays(await getJson(REVENUE_FEEDS[s.id].url),s.id,now);gross=s.id==='sequencer';
    state.note=gross?'Gross gas fees are context only. Costs and the revenue retained by Katana still need a verified feed.':'Reported V3 protocol fees only. LP fees and other Swap deployments are outside this reading.';}
   const target=gross?ledger.grossFees:ledger.observations,merged=mergeRevenueObservations(target[s.id],rows);target[s.id]=merged.rows;
   if(merged.conflicts.length){state.note+=' Earlier recorded days were retained after a provider revision.';notes.push(s.id+': historical provider revision retained for review.');}
   state.status=gross?'gross_only':target[s.id].some(r=>r.day===revenueDay(reportingEnd(now)-REVENUE_DAY))?'reported':'delayed';
   ledger.sourceState[s.id]=state;
  }catch{ledger.sourceState[s.id]={...state,status:ledger.observations[s.id].length?'retained':'unavailable',
    note:s.id==='sequencer'?'A verified sequencer revenue reading is unavailable.':s.id==='perps'?'The complete Perps fee day could not be read. Previously verified days are retained.':'The Katana V3 protocol-revenue feed could not be read. Previously reported days are retained.'};}
 }));
 ledger.updatedAt=new Date(now*1000).toISOString();validateRevenueLedger(ledger);
 return {ledger,view:{...buildRevenueView(ledger,now),notes}};
}
