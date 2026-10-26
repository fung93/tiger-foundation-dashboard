/* Run the Portfolio's real Katana reader with controlled chain responses.
   Required subcall failures must reject, never silently report an empty LP list.
   Dollar amounts below are fixed test fixtures, not current portfolio holdings. */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const readerStart=source.indexOf('function getKatanaLive(');
const helperStart=source.indexOf('function katanaRead(');
assert.ok(readerStart>=0,'The Portfolio Katana reader must exist');
const reader=source.slice(helperStart>=0&&helperStart<readerStart?helperStart:readerStart,source.indexOf('/* ============ Robinhood Chain',readerStart));
const helpers=source.slice(source.indexOf('function pad(h)'),source.indexOf('function hexBytesLen'));
const address=n=>'0x'+n.toString(16).padStart(40,'0');
const word=value=>(typeof value==='string'?value.replace(/^0x/,''):BigInt(value)<0n?((1n<<256n)+BigInt(value)).toString(16):BigInt(value).toString(16)).padStart(64,'0');
const abi=(...values)=>'0x'+values.map(word).join('');
const good=data=>({ok:true,data});
const failed={ok:false,data:'0x'};
const ID=491037;
let checks=1;
const check=(actual,expected,note)=>{assert.equal(actual,expected,note);checks++;};

function harness(mode='complete') {
  const tokens={USDC:{a:address(1),d:6},USDT:{a:address(2),d:6},KAT:{a:address(3),d:18},WETH:{a:address(4),d:18},avKAT:{a:address(5),d:18},WBTC:{a:address(6),d:8}};
  const CFG={wallet:address(7),npm:address(8),lpStaker:address(9),vkatNft:address(10),votingEscrow:address(11),factory:address(12),poolKatUsdc:address(13),poolWethUsdc:address(14),poolWbtcUsdc:address(15),tokens,morphoMarkets:[],logWindow:10,transferTopic:'0xtransfer'};
  const pool=address(16),owned=mode.startsWith('owned-')||mode==='ownership-race',btc=mode==='btc-price-subcall-failed';
  const twoPositions=mode==='positions-tail-missing'||mode==='pool-tail-missing';
  const ctx={CFG,POSITIONS:{open:{}},UNTRACKED_LIVE:[],console:{warn(){}},BigInt,Math,Number,Promise,
    enc24:t=>word(t),v3Amounts:()=>btc?[100e8,0]:mode==='price-zero'?[0,100e18]:[100e6,0],poolPrice:()=>mode==='price-zero'?0:1,
    arcAccrued:()=>0n,arcInside:()=>0n,arcAmt:n=>String(n),noteUntracked(){},
    rpc:async(method)=>{
      if(method==='eth_getBalance')return'0x0';
      if(method==='eth_blockNumber')return'0x64';
      if(method==='eth_getLogs'){if(mode==='logs-failed')throw Error('forced logs failure');return[];}
      throw Error('Unexpected RPC method '+method);
    },
    multicall:async calls=>{
      if(mode==='owner-transport-failed'&&calls.some(c=>c.data.startsWith('0x6352211e')))throw Error('forced ownerOf transport failure');
      const result=calls.map(c=>{
        const selector=c.data.slice(0,10);
        if(selector==='0x70a08231'){
          if((mode==='wallet-token-failed'&&c.to===tokens.USDC.a)||(mode==='nft-count-failed'&&c.to===CFG.npm)||(mode==='vkat-count-failed'&&c.to===CFG.vkatNft))return failed;
          return good(abi(c.to===CFG.npm&&owned||c.to===CFG.vkatNft&&mode.startsWith('vkat-')?1:0));
        }
        if(selector==='0x07a2d13a')return good(abi(10n**18n));
        if(selector==='0x6352211e'){
          if(mode==='owner-subcall-failed')return failed;
          if(mode==='owner-malformed')return good('0x1234');
          return good(abi(mode==='transferred'||mode==='owned-transferred'?address(99):mode==='unstake-race'?CFG.wallet:CFG.lpStaker));
        }
        if(selector==='0x2f745c59')return mode==='owned-enumeration-failed'||mode==='vkat-enumeration-failed'&&c.to===CFG.vkatNft?failed:good(abi(ID));
        if(selector==='0xb45a3c0e')return mode==='vkat-locked-amount-failed'?failed:good(abi(100n*10n**18n));
        if(selector==='0x99fbab88'){
          if(mode==='positions-subcall-failed')return failed;
          if(mode==='positions-malformed')return good(abi(0));
          return good(abi(0,0,btc?tokens.WBTC.a:tokens.USDC.a,btc?tokens.USDC.a:tokens.KAT.a,3000,-100,100,mode==='closed'?0:10n**18n,0,0,0,0));
        }
        if(selector==='0x1698ee82')return mode==='pool-subcall-failed'?failed:good(abi(mode==='pool-zero'?address(0):pool));
        if(selector==='0x3850c7bd'){
          if((mode==='slot0-subcall-failed'&&c.to===pool)||(mode==='btc-price-subcall-failed'&&c.to===CFG.poolWbtcUsdc))return failed;
          if(mode==='slot0-malformed'&&c.to===pool)return good(abi(1n<<96n));
          return good(abi(mode==='slot0-zero'&&c.to===pool?0:1n<<96n,0));
        }
        if(selector==='0xf3058399')return mode==='owned-fees-subcall-failed'?failed:good(abi(0));
        if(selector==='0x46141319')return good(abi(0));
        if(selector==='0xf30dba93')return mode==='owned-ticks-subcall-failed'?failed:good(abi(0,0,0,0));
        throw Error('Unexpected selector '+selector);
      });
      if((mode==='positions-tail-missing'&&calls[0]?.data.startsWith('0x99fbab88'))||(mode==='pool-tail-missing'&&calls[0]?.data.startsWith('0x1698ee82')))return result.slice(0,-1);
      return result;
    }
  };
  vm.createContext(ctx);
  vm.runInContext(helpers+'\n'+reader+'\nthis.readKatana=getKatanaLive;',ctx);
  const read=()=>ctx.readKatana(twoPositions?[ID,ID+1]:mode==='ownership-race'||mode==='owned-transferred'||!owned?[ID]:[],[]);
  read.setMode=next=>{mode=next;};
  return read;
}

