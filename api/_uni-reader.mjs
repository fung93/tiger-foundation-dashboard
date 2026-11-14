import {encodeAgg3,decodeAgg3,keccakHex} from './_core.mjs';
import {UNI_CHAINS,UNI_FEE_TIERS,UNI_MULTICALL} from './_uni-config.mjs';
import {uniPoolLink,uniPriceFromSqrt} from '../uni-core.mjs';

const hex=n=>'0x'+n.toString(16),pad=n=>String(n).replace(/^0x/,'').padStart(64,'0');
const word=(data,i=0)=>{if(!/^0x[0-9a-f]+$/i.test(data||'')||data.length<66+i*64)throw Error('Incomplete contract reading');return BigInt('0x'+data.slice(2+i*64,66+i*64));};
const addr=data=>'0x'+word(data).toString(16).padStart(64,'0').slice(-40);
const need=row=>{if(!row?.ok)throw Error('A required contract reading failed');word(row.data);return row.data;};
const hash=s=>'0x'+keccakHex(Buffer.from(s).toString('hex')).replace(/^0x/,'');
export const UNI_SWAP_TOPIC=hash('Swap(address,address,int256,int256,uint160,uint128,int24)');
export const UNI_PROTOCOL_TOPIC=hash('SetFeeProtocol(uint8,uint8,uint8,uint8)');
const S={slot:'0x3850c7bd',liquidity:'0x1a686502',spacing:'0xd0c93a7c',factory:'0xc45a0155',token0:'0x0dfe1681',token1:'0xd21220a7',fee:'0xddca3f43',g0:'0xf3058399',g1:'0x46141319',balance:'0x70a08231',decimals:'0x313ce567'};
export function uniLogRangeError(error){const text=String(error?.message||'');return !/rate limit|too many requests|HTTP 429|quota/i.test(text)&&(/log.*limit|more than.*(?:results|logs)|block range|range.*(?:large|exceed)|too many results|response size|limited to.*blocks|limit.*(?:blocks|results|logs|range)|query.*(?:exceed|limit)/i.test(text)||error?.rpcCode===-32005);}
const unavailableMethod=error=>error?.rpcCode===-32601||/method.*(?:not supported|disabled|not available|not found|does not exist)|unsupported method/i.test(String(error?.message||''));

