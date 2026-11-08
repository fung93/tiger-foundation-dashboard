/* Summaries consume actual calculated net values. Synthetic adversarial cases
   verify comparisons, missing data and policy guards without any external call. */
import assert from 'node:assert/strict';
import { summarizeLPComparison, renderLPComparisonSummary } from '../agent-lp-summary.mjs';
import { compareAgentStrategies, renderAgentStrategyResult } from '../api/_agent-scenarios.mjs';
import { prepareAutomaticLP } from '../api/_agent-lp-autofill.mjs';
import { autofillContext, fundingFixture } from './fixtures/agent-lp-autofill.mjs';
import { reviewPolicy } from './fixtures/agent-review.mjs';

let count=0;const check=(actual,expected,note)=>{assert.deepEqual(actual,expected,note);count++;};
const near=(actual,expected,note)=>{assert.ok(Math.abs(actual-expected)<1e-8,note);count++;};
const cases=[-.1,0,.1].map((move,index)=>({id:'case '+index,path:[{day:0,ratio:1},{day:7,ratio:1+move}],rewardFactor:1,rewardPriceUsd:1}));
const option=(id,values,cost=0)=>({id,label:id,status:'conditional',cashRequiredUsd:cost,policyChecks:[],outcomes:values.map((netUsd,index)=>({
  scenario:cases[index].id,netUsd,costUsd:cost,timeInRangeDays:7,differenceFromHoldUsd:-999999}))});
const base={kind:'lp',horizonDays:7,status:'partial',comparisonBasis:'before_financing',scenarios:cases,options:[
  option('hold',[90,100,110],1),option('maintain',[95,105,115]),option('widen',[94,104,114],2),option('reposition',[93,103,113],3)]};
const clone=structuredClone, row=(summary,id)=>summary.rows.find(value=>value.id===id);
let summary=summarizeLPComparison(base),reply=renderAgentStrategyResult(base);
check(summary.leaderIds,['maintain'],'The same calculated leader is identified across all tested cases');
check(row(summary,'maintain').advantageText,'+$5.00','Advantages compare calculated final values after each option’s costs');
check(row(summary,'hold').advantageText,'Baseline','Holding is compared with its own after-closing-cost value');
check(row(summary,'reposition').costText,'$3.00','Upfront change costs stay visible');
check(reply.includes('• Takeaway:'),true,'Dashboard and Telegram receive a compact analysis summary');
check(reply.includes('before borrowing costs'),true,'The concise version retains its financing scope');
check(reply.includes('current token amounts'),true,'Holding explicitly uses the current LP token amounts');
check(reply.includes('not future facts'),true,'Future rates remain explicit assumptions');
check(reply.includes('estimated final value'),false,'Individual scenario paragraphs are not part of the default reply');
check(reply.split(/\s+/).length<220,true,'The ordinary result fits a short summary');
const original=JSON.stringify(base);summarizeLPComparison(base);renderLPComparisonSummary(base);
check(JSON.stringify(base),original,'Summary presentation cannot rewrite original financial results');

const varies=clone(base);varies.options.find(o=>o.id==='widen').outcomes[1].netUsd=200;
summary=summarizeLPComparison(varies);
check(summary.leaderIds,[],'Different scenario leaders do not become one overall recommendation');
check(summary.points[0].text.includes('no single winner'),true,'Scenario dependence is explained plainly');
const tie=clone(base);tie.options.find(o=>o.id==='widen').outcomes=tie.options.find(o=>o.id==='maintain').outcomes.map(o=>({...o,netUsd:o.netUsd+.001}));
check(summarizeLPComparison(tie).leaderIds,['maintain','widen'],'Differences below half a cent do not produce a misleading winner');

const outside=clone(base);Object.assign(outside.options.find(o=>o.id==='reposition'),{status:'outside_policy',outcomes:option('reposition',[1000,1000,1000]).outcomes});
summary=summarizeLPComparison(outside);
check(summary.leaderIds,['maintain'],'The richest option outside saved limits cannot become the lead option');
check(row(summary,'reposition').statusText,'Outside saved limits','Excluded options remain visibly labelled');
const failed=clone(base);failed.options.find(o=>o.id==='reposition').policyChecks=[{status:'fail'}];failed.options.find(o=>o.id==='reposition').outcomes=option('reposition',[1000,1000,1000]).outcomes;
check(summarizeLPComparison(failed).leaderIds,['maintain'],'A failed actual check excludes an option even if its status is inconsistent');
const unknown=clone(base);unknown.options[0].policyChecks=[{status:'unknown'}];
check(summarizeLPComparison(unknown).notes.some(text=>text.includes('still need verifying')),true,'Unknown saved-limit checks are not claimed to pass');

