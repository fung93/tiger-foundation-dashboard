/* Reviewed, conversational rendering shared by both channels. The structured
   decision fields stay private; none is a mandatory user-facing heading. */
import {agentMoney,agentNumber,agentPrice} from './agent-language.mjs';
const finite=Number.isFinite,plain=value=>String(value||'').replace(/[\r\n\u2028\u2029]+/g,' ').trim();
export function renderInvestmentBrief(brief) {
  if(!brief||!['suggestion','evidence','tradeOff','recheck'].every(key=>typeof brief[key]==='string'&&brief[key].trim()&&brief[key].length<=1000))
    return 'I need a fresh, verified reading to answer that properly.';
  const trigger=/price|range|campaign|oracle|debt|collateral/i.test(brief.recheck)?' '+plain(brief.recheck):'';
  return [plain(brief.suggestion)+' '+plain(brief.evidence),plain(brief.tradeOff)+trigger].join('\n\n');
}
export function renderInvestmentAnswer(report,{question=''}={}){
 if(report?.focus==='performance'&&report.performance){
  const p=report.performance,rows=p.rows.filter(row=>finite(row.attribution?.grossCashBasisPnlUsd));
  if(!rows.length)return 'I can’t give you a reliable LP profit figure yet. I need the original priced capital and claim history alongside a fresh position reading.';
  const sum=key=>rows.every(row=>finite(row.attribution[key]))?rows.reduce((n,row)=>n+row.attribution[key],0):null;
  const principal=sum('principalPnlUsd'),claimed=sum('claimedAtEventUsd'),pending=sum('unclaimedNowUsd'),divergence=sum('divergenceUsd'),total=p.grossCashBasisSubtotalUsd;
  const subject=rows.length===1?(rows[0].pair||'Your LP')+' #'+rows[0].positionId:'Your '+rows.length+' verified LPs';
  let answer=subject+' '+(total<0?'are down ':total>0?'are up ':'are flat at ')+agentMoney(Math.abs(total))+' before transaction and borrowing costs.';
  if(rows.length===1)answer=answer.replace(' are ',' is ');
  if(/impermanent|\bIL\b|divergence/i.test(question)&&finite(divergence)&&finite(claimed)&&finite(pending)){
   const earnings=claimed+pending,loss=Math.max(0,-divergence);
   answer=loss===0?'The verified comparison doesn’t show a divergence loss against holding.':earnings>=loss
    ?'Fees and rewards cover the measured '+agentMoney(loss)+' divergence loss against holding, before costs.'
    :'Fees and rewards haven’t covered the measured divergence loss: '+agentMoney(earnings)+' earned versus '+agentMoney(loss)+' lost against holding.';
   answer+=' That comparison is separate from the tokens’ overall price move.';
  }
  else if(/impermanent|\bIL\b|divergence/i.test(question))answer='I can’t isolate impermanent loss without a matching holding benchmark. '+answer;
  const components=[];if(finite(principal))components.push('principal P&L '+agentMoney(principal));if(finite(claimed))components.push('claimed earnings '+agentMoney(claimed));if(finite(pending))components.push('still to claim '+agentMoney(pending));
  if(components.length)answer+='\n\nThe breakdown is '+components.join(', ')+'. Claims use their recorded prices.';
  if(rows.length<p.totalCount)answer+=' I could verify '+rows.length+' of '+p.totalCount+' LPs.';
  return answer+'\n\n'+(finite(p.netAfterAllCostsUsd)?'After the verified costs, the LP result is '+agentMoney(p.netAfterAllCostsUsd)+'.'
    :'I still need complete cost history to call this net profit. This covers these LPs, not your entire portfolio.');
 }
 if(report?.focus==='stress'&&report.stress){
  const s=report.stress,cases=s.cases||[],critical=cases.flatMap(c=>(c.loans||[]).filter(l=>l.liquidatable).map(l=>({c,l}))),worst=[...cases].sort((a,b)=>a.verifiedChangeUsd-b.verifiedChangeUsd)[0];
  if(!worst)return 'I need current holdings and lending readings before I can work through that scenario.';
  if(!worst.rows?.length&&!critical.length)return 'I don’t have enough fresh holdings to put a reliable amount on that scenario yet. I’ll keep the missing readings separate from the positions I can verify.';
  const describe=c=>Object.entries(c.shocks||{}).map(([symbol,pct])=>symbol+' '+(pct<0?'down ':'up ')+agentNumber(Math.abs(pct),2)+'%')
    .concat(c.oracleRatioPct?['avKAT/KAT oracle ratio '+(c.oracleRatioPct<0?'down ':'up ')+agentNumber(Math.abs(c.oracleRatioPct),2)+'%']:[]).join(', ');
  let answer=critical.length?'Borrowing is the main risk in these scenarios. '+critical.slice(0,2).map(({c,l})=>
    'With '+describe(c)+', '+l.label+' reaches health '+agentNumber(l.health,3)+', crossing its liquidation boundary.').join(' ')
    :'With '+describe(worst)+', the holdings I could verify would '+(worst.verifiedChangeUsd<0?'lose ':'gain ')+agentMoney(Math.abs(worst.verifiedChangeUsd))+'.';
  if(critical.length&&worst.rows?.length)answer+='\n\nThe largest verified value change across these cases is '+agentMoney(worst.verifiedChangeUsd)+'.';
  if(cases.length===1&&!critical.length&&worst.loans?.length)answer+=' '+worst.loans.slice(0,2).map(l=>l.label+' health would be '+agentNumber(l.health,3)+'.').join(' ');
  return answer+'\n\nThese are fixed-balance what-if calculations'+(s.status!=='ready'?', with partial portfolio coverage':'')+'. '
    +(s.lendingCoverage!=='ready'?'Some borrowing readings still need checking. ':'')+'Locked funds and money in another wallet or chain aren’t automatically available to repay a loan.';
 }
 if(report?.focus==='ranges'){
  const usable=(report.rangeAnalyses||[]).filter(a=>a.data?.frontier?.brief),first=usable[0];
  if(!first)return 'I need a complete current LP and pool reading before I can compare a new range fairly. Missing liquidity or reset costs would make a recommendation unreliable.';
  const d=first.data,f=d.frontier,keep=f.options.find(o=>o.id==='keep'),price=n=>d.quoteUsd===1?agentPrice(n):agentNumber(n,6)+' '+d.quote;
  let answer=plain(f.brief.suggestion);
  if(keep)answer+=' Your '+d.pair+' range is '+price(keep.lowerPrice)+'–'+price(keep.upperPrice)+'.';
  const candidate=f.options.find(o=>o.id!=='keep'&&f.efficientOptionIds?.includes(o.id)&&finite(o.costUsd));
  if(candidate)answer+='\n\nFor comparison, '+price(candidate.lowerPrice)+'–'+price(candidate.upperPrice)+' has an estimated '+agentMoney(candidate.costUsd)+' reset cost. '
    +'That cost comes out of the capital earning in the replacement LP.';
  answer+='\n\nI compared '+f.options.length+' bands over '+f.horizonDays+' days under stated price and income paths. '
    +(f.status==='ready'?'The outcomes remain conditional; future volume and competition can change.':'Some liquidity, earnings or cost evidence is incomplete, so this is a provisional comparison.');
  if(d.learning?.applied&&d.learning.message)answer+=' '+plain(d.learning.message);
  if(usable.length>1)answer+=' '+usable.slice(1,2).map(a=>a.data.pair+': '+plain(a.data.frontier.brief.suggestion)).join(' ');
  if(report.rangeCoverage?.total>report.rangeCoverage.reviewed)answer+=' This request covered '+report.rangeCoverage.reviewed+' of '+report.rangeCoverage.total+' LPs.';
  return answer+' Results are before financing; I’d review the choice again as price approaches the range edge or incentives change.';
 }
 if(report?.focus==='evaluation'){
  const rows=(report.evaluations||[]).filter(row=>row.status==='observed'&&row.policyVersion===report.policyVersion);
  if(!rows.length)return report.evaluationCoverage?.scoped?'I don’t have a later, comparable reading for that position in the recent decision records. I’ll keep collecting matching observations in the background.'
    :'I’m still building the track record. I need later, comparable readings of the original ideas before I can judge them. The background checks will keep collecting that evidence.';
  const latest=rows[0],marks=latest.marks||[],current=marks.find(m=>m.optionId==='keep');
  let answer='I have '+rows.length+' later comparisons of the original ideas under your current policy.';
  if(current&&finite(current.differenceBeforeUnobservedIncomeUsd))answer+=' At the latest checked prices, the original current-band principal is '+agentMoney(Math.abs(current.differenceBeforeUnobservedIncomeUsd))
    +(current.differenceBeforeUnobservedIncomeUsd<0?' behind':' ahead of')+' holding the starting token amounts, before income.';
  return answer+'\n\nThat doesn’t yet establish which choice made the best net return. Alternative fees, borrowing costs and unexecuted changes remain unverified, and I keep those separate from actual results.';
 }
 if(report?.focus==='protocols'&&report.protocolWatch){
  const p=report.protocolWatch;if(p.status==='disabled')return 'Protocol-source checks are currently switched off.';
  const warning=p.warnings?.[0];if(warning)return plain(warning.message)+'\n\n'+plain(warning.recheck);
  return p.status==='ready'?'The configured official releases and current campaign readings show no new verified notice. I’ll keep checking them in the background.'
    :'I couldn’t recheck all the official sources, so I can’t confirm that nothing changed. The background monitor will retry; older readings keep their original dates.';
 }
 return renderInvestmentBrief(report?.brief);
}