let result=await harness()();
check(result.lps.length,1,'A complete reading includes the staked LP');
check(result.lps[0].value_usd,100,'The complete reading includes the whole fixture value');
check(result.lps[0].staked,true,'The verified staked position retains its identity');
check(result.lps[0].token_id,String(ID),'The LP keeps its token id');

for(const mode of ['owner-subcall-failed','owner-transport-failed','owner-malformed','owned-enumeration-failed',
  'positions-subcall-failed','positions-malformed','pool-subcall-failed','pool-zero','slot0-subcall-failed',
  'slot0-malformed','slot0-zero','owned-fees-subcall-failed','owned-ticks-subcall-failed','btc-price-subcall-failed','price-zero',
  'wallet-token-failed','nft-count-failed','vkat-count-failed','vkat-enumeration-failed','vkat-locked-amount-failed',
  'positions-tail-missing','pool-tail-missing']) {
  await assert.rejects(harness(mode)(),mode+' must not resolve as an empty or under-valued successful read');
  checks++;
}
result=await harness('closed')();
check(result.lps.length,0,'A successfully read zero-liquidity position is removed');
result=await harness('transferred')();
check(result.lps.length,0,'A successful ownership read proving transfer removes the old staked LP');
result=await harness('logs-failed')();
check(result.lps.length,1,'A failed discovery sweep preserves a verified snapshot candidate');
check(result.lps[0].value_usd,100,'Discovery failure does not reduce a verified position value');
result=await harness('owned-complete')();
check(result.lps.length,1,'Wallet-held LPs remain counted');
check(result.lps[0].staked,false,'Wallet-held positions are not classified as staked');
result=await harness('vkat-complete')();
check(result.vkat.totalKat,100,'A complete vKAT lock reading preserves its locked value');
result=await harness('ownership-race')();
check(result.lps.length,1,'A token appearing in wallet and staked candidate lists is counted once');
check(result.lps[0].value_usd,100,'An ownership race cannot double the LP value');
result=await harness('unstake-race')();
check(result.lps.length,1,'A verified return to the wallet survives an earlier zero wallet NFT count');
check(result.lps[0].staked,false,'A verified returned position is classified as wallet held');
check(result.lps[0].value_usd,100,'A return-to-wallet race preserves the whole LP value');
result=await harness('owned-transferred')();
check(result.lps.length,0,'A verified transfer to someone else overrides an earlier wallet enumeration');
const recover=harness('positions-subcall-failed');
await assert.rejects(recover(),'The recovery fixture starts with an incomplete position reading');checks++;
recover.setMode('complete');
result=await recover();
check(result.lps[0].value_usd,100,'A complete recovery in the same reader context restores the whole value');
console.log('Portfolio Katana reader: '+checks+' assertions passed.');
