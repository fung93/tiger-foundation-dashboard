/* Regression for discovery coverage and wealth-change semantics. These are fixed
   local observations, not a current valuation or the unverified historical gap. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../index.html',import.meta.url),'utf8');
let checks=0;
const eq=(a,b,note)=>{assert.deepEqual(a,b,note);checks++;};
const NOW=Date.parse('2026-11-05T12:00:00Z');
class Clock extends Date { constructor(...a){super(...(a.length?a:[NOW]));} static now(){return NOW;} }
const elements=new Map(),element=id=>{
  if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',style:{},firstChild:{}});
  return elements.get(id);
};
const ctx=vm.createContext({Date:Clock,Number,Array,Math,Promise,console:{warn(){}},
  CFG:{wallet:'0x'+'1'.repeat(40),startDate:'2026-10-01',startValue:100,target:10000,katClaimed:0},
  getArcLive:async()=>({walletUsd:0,lps:[],merkl:{total_usd:0}}),
  getSolanaLive:async()=>({sol:0,usdc:0,solPrice:1,lps:[]}),discoverMorpho:async()=>{},morphoMarketList:()=>[],
  getKatanaLive:async()=>({lp_discovery_complete:false}),getSushiAprs:async()=>({}),
  robinhoodSourceTime:()=>new Clock().toISOString(),
  getRobinhoodLive:async()=>({walletUsd:0,lps:[],tokens:[]}),getFablesLive:async()=>({lps:[],locks:[]}),
  getMerklLive:async()=>({total_usd:0}),
  document:{getElementById:element},localStorage:{setItem(){}},
  fmtSigned:n=>(n<0?'-':'+')+'$'+Math.abs(n).toFixed(2),money:n=>'$'+n.toFixed(2),
  updatePeak(){},buildMonthly(){},buildCompound(){},
});
const begin=source.indexOf('function loadLive('),end=source.indexOf('/* ============ rendering',begin);
vm.runInContext(source.slice(begin,end),ctx);
await assert.rejects(()=>ctx.loadLive([],{}),/Katana LP discovery is incomplete/,
  'Unverified discovery cannot publish an apparently complete zero LP overview');checks++;
ctx.getKatanaLive=async()=>({lp_discovery_complete:true,ethPrice:2000,katPrice:1,avkatRate:1,ethBal:0,bal:{},lps:[],morpho:[],vkat:{totalKat:0,ids:[]}});
const empty=await ctx.loadLive([],{});
eq(empty.summary.lp_usd,0,'A successful complete discovery can still prove an empty position set');
eq(empty.live_health.warnings.length,0,'Verified empty holdings are not treated as missing data');

const fn=name=>{const m=source.match(new RegExp('function '+name+'\\([\\s\\S]*?\\n}'));assert.ok(m,name+' must exist');checks++;return m[0];};
for(const name of ['portfolioMovementState','syncTodayPoint','updateAvgDaily','updateChangeChips','updateRoiToggle'])vm.runInContext(fn(name),ctx);
const clean=()=>({live_health:{read_at:new Clock().toISOString(),warnings:[]}});
eq(ctx.portfolioMovementState(clean()).investment_return_available,false,
  'Fresh wealth values alone never establish investment returns without external cash-flow history');
eq(ctx.portfolioMovementState(clean()).basis,'wealth_change_unadjusted','The available measure names its actual wealth-movement basis');
eq(ctx.portfolioMovementState({last_updated:new Clock().toISOString()}).available,false,'An unlabeled saved snapshot is not current comparable coverage');
eq(ctx.portfolioMovementState({live_health:{read_at:new Clock(NOW-91000).toISOString(),warnings:[]}}).available,false,'An expired reading cannot support a current change');
ctx.HIST=[{date:'2026-11-05',total_usd:4000}];ctx.LAST_TOTAL=3100;ctx.CHART=null;ctx.LAST_BREAKDOWN=null;
ctx.LAST_DATA={live_health:{read_at:new Clock().toISOString(),warnings:['LP discovery failed']}};
const before=JSON.stringify(ctx.HIST);
ctx.syncTodayPoint();
eq(JSON.stringify(ctx.HIST),before,'A missing LP cannot overwrite today\'s historical chart point and manufacture a daily loss');
ctx.HIST=[{date:'2026-11-04',total_usd:4000}];ctx.HIST_START={time:NOW-86400000,total:4000,dateStr:'2026-11-04'};
ctx.EARN_MODES=[{k:'Daily',mult:1}];ctx.EARN_IDX=0;ctx.CHIP_MODES=[{l:'24H',d:1}];ctx.CHIP_IDX=0;ctx.ROI_MODES=[{k:'Daily',d:1}];ctx.ROI_IDX=0;
for(const name of ['updateAvgDaily','updateChangeChips','updateRoiToggle'])ctx[name]();
eq(element('dailyEarnings').textContent,'—','Incomplete coverage hides the apparent average loss');
eq(element('roiToggleVal').textContent,'—','Incomplete coverage hides the apparent percentage loss');
eq(element('chgChips').innerHTML.includes('unavailable'),true,'The change chip explains incomplete coverage');
ctx.LAST_DATA=clean();
for(const name of ['updateAvgDaily','updateChangeChips','updateRoiToggle'])ctx[name]();
eq(element('earnLabel').innerHTML.includes('Value Change'),true,'An unadjusted wealth movement is not called an earning');
eq(element('roiToggleLabel').innerHTML.includes('ROI'),false,'An unadjusted percentage movement is not called ROI');
eq(element('dailyEarningsSub').textContent.includes('includes cash flows'),true,'The cash-flow limitation remains visible');
eq(element('chgChips').innerHTML.includes('not investment P&amp;L'),true,'A raw wealth delta is explicitly distinguished from investment P&L');
console.log('Portfolio reconciliation and performance semantics: '+checks+' assertions passed.');
