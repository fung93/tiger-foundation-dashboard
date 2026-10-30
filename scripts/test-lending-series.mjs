/* Exercise the actual browser series function: first borrowing, date windows,
   repayment periods and missing observations. No chain or browser dependency. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validateMorphoHistory } from './morpho.mjs';
import { MARKETS } from '../morpho-core.mjs';

const source=readFileSync(new URL('../lending.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const match=source.match(/function lendingSeries\([\s\S]*?\n}\nfunction seriesFor/);
assert.ok(match,'The tested series function must exist in the browser code');
const fn=vm.runInNewContext('('+match[0].replace(/\nfunction seriesFor$/,'')+')');
const series=(...args)=>JSON.parse(JSON.stringify(fn(...args)));
let checks=1;
const check=(actual,expected,note)=>{assert.deepEqual(actual,expected,note);checks++;};
const D=86400,id='market';
const market=(debt,extra={})=>({id,debt_amount:debt,no_position:false,...extra});
const sample=(day,row,extra={})=>({ts:day*D,block:day,markets:row?[row]:[],...extra});
const samples=[sample(1,market(0)),sample(2,market(5,{error:'unread'})),sample(3,market(5,{no_position:true})),
  sample(4,market(5)),sample(5,null),sample(6,market(5,{error:'unread'})),sample(7,market(0)),
  sample(8,market(0,{no_position:true})),sample(9,market(8))];
const before=JSON.stringify(samples);
let result=series(samples,null,id,0);
check(result[0].ts,4*D,'Collateral alone and invalid reads do not start a borrowing chart');
check(result.length,6,'Only the prefix before the first borrow is removed');
check(result[1].row,null,'A missing interior observation remains a gap');
check(result[2].row,null,'An interior read error remains a gap');
check(result[3].row.debt_amount,0,'A later repayment is retained');
check(result[4].row,null,'A later empty position remains a gap');
check(result[5].row.debt_amount,8,'A later reborrow is retained');
check(JSON.stringify(samples),before,'Preparing a chart does not mutate recorded history');
check(series(samples,null,id,1).map(p=>p.ts),[8*D,9*D],'A recent period crops the already-started loan history');
check(series([sample(1,market(5)),sample(28,market(0)),sample(30,market(0))],null,id,7).map(p=>p.ts),[28*D,30*D],
  'A recent repaid period is preserved even when the first borrow predates the window');
check(series([sample(1,market(0)),sample(2,market(0))],null,id,0),[],'No borrowing produces no borrowing chart');
check(series([],market(3,{ts:40*D,block:40}),id,0)[0].ts,40*D,'A first live borrow can start an empty history');
check(series([],market(0,{ts:40*D,block:40}),id,0),[],'A live collateral-only position does not start the chart');
check(series(samples,market(1,{ts:8*D,block:8}),id,0).length,6,'An older live reading cannot overwrite newer history');
check(series([sample(1,market(5),{interval_seconds:86400}),sample(2,market(6))],null,id,0).map(p=>p.interval_seconds),[86400,21600],
  'Daily archive and six-hour observations retain their different sampling intervals');

const restart=Date.parse('2026-10-30T00:00:00+08:00')/1000;
const resetSamples=[restart-D,restart-1,restart,restart+3600,restart+2*3600]
  .map((ts,i)=>({ts,block:i+1,markets:[market(i===3?0:5)]}));
const resetBefore=JSON.stringify(resetSamples);
for(const days of [7,14,0]) {
  const points=series(resetSamples,null,id,days,restart);
  check(points.map(p=>p.ts),[restart,restart+3600,restart+2*3600],'The fixed MYT restart applies to viewing period '+days);
  check(points[1].row.debt_amount,0,'A repayment after the restart remains visible for period '+days);
}
check(new Date(restart*1000).toISOString(),'2026-10-29T16:00:00.000Z','The restart uses MYT midnight rather than UTC midnight');
check(series([],market(3,{ts:restart-1,block:1}),id,0,restart),[],'A cached live reading before the restart stays excluded');
check(series([],market(3,{ts:restart,block:2}),id,0,restart)[0].ts,restart,'A live reading exactly at the restart is included');
check(series(resetSamples,market(3,{ts:restart+10*D,block:10}),id,0,restart)[0].ts,restart,'The fixed start does not move forward on later days');
check(series(resetSamples,market(3,{ts:restart+10*D,block:10}),id,7,restart).map(p=>p.ts),[restart+10*D],'A shorter viewing window still crops the restarted history');
check(JSON.stringify(resetSamples),resetBefore,'Restarting the displayed series leaves saved observations unchanged');

const book=JSON.parse(readFileSync(new URL('../morpho-history.json',import.meta.url),'utf8'));
const starts=vm.runInNewContext(source.match(/^const CHART_STARTS = .+;/m)[0]+'\nCHART_STARTS;');
const selector=source.match(/function seriesFor\(id\) \{[\s\S]*?\n}/)[0];
for(const days of [7,14,0]) {
  const select=vm.runInNewContext('('+selector+')',{MARKETS,history:book.samples,records:new Map(),
    periods:new Map(MARKETS.map(m=>[m.id,days])),CHART_STARTS:starts,lendingSeries:fn});
  const kat=MARKETS.find(m=>m.key==='kat-usdc');
  check(select(kat.id).every(p=>p.ts>=restart),true,'The actual KAT/USDC chart selector enforces the restart for period '+days);
  const other=MARKETS.find(m=>m.key==='avkat-kat');
  check(JSON.stringify(select(other.id)),JSON.stringify(series(book.samples,null,other.id,days)),'Other markets keep their original series for period '+days);
}
if(book.borrow_starts){
  check(validateMorphoHistory(book).samples.length,book.samples.length,'The expanded history and borrow-start records validate');
  for(const start of book.borrow_starts){
    const points=series(book.samples,null,start.id,0);
    check(points[0].block,start.block,'All starts at the verified first Borrow block: '+start.key);
    check(points[0].ts,start.ts,'Both charts start at the verified Borrow timestamp: '+start.key);
    check(points[0].row.debt_amount>0,true,'The opening point has genuine debt: '+start.key);
    const end=points.at(-1).ts;
    check(series(book.samples,null,start.id,7).every(p=>p.ts>=end-7*D),true,'7D respects its date window: '+start.key);
    check(series(book.samples,null,start.id,14).every(p=>p.ts>=end-14*D),true,'14D respects its date window: '+start.key);
  }
  const badInterval=structuredClone(book);badInterval.samples[0].interval_seconds=1;
  assert.throws(()=>validateMorphoHistory(badInterval),/unsupported sample interval/);checks++;
  const badStart=structuredClone(book);badStart.borrow_starts[0].block=1;
  assert.throws(()=>validateMorphoHistory(badStart),/borrow start/);checks++;
  const badHash=structuredClone(book);badHash.borrow_starts[0].tx_hash='unknown';
  assert.throws(()=>validateMorphoHistory(badHash),/borrow start/);checks++;
}
console.log('Lending chart starts: '+checks+' assertions passed.');
