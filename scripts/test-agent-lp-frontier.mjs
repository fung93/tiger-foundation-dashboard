import assert from 'node:assert/strict';
import {buildLPFrontier} from '../agent-lp-frontier.mjs';
import {liquidityForCapital,priceAtTick} from '../strategy-core.mjs';
let n=0;const check=(a,b,s)=>{assert.deepEqual(a,b,s);n++;};const now=Date.now(),ts=new Date(now).toISOString(),a=k=>'0x'+String(k).repeat(40);
const pool={chain:'robinhood',pool:a(3),kind:'fees',status:'fresh',ts,block:100,tick:0,sqrtPrice:1,price:1,tickSpacing:10,fee:3000,
 activeLiquidity:1000000,activeLiquidityRaw:'1000000',baseIndex:0,base:'ETH',quote:'USDG',quoteUsd:1,
 token0:{address:a(4),symbol:'ETH',decimals:0,usd:1},token1:{address:a(5),symbol:'USDG',decimals:0,usd:1},fees:{usd_per_day:100},
 liquidityEvidence:{schemaVersion:'agent-liquidity-v1',chain:'robinhood',pool:a(3),block:100,currentTick:0,activeLiquidityRaw:'1000000',
  lowerTick:-2560,upperTick:5120,complete:true,ticks:[{tick:-2560,gross:'1000000',net:'1000000'},{tick:2560,gross:'1000000',net:'-1000000'}]}};
const range={tickLower:-1000,tickUpper:1000,lowerPrice:priceAtTick(-1000,pool),upperPrice:priceAtTick(1000,pool),inRange:true};
const L=liquidityForCapital(1000,range.tickLower,range.tickUpper,pool).liquidity,p={id:'1',positionId:'1',chain:'robinhood',owner:a(1),principalUsd:1000,
 feesMine:true,staked:false,raw:{liquidity:String(L),lowerTick:-1000,upperTick:1000}};
const context={lpAdviceFunding:{schemaVersion:'agent-lp-funding-v1',chain:'robinhood',owner:p.owner,observedAt:ts,priceObservedAt:ts,
 block:100,gasUnits:100000,gasPriceWei:'1000000000',nativePriceUsd:1,gasUsd:.0001}};
const args={position:p,pool,rangeData:{price:1,quote:'USDG',currentRange:range,windows:[],withinAssetPreferences:true},context,now};
let out=buildLPFrontier(args);check(out.status,'ready','Covered liquidity and verified costs support a fully specified conditional comparison');
check(out.scenarios.length,5,'The result compares five explicit, unweighted market/income paths');
const keep=out.options.find(row=>row.id==='keep'),flat=keep.outcomes.find(row=>row.scenario==='flat');
check(Math.abs(flat.newFeesUsd-100*L/1000000*7)<1e-7,true,'The flat path reproduces the exact current owner share over the horizon');
check(flat.principalUsd,1000,'Same-capital principal is conserved at the initial price');
check(out.options.filter(row=>row.id!=='keep').every(row=>row.capitalAfterCostUsd<1000),true,'Reset costs reduce capital before new liquidity and rewards are calculated');
check(out.options.every(row=>row.outcomes.length===5),true,'Every band uses the same scenario set and horizon');
check(out.options.every(row=>row.outcomes.every(result=>result.newFeesUsd<=100*7+1e-8)),true,'No position can receive more than the modeled whole-pool fee budget');
check(keep.outcomes.find(row=>row.scenario==='whipsaw').timeInRangeDays<7,true,'A price round-trip can spend time outside even when its final price is unchanged');
check(keep.outcomes.find(row=>row.scenario==='income_stress').newFeesUsd,flat.newFeesUsd/2,'Lower trading volume changes fee income independently of principal');
check(out.reply.split('\n').length,4,'The decision is concise while full cases stay structured');
check(out.reply.includes('before financing'),true,'Unknown financing costs are not called zero');
const noCosts=buildLPFrontier({...args,context:{}});check(noCosts.options.some(row=>row.id!=='keep'&&row.status==='blocked'),true,'Missing gas cannot create free resets');
const noDepth=buildLPFrontier({...args,pool:{...pool,liquidityEvidence:null}});check(noDepth.status,'partial','A constant-competition assumption cannot masquerade as a verified liquidity curve');
const badPosition=buildLPFrontier({...args,position:{...p,principalUsd:2000}});check(badPosition.options.length,0,'Unreconciled capital blocks range sizing');
const katPool={...pool,chain:'katana',kind:'rewards',katPerDay:1000,eligible:{liquidity:pool.activeLiquidity},
 rules:{weightFees:10000,weightToken0:0,weightToken1:0,outOfRange:false},campaign:{start:now/1000-86400,end:now/1000+3*86400},
 liquidityEvidence:{...pool.liquidityEvidence,chain:'katana'}},katP={...p,chain:'katana',feesMine:false,staked:true};
const katArgs={...args,position:katP,pool:katPool,context:{...context,strategy:{kat_usd:.01,ts},lpAdviceFunding:{...context.lpAdviceFunding,chain:'katana'}}};
let kat=buildLPFrontier(katArgs),katFlat=kat.options.find(row=>row.id==='keep').outcomes.find(row=>row.scenario==='flat');
check(Math.abs(katFlat.newRewardsKat-1000*L/pool.activeLiquidity*3)<1e-7,true,'KAT projections stop exactly at the recorded campaign deadline');
check(katFlat.newFeesUsd,0,'Staked Sushi trading fees remain DAO income, not owner fees');
check(kat.options.some(row=>row.id!=='keep'&&row.costUsd>0),true,'KAT reset costs do not depend on a second reward estimate');
kat=buildLPFrontier({...katArgs,pool:{...katPool,campaign:null}});
check(kat.options.find(row=>row.id==='keep').outcomes.find(row=>row.scenario==='flat').newRewardsKat,null,'Missing campaign evidence stays unknown while cost comparison remains available');
kat=buildLPFrontier({...katArgs,pool:{...katPool,ratesObservedAt:new Date(now-100000).toISOString()}});
check(kat.options[0].outcomes.find(row=>row.scenario==='flat').newRewardsKat,null,'A fresh tick reading cannot renew stale incentive data');
console.log('Cost-aware LP frontier: '+n+' assertions passed.');
