/* Closed RPC fixtures for the real read-only wallet/pool adapters. */
import assert from 'node:assert/strict';
import { CFG, VAULT } from '../api/_core.mjs';
import { readAgentWallets, readAgentPool, handleAgentObservation } from '../api/_agent-observation-reader.mjs';
let count=0;const check=(a,b,n)=>{assert.deepEqual(a,b,n);count++;};
const now=Date.now(),hex=n=>BigInt(n).toString(16).padStart(64,'0'),ok=n=>({ok:true,data:'0x'+hex(n)}),addr=a=>({ok:true,data:'0x'+a.slice(2).padStart(64,'0')});
const sym=s=>({ok:true,data:'0x'+hex(32)+hex(s.length)+Buffer.from(s).toString('hex').padEnd(64,'0')});
let failNative=false,failBalances=false,foreignFactory=false,old=false,calls=[];
const readRpc=async(url,method,params)=>{calls.push({url,method,params});
  if(method==='eth_blockNumber')return '0x64';
  if(method==='eth_getBlockByNumber')return {number:'0x64',timestamp:'0x'+Math.floor((now-(old?100000:0))/1000).toString(16)};
  throw Error('Unexpected RPC method');};
const rpc=async(url,method,params)=>method==='eth_getBalance'
  ?(calls.push({url,method,params}),failNative?Promise.reject(Error('Fixture native outage')):'0x'+(10n**18n).toString(16))
  :readRpc(url,method,params);
const multi=async(url,requests,block)=>{
  check(block,'0x64','Every balance, metadata and pool read uses the reported pinned block');
  return requests.map(({to,data})=>{
    if(data.startsWith('0x70a08231')){if(failBalances)return {ok:false,data:'0x'};return ok(0);}
    if(data==='0x313ce567'){
      const token=Object.values(VAULT.chains).flatMap(c=>c.tokens).find(t=>t.a===to);return ok(token?.d??18);
    }
    if(data==='0x95d89b41')return sym(VAULT.chains.robinhood.tokens.find(t=>t.a===to)?.s||'TOKEN');
    if(data.startsWith('0x07a2d13a')){check(to.length,42,'The configured avKAT contract has a full EVM address');return ok(12n*10n**17n);}
    const name=Object.entries(VAULT.pricePools).find(([,pool])=>pool===to)?.[0];
    if(name){const token=VAULT.chains.katana.tokens.find(t=>t.px===name),stable=VAULT.chains.katana.tokens[0],price={eth:3000,btc:100000,kat:.01}[name];
      if(data==='0x0dfe1681')return addr(stable.a);if(data==='0xd21220a7')return addr(token.a);
      if(data==='0x3850c7bd')return ok(BigInt(Math.floor(Math.sqrt(1/price*10**(token.d-stable.d))*2**96)));
    }
    if(data==='0xc45a0155')return addr(foreignFactory?'0x'+'9'.repeat(40):CFG.rhFactory);
    if(data==='0x3850c7bd'){const sqrt=BigInt(Math.floor(Math.sqrt(3000*1e-12)*2**96)),tick=Math.floor(Math.log(Number(sqrt)/2**96)*2/Math.log(1.0001));
      return {ok:true,data:'0x'+hex(sqrt)+hex(BigInt.asUintN(256,BigInt(tick)))};}
    if(data==='0x0dfe1681')return addr(VAULT.chains.robinhood.tokens[1].a);
    if(data==='0xd21220a7')return addr(VAULT.chains.robinhood.tokens[0].a);
    if(data==='0x1a686502')return ok(1000000);
    if(data==='0xd0c93a7c')return ok(10);
    if(data==='0xddca3f43')return ok(500);
    if(['0xf3058399','0x46141319'].includes(data))return ok(1n<<128n);
    throw Error('Unexpected ABI selector');
  });};
