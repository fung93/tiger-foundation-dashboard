/* Public, read-only first-party adapters for the configured dashboard wallets.
   Fixed RPCs, fixed ABI methods, pinned blocks; no caller-provided URL or wallet. */
import { Buffer } from 'node:buffer';
import { CFG, VAULT, rpc, multi, pad } from './_core.mjs';
import {readLiquidityEvidence} from './_agent-liquidity-reader.mjs';

export const OBSERVATION_CHAINS = ['katana', 'robinhood', 'arc', 'solana'];
const AVKAT = '0x7231dbacdfc968e07656d12389ab20de82fbfceb';
const EXTRA = {
  katana: [{ s: 'avKAT', a: AVKAT, d: 18, px: 'avkat' }],
  robinhood: [{ s: 'FABLES', a: '0xb63d07cef74be747231d601bb2faa6b252c68106', d: 18, px: null }],
  arc: [{ s: 'ARGUS', a: '0xece5ca8bf9220718e5727754026757512212cb3c', d: 18, px: null },
    { s: 'Minara', a: '0xa163d7624da3b5d9182c50eab5b8cd247ae861bb', d: 18, px: null }],
};
const FACTORIES = { katana: CFG.factory, robinhood: CFG.rhFactory, arc: '0xf0db7b58379503491d857db50ac9ece64c653918' };
const SOL = { rpc: 'https://solana-rpc.publicnode.com', owner: 'GSMtKVYnxLbhfGQUBkdYW5npnu1LWP58ruBxVya5VM4B',
  usdc: 'ED4qHSWBm2qUauEez1DejEzShkwEKA8a66aZdtFPjMpS', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
const uint = value => typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value) ? BigInt(value) : null;
const word = (row, index = 0) => row?.ok && /^0x[0-9a-f]+$/i.test(row.data || '') && row.data.length >= 66 + index * 64
  ? uint('0x' + row.data.slice(2 + index * 64, 66 + index * 64)) : null;
