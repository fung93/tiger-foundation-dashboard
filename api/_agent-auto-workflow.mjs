/* Five-minute observations run in bounded Workflow steps, independently of the
   risk Cron and AI budgets. Original proposals and performance evidence are durable. */
import { createAgentStore, readAgentState } from './_agent-store.mjs';
import { getAgentOrigin } from './_agent-http.mjs';
import { loadAgentContext, readAgentJSON } from './_agent-context.mjs';
import { AUTO_SCHEMA, AUTO_LIMITS, automaticInputs, automationEnabled, autoPaused, autoHash, autoFresh } from './_agent-auto-state.mjs';
import { poolKey, positionKey, recordAutomatic, recordWalletObservation, recordPoolObservation, recordPositionObservation, markAbsentPositions } from './_agent-auto-observations.mjs';
import { trackedIdentity, observedFeeRate, renderPositionSuggestion, renderAutomaticPortfolioBrief } from './_agent-auto-analysis.mjs';
import { prepareAutomaticLP, detectedLPPositions } from './_agent-lp-autofill.mjs';
import { compareAgentStrategies } from './_agent-scenarios.mjs';
import { summarizeLPComparison } from '../agent-lp-summary.mjs';
import { createStrategyReport, persistAgentReport } from './_agent-reports.mjs';
import { mytDayAndTime, monitorConditions } from './_agent-notifications.mjs';
import { deliverAutomaticNotices } from './_agent-auto-delivery.mjs';
import { mergeRangeOutcome } from './_agent-auto-learning.mjs';

