import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createUniStrategyLoader} from '../api/_uni-strategy.mjs';
import {updateUniStrategy} from './uni-strategy.mjs';
import {strategyRpcFixture} from './fixtures/uni-strategy-rpc.mjs';
import {emptyUniStrategy} from '../uni-strategy-core.mjs';
import {createPreviewServer} from './dev-server.mjs';
let n=0;const eq=(a,b,m)=>{assert.deepEqual(a,b,m);n++;},ok=(v,m)=>{assert.ok(v,m);n++;};
const f=strategyRpcFixture(),saved=emptyUniStrategy(f.book.wallets),lpBook={version:9,wallets:f.book.wallets,tokens:{},positions:{},events:[],last_block:{}};
let bad=false,offline=false,advances=0,seen=[];
const read=createUniStrategyLoader({readJSON:async url=>url.endsWith('/lpbook.json')?lpBook:bad?{version:9}:saved,readTrades:async()=>f.trade,advance:async input=>{
 advances++;seen.push(input.events.length);await Promise.resolve();return {book:offline?{...f.book,chains:{base:{...f.book.chains.base,head:f.head+1}}}:f.book,complete:!offline,errors:offline?{base:'Controlled offline'}:{},at:f.now};
}});
const [a,b]=await Promise.all([read('https://complete.invalid'),read('https://complete.invalid')]);
eq(advances,1,'Concurrent strategy requests share one read');eq(a,b,'Shared requests get the identical evidence');eq(a.complete,true,'Accounting is checked before complete is advertised');
await read('https://complete.invalid');eq(advances,1,'Only verified complete readings enter the short cache');
bad=true;await assert.rejects(()=>read('https://invalid.invalid'),/ledger/);n++;eq(advances,1,'Malformed saved evidence fails before RPC');bad=false;
offline=true;const failed=await read('https://recovery.invalid');eq(failed.complete,false,'Failures cannot be cached as a healthy zero-capital strategy');
offline=false;const retry=await read('https://recovery.invalid');eq(retry.complete,true,'The same origin retries immediately after a failed pass');eq(seen.at(-1),f.book.events.length,'Warm checkpoints preserve independent progress');
const unpriced=structuredClone(f.book);unpriced.events[0].trade.usd=251;
const guard=createUniStrategyLoader({readJSON:async u=>u.endsWith('/lpbook.json')?lpBook:saved,readTrades:async()=>f.trade,advance:async()=>({book:unpriced,complete:true,errors:{},at:f.now})});
eq((await guard('https://unpriced.invalid')).complete,false,'A complete chain cursor cannot turn unknown cost into a financial result');
const temporary=await mkdtemp(join(tmpdir(),'tiger-uni-strategy-'));
try{
 const original={...saved};for(const [name,v]of Object.entries({'uni-strategy.json':original,'uni-trades.json':{trades:[]},'lpbook.json':lpBook}))await writeFile(join(temporary,name),JSON.stringify(v));
 const before=await Promise.all(['uni-trades.json','lpbook.json'].map(p=>readFile(join(temporary,p),'utf8')));
 const next=await updateUniStrategy(temporary,{advance:async()=>({book:f.book,complete:true,errors:{},at:f.now})});eq(next.complete,true,'Independent checkpoint writer validates successful replay');
 eq(await Promise.all(['uni-trades.json','lpbook.json'].map(p=>readFile(join(temporary,p),'utf8'))),before,'Cash writer never changes trade or LP histories');
 const verified=await readFile(join(temporary,'uni-strategy.json'),'utf8');
 await assert.rejects(()=>updateUniStrategy(temporary,{advance:async()=>({book:{version:99},complete:true,errors:{}})}),/ledger/);n++;
 eq(await readFile(join(temporary,'uni-strategy.json'),'utf8'),verified,'Invalid new evidence cannot overwrite the last checkpoint');
}finally{await rm(temporary,{recursive:true,force:true});}
const server=await createPreviewServer({port:0});
try{
 const origin='http://127.0.0.1:'+server.address().port,ref=origin+'/__review/uni-strategy?scenario=reuse';
 const page=await fetch(ref).then(r=>r.text());ok(page.includes('Local review · Example figures'),'Example finances are prominently labelled on their own local route');
 const sample=await fetch(origin+'/api/uni?view=strategy',{headers:{referer:ref}}).then(r=>r.json());eq(sample.book.events[0].trade.usd,250,'Only the explicit same-origin review route receives example finances');
 const ordinary=await fetch(origin+'/uni-trade.html').then(r=>r.text());ok(!ordinary.includes('id="localReview"'),'The regular page never becomes an example page');
 const savedData=await fetch(origin+'/uni-strategy.json').then(r=>r.json());eq(savedData,JSON.parse(await readFile(new URL('../uni-strategy.json',import.meta.url),'utf8')),'Ordinary static history is the actual saved checkpoint, never fabricated example balances');
 eq((await fetch(origin+'/__review/uni-strategy?scenario=wrong')).status,400,'Unknown review scenarios fail explicitly');
 const post=await fetch(origin+'/api/uni?view=strategy',{method:'POST'});eq(post.status,405,'The new cash view cannot submit transactions or mutate a wallet');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
console.log(`UNI strategy API isolation, independent writer and explicit local examples: ${n} assertions passed.`);