const address = row => word(row) === null ? null : '0x' + row.data.slice(26, 66).toLowerCase();
const fresh = (ts, now) => Number.isFinite(ts) && now - ts >= -30000 && now - ts < 90000;
async function head(rpcUrl, readRpc, now) {
  const raw = uint(await readRpc(rpcUrl, 'eth_blockNumber', []));
  if (raw === null || raw > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Invalid block');
  const tag = '0x' + raw.toString(16), block = await readRpc(rpcUrl, 'eth_getBlockByNumber', [tag, false]), ts = uint(block?.timestamp);
  if (uint(block?.number) !== raw || ts === null || !fresh(Number(ts) * 1000, now)) throw Error('Old block');
  return { tag, block: Number(raw), observedAt: new Date(Number(ts) * 1000).toISOString() };
}
async function referencePrices(readRpc, readMulti, now, pinned) {
  const at = pinned || await head(CFG.katRpc, readRpc, now), prices = { usd: 1 }, proof = [];
  const stable = VAULT.chains.katana.tokens.find(t => t.s === 'vbUSDC');
  const names = Object.keys(VAULT.pricePools);
  const rows = await readMulti(CFG.katRpc, names.flatMap(name => ['0x3850c7bd','0x0dfe1681','0xd21220a7'].map(data => ({ to: VAULT.pricePools[name], data }))), at.tag);
  for (const [i, name] of names.entries()) {
    const token = VAULT.chains.katana.tokens.find(t => t.px === name), sqrt = word(rows[i * 3]);
    const t0 = address(rows[i * 3 + 1]), t1 = address(rows[i * 3 + 2]);
    if (!sqrt || sqrt >= 1n << 160n || !token || ![t0,t1].includes(token.a) || ![t0,t1].includes(stable.a)) continue;
    const direct = t0 === token.a, price = (Number(sqrt) / 2 ** 96) ** 2 * 10 ** (direct ? token.d - stable.d : stable.d - token.d);
    const usd = direct ? price : 1 / price;
    if (Number.isFinite(usd) && usd > 0 && usd < 1e12) { prices[name] = usd;
      proof.push({ name, pool: VAULT.pricePools[name], sqrtPriceX96: sqrt.toString(), token0: t0, token1: t1, ...at }); }
  }
  return { prices, proof, ...at };
}
function b58(value) {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n = 0n;
  for (const ch of value) { const v = chars.indexOf(ch); if (v < 0) throw Error(); n = n * 58n + BigInt(v); }
  const hex = n.toString(16).padStart(64, '0');if (hex.length !== 64) throw Error();return Buffer.from(hex, 'hex');
}
async function solWallet(readRpc, now) {
  const sample = await readRpc(SOL.rpc, 'getMultipleAccounts', [[SOL.owner,SOL.usdc], { encoding: 'base64', commitment: 'confirmed' }]);
  const slot = sample?.context?.slot;
  if (!Number.isSafeInteger(slot) || !Array.isArray(sample.value) || sample.value.length !== 2) throw Error();
  const ts = await readRpc(SOL.rpc, 'getBlockTime', [slot]);if (!Number.isFinite(ts) || !fresh(ts * 1000, now)) throw Error();
  const stamp = new Date(ts * 1000).toISOString(), rows = [];
  const native = sample.value[0];
  if (native !== null && (!Number.isSafeInteger(native?.lamports) || native.lamports < 0)) throw Error();
  rows.push({ owner: SOL.owner, chain: 'solana', symbol: 'SOL', address: null, raw: String(native?.lamports || 0), decimals: 9,
    amount: (native?.lamports || 0) / 1e9, priceUsd: null, valueUsd: null, block: slot, observedAt: stamp, status: 'observed' });
  const account = sample.value[1];let raw = 0n;
  if (account !== null) {
    if (account?.owner !== SOL.program || account.data?.[1] !== 'base64') throw Error();
    const bytes = Buffer.from(account.data[0], 'base64');
    if (bytes.length < 165 || !bytes.subarray(0,32).equals(b58(SOL.mint)) || !bytes.subarray(32,64).equals(b58(SOL.owner))) throw Error();
    raw = bytes.readBigUInt64LE(64);
  }
  rows.push({ owner: SOL.owner, chain: 'solana', symbol: 'USDC', address: SOL.mint, raw: raw.toString(), decimals: 6,
    amount: Number(raw) / 1e6, priceUsd: 1, valueUsd: Number(raw) / 1e6, block: slot, observedAt: stamp, status: 'observed' });
  return { schemaVersion: 'agent-wallet-observation-v1', chain: 'solana', block: slot, observedAt: stamp, status: 'fresh', balances: rows,
    coverage: 'Configured SOL wallet and USDC account; SOL USD valuation and other SPL tokens are not supplied.' };
}
export async function readAgentWallets({ chain, now = Date.now(), readRpc = rpc, readMulti = multi } = {}) {
  if (!OBSERVATION_CHAINS.includes(chain)) throw Object.assign(Error(), { status: 400 });
  if (chain === 'solana') return solWallet(readRpc, now);
  const cfg = VAULT.chains[chain], at = await head(cfg.rpc, readRpc, now), tokens = [...cfg.tokens,...EXTRA[chain]];
  let quoted = { prices: { usd: 1 }, proof: [] };
  try { quoted = await referencePrices(readRpc, readMulti, now, chain === 'katana' ? at : null); } catch {}
  if (chain === 'katana') try {
    const rows = await readMulti(cfg.rpc, [{to:AVKAT,data:'0x07a2d13a'+pad('de0b6b3a7640000')}], at.tag), units = word(rows[0]);
    if (units !== null && quoted.prices.kat > 0) quoted.prices.avkat = Number(units) / 1e18 * quoted.prices.kat;
  } catch {}
  const settled = await Promise.allSettled(CFG.wallets.map(async wallet => {
    const owner = wallet.address.toLowerCase(), [native, values] = await Promise.allSettled([
      readRpc(cfg.rpc,'eth_getBalance',[owner,at.tag]),
      readMulti(cfg.rpc,tokens.flatMap(token=>[{to:token.a,data:'0x70a08231'+pad(owner)},{to:token.a,data:'0x313ce567'}]),at.tag),
    ]);
    const rows = [{ token: cfg.native, raw: native.status === 'fulfilled' ? uint(native.value) : null }];
    for (const [index,token] of tokens.entries()) rows.push({token,raw:values.status === 'fulfilled' && word(values.value[index*2+1]) === BigInt(token.d)
      ? word(values.value[index*2]) : null});
    return rows.map(({token,raw})=>{
      const amount = raw === null ? null : Number(raw)/10**token.d, price = quoted.prices[token.px] ?? null;
      return {owner,chain,symbol:token.s,address:token.a||null,raw:raw?.toString()??null,decimals:token.d,amount,
        priceUsd:price,valueUsd:amount===0?0:amount===null||price===null?null:amount*price,block:at.block,observedAt:at.observedAt,status:raw===null?'unavailable':'observed'};
    });
  }));
  const balances = settled.flatMap((result,index)=>result.status==='fulfilled'?result.value:[{owner:CFG.wallets[index].address,chain,status:'unavailable'}]);
  return {schemaVersion:'agent-wallet-observation-v1',chain,...at,status:balances.every(row=>row.status==='observed')?'fresh':'partial',balances,
    priceProof:quoted.proof,coverage:'Configured native/ERC20 holdings only; USD stablecoins use the stated $1 anchor. Locks and DeFi are separate.'};
}
const symbol = row => {
  if (!row?.ok || typeof row.data !== 'string') return null;
  try { const offset=Number(word(row)),length=Number(word(row,offset/32));
    if (!Number.isInteger(offset)||offset%32||length<1||length>40) return null;
    return Buffer.from(row.data.slice(2+offset*2+64,2+offset*2+64+length*2),'hex').toString('utf8').replace(/[^\w./+-]/g,'').slice(0,24)||null;
  } catch { return null; }
};
export async function readAgentPool({chain,pool,now=Date.now(),readRpc=rpc,readMulti=multi,withLiquidity=false}={}) {
  if (!Object.hasOwn(FACTORIES,chain)||!/^0x[0-9a-f]{40}$/i.test(pool||'')) throw Object.assign(Error(),{status:400});
  const cfg=VAULT.chains[chain],at=await head(cfg.rpc,readRpc,now),selectors=['0xc45a0155','0x3850c7bd','0x1a686502','0x0dfe1681','0xd21220a7','0xd0c93a7c','0xddca3f43','0xf3058399','0x46141319'];
  const rows=await readMulti(cfg.rpc,selectors.map(data=>({to:pool,data})),at.tag);
  if (address(rows[0])!==FACTORIES[chain].toLowerCase()) throw Error('Unverified pool factory');
  const sqrt=word(rows[1]),encodedTick=word(rows[1],1),liquidity=word(rows[2]),spacing=word(rows[5]),fee=word(rows[6]);
  const tick=encodedTick===null?null:Number(BigInt.asIntN(256,encodedTick)),addresses=[address(rows[3]),address(rows[4])];
  if (!sqrt||sqrt>=1n<<160n||!Number.isInteger(tick)||Math.abs(tick)>887272||liquidity===null||!spacing||spacing>32767n||fee===null||fee>1000000n||addresses.some(a=>!a)) throw Error();
  const metadata=await readMulti(cfg.rpc,addresses.flatMap(to=>['0x95d89b41','0x313ce567'].map(data=>({to,data}))),at.tag);
  const tokens=addresses.map((address,index)=>({address,symbol:symbol(metadata[index*2]),decimals:Number(word(metadata[index*2+1])??-1n)}));
  if (tokens.some(t=>!t.symbol||t.decimals<0||t.decimals>36)) throw Error();
  let prices={usd:1};try{prices=(await referencePrices(readRpc,readMulti,now,chain==='katana'?at:null)).prices;}catch{}
  const known=[...VAULT.chains[chain].tokens,...EXTRA[chain]];
  for(const token of tokens){const hit=known.find(t=>t.a===token.address&&t.d===token.decimals);token.usd=hit?prices[hit.px]??null:null;}
  if (chain==='arc') for(const token of tokens)if(token.address==='0x3600000000000000000000000000000000000000'&&token.decimals===18)token.usd=1;
  const stable=index=>tokens[index].usd===1&&([...VAULT.chains[chain].tokens].some(t=>t.a===tokens[index].address&&t.px==='usd')
    ||chain==='arc'&&tokens[index].address==='0x3600000000000000000000000000000000000000');
  const baseIndex=stable(1)?0:stable(0)?1:0,ratio=(Number(sqrt)/2**96)**2*10**(tokens[0].decimals-tokens[1].decimals);
  if(!Number.isFinite(ratio)||ratio<=0)throw Error();
  if(tokens[1].usd!==null)tokens[0].usd=ratio*tokens[1].usd;else if(tokens[0].usd!==null)tokens[1].usd=tokens[0].usd/ratio;
  const market={schemaVersion:'agent-pool-observation-v1',chain,pool:pool.toLowerCase(),...at,status:'fresh',kind:'fees',tick,sqrtPrice:Number(sqrt)/2**96,
    sqrtPriceX96:sqrt.toString(),tickSpacing:Number(spacing),fee:Number(fee),activeLiquidity:Number(liquidity),activeLiquidityRaw:liquidity.toString(),token0:tokens[0],token1:tokens[1],baseIndex,
    base:tokens[baseIndex].symbol,quote:tokens[1-baseIndex].symbol,quoteUsd:tokens[1-baseIndex].usd,price:baseIndex===0?ratio:1/ratio,
    feeGrowth0:word(rows[7])?.toString()??null,feeGrowth1:word(rows[8])?.toString()??null,
    factory:FACTORIES[chain],accounting:{valuationBlockPinned:true,projectedRewardsAreAssumptions:true},recent:{}};
  if(withLiquidity)market.liquidityEvidence=await readLiquidityEvidence(market,{readMulti});return market;
}
export async function handleAgentObservation(req,res,{readWallets=readAgentWallets,readPool=readAgentPool}={}) {
  const query=req.query||Object.fromEntries(new URL(req.url||'/','https://dashboard.invalid').searchParams);
  if(!['agent-wallet','agent-pool','agent-liquidity'].includes(query.view))return false;
  res.setHeader('cache-control','no-store');
  if(req.method&&req.method!=='GET'){res.status(405).end(JSON.stringify({error:'Use GET.'}));return true;}
  try{res.status(200).end(JSON.stringify(await(query.view==='agent-wallet'?readWallets({chain:query.chain}):readPool({chain:query.chain,pool:query.pool,withLiquidity:query.view==='agent-liquidity'}))));}
  catch(error){res.status(error.status===400?400:502).end(JSON.stringify({error:error.status===400?'Choose a configured chain and pool.':'The current observation could not be verified.'}));}
  return true;
}
