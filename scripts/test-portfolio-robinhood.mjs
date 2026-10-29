/* Exercise the Portfolio's real Robinhood reader with controlled chain responses.
   An incomplete multicall must never become a smaller successful portfolio reading.
   These fixed dollar amounts are test fixtures, not current portfolio holdings. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('/* ============ Robinhood Chain');
const end=source.indexOf('/* ============ Arc',start);
assert.ok(start>=0&&end>start,'The tested Robinhood reader must exist in the Portfolio');
const reader=source.slice(start,end);
const helpers=source.slice(source.indexOf('function pad(h)'),source.indexOf('function hexBytesLen'));
const address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const word=value=>(typeof value==='string'?value.replace(/^0x/,''):BigInt.asUintN(256,BigInt(value)).toString(16)).padStart(64,'0');
const abi=(...values)=>'0x'+values.map(word).join('');
const symbol=text=>abi(32,text.length)+Buffer.from(text).toString('hex').padEnd(64,'0');
const good=data=>({ok:true,data}),failed={ok:false,data:'0x'};
const ID=1458357,START=Date.parse('2026-10-29T04:00:00Z');
let checks=1;
const normal=value=>value&&typeof value==='object'?JSON.parse(JSON.stringify(value)):value;
const check=(actual,expected,note)=>{assert.deepEqual(normal(actual),normal(expected),note);checks++;};
const ok=(condition,note)=>{assert.ok(condition,note);checks++;};

function harness(initialMode='complete') {
  let mode=initialMode,now=START;
  const calls=[];
  const CFG={wallet:address(7),multicall:address(8),rhNpm:address(9),rhFactory:address(10),
    rhRpcs:['https://rpc.example.invalid'],rhTokens:{USDG:{a:address(1),d:6,stable:true}}};
  const pool=address(12),token=address(2);
  class ControlledDate extends Date {
    constructor(...args){super(...(args.length?args:[now]));}
    static now(){return now;}
  }
  const count=()=>mode==='empty'?0:mode==='many'?21:mode==='too-many'?201:
    ['enumeration-tail-missing','position-tail-missing','metadata-tail-missing','pool-tail-missing','duplicate-ids'].includes(mode)?2:1;
  const invoke=async(url,method,params)=>{
    assert.equal(url,CFG.rhRpcs[0],'Robinhood calls remain on their own chain endpoint');
    assert.equal(method,'eth_call','The position reader uses aggregate eth_call');
    const batch=params[0].data;
    calls.push(batch);
    if(mode==='transport-failed')throw new Error('forced Robinhood transport failure');
    const result=batch.map(call=>{
      const selector=call.data.slice(0,10);
      if(selector==='0x4d2301cc')return mode==='native-failed'?failed:good(mode==='native-malformed'?'0x1234':abi((mode==='native-zero'?0n:mode==='wallet-new-lp-failed'?2n:1n)*10n**18n));
      if(selector==='0x70a08231'){
        if(call.to===CFG.rhNpm)return mode==='count-failed'?failed:good(mode==='count-malformed'?'0x1234':abi(count()));
        return mode==='token-failed'?failed:good(mode==='token-malformed'?'0x1234':abi(10n*10n**6n));
      }
      if(selector==='0x2f745c59'){
        if(mode==='enumeration-failed')return failed;
        const index=Number(BigInt('0x'+call.data.slice(-64)));
        return good(mode==='enumeration-malformed'?'0x1234':abi(ID+(mode==='duplicate-ids'?0:index)));
      }
      if(selector==='0x99fbab88'){
        if(mode==='position-failed')return failed;
        return good(mode==='position-malformed'?abi(0):abi(0,0,
          mode==='no-stable-leg'?address(98):CFG.rhTokens.USDG.a,token,3000,-100,100,
          mode==='closed'||mode==='fee-only'?0:10n**18n,0,0,mode==='fee-only'?5000000:0,0));
      }
      if(selector==='0x6352211e')return mode==='owner-failed'?failed:good(mode==='owner-malformed'?'0x1234':abi(mode==='owner-zero'?address(0):mode==='transferred'?address(99):CFG.wallet));
      if(selector==='0x313ce567'){
        if(mode==='decimals-failed')return failed;
        return good(mode==='decimals-malformed'?'0x1234':abi(mode==='decimals-invalid'?256:call.to===CFG.rhTokens.USDG.a?6:18));
      }
      if(selector==='0x95d89b41')return mode==='symbol-failed'?failed:good(symbol(call.to===CFG.rhTokens.USDG.a?'USDG':'WETH'));
      if(selector==='0x1698ee82')return mode==='pool-failed'?failed:good(mode==='pool-malformed'?'0x1234':abi(mode==='pool-zero'?address(0):pool));
      if(selector==='0x3850c7bd')return mode==='slot-failed'?failed:good(mode==='slot-malformed'?abi(1n<<96n):abi(mode==='slot-zero'?0:1n<<96n,0));
      if(selector==='0xf3058399')return mode==='fee0-failed'||mode==='wallet-new-lp-failed'?failed:good(mode==='fee0-malformed'?'0x1234':abi(0));
      if(selector==='0x46141319')return mode==='fee1-failed'?failed:good(abi(0));
      if(selector==='0xf30dba93')return mode==='ticks-failed'?failed:good(mode==='ticks-malformed'?abi(0):abi(0,0,0,0));
      throw new Error('Unexpected Robinhood fixture selector '+selector);
    });
    if(mode==='wallet-tail-missing'&&batch[0]?.data.startsWith('0x4d2301cc')
      ||mode==='enumeration-tail-missing'&&batch[0]?.data.startsWith('0x2f745c59')
      ||mode==='position-tail-missing'&&batch.some(call=>call.data.startsWith('0x99fbab88'))
      ||mode==='metadata-tail-missing'&&batch[0]?.data.startsWith('0x313ce567')
      ||mode==='pool-tail-missing'&&batch[0]?.data.startsWith('0x3850c7bd'))return result.slice(0,-1);
    return result;
  };
  const context=vm.createContext({CFG,console:{warn(){}},Date:ControlledDate,BigInt,Number,Math,Promise,JSON,
    TigerRpc:{create:()=>invoke},
    encodeAgg3:batch=>batch,decodeAgg3:value=>value,
    enc24:tick=>word(tick),v3Amounts:liq=>[liq===0n?0n:100n*10n**6n,0].map(Number),
    poolPrice:()=>mode==='price-zero'?0:1,arcAccrued:()=>0n,arcInside:()=>0n,
    fmtN:value=>String(value)});
  vm.runInContext(helpers+'\n'+reader,context,{filename:'Portfolio Robinhood reader from index.html'});
  return {read:(price=2000)=>context.getRobinhoodLive(price),fallback:snapshot=>context.robinhoodFallback(snapshot),
    setMode(next){mode=next;},advance(ms){now+=ms;},now:()=>now,calls,context};
}

const full=harness();
let result=await full.read();
check(result.walletUsd,2010,'The full wallet reading includes native ETH and stable tokens');
check(result.lps.length,1,'A complete reading includes the verified live LP');
check(result.lps[0].value_usd,100,'The LP preserves its whole measured test value');
check(result.lps[0].token_id,String(ID),'The LP retains its verified token identity');
check(full.calls.length,5,'A cold LP reading uses five batched requests');
await full.read();
check(full.calls.length,9,'A warm LP reading reuses immutable metadata and needs four requests');

for(const mode of ['transport-failed','native-failed','native-malformed','token-failed','token-malformed',
  'count-failed','count-malformed','too-many','wallet-tail-missing','enumeration-failed','enumeration-malformed',
  'enumeration-tail-missing','duplicate-ids','position-failed','position-malformed','position-tail-missing',
  'owner-failed','owner-malformed','owner-zero','decimals-failed','decimals-malformed','decimals-invalid','pool-failed',
  'pool-malformed','pool-zero','metadata-tail-missing','slot-failed','slot-malformed','slot-zero',
  'fee0-failed','fee0-malformed','fee1-failed','ticks-failed','ticks-malformed','pool-tail-missing',
  'price-zero','no-stable-leg']) {
  await assert.rejects(harness(mode).read(),mode+' must not become a smaller successful reading');checks++;
}
await assert.rejects(harness().read(0),'An unavailable native-token quote cannot value owned ETH at zero');checks++;
result=await harness('native-zero').read(Infinity);
check(result.walletUsd,10,'Verified zero native ETH does not need an ETH quote or turn the stable wallet balance into NaN');
result=await harness('symbol-failed').read();
check(result.lps[0].value_usd,100,'An optional token symbol failure does not discard a fully priced LP');
ok(result.lps[0].pair.length>0,'An optional symbol failure still leaves a usable position label');
result=await harness('fee-only').read();
check(result.lps.length,1,'A zero-liquidity NFT with fees still owed remains in the reading');
check(result.lps[0].value_usd,5,'A fee-only position keeps its verified owed amount');

const many=harness('many');result=await many.read();
check(result.lps.length,21,'A wallet owning more than twenty NFTs is not silently truncated');
check(result.lps.reduce((sum,lp)=>sum+lp.value_usd,0),2100,'All twenty-one positions contribute their value');
check(new Set(result.lps.map(lp=>lp.token_id)).size,21,'Every enumerated position is counted once');

for(const mode of ['empty','closed','transferred']) {
  const read=harness();await read.read();read.advance(15000);read.setMode(mode);
  result=await read.read();
  check(result.lps.length,0,'A complete '+mode+' reading removes prior live positions');
  check(read.fallback({}).lps.length,0,'A later fallback cannot resurrect a verified '+mode+' position');
}

const cache=harness();result=await cache.read();
const sourceTime=result.read_at;
ok(Number.isFinite(Date.parse(sourceTime)),'A complete Robinhood reading records its own source time');
result.walletUsd=0;result.lps[0].value_usd=0;result.tokens[0].amount=0;
cache.advance(60000);cache.setMode('wallet-new-lp-failed');
await assert.rejects(cache.read(),'A new wallet balance paired with an incomplete LP reading is rejected');checks++;
const oldSnapshot={last_updated:new Date(START-3600000).toISOString(),chains:{robinhood:{
  onchain_usd:12,tokens:[{symbol:'USDG',amount:12,usd:12}],lp_positions:[{value_usd:50}]}}};
const retained=cache.fallback(oldSnapshot);
check(retained.walletUsd,2010,'A failure keeps the latest whole wallet reading instead of an older saved snapshot');
check(retained.lps[0].value_usd,100,'A partial LP read preserves the last whole LP value');
check(retained.tokens[0].amount,10,'Caller mutation cannot poison retained token quantities');
check(retained.read_at,sourceTime,'Fallback preserves the original Robinhood reading time');
check(retained.fromSnapshot,true,'A retained reading is explicitly marked as a fallback');
retained.lps[0].value_usd=0;retained.walletUsd=0;
check(cache.fallback(oldSnapshot).lps[0].value_usd,100,'Fallback consumers cannot mutate the last complete cache');
check(cache.fallback(oldSnapshot).walletUsd,2010,'Fallback consumers cannot overwrite the cached wallet total');
cache.setMode('complete');result=await cache.read();
check(result.walletUsd,2010,'A full recovery restores the complete wallet value');
check(result.lps[0].value_usd,100,'A full recovery restores the complete LP value');
ok(Date.parse(result.read_at)>Date.parse(sourceTime),'Only a complete recovery advances the source time');
check(!!result.fromSnapshot,false,'A full recovery no longer reports retained data');

const cold=harness('transport-failed');await assert.rejects(cold.read());checks++;
const saved=cold.fallback(oldSnapshot);
check(saved.walletUsd,12,'A cold failure may use the actual committed wallet snapshot');
check(saved.lps[0].value_usd,50,'A cold failure preserves the committed LP snapshot');
check(saved.read_at,oldSnapshot.last_updated,'A cold snapshot fallback keeps its saved reading time');
check(saved.fromSnapshot,true,'The cold snapshot fallback is explicitly labelled');
saved.lps[0].value_usd=0;saved.tokens[0].amount=0;
check(JSON.stringify(oldSnapshot),JSON.stringify({last_updated:new Date(START-3600000).toISOString(),chains:{robinhood:{
  onchain_usd:12,tokens:[{symbol:'USDG',amount:12,usd:12}],lp_positions:[{value_usd:50}]}}}),
  'Preparing a fallback never changes the source snapshot');

/* Exercise the actual Fables API reader and loadLive assembly, not just the caches.
   A whole retained reading must keep its source time all the way to Portfolio status. */
