/* Private portfolio memory. Observed changes are never cash-flow-adjusted
   returns; only the existing books may establish earned or realised results. */
import { createHash } from 'node:crypto';
import { automaticInputs, autoFresh, autoPaused } from './_agent-auto-state.mjs';
import { mytDayAndTime } from './_agent-notifications.mjs';
import { agentMoney, agentNumber } from '../agent-language.mjs';
import { positionIdentity } from '../portfolio-core.mjs';
export { renderPortfolioLearning } from '../agent-learning-summary.mjs';

export const PORTFOLIO_LEARNING_SCHEMA = 'portfolio-learning-v1';
export const LEARNING_KEY = 'learning:portfolio';
const CHAINS = ['katana','robinhood','arc','solana'];
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const finite = n => Number.isFinite(n) ? n : null;
const label = s => typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g,'').slice(0,80) : '';
const observed = (source,now) => source && ['fresh','partial'].includes(source.status) && autoFresh(source.ts||source.observedAt,now);
const lpId = p => [p.chain,p.contract?.toLowerCase(),String(p.positionId||p.id),p.owner?.toLowerCase()].join(':');
export const isPortfolioLearningQuestion = text => typeof text === 'string'
  && /\b(?:learn(?:ed|ing|t)?|lessons?|patterns?|self[ -]study|improv(?:e|ed|ing).*decisions?)\b/i.test(text)
  && /\b(?:my|portfolio|positions?|investments?|agent|you|your|our|decisions?)\b/i.test(text);

export function portfolioLearningObservation({context={},wallets=[],otherDefi,now=Date.now()}={}) {
  const lps=(context.tracking?.positions||(context.lp?.positions||[]).map(row=>row.canonical)).filter(p=>p&&p.status==='observed'
    &&context.lp?.status==='fresh'&&autoFresh(p.observedAt,now)&&positionIdentity({chain:p.chain,protocolContract:p.contract,
      positionId:String(p.positionId||p.id),owner:p.owner})).slice(0,30).map(p=>{
    const row=context.lp?.positions?.find(row=>row.canonical&&lpId(row.canonical)===lpId(p)),m=p.performance;
    return {identity:lpId(p),chain:p.chain,pool:p.pool?.toLowerCase()||null,positionId:String(p.positionId||p.id),pair:label(p.pair||row?.pair),
      observedAt:p.observedAt,principalUsd:finite(p.principalUsd),liquidity:p.raw?.liquidity||null,inRange:typeof p.inRange==='boolean'?p.inRange:null,
      performance:m?.complete===true?{costUsd:finite(m.costUsd),netUsd:finite(m.netUsd),earnedUsd:finite(m.earnedUsd),
        unclaimedUsd:finite(m.unclaimedUsd),claimedTokens:m.claimedTokens||null}:null,
      advantageUsd:row?.comparison?.available===true?finite(row.comparison.difference_usd):null};
  });
  const balances=wallets.flatMap(source=>autoFresh(source.observedAt,now)?(source.balances||[]).filter(row=>row.status==='observed'
    &&autoFresh(row.observedAt,now)&&typeof row.raw==='string'&&/^\d{1,160}$/.test(row.raw)&&Number.isInteger(row.decimals)
    &&row.decimals>=0&&row.decimals<=36).map(row=>({identity:[row.chain,row.owner,row.address||'native'].join(':'),chain:row.chain,
      symbol:label(row.symbol),raw:row.raw,decimals:row.decimals,valueUsd:finite(row.valueUsd),observedAt:row.observedAt})):[]).slice(0,160);
  const loans=(context.lending?.markets||[]).filter(row=>row.status==='fresh'&&autoFresh(row.ts,now)).slice(0,3)
    .map(row=>({key:row.key||row.id,label:label(row.label),observedAt:row.ts,health:finite(row.health),ltv:finite(row.ltv),
      debtAmount:finite(row.debt_amount),debtUsd:finite(row.debt_usd),loanToken:label(row.loan_token),noPosition:row.no_position===true,
      raw:row.raw?{debt:row.raw.debt||null,collateral:row.raw.collateral||null}:null}));
  const kat=observed(context.kat,now)&&context.kat.historyCoverage?.complete&&context.kat.summary?{
    observedAt:context.kat.ts,priceUsd:finite(context.kat.price_usd),realizedUsd:finite(context.kat.summary.realized),
    unrealizedUsd:finite(context.kat.summary.unrealized),feesUsd:finite(context.kat.summary.fees),
    basis:'Existing KAT trade book since its tracking start, not the entire portfolio.'}:null;
  const locks=[];
  if(otherDefi?.vkat&&!otherDefi.vkat.retained&&autoFresh(otherDefi.vkat.observedAt,now))for(const row of (otherDefi.vkat.locks||[]).slice(0,20))
    locks.push({identity:'vkat:'+row.wallet+':'+row.id,kind:'vKAT',amount:finite(row.kat),observedAt:otherDefi.vkat.observedAt});
  if(otherDefi?.fables&&!otherDefi.fables.retained&&autoFresh(otherDefi.fables.observedAt,now))for(const row of (otherDefi.fables.locks||[]).slice(0,20))
    locks.push({identity:'vefables:'+row.wallet+':'+row.market,kind:'veFABLES',amount:finite(row.locked?.amount),observedAt:otherDefi.fables.observedAt});
  const closed=(context.tracking?.closed||context.lp?.closed||[]).filter(row=>!row.incomplete&&row.wallet_address&&row.contract
    &&Number.isFinite(row.net_usd)&&Number.isFinite(Date.parse(row.closed))).slice(0,100).map(row=>({
    identity:[row.chain,row.contract,row.id,row.wallet_address,row.closed].join(':'),chain:row.chain,pool:row.pool?.toLowerCase()||null,
    pair:label(row.pair),closedAt:row.closed,netUsd:row.net_usd,feesUsd:finite(row.fee_usd),costUsd:finite(row.cost_usd),
    hours:finite(row.held_hours),basis:'LP Book realised results at original close/claim prices.'}));
  const votes=observed(context.vkat,now)&&context.vkat.book?.status==='historical'&&Number.isFinite(context.vkat.book.total_usd)
    ?{observedAt:context.vkat.ts,rewardsUsd:context.vkat.book.total_usd,epochs:(context.vkat.epochs||[]).filter(row=>row.settled).length,
      basis:'Existing vote-reward book at recorded payout prices; not additional wallet wealth.'}:null;
  const coverage={walletChains:CHAINS.filter(chain=>wallets.some(row=>row.chain===chain&&row.status==='fresh'&&autoFresh(row.observedAt,now))),
    lpComplete:context.lp?.status==='fresh'&&lps.length===context.lp?.cards?.open,lendingComplete:loans.length===3,
    kat:!!kat,locks:locks.length,omittedBalances:wallets.reduce((n,w)=>n+(w.balances?.length||0),0)>160,
    closedOmitted:context.tracking?.closedOmitted===true||closed.length>=100};
  return {schemaVersion:PORTFOLIO_LEARNING_SCHEMA,observedAt:new Date(now).toISOString(),day:mytDayAndTime(now).day,
    loans,lps,balances,kat,locks,votes,closed,coverage,
    basis:'Dated source observations. Balance/debt changes are not investment returns; missing observations are not zero.'};
}

