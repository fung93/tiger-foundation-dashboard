/* UNI guide: deterministic Uniswap V3 position maths. No network or wallet access. */
import {snapRange,liquidityForCapital,edgeOutcome,tickAtPrice,priceAtTick} from './strategy-core.mjs';

export const UNI_MODES=['uni','stable','balanced'];
export function uniPoolLink(chain,pool){
  if(!['base','bnb'].includes(chain)||!/^0x[0-9a-f]{40}$/i.test(pool))throw Error('Invalid Uniswap pool');
  return `https://app.uniswap.org/explore/pools/${chain}/${pool.toLowerCase()}`;
}
export function uniDefaultInput(pool,mode){
  if(!UNI_MODES.includes(mode)||!(pool.price>0))return null;
  const factors=mode==='uni'?[1,1.15]:mode==='stable'?[.85,1]:[.9,1.1];
  return {mode,amount:mode==='uni'?1000/pool.price:1000,lowerPrice:pool.price*factors[0],upperPrice:pool.price*factors[1]};
}
export function uniReadingStatus(pool,{now=pool?.at,liveFailed=false}={}){
  const age=now-pool?.at,within=stamp=>Number.isFinite(stamp)&&Number.isFinite(now)&&now-stamp>=-180&&now-stamp<=8*3600;
  const quote=within(pool?.at)&&[pool?.price,pool?.sqrtPrice].every(n=>Number.isFinite(n)&&n>0),growth=pool?.feeWindow;
  const fees=!!(quote&&growth?.verified===true&&growth.seconds>=82800&&growth.seconds<=90000&&within(growth.toTs)
    &&pool.at>=growth.toTs&&[growth.perL0Day,growth.perL1Day].every(n=>Number.isFinite(n)&&n>=0));
  const totals=!!(quote&&[pool.tvlUsd,pool.volume24hUsd,pool.fees24hUsd,pool.apr].every(n=>Number.isFinite(n)&&n>=0)
    &&within(pool.tradingWindow?.toTs??pool.at));
  const live=!!(quote&&age<=180&&!pool.retained&&!liveFailed);
  return {quote,fees,totals,ready:quote&&fees&&totals&&pool.activeLiquidity>0,live,recorded:quote&&!live};
}
function uniDepositRange(pool,input){
  const range=snapRange(input.lowerPrice,input.upperPrice,pool);if(range.error||input.mode==='balanced')return range;
  const tolerance=pool.price*1e-8;
  if(input.mode==='uni'&&input.lowerPrice<pool.price-tolerance)return {error:'For UNI only, set the minimum at or above the current price.'};
  if(input.mode==='stable'&&input.upperPrice>pool.price+tolerance)return {error:'For stablecoin only, set the maximum at or below the current price.'};
  const s=pool.tickSpacing,limit=Math.floor(887272/s)*s,edge=input.mode==='uni'?input.lowerPrice:input.upperPrice,
    entry=Math.abs(edge-pool.price)<=tolerance?pool.price:edge,tick=tickAtPrice(entry,pool),token0Only=(input.mode==='uni')===(pool.baseIndex===0);
  let lo=range.tickLower,hi=range.tickUpper;
  if(token0Only){lo=Math.max(Math.ceil(tick/s)*s,(Math.floor(pool.tick/s)+1)*s);hi=Math.max(hi,lo+s);}
  else{hi=Math.min(Math.floor(tick/s)*s,Math.floor(pool.tick/s)*s);lo=Math.min(lo,hi-s);}
  if(lo < -limit||hi>limit||!(hi>lo))return {error:'This entry is outside the pool’s usable price range.'};
  const prices=[priceAtTick(lo,pool),priceAtTick(hi,pool)].sort((a,b)=>a-b);
  return {tickLower:lo,tickUpper:hi,lowerPrice:prices[0],upperPrice:prices[1]};
}
export function uniEstimate(pool,input,{now=pool.at}={}){
  if(!UNI_MODES.includes(input.mode))return {error:'Choose how you want to deposit first.'};
  if(!(input.amount>0)||!Number.isFinite(input.amount))return {error:'Enter an amount greater than zero.'};
  if(![input.lowerPrice,input.upperPrice].every(n=>Number.isFinite(n)&&n>0))return {error:'Enter a minimum and maximum price greater than zero.'};
  if(!(pool.price>0)||!(pool.sqrtPrice>0)||!(pool.tickSpacing>0))return {error:'A current pool price is needed.'};
  const reading=uniReadingStatus(pool,{now});
  if(!reading.quote)return {error:'This price reading is too old for an estimate. Waiting for a newer pool reading.'};
  const range=uniDepositRange(pool,input);if(range.error)return range;
  const inRange=pool.tick>=range.tickLower&&pool.tick<range.tickUpper;
  if(input.mode==='balanced'&&(!inRange||!(range.lowerPrice<pool.price&&range.upperPrice>pool.price)))return {error:'For both tokens, put the current price between your minimum and maximum.',range};
  const capital=input.amount*(input.mode==='uni'?pool.price:1),pos=liquidityForCapital(capital,range.tickLower,range.tickUpper,pool);
  if(!pos||!Number.isFinite(pos.liquidity))return {error:'This range cannot be valued. Try prices closer to the current price.',range};
  const base=pool.baseIndex,uni=pos['amount'+base],stable=pos['amount'+(1-base)];
  const growth=pool.feeWindow,verified=reading.fees;
  // Conditional on this position being active with today's background liquidity
  // and observed trading pace. This is not a reading of liquidity at a future
  // entry price. Recorded fee growth already excludes protocol fees.
  const dilution=pool.activeLiquidity>0?pool.activeLiquidity/(pool.activeLiquidity+pos.liquidity):null;
  const projected=verified&&dilution!==null?pos.liquidity*dilution*(growth.perL0Day*pool.token0.usd+growth.perL1Day*pool.token1.usd):null;
  const activeFeesPerDay=Number.isFinite(projected)?projected:null,activeApr=activeFeesPerDay===null?null:activeFeesPerDay*365/capital;
  // Keep earnings at the current price separate: outside the range they are
  // exactly zero even when evidence for the conditional estimate is missing.
  const daily=inRange?activeFeesPerDay:0;
  const edge=edgeOutcome(pool,range,pos.liquidity,capital);
  return {range,inRange,capitalUsd:capital,liquidity:pos.liquidity,deposit:{uni,stable},edges:edge,
    feesPerDay:daily,apr:daily===null?null:daily*365/capital,activeFeesPerDay,activeApr,
    feeBasis:verified?{fromTs:growth.fromTs,toTs:growth.toTs,seconds:growth.seconds,method:growth.method||'fee_growth'}:null};
}
export function uniPriceFromSqrt(sqrtRaw,pool){
  const ratio=(Number(sqrtRaw)/2**96)**2*10**(pool.token0.decimals-pool.token1.decimals);
  return pool.baseIndex===0?ratio:1/ratio;
}

