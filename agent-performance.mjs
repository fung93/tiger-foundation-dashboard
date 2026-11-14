/* Cash/claim-date attribution, independent of the dashboard's mark-to-market
   accounting. No missing cost or cash-flow coverage is silently treated as zero. */
export const ATTRIBUTION_SCHEMA = 'agent-attribution-v1';
const finite = n => Number.isFinite(n) ? n : null;
const cents = n => Number.isFinite(n) ? Math.round((n+Number.EPSILON)*100)/100 : null;
const close = (a,b) => Math.abs(a-b)<=Math.max(.010001,Math.abs(a)*1e-10);
const validAmounts = x => x&&typeof x==='object'&&!Array.isArray(x)&&Object.values(x).every(n=>Number.isFinite(Number(n))&&Number(n)>=0);

export function attributeLPPerformance({position:p,metric:m,comparison,observedAt,costs}={}) {
  const result={schemaVersion:ATTRIBUTION_SCHEMA,status:'partial',observedAt:observedAt||null,
    identity:p?{chain:p.chain,contract:p.contract||null,positionId:String(p.id),owner:p.wallet||p.owner}:null,
    capitalInUsd:finite(p?.cost_usd),capitalOutUsd:finite(p?.out_usd),principalNowUsd:finite(m?.principalUsd),
    principalPnlUsd:null,marketMoveUsd:null,divergenceUsd:null,claimedAtEventUsd:null,unclaimedNowUsd:finite(m?.unclaimedUsd),
    grossCashBasisPnlUsd:null,bookMarkToMarketPnlUsd:finite(m?.netUsd),claimRepricingDifferenceUsd:null,
    knownGasUsd:null,knownSwapCostsUsd:null,knownFinancingUsd:null,netAfterAllCostsUsd:null,
    completeCapitalHistory:false,completeClaims:false,completeCosts:false,flows:[],reasons:[],
    basis:'Principal cash flows at their recorded prices; claims at their original recorded prices; unclaimed rewards at the observation price. Capital movements are not earnings.'};
  if(!p||!m||m.complete!==true||!Number.isFinite(m.principalUsd)||m.principalUsd<0){result.reasons.push('A complete LP Book observation is required.');return result;}
  const deposits=p.deposits,withdrawals=p.withdrawals;
  const validRows=rows=>Array.isArray(rows)&&rows.length<=256&&rows.every(row=>Number.isFinite(row.ts)&&row.ts>0
    &&Number.isFinite(row.usd)&&row.usd>=0&&Number.isFinite(row.a0)&&row.a0>=0&&Number.isFinite(row.a1)&&row.a1>=0);
  result.completeCapitalHistory=!p.at_start&&!p.unpriced&&!p.transferred&&!p.transferred_in&&!p.transferred_out
    &&validRows(deposits)&&deposits.length>0&&validRows(withdrawals)&&Number.isFinite(p.cost_usd)&&p.cost_usd>0
    &&Number.isFinite(p.out_usd)&&p.out_usd>=0&&close(deposits.reduce((n,row)=>n+row.usd,0),p.cost_usd)
    &&close(withdrawals.reduce((n,row)=>n+row.usd,0),p.out_usd);
  if(result.completeCapitalHistory){
    result.principalPnlUsd=cents(p.out_usd+m.principalUsd-p.cost_usd);
    result.flows=[...deposits.map(row=>({kind:'lp_deposit',block:row.block,ts:row.ts,usd:row.usd,amount0:row.a0,amount1:row.a1})),
      ...withdrawals.map(row=>({kind:'lp_withdrawal',block:row.block,ts:row.ts,usd:row.usd,amount0:row.a0,amount1:row.a1}))];
  }else result.reasons.push('Original priced deposit/withdrawal or ownership coverage is incomplete.');
  const claims=[...(p.claims||[]),...(p.trading_claims||[])],totals={};
  const validClaims=Array.isArray(claims)&&claims.length<=256&&claims.every(row=>Number.isFinite(row.ts)&&row.ts>0
    &&Number.isFinite(row.usd)&&row.usd>=0&&validAmounts(row.tokens));
  if(validClaims)for(const row of claims)for(const [key,n]of Object.entries(row.tokens))totals[key]=(totals[key]||0)+Number(n);
  const nativeClaimed=m.claimedTokens;
  result.completeClaims=validClaims&&validAmounts(nativeClaimed)&&[...new Set([...Object.keys(totals),...Object.keys(nativeClaimed||{})])]
    .every(key=>Math.abs((totals[key]||0)-Number(nativeClaimed[key]||0))<=Math.max(1e-9,Number(nativeClaimed[key]||0)*1e-9));
  if(result.completeClaims){
    result.claimedAtEventUsd=cents(claims.reduce((n,row)=>n+row.usd,0));
    result.flows.push(...claims.map(row=>({kind:'reward_or_fee_claim',block:row.block,ts:row.ts,usd:row.usd,tokens:row.tokens,
      basis:'Recorded claim-date valuation; not an external portfolio deposit.'})));
    if(Number.isFinite(m.claimedUsd))result.claimRepricingDifferenceUsd=cents(m.claimedUsd-result.claimedAtEventUsd);
  }else result.reasons.push('Some claims lack their original dollar prices or complete native-token reconciliation.');
  if(result.completeCapitalHistory&&comparison?.available===true&&comparison.complete===true&&Number.isFinite(comparison.hold_usd)){
    result.marketMoveUsd=cents(comparison.hold_usd-p.cost_usd);
    result.divergenceUsd=cents(result.principalPnlUsd-result.marketMoveUsd);
  }
  if(result.completeCapitalHistory&&result.completeClaims&&Number.isFinite(result.unclaimedNowUsd))
    result.grossCashBasisPnlUsd=cents(result.principalPnlUsd+result.claimedAtEventUsd+result.unclaimedNowUsd);
  const costRecord=costs?.schemaVersion==='agent-cost-evidence-v1'&&costs.positionId===String(p.id)&&costs.chain===p.chain
    &&costs.owner?.toLowerCase()===(p.wallet||p.owner)?.toLowerCase()?costs:null;
  if(costRecord){for(const [to,from]of [['knownGasUsd','gasUsd'],['knownSwapCostsUsd','swapCostsUsd'],['knownFinancingUsd','financingUsd']])
    if(Number.isFinite(costRecord[from])&&costRecord[from]>=0)result[to]=costRecord[from];
    result.completeCosts=costRecord.complete===true&&['knownGasUsd','knownSwapCostsUsd','knownFinancingUsd'].every(key=>Number.isFinite(result[key]));}
  if(result.completeCosts&&result.grossCashBasisPnlUsd!==null){
    result.netAfterAllCostsUsd=cents(result.grossCashBasisPnlUsd-result.knownGasUsd-result.knownSwapCostsUsd-result.knownFinancingUsd);result.status='ready';
  }else result.reasons.push('All transaction and financing costs are not yet verified; fully net performance remains unavailable.');
  result.flowDetailsOmitted=Math.max(0,result.flows.length-16);result.flows=result.flows.slice(0,16);
  return result;
}