export function derivePortfolioLessons({days=[],current,policy,now=Date.now()}={}) {
  if(!current)return {schemaVersion:PORTFOLIO_LEARNING_SCHEMA,status:'collecting',lessons:[],coveredDays:0,coverage:null};
  const later=days.filter(day=>Date.parse(day.observedAt)<Date.parse(current.observedAt)),lessons=[];
  const add=(kind,key,message,suggestion,sourceTimes,extra={})=>lessons.push({id:'lesson:'+hash([kind,key,sourceTimes]),kind,key,message,suggestion,
    sourceTimes,provenance:'verified_observations',...extra});
  for(const loan of current.loans.filter(row=>!row.noPosition)){
    const previous=later.map(day=>day.loans.find(row=>row.key===loan.key&&!row.noPosition&&Number.isFinite(row.health)
      &&Date.parse(row.observedAt)<Date.parse(loan.observedAt))).filter(Boolean);
    const last=previous.at(-1),series=[...previous.slice(-2),loan];
    const falling=series.length===3&&series.every(row=>Number.isFinite(row.health))&&series[0].health>series[1].health&&series[1].health>series[2].health;
    const target=policy?.status==='confirmed'?policy.constraints?.marketLimits?.[loan.key]?.targetHealth:null;
    if(last&&Number.isFinite(loan.health))add('lending',loan.key,loan.label+': health '+agentNumber(last.health,4)+' → '+agentNumber(loan.health,4)
      +(falling?' across a falling three-day sequence.':'.'),loan.health<1?'Check this loan immediately; it is below its liquidation boundary.'
      :Number.isFinite(target)&&loan.health<target?'Review repayment against your saved target before adding risk.'
        :falling?'Borrowing safety has weakened across recorded days; review the loan buffer.':'Keep watching the borrowing buffer.',[last.observedAt,loan.observedAt],
      {priority:loan.health<1?100:falling?75:20,trend:falling?'falling':'observed',policyVersion:policy?.version||0});
  }
  for(const p of current.lps){
    const earlier=later.map(day=>day.lps.find(row=>row.identity===p.identity)).filter(Boolean).at(-1);
    if(Number.isFinite(p.advantageUsd))add('lp',p.identity,p.pair+': LP plus earnings is '+agentMoney(Math.abs(p.advantageUsd))
      +(p.advantageUsd<0?' behind':' ahead of')+' holding under the LP Book benchmark.',p.advantageUsd<0
      ?'Compare future fees with range risk and reset costs; a high APR alone does not establish a better result.':'Keep the fee benefit and range risk under review.',
      [p.observedAt],{priority:p.advantageUsd<0?55:15,pool:p.pool,chain:p.chain});
    else if(p.performance&&Number.isFinite(p.performance.netUsd))add('lp',p.identity,p.pair+': recorded LP Book net '+agentMoney(p.performance.netUsd)+'.',
      p.inRange===false?'Review the range exit before comparing new earnings.':'Review earnings together with principal P&L.',[p.observedAt],
      {priority:p.inRange===false?65:10,pool:p.pool,chain:p.chain});
    // Dollar repricing and claims can change earned/claimable totals. Never call
    // their difference newly earned fees. Only record the capital change itself.
    if(earlier&&earlier.liquidity&&p.liquidity&&earlier.liquidity!==p.liquidity)add('capital',p.identity,p.pair+': liquidity changed since an earlier recorded day.',
      'Use the new capital baseline when comparing earnings; the balance change is not profit.',[earlier.observedAt,p.observedAt],{priority:25});
  }
  const closedGroups=new Map();
  for(const p of current.closed){const key=[p.chain,p.pool||p.pair].join(':');const group=closedGroups.get(key)||{chain:p.chain,pair:p.pair,rows:[]};group.rows.push(p);closedGroups.set(key,group);}
  for(const [key,group]of closedGroups){const net=group.rows.reduce((n,row)=>n+row.netUsd,0);add('closed_lp',key,group.pair+': '+group.rows.length
    +' recorded closed LP'+(group.rows.length===1?'':'s')+', combined net '+agentMoney(net)+'.',net<0
      ?'Past fees did not offset the recorded principal losses in this group; review LP versus holding before resetting.'
      :'Use these realised records when reviewing costs and future fee assumptions; they do not establish a future win rate.',group.rows.map(row=>row.closedAt).slice(-5),
    {priority:net<0?45:10,closedCount:group.rows.length,netUsd:net,chain:group.chain,overlappingCapitalPossible:true});}
  if(current.kat)add('kat','trade-book','KAT trade book: realised '+agentMoney(current.kat.realizedUsd)+', unrealised '+agentMoney(current.kat.unrealizedUsd)+'.',
    current.kat.unrealizedUsd<0?'Review KAT price exposure separately from LP reward quantity.':'Review realised and unrealised results separately.',[current.kat.observedAt],{priority:30});
  if(current.votes)add('votes','vote-rewards','Recorded voting rewards total '+agentMoney(current.votes.rewardsUsd)+'.',
    'Compare received rewards with locked capital and exit restrictions before locking more.',[current.votes.observedAt],{priority:20});
  if(current.locks.length){const kinds=[...new Set(current.locks.map(row=>row.kind))];add('locks','known-locks',current.locks.length+' known '+kinds.join('/')+' lock positions are recorded.',
    'Keep locked capital separate from money available for repayment or an LP reset.',current.locks.map(row=>row.observedAt).slice(-2),{priority:20});}
  const prior=later.at(-1);
  if(prior){const moved=current.balances.filter(row=>{const before=prior.balances.find(p=>p.identity===row.identity);return before&&before.raw!==row.raw;});
    if(moved.length)add('holdings','balance-changes',moved.length+' tracked token balance'+(moved.length===1?' changed':'s changed')+' since the previous recorded day.',
      'Transfers, deposits, borrowing and rewards can change balances; do not treat that change as investment return.',[prior.observedAt,current.observedAt],{priority:15});}
  const allowed=policy?.status==='confirmed'?policy.constraints?.allowedAnalysisTypes:null;
  const eligible=lessons.filter(row=>!Array.isArray(allowed)||allowed.includes(({lending:'lending',lp:'lp',closed_lp:'lp',capital:'lp',kat:'kat',votes:'kat',locks:'portfolio',holdings:'portfolio'})[row.kind]));
  eligible.sort((a,b)=>b.priority-a.priority||a.key.localeCompare(b.key));
  return {schemaVersion:PORTFOLIO_LEARNING_SCHEMA,status:lessons.length?'observed':'collecting',checkedAt:current.observedAt,policyVersion:policy?.version||0,
    coveredDays:new Set([...days.map(row=>row.day),current.day]).size,coverage:current.coverage,lessons:eligible.slice(0,18),
    independentOutcomeBasis:'Daily observations and original books; repeated checks are not independent successful investments.',
    adaptation:'Only qualified pool containment evidence adjusts lookback comparisons. No policy mutation or model-weight training.',
    returnsAvailable:false};
}

