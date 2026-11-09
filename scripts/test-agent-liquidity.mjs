import assert from 'node:assert/strict';
import {createLiquidityCurve} from '../agent-liquidity.mjs';
import {readLiquidityEvidence} from '../api/_agent-liquidity-reader.mjs';
import {keccakHex} from '../api/_core.mjs';
let n=0;const check=(a,b,s)=>{assert.deepEqual(a,b,s);n++;};
const address='0x'+'1'.repeat(40),stamp=new Date().toISOString(),e={schemaVersion:'agent-liquidity-v1',chain:'katana',pool:address,block:100,
 currentTick:0,activeLiquidityRaw:'1000',lowerTick:-2560,upperTick:5120,complete:true,ticks:[{tick:-100,gross:'1000',net:'1000'},{tick:100,gross:'400',net:'-400'}]};
let curve=createLiquidityCurve(e);check(curve.at(-101),0,'Going down crosses liquidityNet in the correct direction');
check(curve.at(-100),1000,'The lower initialized tick contributes active liquidity');check(curve.at(100),600,'An upward crossing applies signed negative liquidityNet');
check(curve.at(-3000),null,'Uncovered regions remain unknown');
check(createLiquidityCurve({...e,ticks:[...e.ticks].reverse()}),null,'Unordered tick evidence is rejected');
check(createLiquidityCurve({...e,ticks:[{tick:100,net:'-2000',gross:'2000'}]}),null,'Negative reconstructed liquidity is impossible');
check(createLiquidityCurve({...e,activeLiquidityRaw:(1n<<128n).toString()}),null,'Active liquidity must fit the actual uint128 pool ABI');
check(createLiquidityCurve({...e,activeLiquidityRaw:((1n<<128n)-1n).toString(),ticks:[{tick:-100,gross:'1',net:'-1'}]}),null,'Reconstructed liquidity outside the current tick must also fit uint128');
check(keccakHex(Buffer.from('tickBitmap(int16)').toString('hex')).replace(/^0x/,'').slice(0,8),'5339c296','The bitmap selector matches the exact V3 ABI');
check(keccakHex(Buffer.from('ticks(int24)').toString('hex')).replace(/^0x/,'').slice(0,8),'f30dba93','Initialized ticks use the exact V3 ABI');
const encoded=n=>BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0');let seen=[];
const readMulti=async(rpc,calls,tag)=>{seen.push({calls,tag});return calls.map(call=>call.data.startsWith('0x5339c296')
 ?{ok:true,data:'0x'+encoded(call.data.endsWith('f'.repeat(64))?1n<<246n:call.data.endsWith('0'.repeat(64))?1n<<10n:0n)}
 :{ok:true,data:'0x'+[1000,call.data.slice(-64).startsWith('f')?1000:-1000,0,0,0,0,0,1].map(encoded).join('')});};
const market={chain:'katana',pool:address,block:100,tick:0,tickSpacing:10,observedAt:stamp,activeLiquidityRaw:'1000'};
const result=await readLiquidityEvidence(market,{readMulti});check(result.complete,true,'The bounded reader produces a reconciled initialized-tick curve');
check(result.ticks.map(row=>row.tick),[-100,100],'Bitmap word and bit indices preserve negative ticks');
check(seen.every(row=>row.tag==='0x64'),true,'Every bitmap/tick read uses the original pinned block');
check(seen[0].calls.length,3,'Only three bitmap words are read');
check(seen[1].calls.length,2,'Only the observed initialized ticks are fetched');
const busy=await readLiquidityEvidence(market,{readMulti:async()=>Array.from({length:3},()=>({ok:true,data:'0x'+'f'.repeat(64)}))});
check(busy.complete,false,'Dense tick regions fail bounded rather than silently truncating liquidity');
console.log('Pinned initialized liquidity: '+n+' assertions passed.');
