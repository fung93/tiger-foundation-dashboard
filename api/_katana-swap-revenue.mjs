/* Protocol-fee counters + actual protocol collections. Never sum LP Collect
   events, volume or today's fee tier as historical network revenue. */
import {CFG,keccakHex,encodeAgg3,decodeAgg3} from './_core.mjs';
import {KATANA_ASSETS,KATANA_USD_POOLS} from './_katana-config.mjs';
import {createRevenueRpc,revenueClock,completeRevenueLogs} from './_katana-revenue-rpc.mjs';
import {REVENUE_DAY,reportingEnd,revenueDay,usdMicros} from '../katana-revenue-core.mjs';
const topic=s=>'0x'+keccakHex(Buffer.from(s).toString('hex')).replace(/^0x/,''),selector=s=>topic(s).slice(0,10),
 CREATED=topic('PoolCreated(address,address,uint24,int24,address)'),COLLECTED=topic('CollectProtocol(address,address,uint128,uint128)'),
 PROTOCOL=selector('protocolFees()'),SLOT='0x3850c7bd',CONVERT=selector('convertToAssets(uint256)'),
 hex=n=>'0x'+n.toString(16),word=(h,i)=>BigInt('0x'+h.slice(2+i*64,66+i*64)),assets=new Map(Object.values(KATANA_ASSETS).map(t=>[t.address,t]));