export function classifyPortfolioFlow(flow,{owners=[],protocols=[]}={}) {
  if(!flow||typeof flow.chain!=='string'||!Number.isFinite(flow.usd)||flow.usd<0||!Number.isFinite(Date.parse(flow.observedAt)))return null;
  const own=address=>owners.some(row=>row.chain===flow.chain&&row.address.toLowerCase()===String(address).toLowerCase());
  const from=own(flow.from),to=own(flow.to);
  if(!from&&!to)return null;
  const protocol=protocols.find(row=>row.chain===flow.chain&&[flow.from,flow.to].some(a=>row.address.toLowerCase()===String(a).toLowerCase()));
  const kind=from&&to?'internal_transfer':protocol?protocol.kind:to?'external_deposit':'external_withdrawal';
  return {...flow,kind,external:kind.startsWith('external_'),classificationBasis:protocol?'configured_protocol_identity':'configured_wallet_boundary'};
}

export function attributePortfolioPeriod({before,after,flows,coverageComparable=false,flowsComplete=false}={}) {
  const result={schemaVersion:ATTRIBUTION_SCHEMA,status:'partial',wealthChangeUsd:null,externalNetUsd:null,pnlUsd:null,timeWeightedReturn:null,
    basis:'Portfolio boundaries and complete priced flows are required; internal transfers and DeFi capital movements are not profit.'};
  if(!Number.isFinite(before?.valueUsd)||!Number.isFinite(after?.valueUsd)||!coverageComparable)return {...result,reason:'Valuation coverage is not comparable.'};
  result.wealthChangeUsd=cents(after.valueUsd-before.valueUsd);
  if(!flowsComplete||!Array.isArray(flows)||flows.some(row=>!Number.isFinite(row.usd)||row.usd<0||!['external_deposit','external_withdrawal','internal_transfer','lp_deposit','lp_withdrawal','staking','lending','reward_or_fee_claim'].includes(row.kind)))
    return {...result,reason:'Complete external cash-flow coverage is unavailable.'};
  result.externalNetUsd=cents(flows.reduce((n,row)=>n+(row.kind==='external_deposit'?row.usd:row.kind==='external_withdrawal'?-row.usd:0),0));
  return {...result,status:'ready',pnlUsd:cents(result.wealthChangeUsd-result.externalNetUsd),
    reason:'Dollar attribution only; time-weighted return needs valuations around each flow.'};
}
