/* Actual browser Solana reader: raw account balances and transient RPC recovery. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../index.html',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const between=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const code=between('function solRpc(','/* decode one Meteora')+'\n'+between('function solanaWalletAccounts(','function getMerklLive(');
const CFG={solWallet:'GSMtKVYnxLbhfGQUBkdYW5npnu1LWP58ruBxVya5VM4B',usdcMint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',usdcAta:'ED4qHSWBm2qUauEez1DejEzShkwEKA8a66aZdtFPjMpS',solRpcs:['public-rpc'],solTimeout:6000};
const raw=Buffer.from('xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHlXnBLUJRhlMDbLkc/nVfcqw+7+M98iVQaUHHi0XZIyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','base64');
const token=bytes=>({owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:[Buffer.from(bytes).toString('base64'),'base64']});
let now=100000,fail=false,price=102,calls=[];
let result={context:{slot:123},value:[{lamports:890880},token(raw)]};
class Clock extends Date{static now(){return now;}}
const context=vm.createContext({CFG,Date:Clock,solIdx:0,SOL_DEAD:{},atob:s=>Buffer.from(s,'base64').toString('binary'),console,
  fT:async(url,options)=>{
    if(url.includes('coingecko'))return {ok:true,json:async()=>({solana:{usd:price}})};
    calls.push(JSON.parse(options.body));
    return {ok:!fail,status:fail?403:200,json:async()=>({result})};
  },meteoraPosition:async()=>null});
vm.runInContext(code,context);
let checks=0;
const eq=(a,b,note)=>{assert.deepEqual(a,b,note);checks++;};
const rejects=async(fn,note)=>{await assert.rejects(fn,note);checks++;};
let reading=await context.getSolanaLive([],CFG.usdcAta);
eq(reading.sol,0.00089088,'Native SOL is read from the wallet account lamports');
eq(reading.usdc,0,'The recorded empty USDC account has zero tokens');
eq(reading.solPrice,102,'The price remains separate from the account amount');
eq(reading.lps.length,0,'An empty LP reference list remains empty');
eq(calls[0].method,'getMultipleAccounts','Use the free raw-account request, never the blocked balance request');
eq(JSON.parse(JSON.stringify(calls[0].params[0])),[CFG.solWallet,CFG.usdcAta],'Both accounts are read in one batch');
eq(calls[0].params[1].commitment,'confirmed','An absent account is accepted only from a successful confirmed read');
const funded=Buffer.from(raw);funded.writeBigUInt64LE(12345678n,64);
result={value:[{lamports:1000000000},token(funded)]};
reading=await context.getSolanaLive([],CFG.usdcAta);
eq(reading.sol,1,'A funded wallet is converted from lamports exactly');
eq(reading.usdc,12.345678,'USDC uses its raw u64 amount and six decimals');
result={value:[null,null]};
reading=await context.getSolanaLive([],CFG.usdcAta);
eq(reading.sol,0,'A confirmed absent wallet is zero');
eq(reading.usdc,0,'A confirmed closed token account is zero');
for(const invalid of [null,{}, {value:[]},{value:[{lamports:-1},null]},{value:[{lamports:NaN},null]},
  {value:[{lamports:1},{...token(raw),owner:'wrong-program'}]},
  {value:[{lamports:1},token(raw.subarray(0,80))]}]){
  assert.throws(()=>context.solanaWalletAccounts(invalid),'Unknown or malformed accounts cannot become zero balances');checks++;
}
for(const offset of [0,32]){
  const changed=Buffer.from(raw);changed[offset]^=1;
  assert.throws(()=>context.solanaWalletAccounts({value:[{lamports:1},token(changed)]}),'Wrong mint or wallet is rejected');checks++;
}
result={value:[{lamports:890880},token(raw)]};
price=0;await rejects(()=>context.getSolanaLive([],CFG.usdcAta),'An unavailable price cannot produce a complete zero-valued result');price=102;
fail=true;await rejects(()=>context.getSolanaLive([],CFG.usdcAta),'A provider HTTP failure is visible');
const attempts=calls.length;
await rejects(()=>context.getSolanaLive([],CFG.usdcAta),'The endpoint has a bounded cooldown');
eq(calls.length,attempts,'Cooldown avoids hammering the failed provider');
now+=10001;fail=false;
reading=await context.getSolanaLive([],CFG.usdcAta);
eq(reading.sol,0.00089088,'The same page recovers after the cooldown');
eq(context.SOL_DEAD['public-rpc'],undefined,'A successful read clears the failure marker');
eq(calls.every(c=>c.method==='getMultipleAccounts'),true,'No path falls back to the blocked indexed request');
console.log('Portfolio Solana reader: '+checks+' assertions passed.');