const partial=clone(base);partial.options.find(o=>o.id==='reposition').outcomes[1].netUsd=null;
summary=summarizeLPComparison(partial);
check(row(summary,'reposition').status,'incomplete','One unpriced case prevents full-option ranking');
check(summary.scenarios[1].rows.find(o=>o.option==='Proposed range').finalValue,'Unavailable','Missing earnings cannot become a zero-dollar outcome');
check(summary.points[0].text.startsWith('Among fully priced options'),true,'A partial comparison qualifies its scope');
const noHold=clone(base);noHold.options[0].outcomes[1].netUsd=null;
summary=summarizeLPComparison(noHold);
check(summary.leaderIds,[],'A missing holding benchmark prevents a headline LP-versus-holding conclusion');
check(summary.points[0].text.includes('holding benchmark is unavailable'),true,'A missing benchmark has a clear next step');

const repeated=clone(base);repeated.scenarios.forEach(item=>item.id='same label');repeated.options.forEach(o=>o.outcomes.forEach(out=>out.scenario='same label'));
check(row(summarizeLPComparison(repeated),'maintain').advantageText,'+$5.00','Repeated labels still match each outcome to its actual case index');
const mismatch=clone(base);mismatch.options[0].outcomes[1].scenario='different path';
check(summarizeLPComparison(mismatch).leaderIds,[],'An outcome for another case cannot serve as the holding benchmark');
const rewards=clone(base);rewards.scenarios[0].rewardFactor=0;rewards.scenarios[1].path=clone(rewards.scenarios[0].path);
rewards.options.find(o=>o.id==='maintain').outcomes[0].netUsd=85;
check(summarizeLPComparison(rewards).points.some(point=>point.text.includes('Removing incentives')),true,'Matched reward/no-reward cases explain incentive dependence');
rewards.scenarios[1].path=clone(base.scenarios[1].path);
check(summarizeLPComparison(rewards).points.some(point=>point.text.includes('Removing incentives')),false,'Different price paths cannot establish an incentive-only effect');
rewards.scenarios[1].path=clone(rewards.scenarios[0].path);rewards.scenarios[1].rewardPriceUsd=2;
check(summarizeLPComparison(rewards).points.some(point=>point.text.includes('Removing incentives')),false,'Different reward valuations cannot establish an incentive-only effect');
const zeros=clone(base);zeros.options=zeros.options.filter(o=>['hold','maintain'].includes(o.id));zeros.options.forEach(o=>o.outcomes.forEach(value=>value.netUsd=0));
check(row(summarizeLPComparison(zeros),'maintain').advantageText,'$0.00','A verified zero stays distinct from an unavailable result');
const range=clone(base);range.options.find(o=>o.id==='maintain').outcomes[0].timeInRangeDays=3;
check(summarizeLPComparison(range).points.some(point=>point.text.includes('out of range in 1 of 3 tested cases')),true,'The key risk reflects calculated time outside the current range');
for(const status of ['blocked','superseded']){
  summary=summarizeLPComparison({...base,status});
  check(summary.rows.length,0,'Unsafe '+status+' results do not display amounts');
  check(summary.leaderIds.length,0,'Unsafe '+status+' results cannot present a leader');
}

const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Closed LP summary fixtures only');};
try{
  const now=Date.now(),context=await autofillContext(now),policy=reviewPolicy();
  const setup=await prepareAutomaticLP({context,policy,now,readFunding:async selected=>fundingFixture(selected.owner,now)});
  const result=await compareAgentStrategies({context,policy,input:setup.inputs,now});
  const before=JSON.stringify(result),actual=summarizeLPComparison(result),current=result.options.find(o=>o.id==='maintain'),hold=result.options.find(o=>o.id==='hold');
  const deltas=current.outcomes.map((out,index)=>out.netUsd-hold.outcomes[index].netUsd);
  near(row(actual,'maintain').minAdvantageUsd,Math.min(...deltas),'The summary agrees with actual deterministic LP-versus-holding maths');
  near(row(actual,'maintain').maxAdvantageUsd,Math.max(...deltas),'The complete tested advantage interval comes from real engine results');
  check(actual.scenarios.length,setup.inputs.paths.length,'Every original scenario is retained for expandable evidence');
  check(JSON.stringify(result),before,'Real calculation IDs, amounts and evidence stay immutable');
  check(renderAgentStrategyResult(result),renderLPComparisonSummary(result),'Every existing strategy reply path uses the same concise LP formatter');
  console.log('Concise LP comparison analysis: '+count+' assertions passed.');
}finally{globalThis.fetch=originalFetch;}