const assemblyStart=source.indexOf('var FABLES_LAST_GOOD=');
const assemblyEnd=source.indexOf('/* ============ rendering',assemblyStart);
assert.ok(assemblyStart>=0&&assemblyEnd>assemblyStart,'The actual Fables and Portfolio assembly helpers must exist');checks++;
const status=source.match(/function portfolioReadState\([\s\S]*?\n}/);
assert.ok(status,'The tested Portfolio freshness function must exist');checks++;

function assemblyHarness(mode='complete') {
  const h=harness(mode),ctx=h.context;
  let fabMode='complete';
  const own=ctx.CFG.wallet,other=address(99),clone=value=>JSON.parse(JSON.stringify(value));
  Object.assign(ctx.CFG,{startDate:'2026-10-01',startValue:100,target:10000,katClaimed:0});
  Object.assign(ctx,{
    AbortController,setTimeout,clearTimeout,
    getArcLive:async()=>({walletUsd:0,tokens:[],lps:[],merkl:{total_usd:0}}),
    getSolanaLive:async()=>({sol:0,usdc:0,solPrice:1,lps:[]}),
    discoverMorpho:async()=>{},morphoMarketList:()=>[],
    getKatanaLive:async()=>({ethPrice:2000,katPrice:1,avkatRate:1,ethBal:0,bal:{},lps:[],morpho:[],vkat:{totalKat:0,ids:[]}}),
    getSushiAprs:async()=>({}),getMerklLive:async()=>({total_usd:0}),
    fetch:async url=>{
      assert.equal(url,'/api/fables','The assembly reads the shared Fables endpoint');
      if(fabMode==='http-error')return{ok:false,status:429,json(){throw new Error('An HTTP failure must not parse a success body');}};
      let payload={complete:true,at:new Date(h.now()).toISOString(),
        lps:[{protocol:'Fables',wallet:own,value_usd:5},{protocol:'Fables',wallet:other,value_usd:50}],
        locks:[{protocol:'Fables veFABLES',wallet:own,value_usd:7},{protocol:'Fables veFABLES',wallet:other,value_usd:70}]};
      if(fabMode==='empty')payload={...payload,lps:[],locks:[]};
      if(fabMode==='incomplete')payload.complete=false;
      if(fabMode==='errors')payload.errors={robinhood:'required read failed'};
      if(fabMode==='missing-lps')delete payload.lps;
      if(fabMode==='missing-locks')delete payload.locks;
      if(fabMode==='missing-wallet')delete payload.lps[0].wallet;
      if(fabMode==='missing-value')delete payload.lps[0].value_usd;
      if(fabMode==='null-value')payload.lps[0].value_usd=null;
      if(fabMode==='negative-value')payload.lps[0].value_usd=-1;
      if(fabMode==='stale')payload.at=new Date(h.now()-91000).toISOString();
      if(fabMode==='future')payload.at=new Date(h.now()+31000).toISOString();
      if(fabMode==='missing-time')delete payload.at;
      return {ok:true,status:200,json:async()=>clone(payload)};
    }
  });
  vm.runInContext(source.slice(assemblyStart,assemblyEnd)+'\n'+status[0],ctx,{filename:'Fables and loadLive from index.html'});
  return {...h,setFablesMode(next){fabMode=next;},fables:()=>ctx.getFablesLive(),
    fablesFallback:snap=>ctx.fablesFallback(snap),load:snap=>ctx.loadLive([],snap),
    state:data=>normal(ctx.portfolioReadState(data,true,h.now()))};
}

