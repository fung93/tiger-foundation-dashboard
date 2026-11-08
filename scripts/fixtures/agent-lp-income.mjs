/* Fully hypothetical LP/campaign inputs for deterministic income-goal tests. */
import { tickAtPrice,priceAtTick,snapRange,liquidityForCapital } from '../../strategy-core.mjs';
const address=n=>'0x'+String(n).padStart(40,'0');
export function incomeContext(now=Date.now(),{reverse=false,othersMultiplier=999,katPerDay=100000,katUsd=.01}={}) {
  const stamp=new Date(now).toISOString(),btc={address:address(81),symbol:'vbWBTC',decimals:8,usd:100000},
    usd={address:address(82),symbol:'vbUSDC',decimals:6,usd:1};
  const campaignStart=Math.floor(now/1000/(14*86400))*(14*86400);
  const pool={pool:address(83),chain:'katana',status:'fresh',ts:stamp,kind:'rewards',token0:reverse?usd:btc,token1:reverse?btc:usd,
    baseIndex:reverse?1:0,base:'vbWBTC',quote:'vbUSDC',price:100000,tickSpacing:10,fee:500,katPerDay,recent:{},
    campaign:{start:campaignStart,end:campaignStart+14*86400,active:true},
    rules:{weightFees:10000,weightToken0:0,weightToken1:0,outOfRange:false}};
  pool.tick=Math.floor(tickAtPrice(pool.price,pool));
  pool.sqrtPrice=Math.sqrt((reverse?1/100000:100000)/10**(pool.token0.decimals-pool.token1.decimals));
  pool.price=priceAtTick(pool.tick,pool);
  for(const [days,low,high]of [[7,90000,110000],[14,85000,120000],[30,80000,125000]]){
    const a=tickAtPrice(low,pool),b=tickAtPrice(high,pool);
    pool.recent[days]={lowTick:Math.floor(Math.min(a,b)),highTick:Math.ceil(Math.max(a,b)),swaps:days*100,complete:true};
  }
  const range=snapRange(95000,105000,pool),L=Math.round(liquidityForCapital(500,range.tickLower,range.tickUpper,pool).liquidity);
  pool.eligible={liquidity:L*(othersMultiplier+1),holders:othersMultiplier?10:1};pool.activeLiquidity=pool.eligible.liquidity;
  const position={id:'8101',positionId:'8101',chain:'katana',owner:address(80),contract:address(84),pool:pool.pool,
    status:'observed',observedAt:stamp,principalUsd:500,staked:true,feesMine:false,inRange:true,protocol:'SushiSwap V3',
    raw:{liquidity:String(L),lowerTick:range.tickLower,upperTick:range.tickUpper,token0:pool.token0,token1:pool.token1}};
  return {asOf:stamp,timezone:'Asia/Kuala_Lumpur',snapshot:{snapshotId:'portfolio:income-fixture',status:'partial',allocationBlocked:true,
    assets:[],liabilities:[],coverage:[],reasons:[]},lp:{status:'fresh',ts:stamp,cards:{open:1,value_usd:500,pnl_usd:0,net_usd:0,fees_usd:0,unclaimed_usd:0},
    positions:[{id:position.id,chain:position.chain,pair:'vbWBTC / vbUSDC',canonical:position}]},
    strategy:{status:'fresh',ts:stamp,kat_usd:katUsd,pools:[pool],fee_pools:[]},sources:[{name:'lp',status:'fresh',ts:stamp},{name:'strategy',status:'fresh',ts:stamp}]};
}
export function incomeSources(now=Date.now()) {
  const context=incomeContext(now),p=context.lp.positions[0].canonical;
  return {lp:{generated:context.asOf,health:{errors:{},behind:{},unread:[],unpriced:[]},cards:context.lp.cards,
    live:[{id:p.id,chain:p.chain,pair:'vbWBTC / vbUSDC',in_range:true}],position_data:[p]},
    strategy:{at:now/1000,health:{notes:[]},kat_usd:context.strategy.kat_usd,pools:context.strategy.pools,fee_pools:[]}};
}
