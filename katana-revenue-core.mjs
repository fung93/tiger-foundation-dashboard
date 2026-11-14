/* Network revenue is independent of personal holdings, LP fees and KAT trades.
   Report complete UTC days; use integer USD millionths and never extrapolate. */
export const REVENUE_DAY=86400;
export const REVENUE_SOURCES=Object.freeze([
 {id:'swap',name:'Katana Swap',detail:'The protocol share of swap fees. Liquidity-provider fees are excluded.'},
 {id:'perps',name:'Katana Perps',detail:'Normal trading fees less maker rebates, before operating costs. Other exchange income is not covered.'},
 {id:'vault_bridge',name:'Vault Bridge',detail:'Revenue earned from the bridge yield engine. Bridged principal is excluded.'},
 {id:'sequencer',name:'Sequencer',detail:'Revenue retained from processing transactions. Gross gas fees alone do not establish retained revenue.'},
]);
export const REVENUE_ANNOUNCEMENT=Object.freeze({
 url:'https://x.com/katana/status/2120517054558093364',
 detailsUrl:'https://katana.network/blog/kat-tokenomics-update-avkat-katana-revenue',
 title:'Holding is a losing trade. Time to act. Time to believe.',
 evidence:'Owner supplied the full Katana Foundation article; linked tokenomics details are not independently accessible in this workspace.',
 feeFlowDate:'2026-11-17',buybackLaunchDate:null,revenueBuybackBps:null,purchasedKatToAvkatBps:10000,
});
const ids=REVENUE_SOURCES.map(s=>s.id),record=v=>v&&typeof v==='object'&&!Array.isArray(v),
 dayNumber=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')?Date.parse(s+'T00:00:00Z')/1000:NaN;
export const revenueDay=ts=>new Date(ts*1000).toISOString().slice(0,10);
export const reportingEnd=ts=>Math.floor(ts/REVENUE_DAY)*REVENUE_DAY;
export function usdMicros(n){
 if(!Number.isFinite(n)||Math.abs(n)>1e9)throw Error('Invalid reported USD amount');
 return String(Math.round(n*1e6));
}
const validMicros=n=>typeof n==='string'&&/^-?\d{1,25}$/.test(n),asUsd=n=>Number(n)/1e6;
const displayCents=n=>n>=0n?(n+5000n)/10000n:-((-n+5000n)/10000n);
export function emptyRevenueLedger(){return {version:1,chain:747474,updatedAt:null,
 observations:Object.fromEntries(ids.map(id=>[id,[]])),grossFees:Object.fromEntries(ids.map(id=>[id,[]])),sourceState:{},
 allocations:[],buybacks:[],allocationCoverage:null,buybackCoverage:null};}