for(const mode of ['http-error','incomplete','errors','missing-lps','missing-locks','missing-wallet','missing-value',
  'null-value','negative-value','stale','future','missing-time']) {
  const h=assemblyHarness();h.setFablesMode(mode);
  await assert.rejects(h.fables(),mode+' cannot be accepted as a complete current Fables reading');checks++;
}
for(const stalled of ['headers','body']) {
  const h=assemblyHarness(),ctx=h.context,healthy=ctx.fetch;
  let signal;
  ctx.setTimeout=(fn,ms)=>setTimeout(fn,Math.min(ms,5));
  ctx.fetch=async(url,options)=>{
    signal=options.signal;
    return stalled==='headers'?new Promise(()=>{}):{ok:true,json:()=>new Promise(()=>{})};
  };
  await assert.rejects(h.fables(),/timed out/,'A stalled Fables '+stalled+' read has a bounded whole-operation deadline');checks++;
  check(signal.aborted,true,'The stalled Fables '+stalled+' request is aborted');
  ctx.fetch=healthy;
  check((await h.fables()).lps.length,2,'Fables recovers after a stalled '+stalled+' read in the same context');
}
const fabCache=assemblyHarness();result=await fabCache.fables();const fabTime=result.at;
result.lps[0].value_usd=0;result.locks[0].value_usd=0;
fabCache.advance(15000);fabCache.setFablesMode('http-error');
await assert.rejects(fabCache.fables(),'Fables transport failure must reject rather than replace its cache');checks++;
let fabRetained=fabCache.fablesFallback(oldSnapshot);
check(fabRetained.lps[0].value_usd,5,'Fables fallback retains its last full LP value');
check(fabRetained.locks[0].value_usd,7,'Fables fallback retains its last full lock value');
check(fabRetained.at,fabTime,'Fables fallback retains its actual prior reading time');
check(fabRetained.fromSnapshot,true,'Retained Fables figures are explicitly marked as fallback');
fabRetained.lps[0].value_usd=0;
check(fabCache.fablesFallback(oldSnapshot).lps[0].value_usd,5,'Fables fallback callers cannot poison its full cache');
fabCache.setFablesMode('empty');result=await fabCache.fables();
check(result.lps.length+result.locks.length,0,'Verified empty Fables arrays are accepted');
check(fabCache.fablesFallback(oldSnapshot).lps.length+fabCache.fablesFallback(oldSnapshot).locks.length,0,
  'A fallback cannot resurrect verified closed Fables positions');

