/* ABI-shaped read-only chain: prove BTC's eight decimals, oracle valuation,
   accrued USDC debt, missing-source recovery and additive history migration. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
import {readMorpho,MARKETS,liquidationMetrics,mergeHistory,debtAssets,targetMetrics} from '../morpho-core.mjs';
import {validateMorphoHistory} from './morpho.mjs';
let n=0;const eq=(a,b,note)=>{assert.deepEqual(a,b,note);n++;},near=(a,b,note)=>{assert.ok(Math.abs(a-b)<1e-6,note+': '+a+' vs '+b);n++;};
const WAD=10n**18n,head=49999999,now=Math.floor(Date.now()/1000),hx=n=>'0x'+n.toString(16),
 word=n=>BigInt(n).toString(16).padStart(64,'0'),abi=(...values)=>'0x'+values.map(word).join(''),
 KAT='0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d',AV='0x7231dbacdfc968e07656d12389ab20de82fbfceb',BTC='0x0913da6da4b42f538b445599b46bb4622342cf52',USDC='0x203a662b0bd271a6ed5a60edfbd04bfce608fd36',
 KAT_POOL='0x10045367e619caae6f60cc80046c43c6cd55f629',BTC_POOL='0x744676b3ced942d78f9b8e9cd22246db5c32395c',btc=MARKETS.find(m=>m.key==='btc-usdc');
assert.ok(btc,'BTC is in the canonical lending registry');n++;
const aggregate=results=>{let tail='',offsets='';for(const r of results){const bytes=r.data.slice(2);offsets+=word(results.length*32+tail.length/2);tail+=word(r.ok?1:0)+word(64)+word(bytes.length/2)+bytes.padEnd(Math.ceil(bytes.length/64)*64,'0');}return abi(32,results.length)+offsets+tail;};
const decode=data=>{const hex=data.slice(10),at=byte=>hex.slice(byte*2,byte*2+64),count=Number(BigInt('0x'+at(32)));return Array.from({length:count},(_,i)=>{const start=64+Number(BigInt('0x'+at(64+i*32))),bytes=start+Number(BigInt('0x'+at(start+64))),size=Number(BigInt('0x'+at(bytes)));return{to:'0x'+at(start).slice(24),data:'0x'+hex.slice((bytes+32)*2,(bytes+32+size)*2)};});};
const good=data=>({ok:true,data}),bad={ok:false,data:'0x'},oracles=MARKETS.map((m,i)=>'0x'+String(i+1).repeat(40));
let mode='normal',calls=[],accrued=new Set();
function contract(call,tag){
 calls.push({...call,tag});const sel=call.data.slice(0,10),id='0x'+call.data.slice(10,74),index=MARKETS.findIndex(m=>m.id===id),m=MARKETS[index];
 if(sel==='0x3850c7bd'){
  if(call.to===BTC_POOL)return mode==='missing-price'?bad:good(abi(BigInt(Math.round(Math.sqrt(90000/100)*2**96)),0));
  assert.equal(call.to,KAT_POOL);return good(abi(BigInt(Math.round(Math.sqrt(1e12/.003)*2**96)),0));
 }
 if(sel==='0x07a2d13a')return good(abi(14n*WAD/10n));
 if(sel==='0x313ce567')return good(abi(8));
 if(sel==='0xfeaf968c')return good(abi(1,300000,now-10,now-10,1));
 if(sel==='0x93c52062')return good(abi(0,m.key==='btc-usdc'&&mode!=='empty'?200000000n*1000000n:m.key==='avkat-kat'?600n*WAD*1000000n:0,
   m.key==='btc-usdc'&&mode!=='empty'?400000n:m.key==='avkat-kat'?1000n*WAD:0));
 if(sel==='0x2c3c9157')return good(abi(m.loan_token==='KAT'?KAT:USDC,m.key==='btc-usdc'?(mode==='wrong-token'?KAT:BTC):m.collateral_token==='avKAT'?AV:KAT,oracles[index],1,BigInt(Math.round(m.lltv*1e6))*10n**12n));
 if(sel==='0x151c1ade'){const oracle='0x'+call.data.slice(10+2*64,10+3*64).slice(24);accrued.add(oracles.indexOf(oracle));return good('0x');}
 if(sel==='0x5c60e39a'){
  assert.ok(accrued.has(index),'Each market accrues interest before its debt reading');
  const shares=m.key==='btc-usdc'?200000000n*1000000n:m.key==='avkat-kat'?600n*WAD*1000000n:1000000n,
   debt=m.key==='btc-usdc'?210000000n:m.key==='avkat-kat'?600n*WAD:1n;
  return good(abi(debt+1000n*10n**BigInt(m.loan_decimals),1,debt-1n,shares-1000000n,now-100,0));
 }
 if(sel==='0xa035b1fe'){
  const i=oracles.indexOf(call.to);if(i===3&&mode==='missing-oracle')return bad;
  return good(abi(i===3?1000n*10n**36n:i===0?14n*10n**35n:i===1?42n*10n**20n:3n*10n**21n));
 }
 throw Error('Unexpected fixture selector '+sel);
}
const fetcher=globalThis.fetch;
globalThis.fetch=async(_url,init)=>{const q=JSON.parse(init.body);if(q.method==='eth_getBlockByNumber')return Response.json({result:{number:hx(head),timestamp:hx(now)}});assert.equal(q.method,'eth_call','No transaction method is used');accrued=new Set();return Response.json({result:aggregate(decode(q.params[0].data).map(c=>contract(c,q.params[1])))});};
try{
 const sample=await readMorpho(),row=sample.markets.find(m=>m.key==='btc-usdc');
 eq(sample.full,true,'All four positions are independently verified');eq(sample.market_ids.length,4,'Snapshots declare four-market coverage');
 eq(row.collateral_decimals,8,'Canonical vbWBTC uses eight decimals');eq(row.loan_decimals,6,'Canonical vbUSDC uses six decimals');
 near(row.collateral_amount,.004,'Raw BTC collateral converts without a 10^10 unit error');near(row.debt_amount,210,'USDC debt includes the simulated accrued interest');
 near(row.oracle_collateral_usd,400,'Collateral summary uses the BTC market oracle');near(row.collateral_usd,360,'Market price stays separate from the oracle valuation');
 near(row.ltv,.525,'BTC LTV is debt divided by its own oracle collateral');near(row.health,344/210,'BTC health uses its 86% LLTV');eq(row.lltv,.86,'Actual market LLTV is retained');
 eq(calls.every(c=>c.tag===hx(head)),true,'All prices, parameters, balances and accrued debt share one pinned block');
 const source=readFileSync(new URL('../lending.js',import.meta.url),'utf8'),functions=['marketIsInactive','lendingOverview'].map(name=>source.match(new RegExp('function '+name+'\\([\\s\\S]*?\\n}'))[0]).join('\n'),overview=vm.runInNewContext(functions+'\nlendingOverview');
 const total=overview(sample.markets);near(total.oracle_collateral_usd,404.2,'Top Oracle collateral includes BTC plus the KAT market');near(total.debt_usd,211.8,'Top Borrowed includes accrued BTC/USDC debt');near(total.average_ltv,211.8/404.2,'Average LTV uses the full weighted oracle collateral denominator');
 const boundary=liquidationMetrics(row);eq(boundary.kind,'collateral-usd','BTC uses its own oracle-dollar boundary');near(boundary.estimated_collateral_liquidation_usd,61046.51175,'BTC boundary includes Morpho’s raw USDC rounding for eight-decimal collateral');
 const rawBoundary=BigInt(boundary.oracle_liquidation_raw),healthy=p=>400000n*p/(10n**36n)*860000000000000000n/WAD>=210000000n;eq(healthy(rawBoundary),true,'The BTC boundary is healthy under the exact protocol floors');eq(healthy(rawBoundary-1n),false,'One raw oracle unit below the BTC boundary permits liquidation');
 eq(boundary.estimated_kat_liquidation_usd,null,'BTC borrowing never becomes a KAT liquidation forecast');eq(boundary.kat_price_basis,null,'The unrelated KAT feed cannot become the BTC price basis');
 mode='missing-oracle';const failed=await readMorpho();eq(!!failed.errors['btc-usdc'],true,'An unread BTC oracle marks that market incomplete');eq(overview(failed.markets).debt_usd,null,'The overview cannot silently omit an unread BTC loan');
 mode='normal';eq((await readMorpho()).full,true,'The same source recovers after its BTC oracle returns');
 mode='missing-price';const partial=await readMorpho(),oracleOnly=partial.markets.find(m=>m.key==='btc-usdc');eq(oracleOnly.collateral_usd,null,'A failed pool quote never fabricates a BTC market value');near(oracleOnly.oracle_collateral_usd,400,'A separate pool quote outage preserves the verified oracle collateral');
 mode='wrong-token';eq(!!(await readMorpho()).errors['btc-usdc'],true,'Incorrect collateral token identity is rejected');
 mode='empty';eq((await readMorpho()).markets.find(m=>m.key==='btc-usdc').no_position,true,'Only a verified empty BTC position is inactive');mode='normal';
 const legacy=JSON.parse(readFileSync(new URL('./fixtures/morpho-legacy.json',import.meta.url))),before=JSON.stringify(legacy.samples);
 eq(validateMorphoHistory(legacy).samples.length,legacy.samples.length,'Existing three-market histories still validate');
 const merged=mergeHistory(legacy,sample);eq(merged.markets.length,4,'Appending a reading adds BTC to the history registry');eq(JSON.stringify(merged.samples.slice(0,-1)),before,'Every previously recorded observation remains byte-for-byte unchanged');
 eq(validateMorphoHistory(merged).samples.length,legacy.samples.length+1,'Legacy and four-market observations coexist safely');
 const missing=structuredClone(merged);missing.samples.at(-1).markets.pop();assert.throws(()=>validateMorphoHistory(missing),/coverage/);n++;
 const duplicate=structuredClone(merged);duplicate.samples.at(-1).markets[3]=duplicate.samples.at(-1).markets[0];assert.throws(()=>validateMorphoHistory(duplicate),/sample markets/);n++;
 const wrongDecimals=structuredClone(merged);wrongDecimals.samples.at(-1).markets[3].collateral_decimals=18;assert.throws(()=>validateMorphoHistory(wrongDecimals),/identity/);n++;
 const recorded=JSON.parse(readFileSync(new URL('./fixtures/morpho-btc-recorded.json',import.meta.url))).latestSample,
  recordedBtc=recorded.markets.find(m=>m.key==='btc-usdc');
 eq(recordedBtc.id,btc.id,'The actual wallet receipt identifies the configured BTC market');
 eq(debtAssets(BigInt(recordedBtc.raw.borrow_shares),BigInt(recordedBtc.raw.total_borrow_assets),BigInt(recordedBtc.raw.total_borrow_shares)),BigInt(recordedBtc.raw.debt),'Actual recorded BTC borrowing reconciles with accrued shares');
 near(overview(recorded.markets).debt_usd,868.5272875335831,'The recorded combined Borrowed value includes BTC');
 near(overview(recorded.markets).oracle_collateral_usd,1507.9729962309339,'The recorded Oracle collateral includes BTC at its own oracle');
 eq(targetMetrics(recordedBtc,1).target_ltv,.86,'Minimum health one permits the actual BTC market’s 86% boundary');
 const output=process.argv.indexOf('--output');if(output>=0)writeFileSync(process.argv[output+1],JSON.stringify({sample,history:merged}));
 console.log('BTC lending oracle, accrued debt, overview, liquidation and history migration: '+n+' assertions passed.');
}finally{globalThis.fetch=fetcher;}
