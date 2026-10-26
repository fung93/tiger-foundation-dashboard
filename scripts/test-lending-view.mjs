/* Exercise the browser's real market visibility and combined LTV calculations.
   Uses controlled readings, without network access or browser dependencies. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MARKETS } from '../morpho-core.mjs';

const source=readFileSync(new URL('../lending.js',import.meta.url),'utf8');
const names=['marketIsInactive','marketIsHidden','lendingOverview'];
const functions=names.map(name=>{
  const match=source.match(new RegExp('function '+name+'\\([\\s\\S]*?\\n}'));
  assert.ok(match,'The browser function must exist: '+name);
  return match[0];
});
const view=vm.runInNewContext(functions.join('\n')+'\n({marketIsInactive,marketIsHidden,lendingOverview})');
let checks=names.length;
const check=(actual,expected,note)=>{assert.deepEqual(actual,expected,note);checks++;};
const overview=rows=>JSON.parse(JSON.stringify(view.lendingOverview(rows)));
const active=(collateral,debt,extra={})=>({no_position:false,oracle_collateral_usd:collateral,debt_usd:debt,...extra});
const closed={no_position:true,active:false,collateral_amount:0,debt_amount:0};
const unknown={oracle_collateral_usd:null,debt_usd:null,average_ltv:null};
const avkatUsdc=MARKETS.find(m=>m.key==='avkat-usdc');
const katUsdc=MARKETS.find(m=>m.key==='kat-usdc');
const avkatKat=MARKETS.find(m=>m.key==='avkat-kat');

for(const row of [undefined,null,{},
  {collateral_amount:0,debt_amount:0},
  {no_position:false,collateral_amount:10,debt_amount:0},
  {no_position:false,collateral_amount:0,debt_amount:10},
  {no_position:false,active:true,collateral_amount:0,debt_amount:0},
  {no_position:1},
  {...closed,error:'Katana could not be read'}]) {
  check(view.marketIsInactive(row),false,'Unknown readings and collateral, borrower or supplier positions are not inactive');
}
check(view.marketIsInactive(closed),true,'A confirmed empty position is inactive');
check(view.marketIsHidden(avkatUsdc,closed),true,'The empty avKAT/USDC market is hidden');
check(view.marketIsHidden(katUsdc,closed),false,'The empty KAT/USDC market stays visible for its inactive label and history');
check(view.marketIsHidden(avkatKat,closed),false,'Other requested markets are not removed');
check(view.marketIsHidden(avkatUsdc,active(100,50)),false,'A new avKAT/USDC position restores its visibility');
check(view.marketIsHidden(avkatUsdc,{...closed,error:'Unreadable'}),false,'An unreadable market cannot be mistaken for a closed market');
check(view.marketIsHidden(avkatUsdc,undefined),false,'A market without any reading is not silently removed');

const unequal=[active(1000,500),active(100,80),closed];
check(overview(unequal),{oracle_collateral_usd:1100,debt_usd:580,average_ltv:580/1100},
  'Combined LTV weights each market by oracle collateral rather than averaging percentages');
check(overview([active(1000,0),closed,closed]),{oracle_collateral_usd:1000,debt_usd:0,average_ltv:0},
  'Collateral with no borrowing has a genuine zero-percent LTV');
check(overview([closed,closed,closed]),{oracle_collateral_usd:0,debt_usd:0,average_ltv:null},
  'An empty portfolio has zero totals and no defined LTV');
check(overview([active(0,10),closed,closed]),{oracle_collateral_usd:0,debt_usd:10,average_ltv:null},
  'Debt without a collateral denominator cannot produce a finite LTV');
check(overview([active(100,90),active(100,120),closed]).average_ltv,1.05,
  'Above-100-percent aggregate LTV is shown honestly rather than capped');
check(overview([active(100,50),{...closed,oracle_collateral_usd:null,debt_usd:null},closed]),
  {oracle_collateral_usd:100,debt_usd:50,average_ltv:.5},
  'Confirmed empty markets contribute zero without needing an oracle dollar quote');

for(const missing of [undefined,null,{error:'Position read failed'},active(100,50,{error:'Read failed'})]) {
  check(overview([active(100,50),missing,closed]),unknown,'Missing or failed readings cannot become zero in the aggregate');
}
for(const field of ['oracle_collateral_usd','debt_usd']) {
  for(const invalid of [undefined,null,NaN,Infinity,-1]) {
    check(overview([active(100,50),active(100,50,{[field]:invalid}),closed]),unknown,
      'An unavailable or invalid '+field+' leaves the aggregate unknown');
  }
}
const frozen=Object.freeze(unequal.map(row=>Object.freeze({...row})));
const before=JSON.stringify(frozen);
overview(frozen);
check(JSON.stringify(frozen),before,'Overview calculations never modify the original readings');
console.log('Lending market view: '+checks+' assertions passed.');