export function createUniRpc(chain,{fetcher=fetch,timeoutMs=14000,maxRequests=64,nowMs=()=>Date.now()}={}){
  const deadline=nowMs()+timeoutMs,verified=new Set(),disabled=new Map();let used=0,preferred=0;
  async function send(url,method,params){
    if(++used>maxRequests||nowMs()>=deadline)throw Error('Pool reading limit reached');
    const r=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
      signal:AbortSignal.timeout(Math.max(1,Math.min(3500,deadline-nowMs())))});
    if(!r.ok)throw Error('Pool source HTTP '+r.status);const j=await r.json();if(j.error)throw Object.assign(Error(String(j.error.message).slice(0,180)),{rpcCode:j.error.code});if(!Object.hasOwn(j,'result'))throw Error('Missing RPC result');return j.result;
  }
  return async(method,params,{validate}={})=>{
    if(!['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getLogs','eth_call','eth_getCode'].includes(method))throw Error('Read-only RPC methods only');
    let last,rangeError;
    for(let n=0;n<chain.rpcs.length;n++){
      const index=(preferred+n)%chain.rpcs.length,url=chain.rpcs[index];
      if(disabled.get(url)?.has(method))continue;
      try{if(!verified.has(url)){if(Number(BigInt(await send(url,'eth_chainId',[])))!==chain.id)throw Error('RPC chain does not match');verified.add(url);}
        const value=await send(url,method,params);
        if(method==='eth_getBlockByNumber'&&(!value?.timestamp||!/^0x[0-9a-f]{64}$/i.test(value.hash||'')||Number(BigInt(value.number))!==Number(BigInt(params[0]))))throw Error('Incomplete block reading from this provider');
        if(method==='eth_blockNumber'&&(!/^0x[0-9a-f]+$/i.test(value||'')||BigInt(value)<=0n))throw Error('Incomplete block number from this provider');
        if(validate&&!validate(value))throw Error('Incomplete contract readings from this provider');preferred=index;return value;
      }catch(e){last=e;if(method==='eth_getLogs'&&uniLogRangeError(e))rangeError=e;
        if(unavailableMethod(e)){if(!disabled.has(url))disabled.set(url,new Set());disabled.get(url).add(method);}}
    }
    // Preserve an actionable range error even if a later peer disables logs.
    // The caller can then split the query instead of discarding a whole day.
    throw rangeError||last||Error('Pool source unavailable');
  };
}
async function multi(rpc,calls,block){
  const out=[];for(let i=0;i<calls.length;i+=64){const batch=calls.slice(i,i+64);let best=null,score=-1;
    const validate=value=>{const rows=decodeAgg3(value,batch.length),good=rows.filter(r=>r.ok&&r.data.length>=66).length;if(good>score){score=good;best=rows;}return good===batch.length;};
    try{const value=await rpc('eth_call',[{to:UNI_MULTICALL,data:encodeAgg3(batch)},hex(block)],{validate});validate(value);}catch(e){if(!best)throw e;}
    if(!best)throw Error('Incomplete batch reading');out.push(...best);}return out;
}
export async function uniReadingClock(rpc,{pinnedTip}={}){
  const head=pinnedTip?.number??Number(BigInt(await rpc('eth_blockNumber',[]))),blocks=new Map(pinnedTip?[[head,pinnedTip]]:[]);
  async function block(n){if(!blocks.has(n)){const row=await rpc('eth_getBlockByNumber',[hex(n),false]);if(!row||!row.timestamp||Number(BigInt(row.number))!==n||!/^0x[0-9a-f]{64}$/i.test(row.hash||''))throw Error('Unverified block');blocks.set(n,{number:n,ts:Number(BigInt(row.timestamp)),hash:row.hash});}return blocks.get(n);}
  const tip=await block(head);
  async function before(ts){
    const prior=await block(Math.max(0,head-4096)),spacing=(tip.ts-prior.ts)/(head-prior.number);
    if(!(spacing>0))throw Error('Unverified chain clock');
    const guess=Math.max(0,head-Math.ceil((tip.ts-ts)/spacing));let span=4096,lo=Math.max(0,guess-span),hi=Math.min(head,guess+span);
    while((await block(lo)).ts>ts&&lo>0){span*=2;lo=Math.max(0,guess-span);}
    while((await block(hi)).ts<ts&&hi<head){span*=2;hi=Math.min(head,guess+span);}
    if((await block(lo)).ts>ts)throw Error('No full fee-history interval');
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if((await block(mid)).ts<=ts)lo=mid;else hi=mid-1;}
    return block(lo);
  }
  return {tip,block,before};
}
export async function completeUniLogs(rpc,addresses,from,to){
  if(from>to)return [];
  if(addresses.length>1){const out=[];for(const address of addresses)out.push(...await completeUniLogs(rpc,[address],from,to));return out;}
  if(to-from>=5000){const out=[];for(let a=from;a<=to;a+=5000)out.push(...await completeUniLogs(rpc,addresses,a,Math.min(to,a+4999)));return out;}
  try{const logs=await rpc('eth_getLogs',[{address:addresses[0],topics:[[UNI_SWAP_TOPIC,UNI_PROTOCOL_TOPIC]],fromBlock:hex(from),toBlock:hex(to)}]);
    if(!Array.isArray(logs))throw Error('Malformed pool logs');if(logs.length>=10000)throw Error('Log result limit exceeded');return logs;
  }catch(e){if(!uniLogRangeError(e)||from>=to)throw e;
    const mid=Math.floor((from+to)/2);return [...await completeUniLogs(rpc,addresses,from,mid),...await completeUniLogs(rpc,addresses,mid+1,to)];}
}
export function uniObservedTrading(logs,pool,fromBlock,toBlock,initialProtocol){
  let protocol=initialProtocol,volume=0,fees=0,priorTick=null,covered=0,total=0;const seen=new Set(),perL=[0,0];
  const sorted=[...logs].sort((a,b)=>Number(BigInt(a.blockNumber)-BigInt(b.blockNumber))||Number(BigInt(a.logIndex)-BigInt(b.logIndex)));
  for(const log of sorted){
    const block=Number(BigInt(log.blockNumber)),key=log.transactionHash+':'+log.logIndex;
    if(log.address?.toLowerCase()!==pool.pool||log.removed||block<fromBlock||block>toBlock||!/^0x[0-9a-f]{64}$/i.test(log.transactionHash||'')||seen.has(key))throw Error('Unverified pool log interval');seen.add(key);
    // IUniswapV3PoolEvents: old0, old1, new0, new1 (not interleaved).
    if(log.topics?.[0]===UNI_PROTOCOL_TOPIC){const p=[0,1,2,3].map(i=>Number(word(log.data,i)));if(p.some(n=>n!==0&&(n<4||n>10)))throw Error('Invalid protocol fee');if(p[0]+16*p[1]!==protocol)throw Error('Incomplete fee protocol history');protocol=p[2]+16*p[3];continue;}
    if(log.topics?.[0]!==UNI_SWAP_TOPIC)throw Error('Unexpected pool event');
    const amounts=[0,1].map(i=>BigInt.asIntN(256,word(log.data,i))),side=amounts[0]>0n?0:1;
    if(amounts[side]<=0n||amounts[1-side]>=0n)throw Error('Unverified swap input');
    const token=pool['token'+side],input=Number(amounts[side])/10**token.decimals*token.usd,divisor=side===0?protocol%16:protocol>>4;
    volume+=input;fees+=input*pool.fee/1e6*(divisor?1-1/divisor:1);
    const tick=Number(BigInt.asIntN(256,word(log.data,4))),L=word(log.data,3);if(!Number.isInteger(tick)||Math.abs(tick)>887272||L>=2n**128n)throw Error('Unverified swap liquidity');total++;
    // Within one usable-tick interval no initialized liquidity boundary can be
    // crossed. Ignore the first swap and all crossings rather than guessing
    // their per-step liquidity. Integer rounding keeps the sampled fee a lower bound.
    if(priorTick!==null&&L>0n&&Math.floor(priorTick/pool.tickSpacing)===Math.floor(tick/pool.tickSpacing)){
      const gross=amounts[side]*BigInt(pool.fee)/1000000n,lp=divisor?gross*BigInt(divisor-1)/BigInt(divisor):gross;
      perL[side]+=Number(lp)/Number(L)/10**token.decimals;covered++;
    }
    priorTick=tick;
  }
  if(![volume,fees,...perL].every(Number.isFinite))throw Error('Invalid pool totals');return {volumeUsd:volume,feesUsd:fees,feeProtocol:protocol,perL,coveredSwaps:covered,totalSwaps:total};
}
export function uniInitialProtocol(logs,pool,from,to){
  let protocol=pool.feeProtocol;
  const changes=logs.filter(l=>l.topics?.[0]===UNI_PROTOCOL_TOPIC).sort((a,b)=>Number(BigInt(b.blockNumber)-BigInt(a.blockNumber))||Number(BigInt(b.logIndex)-BigInt(a.logIndex)));
  for(const l of changes){const block=Number(BigInt(l.blockNumber));if(l.address?.toLowerCase()!==pool.pool||l.removed||block<from||block>to)throw Error('Unverified fee protocol interval');
    const p=[0,1,2,3].map(i=>Number(word(l.data,i)));if(p.some(n=>n!==0&&(n<4||n>10))||p[2]+16*p[3]!==protocol)throw Error('Incomplete fee protocol history');protocol=p[0]+16*p[1];}
  return protocol;
}
export function uniFailureReason(error){const message=String(error?.message||'');return /budget|reading limit/i.test(message)?'budget_exhausted':/chain.*match/i.test(message)?'chain_mismatch':/behind/i.test(message)?'stale_chain':/timeout|timed out|abort/i.test(message)?'timeout':/429|rate limit/i.test(message)?'rate_limited':uniLogRangeError(error)?'log_range_limit':unavailableMethod(error)?'method_unavailable':/archive|historical|missing trie/i.test(message)?'archive_unavailable':/contract|multicall|batch/i.test(message)?'contract_read_failed':/HTTP (\d{3})/.test(message)?'source_http_'+message.match(/HTTP (\d{3})/)[1]:'source_unavailable';}
export async function readUniChain(chain,{rpc,historyRpc,archiveRpc,now=Math.floor(Date.now()/1000),savedPools=[],currentTimeoutMs=14000,historyTimeoutMs=24000,archiveTimeoutMs=8000,maxHistoryRequests=140}={}){
  const supplied=rpc;rpc=rpc||createUniRpc(chain,{timeoutMs:currentTimeoutMs});
  const clock=await uniReadingClock(rpc),{tip}=clock;if(Math.abs(now-tip.ts)>180)throw Error('The chain reading is behind; keeping the previous figures');
  const candidates=chain.stables.flatMap(stable=>UNI_FEE_TIERS.map(fee=>({stable,fee}))),calls=candidates.map(c=>({to:chain.factory,data:'0x1698ee82'+pad(chain.uni.address)+pad(c.stable.address)+pad(c.fee.toString(16))}));
  const discovered=await multi(rpc,calls,tip.number),catalog=[],notes=[];
  for(let i=0;i<candidates.length;i++){try{const pool=addr(need(discovered[i]));if(pool!=='0x'+'0'.repeat(40))catalog.push({...candidates[i],pool});}catch{notes.push('Some fee tiers could not be checked.');}}
  if(notes.length&&catalog.length===0)throw Error('Pool discovery is incomplete');
  if(new Set(catalog.map(p=>p.pool)).size!==catalog.length)throw Error('Conflicting pool discovery');
  if(!catalog.length)return {key:chain.key,name:chain.name,status:'fresh',at:tip.ts,block:tip.number,pools:[],notes};
  const usedTokens=[chain.uni,...new Map(catalog.map(c=>[c.stable.address,c.stable])).values()],identity=await multi(rpc,usedTokens.map(t=>({to:t.address,data:S.decimals})),tip.number);
  for(let i=0;i<identity.length;i++)if(Number(word(need(identity[i])))!==usedTokens[i].decimals)throw Error('Token identity/decimals could not be verified');
  const stateCalls=catalog.flatMap(c=>[S.slot,S.liquidity,S.spacing,S.factory,S.token0,S.token1,S.fee,S.g0,S.g1].map(data=>({to:c.pool,data})).concat(
    [{to:chain.uni.address,data:S.balance+pad(c.pool)},{to:c.stable.address,data:S.balance+pad(c.pool)}]));
  const state=await multi(rpc,stateCalls,tip.number),pools=[];
  for(let i=0;i<catalog.length;i++){const c=catalog[i];try{
    const raw=state.slice(i*11,i*11+11),r=raw.map((v,k)=>k===7||k===8?v?.data:need(v)),tokens=[chain.uni,c.stable].sort((a,b)=>a.address.localeCompare(b.address));
    if(addr(r[3])!==chain.factory||addr(r[4])!==tokens[0].address||addr(r[5])!==tokens[1].address||Number(word(r[6]))!==c.fee)throw Error('Pool identity does not match Uniswap');
    const baseIndex=tokens[0].address===chain.uni.address?0:1,slot=r[0],sqrtRaw=word(slot),tick=Number(BigInt.asIntN(256,word(slot,1))),spacing=Number(word(r[2]));
    if(!(sqrtRaw>0n)||!(spacing>0)||!Number.isInteger(tick)||Math.abs(tick)>887272)continue;
    const pool={id:chain.key+':'+c.pool,pool:c.pool,chain:chain.key,chainName:chain.name,chainId:chain.id,protocol:'Uniswap v3',fee:c.fee,stable:c.stable.symbol,
      baseIndex,token0:{...tokens[0]},token1:{...tokens[1]},sqrtPriceX96:sqrtRaw.toString(),sqrtPrice:Number(sqrtRaw)/2**96,tick,tickSpacing:spacing,
      activeLiquidity:Number(word(r[1])),feeProtocol:Number(word(slot,5)),at:tip.ts,block:tip.number,blockHash:tip.hash,status:'fresh',
      feeWindow:null,volume24hUsd:null,fees24hUsd:null,apr:null,link:uniPoolLink(chain.key,c.pool)};
    pool.price=uniPriceFromSqrt(sqrtRaw,pool);if(!(pool.price>0)||!Number.isFinite(pool.price))throw Error('Invalid UNI price');
    pool['token'+baseIndex].usd=pool.price;pool['token'+(1-baseIndex)].usd=1;
    pool.tvlUsd=Number(word(r[9]))/1e18*pool.price+Number(word(r[10]))/10**c.stable.decimals;
    try{pool._growth=[word(need(raw[7])),word(need(raw[8]))];}catch{pool._growth=null;}
    if(pool.tvlUsd>=1)pools.push(pool);
  }catch{notes.push('A pool reading is unavailable; it was not treated as empty.');}}
  if(!pools.length&&notes.some(n=>n.startsWith('A pool reading')))throw Error('Required pool contract readings are unavailable');
  // Confirm current price/balances before starting expensive history. History
  // has its own RPC budget and can no longer erase a valid current TVL reading.
  const final=await rpc('eth_getBlockByNumber',[hex(tip.number),false]);if(final?.hash!==tip.hash)throw Error('Chain block changed during the reading');
  const history=historyRpc||supplied||createUniRpc(chain,{timeoutMs:historyTimeoutMs,maxRequests:maxHistoryRequests});
  let start,historyClock,historyReason=null;
  try{
    historyClock=await uniReadingClock(history,{pinnedTip:tip});start=await historyClock.before(tip.ts-86400);const seconds=tip.ts-start.ts;
    if(seconds<82800||seconds>90000)throw Error('The fee window is not a complete day');
    // Archives and logs must not consume each other's time/request allowance.
    // Run independent reads in parallel; a slow archive cannot starve fee totals.
    const archive=archiveRpc||supplied||createUniRpc(chain,{timeoutMs:archiveTimeoutMs,maxRequests:48});
    const archiveTask=async()=>{
      const before=await multi(archive,pools.flatMap(p=>[S.g0,S.g1].map(data=>({to:p.pool,data}))),start.number);
      for(let i=0;i<pools.length;i++){const p=pools[i];try{let old;
        if(!p._growth)throw Error('Current fee growth is unavailable');
        const pair=before.slice(i*2,i*2+2);if(pair.length===2&&pair.every(r=>r.ok&&r.data?.length>=66))old=[word(pair[0].data),word(pair[1].data)];
        else{const code=await archive('eth_getCode',[p.pool,hex(start.number)]);if(code!=='0x')throw Error('Archive fee reading unavailable');old=[0n,0n];}
        p.feeWindow={verified:true,method:'fee_growth',seconds,fromTs:start.ts,toTs:tip.ts,fromBlock:start.number,toBlock:tip.number,
          perL0Day:Number(BigInt.asUintN(256,p._growth[0]-old[0]))/2**128/10**p.token0.decimals*86400/seconds,
          perL1Day:Number(BigInt.asUintN(256,p._growth[1]-old[1]))/2**128/10**p.token1.decimals*86400/seconds};
      }catch{/* A failed archive method does not block independent swap totals. */}}
    };
    const results=await Promise.allSettled([archiveTask(),pools.length?completeUniLogs(history,pools.map(p=>p.pool),start.number+1,tip.number):Promise.resolve([])]);
    if(results[0].status==='rejected')notes.push('Archive fee growth is unavailable; recent swap evidence was checked independently.');
    if(results[1].status==='rejected')throw results[1].reason;const logs=results[1].value;
    const allowed=new Set(pools.map(p=>p.pool));if(logs.some(l=>!allowed.has(l.address?.toLowerCase())))throw Error('Unexpected pool log');
    for(const p of pools){try{const own=logs.filter(l=>l.address.toLowerCase()===p.pool),initial=uniInitialProtocol(own,p,start.number+1,tip.number),trading=uniObservedTrading(own,p,start.number+1,tip.number,initial);
      if(trading.feeProtocol!==p.feeProtocol)throw Error('Incomplete fee protocol history');p.volume24hUsd=trading.volumeUsd;p.fees24hUsd=trading.feesUsd;p.apr=trading.feesUsd*86400/seconds*365/p.tvlUsd;
      p.tradingWindow={fromTs:start.ts,toTs:tip.ts};
      if(!p.feeWindow&&(trading.coveredSwaps>0||trading.totalSwaps===0))p.feeWindow={verified:true,method:'swap_fee_lower_bound',seconds,fromTs:start.ts,toTs:tip.ts,fromBlock:start.number,toBlock:tip.number,
        perL0Day:trading.perL[0]*86400/seconds,perL1Day:trading.perL[1]*86400/seconds,coveredSwaps:trading.coveredSwaps,totalSwaps:trading.totalSwaps};
    }catch{p.status='partial';p.note='Some recent trading data could not be verified.';}}
  }catch(error){historyReason=uniFailureReason(error);notes.push('Some 24-hour trading data is unavailable. Verified prices and fee growth remain available.');}
  for(const p of pools){
    const saved=savedPools.find(old=>old.id===p.id&&old.fee===p.fee&&old.token0?.address===p.token0.address&&old.token1?.address===p.token1.address&&old.at<=p.at&&p.at-old.at<=8*3600);
    if(!p.feeWindow&&saved?.feeWindow?.verified&&p.at-saved.feeWindow.toTs<=8*3600){p.feeWindow=structuredClone(saved.feeWindow);p.feeHistoryRetained=true;}
    if(p.fees24hUsd===null&&saved&&p.at-(saved.tradingWindow?.toTs??saved.at)<=8*3600&&[saved.fees24hUsd,saved.volume24hUsd,saved.apr].every(Number.isFinite)){p.fees24hUsd=saved.fees24hUsd;p.volume24hUsd=saved.volume24hUsd;p.apr=saved.apr;p.tradingWindow=structuredClone(saved.tradingWindow||{toTs:saved.at});p.tradingRetained=true;}
    if(!p.feeWindow||p.fees24hUsd===null||p.feeHistoryRetained||p.tradingRetained){p.status='partial';p.note='Current TVL and price are live. Fee readings keep their own recorded period.';}
    delete p._growth;
  }
  return {key:chain.key,name:chain.name,status:notes.length||pools.some(p=>p.status!=='fresh')?'partial':'fresh',at:tip.ts,block:tip.number,pools,historyReason,poolsWithTrading:pools.filter(p=>p.fees24hUsd!==null).length,notes:[...new Set(notes)]};
}
export async function readUniPools({now=Math.floor(Date.now()/1000),readChain=readUniChain,saved,currentTimeoutMs,historyTimeoutMs,archiveTimeoutMs,maxHistoryRequests}={}){
  const chains=await Promise.all(Object.values(UNI_CHAINS).map(async chain=>{try{return await readChain(chain,{now,savedPools:saved?.pools||[],currentTimeoutMs,historyTimeoutMs,archiveTimeoutMs,maxHistoryRequests});}catch(e){return {key:chain.key,name:chain.name,status:'unavailable',at:null,pools:[],reason:uniFailureReason(e),notes:['The live pool source could not be reached. Previous readings are retained.']};}}));
  return {schemaVersion:1,checkedAt:now,chains,pools:chains.flatMap(c=>c.pools)};
}