export function validateRevenueLedger(f){
 if(!record(f)||f.version!==1||f.chain!==747474||!record(f.observations)||!record(f.grossFees)||!record(f.sourceState))throw Error('Invalid Katana revenue ledger');
 for(const key of ['observations','grossFees'])for(const id of ids){
  const rows=f[key][id];if(!Array.isArray(rows)||rows.length>730)throw Error('Invalid revenue history');
  let prev=-Infinity;
  for(const r of rows){const ts=dayNumber(r.day);if(!Number.isFinite(ts)||revenueDay(ts)!==r.day||ts<=prev||!validMicros(r.usdMicros)
    ||!Number.isFinite(Date.parse(r.observedAt))||!/^https:\/\//.test(r.evidenceUrl||''))throw Error('Invalid dated revenue observation');prev=ts;}
 }
 for(const key of ['allocations','buybacks']){
  if(!Array.isArray(f[key])||f[key].length>10000)throw Error('Invalid buyback records');const seen=new Set();
  for(const r of f[key]){
   if(!r||!Number.isFinite(r.ts)||r.ts<=0||!validMicros(r.usdMicros)||BigInt(r.usdMicros)<0n||!/^https:\/\//.test(r.evidenceUrl||'')
     ||typeof r.id!=='string'||!r.id||seen.has(r.id))throw Error('Invalid buyback evidence');seen.add(r.id);
   if(key==='buybacks'&&(!/^0x[0-9a-f]{64}$/i.test(r.transactionHash||'')||!/^\d{1,50}$/.test(r.katRaw||'')||r.verified!==true))throw Error('Unverified KAT purchase');
  }
 }
 for(const key of ['allocationCoverage','buybackCoverage'])if(f[key]!==null){const c=f[key];
  if(!record(c)||!Number.isSafeInteger(c.from)||!Number.isSafeInteger(c.to)||c.to<=c.from||!/^https:\/\//.test(c.evidenceUrl||''))throw Error('Invalid buyback coverage');
 }
 return f;
}
export function mergeRevenueObservations(oldRows,newRows){
 const rows=new Map(oldRows.map(r=>[r.day,r])),conflicts=[];
 for(const r of newRows){const saved=rows.get(r.day);if(saved&&saved.usdMicros!==r.usdMicros){conflicts.push(r.day);continue;}
  if(!saved)rows.set(r.day,structuredClone(r));}
 return {rows:[...rows.values()].sort((a,b)=>a.day.localeCompare(b.day)),conflicts};
}
export function revenuePeriod(rows,days,end){
 const from=end-days*REVENUE_DAY,wanted=new Set(Array.from({length:days},(_,i)=>revenueDay(from+i*REVENUE_DAY))),
  found=rows.filter(r=>wanted.has(r.day)),sum=found.reduce((n,r)=>n+BigInt(r.usdMicros),0n);
 return {days,from,to:end,coveredDays:found.length,complete:found.length===days,
  usd:found.length===days?asUsd(sum):null,knownUsd:found.length?asUsd(sum):null,knownMicros:found.length?sum.toString():null};
}
function expenditurePeriod(records,coverage,days,end,kat=false){
 const from=end-days*REVENUE_DAY,rows=records.filter(r=>r.ts>=from&&r.ts<end),sum=rows.reduce((n,r)=>n+BigInt(r.usdMicros),0n),
  complete=!!coverage&&coverage.from<=from&&coverage.to>=end;
 return {complete,usd:complete?asUsd(sum):null,knownUsd:rows.length?asUsd(sum):null,count:rows.length,
  kat:kat&&(complete||rows.length)?Number(rows.reduce((n,r)=>n+BigInt(r.katRaw),0n))/1e18:null};
}
export function buildRevenueView(file,now=Math.floor(Date.now()/1000)){
 validateRevenueLedger(file);const end=reportingEnd(now),periods=[1,7,30],
  sources=REVENUE_SOURCES.map(s=>({...s,state:file.sourceState[s.id]||{status:'unconfigured'},
   scope:s.id==='swap'&&Array.isArray(file.swapCatalog?.pools)?file.swapCatalog.pools.length+' priced V3 pools · partial coverage':s.id==='perps'?'Normal trades only · funding excluded':null,
   periods:Object.fromEntries(periods.map(d=>[d,revenuePeriod(file.observations[s.id],d,end)])),
   grossPeriods:Object.fromEntries(periods.map(d=>[d,revenuePeriod(file.grossFees[s.id],d,end)])),
   lastReportedDay:file.observations[s.id].filter(r=>dayNumber(r.day)<end).at(-1)?.day||null,
   evidenceUrl:file.observations[s.id].at(-1)?.evidenceUrl||null})),
  totals=Object.fromEntries(periods.map(d=>{const p=sources.map(s=>s.periods[d]),complete=p.every((p,i)=>p.complete&&sources[i].state.completeRevenue===true),available=p.filter(p=>p.knownMicros!==null),
   sum=available.reduce((n,p)=>n+BigInt(p.knownMicros),0n),cents=available.reduce((n,p)=>n+displayCents(BigInt(p.knownMicros)),0n);
   return [d,{complete,completeSources:p.filter(p=>p.complete).length,sourceCount:sources.length,
    usd:complete?Number(cents)/100:null,knownUsd:available.length?Number(cents)/100:null,unroundedUsd:available.length?asUsd(sum):null}];})),
  buybacks=Object.fromEntries(periods.map(d=>[d,{allocated:expenditurePeriod(file.allocations,file.allocationCoverage,d,end),
   purchased:expenditurePeriod(file.buybacks,file.buybackCoverage,d,end,true)}]));
 const hasData=sources.some(s=>s.periods[30].knownUsd!==null);
 return {schemaVersion:'katana-revenue-v1',generatedAt:new Date(now*1000).toISOString(),updatedAt:file.updatedAt,
  reporting:{timezone:'UTC',end,day:revenueDay(end-REVENUE_DAY),periods,monthlyDays:30},announcement:REVENUE_ANNOUNCEMENT,
  status:totals[30].complete?'complete':hasData?'partial':'unavailable',sources,totals,buybacks,
  purchases:file.buybacks.filter(r=>r.ts<end).slice(-10).reverse()};
}
