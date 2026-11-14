/* Real holdings endpoint with closed ABI fixtures. No vote/claim history read,
   external provider, wallet action or persistent state is allowed here. */
import assert from 'node:assert/strict';
import handler,{readVkatHoldings} from '../api/vkat.mjs';
import {CFG,keccakHex} from '../api/_core.mjs';
import {KATANA_ASSETS} from '../api/_katana-config.mjs';
import {VKAT_NFT,ESCROW,KAT,WALLETS} from '../vkat-core.mjs';
import {MORPHO} from '../morpho-core.mjs';
let checks=0,mode='complete';const check=(a,b,n)=>{assert.deepEqual(a,b,n);checks++;},seen=[],head=800000,ts=1794634265;
const word=n=>BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0'),abi=(...ns)=>'0x'+ns.map(word).join(''),
 sel=s=>'0x'+keccakHex(Buffer.from(s).toString('hex')).replace(/^0x/,'').slice(0,8),av=KATANA_ASSETS.avKAT.address;
function aggregate(results){let tail='',offsets='';for(const r of results){const bytes=r.data.slice(2);offsets+=word(results.length*32+tail.length/2);
 tail+=word(r.ok?1:0)+word(64)+word(bytes.length/2)+bytes.padEnd(Math.ceil(bytes.length/64)*64,'0');}return abi(32,results.length)+offsets+tail;}
function decode(data){const h=data.slice(10),at=n=>h.slice(n*2,n*2+64),count=Number(BigInt('0x'+at(32)));
 return Array.from({length:count},(_,i)=>{const from=64+Number(BigInt('0x'+at(64+i*32))),bytes=from+Number(BigInt('0x'+at(from+64))),length=Number(BigInt('0x'+at(bytes)));
  return {to:'0x'+at(from).slice(24),data:'0x'+h.slice((bytes+32)*2,(bytes+32+length)*2)};});}
function read(c,tag){const selector=c.data.slice(0,10);seen.push({...c,tag});let result;
 const fail=(name)=>mode===name?{ok:false,data:'0x'}:null;
 if(selector===sel('balanceOf(address)')){
  if(c.to===VKAT_NFT){if(fail('lock-count'))return fail('lock-count');result=1;}
  else if(c.to===av){if(fail('wallet'))return fail('wallet');result=(c.data.endsWith(WALLETS[0].slice(2))?10n:20n)*10n**18n;}
 }
 if(selector===sel('tokenOfOwnerByIndex(address,uint256)')){if(fail('lock-id'))return fail('lock-id');result=c.data.slice(10,74).endsWith(WALLETS[0].slice(2))?1:2;}
 if(selector===sel('locked(uint256)')){if(fail('lock-amount'))return fail('lock-amount');return {ok:true,data:abi(BigInt('0x'+c.data.slice(-64))*100n*10n**18n,ts-86400)};}
 if(selector===sel('votingPower(uint256)'))result=1n*10n**18n;
 if(selector===sel('position(bytes32,address)')){check(c.to,MORPHO,'Only the configured lending contract supplies collateral');if(fail('collateral'))return fail('collateral');return {ok:true,data:abi(0,0,25n*10n**18n)};}
 if(selector===sel('totalLocked()')){if(fail('network'))return fail('network');result=1_000_000n*10n**18n;}
 if(selector===sel('totalSupply()'))result=c.to===VKAT_NFT?1000:c.to===KAT?10_000_000_000n*10n**18n:10_000n*10n**18n;
 if(selector===sel('totalAssets()'))result=15_000n*10n**18n;
 if(selector===sel('convertToAssets(uint256)'))result=tag==='0x'+head.toString(16)?15n*10n**17n:14n*10n**17n;
 if(selector==='0x3850c7bd'){if(fail('price'))return fail('price');return {ok:true,data:abi(BigInt(Math.floor(Math.sqrt(1e12/.004)*2**96)),0)};}
 if(result===undefined)throw Error('Unexpected holdings call '+selector+' to '+c.to);return {ok:true,data:abi(result)};
}
const native=globalThis.fetch;
globalThis.fetch=async(url,options)=>{check(url,CFG.katRpc,'Holdings never require a Merkl/gauge/other-network request');const q=JSON.parse(options.body);let result;
 if(q.method==='eth_blockNumber')result='0x'+head.toString(16);
 else if(q.method==='eth_getBlockByNumber')result={timestamp:'0x'+ts.toString(16)};
 else if(q.method==='eth_call'){const [c,tag]=q.params;result=c.to===CFG.multicall?aggregate(decode(c.data).map(c=>read(c,tag))):read(c,tag).data;}
 else throw Error('Unexpected holdings RPC '+q.method);return Response.json({jsonrpc:'2.0',id:q.id,result});};
try{
 let v=await readVkatHoldings();
 check(v.holdings.vkat.amount,300,'vKAT sums verified wallet-held locks from both wallets');
 check(v.holdings.avkat.wallet_amount,30,'avKAT includes both wallet balances');
 check(v.holdings.avkat.collateral_amount,100,'All configured avKAT lending collateral is included once');
 check(v.holdings.avkat.amount,130,'Personal avKAT is wallet plus collateral, not a net debt value');
 check(v.holdings.avkat.kat_equivalent,195,'avKAT uses the conversion ratio at the pinned block');
 check(Math.abs(v.holdings.vkat.value_usd-1.2)<1e-10,true,'vKAT has the verified KAT dollar quote');
 check(v.head_ts,ts,'The reading retains the actual block time');
 check(seen.filter(c=>c.to===MORPHO||c.to===ESCROW&&c.data.startsWith(sel('locked(uint256)'))).every(c=>c.tag==='0x'+head.toString(16)),true,'Collateral and personal locks share the pinned block');
 check(v.book,undefined,'Personal holdings do not expose a voting/reward book');
 for(mode of ['lock-count','lock-id','lock-amount','wallet','collateral','network','price']){
  await assert.rejects(readVkatHoldings(),mode+' cannot silently zero or understate holdings');checks++;
 }
 mode='complete';v=await readVkatHoldings();check(v.holdings.avkat.amount,130,'A full reading recovers after source failures');
 const response={headers:{},status(n){this.code=n;return this;},setHeader(k,v){this.headers[k]=v;},end(body){this.body=JSON.parse(body);}};
 await handler({query:{view:'holdings'},headers:{}},response);check(response.code,200,'The simplified route needs no saved vote ledger');
 mode='collateral';await handler({query:{view:'holdings'},headers:{}},response);
 check(response.code,502,'Incomplete holdings cannot be published as success');check(response.headers['cache-control'],'no-store','A failed holdings reading cannot be cached as fresh');
}finally{globalThis.fetch=native;}
console.log('Personal vKAT/avKAT holdings: '+checks+' assertions passed.');
