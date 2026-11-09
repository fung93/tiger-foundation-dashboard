/* Instantaneous, fixed-balance portfolio stress. Economic assets are counted
   once; LP look-through is used for valuation, never added as extra wealth. */
import {amountsPerLiquidity} from './strategy-core.mjs';
import {targetMetrics} from './morpho-core.mjs';
import {agentMoney,agentNumber} from './agent-language.mjs';
const WAD=10n**18n,ORACLE=10n**36n,PPM=1000000n;
const alias=s=>({VBWBTC:'BTC',WBTC:'BTC',BITCOIN:'BTC',VBETH:'ETH',WETH:'ETH',AVKAT:'KAT',VKAT:'KAT',VBUSDC:'USDC',VBUSDT:'USDT'})[String(s).toUpperCase()]||String(s).toUpperCase();
const fresh=(s,now)=>Number.isFinite(Date.parse(s))&&now-Date.parse(s)>=-30000&&now-Date.parse(s)<90000;
const factor=(symbol,shocks)=>1+(shocks[alias(symbol)]||0)/100;
export const DEFAULT_STRESSES=Object.freeze([
 {id:'kat_down',label:'KAT −30%',shocks:{KAT:-30},oracleRatioPct:0},
 {id:'market_down',label:'BTC −20%, ETH −25%',shocks:{BTC:-20,ETH:-25},oracleRatioPct:0},
 {id:'usdg_depeg',label:'USDG −5%',shocks:{USDG:-5},oracleRatioPct:0},
 {id:'combined',label:'Combined fall + avKAT/KAT oracle ratio −10%',shocks:{BTC:-20,ETH:-25,KAT:-30,USDG:-5},oracleRatioPct:-10},
]);
export function requestedPortfolioStress(message){
 const text=String(message||'').replace(/```[\s\S]*?```|`[^`]*`|"[^"\r\n]*"|“[^”]*”/g,' '),shocks={};let recognizedMoves=0;
 for(const row of text.matchAll(/\b(BTC|WBTC|bitcoin|ETH|WETH|KAT|USDG|USDC|USDT|SOL)\s+(?:price\s+)?(?:falls?|drops?|down|declines?|crashes|plunges|loses|rises?|up|gains?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/gi)){
   const symbol=alias(row[1]),value=Number(row[2])*(/fall|drop|down|decline|crash|plunge|loses/i.test(row[0])?-1:1);
   if(value< -95||value>500||Object.hasOwn(shocks,symbol)&&shocks[symbol]!==value)return {invalid:true};shocks[symbol]=value;
   recognizedMoves++;
 }
 for(const row of text.matchAll(/\b(BTC|WBTC|bitcoin|ETH|WETH|KAT|USDG|USDC|USDT|SOL)\s*([+-]\d+(?:\.\d+)?)\s*%/gi)){
  const symbol=alias(row[1]),value=Number(row[2]);if(value< -95||value>500||Object.hasOwn(shocks,symbol)&&shocks[symbol]!==value)return {invalid:true};shocks[symbol]=value;
  recognizedMoves++;
 }
 const oracle=text.match(/\bavKAT\s*\/\s*KAT\s+(?:oracle\s+)?ratio\s+(falls?|drops?|down|declines?|rises?|up|gains?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/i);
 const oracleRatioPct=oracle?Number(oracle[2])*(/fall|drop|down|decline/i.test(oracle[1])?-1:1):0;
 if(oracleRatioPct< -95||oracleRatioPct>100)return {invalid:true};
 if([...text.matchAll(/\d+(?:\.\d+)?\s*%/g)].length>recognizedMoves+(oracle?1:0))return {invalid:true};
 if(Object.keys(shocks).length||oracle)return [{id:'requested',label:'Your stated combined price case',shocks,oracleRatioPct}];
 return DEFAULT_STRESSES;
}
function lpValue(asset,context,shocks,now){
 const matches=(context.lp?.positions||[]).map(row=>row.canonical).filter(p=>p&&p.chain===asset.chain&&String(p.positionId||p.id)===String(asset.positionId)
   &&p.owner?.toLowerCase()===asset.owner?.toLowerCase()&&p.contract?.toLowerCase()===asset.protocolContract?.toLowerCase());
 const p=matches.length===1?matches[0]:asset.metadata,raw=p?.raw;
 if(!raw||p.status!=='observed'||!fresh(p.observedAt,now)||!/^\d{1,78}$/.test(raw.liquidity||'')||!/^\d{1,78}$/.test(raw.sqrtPriceX96||'')
   ||![raw.lowerTick,raw.upperTick].every(Number.isInteger)||raw.lowerTick>=raw.upperTick||[raw.token0,raw.token1].some(t=>!Number.isInteger(t?.decimals)||t.decimals<0||t.decimals>36))return null;
 const L=Number(raw.liquidity),sqrt=Number(raw.sqrtPriceX96)/2**96,ratio=sqrt**2*10**(raw.token0.decimals-raw.token1.decimals);
 if(!(L>0&&sqrt>0&&ratio>0))return null;
 const old=amountsPerLiquidity(raw.lowerTick,raw.upperTick,sqrt,raw.token0.decimals,raw.token1.decimals);
 const denom=L*(old.amount0*ratio+old.amount1),p1=asset.valueUsd/denom,p0=p1*ratio;
 if(![p0,p1].every(n=>Number.isFinite(n)&&n>0))return null;
 const f0=factor(raw.token0.symbol,shocks),f1=factor(raw.token1.symbol,shocks),nextSqrt=sqrt*Math.sqrt(f0/f1);
 const next=amountsPerLiquidity(raw.lowerTick,raw.upperTick,nextSqrt,raw.token0.decimals,raw.token1.decimals);
 const value=L*(next.amount0*p0*f0+next.amount1*p1*f1),hold=L*(old.amount0*p0*f0+old.amount1*p1*f1);
 return Number.isFinite(value)?{valueUsd:value,holdUsd:hold,differenceFromHoldUsd:value-hold,
   inRange:nextSqrt>=1.0001**(raw.lowerTick/2)&&nextSqrt<1.0001**(raw.upperTick/2)}:null;
}
export function stressPortfolio({context,risk,scenarios=DEFAULT_STRESSES,now=Date.now()}={}){
 if(!Array.isArray(scenarios)||scenarios.length<1||scenarios.length>5||scenarios.some(s=>!s||typeof s.id!=='string'||typeof s.label!=='string'
   ||!s.shocks||Object.entries(s.shocks).some(([symbol,value])=>!['BTC','ETH','KAT','USDG','USDC','USDT','SOL'].includes(symbol)||!Number.isFinite(value)||value< -95||value>500)
   ||!Number.isFinite(s.oracleRatioPct)||s.oracleRatioPct< -95||s.oracleRatioPct>100))throw Error('Choose bounded portfolio stress cases.');
 const assets=context.stressAssets||context.snapshot?.assets||[],liabilities=context.snapshot?.liabilities||[];
 const result={schemaVersion:'agent-portfolio-stress-v1',status:'partial',observedAt:new Date(now).toISOString(),cases:[],portfolioNavUsd:null,
   basis:'Instantaneous fixed balances; current accrued debt. Oracles follow stated relative-price cases. Locked funds are not spendable cash. No future returns, correlations or probabilities are inferred.'};
 for(const scenario of scenarios){let before=0,after=0,cash=0;const rows=[],missing=[],seen=new Set();
   for(const asset of [...assets,...liabilities]){
     if(asset.representationOf||asset.kind==='exposure')continue;
     if(seen.has(asset.id)){missing.push(asset.id);continue;}seen.add(asset.id);
     if(asset.status!=='fresh'||!fresh(asset.observedAt,now)||!Number.isFinite(asset.valueUsd)||asset.valueUsd<0){missing.push(asset.id);continue;}
     const debt=asset.kind==='debt',lp=asset.kind==='lp'?lpValue(asset,context,scenario.shocks,now):null;
     if(asset.kind==='lp'&&!lp){missing.push(asset.id);continue;}
     const value=lp?lp.valueUsd:asset.valueUsd*factor(asset.symbol,scenario.shocks),sign=debt?-1:1;
     before+=sign*asset.valueUsd;after+=sign*value;
     if(asset.kind==='wallet'&&!asset.restriction&&['USDG','USDC','USDT','DAI'].includes(alias(asset.symbol)))cash+=value;
     rows.push({id:asset.id,chain:asset.chain,kind:asset.kind,symbol:asset.symbol,currentUsd:asset.valueUsd,stressedUsd:value,
       locked:!!asset.restriction||asset.kind==='locked',...(lp?{lp}:{}),sourceTime:asset.observedAt});
   }
   const loans=[];
   for(const verified of risk?.data?.markets||[]){
     if(verified.status!=='ready'||verified.noPosition)continue;
     const source=context.lending?.markets?.find(row=>row.key===verified.marketKey),raw=source?.raw;if(!raw)continue;
     const cf=BigInt(Math.round(factor(source.collateral_token,scenario.shocks)*1e6)),df=BigInt(Math.round(factor(source.loan_token,scenario.shocks)*1e6));
     const ratio=source.key==='avkat-kat'?BigInt(Math.round((1+scenario.oracleRatioPct/100)*1e6)):PPM;
     const px=BigInt(raw.oracle_price)*cf*ratio/(df*PPM),value=BigInt(raw.collateral)*px/ORACLE,debt=BigInt(raw.debt),lltv=BigInt(raw.lltv),boundary=value*lltv/WAD;
     const health=debt===0n?null:Number(boundary)/Number(debt),limit=context.policy?.status==='confirmed'?context.policy.constraints?.marketLimits?.[source.key]:null;
     const lendingAllowed=!Array.isArray(context.policy?.constraints?.allowedAnalysisTypes)||context.policy.constraints.allowedAnalysisTypes.includes('lending');
     const targets=lendingAllowed?[limit?.targetHealth,limit?.maxLtvPct?source.lltv*100/limit.maxLtvPct:null].filter(Number.isFinite):[],target=targets.length?Math.max(...targets):null;
     let repayment=null;if(target){try{repayment=targetMetrics({...source,oracle_price:Number(px)/1e36,loan_usd:source.loan_usd*Number(df)/1e6,
       raw:{...raw,oracle_price:px.toString(),liquidation_debt:boundary.toString()}},target);}catch{}}
     loans.push({key:source.key,label:source.label,health,ltv:value===0n?null:Number(debt)/Number(value),liquidatable:debt>boundary,
       targetHealth:target,repayment,oracleRatioPct:source.key==='avkat-kat'?scenario.oracleRatioPct:null,sourceTime:verified.observedAt});
   }
   const complete=context.snapshot?.allocationBlocked===false&&!missing.length&&!context.stressCoverageIncomplete;
   result.cases.push({id:scenario.id,label:scenario.label,shocks:scenario.shocks,oracleRatioPct:scenario.oracleRatioPct,
     complete,verifiedBeforeUsd:before,verifiedAfterUsd:after,verifiedChangeUsd:after-before,portfolioNavUsd:complete?after:null,
     verifiedWalletStableUsd:cash,rows,missingAssetIds:missing,loans});
 }
 if(result.cases.every(row=>row.complete)&&risk?.status==='ready')result.status='ready';
 result.lendingCoverage=risk?.status||'unavailable';
 const critical=result.cases.flatMap(row=>row.loans.filter(loan=>loan.liquidatable).map(loan=>({scenario:row.label,...loan}))),worst=[...result.cases].sort((a,b)=>a.verifiedChangeUsd-b.verifiedChangeUsd)[0];
 result.brief={suggestion:critical.length?'Review borrowing risk first; at least one stated stress case crosses a liquidation boundary.':risk?.status!=='ready'?'Verify the borrowing readings before relying on this portfolio stress result.':'Keep a liquid buffer and review the combined shocks before adding exposure.',
   evidence:critical.length?critical.slice(0,2).map(row=>row.label+': health '+agentNumber(row.health,4)+' in '+row.scenario+'.').join(' ')
     :worst.label+': verified-position value changes by '+agentMoney(worst.verifiedChangeUsd)+'.',
   tradeOff:result.status==='ready'?'These are stated shocks, not price forecasts. Locked holdings cannot fund a repayment automatically.'
     :'Coverage is partial, so the displayed changes are scoped subtotals. Locked funds and cross-wallet stablecoins are not automatically available for a loan.',
   recheck:'Prices, oracle ratios, debt, collateral or available wallet cash change.'};
 return result;
}