const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No real RPC in observation tests');};
try{
  let wallets=await readAgentWallets({chain:'katana',now,readRpc:rpc,readMulti:multi});
  check(wallets.status,'fresh','All configured wallet amounts can be observed without inference');
  check(new Set(wallets.balances.map(row=>row.owner)).size,2,'Both tracked EVM wallets are read automatically');
  check(wallets.balances.find(row=>row.symbol==='vbUSDC').raw,'0','A verified zero is kept as a real observation');
  check(wallets.balances.find(row=>row.symbol==='avKAT').priceUsd,.012,'avKAT uses its ERC4626 redemption reading and the current KAT quote');
  check(wallets.balances.find(row=>row.symbol==='ETH').priceUsd>2999,true,'Native ETH is valued from the verified reference pool');
  check(wallets.priceProof.length,3,'Each reference quote retains its token identities and raw sqrt price');
  check(calls.filter(call=>call.method==='eth_getBalance').every(call=>call.params[1]==='0x64'),true,'Native balances use the same pinned block');
  failNative=true;wallets=await readAgentWallets({chain:'arc',now,readRpc:rpc,readMulti:multi});
  check(wallets.balances.find(row=>row.symbol==='USDC').raw,null,'An Arc native failure cannot become a zero cash balance');
  check(wallets.status,'partial','Unsuccessful native reads keep coverage partial');failNative=false;
  failBalances=true;wallets=await readAgentWallets({chain:'katana',now,readRpc:rpc,readMulti:multi});
  check(wallets.balances.find(row=>row.symbol==='KAT').valueUsd,null,'A failed ERC20 amount never creates a dollar valuation');failBalances=false;
  const pool=await readAgentPool({chain:'robinhood',pool:'0x'+'1'.repeat(40),now,readRpc:rpc,readMulti:multi});
  check(pool.block,100,'Live market observations include their actual source block');
  check(Math.abs(pool.price-3000)<1e-6,true,'Different token decimals and orientation give a correct pool quote');
  check(pool.token0.symbol,'WETH','Metadata is decoded from the pinned ERC20 reading');
  check(pool.fee,500,'The actual pool fee tier is retained');
  check(pool.feeGrowth0,(1n<<128n).toString(),'Raw fee growth supports later fee-window observations');
  foreignFactory=true;await assert.rejects(()=>readAgentPool({chain:'robinhood',pool:'0x'+'1'.repeat(40),now,readRpc:rpc,readMulti:multi}));count++;foreignFactory=false;
  old=true;await assert.rejects(()=>readAgentWallets({chain:'katana',now,readRpc:rpc,readMulti:multi}));count++;old=false;
  const before=calls.length;await assert.rejects(()=>readAgentWallets({chain:'https://untrusted.invalid',now,readRpc:rpc,readMulti:multi}));count++;
  check(calls.length,before,'Caller URLs are rejected before any RPC');
  const decode58=value=>{let n=0n;for(const c of value)n=n*58n+BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));
    return Buffer.from(n.toString(16).padStart(64,'0'),'hex');};
  const bytes=Buffer.alloc(165);decode58('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').copy(bytes,0);
  decode58('GSMtKVYnxLbhfGQUBkdYW5npnu1LWP58ruBxVya5VM4B').copy(bytes,32);bytes.writeBigUInt64LE(1234567n,64);
  let foreignOwner=false;const solRpc=async(url,method,args)=>{
    check(url,'https://solana-rpc.publicnode.com','Solana observations use the fixed key-free RPC');
    if(method==='getBlockTime')return now/1000;
    check(method,'getMultipleAccounts','The owner wallet and existing USDC account are read together');
    check(args[0].length,2,'Only the two configured Solana accounts are read');
    const copy=Buffer.from(bytes);if(foreignOwner)copy[32]^=255;
    return {context:{slot:123},value:[{lamports:2000000000},{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:[copy.toString('base64'),'base64']}]};};
  const sol=await readAgentWallets({chain:'solana',now,readRpc:solRpc});
  check(sol.balances[1].raw,'1234567','Solana retains the verified native USDC integer amount');
  check(sol.balances[1].valueUsd,1.234567,'The SPL USDC amount uses its actual six decimals');
  check(sol.balances[0].valueUsd,null,'An unavailable SOL price cannot become a fabricated USD valuation');
  foreignOwner=true;await assert.rejects(()=>readAgentWallets({chain:'solana',now,readRpc:solRpc}));count++;
  let status,body,headers={};const res={setHeader:(k,v)=>headers[k]=v,status(n){status=n;return this;},end(v){body=JSON.parse(v);}};
  check(await handleAgentObservation({method:'GET',query:{view:'agent-wallet',chain:'katana'}},res,{readWallets:async()=>({ok:true})}),true,'The adapter reuses the existing public Strategy function');
  check(headers['cache-control'],'no-store','Fresh observation responses never use an edge stale-value cache');
  await handleAgentObservation({method:'POST',query:{view:'agent-wallet'}},res);check(status,405,'The observation view cannot mutate a wallet');
  await handleAgentObservation({method:'GET',query:{view:'agent-wallet',chain:'bad'}},res);check(status,400,'Invalid configured chains have a safe public error');
  check(JSON.stringify(body).includes('RPC'),false,'Raw provider errors and URLs stay private');
  console.log('Read-only automatic wallet and pool observations: '+count+' assertions passed.');
}finally{globalThis.fetch=originalFetch;}