export function emptyUniSnapshot(){return {schemaVersion:1,checkedAt:0,chains:[{key:'base',name:'Base',status:'unavailable',at:null,pools:[]},{key:'bnb',name:'BNB Chain',status:'unavailable',at:null,pools:[]}],pools:[]};}
export function validateUniSnapshot(value){
  if(value?.schemaVersion!==1||!Number.isFinite(value.checkedAt)||!Array.isArray(value.chains)||value.chains.length!==2||!Array.isArray(value.pools)||value.pools.length>56)throw Error('Invalid UNI snapshot');
  if(new Set(value.chains.map(c=>c.key)).size!==2||value.chains.some(c=>!['base','bnb'].includes(c.key)||!['fresh','partial','unavailable'].includes(c.status)))throw Error('Invalid UNI chain coverage');
  const seen=new Set();for(const p of value.pools){if(!['base','bnb'].includes(p.chain)||!/^0x[0-9a-f]{40}$/.test(p.pool||'')||p.id!==p.chain+':'+p.pool||seen.has(p.id)||!(p.at>0)||![p.price,p.sqrtPrice,p.tvlUsd,p.activeLiquidity].every(n=>Number.isFinite(n)&&n>=0)||!(p.price>0)||!(p.sqrtPrice>0)||!Number.isInteger(p.tickSpacing)||p.tickSpacing<=0||![0,1].includes(p.baseIndex))throw Error('Invalid UNI pool observation');seen.add(p.id);
    for(const t of [p.token0,p.token1])if(!t||!/^0x[0-9a-f]{40}$/.test(t.address||'')||!Number.isInteger(t.decimals)||t.decimals<0||t.decimals>24||!(t.usd>0)||!Number.isFinite(t.usd))throw Error('Invalid UNI token observation');
    for(const key of ['fees24hUsd','volume24hUsd','apr'])if(p[key]!==null&&(!Number.isFinite(p[key])||p[key]<0))throw Error('Invalid UNI trading amount');
    if(p.feeWindow&&(!p.feeWindow.verified||![p.feeWindow.perL0Day,p.feeWindow.perL1Day].every(n=>Number.isFinite(n)&&n>=0)||p.feeWindow.seconds<82800||p.feeWindow.seconds>90000||p.feeWindow.toTs-p.feeWindow.fromTs!==p.feeWindow.seconds))throw Error('Invalid UNI fee window');
  }return value;
}
export function mergeUniSnapshots(previous,next){
  validateUniSnapshot(next);const out=structuredClone(next),oldPools=previous?.pools||[],incoming=new Set(next.pools.map(p=>p.id));
  for(const old of oldPools){const source=next.chains.find(c=>c.key===old.chain);if(!incoming.has(old.id)&&(source?.status!=='fresh'||!(source.at>=old.at)))out.pools.push({...structuredClone(old),retained:source?.status==='unavailable'||source?.at>=old.at?true:!!old.retained});}
  out.pools=out.pools.map(p=>{const old=oldPools.find(v=>v.id===p.id);return old?.at>p.at?structuredClone(old):p;});
  if(previous?.checkedAt>next.checkedAt){out.checkedAt=previous.checkedAt;out.chains=out.chains.map(c=>structuredClone(previous.chains?.find(v=>v.key===c.key)||c));}
  return out;
}
