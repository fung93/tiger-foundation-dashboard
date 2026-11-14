/* UNI guide: deterministic Uniswap V3 position maths. No network or wallet access. */
import {snapRange,liquidityForCapital,edgeOutcome} from './strategy-core.mjs';

export const UNI_MODES=['uni','stable','balanced'];
export function uniPoolLink(chain,pool){
  if(!['base','bnb'].includes(chain)||!/^0x[0-9a-f]{40}$/i.test(pool))throw Error('Invalid Uniswap pool');
  return `https://app.uniswap.org/explore/pools/${chain}/${pool.toLowerCase()}`;
}
export function uniDefaultInput(pool,mode){
  if(!UNI_MODES.includes(mode)||!(pool.price>0))return null;
  const factors=mode==='uni'?[1.01,1.15]:mode==='stable'?[.85,.99]:[.9,1.1];
  return {mode,amount:mode==='uni'?1000/pool.price:1000,lowerPrice:pool.price*factors[0],upperPrice:pool.price*factors[1]};
}
export function uniEstimate(pool,input){
  if(!UNI_MODES.includes(input.mode))return {error:'Choose how you want to deposit first.'};
  if(!(input.amount>0)||!Number.isFinite(input.amount))return {error:'Enter an amount greater than zero.'};
  if(![input.lowerPrice,input.upperPrice].every(n=>Number.isFinite(n)&&n>0))return {error:'Enter a minimum and maximum price greater than zero.'};
  if(!(pool.price>0)||!(pool.sqrtPrice>0)||!(pool.tickSpacing>0))return {error:'A current pool price is needed.'};
  const range=snapRange(input.lowerPrice,input.upperPrice,pool);if(range.error)return range;
  const inRange=pool.tick>=range.tickLower&&pool.tick<range.tickUpper;
  if(input.mode==='uni'&&(range.lowerPrice<pool.price||inRange))return {error:'For UNI only, set the minimum price above the current price. The position sells UNI as price rises into the range.',range};
  if(input.mode==='stable'&&(range.upperPrice>pool.price||inRange))return {error:'For stablecoin only, set the maximum price below the current price. The position buys UNI as price falls into the range.',range};
  if(input.mode==='balanced'&&(!inRange||!(range.lowerPrice<pool.price&&range.upperPrice>pool.price)))return {error:'For both tokens, put the current price between your minimum and maximum.',range};
  const capital=input.amount*(input.mode==='uni'?pool.price:1),pos=liquidityForCapital(capital,range.tickLower,range.tickUpper,pool);
  if(!pos||!Number.isFinite(pos.liquidity))return {error:'This range cannot be valued. Try prices closer to the current price.',range};
  const base=pool.baseIndex,uni=pos['amount'+base],stable=pos['amount'+(1-base)];
  const growth=pool.feeWindow,verified=growth?.verified===true&&growth.seconds>=82800&&growth.seconds<=90000
    &&pool.at>=growth.toTs&&pool.at-growth.toTs<=8*3600
    &&[growth.perL0Day,growth.perL1Day].every(n=>Number.isFinite(n)&&n>=0);
  // Observed per-liquidity fee growth already excludes protocol fees. Account
  // for a new deposit diluting today's active liquidity; never promise a yield.
  const dilution=pool.activeLiquidity>0?pool.activeLiquidity/(pool.activeLiquidity+pos.liquidity):null;
  let daily=null;
  if(!inRange)daily=0;
  else if(verified&&dilution!==null){daily=pos.liquidity*dilution*(growth.perL0Day*pool.token0.usd+growth.perL1Day*pool.token1.usd);}
  const edge=edgeOutcome(pool,range,pos.liquidity,capital);
  return {range,inRange,capitalUsd:capital,liquidity:pos.liquidity,deposit:{uni,stable},edges:edge,
    feesPerDay:daily,apr:daily===null?null:daily*365/capital,feeBasis:verified?{fromTs:growth.fromTs,toTs:growth.toTs,seconds:growth.seconds,method:growth.method||'fee_growth'}:null};
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
