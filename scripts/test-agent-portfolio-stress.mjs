import assert from 'node:assert/strict';
import {stressPortfolio,requestedPortfolioStress,DEFAULT_STRESSES} from '../agent-portfolio-stress.mjs';
import {liquidityForCapital,tickAtPrice} from '../strategy-core.mjs';
let n=0;const check=(a,b,s)=>{assert.deepEqual(a,b,s);n++;};const now=Date.now(),ts=new Date(now).toISOString(),a=k=>'0x'+String(k).repeat(40),wad=10n**18n;
const pool={sqrtPrice:Math.sqrt(2),price:2,baseIndex:0,token0:{symbol:'ETH',decimals:0,usd:2},token1:{symbol:'USDG',decimals:0,usd:1}};
const lo=Math.floor(tickAtPrice(1.8,pool)),hi=Math.ceil(tickAtPrice(2.2,pool)),L=liquidityForCapital(100,lo,hi,pool).liquidity;
const p={id:'1',positionId:'1',chain:'robinhood',owner:a(1),contract:a(2),status:'observed',observedAt:ts,
 raw:{lowerTick:lo,upperTick:hi,liquidity:String(Math.round(L*1e12)),sqrtPriceX96:BigInt(Math.round(Math.sqrt(2)*2**96)).toString(),
 token0:{symbol:'ETH',decimals:12},token1:{symbol:'USDG',decimals:12}}};
// Scaling both decimals and liquidity together preserves the hand-worked value.
const asset=(id,kind,symbol,value)=>({id,kind,symbol,valueUsd:value,status:'fresh',observedAt:ts,chain:'katana',owner:a(1)});
const lp={...asset('lp','lp','LP',100),chain:'robinhood',protocolContract:p.contract,positionId:'1',metadata:p};
const context={snapshot:{allocationBlocked:false,assets:[asset('kat','wallet','KAT',100),asset('cash','wallet','USDG',200),
 {...asset('locked','locked','vKAT',50),restriction:'locked'},lp,{...asset('lookthrough','exposure','KAT',50),representationOf:'locked'}],
 liabilities:[asset('debt','debt','KAT',50)]},lp:{positions:[{canonical:p}]},
 lending:{markets:[{key:'avkat-kat',label:'avKAT / KAT',collateral_token:'avKAT',loan_token:'KAT',lltv:.77,
 raw:{collateral:String(100n*wad),debt:String(98n*wad),oracle_price:String(14n*10n**35n),lltv:String(77n*wad/100n)}}]}};
const risk={status:'ready',data:{markets:[{status:'ready',marketKey:'avkat-kat',observedAt:ts}]}};
let out=stressPortfolio({context,risk,now});
const kat=out.cases.find(row=>row.id==='kat_down');
check(Math.abs(kat.verifiedBeforeUsd-400)<1e-6,true,'Receipt look-through is not added as a second economic asset');
check(Math.abs(kat.verifiedAfterUsd-370)<1e-6,true,'KAT exposure is reduced by KAT debt once');
check(Math.abs(kat.loans[0].health-1.1)<1e-12,true,'A common KAT/USD fall cancels for avKAT/KAT health');
const combined=out.cases.find(row=>row.id==='combined');check(combined.loans[0].liquidatable,true,'A separate oracle-ratio shock can cross the actual loan boundary');
check(Math.abs(combined.loans[0].health-.99)<1e-12,true,'Ratio sensitivity uses exact raw balances and protocol LLTV');
const depeg=out.cases.find(row=>row.id==='usdg_depeg');
check(depeg.verifiedWalletStableUsd,190,'Depegged stablecoin wallet cash is marked down');
check(depeg.rows.find(row=>row.id==='locked').locked,true,'Locked capital is not spendable repayment cash');
check(depeg.rows.find(row=>row.id==='lp').lp.valueUsd<100,true,'A quote-token depeg affects LP valuation as well as the wallet');
check(depeg.rows.find(row=>row.id==='lp').lp.differenceFromHoldUsd<=1e-6,true,'LP token reconstruction includes divergence only once');
check(out.status,'ready','Complete synthetic coverage supports a scoped full stress value');
const partial=structuredClone(context);partial.snapshot.assets[0].status='stale';out=stressPortfolio({context:partial,risk,now});
check(out.cases.every(row=>row.portfolioNavUsd===null),true,'An unread asset cannot become a zero or a complete stressed NAV');
check(out.status,'partial','Source gaps are visible');
check(requestedPortfolioStress('Stress my portfolio if BTC drops 20% and ETH drops 25%')[0].shocks,{BTC:-20,ETH:-25},'Explicit combined owner cases are parsed without model maths');
check(requestedPortfolioStress('Stress my portfolio if BTC drops 99%').invalid,true,'Unbounded cases are rejected');
check(requestedPortfolioStress('Stress my portfolio: BTC -20%, SOL +10%')[0].shocks,{BTC:-20,SOL:10},'Common signed percentage cases do not silently become default scenarios');
check(requestedPortfolioStress('Stress my portfolio if avKAT/KAT oracle ratio drops 5%')[0].oracleRatioPct,-5,'The owner can explicitly vary the independent oracle-ratio case');
check(requestedPortfolioStress('Stress my portfolio'),DEFAULT_STRESSES,'Unspecified shocks are labelled fixed illustrative cases');
check(out.brief.tradeOff.includes('partial'),true,'The short recommendation discloses incomplete portfolio coverage');
console.log('Combined portfolio stress: '+n+' assertions passed.');