const snap={last_updated:new Date(START-3600000).toISOString(),chains:{robinhood:{onchain_usd:12,
  tokens:[{symbol:'USDG',amount:12,usd:12}],lp_positions:[{protocol:'Uniswap V3',value_usd:50},
    {protocol:'Fables',wallet:address(7),value_usd:1}],defi_positions:[{protocol:'Fables veFABLES',wallet:address(7),value_usd:2}]}}};
const snapshotBefore=JSON.stringify(snap),whole=assemblyHarness();
check(whole.context.robinhoodSourceTime({read_at:null},{at:new Date(START).toISOString()},new Date(START).toISOString()),'unavailable',
  'An unknown Robinhood source time is not replaced by a fresh display time');
check(whole.context.robinhoodSourceTime({read_at:new Date(START).toISOString()},{at:null},new Date(START).toISOString()),'unavailable',
  'An unknown Fables source time is not replaced by a fresh display time');
result=await whole.load(snap);const fullTime=result.live_health.read_at;
check(result.chains.robinhood.total_usd,2122,'The actual assembly totals the complete wallet, LP, own Fables LP and own lock');
check(result.chains.robinhood.lp_positions.length,2,'Fables appears once beside the directly read V3 position');
check(result.live_health.warnings,[],'A full assembled reading clears all warning text');
check(whole.state(result).live,true,'A complete assembled recovery is eligible for LIVE');
check(whole.fallback(snap).lps.length,1,'Assembling Fables does not contaminate the independently retained V3 LP cache');