export async function recordPortfolioLearning(store,context,revision,{now=Date.now(),enabled=true}={}) {
  if(!enabled)return {status:'disabled'};
  const lease=await store.lock(LEARNING_KEY,30);if(!lease)throw Error('Portfolio learning update is busy');
  try{
    const names=[LEARNING_KEY,'automation:other-defi',...CHAINS.map(chain=>'automation:wallet:'+chain)],input=await automaticInputs(store,names);
    if(!input.controls.enabled||input.controls.revision!==revision||autoPaused(input.settings,now))return {status:'paused'};
    const prior=input.raw[LEARNING_KEY];
    if(prior?.checkedAt&&now-Date.parse(prior.checkedAt)<1800000&&prior.summary?.policyVersion===input.policy.version)
      return {status:'not_due',summary:prior.summary};
    const current=portfolioLearningObservation({context,wallets:CHAINS.map(chain=>input.raw['automation:wallet:'+chain]).filter(Boolean),
      otherDefi:input.raw['automation:other-defi'],now});
    if(!current.loans.length&&!current.lps.length&&!current.balances.length&&!current.kat&&!current.locks.length)return {status:'unavailable'};
    const sourceHash=hash([current.loans,current.lps,current.balances,current.kat,current.locks,current.votes,current.closed]);
    if(prior?.sourceHash===sourceHash)return {status:'duplicate',summary:derivePortfolioLessons({days:prior.days,current:prior.days.at(-1),policy:input.policy,now})};
    const days=[...(prior?.days||[]).filter(row=>row.day!==current.day),current].sort((a,b)=>a.day.localeCompare(b.day)).slice(-31);
    const sizes=days.map(row=>new TextEncoder().encode(JSON.stringify(row)).byteLength+1);let bytes=sizes.reduce((n,size)=>n+size,2);
    while(days.length>1&&bytes>196608){bytes-=sizes.shift();days.shift();}
    const summary=derivePortfolioLessons({days,current,policy:input.policy,now}),dayKey='learning:day:'+current.day;
    const oldDay=await store.get(dayKey),entries=[{key:LEARNING_KEY,value:{schemaVersion:PORTFOLIO_LEARNING_SCHEMA,
      checkedAt:current.observedAt,sourceHash,days,summary}},{key:dayKey,value:{schemaVersion:PORTFOLIO_LEARNING_SCHEMA,
      first:oldDay?.first||current,last:current,basis:current.basis}}];
    if(!oldDay)entries.push({key:dayKey+':original',value:current,immutable:true});
    await lease.commit(entries);return {status:'recorded',summary};
  }finally{await lease.release();}
}

export async function loadPortfolioLearning(store,{policy,now=Date.now(),enabled=true}={}) {
  if(!enabled)return {schemaVersion:PORTFOLIO_LEARNING_SCHEMA,status:'disabled',lessons:[]};
  const record=await store.get(LEARNING_KEY);if(record?.schemaVersion!==PORTFOLIO_LEARNING_SCHEMA||!record?.days?.length)return derivePortfolioLessons();
  const current=record.days.at(-1),summary=derivePortfolioLessons({days:record.days,current,policy,now});
  const retained=!Number.isFinite(Date.parse(current.observedAt))||now-Date.parse(current.observedAt)>3600000||now-Date.parse(current.observedAt)<-30000;
  return {...summary,status:retained?'stale':summary.status,sourceRecord:LEARNING_KEY,retained};
}