const evidence='https://github.com/DefiLlama/dimension-adapters/blob/9fef43d/dexs/sushiswap-v3.ts';
export function validateSwapRevenueCatalog(c){
 if(!c||c.factory!==CFG.factory.toLowerCase()||!Array.isArray(c.pools)||!Number.isSafeInteger(c.toBlock)||c.toBlock<0
  ||!Number.isSafeInteger(c.totalPools)||c.totalPools<c.pools.length)throw Error('Invalid Swap pool catalog');
 const seen=new Set();for(const p of c.pools){if(!/^0x[0-9a-f]{40}$/.test(p.pool||'')||seen.has(p.pool)||!assets.has(p.token0)||!assets.has(p.token1)
  ||p.token0>=p.token1||!Number.isSafeInteger(p.createdBlock)||p.createdBlock<0||p.createdBlock>c.toBlock)throw Error('Invalid Swap pool catalog');seen.add(p.pool);}return c;
}
export function swapProtocolAccrual(before,after,collected){
 const out=after.map((n,i)=>BigInt(n)-BigInt(before[i])+BigInt(collected[i]));
 if(out.some(n=>n<0n))throw Error('Unreconciled protocol-fee counter decrease');return out;
}
export async function readSwapRevenueDays(existing,catalog,{now=Math.floor(Date.now()/1000),maxDays=1,maxRequests=64,timeoutMs=22000,
 rpc=createRevenueRpc({maxRequests,timeoutMs})}={}){
 const clock=await revenueClock(rpc),end=reportingEnd(Math.min(now,clock.headTs));
 if(catalog){validateSwapRevenueCatalog(catalog);if(catalog.toBlock>clock.head)throw Error('RPC head is behind the Swap catalog');}
 const saved=catalog?structuredClone(catalog):{factory:CFG.factory.toLowerCase(),toBlock:0,totalPools:0,pools:[]},known=new Set(saved.pools.map(p=>p.pool));
 const discovered=catalog&&saved.toBlock===clock.head?[]:await completeRevenueLogs(rpc,{address:CFG.factory,topics:[CREATED]},catalog?saved.toBlock+1:0,clock.head);
 const seenCreated=new Set();
 for(const l of discovered){
  if(l.removed||l.address?.toLowerCase()!==saved.factory||l.topics?.[0]!==CREATED||l.topics.length!==4||!/^0x[0-9a-f]{128}$/i.test(l.data||''))throw Error('Malformed Swap pool discovery');
  const token0='0x'+l.topics[1].slice(-40).toLowerCase(),token1='0x'+l.topics[2].slice(-40).toLowerCase(),pool='0x'+l.data.slice(-40).toLowerCase(),key=l.transactionHash+':'+l.logIndex;
  if(seenCreated.has(key))throw Error('Duplicate Swap pool discovery');seenCreated.add(key);saved.totalPools++;
  if(assets.has(token0)&&assets.has(token1)&&!known.has(pool)){saved.pools.push({pool,token0,token1,createdBlock:Number(BigInt(l.blockNumber))});known.add(pool);}
 }
 saved.toBlock=clock.head;
 if(!saved.pools.length||saved.pools.length>200)throw Error('Swap priced-pool coverage is unavailable or exceeds the read budget');
 const quoteAssets=[KATANA_ASSETS.KAT,KATANA_ASSETS.ETH,KATANA_ASSETS.BTC],snapshots=new Map();
 async function snapshot(block){
  if(snapshots.has(block))return snapshots.get(block);
  const calls=[...saved.pools.map(p=>({to:p.pool,data:PROTOCOL})),...quoteAssets.map(t=>({to:KATANA_USD_POOLS[t.address],data:SLOT})),
   ...quoteAssets.map(t=>({to:KATANA_USD_POOLS[t.address],data:'0x1a686502'})),
   {to:KATANA_ASSETS.avKAT.address,data:CONVERT+(10n**18n).toString(16).padStart(64,'0')}],
   raw=await rpc('eth_call',[{to:CFG.multicall,data:encodeAgg3(calls)},hex(block)]),r=decodeAgg3(raw,calls.length),counters={};
  for(let i=0;i<saved.pools.length;i++){const p=saved.pools[i];if(p.createdBlock>block){counters[p.pool]=[0n,0n];continue;}
   if(!r[i]?.ok||r[i].data.length<130)throw Error('A protocol fee counter is unavailable');counters[p.pool]=[word(r[i].data,0),word(r[i].data,1)];}
  const prices={[KATANA_ASSETS.USDC.address]:1,[KATANA_ASSETS.USDT.address]:1};
  quoteAssets.forEach((t,i)=>{const q=r[saved.pools.length+i],liq=r[saved.pools.length+3+i];
   if(!q?.ok||q.data.length<130||!liq?.ok||liq.data.length<66||word(liq.data,0)<=0n)throw Error('A historical Swap dollar quote is unavailable');
   const sqrt=Number(word(q.data,0))/2**96,first=t.address<KATANA_ASSETS.USDC.address,ratio=sqrt*sqrt*10**(first?t.decimals-6:6-t.decimals),price=first?ratio:1/ratio;
   if(!Number.isFinite(price)||!(price>0))throw Error('Invalid historical Swap dollar quote');prices[t.address]=price;});
  const rate=r.at(-1);if(!rate?.ok||rate.data.length<66)throw Error('Historical avKAT conversion is unavailable');
  prices[KATANA_ASSETS.avKAT.address]=Number(word(rate.data,0))/1e18*prices[KATANA_ASSETS.KAT.address];
  if(!(prices[KATANA_ASSETS.avKAT.address]>0))throw Error('Invalid historical avKAT quote');
  const result={counters,prices};snapshots.set(block,result);return result;
 }
 const existingDays=new Set(existing.map(r=>r.day)),rows=[];
 for(let d=0;d<30&&rows.length<maxDays;d++){
  const to=end-d*REVENUE_DAY,from=to-REVENUE_DAY,date=revenueDay(from);if(existingDays.has(date))continue;
  try{
   const a=await clock.firstBlock(from),b=await clock.firstBlock(to),[start,finish]=[await snapshot(a-1),await snapshot(b-1)],
    logs=await completeRevenueLogs(rpc,{address:saved.pools.map(p=>p.pool),topics:[COLLECTED]},a,b-1),collected={},seen=new Set();
   for(const l of logs){const pool=l.address?.toLowerCase(),key=l.transactionHash+':'+l.logIndex,block=Number(BigInt(l.blockNumber));
    if(!known.has(pool)||l.topics?.[0]!==COLLECTED||l.data?.length<130||block<a||block>=b||l.removed||seen.has(key))throw Error('Incomplete protocol collection reading');seen.add(key);
    const amounts=collected[pool]||(collected[pool]=[0n,0n]);amounts[0]+=word(l.data,0);amounts[1]+=word(l.data,1);}
   const totals={};
   for(const p of saved.pools){const earned=swapProtocolAccrual(start.counters[p.pool],finish.counters[p.pool],collected[p.pool]||[0n,0n]);
    [p.token0,p.token1].forEach((token,i)=>totals[token]=(totals[token]||0n)+earned[i]);}
   const usd=Object.entries(totals).reduce((sum,[token,amount])=>sum+Number(amount)/10**assets.get(token).decimals*finish.prices[token],0);
   rows.push({day:date,usdMicros:usdMicros(usd),observedAt:new Date(now*1000).toISOString(),evidenceUrl:evidence,metric:'priced_v3_protocol_fee_accrual',
    valuation:'Token fees valued at that UTC reporting day’s closing reference prices; before operating costs.',fromBlock:a,toBlock:b-1,
    trackedPools:saved.pools.length,totalDiscoveredPools:saved.totalPools,tokenAmounts:Object.fromEntries(Object.entries(totals).map(([token,n])=>[token,n.toString()]))});
  }catch(error){if(!rows.length)throw error;break;}
 }
 return {rows,catalog:saved};
}