const CHAINS=['katana','robinhood','arc','solana'];
const validParams=p=>p?.schemaVersion===1&&p.mode==='observe'&&typeof p.manual==='boolean'&&/^observe-\d+(?:-manual)?$/.test(p.requestId||'');
function roster(context) {
  const raw=context.tracking?.positions||(context.lp?.positions||[]).map(row=>row.canonical);
  return [...new Map(raw.filter(p=>p&&p.status==='observed'&&trackedIdentity(p)).map(p=>[trackedIdentity(p),p])).values()].slice(0,AUTO_LIMITS.positions);
}
function mergeMarket(observed,known,position,now) {
  if(known&&!autoFresh(known.ts,now))known=null;
  if(!observed)return known?{...known,chain:position.chain}:null;
  if(known&&![0,1].every(i=>known['token'+i]?.address?.toLowerCase()===observed['token'+i]?.address?.toLowerCase()
    &&known['token'+i]?.decimals===observed['token'+i]?.decimals))known=null;
  const kind=known?.kind||(position.chain==='katana'&&position.feesMine===false?'rewards':'fees');
  const out={...known,...observed,kind,ts:observed.observedAt||observed.ts,ratesObservedAt:known?.ts||null,
    recent:{...(known?.recent||{}),...(observed.recent||{})}};
  if(known&&[0,1].every(i=>known['token'+i]?.address?.toLowerCase()===observed['token'+i]?.address?.toLowerCase()
    &&known['token'+i]?.decimals===observed['token'+i]?.decimals)){
    out.baseIndex=known.baseIndex;out.base=known.base;out.quote=known.quote;
    const ratio=observed.sqrtPrice**2*10**(observed.token0.decimals-observed.token1.decimals);
    out.price=out.baseIndex===0?ratio:1/ratio;
    out.token0={...observed.token0,usd:observed.token0.usd??known.token0.usd};out.token1={...observed.token1,usd:observed.token1.usd??known.token1.usd};
  }
  return out;
}
async function caseForPosition({store,context,item,policy,origin,fetcher,now,readFunding}) {
  if(!item?.market||!item.range?.selected||!autoFresh(item.position.observedAt,now)||!autoFresh(item.market.ts,now))return null;
  const current={...item.market,fees:observedFeeRate((await store.get(poolKey(item.position)))?.history||{},item.market)};
  const pools=[...(context.strategy?.pools||[]),...(context.strategy?.fee_pools||[])].filter(pool=>!(pool.pool===current.pool&&(pool.chain||'katana')===item.position.chain));
  const reading={...context,lp:{...context.lp,positions:[{canonical:item.position,pair:item.position.pair}]},
    strategy:{...context.strategy,status:'fresh',pools:[...pools,current],fee_pools:[]}};
  const selected=detectedLPPositions(reading,now).find(p=>p.owner===item.position.owner&&p.positionId===String(item.position.positionId||item.position.id));
  if(!selected?.available)return null;
  const band=item.range.selected;
  const setup=await prepareAutomaticLP({context:reading,policy,origin,fetcher,now,request:{positionKey:selected.key,
    overrides:{lowerPrice:band.lowerPrice,upperPrice:band.upperPrice}},...(readFunding?{readFunding}:{})});
  if(!setup.inputs)return null;
  // These are automatically generated paper assumptions, never owner-confirmed
  // recurring plans. The caller does not persist or mutate investment policy.
  setup.fieldSources.lowerPrice={basis:'derived',label:'Automatically selected historical band'};
  setup.fieldSources.upperPrice={basis:'derived',label:'Automatically selected historical band'};
  const result=await compareAgentStrategies({context:reading,policy,input:setup.inputs,now}),view=summarizeLPComparison(result);
  const reposition=result.options.find(option=>option.id==='reposition');
  setup.marketObservation=current;
  return {setup,result,input:setup.inputs,marketObservation:current,summary:reposition?.status==='outside_policy'?'A range change is outside your cash or saved limits.'
    :view.points.find(point=>point.label==='Your LP vs holding')?.text||'Waiting for complete fee and cost observations.',
    upfrontCostUsd:reposition?.cashRequiredUsd??null,source:'automatic_observational_defaults_v1',createdAt:new Date(now).toISOString()};
}
function compactItem(item,current,policyVersion,intervalMinutes) {
  const p=item.position,m=item.market,comparison=item.comparison;
  const result={key:positionKey(p),identity:item.identity,current,intervalMinutes,position:{id:p.id,positionId:p.positionId||p.id,chain:p.chain,owner:p.owner,contract:p.contract,
    pair:p.pair,principalUsd:p.principalUsd,observedAt:p.observedAt,performance:p.performance||null,
    raw:{token0:p.raw?.token0,token1:p.raw?.token1,lowerTick:p.raw?.lowerTick,upperTick:p.raw?.upperTick}},
    market:m?{price:m.price,quote:m.quote,base:m.base,quoteUsd:m.quoteUsd??m['token'+(1-m.baseIndex)]?.usd??null,ts:m.ts,block:m.block??null}:null,risk:current?item.risk:{status:'unavailable',signals:[]},
    range:current&&item.policyVersion===policyVersion?item.range:{status:'unavailable',selected:null},lessons:item.lessons,proposal:item.proposal,
    conditions:item.conditions,pendingSignals:item.pendingSignals||{},
    comparisonSummary:comparison?.result?.policyVersion===policyVersion?item.comparisonSummary:null,
    comparison:comparison?{reportId:comparison.reportId,upfrontCostUsd:comparison.upfrontCostUsd,createdAt:comparison.createdAt,
      status:comparison.result?.status,financingBasis:comparison.result?.comparisonBasis,policyVersion:comparison.result?.policyVersion}:null};
  result.summaryText=renderPositionSuggestion(result);return result;
}
export async function executeAutomaticWorkflow({env,params,workflowId,step,store=createAgentStore(env),dependencies={}}) {
  if(!validParams(params))throw Error('Invalid automatic observation invocation');
  const now=dependencies.now||Date.now,clock=()=>typeof now==='function'?now():now,origin=getAgentOrigin(env),fetcher=dependencies.fetcher||fetch;
  const doStep=(name,fn)=>step.do('observe-'+name,{retries:{limit:2,delay:'5 seconds',backoff:'linear'},timeout:'60 seconds'},fn);
  const jobKey='automation:context:'+params.requestId;
  const prepared=await doStep('prepare',async()=>{
    const input=await automaticInputs(store,['telegram','automation:schedule']);
    await store.increment('automation:cleanup',86400); // Bounded expiry cleanup also removes failed job payloads.
    await store.set('automation:lastTick',{ts:new Date(clock()).toISOString(),workflowId});
    if(!params.manual)await store.set('automation:lastScheduledTick',{ts:new Date(clock()).toISOString(),workflowId});
    if(!automationEnabled(env)||!input.controls.enabled||autoPaused(input.settings,clock()))return {status:'paused'};
    // Conservative application write estimate leaves room for existing risk,
    // journal and account work under Free D1's daily allowance. It is not an
    // account billing meter. Small portfolios keep the five-minute cadence.
    const prior=input.raw['automation:schedule'],size=prior?.positions||0;
    const intervalMinutes=5*Math.max(1,Math.ceil((100+28*size)*288/45000));
    if(!params.manual&&prior&&clock()-Date.parse(prior.checkedAt)<intervalMinutes*60000-30000)return {status:'not_due'};
    return {status:'ready',revision:input.controls.revision,policyVersion:input.policy.version,
      intervalMinutes,recipient:params.manual&&Object.hasOwn(params,'recipient')?params.recipient:input.raw.telegram||null};
  });
  if(prepared.status!=='ready')return prepared;
  const collected=await doStep('collect',async()=>{
    const input=await automaticInputs(store);if(!input.controls.enabled||input.controls.revision!==prepared.revision||autoPaused(input.settings,clock()))return {status:'paused'};
    const context=await(dependencies.loadContext||loadAgentContext)({origin,fetcher,now:clock,timeoutMs:12000,needs:['strategy','vkat','kat'],tracking:true});
    const positions=roster(context),keys=positions.map(positionKey),pools=[...new Map(positions.filter(p=>p.pool).map(p=>[poolKey(p),{chain:p.chain,pool:p.pool,position:p}])).values()];
    await store.set(jobKey,{context,positions,keys,pools,prepared},{ttlSeconds:1800});
    return {status:'ready',keys,poolCount:pools.length,intervalMinutes:5*Math.max(1,Math.ceil((100+28*keys.length)*288/45000)),
      truncated:(context.tracking?.positions||context.lp?.positions||[]).length>AUTO_LIMITS.positions,
      closedCount:Math.min(100,context.tracking?.closed?.length||context.lp?.closed?.length||0),claimCount:Math.min(100,context.tracking?.claims?.length||0)};
  });
  if(collected.status!=='ready')return collected;
  for(const chain of CHAINS)await doStep('wallet-'+chain,async()=>{
    const input=await automaticInputs(store);if(!input.controls.enabled||input.controls.revision!==prepared.revision||autoPaused(input.settings,clock()))return {status:'paused'};
    let reading=null;try{reading=dependencies.readWallet?await dependencies.readWallet(chain):await readAgentJSON(origin+'/api/strategy?'+new URLSearchParams({view:'agent-wallet',chain}),{fetcher,timeoutMs:12000,maxBytes:100000});}catch{}
    return recordWalletObservation(store,chain,reading,prepared.revision,{now:clock()});
  });
  await doStep('other-defi',async()=>{
    const job=await store.get(jobKey);if(!job)return {status:'expired'};
    const input=await automaticInputs(store);if(!input.controls.enabled||input.controls.revision!==prepared.revision||autoPaused(input.settings,clock()))return {status:'paused'};
    let fables=null;try{fables=dependencies.readOtherDefi?await dependencies.readOtherDefi():await readAgentJSON(origin+'/api/fables',{fetcher,timeoutMs:12000,maxBytes:120000});}catch{}
    const vkat=job.context.vkat,vkatCurrent=vkat&&['fresh','partial'].includes(vkat.status)&&autoFresh(vkat.ts,clock()),
      fablesCurrent=autoFresh(fables?.at,clock())&&Array.isArray(fables?.locks)&&Array.isArray(fables?.lps)
        &&fables.locks.every(row=>/^0x[0-9a-f]{40}$/i.test(row.wallet||'')&&Number.isFinite(row.value_usd)&&row.value_usd>=0)
        &&fables.lps.every(row=>/^0x[0-9a-f]{40}$/i.test(row.wallet||'')&&Number.isFinite(row.value_usd)&&row.value_usd>=0);
    const record={observedAt:new Date(clock()).toISOString(),status:vkatCurrent&&fablesCurrent?'observed':'partial',
      vkat:vkatCurrent?{observedAt:vkat.ts,block:vkat.headBlock,katPriceUsd:vkat.kat_usd,locks:vkat.locks||[],
        historicalVoteRewards:vkat.book,network:vkat.network,coverage:vkat.locksCoverage}:null,
      fables:fablesCurrent?{observedAt:fables.at,locks:fables.locks.slice(0,30),lps:fables.lps.slice(0,30),priceUsd:fables.fables_usd,
        coverage:'Known range/lock references from the dashboard; broader discovery follows the existing chain collector.'}:null,
      savedReferences:(job.context.snapshot?.assets||[]).filter(row=>['locked','other_defi'].includes(row.kind)).slice(0,30),
      basis:'Separate DeFi observations; historical rewards and alternate representations are never added twice to wealth.'};
    return recordAutomatic(store,'automation:other-defi',prepared.revision,['automation:other-defi'],({raw})=>{
      const before=raw['automation:other-defi'];
      const next={...record,vkat:record.vkat|| (before?.vkat?{...before.vkat,retained:true}:null),fables:record.fables||(before?.fables?{...before.fables,retained:true}:null)};
      return {entries:[{key:'automation:other-defi',value:next},{key:'automation:other-defi-day:'+mytDayAndTime(clock()).day,value:next}],value:{status:next.status}};
    },{now:clock()});
  });
  for(let index=0;index<collected.poolCount;index++)await doStep('market-'+index,async()=>{
    const job=await store.get(jobKey);if(!job)return {status:'expired'};
    const selected=job.pools[index],known=[...(job.context.strategy?.pools||[]),...(job.context.strategy?.fee_pools||[])].find(pool=>pool.pool?.toLowerCase()===selected.pool.toLowerCase()&&(pool.chain||'katana')===selected.chain);
    const input=await automaticInputs(store);if(!input.controls.enabled||input.controls.revision!==prepared.revision||autoPaused(input.settings,clock()))return {status:'paused'};
    let market=null;
    try{market=dependencies.readPool?await dependencies.readPool(selected):await readAgentJSON(origin+'/api/strategy?'+new URLSearchParams({view:'agent-pool',chain:selected.chain,pool:selected.pool}),{fetcher,timeoutMs:12000,maxBytes:32000});}catch{}
    const merged=mergeMarket(market,known,selected.position,clock());if(merged)merged.samplingIntervalMinutes=collected.intervalMinutes;
    return recordPoolObservation(store,selected.position,merged,prepared.revision,{now:clock()});
  });
  const results=[];
  for(let index=0;index<collected.keys.length;index++)results.push(await doStep('position-'+index,async()=>{
    const job=await store.get(jobKey);if(!job)return {status:'expired'};
    const position=job.positions[index],key=positionKey(position);
    const recorded=await recordPositionObservation(store,position,prepared.revision,{now:clock(),strategyEnabled:env.AGENT_STRATEGY_ENABLED!=='false'});
    if(recorded.pendingOutcome)await mergeRangeOutcome(store,position,key,recorded.pendingOutcome,prepared.revision,{now:clock()});
    if(recorded.status!=='recorded')return recorded;
    const {policy,controls,settings,raw}=await automaticInputs(store,[key]);
    if(!controls.enabled||controls.revision!==prepared.revision||autoPaused(settings,clock())||env.AGENT_STRATEGY_ENABLED==='false')return recorded;
    const item=raw[key];let comparison=null;
    try{comparison=await caseForPosition({store,context:job.context,item,policy,origin,fetcher,now:clock(),readFunding:dependencies.readFunding});}catch{}
    if(comparison){
      // One durable original comparison per day/policy; the latest case may be
      // recalculated without creating hundreds of journal entries every day.
      const caseDay=mytDayAndTime(clock()).day,uuid=autoHash([item.identity,caseDay,policy.version]).slice(0,32);
      // The ID names a logical day; createdAt remains the actual observation time.
      let reportId='report:'+caseDay+'T00:00:00.000Z:'+uuid.slice(0,8)+'-'+uuid.slice(8,12)+'-'+uuid.slice(12,16)+'-'+uuid.slice(16,20)+'-'+uuid.slice(20);
      const originalReport=await store.get(reportId);
      if(!originalReport&&comparison.result.status!=='blocked'){
        const draft=createStrategyReport({context:job.context,policy,result:comparison.result,input:comparison.input,now:clock()});
        draft.reportId=reportId;
        draft.automation={source:comparison.source,positionIdentity:item.identity,rangeProposalId:item.proposal?.id||null};
        draft.autofill=comparison.setup;
        const report=await persistAgentReport(store,draft,job.context.snapshot);reportId=report.reportId;
      }
      if(!originalReport&&comparison.result.status==='blocked')reportId=null;
      await recordAutomatic(store,key,prepared.revision,[key],({raw:latest,policy:currentPolicy})=>{
        const value=latest[key];if(!value||currentPolicy.version!==policy.version||value.position.observedAt!==position.observedAt)return {value:{status:'superseded'}};
        const next={...value,comparisonSummary:comparison.summary,comparison:{...comparison,reportId},
          proposal:value.proposal?{...value.proposal,comparisonReportId:reportId}:null};
        if(comparison.result.options.find(option=>option.id==='reposition')?.status==='outside_policy')next.range={...next.range,selected:null,status:'outside_policy',reason:comparison.summary};
        return {entries:[{key,value:next}]};
      },{now:clock()});
    }
    return recorded;
  }));
  // Each closure batch is at most four short fenced writes: safely below the
  // Free invocation ceiling, including context/control reads.
  const previous=await doStep('roster',async()=>({keys:(await store.get('automation:latest'))?.positionKeys||[]}));
  const missing=previous.keys.filter(key=>!collected.keys.includes(key));
  for(let start=0;start<missing.length;start+=4)await doStep('absence-'+start,async()=>{
    const job=await store.get(jobKey);if(!job)return {status:'expired'};
    return markAbsentPositions(store,missing.slice(start,start+4),collected.keys,prepared.revision,{complete:job.context.tracking?.enumerationComplete===true&&!collected.truncated,
      observedAt:job.context.lp?.ts,now:clock()});
  });
  for(let start=0;start<collected.closedCount;start+=20)await doStep('closed-history-'+start,async()=>{
    const job=await store.get(jobKey);if(!job)return {status:'expired'};
    const input=await automaticInputs(store);if(!input.controls.enabled||input.controls.revision!==prepared.revision||autoPaused(input.settings,clock()))return {status:'paused'};
    const rows=(job.context.tracking?.closed||job.context.lp?.closed||[]).slice(start,start+20).filter(row=>!row.incomplete&&row.wallet_address&&row.contract&&Number.isFinite(row.net_usd)&&Number.isFinite(Date.parse(row.closed)));
    const records=rows.map(row=>{const {comparison,...financial}=row,identity=autoHash([row.chain,row.contract,row.id,row.wallet_address,row.closed]);
      const key='automation:closed:'+row.closed+':'+autoHash([identity,financial]);
      return {key,index:'automation:closed-latest:'+row.closed+':'+identity,
        value:{...financial,recordedAt:job.context.asOf,sourceRecord:key,basis:'LP Book realised accounting at the original close and claim prices.'}};});
    if(records.length)await store.putImmutableMany(records.map(({key,value})=>({key,value})));
    for(let i=0;i<records.length;i+=10){const group=records.slice(i,i+10);
      const seen=await readAgentState(store,group.map(row=>row.index));
      if(group.every(row=>seen[row.index]?.sourceRecord===row.key))continue;
      await recordAutomatic(store,'automation:closed-index',prepared.revision,group.map(row=>row.index),({raw})=>({entries:group
        .filter(row=>raw[row.index]?.sourceRecord!==row.key&&(!raw[row.index]||Date.parse(raw[row.index].recordedAt)<Date.parse(row.value.recordedAt))).map(row=>({key:row.index,value:row.value}))}),{now:clock()});}
    return {status:'recorded',count:rows.length};
  });
  for(let start=0;start<collected.claimCount;start+=20)await doStep('claim-history-'+start,async()=>{
    const job=await store.get(jobKey);if(!job||job.context.lp?.status!=='fresh')return {status:'unverified'};
    const input=await automaticInputs(store);if(!input.controls.enabled||input.controls.revision!==prepared.revision||autoPaused(input.settings,clock()))return {status:'paused'};
    const rows=job.context.tracking.claims.slice(start,start+20).filter(row=>row.wallet_address&&row.contract&&Number.isFinite(row.ts)&&Number.isFinite(row.amount)&&row.amount>=0);
    if(rows.length)await store.putImmutableMany(rows.map(row=>({key:'automation:claim:'+new Date(row.ts*1000).toISOString()+':'+autoHash([row.chain,row.wallet_address,row.contract,row.position_id,row.token,row.ts,row.amount]),
      value:{...row,recordedAt:job.context.asOf,valuationBasis:'usd_now is the observation-time quote, not the historical claim price. Native token amount and event time are retained.'}})));
    return {status:'recorded',count:rows.length};
  });
  const published=await doStep('publish',async()=>{
    const job=await store.get(jobKey);if(!job)return {status:'expired'};
    const monitor=await store.lock('monitor',30);if(!monitor)throw Error('Risk monitoring has priority');
    const owner=await store.lock('owner',15);if(!owner){await monitor.release();throw Error('Private update in progress');}
    try{
      const dailyKey='automation:day:'+mytDayAndTime(clock()).day;
      const {raw,controls,settings,policy}=await automaticInputs(store,['automation:latest','automation:pending','alerts','messages','telegram','monitor:state',dailyKey,...collected.keys,
        'automation:other-defi',...CHAINS.map(chain=>'automation:wallet:'+chain)]);
      if(!controls.enabled||controls.revision!==prepared.revision||autoPaused(settings,clock()))return {status:'paused'};
      const prior=raw['automation:latest'];if(prior&&Date.parse(prior.checkedAt)>Date.parse(job.context.asOf))return {status:'superseded'};
      const states=collected.keys.map(key=>raw[key]).filter(item=>item?.status==='open');
      const wallets=CHAINS.map(chain=>raw['automation:wallet:'+chain]).filter(Boolean),day=mytDayAndTime(clock()),iso=new Date(clock()).toISOString();
      const freshLp=job.context.lp?.status==='fresh'&&autoFresh(job.context.lp.ts,clock());
      const positions=states.map(item=>compactItem(item,freshLp&&autoFresh(item.market?.ts,clock()),policy.version,collected.intervalMinutes));
      const uniqueLessons=[...new Map(states.map(item=>[poolKey(item.position),item.lessons])).values()];
      const latest={schemaVersion:AUTO_SCHEMA,checkedAt:job.context.asOf,policyVersion:policy.version,controlsRevision:controls.revision,
        intervalMinutes:collected.intervalMinutes,nextIntendedCheck:new Date(Date.parse(job.context.asOf)+collected.intervalMinutes*60000).toISOString(),
        lastSuccess:freshLp||wallets.some(wallet=>wallet.status==='fresh'&&autoFresh(wallet.observedAt,clock()))?job.context.asOf:prior?.lastSuccess||null,
        status:freshLp&&!collected.truncated&&positions.every(item=>item.current)&&job.context.lending?.status==='fresh'&&wallets.length===CHAINS.length&&wallets.every(wallet=>wallet.status==='fresh'&&autoFresh(wallet.observedAt,clock()))?'ready':'partial',
        coverage:{truncated:collected.truncated,totalOpenPositions:job.context.lp?.cards?.open??null,monitoredPositions:positions.length},
        positionKeys:freshLp&&!collected.truncated&&job.context.tracking?.enumerationComplete!==false?collected.keys:prior?.positionKeys||collected.keys,
        positions:freshLp?positions:(prior?.positions||[]).map(item=>({...item,retained:true,current:false})),wallets,
        otherDefi:raw['automation:other-defi']||null,
        lp:freshLp?job.context.lp.cards:null,loans:job.context.lending?.markets||[],closedSummary:job.context.lp?.closed_cards||null,
        loanAttention:Object.values(monitorConditions(job.context,settings,{policy,now:clock()})).filter(item=>item.type==='lending'&&item.active).slice(0,3),
        sources:job.context.sources||[],dailyDate:prior?.dailyDate||null,telegramDailyDate:prior?.telegramDailyDate||null,delivery:prior?.delivery||null,
        learning:{proposals:positions.filter(item=>item.proposal).length,observations:positions.reduce((n,item)=>n+(item.proposal?.observations||0)+(item.lessons?.observations||0),0),
          completed:uniqueLessons.reduce((n,item)=>n+(item?.completedProposals||0),0)}};
      latest.reply=renderAutomaticPortfolioBrief(latest);
      const publishedSignals={},events=[];
      for(const item of positions)for(const event of Object.values(item.pendingSignals)){
        const key=item.key+':'+event.kind,published=prior?.publishedSignals?.[key];
        publishedSignals[key]=published;
        if(settings.alertsEnabled&&item.current&&item.conditions?.[event.kind]?.active&&published!==event.id){
          events.push({...event,observedAt:item.market.ts});publishedSignals[key]=event.id;
        }
      }
      latest.publishedSignals=publishedSignals;
      const newDay=day.time>=settings.dailyTime&&prior?.dailyDate!==day.day;
      const pending=raw['automation:pending']||[],sameRecipient=raw.telegram&&prepared.recipient&&String(raw.telegram.chatId)===String(prepared.recipient.chatId)&&String(raw.telegram.userId)===String(prepared.recipient.userId);
      const recipientKey=raw.telegram?autoHash([String(raw.telegram.chatId),String(raw.telegram.userId),controls.revision,policy.version]):null;
      const telegramSignals=settings.alertsEnabled&&prior?.telegramRecipientKey===recipientKey?{...(prior?.telegramSignalIds||{})}:{};
      latest.telegramRecipientKey=sameRecipient?recipientKey:prior?.telegramRecipientKey||null;
      latest.telegramSignalIds=sameRecipient?telegramSignals:prior?.telegramSignalIds||{};
      const queue=pending.filter(item=>Date.parse(item.expiresAt)>clock()&&sameRecipient&&String(item.chatId)===String(raw.telegram.chatId)&&String(item.userId)===String(raw.telegram.userId));
      // Refresh unsent notices from newly verified current facts. A resolved or
      // stale condition cannot be sent merely because it once entered the queue.
      for(let index=queue.length-1;index>=0;index--){const notice=queue[index],item=positions.find(item=>positionKey(item.position)===notice.positionKey);
        if(notice.trigger==='alert'){
          if(!item||!item.conditions?.[notice.condition]?.active||!autoFresh(item.market?.ts,clock())){queue.splice(index,1);continue;}
          notice.text=renderPositionSuggestion(item);notice.validUntil=new Date(Date.parse(item.market.ts)+90000).toISOString();
        }else{if(notice.trigger==='daily'&&notice.day!==day.day){queue.splice(index,1);continue;}
          notice.text=latest.reply;notice.validUntil=new Date(clock()+90000).toISOString();}
      }
      for(const item of positions)for(const event of Object.values(item.pendingSignals||{}))if(sameRecipient&&settings.alertsEnabled&&item.current
        &&item.conditions?.[event.kind]?.active&&telegramSignals[item.key+':'+event.kind]!==event.id){
        queue.push({id:event.id,trigger:'alert',positionKey:item.key,condition:event.kind,text:renderPositionSuggestion(item),
          chatId:raw.telegram.chatId,userId:raw.telegram.userId,policyVersion:policy.version,controlsRevision:controls.revision,
          expiresAt:new Date(clock()+86400000).toISOString(),validUntil:new Date(Date.parse(item.market.ts)+90000).toISOString(),sentParts:0});
        telegramSignals[item.key+':'+event.kind]=event.id;
      }
      const dailyAllowed=day.time>=settings.dailyTime&&settings.dailyEnabled&&latest.telegramDailyDate!==day.day&&raw['monitor:state']?.dailyDate!==day.day;
      if(sameRecipient&&(params.manual||dailyAllowed)){
        const id='auto-'+(params.manual?params.requestId:day.day);
        if(!queue.some(item=>item.id===id))queue.push({id,trigger:params.manual?'manual':'daily',day:day.day,text:latest.reply,
          chatId:raw.telegram.chatId,userId:raw.telegram.userId,policyVersion:policy.version,controlsRevision:controls.revision,
          expiresAt:new Date(clock()+86400000).toISOString(),validUntil:new Date(clock()+90000).toISOString(),sentParts:0});
        if(dailyAllowed&&!params.manual)latest.telegramDailyDate=day.day;
      }
      if(newDay)latest.dailyDate=day.day;
      const alerts=[...(raw.alerts||[]),...events.map(event=>({id:event.id,key:'auto:'+event.positionKey+':'+event.kind,type:'lp',severity:event.severity,
        title:'Automatic LP market watch',message:event.message,ts:iso,sourceTs:event.observedAt,status:'active',telegramSent:false}))].slice(-30);
      const daily={schemaVersion:'agent-automation-day-v1',day:day.day,checkedAt:latest.checkedAt,
        positionKeys:latest.positionKeys,lp:latest.lp,loans:latest.loans,closedSummary:latest.closedSummary,learning:latest.learning};
      const entries=[{key:'automation:latest',value:latest},{key:'automation:schedule',value:{checkedAt:latest.checkedAt,lastSuccess:latest.lastSuccess,
        telegramDailyDate:latest.telegramDailyDate,positions:collected.keys.length,intervalMinutes:collected.intervalMinutes}},
        {key:'automation:pending',value:[...new Map(queue.map(item=>[item.id,item])).values()].slice(-20)},
        {key:'alerts',value:alerts},{key:dailyKey,value:{...daily,first:raw[dailyKey]?.first||daily,
          lastGood:freshLp?daily:raw[dailyKey]?.lastGood||null}}];
      if(newDay||events.length||params.manual)entries.push({key:'messages',value:[...(raw.messages||[]),{id:params.requestId,role:'assistant',content:latest.reply,ts:iso,source:'automation'}]
        .filter((item,index,list)=>list.findIndex(other=>other.id&&other.id===item.id)===index||!item.id).slice(-24)});
      await monitor.commit(entries,{alsoOwned:[owner]});return {status:latest.status,positions:positions.length};
    }finally{await owner.release();await monitor.release();}
  });
  await doStep('delivery',()=>deliverAutomaticNotices({store,env,fetcher,now:clock}));
  await doStep('cleanup',async()=>{await store.del(jobKey);return {status:'completed'};});
  return published;
}
