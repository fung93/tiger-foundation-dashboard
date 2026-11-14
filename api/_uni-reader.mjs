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

export function createUniRpc(chain,{fetcher=fetch,timeoutMs=42000,maxRequests=180,nowMs=()=>Date.now()}={}){
  const deadline=nowMs()+timeoutMs,verified=new Set();let used=0,preferred=0;
  async function send(url,method,params){
    if(++used>maxRequests||nowMs()>=deadline)throw Error('Pool reading limit reached');
    const r=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
      signal:AbortSignal.timeout(Math.max(1,Math.min(6000,deadline-nowMs())))});
    if(!r.ok)throw Error('Pool source HTTP '+r.status);const j=await r.json();if(j.error)throw Error(String(j.error.message).slice(0,180));if(!Object.hasOwn(j,'result'))throw Error('Missing RPC result');return j.result;
  }
  return async(method,params)=>{
    if(!['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getLogs','eth_call','eth_getCode'].includes(method))throw Error('Read-only RPC methods only');
    let last;
    for(let n=0;n<chain.rpcs.length;n++){
      const index=(preferred+n)%chain.rpcs.length,url=chain.rpcs[index];
      try{if(!verified.has(url)){if(Number(BigInt(await send(url,'eth_chainId',[])))!==chain.id)throw Error('RPC chain does not match');verified.add(url);}
        const value=await send(url,method,params);preferred=index;return value;
      }catch(e){last=e;}
    }
    throw last||Error('Pool source unavailable');
  };
}
async function multi(rpc,calls,block){
  const out=[];for(let i=0;i<calls.length;i+=200){const batch=calls.slice(i,i+200),rows=decodeAgg3(await rpc('eth_call',[{to:UNI_MULTICALL,data:encodeAgg3(batch)},hex(block)]),batch.length);
    if(rows.length!==batch.length)throw Error('Incomplete batch reading');out.push(...rows);}return out;
}
export async function uniReadingClock(rpc){
  const head=Number(BigInt(await rpc('eth_blockNumber',[]))),blocks=new Map();
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
  try{const logs=await rpc('eth_getLogs',[{address:addresses,topics:[[UNI_SWAP_TOPIC,UNI_PROTOCOL_TOPIC]],fromBlock:hex(from),toBlock:hex(to)}]);
    if(!Array.isArray(logs))throw Error('Malformed pool logs');if(logs.length>=10000)throw Error('Log result limit exceeded');return logs;
  }catch(e){if(!/log.*limit|more than.*(?:results|logs)|block range|range.*(?:large|exceed)|too many results|response size|limited to.*blocks/i.test(e.message)||from>=to)throw e;
    const mid=Math.floor((from+to)/2);return [...await completeUniLogs(rpc,addresses,from,mid),...await completeUniLogs(rpc,addresses,mid+1,to)];}
}
export function uniObservedTrading(logs,pool,fromBlock,toBlock,initialProtocol){
  let protocol=initialProtocol,volume=0,fees=0;const seen=new Set();
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
  }
  if(![volume,fees].every(Number.isFinite))throw Error('Invalid pool totals');return {volumeUsd:volume,feesUsd:fees,feeProtocol:protocol};
}
export async function readUniChain(chain,{rpc=createUniRpc(chain),now=Math.floor(Date.now()/1000)}={}){
  const clock=await uniReadingClock(rpc),{tip}=clock;if(Math.abs(now-tip.ts)>180)throw Error('The chain reading is behind; keeping the previous figures');
  const candidates=chain.stables.flatMap(stable=>UNI_FEE_TIERS.map(fee=>({stable,fee}))),calls=candidates.map(c=>({to:chain.factory,data:'0x1698ee82'+pad(chain.uni.address)+pad(c.stable.address)+pad(c.fee.toString(16))}));
  const discovered=await multi(rpc,calls,tip.number),catalog=[],notes=[];
  for(let i=0;i<candidates.length;i++){try{const pool=addr(need(discovered[i]));if(pool!=='0x'+'0'.repeat(40))catalog.push({...candidates[i],pool});}catch{notes.push('Some fee tiers could not be checked.');}}
  if(notes.length&&catalog.length===0)throw Error('Pool discovery is incomplete');
  if(new Set(catalog.map(p=>p.pool)).size!==catalog.length)throw Error('Conflicting pool discovery');
  const identity=await multi(rpc,[chain.uni,...chain.stables].map(t=>({to:t.address,data:S.decimals})),tip.number);
  for(let i=0;i<identity.length;i++)if(Number(word(need(identity[i])))!==[chain.uni,...chain.stables][i].decimals)throw Error('Token identity/decimals could not be verified');
  if(!catalog.length)return {key:chain.key,name:chain.name,status:'fresh',at:tip.ts,block:tip.number,pools:[],notes};
  const stateCalls=catalog.flatMap(c=>[S.slot,S.liquidity,S.spacing,S.factory,S.token0,S.token1,S.fee,S.g0,S.g1].map(data=>({to:c.pool,data})).concat(
    [{to:chain.uni.address,data:S.balance+pad(c.pool)},{to:c.stable.address,data:S.balance+pad(c.pool)}]));
  const state=await multi(rpc,stateCalls,tip.number),pools=[];
  for(let i=0;i<catalog.length;i++){const c=catalog[i];try{
    const r=state.slice(i*11,i*11+11).map(need),tokens=[chain.uni,c.stable].sort((a,b)=>a.address.localeCompare(b.address));
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
    pool._growth=[word(r[7]),word(r[8])];
    if(pool.tvlUsd>=1)pools.push(pool);
  }catch{notes.push('A pool reading is unavailable; it was not treated as empty.');}}
  let start;
  try{
    start=await clock.before(tip.ts-86400);const seconds=tip.ts-start.ts;
    if(seconds<82800||seconds>90000)throw Error('The fee window is not a complete day');
    const before=await multi(rpc,pools.flatMap(p=>[S.g0,S.g1,S.slot].map(data=>({to:p.pool,data}))),start.number);
    for(let i=0;i<pools.length;i++){const p=pools[i];try{const rows=before.slice(i*3,i*3+3);let old,protocol;
      if(rows.every(r=>r.ok&&r.data?.length>=66)){old=[word(rows[0].data),word(rows[1].data)];protocol=Number(word(rows[2].data,5));}
      else{const code=await rpc('eth_getCode',[p.pool,hex(start.number)]);if(code!=='0x')throw Error('Archive fee reading unavailable');old=[0n,0n];protocol=0;}
      p._initialProtocol=protocol;p.feeWindow={verified:true,seconds,fromTs:start.ts,toTs:tip.ts,fromBlock:start.number,toBlock:tip.number,
        perL0Day:Number(BigInt.asUintN(256,p._growth[0]-old[0]))/2**128/10**p.token0.decimals*86400/seconds,
        perL1Day:Number(BigInt.asUintN(256,p._growth[1]-old[1]))/2**128/10**p.token1.decimals*86400/seconds};
    }catch{p.status='partial';p.note='Current price is available; the 24-hour fee history could not be verified.';}}
    const logs=pools.length?await completeUniLogs(rpc,pools.map(p=>p.pool),start.number+1,tip.number):[];
    const allowed=new Set(pools.map(p=>p.pool));if(logs.some(l=>!allowed.has(l.address?.toLowerCase())))throw Error('Unexpected pool log');
    for(const p of pools){try{if(p._initialProtocol===undefined)continue;const trading=uniObservedTrading(logs.filter(l=>l.address.toLowerCase()===p.pool),p,start.number+1,tip.number,p._initialProtocol);
      if(trading.feeProtocol!==p.feeProtocol)throw Error('Incomplete fee protocol history');p.volume24hUsd=trading.volumeUsd;p.fees24hUsd=trading.feesUsd;p.apr=trading.feesUsd*86400/seconds*365/p.tvlUsd;
    }catch{p.status='partial';p.note='Some recent trading data could not be verified.';}}
  }catch{notes.push('Some 24-hour trading data is unavailable. Verified prices and fee growth remain available.');}
  for(const p of pools){delete p._growth;delete p._initialProtocol;}
  // Confirm the pinned block survived the read; a reorg never becomes a new snapshot.
  const final=await rpc('eth_getBlockByNumber',[hex(tip.number),false]);if(final?.hash!==tip.hash)throw Error('Chain block changed during the reading');
  return {key:chain.key,name:chain.name,status:notes.length||pools.some(p=>p.status!=='fresh')?'partial':'fresh',at:tip.ts,block:tip.number,pools,notes:[...new Set(notes)]};
}
export async function readUniPools({now=Math.floor(Date.now()/1000),readChain=readUniChain}={}){
  const chains=await Promise.all(Object.values(UNI_CHAINS).map(async chain=>{try{return await readChain(chain,{now});}catch{return {key:chain.key,name:chain.name,status:'unavailable',at:null,pools:[],notes:['The live pool source could not be reached. Previous readings are retained.']};}}));
  return {schemaVersion:1,checkedAt:now,chains,pools:chains.flatMap(c=>c.pools)};
}