whole.advance(15000);whole.setMode('wallet-new-lp-failed');result=await whole.load(snap);
check(result.chains.robinhood.onchain_usd,2010,'The actual failed-Robinhood path retains the whole prior wallet');
check(result.chains.robinhood.total_usd,2122,'The actual failed-Robinhood path retains the whole chain value');
check(result.chains.robinhood.read_at,fullTime,'The chain exposes the retained Robinhood source time');
check(result.live_health.read_at,fullTime,'Portfolio freshness uses the retained Robinhood time');
check(result.live_health.warnings.length,1,'A Robinhood failure creates one warning rather than duplicate wallet and LP warnings');
ok(result.live_health.warnings[0].includes('Robinhood'),'The failed component is named');
check(whole.state(result).live,false,'The assembled fallback cannot claim LIVE even within ninety seconds');

whole.advance(15000);whole.setMode('complete');whole.setFablesMode('http-error');result=await whole.load(snap);
const fablesSourceTime=new Date(START+15000).toISOString();
check(result.chains.robinhood.total_usd,2122,'A Fables outage retains its prior values instead of the older saved snapshot');
check(result.live_health.read_at,fablesSourceTime,'A Fables outage preserves its own older source time at Portfolio level');
check(result.live_health.warnings.length,1,'An isolated Fables outage creates one warning');
ok(result.live_health.warnings[0].includes('Fables'),'Fables failure remains identified');
check(whole.state(result).live,false,'A Fables fallback cannot claim LIVE');

