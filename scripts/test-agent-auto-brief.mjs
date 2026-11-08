/* The owner's missing Katana LP was counted/stored but omitted from the brief. */
import assert from 'node:assert/strict';
import { autofillContext } from './fixtures/agent-lp-autofill.mjs';
import { robinhoodLPFixture } from './fixtures/agent-auto-multiple.mjs';
import { lpRisk,chooseAutomaticRange,renderAutomaticPortfolioBrief,renderPositionSuggestion } from '../api/_agent-auto-analysis.mjs';

let count=0;const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;};
const now=Date.now(),context=await autofillContext(now),rh=robinhoodLPFixture(now);
const item=(position,market)=>{
  const risk=lpRisk(position,market,{},now);
  return {position,market,current:true,risk,range:chooseAutomaticRange({position,market,history:{},risk,policy:{version:0},now})};
};
const katana=item(context.lp.positions[0].canonical,context.strategy.pools[0]),robinhood=item(rh.position,rh.pool);
katana.comparisonSummary='Holding leads in these conditional cases.';katana.comparison={financingBasis:'before_financing'};
const latest={positions:[robinhood,katana],lp:{open:2,value_usd:1000,net_usd:-10,unclaimed_usd:2},
  status:'ready',checkedAt:new Date(now).toISOString(),intervalMinutes:5,
  loanAttention:[{severity:'critical',message:'Fixture loan health is below the liquidation boundary. Reading: fixture time.'}]};
const before=JSON.stringify(latest),brief=renderAutomaticPortfolioBrief(latest);
check(brief.includes('katana #1001'),true,'The default brief includes the staked Katana LP even when Robinhood sorts first');
check(brief.includes('robinhood #2002'),true,'The same brief includes the Robinhood LP');
check(brief.indexOf('robinhood #2002')<brief.indexOf('katana #1001'),true,'Risk ordering remains intact without dropping later positions');
check((brief.match(/• Suggestion:/g)||[]).length,2,'Each tracked LP receives its own brief suggestion');
check(brief.indexOf('Lending priority')<brief.indexOf('robinhood #2002'),true,'Critical lending remains ahead of every LP suggestion');
check(brief.includes('Reading: fixture time'),false,'Repeated reading metadata stays out of the concise loan line');
check(brief.includes('2 open · $1,000.00 value · -$10.00 net · $2.00'),true,'Existing accounting subtotals are rendered unchanged');
check(brief.includes('before borrowing costs'),true,'Conditional cost comparisons keep their financing scope');
check(brief.includes('Building a reliable pool history'),true,'Insufficient Robinhood history remains explicit alongside the Katana range');
check((brief.match(/Compare range:/g)||[]).length,1,'A numeric band is only shown for the position with verified history');
check((brief.match(/Next check in about/g)||[]).length,1,'The brief shares a single next-check line');
check(brief.length<2200,true,'Two-position replies remain concise');
check(JSON.stringify(latest),before,'Rendering cannot alter recorded positions, accounting or risk data');
const sameId=renderAutomaticPortfolioBrief({...latest,positions:[katana,{...robinhood,position:{...robinhood.position,positionId:'1001'}}]});
check(sameId.includes('katana #1001')&&sameId.includes('robinhood #1001'),true,'An identical NFT number on another chain is still a separate position');
const third={...katana,position:{...katana.position,positionId:'1003',owner:rh.position.owner}};
check(renderAutomaticPortfolioBrief({...latest,lp:{...latest.lp,open:3},positions:[robinhood,katana,third]}).includes('katana #1003'),true,
  'Another Katana position in the same pair receives its own visible entry');
const retained=renderAutomaticPortfolioBrief({...latest,status:'partial',positions:[{...katana,current:false}],lp:null});
check(retained.includes('Waiting for a current reading'),true,'A retained position cannot be presented as a current strategy');
check(retained.includes('Compare range:'),false,'A retained quote cannot supply a numeric range suggestion');
check(retained.includes('Costs/cases:'),false,'Stale observations cannot supply current cost advice');
check(retained.includes('retained values keep their original dates'),true,'Incomplete source coverage remains visible');
const many=Array.from({length:30},(_,i)=>({...katana,position:{...katana.position,positionId:String(5000+i)}}));
const bounded=renderAutomaticPortfolioBrief({...latest,positions:many,lp:{...latest.lp,open:30}});
check(bounded.length<=3000,true,'A large portfolio respects the established Telegram brief size');
check(/Showing \d+ of 30 tracked LPs/.test(bounded),true,'Large-portfolio omissions are counted explicitly instead of silently cutting off the reply');
check(bounded.includes('all positions and recorded outcomes are available in Agent'),true,'The remaining full evidence has an explicit destination');
check(bounded.endsWith('MYT.'),true,'Budgeting retains the complete reading-time footer');
const longCase=renderAutomaticPortfolioBrief({...latest,positions:[{...katana,comparisonSummary:'x'.repeat(5000)},robinhood]});
check(longCase.includes('katana #1001')&&longCase.includes('robinhood #2002'),true,'An oversized case explanation cannot crowd the other LP out of a normal two-position brief');
check(longCase.length<=3000,true,'Long comparison text is shortened at a field boundary, not cut mid-position');
const empty=renderAutomaticPortfolioBrief({...latest,positions:[],lp:{...latest.lp,open:0}});
check(empty.includes('0 open'),true,'A verified empty roster remains a real zero');
check(empty.includes('• Suggestion:'),false,'An empty roster cannot fabricate a position suggestion');
check(renderPositionSuggestion(katana).includes('• Why:'),true,'Expanded per-position evidence retains its existing format');
check(renderPositionSuggestion(katana).includes('• Next:'),true,'Individual risk alerts keep their own next-step line');
console.log('Complete automatic LP briefs: '+count+' assertions passed.');
