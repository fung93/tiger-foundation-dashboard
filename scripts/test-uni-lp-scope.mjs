/* Exercise the actual public LP handler orchestration, with no external reads.
   Financial correctness remains in the independent Base/accounting suites. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {CFG,V3,FABLES,BOOK_VERSION} from '../api/_core.mjs';
import {createLiveCache,requestOrigin,fetchJSON,lpViewComplete,responseHeaders,savedBookValid} from '../api/_live-cache.mjs';
import {compactLPPositions} from '../portfolio-core.mjs';
let n=0;const eq=(a,b,m)=>{assert.deepEqual(a,b,m);n++;},ok=(v,m)=>{assert.ok(v,m);n++;};
const clone=v=>JSON.parse(JSON.stringify(v)),seed=JSON.parse(readFileSync(new URL('../lpbook.json',import.meta.url))),before=JSON.stringify(seed),inputs=[],reads=[];
let merklCalls=0,failed=false,time=Date.now();
class Clock extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
const source=readFileSync(new URL('../api/lpbook.mjs',import.meta.url),'utf8').replace(/^import[^\n]*\n/gm,'').replace('export default async function handler','async function handler');
const run=vm.runInNewContext(source+'\nhandler',{Date:Clock,URL,Map,Promise,Object,CFG,V3,FABLES,BOOK_VERSION,compactLPPositions,createLiveCache,requestOrigin,lpViewComplete,responseHeaders,savedBookValid,
 fetchJSON:async()=>clone(seed),merklLp:async()=>{merklCalls++;return {token_price:{}};},
 advanceBook:async(book,options)=>{inputs.push({book:clone(book),options});const next=clone(book);if(!failed)next.last_block.base++;return {book:next,errors:failed?{base:'Controlled source failure'}:{},behind:{base:failed?1:0},merkl:options.merkl};},
 bookLiveRows:async book=>{reads.push(clone(book));return {rows:{},errors:{}};},livePrices:async()=>({}),
 bookView:(_book,data)=>({cards:{},live:[],position_metrics:[],health:{errors:data.errors,behind:data.behind,unread:[],unpriced:[]}}),
 buildUniLPAccounting:(_book,view)=>({schemaVersion:'uni-lp-accounting-v1',complete:!view.health.errors.base&&view.health.behind.base===0,positions:[]}),
},{filename:'lpbook.mjs'});
async function call(query){const r={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},end(s){this.body=JSON.parse(s);}};await run({headers:{host:'uni-scope.test'},query},r);return r;}
const [a,b]=await Promise.all([call({scope:'uni'}),call({scope:'uni'})]);
eq(a.code,200,'Scoped UNI positions use the existing LP endpoint');eq(a.body,b.body,'Concurrent UNI visitors share one observation');eq(inputs.length,1,'Only one scoped ledger read');eq(Array.from(inputs[0].options.onlyChains),['base'],'UNI advances only the configured Base ledger');eq(merklCalls,0,'UNI does not wait for Katana rewards');
ok(Object.values(reads[0].positions).every(p=>p.chain==='base'),'Current position reads exclude unrelated chains');ok(Object.values(reads[0].tokens).every(t=>t.chain==='base'),'Current prices exclude unrelated chains');ok(a.headers['cache-control'].includes('s-maxage=3'),'Scoped UNI replies have a short current-data cache');
await call({scope:'uni'});eq(inputs.length,1,'A verified scoped response is briefly shared');
const full=await call({});eq(full.code,200,'The full LP Book remains available');eq(merklCalls,1,'The ordinary LP Book still reads its own rewards');eq(inputs[1].options.onlyChains,undefined,'The full LP Book still advances every configured chain');eq(inputs[1].book.last_block.base,seed.last_block.base,'Scoped and full readers keep separate checkpoints');
const realNow=Date.now;
try{Date.now=()=>time;time+=4000;failed=true;const bad=await call({scope:'uni'});eq(bad.body.uni.complete,false,'A Base failure cannot claim verified UNI figures');eq(bad.headers['cache-control'],'no-store','Scoped failures cannot enter the edge cache');
 failed=false;const retry=await call({scope:'uni'});eq(retry.body.uni.complete,true,'The next scoped pass can immediately recover');eq(inputs.at(-1).book.last_block.base,seed.last_block.base+1,'Recovery resumes its own verified warm checkpoint');
}finally{Date.now=realNow;}
eq(JSON.stringify(seed),before,'Source positions, closed values and histories never mutate');
console.log(`UNI LP-only refresh, unrelated-chain isolation, cache and recovery: ${n} assertions passed.`);