whole.advance(15000);whole.setMode('transport-failed');result=await whole.load(snap);
check(result.chains.robinhood.total_usd,2122,'Simultaneous failures preserve the entire last known Robinhood value');
check(result.live_health.read_at,fablesSourceTime,'Simultaneous failures retain the oldest component source time');
check(new Set(result.live_health.warnings).size,2,'Both failed components are reported exactly once');

whole.advance(15000);whole.setMode('complete');whole.setFablesMode('complete');result=await whole.load(snap);
check(result.chains.robinhood.total_usd,2122,'A complete assembly recovery restores all figures');
check(result.live_health.read_at,new Date(whole.now()).toISOString(),'Only complete new reads advance all retained source times');
check(result.live_health.warnings,[],'A complete assembly recovery clears previous warnings');
check(whole.state(result).live,true,'The complete assembly recovery restores LIVE eligibility');
whole.advance(15000);whole.setMode('empty');whole.setFablesMode('empty');result=await whole.load(snap);
check(result.chains.robinhood.total_usd,2010,'Verified closures remove prior V3 and Fables value without inventing a wallet change');
check(result.chains.robinhood.lp_positions.length+result.chains.robinhood.defi_positions.length,0,'All verified empty positions disappear');
check(result.live_health.warnings,[],'Verified empty positions do not imply an RPC failure');
check(JSON.stringify(snap),snapshotBefore,'The live assembly never rewrites the committed source snapshot');

const coldAssembly=assemblyHarness('transport-failed');coldAssembly.setFablesMode('http-error');result=await coldAssembly.load(snap);
check(result.chains.robinhood.total_usd,65,'A cold failure may use all genuine committed Robinhood component values');
check(result.live_health.read_at,snap.last_updated,'A cold assembled failure keeps the saved snapshot timestamp');
check(coldAssembly.state(result).live,false,'An assembled snapshot fallback cannot claim LIVE');

console.log('Portfolio Robinhood reader and recovery: '+checks+' assertions passed.');
