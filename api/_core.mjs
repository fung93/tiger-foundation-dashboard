/* ============================================================================
   api/_core — the chain reading and the LP book, shared.

   Three callers use this and none of them should hold a private copy:
     - api/lp.mjs       the home-screen widget's live numbers
     - api/lpbook.mjs   the LP book page, ledger plus live view
     - scripts/lpbook.mjs  the 6-hourly Action that keeps the ledger on disk

   The leading underscore keeps Vercel from serving this file as an endpoint of
   its own; it is bundled into the two that import it.

   Zero dependencies, like the rest of this repo.
   ========================================================================== */

import '../rpc-reader.js';
import { attributedAprBaseline, prepareBookRewards, registerKatanaRollovers, anchorRewardRollovers } from './_reward-attribution.mjs';
export { attributeMerklRewards, prepareBookRewards, REWARD_ATTRIBUTION_VERSION } from './_reward-attribution.mjs';

export const CFG = {
  katRpc: 'https://rpc.katanarpc.com',
  arcRpc: 'https://rpc.mainnet.arc.io',
  rhRpc: 'https://rpc.mainnet.chain.robinhood.com',
  /* Every wallet the LP book follows. Add one here and both chains are scanned for it;
     a label, if given, is what the page shows instead of the shortened address. */
  wallets: [
    { address: '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1', label: '' },
    { address: '0x4da1d0d5f7b123364d7580f19b716de2ed4e9770', label: '' },
  ],
  multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
  npm: '0x2659C6085D26144117D904C46B48B6d180393d27',
  factory: '0x203e8740894c8955cB8950759876d7E7E45E04c1',
  arcV4State: '0x6e43e7be27a11956218d6882ecc0cc1bed63e31f',
  arcV4Posm: '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b',
  lpStaker: '0xbe12e1b5c4859a3d141412748279b67458f729e9',   /* holds staked Sushi position NFTs */
  rhNpm: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  rhFactory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  stakedChunk: 1000,
  stakedChunks: 6,
  stakedLookback: 250000,   /* about three days of Katana blocks */
  walletTail: 25,           /* how far up the owner's token list a new NFT could sit */
  merklApi: 'https://api.merkl.xyz/v4',
};
/* the first wallet, for the parts of the dashboard that have only ever known one */
CFG.wallet = CFG.wallets[0].address;

/* Every Uniswap-v3-shaped deployment the wallets use. Adding a chain is adding a row:
   leaving Robinhood out of this list is what let a live WETH/USDG position sit on the
   dashboard and never once reach the widget.

     archive    whether the node still answers for old blocks
     yield      what a position here earns him: 'merkl' where staked positions hand their
                trading fees to the Katana DAO and are paid in Merkl KAT instead, 'fees'
                where the trading fees come straight to the wallet
     logSpan    the widest log query the node will take for the ledger's own sweeps
     refPools   pools kept only to price a token no open position happens to hold */
export const V3 = [
  {
    key: 'katana', protocol: 'SushiSwap V3', archive: true, yield: 'merkl', merklChain: 747474,
    rpc: CFG.katRpc, npm: CFG.npm, factory: CFG.factory, staker: CFG.lpStaker,
    open: (pos) => pos.open || {},
    closed: (pos) => pos.closed || [],
    mintLookback: 2000000, logSpan: 200000,
    refPools: ['0x10045367e619caae6f60cc80046c43c6cd55f629'],   /* KAT/USDC, to price Merkl KAT */
    /* Merkl's distributor: emits Claimed(user, token, amount) for every claim */
    distributor: '0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae',
  },
  {
    key: 'robinhood', protocol: 'Uniswap V3', archive: false, yield: 'fees', merklChain: null,
    rpc: CFG.rhRpc, npm: CFG.rhNpm, factory: CFG.rhFactory, staker: null,
    open: (pos) => (pos.robinhood || {}).open || {},
    closed: (pos) => (pos.robinhood || {}).closed || [],
    /* this node refuses anything over 100,000 blocks — under three hours of its blocks */
    mintLookback: 600000, logSpan: 100000,
    refPools: [],
  },
];
export const chainOf = (key) => V3.find((c) => c.key === key);

/* ---------- abi plumbing ---------- */
const MOD256 = 1n << 256n;
export const pad = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
export const w = (hex, i) => hex.substr(2 + i * 64, 64);
export const toBig = (word) => BigInt('0x' + word);
export const toSigned = (word) => { const v = toBig(word); return v > (1n << 255n) ? v - MOD256 : v; };
export const toAddr = (word) => '0x' + word.slice(24);
export const enc24 = (t) => pad(BigInt.asUintN(256, BigInt(t)).toString(16));
export const lc = (s) => String(s).toLowerCase();
export const hx = (n) => '0x' + Number(n).toString(16);
const robinhoodRpc = globalThis.TigerRpc.create();

export async function rpc(url, method, params) {
  if (url === CFG.rhRpc) return robinhoodRpc(url, method, params, CFG.patient
    ? { maxAttempts: 7, totalTimeoutMs: 120000, retryMaxMs: 20000 } : undefined);
  /* The public nodes drop a connection now and then; a figure that fails because of one
     reset socket is a figure nobody trusts, so every call gets a few attempts. */
  /* A node that says "too many requests" is waited out rather than retried at once: patiently
     by the six-hourly job (CFG.patient — it reads every swap of a busy pool, and Robinhood's
     node rate-limits hard), briefly by a page request, which must answer in seconds. */
  let last;
  const tries = CFG.patient ? 7 : 3;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error('RPC HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      if (!Object.prototype.hasOwnProperty.call(j, 'result')) throw new Error('JSON-RPC result is missing');
      return j.result;
    } catch (e) {
      last = e;
      const limited = /too many|rate.?limit|429/i.test(String((e && e.message) || e));
      const wait = limited && CFG.patient ? Math.min(20000, 1000 * 2 ** i) : 250 * (i + 1);
      if (i + 1 < tries) await new Promise((s) => setTimeout(s, wait));
    }
  }
  throw last;
}

function encodeAgg3(calls) {
  const head = '0x82ad56cb' + pad('20') + pad(calls.length.toString(16));
  let offsets = '', tails = '';
  const base = calls.length * 32;
  for (const c of calls) {
    offsets += pad((base + tails.length / 2).toString(16));
    const data = c.data.replace(/^0x/, '');
    tails += pad(c.to) + pad('01') + pad('60') + pad((data.length / 2).toString(16))
      + data + '0'.repeat((64 - (data.length % 64)) % 64);
  }
  return head + offsets + tails;
}
function decodeAgg3(hex, expected) {
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(hex) || hex.length < 130)
    throw new Error('Malformed multicall response');
  const h = hex.replace(/^0x/, '');
  const W = (i) => h.substr(i * 64, 64);
  const n = parseInt(W(1), 16);
  if (parseInt(W(0), 16) !== 32 || !Number.isSafeInteger(n) || n !== expected || h.length < (2 + n) * 64)
    throw new Error('Incomplete multicall response');
  const out = [];
  for (let i = 0; i < n; i++) {
    const offset = parseInt(W(2 + i), 16);
    if (!Number.isSafeInteger(offset) || offset % 32 || offset < n * 32) throw new Error('Malformed multicall offset');
    const el = offset / 32 + 2;
    const flag = parseInt(W(el), 16), dataOffset = parseInt(W(el + 1), 16);
    if ((flag !== 0 && flag !== 1) || !Number.isSafeInteger(dataOffset) || dataOffset < 64 || dataOffset % 32)
      throw new Error('Malformed multicall tuple');
    const ok = flag === 1;
    const dOff = dataOffset / 32 + el;
    const dLen = parseInt(W(dOff), 16);
    if (!Number.isSafeInteger(dLen) || dLen < 0 || (dOff + 1) * 64 + dLen * 2 > h.length)
      throw new Error('Truncated multicall data');
    out.push({ ok, data: '0x' + h.substr((dOff + 1) * 64, dLen * 2) });
  }
  return out;
}
export const multi = async (url, calls, tag = 'latest') =>
  calls.length ? decodeAgg3(await rpc(url, 'eth_call', [{ to: CFG.multicall, data: encodeAgg3(calls) }, tag]), calls.length) : [];

function requiredRead(result, words, label) {
  if (!result || !result.ok || typeof result.data !== 'string' || !/^0x[0-9a-f]*$/i.test(result.data)
    || result.data.length < 2 + words * 64 || (result.data.length - 2) % 2)
    throw new Error('Could not read ' + label);
  return result.data;
}

/* ---------- uniswap v3 maths ---------- */
export function v3Amounts(L, lo, hi, sqrtPX96) {
  const sp = Number(sqrtPX96) / 2 ** 96;
  const sa = Math.pow(1.0001, lo / 2), sb = Math.pow(1.0001, hi / 2);
  const Lf = Number(L);
  if (sp <= sa) return [Lf * (1 / sa - 1 / sb), 0];
  if (sp >= sb) return [0, Lf * (sb - sa)];
  return [Lf * (1 / sp - 1 / sb), Lf * (sp - sa)];
}
export const poolPrice = (sqrtPX96, d0, d1) => {
  const sp = Number(sqrtPX96) / 2 ** 96;
  return sp * sp * Math.pow(10, d0 - d1);
};
const tickPrice = (t, d0, d1) => Math.pow(1.0001, t) * Math.pow(10, d0 - d1);
const accrued = (liq, now, last) => (((now - last) % MOD256 + MOD256) % MOD256) * liq / (1n << 128n);
function v3Inside(tick, lo, hi, global, outLo, outHi) {
  const below = tick >= lo ? outLo : global - outLo;
  const above = tick < hi ? outHi : global - outHi;
  return ((global - below - above) % MOD256 + MOD256) % MOD256;
}

/* ---------- presentation ---------- */
export const money = (n, dp = 2) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US',
  { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const signed = (n) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* a price is quoted with as many decimals as it needs to be legible at any scale */
const price = (n) => n >= 1000 ? money(n, 0) : n >= 1 ? money(n, 2) : n >= 0.01 ? money(n, 4) : money(n, 8);
const pct = (n, dp = 2) => n.toFixed(dp) + '%';
export const r2 = (n) => Math.round(n * 100) / 100;
export const shortAddr = (a) => a.slice(0, 6) + '…' + a.slice(-4);
export function walletLabel(addr) {
  const hit = CFG.wallets.find((x) => lc(x.address) === lc(addr || ''));
  return hit && hit.label ? hit.label : addr ? shortAddr(addr) : '';
}

/* Where the price sits inside the band, as a percentage of the band's width.
   Measured on a log scale because that is the scale ticks are spaced on. */
function bandPosition(now, lower, upper) {
  if (!(upper > lower) || !(now > 0)) return null;
  const p = Math.log(now / lower) / Math.log(upper / lower) * 100;
  return Math.round(p * 10) / 10;
}

/* ---------- which positions are open, right now ----------
   For the widget, which has no ledger of its own beyond positions.json. Three sources,
   cheapest first: the ledger; the NFTs each wallet holds, which catches an unstaked
   position the moment it is minted; and Transfer logs for a position handed to a staker,
   because a staked NFT leaves the wallet and no enumeration can see it.

   Returns id -> the wallet it belongs to. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO32 = '0x' + '0'.repeat(64);

export async function v3Candidates(ch, pos, ledgerOpen, stakedSeed, opts = {}) {
  const owner = new Map();
  const first = CFG.wallets[0].address;
  /* positions.json only ever knew the first wallet, so its ids are seeds only when that
     wallet is among the ones being looked for */
  if (!opts.wallets || opts.wallets.some((a) => lc(a) === lc(first))) {
    Object.keys(ledgerOpen || {}).forEach((id) => owner.set(String(id), first));
    (stakedSeed || []).forEach((id) => owner.set(String(id), first));
  }
  const closed = new Set((ch.closed(pos) || []).map((c) => String(c.id)));

  const wallets = opts.wallets || CFG.wallets.map((x) => x.address);
  const held = wallets.map(async (address) => {
    const balance = await rpc(ch.rpc, 'eth_call', [{ to: ch.npm, data: '0x70a08231' + pad(address) }, 'latest']);
    const bal = Number(toBig(w(requiredRead({ ok: true, data: balance }, 1, ch.key + ' NFT count'), 0)));
    if (!Number.isSafeInteger(bal) || bal > 10000) throw new Error('Invalid NFT count');
    if (!bal) return [];
    /* Only the tail of the list can hold something new. ERC721Enumerable appends a token it
       receives at the owner's last index, and closing a V3 position burns its liquidity
       rather than the NFT, so nothing is removed to shuffle it away. A baseline wants the
       whole list instead, since it has no earlier record to lean on. */
    const from = opts.wholeList ? 0 : Math.max(0, bal - CFG.walletTail);
    const out = [];
    for (let k = from; k < bal; k += 60) {
      const batch = [];
      for (let j = k; j < Math.min(bal, k + 60); j++)
        batch.push({ to: ch.npm, data: '0x2f745c59' + pad(address) + pad(j.toString(16)) });
      const r = await multi(ch.rpc, batch);
      r.forEach((x) => { out.push([String(toBig(w(requiredRead(x, 1, ch.key + ' NFT enumeration'), 0))), address]); });
    }
    return out;
  });

  const staked = (async () => {
    if (!ch.staker) return [];
    const head = Number(toBig((await rpc(ch.rpc, 'eth_blockNumber', [])).slice(2)));
    const span = opts.stakedLookback || CFG.stakedLookback;
    const logs = async (from, to) => rpc(ch.rpc, 'eth_getLogs', [{
      address: ch.npm, fromBlock: hx(from), toBlock: hx(to),
      topics: [TRANSFER, wallets.map((x) => '0x' + pad(x)), '0x' + pad(ch.staker)],
    }]);
    /* The node's thousand-block limit is on the size of the answer, not the width of the
       question. Naming the contract and every topic keeps the answer to a handful of logs,
       and that is accepted across weeks of blocks. */
    let out;
    try {
      out = await logs(Math.max(0, head - span), head);
    } catch {
      const windows = [];
      for (let to = head; windows.length < CFG.stakedChunks; to -= CFG.stakedChunk)
        windows.push([to - CFG.stakedChunk + 1, to]);
      out = (await Promise.all(windows.map(([a, b]) => logs(a, b).catch(() => [])))).flat();
    }
    return (out || []).map((l) => [String(toBig(l.topics[3].slice(2))), toAddr(l.topics[1].slice(2))]);
  })();

  for (const list of await Promise.all(held)) for (const [id, wa] of list) owner.set(id, wa);
  for (const [id, wa] of await staked) owner.set(id, wa);
  for (const id of closed) owner.delete(id);
  return owner;
}

/* What a token is, asked of the token. A hard-coded list is why a WETH/USDG position on
   Robinhood was dropped without a word: the pair was real and the chain was reachable, and
   the code simply had no entry for USDG. */
const STABLE = /^(vb)?(USDC|USDT|USDG|DAI|USDe|FRAX)$/i;
export async function tokenMeta(ch, addrs) {
  const list = [...new Set(addrs.map(lc))];
  const out = {};
  if (!list.length) return out;
  const r = await multi(ch.rpc, list.flatMap((a) => [
    { to: a, data: '0x95d89b41' },   /* symbol() */
    { to: a, data: '0x313ce567' },   /* decimals() */
  ]));
  list.forEach((a, i) => {
    let sym = a.slice(0, 8);
    try {
      const h = r[i * 2].data;
      const off = Number(toBig(w(h, 0))) / 32;
      const len = Number(toBig(w(h, off)));
      sym = Buffer.from(h.slice(2 + (off + 1) * 64, 2 + (off + 1) * 64 + len * 2), 'hex').toString() || sym;
    } catch { /* a token with no readable symbol still gets decimals and a short name */ }
    const d = Number(toBig(w(requiredRead(r[i * 2 + 1], 1, ch.key + ' token decimals'), 0)));
    if (!Number.isInteger(d) || d < 0 || d > 255) throw new Error('Invalid token decimals');
    out[a] = { s: sym, d: d, stable: STABLE.test(sym), a: a };
  });
  return out;
}

/* What a position cost, taken from its own mint.

   A mint records the liquidity it created and the two amounts it took, and those three
   numbers fix the price it happened at:

     inside the band   a1 = L(sp - sa)      ->  sp = a1/L + sa
                       a0 = L(1/sp - 1/sb)  ->  sp = 1/(a0/L + 1/sb)

   Both sides must give the same answer, which is the check that it was minted in range
   and that the numbers are being read correctly. */
const INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const COLLECT = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

/* the price a liquidity change happened at, from its own numbers — or null where it was
   one-sided, since amounts taken out of range only bound the price, they do not fix it */
export function solveSqrt(L, r0, r1, lo, hi) {
  if (!(L > 0n)) return null;
  const sa = Math.pow(1.0001, lo / 2), sb = Math.pow(1.0001, hi / 2), Lf = Number(L);
  const q = r1 > 0n ? Number(r1) / Lf + sa : null;
  const b = r0 > 0n ? 1 / (Number(r0) / Lf + 1 / sb) : null;
  if (q === null || b === null) return null;
  return Math.abs(q / b - 1) <= 0.01 ? (q + b) / 2 : null;
}

async function mintEntry(ch, p, T0, T1) {
  try {
    const head = Number(toBig((await rpc(ch.rpc, 'eth_blockNumber', [])).slice(2)));
    const topics = [INCREASE, '0x' + pad(BigInt(p.id).toString(16))];
    let logs = [];
    try {
      logs = await rpc(ch.rpc, 'eth_getLogs', [{ address: ch.npm, topics,
        fromBlock: hx(Math.max(0, head - ch.mintLookback)), toBlock: hx(head) }]);
    } catch {
      for (let to = head; to > head - ch.mintLookback && !logs.length; to -= Math.min(ch.logSpan, 100000)) {
        const from = Math.max(0, to - Math.min(ch.logSpan, 100000) + 1);
        try {
          logs = await rpc(ch.rpc, 'eth_getLogs', [{ address: ch.npm, topics, fromBlock: hx(from), toBlock: hx(to) }]);
        } catch { /* a window the node refuses costs reach, not the read */ }
      }
    }
    if (!logs.length) return null;

    let L = 0n, r0 = 0n, r1 = 0n, block = 0;
    for (const l of logs) {
      L += toBig(w(l.data, 0)); r0 += toBig(w(l.data, 1)); r1 += toBig(w(l.data, 2));
      block = Math.max(block, Number(toBig(l.blockNumber.slice(2))));
    }
    if (L === 0n) return null;

    const sa = Math.pow(1.0001, p.lo / 2), sb = Math.pow(1.0001, p.hi / 2), Lf = Number(L);
    const fromQuote = r1 > 0n ? Number(r1) / Lf + sa : null;
    const fromBase = r0 > 0n ? 1 / (Number(r0) / Lf + 1 / sb) : null;
    let sp;
    if (fromQuote !== null && fromBase !== null) {
      if (Math.abs(fromQuote / fromBase - 1) > 0.01) return null;
      sp = (fromQuote + fromBase) / 2;
    } else sp = fromQuote !== null ? fromQuote : fromBase;
    if (!(sp > 0)) return null;

    const px = sp * sp * Math.pow(10, T0.d - T1.d);
    const a0 = Number(r0) / 10 ** T0.d, a1 = Number(r1) / 10 ** T1.d;
    const usd = T1.stable ? a0 * px + a1 : T0.stable ? a1 / px + a0 : null;
    if (usd === null) return null;
    return { sqrt: BigInt(Math.round(sp * 2 ** 96)), usd: usd, single: logs.length === 1, block: block };
  } catch { return null; }
}

/* ---------- any uniswap-v3-shaped pool, on any of the chains ----------
   `candidates` is an array of ids, or a Map of id -> owning wallet. */
export async function v3Rows(ch, ledgerOpen, candidates, opts = {}) {
  const open = ledgerOpen || {};
  const walletOf = candidates instanceof Map ? candidates : null;
  const ids = walletOf ? [...walletOf.keys()] : (candidates || Object.keys(open));
  if (!ids.length) return [];
  /* positions() for the band and the liquidity, and ownerOf to settle whether it is staked.
     A staked Sushi position's trading fees are collected by the Katana DAO. */
  const posRes = await multi(ch.rpc, ids.flatMap((id) => {
    const h = pad(BigInt(id).toString(16));
    return [{ to: ch.npm, data: '0x99fbab88' + h }, { to: ch.npm, data: '0x6352211e' + h }];
  }));

  const live = [];
  ids.forEach((id, k) => {
    const res = posRes[k * 2];
    const own = posRes[k * 2 + 1];
    const ownerData = own && own.ok ? requiredRead(own, 1, ch.key + ' #' + id + ' owner') : null;
    const ownerNow = ownerData ? lc(toAddr(w(ownerData, 0))) : '';
    if (ownerNow === '0x' + '0'.repeat(40)) throw new Error('Position ownership is unavailable');
    const expectedOwner = (walletOf && walletOf.get(String(id))) || (open[id] && open[id].wallet);
    if (expectedOwner && ownerNow && ownerNow !== lc(expectedOwner) && ownerNow !== lc(ch.staker || '')) return;
    const d = requiredRead(res, 12, ch.key + ' #' + id + ' position');
    const liq = toBig(w(d, 7)), owed0 = toBig(w(d, 10)), owed1 = toBig(w(d, 11));
    if (liq === 0n && owed0 === 0n && owed1 === 0n) return;   /* closed */
    requiredRead(own, 1, ch.key + ' #' + id + ' owner');
    live.push({
      id: String(id), ledger: open[id],
      staked: !!(ch.staker && ownerNow === lc(ch.staker)),
      wallet: (walletOf && walletOf.get(String(id))) || (ownerNow && ownerNow !== lc(ch.staker || '') ? ownerNow : CFG.wallet),
      token0: lc(toAddr(w(d, 2))), token1: lc(toAddr(w(d, 3))), fee: Number(toBig(w(d, 4))),
      lo: Number(toSigned(w(d, 5))), hi: Number(toSigned(w(d, 6))),
      liq, last0: toBig(w(d, 8)), last1: toBig(w(d, 9)), owed0, owed1,
    });
  });
  if (!live.length) return [];

  const [poolRes, meta] = await Promise.all([
    multi(ch.rpc, live.map((p) => ({
      to: ch.factory, data: '0x1698ee82' + pad(p.token0) + pad(p.token1) + pad(p.fee.toString(16)),
    }))),
    tokenMeta(ch, live.flatMap((p) => [p.token0, p.token1])),
  ]);
  live.forEach((p, i) => {
    p.pool = lc(toAddr(w(requiredRead(poolRes[i], 1, ch.key + ' #' + p.id + ' pool'), 0)));
    if (p.pool === '0x' + '0'.repeat(40)) throw new Error('Position pool is unavailable');
  });

  const slotRes = await multi(ch.rpc, live.flatMap((p) => p.pool ? [
    { to: p.pool, data: '0x3850c7bd' },                      /* slot0 */
    { to: p.pool, data: '0xf3058399' },                      /* feeGrowthGlobal0 */
    { to: p.pool, data: '0x46141319' },                      /* feeGrowthGlobal1 */
    { to: p.pool, data: '0xf30dba93' + enc24(p.lo) },        /* ticks(lower) */
    { to: p.pool, data: '0xf30dba93' + enc24(p.hi) },        /* ticks(upper) */
  ] : []));

  /* The entry price: from archive state where the ledger says when it opened, otherwise
     from the mint's own numbers. The book keeps its own costs and does not need either. */
  const entry = opts.noEntry ? live.map(() => null) : await Promise.all(live.map(async (p) => {
    const T0 = meta[p.token0], T1 = meta[p.token1];
    if (ch.archive && p.pool && p.ledger && p.ledger.opened_block) {
      try {
        const d = await rpc(ch.rpc, 'eth_call', [{ to: p.pool, data: '0x3850c7bd' }, hx(p.ledger.opened_block)]);
        return { sqrt: toBig(w(d, 0)) };
      } catch { /* fall through to the mint */ }
    }
    return (T0 && T1) ? await mintEntry(ch, p, T0, T1) : null;
  }));

  const out = [];
  live.forEach((p, j) => {
    const i = j * 5;
    requiredRead(slotRes[i], 2, ch.key + ' #' + p.id + ' pool price');
    const T0 = meta[p.token0], T1 = meta[p.token1];
    if (!T0 || !T1) throw new Error('Position token metadata is unavailable');

    const sqrtP = toBig(w(slotRes[i].data, 0));
    if (sqrtP <= 0n) throw new Error('Pool price is unavailable');
    const tick = Number(toSigned(w(slotRes[i].data, 1)));
    const [a0, a1] = v3Amounts(p.liq, p.lo, p.hi, sqrtP);

    /* fees already owed, plus everything earned since the position was last touched */
    let f0 = p.owed0, f1 = p.owed1;
    for (const offset of [1, 2, 3, 4]) requiredRead(slotRes[i + offset], offset < 3 ? 1 : 4, ch.key + ' #' + p.id + ' fee growth');
    {
      f0 += accrued(p.liq, v3Inside(tick, p.lo, p.hi, toBig(w(slotRes[i + 1].data, 0)),
        toBig(w(slotRes[i + 3].data, 2)), toBig(w(slotRes[i + 4].data, 2))), p.last0);
      f1 += accrued(p.liq, v3Inside(tick, p.lo, p.hi, toBig(w(slotRes[i + 2].data, 0)),
        toBig(w(slotRes[i + 3].data, 3)), toBig(w(slotRes[i + 4].data, 3))), p.last1);
    }

    const L = p.ledger || {};
    const row = shape({
      chain: ch.key, id: p.id, protocol: ch.protocol, wallet: p.wallet,
      pending: !p.ledger && !(entry[j] && entry[j].usd),
      staked: p.staked, feesMine: !p.staked,
      T0, T1, lo: p.lo, hi: p.hi, sqrtP, sqrtEntry: entry[j] && entry[j].sqrt, liq: p.liq,
      a0: a0 / 10 ** T0.d, a1: a1 / 10 ** T1.d,
      fee0: Number(f0) / 10 ** T0.d, fee1: Number(f1) / 10 ** T1.d,
      inUsd: L.open_value_usd !== undefined ? L.open_value_usd : (entry[j] && entry[j].usd),
      withdrawn: L.withdrawn_usd || 0, topup: L.topup_usd || 0,
      openedTs: L.opened_ts, opened: L.opened,
    });
    /* what the book needs that a widget does not: the raw position, keyed for pricing */
    row.raw = {
      pool: p.pool, token0: p.token0, token1: p.token1, fee: p.fee, lo: p.lo, hi: p.hi,
      liq: p.liq.toString(), sqrt: sqrtP.toString(),
      t0: { s: T0.s, d: T0.d, stable: T0.stable, a: p.token0 },
      t1: { s: T1.s, d: T1.d, stable: T1.stable, a: p.token1 },
      fee0: Number(f0) / 10 ** T0.d, fee1: Number(f1) / 10 ** T1.d,
    };
    out.push(row);
  });
  return out;
}

/* ---------- arc: uniswap v4 ----------
   V4 keeps no position data on the NFT, so the pool id and the band come from the ledger
   the Action builds; StateView answers for the rest. */
export async function arcRows(open) {
  const rows = Object.values(open || {}).filter((o) => o.kind === 'v4' && o.pool_id);
  if (!rows.length) return [];
  const res = await multi(CFG.arcRpc, rows.flatMap((p) => {
    const id = pad(BigInt(p.id).toString(16)), pid = p.pool_id.slice(2);
    return [
      { to: CFG.arcV4State, data: '0xc815641c' + pid },
      { to: CFG.arcV4State, data: '0x53e9c1fb' + pid + enc24(p.lo) + enc24(p.hi) },
      { to: CFG.arcV4State, data: '0xdacf1d2f' + pid + pad(CFG.arcV4Posm) + enc24(p.lo) + enc24(p.hi) + id },
    ];
  }));

  const entry = await Promise.all(rows.map(async (p) => {
    if (!p.opened_block) return null;
    try {
      const d = await rpc(CFG.arcRpc, 'eth_call', [{ to: CFG.arcV4State, data: '0xc815641c' + p.pool_id.slice(2) },
        hx(p.opened_block)]);
      return toBig(w(d, 0));
    } catch { return null; }
  }));

  const out = [];
  rows.forEach((p, j) => {
    const b = j * 3;
    if (!res[b] || !res[b].ok || !res[b + 2] || !res[b + 2].ok) return;
    const liq = toBig(w(res[b + 2].data, 0));
    if (liq === 0n) return;
    const sqrtP = toBig(w(res[b].data, 0));
    const [a0, a1] = v3Amounts(liq, p.lo, p.hi, sqrtP);
    let f0 = 0n, f1 = 0n;
    if (res[b + 1] && res[b + 1].ok) {
      f0 = accrued(liq, toBig(w(res[b + 1].data, 0)), toBig(w(res[b + 2].data, 1)));
      f1 = accrued(liq, toBig(w(res[b + 1].data, 1)), toBig(w(res[b + 2].data, 2)));
    }
    const isStable = (s) => /^(USDC|USDT|USDG|vbUSDC|vbUSDT)$/.test(s);
    out.push(shape({
      chain: 'arc', id: String(p.id), protocol: 'Uniswap V4', staked: !!p.staked, feesMine: true,
      wallet: CFG.wallet,
      T0: { s: p.s0, d: p.d0, stable: isStable(p.s0) },
      T1: { s: p.s1, d: p.d1, stable: isStable(p.s1) },
      lo: p.lo, hi: p.hi, sqrtP, sqrtEntry: entry[j], liq,
      a0: a0 / 10 ** p.d0, a1: a1 / 10 ** p.d1,
      fee0: Number(f0) / 10 ** p.d0, fee1: Number(f1) / 10 ** p.d1,
      inUsd: p.in_usd, withdrawn: p.out_usd || 0, topup: 0,
      openedTs: p.opened_ts, opened: p.opened,
    }));
  });
  return out;
}

/* ---------- one position, shaped for a widget ---------- */
function shape(p) {
  const T0 = p.T0, T1 = p.T1;
  /* The band is quoted in the stable leg, the way a human reads a chart: dollars per BTC,
     not BTC per dollar. When the stable is token0 the pool's own price is upside down. */
  const invert = !!T0.stable && !T1.stable;
  const px = poolPrice(p.sqrtP, T0.d, T1.d);
  const raw = [tickPrice(p.lo, T0.d, T1.d), tickPrice(p.hi, T0.d, T1.d)];
  const now = invert ? 1 / px : px;
  const lower = invert ? 1 / raw[1] : raw[0];
  const upper = invert ? 1 / raw[0] : raw[1];
  const base = invert ? T1.s : T0.s, quote = invert ? T0.s : T1.s;

  const priced = !!(T0.stable || T1.stable);
  const usd = (x0, x1) => (T1.stable ? x0 * px + x1 : x1 / px + x0);
  const liq = priced ? usd(p.a0, p.a1) : null;
  const fees = priced ? usd(p.fee0, p.fee1) : null;
  /* Uncollected fees are part of what the position is worth only when they are his. */
  const value = liq === null ? null : liq + (p.feesMine ? fees : 0);

  const status = now < lower ? (invert ? 'above' : 'below')
    : now > upper ? (invert ? 'below' : 'above') : 'in';
  const inRange = status === 'in';

  /* What the money would be worth had it never been put in a pool, valued at today's price.
     Only honest if the liquidity has not changed since the mint, which is checked rather
     than assumed: priced at the entry price the reconstructed amounts must come back to
     what went in. */
  let market = null, il = null, hodl = null, entryValue = null, exact = false;
  if (priced && value !== null && p.sqrtEntry) {
    const pxEntry = poolPrice(p.sqrtEntry, T0.d, T1.d);
    const e = v3Amounts(p.liq, p.lo, p.hi, p.sqrtEntry);
    const i0 = e[0] / 10 ** T0.d, i1 = e[1] / 10 ** T1.d;
    entryValue = T1.stable ? i0 * pxEntry + i1 : i1 / pxEntry + i0;
    const capital = p.inUsd === undefined || p.inUsd === null ? entryValue : p.inUsd;
    exact = Math.abs(p.topup) < 0.005 && capital > 0
      && Math.abs(entryValue - capital) / capital < 0.01;
    if (exact) {
      hodl = T1.stable ? i0 * px + i1 : i1 / px + i0;
      market = hodl - capital;
      il = liq - hodl;
    }
  }

  const withdrawn = p.withdrawn || 0;
  const tradePnl = priced && liq !== null && p.inUsd ? liq - p.inUsd : null;
  const feeYield = p.feesMine ? (fees || 0) + withdrawn : 0;
  const heldDays = p.openedTs ? (Date.now() / 1000 - p.openedTs) / 86400 : null;
  const amounts = {};
  amounts[base] = invert ? p.a1 : p.a0;
  amounts[quote] = invert ? p.a0 : p.a1;

  return {
    chain: p.chain, id: p.id, pair: base + ' / ' + quote, protocol: p.protocol,
    wallet: p.wallet || null,
    staked: p.staked, pending: !!p.pending, in_range: inRange, range_status: status,
    opened: p.opened || null, held_days: heldDays === null ? null : r2(heldDays),
    range: {
      lower: lower, upper: upper, now: now, quote: quote,
      position_pct: bandPosition(now, lower, upper),
      width_pct: r2((upper / lower - 1) * 100),
      to_lower_pct: r2((now / lower - 1) * 100),
      to_upper_pct: r2((upper / now - 1) * 100),
    },
    amounts: amounts,
    value_usd: value === null ? null : r2(value),
    liquidity_usd: liq === null ? null : r2(liq),
    open_value_usd: p.inUsd === undefined || p.inUsd === null ? null : r2(p.inUsd),
    withdrawn_usd: r2(withdrawn),
    entry_checked_usd: entryValue === null ? null : r2(entryValue),
    il_exact: exact,
    fees_usd: fees === null ? null : r2(fees),
    fees_mine: p.feesMine,
    market_usd: market === null ? null : r2(market),
    il_usd: il === null ? null : r2(il),
    hodl_usd: hodl === null ? null : r2(hodl),
    pnl_usd: tradePnl === null ? null : r2(tradePnl),
    fee_yield_usd: r2(feeYield),
  };
}

/* ---------- merkl ----------
   SUSHI campaigns pay staked liquidity; Aragon bribes pay the vKAT vote. Only the first is
   an LP's earnings, and each reason names the position it paid for:
     SUSHI_SWAP_<pool>_<tokenId>~..._SushiStaker_...
   Earned rather than outstanding: claiming moves `amount` into `claimed` and must not make
   a position's yield fall. Every wallet is asked, and the answers merged. */
export async function merklLp() {
  let total = 0, lp = 0, failed = false;
  const byId = {}, tokensById = {}, claimedById = {}, walletById = {}, tokenPrice = {};
  for (const { address } of CFG.wallets) {
    for (const ch of V3.filter((c) => c.merklChain)) {
      try {
        const response = await fetch(CFG.merklApi + '/users/' + address + '/rewards?chainId=' + ch.merklChain,
          { signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw new Error('Rewards HTTP ' + response.status);
        const arr = await response.json();
        if (!Array.isArray(arr)) throw new Error('Invalid rewards response');
        for (const chain of arr || []) {
          for (const rw of chain.rewards || []) {
            const dec = (rw.token && rw.token.decimals) !== undefined ? rw.token.decimals : 18;
            const px = (rw.token && rw.token.price) || 0;
            const sym = (rw.token && rw.token.symbol) || '?';
            const key = sym + '@' + ch.key;
            if (px) tokenPrice[key] = px;
            const un = BigInt(rw.amount || '0') - BigInt(rw.claimed || '0') + BigInt(rw.pending || '0');
            if (un > 0n) total += Number(un) / 10 ** dec * px;
            for (const br of rw.breakdowns || []) {
              const reason = String(br.reason || '');
              if (!reason.startsWith('SUSHI')) continue;
              const b = BigInt(br.amount || '0') - BigInt(br.claimed || '0') + BigInt(br.pending || '0');
              if (b > 0n) lp += Number(b) / 10 ** dec * px;
              const earned = BigInt(br.amount || '0') + BigInt(br.pending || '0');
              const m = reason.match(/^SUSHI_SWAP_0x[0-9a-fA-F]{40}_(\d+)~/);
              if (!m || earned <= 0n) continue;
              const amt = Number(earned) / 10 ** dec;
              byId[m[1]] = r2((byId[m[1]] || 0) + amt * px);
              const t = tokensById[m[1]] || (tokensById[m[1]] = {});
              t[key] = (t[key] || 0) + amt;
              const c = claimedById[m[1]] || (claimedById[m[1]] = {});
              c[key] = (c[key] || 0) + Number(BigInt(br.claimed || '0')) / 10 ** dec;
              walletById[m[1]] = lc(address);
            }
          }
        }
      } catch { failed = true; }
    }
  }
  const result = { total_usd: r2(total), lp_usd: r2(lp), earned_by_id: byId, earned_tokens_by_id: tokensById,
    claimed_tokens_by_id: claimedById, wallet_by_id: walletById,
    token_price: tokenPrice, error: failed || undefined };
  return result;
}

/* ---------- the widget's own view ---------- */
export function widgetView(pos, merkl) {
  if (!pos) return null;
  const R = pos.range;
  /* What the position paid out: its own trading fees where he holds it, or the Merkl
     rewards earned against this very NFT where it is staked and the DAO takes the fees. */
  const earned = (merkl && merkl.earned_by_id) || {};
  /* a P&L borrowed from the LP book runs from when the book began, and so must the yield
     beside it, or the net would add two different periods together */
  const mine = pos.yield_override_usd !== undefined ? pos.yield_override_usd
    : pos.fees_mine ? (pos.fee_yield_usd || 0) : (earned[pos.id] || 0);
  const known = pos.pnl_usd !== null;
  const net = (pos.pnl_usd || 0) + mine;
  const edge = Math.min(R.to_lower_pct, R.to_upper_pct);
  return {
    pair: pos.pair,
    id: '#' + pos.id,
    chain: pos.chain,
    wallet: walletLabel(pos.wallet),
    status: pos.in_range ? 'in range' : 'out of range',
    in_range: pos.in_range,
    price: price(R.now),
    lower: price(R.lower),
    upper: price(R.upper),
    position_pct: R.position_pct === null ? 50 : Math.max(0, Math.min(100, R.position_pct)),
    edges: pct(R.to_lower_pct) + ' · ' + pct(R.to_upper_pct) + ' to the edges',
    nearest_edge: pct(edge),
    width: pct(R.width_pct, 1) + ' wide',
    value: pos.value_usd === null ? '--' : money(pos.value_usd),
    yield_label: pos.fees_mine ? 'Fees' : 'Rewards',
    yield_value: money(mine),
    fees_to_dao: pos.fees_mine ? null : money(pos.fees_usd || 0),
    pnl: known ? signed(pos.pnl_usd) : '--',
    pnl_up: known ? pos.pnl_usd >= 0 : true,
    il: pos.il_usd === null ? '--' : signed(pos.il_usd),
    net: known ? signed(net) : '--',
    net_up: known ? net >= 0 : true,
    pending: !!pos.pending,
    held: pos.held_days === null ? '' : pos.held_days.toFixed(1) + 'd',
  };
}

/* ============================================================================
   The LP book.

   Everything here is measured from the moment tracking started. At that moment every
   open position was photographed — token amounts, prices, uncollected fees, Merkl earned —
   and that photograph is its cost. A position opened later costs what its mint took.

   From then on the book is driven by the chain's own events, a window at a time:
     a mint to any tracked wallet          a new position
     IncreaseLiquidity                     money in, priced at the price it happened at
     DecreaseLiquidity                     money out, likewise; at zero, the position closed
     Collect                               fees, once the principal sitting in it is netted
   so nothing depends on a snapshot having been taken at the right moment.

   Fees are kept as token amounts and never as dollars. Dollars are put on them at the last
   moment, at live prices, except in a closed position's history row, which is frozen at
   the prices of the block it closed in.
   ========================================================================== */
/* 2: tracking starts at each chain's current positions' own mint, not at a photograph.
   3: (withdrawn) Katana's fees as the wallet's whole Merkl claimable balance.
   4: Katana's fees are each position's own Merkl KAT again, from its own mint — Alex,
      2026-10-19: "only track the claimable from that particular LP position".
   5: the book's own fee total (top card, fee curve, chain rows) is KAT actually claimed
      from Merkl since tracking began plus Robinhood's fees; the live cards keep each
      position's own rewards. Records every Merkl claim from the start block on.
   6: each point on the fee curve also carries the book's PnL at that moment, so the page
      can draw Net (fees + PnL) beside the fees.
   7: each position keeps how long it has been in range, read off its pool's swaps.
   8: each position keeps its own dated claims (Merkl KAT on Katana, fee collections on
      Robinhood) at the price of their moment; the book is shown as a live page (open
      positions) and an all-time page (closed positions, every figure fixed).
   9: Fables ranges (Uniswap V4 hook shares) on Robinhood are positions too. */
export const BOOK_VERSION = 9;
const CLAIMED = '0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683';
const isMerkl = (chain) => chainOf(chain).yield === 'merkl';
const tkey = (sym, chain) => sym + '@' + chain;
const sumInto = (into, from, sign = 1) => {
  for (const k of Object.keys(from || {})) into[k] = (into[k] || 0) + sign * from[k];
  return into;
};
const big0 = (s) => BigInt(s || '0');

/* the price at the end of a block: archive state where the node keeps it, otherwise the
   last swap at or before it — a pool's price only ever changes on a swap */
export async function sqrtAt(ch, pool, block) {
  if (ch.archive) {
    try {
      return Number(toBig(w(await rpc(ch.rpc, 'eth_call', [{ to: pool, data: '0x3850c7bd' }, hx(block)]), 0))) / 2 ** 96;
    } catch { /* fall back to the swaps */ }
  }
  const span = Math.min(ch.logSpan, 100000);
  for (const back of [2000, 20000, span]) {
    try {
      const logs = await rpc(ch.rpc, 'eth_getLogs', [{ address: pool, topics: [SWAP],
        fromBlock: hx(Math.max(0, block - back + 1)), toBlock: hx(block) }]);
      if (logs.length) return Number(toBig(w(logs[logs.length - 1].data, 2))) / 2 ** 96;
    } catch { /* try a narrower or wider window */ }
  }
  for (let to = block - span, n = 0; n < 6 && to > 0; n++, to -= span) {
    try {
      const logs = await rpc(ch.rpc, 'eth_getLogs', [{ address: pool, topics: [SWAP],
        fromBlock: hx(Math.max(0, to - span + 1)), toBlock: hx(to) }]);
      if (logs.length) return Number(toBig(w(logs[logs.length - 1].data, 2))) / 2 ** 96;
    } catch { /* keep going back */ }
  }
  return null;
}

/* each leg's live dollar price for a row from v3Rows, keyed the way the book keys tokens */
export function rowPrices(row) {
  const R = row && row.raw;
  if (!R) return {};
  return legPrices({ t0: tkey(R.t0.s, row.chain), t1: tkey(R.t1.s, row.chain), d0: R.t0.d, d1: R.t1.d,
    stable0: R.t0.stable, stable1: R.t1.stable }, Number(BigInt(R.sqrt)) / 2 ** 96);
}

/* each leg's dollar price, from the pool's own price */
function legPrices(P, sp) {
  const px = sp * sp * Math.pow(10, P.d0 - P.d1);     /* token1 per token0 */
  if (P.stable0 && P.stable1) return { [P.t0]: 1, [P.t1]: 1 };
  if (P.stable1) return { [P.t0]: px, [P.t1]: 1 };
  if (P.stable0) return { [P.t0]: 1, [P.t1]: 1 / px };
  return {};
}

/* raw amounts of a position's two tokens in dollars, at the price the change itself fixes
   where it can, and at the pool's price for that block where it cannot */
async function valueRaw(ch, P, L, r0, r1, block) {
  const x0 = Number(r0) / 10 ** P.d0, x1 = Number(r1) / 10 ** P.d1;
  if (P.stable0 && P.stable1) return { usd: x0 + x1, sp: null };
  let sp = solveSqrt(L, r0, r1, P.lo, P.hi);
  if (!sp) {
    /* one-sided: a stable leg on its own needs no price at all */
    if (P.stable1 && x0 === 0) return { usd: x1, sp: null };
    if (P.stable0 && x1 === 0) return { usd: x0, sp: null };
    sp = await sqrtAt(ch, P.pool, block);
    if (!sp) return { usd: null, sp: null };
  }
  const p = legPrices(P, sp);
  if (p[P.t0] === undefined) return { usd: null, sp };
  return { usd: x0 * p[P.t0] + x1 * p[P.t1], sp };
}

/* A token's price source: the pool it is quoted in against a stable coin. Positions
   register their own pools; refPools cover a token no position holds, like Merkl KAT. */
function registerToken(book, chain, meta, pool, other) {
  const k = tkey(meta.s, chain);
  if (book.tokens[k] && book.tokens[k].pool) return k;
  book.tokens[k] = {
    chain, a: meta.a, s: meta.s, d: meta.d, stable: meta.stable,
    pool: meta.stable ? null : (other && other.stable ? pool : null),
    other: other ? { a: other.a, d: other.d } : null,
  };
  return k;
}
async function registerRefPools(book, ch) {
  for (const pool of ch.refPools || []) {
    const r = await multi(ch.rpc, [{ to: pool, data: '0x0dfe1681' }, { to: pool, data: '0xd21220a7' }]);
    const a0 = lc(toAddr(w(r[0].data, 0))), a1 = lc(toAddr(w(r[1].data, 0)));
    const m = await tokenMeta(ch, [a0, a1]);
    registerToken(book, ch.key, m[a0], pool, m[a1]);
    registerToken(book, ch.key, m[a1], pool, m[a0]);
  }
}

/* a token's dollar price from its registered pool, at a block or now */
function priceFromSqrt(entry, sp) {
  if (!entry || entry.stable) return entry ? 1 : null;
  if ((!entry.pool && !entry.v4) || !entry.other || !sp) return null;
  const [a0, d0, d1] = lc(entry.a) < lc(entry.other.a)
    ? [entry.a, entry.d, entry.other.d] : [entry.other.a, entry.other.d, entry.d];
  const px = sp * sp * Math.pow(10, d0 - d1);          /* token1 per token0 */
  return lc(entry.a) === lc(a0) ? px : 1 / px;
}
export async function livePrices(book, extra) {
  const out = {};
  const byChain = {};
  for (const [k, e] of Object.entries(book.tokens || {})) {
    if (e.stable) { out[k] = 1; continue; }
    if (!e.pool && !e.v4) continue;
    (byChain[e.chain] = byChain[e.chain] || []).push([k, e]);
  }
  await Promise.all(Object.entries(byChain).map(async ([chain, list]) => {
    const ch = chainOf(chain);
    /* a V3 pool answers slot0; a V4 pool's price is read from the PoolManager's storage */
    const at = (e) => e.pool || e.v4.slot;
    const pools = [...new Set(list.map(([, e]) => at(e)))];
    try {
      const r = await multi(ch.rpc, pools.map((p) => (p.length === 66 ? { to: FABLES.pm, data: FB.extsload + p.slice(2) } : { to: p, data: '0x3850c7bd' })));
      const sp = {};
      pools.forEach((p, i) => { if (r[i] && r[i].ok) sp[p] = Number(p.length === 66 ? slot0Of(r[i].data).sqrt : toBig(w(r[i].data, 0))) / 2 ** 96; });
      for (const [k, e] of list) { const v = priceFromSqrt(e, sp[at(e)]); if (v) out[k] = v; }
    } catch { /* a chain that cannot be read leaves its tokens unpriced, and the page says so */ }
  }));
  /* a reward token with no pool of its own still has the price Merkl quotes for it */
  for (const [k, v] of Object.entries(extra || {})) if (out[k] === undefined && v) out[k] = v;
  return out;
}
async function priceAtBlock(book, key, block) {
  const e = book.tokens[key];
  if (!e) return null;
  if (e.stable) return 1;
  if (e.v4) return priceFromSqrt(e, await sqrtAtV4(chainOf(e.chain), e.v4.pool_id, block));
  if (!e.pool) return null;
  const sp = await sqrtAt(chainOf(e.chain), e.pool, block);
  return priceFromSqrt(e, sp);
}

/* What a position has earned since tracking started, as token amounts. A position that was
   already open at the start had earned something before it; that part is not the book's. */
export function feeTokensOf(P, uncollectedNow) {
  const out = {};
  const ch = chainOf(P.chain);
  if (ch.yield === 'merkl') {
    sumInto(out, P.merkl);
    sumInto(out, P.start_merkl, -1);
  } else {
    sumInto(out, P.fees);
    if (P.status === 'open' && uncollectedNow) sumInto(out, uncollectedNow);
    sumInto(out, P.start_uncollected, -1);
  }
  for (const k of Object.keys(out)) if (!(out[k] > 1e-12)) delete out[k];
  return out;
}
const uncollectedOf = (P, row) => row && row.raw
  ? { [P.t0]: row.raw.fee0, [P.t1]: row.raw.fee1 } : null;

/* A position, written into the book from what the chain says it is. */
function newPosition(chain, id, wallet, d, m0, m1, pool) {
  return {
    key: chain + ':' + id, chain, id: String(id), wallet: lc(wallet),
    pool, lo: d.lo, hi: d.hi, fee: d.fee,
    t0: tkey(m0.s, chain), t1: tkey(m1.s, chain),
    s0: m0.s, s1: m1.s, d0: m0.d, d1: m1.d, stable0: m0.stable, stable1: m1.stable,
    pair: (m0.stable && !m1.stable) ? m1.s + ' / ' + m0.s : m0.s + ' / ' + m1.s,
    liq: '0', status: 'open', at_start: false,
    opened_ts: null, opened_block: null,
    cost_usd: 0, deposits: [], out_usd: 0, withdrawals: [],
    owed: { r0: '0', r1: '0' },
    fees: {}, start_uncollected: {}, start_merkl: {}, merkl: {},
    unpriced: false,
  };
}

/* what positions(), the factory and the tokens say about a set of ids */
async function describe(ch, ids) {
  const r = await multi(ch.rpc, ids.map((id) => ({ to: ch.npm, data: '0x99fbab88' + pad(BigInt(id).toString(16)) })));
  const d = {};
  ids.forEach((id, i) => {
    if (!r[i] || !r[i].ok) return;
    const x = r[i].data;
    d[id] = { token0: lc(toAddr(w(x, 2))), token1: lc(toAddr(w(x, 3))), fee: Number(toBig(w(x, 4))),
      lo: Number(toSigned(w(x, 5))), hi: Number(toSigned(w(x, 6))), liq: toBig(w(x, 7)) };
  });
  const list = Object.keys(d);
  const pools = await multi(ch.rpc, list.map((id) => ({ to: ch.factory,
    data: '0x1698ee82' + pad(d[id].token0) + pad(d[id].token1) + pad(d[id].fee.toString(16)) })));
  list.forEach((id, i) => { d[id].pool = pools[i] && pools[i].ok ? lc(toAddr(w(pools[i].data, 0))) : null; });
  const meta = await tokenMeta(ch, list.flatMap((id) => [d[id].token0, d[id].token1]));
  return { d, meta };
}

/* ---------- rewards already claimable when tracking began ----------
   Merkl KAT is paid by the position NFT and claimed whenever he chooses, so at the moment
   tracking began some had been earned and not yet taken: by the open position before that
   moment, and by positions closed before it. It is his, it is claimable, and it counts as
   fees earned. It is carried in as a fixed token amount — repriced live like every other
   fee — and kept apart from the positions, so no position's PnL or history row is changed
   by it, and claiming it later does not move the figure. */
export function carryIn(book, merkl, wallets) {
  const earned = (merkl && merkl.earned_tokens_by_id) || {};
  const claimed = (merkl && merkl.claimed_tokens_by_id) || {};
  const owner = (merkl && merkl.wallet_by_id) || {};
  const want = new Set(wallets.map(lc));
  book.carried = book.carried || { by_id: {} };
  for (const id of Object.keys(earned)) {
    if (!want.has(owner[id]) || book.carried.by_id[id]) continue;
    const tokens = {};
    for (const [k, a] of Object.entries(earned[id])) {
      const left = a - ((claimed[id] || {})[k] || 0);
      if (left > 1e-9) tokens[k] = left;
    }
    /* a position the book follows already counts what it earns from here on; what is
       carried for it is only what it had earned before, so nothing is counted twice */
    const P = book.positions['katana:' + id];
    if (P && P.start_merkl) {
      for (const k of Object.keys(tokens)) {
        const before = (P.start_merkl[k] || 0) - ((claimed[id] || {})[k] || 0);
        tokens[k] = Math.max(0, Math.min(tokens[k], before));
        if (!(tokens[k] > 1e-9)) delete tokens[k];
      }
    }
    if (Object.keys(tokens).length) book.carried.by_id[id] = { wallet: owner[id], tokens };
  }
  return book.carried;
}
const carriedTokens = (book) => {
  const out = {};
  for (const c of Object.values((book.carried || {}).by_id || {})) sumInto(out, c.tokens);
  return out;
};

/* ---------- the photograph: every open position, at the moment tracking starts ----------
   Taken once for the whole book when it starts, and again for any wallet added to the
   config afterwards — otherwise a wallet added later would only ever be followed from its
   next mint, and whatever it already held would never appear. */
async function photograph(book, ch, wallets, { pos, data, merkl, ts }) {
  const head = Number(toBig((await rpc(ch.rpc, 'eth_blockNumber', [])).slice(2)));
  const seed = ch.key === 'katana' ? (((data || {}).chains || {}).katana || {}).staked_lp_ids || [] : [];
  const owner = await v3Candidates(ch, pos || {}, ch.open(pos || {}), seed,
    { wholeList: true, stakedLookback: 2500000, wallets });
  /* never photograph a position the book already follows */
  for (const id of [...owner.keys()]) if (book.positions[ch.key + ':' + id]) owner.delete(id);
  const rows = await v3Rows(ch, {}, owner, { noEntry: true });
  for (const row of rows) {
    const R = row.raw;
    const P = newPosition(ch.key, row.id, row.wallet, R, R.t0, R.t1, R.pool);
    registerToken(book, ch.key, R.t0, R.pool, R.t1);
    registerToken(book, ch.key, R.t1, R.pool, R.t0);
    P.at_start = true;
    P.liq = R.liq;
    P.opened_ts = ts;
    P.opened_block = head;
    P.cost_usd = row.liquidity_usd || 0;
    if (row.liquidity_usd === null) P.unpriced = true;
    const sp = Number(BigInt(R.sqrt)) / 2 ** 96;
    const [x0, x1] = v3Amounts(BigInt(R.liq), R.lo, R.hi, BigInt(R.sqrt));
    P.start = { a0: x0 / 10 ** P.d0, a1: x1 / 10 ** P.d1, prices: legPrices(P, sp), usd: r2(P.cost_usd) };
    if (ch.yield === 'fees') P.start_uncollected = uncollectedOf(P, row);
    if (ch.yield === 'merkl') P.start_merkl = { ...(((merkl || {}).earned_tokens_by_id || {})[row.id] || {}) };
    P.merkl = { ...(((merkl || {}).earned_tokens_by_id || {})[row.id] || {}) };
    book.positions[P.key] = P;
  }
  return head;
}

/* the block of a position's first deposit — its mint — walking back from the head a
   window at a time until the deposits are behind it */
async function firstDeposit(ch, id, head) {
  const topics = [INCREASE, '0x' + pad(BigInt(id).toString(16))];
  const span = Math.min(ch.logSpan, 100000);
  let first = null;
  for (let to = head, n = 0; to > 0 && n < 600; n++) {
    const from = Math.max(0, to - span + 1);
    const logs = await rpc(ch.rpc, 'eth_getLogs', [{ address: ch.npm, topics, fromBlock: hx(from), toBlock: hx(to) }]);
    if (logs.length) first = Number(toBig(logs[0].blockNumber.slice(2)));
    else if (first !== null) break;
    to = from - 1;
  }
  return first;
}

/* ---------- where tracking starts ----------
   At the mint of the positions open now. On each chain the book begins the block before the
   earliest mint among the positions its wallets hold open, and replays forward from there, so
   every position in it is measured from its own beginning: its cost is what went in at the
   mint's own price, and its fees are everything it has earned — Merkl KAT on Katana, trading
   fees on Robinhood. Nothing is photographed and nothing is carried in: KAT still claimable
   from positions closed before then was earned by them, not by these.
   (Alex, 2026-10-19. The first book photographed positions mid-life at the moment it
   started, so their PnL and fees missed everything before that moment.)
   A chain with nothing open starts at its head and picks up its next mint. */
export async function startBook({ pos, data }) {
  const book = {
    version: BOOK_VERSION,
    started: { ts: null, iso: null, blocks: {}, chains: {}, rule: 'from the mint of the positions open at the start' },
    wallets: CFG.wallets.map((x) => lc(x.address)),
    last_block: {}, tokens: {}, positions: {}, events: [], fee_series: [], runs: [], carried: { by_id: {} },
  };
  for (const ch of V3) {
    await registerRefPools(book, ch);
    const head = Number(toBig((await rpc(ch.rpc, 'eth_blockNumber', [])).slice(2)));
    const seed = ch.key === 'katana' ? (((data || {}).chains || {}).katana || {}).staked_lp_ids || [] : [];
    const owner = await v3Candidates(ch, pos || {}, ch.open(pos || {}), seed,
      { wholeList: true, stakedLookback: 2500000, wallets: book.wallets });
    const ids = [...owner.keys()];
    const { d } = ids.length ? await describe(ch, ids) : { d: {} };
    let start = head;
    const opened = [];
    for (const id of ids.filter((x) => d[x] && d[x].liq > 0n)) {
      const b = await firstDeposit(ch, id, head);
      if (b === null) throw new Error(ch.key + ' #' + id + ' is open but its mint could not be found');
      opened.push(id);
      start = Math.min(start, b - 1);
    }
    /* a Fables range held now starts the chain no later than the block its shares arrived */
    if (ch.key === FABLES.chain) {
      const fr = await fablesRead((data && data.fables) || FABLES.seed);
      for (const r of fr.rows.filter((x) => book.wallets.includes(lc(x.wallet)))) {
        const topics = [FB.T6909, null, '0x' + pad(r.wallet), '0x' + pad(r.raw.range_id)];
        let firstIn = null;
        for (let to = head, n = 0; to > 0 && n < 600; n++) {
          const from = Math.max(0, to - 99999);
          const logs = await rpc(ch.rpc, 'eth_getLogs', [{ address: FABLES.ramp, topics, fromBlock: hx(from), toBlock: hx(to) }]);
          if (logs.length) firstIn = Number(toBig(logs[0].blockNumber.slice(2)));
          else if (firstIn !== null) break;
          to = from - 1;
        }
        if (firstIn !== null) { opened.push(r.id); start = Math.min(start, firstIn - 1); }
      }
    }
    const blk = await rpc(ch.rpc, 'eth_getBlockByNumber', [hx(start + 1), false]);
    const ts = Number(BigInt(blk.timestamp));
    book.last_block[ch.key] = start;
    book.started.blocks[ch.key] = start;
    book.started.chains[ch.key] = { block: start, ts, iso: new Date(ts * 1000).toISOString(), positions: opened };
  }
  const first = Math.min(...Object.values(book.started.chains).map((c) => c.ts));
  book.started.ts = first;
  book.started.iso = new Date(first * 1000).toISOString();
  /* nothing is open before the first mint, so PnL starts at exactly zero */
  book.fee_series.push({ ts: first, tokens: {}, pnl_usd: 0 });
  return book;
}

/* ---------- one window of the chain's own events ---------- */
async function blockTimes(ch, blocks, cache) {
  const need = [...new Set(blocks)].filter((b) => cache[b] === undefined);
  await Promise.all(need.map(async (b) => {
    const blk = await rpc(ch.rpc, 'eth_getBlockByNumber', [hx(b), false]);
    cache[b] = Number(BigInt(blk.timestamp));
  }));
}

/* ---------- time in range ----------
   Every swap in a pool moves its price, so the share of a position's life the price sat
   inside its band is read straight off the swaps: between one swap and the next the price
   does not move. A position starts in range if its mint took both tokens. Robinhood leaves
   log timestamps blank, so a swap's time is placed by its block between the window's two
   ends. The six-hourly job reads every position's swaps (mode true). A page request reads
   only those of a position opened since the job last ran (mode 'new') — its life is a few
   hours at most, so that is cheap, and a new position shows its figure at once rather than
   after the next run; for every other position the page adds the minutes since the job's
   reading at the live state. */
async function rangeWindow(book, ch, a, b, tsCache, mode) {
  const live = Object.values(book.positions).filter((P) => P.chain === ch.key && P.opened_ts && (P.pool || P.pool_id)
    && (P.status === 'open' || (P.closed_block && P.closed_block >= a)) && (!P.range || P.range.block < b)
    && (mode !== 'new' || !P.range || P.range.fresh));
  if (!live.length) return;
  await blockTimes(ch, [a, b], tsCache);
  const tA = tsCache[a], tB = tsCache[b];
  const tsOf = (l, blk) => (l.blockTimestamp && l.blockTimestamp !== '0x0' ? Number(BigInt(l.blockTimestamp))
    : tA + (tB - tA) * (blk - a) / Math.max(1, b - a));
  const swaps = {};
  const src = (P) => P.pool || P.pool_id;
  for (const pool of [...new Set(live.map(src))]) {
    /* a V3 pool logs its own swaps; a V4 pool's are logged by the PoolManager under its id */
    const q = pool.length === 66 ? { address: FABLES.pm, topics: [FB.SWAP, pool] } : { address: pool, topics: [SWAP] };
    const logs = await rpc(ch.rpc, 'eth_getLogs', [{ ...q, fromBlock: hx(a), toBlock: hx(b) }]);
    swaps[pool] = logs.map((l) => {
      const blk = Number(toBig(l.blockNumber.slice(2)));
      return { blk, idx: Number(toBig(l.logIndex.slice(2))), ts: tsOf(l, blk), tick: Number(toSigned(w(l.data, 4))) };
    }).sort((x, y) => x.blk - y.blk || x.idx - y.idx);
  }
  for (const P of live) {
    if (!P.range) {
      const d0 = P.deposits[0];
      P.range = { ts: P.opened_ts, block: P.opened_block, in: !!(d0 && d0.a0 > 0 && d0.a1 > 0), in_s: 0, all_s: 0,
        ...(mode === 'new' ? { fresh: true } : {}) };
    }
    const Rg = P.range;
    const end = P.status === 'closed' && P.closed_block <= b ? { ts: P.closed_ts, blk: P.closed_block } : { ts: tB, blk: b };
    for (const s of swaps[src(P)]) {
      if (s.blk <= Rg.block || s.blk > end.blk) continue;
      const dt = Math.max(0, s.ts - Rg.ts);
      Rg.all_s += dt; if (Rg.in) Rg.in_s += dt;
      Rg.ts = Math.max(Rg.ts, s.ts); Rg.block = s.blk;
      Rg.in = s.tick >= P.lo && s.tick < P.hi;
    }
    const dt = Math.max(0, end.ts - Rg.ts);
    Rg.all_s += dt; if (Rg.in) Rg.in_s += dt;
    Rg.ts = Math.max(Rg.ts, end.ts); Rg.block = end.blk;
  }
}

async function applyWindow(book, ch, a, b, merkl, tsCache, opt = {}) {
  /* the window's events first; time in range last, once the window's mints and closes are known */
  await windowEvents(book, ch, a, b, merkl, tsCache);
  if (opt.ranges) await rangeWindow(book, ch, a, b, tsCache, opt.ranges);
}

async function windowEvents(book, ch, a, b, merkl, tsCache) {
  const walletTopics = book.wallets.map((x) => '0x' + pad(x));
  const nowTs = Math.floor(Date.now() / 1000);

  /* 1. mints to any tracked wallet: positions the book has not met yet */
  const mints = await rpc(ch.rpc, 'eth_getLogs', [{ address: ch.npm, fromBlock: hx(a), toBlock: hx(b),
    topics: [TRANSFER, ZERO32, walletTopics] }]);
  const fresh = mints.map((l) => ({ id: String(toBig(l.topics[3].slice(2))), wallet: toAddr(l.topics[2].slice(2)),
    block: Number(toBig(l.blockNumber.slice(2))), ts: l.blockTimestamp && l.blockTimestamp !== '0x0' ? Number(BigInt(l.blockTimestamp)) : null }))
    .filter((m) => !book.positions[ch.key + ':' + m.id]);
  /* 1b. KAT claimed from Merkl since tracking began, by any tracked wallet — this, not what
     is still claimable, is what the book's fee total counts on a Merkl chain. Each claim also
     puts a step on the fee curve at the moment it was made. */
  if (ch.distributor) {
    const cl = await rpc(ch.rpc, 'eth_getLogs', [{ address: ch.distributor, fromBlock: hx(a), toBlock: hx(b),
      topics: [CLAIMED, walletTopics] }]);
    if (cl.length) await blockTimes(ch, cl.filter((l) => !l.blockTimestamp || l.blockTimestamp === '0x0').map((l) => Number(toBig(l.blockNumber.slice(2)))), tsCache);
    for (const l of cl) {
      const token = lc(toAddr(l.topics[2].slice(2)));
      let key = Object.keys(book.tokens).find((k) => book.tokens[k].chain === ch.key && lc(book.tokens[k].a) === token);
      if (!key) key = registerToken(book, ch.key, (await tokenMeta(ch, [token]))[token], null, null);
      const block = Number(toBig(l.blockNumber.slice(2)));
      const ts = l.blockTimestamp && l.blockTimestamp !== '0x0' ? Number(BigInt(l.blockTimestamp)) : tsCache[block];
      const amount = Number(toBig(w(l.data, 0))) / 10 ** book.tokens[key].d;
      book.merkl_claimed = book.merkl_claimed || {};
      book.merkl_claimed[key] = (book.merkl_claimed[key] || 0) + amount;
      /* the token's price at the claim's own block, so a claim's dollars never move again */
      let price = await priceAtBlock(book, key, block).catch(() => null);
      if (!price && merkl && merkl.token_price && merkl.token_price[key]) price = merkl.token_price[key];
      (book.claims = book.claims || []).push({ block, ts, wallet: toAddr(l.topics[1].slice(2)), token: key, amount,
        price: price || null });
    }
  }

  /* 1c. Fables ranges — shares in a Uniswap V4 hook — on their chain */
  if (ch.key === FABLES.chain) await fablesWindow(book, ch, a, b, tsCache, walletTopics);

  if (fresh.length) {
    const { d, meta } = await describe(ch, fresh.map((m) => m.id));
    await blockTimes(ch, fresh.filter((m) => m.ts === null).map((m) => m.block), tsCache);
    for (const m of fresh) {
      const x = d[m.id];
      if (!x || !meta[x.token0] || !meta[x.token1]) continue;
      const P = newPosition(ch.key, m.id, m.wallet, x, meta[x.token0], meta[x.token1], x.pool);
      registerToken(book, ch.key, meta[x.token0], x.pool, meta[x.token1]);
      registerToken(book, ch.key, meta[x.token1], x.pool, meta[x.token0]);
      P.opened_block = m.block;
      P.opened_ts = m.ts !== null ? m.ts : tsCache[m.block];
      book.positions[P.key] = P;
      book.events.push({ t: 'open', chain: ch.key, wallet: P.wallet, id: P.id, block: m.block, ts: P.opened_ts });
    }
  }

  /* 2. what happened to every position still worth watching. A closed one stays on the
     list for three days, in case its fees are collected after the liquidity is gone. */
  const watch = Object.values(book.positions).filter((P) => P.chain === ch.key && P.kind !== 'fables'
    && (P.status === 'open' || (P.closed_ts && nowTs - P.closed_ts < 3 * 86400)));
  if (!watch.length) return;
  const logs = await rpc(ch.rpc, 'eth_getLogs', [{ address: ch.npm, fromBlock: hx(a), toBlock: hx(b),
    topics: [[INCREASE, DECREASE, COLLECT], watch.map((P) => '0x' + pad(BigInt(P.id).toString(16)))] }]);
  if (!logs.length) return;
  logs.sort((x, y) => (Number(toBig(x.blockNumber.slice(2))) - Number(toBig(y.blockNumber.slice(2))))
    || (Number(toBig(x.logIndex.slice(2))) - Number(toBig(y.logIndex.slice(2)))));
  const needTs = logs.filter((l) => !l.blockTimestamp || l.blockTimestamp === '0x0').map((l) => Number(toBig(l.blockNumber.slice(2))));
  await blockTimes(ch, needTs, tsCache);

  const closedNow = [];
  for (const l of logs) {
    const P = book.positions[ch.key + ':' + String(toBig(l.topics[1].slice(2)))];
    if (!P) continue;
    const block = Number(toBig(l.blockNumber.slice(2)));
    const ts = l.blockTimestamp && l.blockTimestamp !== '0x0' ? Number(BigInt(l.blockTimestamp)) : tsCache[block];
    const kind = l.topics[0];
    if (kind === INCREASE) {
      const L = toBig(w(l.data, 0)), r0 = toBig(w(l.data, 1)), r1 = toBig(w(l.data, 2));
      const v = await valueRaw(ch, P, L, r0, r1, block);
      P.liq = (big0(P.liq) + L).toString();
      P.deposits.push({ block, ts, a0: Number(r0) / 10 ** P.d0, a1: Number(r1) / 10 ** P.d1, usd: v.usd === null ? null : r2(v.usd) });
      if (v.usd === null) P.unpriced = true; else P.cost_usd = r2(P.cost_usd + v.usd);
      if (!P.opened_ts) { P.opened_ts = ts; P.opened_block = block; }
      if (P.status === 'closed') P.status = 'open';
    } else if (kind === DECREASE) {
      const L = toBig(w(l.data, 0)), r0 = toBig(w(l.data, 1)), r1 = toBig(w(l.data, 2));
      const v = await valueRaw(ch, P, L, r0, r1, block);
      const left = big0(P.liq) - L;
      P.liq = (left > 0n ? left : 0n).toString();
      P.withdrawals.push({ block, ts, a0: Number(r0) / 10 ** P.d0, a1: Number(r1) / 10 ** P.d1, usd: v.usd === null ? null : r2(v.usd) });
      if (v.usd === null) P.unpriced = true; else P.out_usd = r2(P.out_usd + v.usd);
      /* principal waits in the position until it is collected, and must not be read as fee */
      P.owed = { r0: (big0(P.owed.r0) + r0).toString(), r1: (big0(P.owed.r1) + r1).toString() };
      if (v.sp) P.close_sp = v.sp;
      if (left <= 0n && P.status === 'open') {
        P.status = 'closed'; P.closed_ts = ts; P.closed_block = block;
        closedNow.push(P);
        book.events.push({ t: 'close', chain: ch.key, wallet: P.wallet, id: P.id, block, ts });
      }
    } else if (kind === COLLECT) {
      const c0 = toBig(w(l.data, 1)), c1 = toBig(w(l.data, 2));
      const o0 = big0(P.owed.r0), o1 = big0(P.owed.r1);
      const p0 = c0 < o0 ? c0 : o0, p1 = c1 < o1 ? c1 : o1;
      P.owed = { r0: (o0 - p0).toString(), r1: (o1 - p1).toString() };
      if (ch.yield === 'fees') {
        const f0 = Number(c0 - p0) / 10 ** P.d0, f1 = Number(c1 - p1) / 10 ** P.d1;
        sumInto(P.fees, { [P.t0]: f0, [P.t1]: f1 });
        /* a collection of fees is this position's claim: dated, at the pool's price of its block */
        if (f0 > 0 || f1 > 0) {
          const sp = await sqrtAt(ch, P.pool, block).catch(() => null);
          const px = sp ? legPrices(P, sp) : {};
          const tokens = {};
          if (f0 > 0) tokens[P.t0] = f0;
          if (f1 > 0) tokens[P.t1] = f1;
          let usd = 0, ok = true;
          for (const [k, a] of Object.entries(tokens)) { if (px[k] === undefined) ok = false; else usd += a * px[k]; }
          (P.claims = P.claims || []).push({ ts, block, tokens, prices: px, usd: ok ? r2(usd) : null });
        }
      }
    }
  }

  /* 3. a position that closed in this window is written into history now, at the prices of
     the block it closed in, and does not change again */
  for (const P of closedNow) await freeze(book, ch, P, merkl);
}

async function freeze(book, ch, P, merkl) {
  if (merkl && !merkl.error && merkl.earned_tokens_by_id && merkl.earned_tokens_by_id[P.id]) P.merkl = { ...merkl.earned_tokens_by_id[P.id] };
  const tokens = feeTokensOf(P, null);
  let sp = P.close_sp || null;
  if (!sp && P.pool) sp = await sqrtAt(ch, P.pool, P.closed_block);
  if (!sp && P.pool_id) sp = await sqrtAtV4(ch, P.pool_id, P.closed_block);
  const prices = sp ? legPrices(P, sp) : {};
  for (const k of Object.keys(tokens)) {
    if (prices[k] === undefined) {
      const v = await priceAtBlock(book, k, P.closed_block);
      if (v) prices[k] = v;
      else if (merkl && merkl.token_price && merkl.token_price[k]) prices[k] = merkl.token_price[k];
    }
  }
  let feeUsd = 0, unpricedFee = false;
  for (const [k, amt] of Object.entries(tokens)) {
    if (prices[k] === undefined) unpricedFee = true; else feeUsd += amt * prices[k];
  }
  const pnl = P.out_usd - P.cost_usd;
  P.frozen = {
    at_ts: P.closed_ts, at_block: P.closed_block,
    cost_usd: r2(P.cost_usd), principal_usd: r2(P.out_usd),
    pnl_usd: r2(pnl),
    fee_tokens: tokens, fee_usd: r2(feeUsd),
    net_usd: r2(pnl + feeUsd),
    net_pct: P.cost_usd > 0 ? r2((pnl + feeUsd) / P.cost_usd * 100) : null,
    prices: prices,
    incomplete: !!(P.unpriced || unpricedFee) || undefined,
  };
}

/* ---------- move the book forward to the head of every chain ----------
   Works on a copy and hands it back; the caller decides whether to keep it. Each chain is
   its own unit: one that fails is put back exactly as it was and named in `errors`, and
   the others still move. A run takes at most `maxWindows` windows a chain, so it always
   finishes, and a book that has fallen behind catches up over several runs rather than
   timing out on one and never moving at all. */
export async function advanceBook(input, { merkl, maxWindows = 60, pos, data, ranges = false, persistRollovers = false } = {}) {
  const book = JSON.parse(JSON.stringify(input));
  const errors = {}, behind = {};
  const rawMerkl = merkl;
  anchorRewardRollovers(book);

  /* a wallet added to the config since the book began: photograph what it holds now, and
     from then on it is followed like the others */
  const added = CFG.wallets.map((x) => lc(x.address)).filter((a) => !book.wallets.includes(a));
  if (added.length) {
    const before = JSON.stringify(book);
    try {
      const ts = Math.floor(Date.now() / 1000);
      for (const ch of V3) await photograph(book, ch, added, { pos, data, merkl, ts });
      carryIn(book, merkl, added);
      book.wallets = book.wallets.concat(added);
      book.events.push({ t: 'wallet', wallets: added, ts });
    } catch (e) {
      Object.assign(book, JSON.parse(before));
      errors.wallets = 'could not photograph a newly added wallet: ' + String((e && e.message) || e).slice(0, 120);
    }
  }

  for (const ch of V3) {
    const before = JSON.stringify(book);
    try {
      const head = Number(toBig((await rpc(ch.rpc, 'eth_blockNumber', [])).slice(2)));
      let from = (book.last_block[ch.key] || head) + 1;
      const tsCache = {};
      for (let n = 0; from <= head && n < maxWindows; n++) {
        const to = Math.min(from + ch.logSpan - 1, head);
        await applyWindow(book, ch, from, to, merkl, tsCache, { ranges });
        book.last_block[ch.key] = to;
        from = to + 1;
      }
      behind[ch.key] = Math.max(0, head - book.last_block[ch.key]);
    } catch (e) {
      Object.assign(book, JSON.parse(before));
      errors[ch.key] = String((e && e.message) || e).slice(0, 160);
    }
  }
  const refreshRewards = function () {
    for (const P of Object.values(book.positions)) {
      const t = merkl?.earned_tokens_by_id?.[P.id];
      if (t && chainOf(P.chain).yield === 'merkl') P.merkl = { ...t };
    }
  };
  // A committed claim anchor makes API reconstruction deterministic across cold
  // starts. Ambiguous earlier claims wait for the scheduled writer to save a
  // complete first allocation instead of exposing a floating temporary rule.
  if (rawMerkl) {
    const beforeRewards = JSON.parse(JSON.stringify(book));
    try {
      if (errors.katana || behind.katana > 0) throw new Error('Waiting for a complete Katana position history before allocating rewards.');
      merkl = prepareBookRewards(book, rawMerkl);
      const issues = new Set();
      for (let n = 0; n < Object.keys(book.positions).length; n++) {
        const count = book.reward_rollovers.length;
        registerKatanaRollovers(book, merkl, { persistRollovers }).forEach(issue => issues.add(issue));
        if (book.reward_rollovers.length === count) break;
        merkl = prepareBookRewards(book, rawMerkl);
      }
      refreshRewards();
      attributeClaims(book, merkl);
      for (const P of Object.values(book.positions).filter(P => P.chain === 'katana')) {
        const claimed = merkl.claimed_tokens_by_id?.[P.id]?.['KAT@katana'] || 0;
        if (claimed > (P.claimed_seen?.['KAT@katana'] || 0) + 1e-8)
          throw new Error('Some claimed KAT is waiting for its dated wallet claim record.');
      }
      if ((book.claims || []).some(c => (c.assigned || 0) > c.amount + 1e-8))
        throw new Error('The recorded reward allocation exceeds a wallet claim.');
      if (issues.size) errors['Katana reward rollover'] = [...issues].join(' ');
    } catch (e) {
      Object.keys(book).forEach(k => { delete book[k]; });
      Object.assign(book, beforeRewards);
      for (const P of Object.values(book.positions).filter(P => P.chain === 'katana')) {
        if (input.positions[P.key]) P.merkl = JSON.parse(JSON.stringify(input.positions[P.key].merkl || {}));
      }
      errors.merkl = String(e?.message || e);
      merkl = { ...rawMerkl, earned_by_id: {}, earned_tokens_by_id: {}, claimed_tokens_by_id: {}, error: true };
    }
  }
  return { book, errors, behind, merkl };
}

/* ---------- rebalances: a position closed and a fresh one minted, same wallet ----------
   Paired nearest-first within a day, in either order — re-ranging sometimes opens the new
   position before closing the old one. The chain need not match: closing on Katana and
   minting on Robinhood half an hour later is the same money being moved. A close with no
   new position near it is an exit, a mint with nothing closed near it is new money, and a
   position is never paired with its own mint. */
export function rebalances(events) {
  const opens = events.filter((e) => e.t === 'open');
  const used = new Set(), out = [];
  for (const c of events.filter((e) => e.t === 'close').sort((x, y) => x.ts - y.ts)) {
    let best = null, gap = Infinity;
    for (const o of opens) {
      const k = o.chain + ':' + o.id;
      if (used.has(k) || (o.chain === c.chain && o.id === c.id) || lc(o.wallet) !== lc(c.wallet)) continue;
      const g = Math.abs(o.ts - c.ts);
      if (g <= 86400 && g < gap) { best = o; gap = g; }
    }
    if (best) {
      used.add(best.chain + ':' + best.id);
      out.push({ wallet: c.wallet, closed: c.id, closed_chain: c.chain, opened: best.id,
        opened_chain: best.chain, ts: Math.max(c.ts, best.ts) });
    }
  }
  return out;
}

/* ---------- the live rows for every position the book holds open ---------- */
export async function bookLiveRows(book) {
  const rows = {}, errors = {};
  await Promise.all(V3.map(async (ch) => {
    const owner = new Map(Object.values(book.positions)
      .filter((P) => P.chain === ch.key && P.status === 'open' && P.kind !== 'fables').map((P) => [P.id, P.wallet]));
    if (!owner.size) return;
    try {
      for (const r of await v3Rows(ch, {}, owner, { noEntry: true })) rows[ch.key + ':' + r.id] = r;
    } catch (e) { errors[ch.key] = String((e && e.message) || e).slice(0, 160); }
  }));
  const fp = Object.values(book.positions).filter((P) => P.status === 'open' && P.kind === 'fables');
  if (fp.length) {
    try {
      const fr = await fablesRead({ ranges: fp.map((P) => ({ id: P.range_id, wallet: P.wallet })), locks: [] });
      for (const r of fr.rows) rows[FABLES.chain + ':' + r.id] = r;
    } catch (e) { errors.fables = String((e && e.message) || e).slice(0, 160); }
  }
  return { rows, errors };
}

/* every fee token earned since the start, across the whole book, at this moment */
/* The book's fees earned since tracking began: on a Merkl chain the KAT actually claimed, on
   the others each position's own fees. A position's unclaimed rewards show on its live card,
   not here — they join this total the moment they are claimed, so nothing counts twice. */
export function feeTotals(book, rows) {
  const total = carriedTokens(book);
  for (const P of Object.values(book.positions)) {
    if (!isMerkl(P.chain)) sumInto(total, feeTokensOf(P, uncollectedOf(P, (rows || {})[P.key])));
  }
  sumInto(total, book.merkl_claimed || {});
  return total;
}

/* Each open position's own fees so far, as tokens. Saved with every fee-curve point, so a
   position's recent earning rate can be read against what it had a day before. */
export function positionFees(book, rows) {
  const out = {};
  for (const P of Object.values(book.positions)) {
    if (P.status === 'open') out[P.key] = feeTokensOf(P, uncollectedOf(P, (rows || {})[P.key]));
  }
  return out;
}

const validTokenAmounts = (tokens) => tokens && typeof tokens === 'object' && !Array.isArray(tokens)
  && Object.values(tokens).every((a) => Number.isFinite(a) && a >= 0);
const comparisonAmounts = ['cost_usd', 'principal_usd', 'hold_usd', 'market_usd', 'il_usd', 'earned_usd', 'lp_outcome_usd', 'difference_usd'];
function comparisonDollars(cost, principal, held, earned) {
  // Derive every displayed difference from the displayed cents, so the figures reconcile.
  const c = r2(cost), p = r2(principal), h = r2(held), e = r2(earned), outcome = r2(p + e);
  return { cost_usd: c, principal_usd: p, hold_usd: h, earned_usd: e,
    market_usd: r2(h - c), il_usd: r2(p - h), lp_outcome_usd: outcome, difference_usd: r2(outcome - h) };
}
const unavailableComparison = (reason) => ({ available: false, complete: false, reason,
  basis: null, start_ts: null, end_ts: null, deposit_count: null,
  ...Object.fromEntries(comparisonAmounts.map((k) => [k, null])) });
const unavailableApr = (reason) => ({ available: false, complete: false, reason,
  basis: null, start_ts: null, end_ts: null, elapsed_hours: null, period_label: null,
  earned_usd: null, capital_usd: null, pct: null });

/* These display-only metrics need complete cashflows. A photographed starting balance is
   not an original deposit, and partial withdrawals need a cashflow-matched benchmark. */
function positionCashflows(P) {
  if (!['open', 'closed'].includes(P.status) || P.transferred || P.transferred_in || P.transferred_out)
    return { reason: 'A transferred position needs a complete ownership and deposit history.' };
  if (P.at_start || P.unpriced || P.incomplete || P.tracking_incomplete)
    return { reason: 'The position does not have complete, priced tracking from its original deposits.' };
  if (Object.values(P.start_merkl || {}).some((a) => a > 0) || Object.values(P.start_uncollected || {}).some((a) => a > 0))
    return { reason: 'Earnings tracking began after the original deposit; a full-lifetime comparison is unavailable.' };
  if (!Number.isFinite(P.opened_ts) || P.opened_ts <= 0 || !Number.isFinite(P.cost_usd) || P.cost_usd <= 0)
    return { reason: 'The original opening time or deposited dollar value is unavailable.' };
  const deposits = P.deposits;
  if (!Array.isArray(deposits) || !deposits.length || deposits.some((d) =>
    !Number.isFinite(d.ts) || d.ts < P.opened_ts || !Number.isFinite(d.a0) || d.a0 < 0
    || !Number.isFinite(d.a1) || d.a1 < 0 || !(d.a0 + d.a1 > 0) || !Number.isFinite(d.usd) || d.usd <= 0))
    return { reason: 'Original deposit token amounts, dates or dollar values are missing.' };
  if (Math.min(...deposits.map((d) => d.ts)) !== P.opened_ts
    || Math.abs(r2(deposits.reduce((s, d) => s + d.usd, 0)) - r2(P.cost_usd)) > .010001)
    return { reason: 'The recorded deposits do not cover the position\'s complete original capital.' };
  if (!Array.isArray(P.withdrawals) || !Number.isFinite(P.out_usd) || P.out_usd < 0)
    return { reason: 'The withdrawal history is incomplete.' };
  if (P.status === 'open' && (P.withdrawals.length || P.out_usd > 0))
    return { reason: 'Partial withdrawals need a cashflow-matched holding benchmark.' };
  if (P.status === 'closed') {
    const w = P.withdrawals[0];
    if (P.withdrawals.length !== 1 || !w || w.ts !== P.closed_ts
      || !Number.isFinite(P.closed_ts) || P.closed_ts < P.opened_ts
      || !Number.isFinite(w.a0) || w.a0 < 0 || !Number.isFinite(w.a1) || w.a1 < 0 || !(w.a0 + w.a1 > 0)
      || !Number.isFinite(w.usd) || w.usd < 0 || Math.abs(r2(w.usd) - r2(P.out_usd)) > .010001
      || (Number.isFinite(w.block) && Number.isFinite(P.closed_block) && w.block !== P.closed_block))
      return { reason: 'The position needs one complete final withdrawal; partial withdrawals are not supported.' };
    if (deposits.some((d) => d.ts > P.closed_ts) || !P.frozen || P.frozen.incomplete
      || P.frozen.at_ts !== P.closed_ts)
      return { reason: 'The complete closing valuation is unavailable.' };
  }
  return { deposits, latest: Math.max(...deposits.map((d) => d.ts)) };
}

function livePerformanceIssue(P, row, merkl, errors, behind) {
  if (!row || !Number.isFinite(row.liquidity_usd) || row.liquidity_usd < 0 || row.error || row.incomplete)
    return 'A complete live principal reading is unavailable.';
  if (row.wallet && P.wallet && lc(row.wallet) !== lc(P.wallet))
    return 'The live wallet does not match the tracked deposit history.';
  if (Object.keys(errors || {}).some((k) => k === P.chain || k.startsWith(P.chain + ' ')
    || k === 'wallets' || (P.kind === 'fables' && k.startsWith('fables')))
    || (behind || {})[P.chain] > 0)
    return 'This chain\'s position history or live reading is incomplete.';
  if (isMerkl(P.chain) && (merkl?.error || (errors || {}).merkl))
    return 'The position\'s current reward reading is unavailable.';
  return null;
}

/* Validate the source before feeTokensOf's legacy positive-only filter can hide a bad
   reading. Katana DAO trading fees are deliberately excluded: only its own Merkl rewards. */
function livePerformanceTokens(P, row, merkl) {
  let source, initial;
  if (isMerkl(P.chain)) {
    const fresh = merkl?.earned_tokens_by_id;
    if (!fresh || typeof fresh !== 'object') return { reason: 'Current per-position rewards were not verified.' };
    if (!Object.hasOwn(fresh, P.id) && Object.values(P.merkl || {}).some((a) => a > 0))
      return { reason: 'The last saved rewards have no matching fresh per-position reading.' };
    source = Object.hasOwn(fresh, P.id) ? fresh[P.id] : {};
    initial = P.start_merkl || {};
  } else {
    if (!validTokenAmounts(P.fees) || !row.raw || !Number.isFinite(row.raw.fee0) || row.raw.fee0 < 0
      || !Number.isFinite(row.raw.fee1) || row.raw.fee1 < 0)
      return { reason: 'Collected and unclaimed fee amounts were not completely read.' };
    source = sumInto({ ...P.fees }, { [P.t0]: row.raw.fee0, [P.t1]: row.raw.fee1 });
    initial = P.start_uncollected || {};
  }
  if (!validTokenAmounts(source) || !validTokenAmounts(initial)) return { reason: 'The cumulative earning amounts are invalid.' };
  const tokens = sumInto({ ...source }, initial, -1);
  if (Object.values(tokens).some((a) => a < 0)) return { reason: 'Cumulative earnings fell below the tracking baseline.' };
  return { tokens };
}

function performanceValue(tokens, prices) {
  if (!validTokenAmounts(tokens)) return { reason: 'The cumulative earning amounts are incomplete.' };
  let usd = 0;
  for (const [k, a] of Object.entries(tokens)) {
    if (a === 0) continue;
    if (!Number.isFinite(prices[k]) || prices[k] <= 0) return { reason: 'A required token dollar price is unavailable.' };
    usd += a * prices[k];
  }
  return Number.isFinite(usd) ? { usd } : { reason: 'The earning valuation is unavailable.' };
}

function positionComparison(P, cashflows, principal, prices, earned, now) {
  if (cashflows.reason) return unavailableComparison(cashflows.reason);
  if (earned.reason) return unavailableComparison(earned.reason);
  if (!Number.isFinite(principal) || principal < 0) return unavailableComparison('The position\'s principal value is unavailable.');
  const amounts = { [P.t0]: 0, [P.t1]: 0 };
  for (const d of cashflows.deposits) { amounts[P.t0] += d.a0; amounts[P.t1] += d.a1; }
  const held = performanceValue(amounts, prices);
  if (held.reason) return unavailableComparison('The deposited tokens cannot be valued: ' + held.reason);
  const closed = P.status === 'closed', count = cashflows.deposits.length;
  return { available: true, complete: true, reason: null,
    basis: (closed ? 'Prices at close; fees at their recorded claim prices' : 'Current prices')
      + (count > 1 ? '; all ' + count + ' recorded deposits' : ''),
    start_ts: P.opened_ts, end_ts: closed ? P.closed_ts : now, deposit_count: count,
    ...comparisonDollars(P.cost_usd, principal, held.usd, earned.usd) };
}

function aggregateComparisons(comparisons, expected, closed = false) {
  const available = comparisons.filter((c) => c.available && c.complete);
  const coverage = { available_count: available.length, expected_count: expected };
  if (!expected || available.length !== expected) return { ...unavailableComparison(expected
    ? available.length + ' of ' + expected + ' positions have a complete holding comparison.'
    : 'There are no positions to compare.'), ...coverage };
  return { available: true, complete: true, reason: null, ...coverage,
    basis: closed ? 'Each position at its own close; fees at their recorded claim prices' : 'Current prices; all recorded deposits',
    start_ts: Math.min(...available.map((c) => c.start_ts)), end_ts: Math.max(...available.map((c) => c.end_ts)),
    deposit_count: available.reduce((s, c) => s + c.deposit_count, 0),
    ...comparisonDollars(...['cost_usd', 'principal_usd', 'hold_usd', 'earned_usd']
      .map((k) => available.reduce((s, c) => s + c[k], 0))) };
}

/* Preserve the recent-observation method, but reveal the actual interval and dollars.
   A top-up must be behind the baseline; otherwise total capital was not present for the
   measured period. Both endpoints use the same current prices, isolating token earnings. */
function positionApr(book, P, cashflows, tokensNow, prices, now) {
  if (cashflows.reason) return unavailableApr(cashflows.reason);
  if (tokensNow.reason) return unavailableApr(tokensNow.reason);
  // Healthy positions can retain their own verified observations while another
  // chain is unavailable; aggregate fee/PnL history still requires every chain.
  const independent = (book.apr_series || []).filter((p) => p.pos && Object.hasOwn(p.pos, P.key));
  const candidates = [...(book.fee_series || []), ...independent].filter((p) => Number.isFinite(p.ts)
    && p.ts >= cashflows.latest && now - p.ts >= 3 * 3600 && now - p.ts <= 26 * 3600)
    .sort((x, y) => x.ts - y.ts);
  const base = candidates.find((p) => p.pos && Object.hasOwn(p.pos, P.key));
  if (!base && candidates.length) return unavailableApr('The recent earning baseline does not contain this position.');
  if (base && (!validTokenAmounts(base.pos[P.key]) || !Number.isFinite(base.pp?.[P.key]) || base.incomplete
    || Object.keys(base.errors || {}).length)) return unavailableApr('The historical earning baseline is incomplete.');
  if (!base && cashflows.latest > P.opened_ts) return unavailableApr('A top-up needs a saved earning reading after the latest deposit.');
  const start = base ? base.ts : P.opened_ts, hours = (now - start) / 3600;
  if (!(hours > .48)) return unavailableApr('There is not yet enough elapsed time to measure an annualised rate.');
  const current = tokensNow.tokens, previous = attributedAprBaseline(P,
    base || { pos: { [P.key]: {} } }, book);
  const earnedNow = performanceValue(current, prices), earnedBefore = performanceValue(previous, prices);
  if (earnedNow.reason || earnedBefore.reason) return unavailableApr(earnedNow.reason || earnedBefore.reason);
  const delta = {};
  // Saved observations round token quantities to 1e-8; compare at that recorded precision.
  const sampleAmount = (a) => base ? Math.round(a * 1e8) / 1e8 : a;
  for (const k of new Set([...Object.keys(current), ...Object.keys(previous)])) {
    const change = sampleAmount(current[k] || 0) - sampleAmount(previous[k] || 0);
    if (change < -1e-12) return unavailableApr('Cumulative token earnings decreased; this interval cannot be treated as earned income.');
    delta[k] = change;
  }
  const gained = performanceValue(delta, prices);
  if (gained.reason) return unavailableApr(gained.reason);
  return { available: true, complete: true, reason: null,
    basis: 'Earned tokens at the same current prices; simple annualised estimate',
    start_ts: start, end_ts: now, elapsed_hours: hours,
    period_label: base ? 'Last ' + hours.toFixed(1) + ' hours' : 'Since opened (' + hours.toFixed(1) + ' hours)',
    earned_usd: r2(gained.usd), capital_usd: r2(P.cost_usd), pct: gained.usd / P.cost_usd / (hours / 24) * 36500 };
}
const pctText = (p) => (p >= 100 ? Math.round(p).toLocaleString('en-US') : p.toFixed(1)) + '%';

/* The book's PnL (IL + price, excl. fees) at this moment: open positions at their live value,
   closed ones as frozen. Null if any open position could not be read — a partial PnL is not
   recorded as the real one. */
export function bookPnl(book, rows) {
  let pnl = 0;
  for (const P of Object.values(book.positions)) {
    if (P.status === 'open') {
      const row = rows[P.key];
      if (!row || row.liquidity_usd === null || row.liquidity_usd === undefined) return null;
      pnl += row.liquidity_usd + P.out_usd - P.cost_usd;
    } else pnl += P.frozen ? P.frozen.pnl_usd : P.out_usd - P.cost_usd;
  }
  return r2(pnl);
}

/* ---------- what each position has CLAIMED, dated ----------
   Robinhood's are its fee collections, recorded as they happen. Katana's are its Merkl KAT:
   a Merkl claim is made by the wallet for every position at once, so a position's share is
   read from Merkl's own per-position "claimed" figure and dated by the wallet's latest claim
   since the share was last seen. Each record keeps the token price of its own moment, so a
   closed position's fees never move again. */
function attributeClaims(book, merkl) {
  const claimed = merkl && !merkl.error && merkl.claimed_tokens_by_id;
  if (!claimed) return;
  const nowTs = Date.now() / 1000;
  /* every position whose Merkl "claimed" has grown since it was last seen */
  const jobs = [];
  for (const P of Object.values(book.positions)) {
    if (!isMerkl(P.chain)) continue;
    P.claimed_seen = P.claimed_seen || {};
    for (const [k, amt] of Object.entries(claimed[P.id] || {})) {
      const d = amt - (P.claimed_seen[k] || 0);
      if (d > 1e-9) jobs.push({ P, k, left: d, cur: amt });
    }
  }
  if (!jobs.length) return;
  /* what a position had earned by a moment: zero at its mint, its recorded readings since, its
     present total at the end — so no claim is credited with rewards not yet earned when made */
  const earnedAt = (P, k, t) => {
    const pts = [[P.opened_ts || 0, 0]];
    for (const p of book.fee_series || []) {
      const x = p.pos && p.pos[P.key] && p.pos[P.key][k];
      if (typeof x === 'number' && p.ts > (P.opened_ts || 0)) pts.push([p.ts, x]);
    }
    pts.sort((x, y) => x[0] - y[0]);
    const fin = (P.merkl && P.merkl[k]) || 0;
    const end = P.status === 'open' ? nowTs : (P.closed_ts || nowTs);
    pts.push([Math.max(end, pts[pts.length - 1][0] + 1), fin]);
    if (t <= pts[0][0]) return 0;
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) { const [t0, v0] = pts[i - 1], [t1, v1] = pts[i]; return v0 + (v1 - v0) * (t - t0) / (t1 - t0); }
    }
    return fin;
  };
  const creditedTo = (P, k) => (P.claims || []).reduce((s2, c) => s2 + (c.tokens[k] || 0), 0);
  const credit = (P, ev, k, amount) => {
    const price = typeof ev.price === 'number' ? ev.price : null;
    P.claims = P.claims || [];
    let rec = P.claims.find((c) => c.ts === ev.ts);
    if (!rec) { rec = { ts: ev.ts, block: ev.block, tokens: {}, prices: {}, usd: 0 }; P.claims.push(rec); }
    rec.tokens[k] = (rec.tokens[k] || 0) + amount;
    if (price === null) rec.usd = null; else { rec.prices[k] = price; if (rec.usd !== null) rec.usd = r2(rec.usd + amount * price); }
    ev.assigned = (ev.assigned || 0) + amount;
  };
  const after = (P) => Math.max(P.opened_ts || 0, P.last_claim_ts || 0);
  const groups = {};
  for (const j of jobs) (groups[lc(j.P.wallet) + '|' + j.k] = groups[lc(j.P.wallet) + '|' + j.k] || []).push(j);
  for (const [g, js] of Object.entries(groups)) {
    const [wallet, k] = g.split('|');
    const evs = (book.claims || []).filter((c) => lc(c.wallet) === wallet && c.token === k).sort((x, y) => x.ts - y.ts);
    /* Claims in the order they were made, each paying the oldest rewards first: a position
       that closed earlier was paid by the earlier claims. Never more to a position than it had
       earned by that claim, never more from a claim than it paid out. */
    js.sort((x, y) => ((x.P.closed_ts || Infinity) - (y.P.closed_ts || Infinity)) || ((x.P.opened_ts || 0) - (y.P.opened_ts || 0)));
    for (const ev of evs) {
      let room = ev.amount - (ev.assigned || 0);
      for (const j of js) {
        if (!(room > 1e-9)) break;
        if (!(j.left > 1e-9) || ev.ts < after(j.P)) continue;
        const take = Math.min(j.left, room, Math.max(0, earnedAt(j.P, k, ev.ts) - creditedTo(j.P, k)));
        if (take > 1e-9) { credit(j.P, ev, k, take); j.left -= take; room -= take; }
      }
    }
    /* what the estimate could not place goes to a claim with room left, else to the latest */
    for (const j of js) {
      if (!(j.left > 1e-9)) continue;
      const el = evs.filter((ev) => ev.ts >= after(j.P));
      if (!el.length) continue;   /* the claim itself is not in the book yet: wait for it */
      for (const ev of el) {
        const take = Math.min(j.left, Math.max(0, ev.amount - (ev.assigned || 0)));
        if (take > 1e-9) { credit(j.P, ev, k, take); j.left -= take; }
        if (!(j.left > 1e-9)) break;
      }
      if (j.left > 1e-9) { credit(j.P, el[el.length - 1], k, j.left); j.left = 0; }
    }
    for (const j of js) {
      if (j.left > 1e-9) continue;
      j.P.claimed_seen[k] = j.cur;
      j.P.claims.sort((x, y) => x.ts - y.ts);
      j.P.last_claim_ts = Math.max(j.P.last_claim_ts || 0, ...j.P.claims.map((c) => c.ts));
    }
  }
}
const claimedTokensOf = (P) => {
  const out = {};
  for (const c of P.claims || []) sumInto(out, c.tokens);
  return out;
};

/* ---------- the two pages' views ----------
   LIVE: open positions only, at live prices. Value, PnL (IL + price), fees CLAIMED since each
   position opened (repriced live), net. When a position closes it leaves this view whole —
   its value, its PnL and its claims — and appears on the all-time view instead.
   ALL-TIME: closed positions only, every figure fixed: PnL in tokens and dollars at the
   close, each claim at its own day's price. Rows are built from those fixed values and the
   cards are their sums, so the rows add up to the cards exactly. */
export function bookView(book, { rows, prices, merkl, errors, behind }) {
  const usdOf = (tokens) => {
    let v = 0; const missing = [];
    for (const [k, a] of Object.entries(tokens || {})) {
      if (a === 0) continue;
      if (!Number.isFinite(a) || !Number.isFinite(prices[k])) missing.push(k); else v += a * prices[k];
    }
    return { usd: r2(v), missing };
  };
  const sym = (k) => (book.tokens[k] && book.tokens[k].s) || k.split('@')[0];
  const nowTs = Math.floor(Date.now() / 1000);
  const all = Object.values(book.positions);
  const open = all.filter((P) => P.status === 'open');
  const closed = all.filter((P) => P.status !== 'open');

  /* ===== live ===== */
  const chains = {};
  const touch = (c) => chains[c] || (chains[c] = { value_usd: 0, pnl_usd: 0, fees_usd: 0, open: 0 });
  V3.forEach((c) => touch(c.key));
  let value = 0, unrealised = 0;
  const live = [], unread = [], feeTokens = {}, claimList = [], pnlNow = {}, pending = {}, liveComparisons = [];
  for (const P of open) {
    const C = touch(P.chain);
    C.open++;
    const got = claimedTokensOf(P);
    sumInto(feeTokens, got);
    C.fees_usd += usdOf(got).usd;
    for (const c of P.claims || []) for (const [k, a] of Object.entries(c.tokens)) {
      claimList.push({ ts: c.ts, chain: P.chain, pair: P.pair, token: sym(k), amount: a,
        usd_now: prices[k] === undefined ? null : r2(a * prices[k]) });
    }
    const row = rows[P.key];
    if (!row || row.liquidity_usd === null) {
      unread.push(P.key); liveComparisons.push(unavailableComparison('A complete live principal reading is unavailable.')); continue;
    }
    const u = row.liquidity_usd + P.out_usd - P.cost_usd;
    pnlNow[P.key] = u;
    value += row.liquidity_usd; unrealised += u;
    C.value_usd += row.liquidity_usd; C.pnl_usd += u;
    /* the card: this position's own rewards or fees since it opened, claimed or not */
    const tokens = feeTokensOf(P, uncollectedOf(P, row));
    const view = widgetView(row, merkl);
    const earned = usdOf(tokens).usd;
    view.yield_value = money(earned);
    view.pnl = signed(u); view.pnl_up = u >= 0;
    view.net = signed(u + earned); view.net_up = u + earned >= 0;
    view.cost = money(P.cost_usd);
    view.since = 'opened ' + new Date(P.opened_ts * 1000).toISOString().slice(0, 10);
    view.value_now = money(row.liquidity_usd);
    if (P.range) {
      const tail = Math.max(0, nowTs - P.range.ts);
      const inS = P.range.in_s + (row.in_range ? tail : 0), allS = P.range.all_s + tail;
      if (allS > 0) view.in_range_pct = Math.round(inS / allS * 100);
    }
    const cashflows = positionCashflows(P);
    const issue = livePerformanceIssue(P, row, merkl, errors, behind);
    let metricPrices;
    // The benchmark's pair prices must come from the same pool reading as its principal.
    try { metricPrices = { ...prices, [P.t0]: undefined, [P.t1]: undefined, ...rowPrices(row) }; } catch { metricPrices = {}; }
    const earnings = issue ? { reason: issue } : livePerformanceTokens(P, row, merkl);
    const earnedValue = earnings.reason ? earnings : performanceValue(earnings.tokens, metricPrices);
    view.comparison = positionComparison(P, cashflows, row.liquidity_usd, metricPrices, earnedValue, nowTs);
    liveComparisons.push(view.comparison);
    const apr = positionApr(book, P, cashflows, earnings, metricPrices, nowTs);
    view.apr_detail = apr;
    view.apr = apr.available ? pctText(apr.pct) : '–';
    live.push(view);
    /* what it has earned and not yet claimed: its own fees since opening, less its claims */
    for (const [k, a] of Object.entries(tokens)) if (a - (got[k] || 0) > 0) sumInto(pending, { [k]: a - (got[k] || 0) });
  }
  for (const c of Object.values(chains)) for (const k of Object.keys(c)) if (typeof c[k] === 'number' && k.endsWith('_usd')) c[k] = r2(c[k]);
  live.sort((x, y) => (x.chain + x.id).localeCompare(y.chain + y.id));
  claimList.sort((x, y) => y.ts - x.ts);
  const feeNow = usdOf(feeTokens);

  /* the live curve: claimed fees of the open positions, stepping at each claim and priced
     today; Net beside it wherever the PnL of exactly these positions was recorded */
  const openKeys = new Set(open.map((P) => P.key));
  const start = open.length ? Math.min(...open.map((P) => P.opened_ts || nowTs)) : nowTs;
  const claimedAt = (t) => {
    const tok = {};
    for (const P of open) for (const c of P.claims || []) if (c.ts <= t) sumInto(tok, c.tokens);
    return usdOf(tok).usd;
  };
  const pnlAt = (p) => {
    if (p.pp) {
      let s = 0;
      for (const P of open) if (P.opened_ts <= p.ts) { if (typeof p.pp[P.key] !== 'number') return null; s += p.pp[P.key]; }
      return s;
    }
    /* a point saved before per-position PnL: usable only if every position then open is open now */
    if (typeof p.pnl_usd !== 'number') return null;
    const then = all.filter((P) => P.opened_ts <= p.ts && (!P.closed_ts || P.closed_ts > p.ts));
    return then.every((P) => openKeys.has(P.key)) ? p.pnl_usd : null;
  };
  const marks = new Map();
  marks.set(start, 0);
  for (const P of open) for (const c of P.claims || []) { marks.set(c.ts - 1, null); marks.set(c.ts, null); }
  const points = {};
  for (const p of book.fee_series || []) if (p.ts > start && p.ts < nowTs) { marks.set(p.ts, null); points[p.ts] = p; }
  const series = [...marks.keys()].filter((t) => t >= start && t < nowTs).sort((x, y) => x - y).map((t) => {
    const usd = claimedAt(t);
    const pn = t === start ? 0 : points[t] ? pnlAt(points[t]) : null;
    return { ts: t, usd, net: pn === null ? null : r2(usd + pn) };
  });
  series.push({ ts: nowTs, usd: feeNow.usd, net: unread.length ? null : r2(feeNow.usd + unrealised), live: true });

  /* ===== all-time: closed positions, fixed ===== */
  const aChains = {};
  const aTouch = (c) => aChains[c] || (aChains[c] = { realised_usd: 0, fees_usd: 0, net_usd: 0, closed: 0 });
  V3.forEach((c) => aTouch(c.key));
  const history = [], fixedEvents = [], closedComparisons = [];
  let realised = 0, feesFixed = 0, capDays = 0, first = Infinity, last = 0, incomplete = false;
  /* how long positions stay open, and how much of that time they spend in range: the in-range
     share is weighted by time, so a long position counts for more than a short one */
  const held = [];
  let rangeIn = 0, rangeAll = 0, unmeasured = 0;
  for (const P of closed) {
    const C = aTouch(P.chain);
    C.closed++;
    const f = P.frozen || {};
    const pnl = typeof f.pnl_usd === 'number' ? f.pnl_usd : r2(P.out_usd - P.cost_usd);
    if (P.closed_ts) fixedEvents.push({ ts: P.closed_ts, position: P, pnl });
    let fees = 0, feeInc = false;
    const ftok = {};
    for (const c of P.claims || []) {
      sumInto(ftok, c.tokens);
      if (c.usd === null || c.usd === undefined) feeInc = true; else { fees += c.usd; fixedEvents.push({ ts: c.ts, position: P, fees: c.usd }); }
    }
    fees = r2(fees);
    const days = P.opened_ts && P.closed_ts ? Math.max(0, (P.closed_ts - P.opened_ts) / 86400) : 0;
    capDays += P.cost_usd * days;
    if (days > 0) held.push(days);
    if (P.range && P.range.all_s > 0) { rangeIn += P.range.in_s; rangeAll += P.range.all_s; } else unmeasured++;
    if (P.opened_ts) first = Math.min(first, P.opened_ts);
    if (P.closed_ts) last = Math.max(last, P.closed_ts);
    realised += pnl; feesFixed += fees;
    C.realised_usd += pnl; C.fees_usd += fees; C.net_usd += pnl + fees;
    const out = { a0: 0, a1: 0 };
    for (const x of P.withdrawals || []) { out.a0 += x.a0; out.a1 += x.a1; }
    if (P.unpriced || feeInc || f.incomplete) incomplete = true;
    const comparison = positionComparison(P, positionCashflows(P),
      Number.isFinite(f.principal_usd) ? f.principal_usd : P.out_usd, f.prices || {},
      feeInc ? { reason: 'Some claimed fees lack their recorded dollar value.' } : { usd: fees }, nowTs);
    closedComparisons.push(comparison);
    history.push({
      chain: P.chain, id: P.id, pair: P.pair, wallet: walletLabel(P.wallet),
      opened: P.opened_ts ? new Date(P.opened_ts * 1000).toISOString() : null,
      closed: P.closed_ts ? new Date(P.closed_ts * 1000).toISOString() : null,
      held_hours: days ? r2(days * 24) : null,
      cost_usd: r2(P.cost_usd), principal_usd: r2(P.out_usd),
      out_tokens: { [sym(P.t0)]: out.a0, [sym(P.t1)]: out.a1 },
      pnl_usd: r2(pnl), fee_usd: fees, fee_tokens: Object.fromEntries(Object.entries(ftok).map(([k, a]) => [sym(k), a])),
      net_usd: r2(pnl + fees), net_pct: P.cost_usd > 0 ? r2((pnl + fees) / P.cost_usd * 100) : null,
      incomplete: !!(P.unpriced || feeInc || f.incomplete),
      comparison,
    });
  }
  for (const c of Object.values(aChains)) for (const k of Object.keys(c)) if (typeof c[k] === 'number' && k.endsWith('_usd')) c[k] = r2(c[k]);
  history.sort((x, y) => String(y.closed).localeCompare(String(x.closed)));
  const spanDays = last > first ? (last - first) / 86400 : 0;
  /* Closed-position fees stay at each claim's saved price/date; realised PnL enters only
     at the actual close. Group simultaneous events so the step curve cannot go backwards
     when multiple positions claim together, and keep a boundary just before each change. */
  fixedEvents.sort((x, y) => x.ts - y.ts);
  const aTimes = new Set(closed.length ? [first, nowTs] : []);
  for (const e of fixedEvents) { if (e.ts > first) aTimes.add(e.ts - 1); aTimes.add(e.ts); }
  const fixedBalances = new Map(closed.map((P) => [P, { fees: 0, pnl: 0 }]));
  let eventAt = 0;
  const aSeries = [...aTimes].sort((x, y) => x - y).map((ts) => {
    while (eventAt < fixedEvents.length && fixedEvents[eventAt].ts <= ts) {
      const e = fixedEvents[eventAt++], balance = fixedBalances.get(e.position);
      balance.fees += e.fees || 0; balance.pnl += e.pnl || 0;
    }
    let fees = 0, pnl = 0;
    // Match the cards' per-position fee rounding, rather than rounding each claim.
    for (const balance of fixedBalances.values()) { fees += r2(balance.fees); pnl += balance.pnl; }
    return { ts, usd: r2(fees), net: r2(fees + pnl) };
  });
  const pairs = rebalances(book.events);
  const stableClosedCapital = closed.every((P) => {
    const cashflows = positionCashflows(P);
    return !cashflows.reason && cashflows.latest === P.opened_ts && P.closed_ts > P.opened_ts;
  });
  const alltimeApr = closed.length && capDays > 0 && Number.isFinite(first) && last >= first && !incomplete && stableClosedCapital
    ? { available: true, complete: true, reason: null,
      basis: 'Recorded claimed fees divided by each position\'s capital and days open; simple annualised estimate',
      start_ts: first, end_ts: last, elapsed_hours: (last - first) / 3600,
      period_label: 'Closed positions over ' + ((last - first) / 86400).toFixed(1) + ' days',
      earned_usd: r2(feesFixed), capital_usd: spanDays > 0 ? r2(capDays / spanDays) : null,
      capital_days_usd: r2(capDays), pct: r2(feesFixed / capDays * 36500) }
    : { ...unavailableApr(!stableClosedCapital
      ? 'Complete position lifetimes with unchanged capital are required for this annualised measurement.'
      : 'Complete recorded fees and capital-weighted position lifetimes are required.'), capital_days_usd: null };

  return {
    started: book.started,
    wallets: book.wallets.map((a) => ({ address: a, label: walletLabel(a) })),
    /* the LIVE page */
    cards: {
      value_usd: r2(value), pnl_usd: r2(unrealised),
      fees_usd: feeNow.usd, fee_tokens: Object.fromEntries(Object.entries(feeTokens).map(([k, a]) => [sym(k), a])),
      fee_tokens_usd: Object.fromEntries(Object.entries(feeTokens).map(([k, a]) => [sym(k), prices[k] === undefined ? null : r2(a * prices[k])])),
      net_usd: r2(feeNow.usd + unrealised),
      unclaimed_usd: usdOf(pending).usd, last_claim_ts: claimList.length ? claimList[0].ts : null,
      open: open.length, chains,
      comparison: aggregateComparisons(liveComparisons, open.length),
    },
    claims: claimList,
    series, live, prices,
    /* the ALL-TIME page */
    alltime: {
      cards: {
        avg_value_usd: spanDays > 0 ? r2(capDays / spanDays) : 0,
        realised_usd: r2(realised), fees_usd: r2(feesFixed), net_usd: r2(realised + feesFixed),
        apr_pct: capDays > 0 ? r2(feesFixed / capDays * 365 * 100) : null,
        avg_days: held.length ? r2(held.reduce((a, d) => a + d, 0) / held.length) : null,
        min_days: held.length ? r2(Math.min(...held)) : null, max_days: held.length ? r2(Math.max(...held)) : null,
        in_range_pct: rangeAll > 0 ? r2(rangeIn / rangeAll * 100) : null,
        in_range_days: r2(rangeIn / 86400), range_days: r2(rangeAll / 86400), range_unmeasured: unmeasured,
        closed: closed.length, days: r2(spanDays), rebalances: pairs.length, incomplete,
        chains: aChains,
        comparison: aggregateComparisons(closedComparisons, closed.length, true), apr_detail: alltimeApr,
      },
      series: aSeries, history, rebalances: pairs.slice().reverse(),
    },
    health: {
      errors: errors || {}, behind: behind || {}, unread,
      unpriced: feeNow.missing,
      last_run: (book.runs || []).slice(-1)[0] || null,
    },
  };
}

/* ============================================================================
   Fables on Robinhood Chain.

   Fables runs its liquidity through a Uniswap V4 hook, FablesRamp: a deposit buys shares
   in a "range" — a pool and a band — and the shares are ERC-6909 tokens of the hook, one id
   per range, not a position NFT. That is why no Uniswap reader ever saw the FABLES/USDG LP
   opened on 2026-10-21. A share is one unit of the range's liquidity (Deposited reports the
   liquidity it minted as shares), so a holding is valued with the same band maths as any V3
   position, at the V4 pool's own price, read straight from the PoolManager's storage.
   Its veFABLES locks are NFTs of VotingEscrowFF; locks(id) gives the amount and the unlock.
   ========================================================================== */
export const FABLES = {
  chain: 'robinhood',
  ramp: '0x08e52564bad99e05a694b4809f397edca417a080',     /* FablesRamp — the V4 hook and share ledger */
  pm: '0x8366a39cc670b4001a1121b8f6a443a643e40951',       /* Uniswap V4 PoolManager */
  ve: '0xc1d5adc963a57d24adaf63aae1bfbecab95f6edd',       /* VotingEscrowFF — veFABLES */
  /* a full scan of both wallets on 2026-10-21 found these; every run adds anything newer */
  seed: {
    ranges: [{ id: '0xf346f1a56c1109a88243a0e4227fe723a36182e477436b6b670eabbfe0a74c2f', wallet: '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1' }],
    locks: [{ id: '559', wallet: '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1' }],
    scanned_to: 94265704,
  },
};
const FB = {
  T6909: '0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859',   /* Transfer(caller, from, to, id, amount) */
  CLAIMED: '0xd49b328847f240dd41d9f8a97b5334cb8d06f55e51ce78bacd364d5c62136d77', /* FeesClaimed(owner, rangeId, amount0, amount1) */
  STAKED: '0x5f1526e127c2ae64abea3117909f2c3ba68d66b293ec1256c0c0025cf7ade21a',
  UNSTAKED: '0x3f58555a19e04d0ac05f036e483136cdab4628e29210be59809a5184983057b6',
  SWAP: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',    /* V4 Swap(id, sender, a0, a1, sqrtP, L, tick, fee) */
  rangeKey: '0x2e32a3b0', rangeState: '0x41b69b2a', userPosition: '0x4eb5c4fd', claimFee: '0xd677eaad',
  extsload: '0x1e2eaeaf', bal: '0x00fdd58e', locks: '0xf4dadc61', ownerOf: '0x6352211e',
};
/* Keccak-256 (the Ethereum hash: Keccak padding 0x01, not SHA-3's 0x06), in plain JS so
   it runs wherever the code does — Vercel's Node has no keccak in its crypto module. Slow
   by hashing standards and fine here: a handful of 64-byte inputs per request. */
const KM = (1n << 64n) - 1n;
const KRC = ['0x1', '0x8082', '0x800000000000808a', '0x8000000080008000', '0x808b', '0x80000001',
  '0x8000000080008081', '0x8000000000008009', '0x8a', '0x88', '0x80008009', '0x8000000a', '0x8000808b',
  '0x800000000000008b', '0x8000000000008089', '0x8000000000008003', '0x8000000000008002',
  '0x8000000000000080', '0x800a', '0x800000008000000a', '0x8000000080008081', '0x8000000000008080',
  '0x80000001', '0x8000000080008008'].map(BigInt);
const KROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt);
const krotl = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & KM);
function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ krotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) s[y + x] ^= D;
    }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = krotl(s[x + 5 * y], KROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = (B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y]) & B[(x + 2) % 5 + 5 * y])) & KM;
    s[0] ^= KRC[round];
  }
}
function keccak256(bytes) {
  const rate = 136, s = new Array(25).fill(0n);
  const msg = Array.from(bytes);
  msg.push(0x01);
  while (msg.length % rate) msg.push(0);
  msg[msg.length - 1] |= 0x80;
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + b]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let out = '';
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  return out;
}
const hexBytes = (hex) => { const h = String(hex).replace(/^0x/, ''); const a = []; for (let i = 0; i < h.length; i += 2) a.push(parseInt(h.slice(i, i + 2), 16)); return a; };
/* a Uniswap V4 pool's id, and the storage slot of its price, are keccak hashes */
const keccakHex = (hex) => keccak256(hexBytes(hex));
const fablesPid = (id, wallet) => 'F' + lc(id).slice(2, 10) + '-' + lc(wallet).slice(2, 6);

/* each range's pool and band — fixed for a range — with the storage slot of its pool's price */
async function fablesRanges(ch, ids) {
  const out = {};
  if (!ids.length) return out;
  const r = await multi(ch.rpc, ids.map((id) => ({ to: FABLES.ramp, data: FB.rangeKey + pad(id) })));
  ids.forEach((id, i) => {
    const x = requiredRead(r[i], 7, 'Fables range definition');
    const c0 = lc(toAddr(w(x, 0))), c1 = lc(toAddr(w(x, 1)));
    const fee = toBig(w(x, 2)), ts = toSigned(w(x, 3)), hooks = lc(toAddr(w(x, 4)));
    const poolId = keccakHex(pad(c0) + pad(c1) + pad(fee.toString(16)) + pad(BigInt.asUintN(256, ts).toString(16)) + pad(hooks));
    const lo = Number(toSigned(w(x, 5))), hi = Number(toSigned(w(x, 6)));
    const state = keccakHex(poolId + pad('6'));                             /* pools mapping sits at slot 6 */
    const at = (n) => (BigInt('0x' + state) + BigInt(n)).toString(16).padStart(64, '0');
    const i24 = (t) => BigInt.asUintN(24, BigInt(t)).toString(16).padStart(6, '0');
    const i256 = (t) => BigInt.asUintN(256, BigInt(t)).toString(16).padStart(64, '0');
    /* the hook's own V4 position for the range (salt 0), and the band's two ticks: what the
       range has earned since the hook last collected */
    const pos = keccakHex(keccakHex(hooks.slice(2) + i24(lo) + i24(hi) + '0'.repeat(64)) + at(6));
    const tk = (t) => keccakHex(i256(t) + at(4));
    const plus = (h, n) => '0x' + (BigInt('0x' + h) + BigInt(n)).toString(16).padStart(64, '0');
    out[lc(id)] = { c0, c1, lo, hi, poolId: '0x' + poolId, slot: '0x' + state,
      feeSlots: [plus(state, 1), plus(state, 2), '0x' + pos, plus(pos, 1), plus(pos, 2),
        plus(tk(lo), 1), plus(tk(lo), 2), plus(tk(hi), 1), plus(tk(hi), 2)] };
  });
  return out;
}
const slot0Of = (data) => {
  const word = toBig(w(data, 0));
  let tick = Number((word >> 160n) & 0xffffffn);
  if (tick >= 1 << 23) tick -= 1 << 24;
  return { sqrt: word & ((1n << 160n) - 1n), tick };
};

/* a V4 pool's price at the end of a block: its last Swap at or before it */
async function sqrtAtV4(ch, poolId, block) {
  const span = Math.min(ch.logSpan, 100000);
  const q = (from, to) => rpc(ch.rpc, 'eth_getLogs', [{ address: FABLES.pm, topics: [FB.SWAP, poolId],
    fromBlock: hx(Math.max(0, from)), toBlock: hx(to) }]);
  for (const back of [2000, 20000, span]) {
    try { const logs = await q(block - back + 1, block); if (logs.length) return Number(toBig(w(logs[logs.length - 1].data, 2))) / 2 ** 96; } catch { /* wider */ }
  }
  for (let to = block - span, n = 0; n < 6 && to > 0; n++, to -= span) {
    try { const logs = await q(to - span + 1, to); if (logs.length) return Number(toBig(w(logs[logs.length - 1].data, 2))) / 2 ** 96; } catch { /* further back */ }
  }
  return null;
}

/* Ranges and locks the wallets have received since the last scan, added to what was known. A
   scan that fails keeps the list it had and covers the same blocks next time. */
export async function fablesDiscover(prev, wallets) {
  const ch = chainOf(FABLES.chain);
  const key = (x) => lc(x.id) + '|' + lc(x.wallet);
  const merge = (a, b) => { const m = new Map(); for (const x of a.concat(b)) m.set(key(x), { id: lc(String(x.id)), wallet: lc(x.wallet) }); return [...m.values()]; };
  const st = {
    ranges: merge(FABLES.seed.ranges, (prev && prev.ranges) || []),
    locks: merge(FABLES.seed.locks, (prev && prev.locks) || []),
    scanned_to: Math.max(FABLES.seed.scanned_to, (prev && prev.scanned_to) || 0),
  };
  try {
    const head = Number(toBig((await rpc(ch.rpc, 'eth_blockNumber', [])).slice(2)));
    const W = wallets.map((a) => '0x' + pad(a));
    const ranges = [], locks = [];
    for (let a = st.scanned_to + 1; a <= head; a += 100000) {
      const b = Math.min(head, a + 99999);
      const [rl, vl] = await Promise.all([
        rpc(ch.rpc, 'eth_getLogs', [{ address: FABLES.ramp, fromBlock: hx(a), toBlock: hx(b), topics: [FB.T6909, null, W] }]),
        rpc(ch.rpc, 'eth_getLogs', [{ address: FABLES.ve, fromBlock: hx(a), toBlock: hx(b), topics: [TRANSFER, null, W] }]),
      ]);
      for (const l of rl) ranges.push({ id: '0x' + l.topics[3].slice(2), wallet: toAddr(l.topics[2].slice(2)) });
      for (const l of vl) if (l.topics.length === 4) locks.push({ id: String(toBig(l.topics[3].slice(2))), wallet: toAddr(l.topics[2].slice(2)) });
    }
    return { ranges: merge(st.ranges, ranges), locks: merge(st.locks, locks), scanned_to: head };
  } catch { return st; }
}

/* Every Fables range and lock in the list, valued now. Rows come in the same shape as a
   Uniswap position's (shape()), with the raw figures the LP book prices from. */
export async function fablesRead(state) {
  const ch = chainOf(FABLES.chain);
  const ranges = ((state && state.ranges) || FABLES.seed.ranges).map((x) => ({ id: lc(x.id), wallet: lc(x.wallet) }));
  const locks = (state && state.locks) || FABLES.seed.locks;
  /* the seed range's pool prices FABLES even when no range is held any more */
  const ids = [...new Set(ranges.map((x) => x.id).concat([lc(FABLES.seed.ranges[0].id)]))];
  const info = await fablesRanges(ch, ids);
  const slots = [...new Set(Object.values(info).map((x) => x.slot))];
  const calls = [
    ...slots.map((s) => ({ to: FABLES.pm, data: FB.extsload + s.slice(2) })),
    ...ids.map((id) => ({ to: FABLES.ramp, data: FB.rangeState + pad(id) })),
    ...ids.flatMap((id) => (info[id] ? info[id].feeSlots : []).map((sl) => ({ to: FABLES.pm, data: FB.extsload + sl.slice(2) }))
      .concat([{ to: FABLES.ramp, data: FB.claimFee + pad(id) }])),
    ...ranges.flatMap((x) => [{ to: FABLES.ramp, data: FB.bal + pad(x.wallet) + pad(x.id) },
      { to: FABLES.ramp, data: FB.userPosition + pad(x.id) + pad(x.wallet) }]),
    ...locks.flatMap((l) => [{ to: FABLES.ve, data: FB.locks + pad(BigInt(l.id).toString(16)) },
      { to: FABLES.ve, data: FB.ownerOf + pad(BigInt(l.id).toString(16)) }]),
  ];
  const r = await multi(ch.rpc, calls);
  let i = 0;
  const pool = {};
  for (const s of slots) {
    const x = r[i++]; pool[s] = slot0Of(requiredRead(x, 1, 'Fables pool price'));
    if (pool[s].sqrt <= 0n) throw new Error('Fables pool price is unavailable');
  }
  const rs = {};
  for (const id of ids) {
    const x = r[i++];
    const data = requiredRead(x, 6, 'Fables range fee state');
    rs[id] = { total: toBig(w(data, 0)), acc0: toBig(w(data, 2)), acc1: toBig(w(data, 3)), accS0: toBig(w(data, 4)), accS1: toBig(w(data, 5)) };
  }
  /* What each range has earned since the hook last collected: the V4 position's liquidity times
     the growth of fees inside its band since its checkpoint. When collected, the staked share
     goes to staked holders and the unstaked share — less the claim fee — to unstaked holders,
     each pro rata (FablesRamp _split / _takeStakedCut). */
  const M = 1n << 256n, Q = 1n << 128n;
  const uncollected = {};
  for (const id of ids) {
    const slotsHere = info[id] ? info[id].feeSlots.length : 0;
    const v = [];
    for (let k = 0; k < slotsHere; k++) { const x = r[i++]; v.push(toBig(w(requiredRead(x, 1, 'Fables fee growth'), 0))); }
    const cf = info[id] ? r[i++] : null;
    if (!info[id] || !pool[info[id].slot]) throw new Error('Fables range metadata is unavailable');
    const bps = toBig(w(requiredRead(cf, 1, 'Fables claim fee'), 0));
    if (bps > 10000n) throw new Error('Invalid Fables claim fee');
    const [g0, g1, L, last0, last1, lo0, lo1, hi0, hi1] = v;
    const t = pool[info[id].slot].tick, { lo, hi } = info[id];
    const inside = (g, a, b2) => (t < lo ? (a - b2 + M) % M : t >= hi ? (b2 - a + M) % M : ((g - a - b2) % M + 2n * M) % M);
    uncollected[id] = {
      f0: L * ((inside(g0, lo0, hi0) - last0 + M) % M) / Q,
      f1: L * ((inside(g1, lo1, hi1) - last1 + M) % M) / Q,
      bps,
    };
  }
  const meta = await tokenMeta(ch, Object.values(info).flatMap((x) => [x.c0, x.c1]));
  /* FABLES in dollars, from the seed range's pool */
  let fablesUsd = null;
  const si = info[lc(FABLES.seed.ranges[0].id)];
  if (si && pool[si.slot]) {
    const T0 = meta[si.c0], T1 = meta[si.c1];
    const px = poolPrice(pool[si.slot].sqrt, T0.d, T1.d);          /* token1 per token0 */
    fablesUsd = T0.stable ? 1 / px : T1.stable ? px : null;
  }
  const grow = (a, c) => (a > c ? a - c : 0n);
  const rows = [];
  for (const x of ranges) {
    const b = r[i++], u = r[i++];
    const inf = info[x.id], P = inf && pool[inf.slot], S = rs[x.id];
    if (!inf || !P || !S) throw new Error('Fables range reading is incomplete');
    requiredRead(b, 1, 'Fables range balance'); requiredRead(u, 7, 'Fables user position');
    const bal = toBig(w(b.data, 0)), staked = toBig(w(u.data, 0));
    const L = bal + staked;
    if (L === 0n) continue;
    /* owed + booked since the holder's checkpoint + this holder's share of what is not yet collected */
    const U = uncollected[x.id], share = (f) => (U && S && S.total > 0n
      ? f * bal / S.total * (10000n - U.bps) / 10000n + f * staked / S.total : 0n);
    const f0 = toBig(w(u.data, 1)) + (S ? bal * grow(S.acc0, toBig(w(u.data, 3))) / Q + staked * grow(S.accS0, toBig(w(u.data, 5))) / Q : 0n) + share(U ? U.f0 : 0n);
    const f1 = toBig(w(u.data, 2)) + (S ? bal * grow(S.acc1, toBig(w(u.data, 4))) / Q + staked * grow(S.accS1, toBig(w(u.data, 6))) / Q : 0n) + share(U ? U.f1 : 0n);
    const T0 = meta[inf.c0], T1 = meta[inf.c1];
    const [a0, a1] = v3Amounts(L, inf.lo, inf.hi, P.sqrt);
    const row = shape({
      chain: FABLES.chain, id: fablesPid(x.id, x.wallet), protocol: 'Fables', wallet: x.wallet,
      staked: staked > 0n, feesMine: true, T0, T1, lo: inf.lo, hi: inf.hi, sqrtP: P.sqrt, liq: L,
      a0: a0 / 10 ** T0.d, a1: a1 / 10 ** T1.d, fee0: Number(f0) / 10 ** T0.d, fee1: Number(f1) / 10 ** T1.d,
    });
    row.raw = { kind: 'fables', range_id: x.id, pool_id: inf.poolId, slot: inf.slot, pool: null,
      token0: inf.c0, token1: inf.c1, lo: inf.lo, hi: inf.hi, liq: L.toString(), sqrt: P.sqrt.toString(),
      t0: { s: T0.s, d: T0.d, stable: T0.stable, a: inf.c0 }, t1: { s: T1.s, d: T1.d, stable: T1.stable, a: inf.c1 },
      fee0: Number(f0) / 10 ** T0.d, fee1: Number(f1) / 10 ** T1.d };
    rows.push(row);
  }
  const lockRows = [];
  for (const l of locks) {
    const a = r[i++], o = r[i++];
    requiredRead(a, 2, 'Fables locked amount');
    const amount = Number(toBig(w(a.data, 0))) / 1e18, unlock = Number(toBig(w(a.data, 1)));
    if (!(amount > 0)) continue;
    const owner = lc(toAddr(w(requiredRead(o, 1, 'Fables lock owner'), 0)));
    if (owner !== lc(l.wallet)) continue;
    lockRows.push({ id: String(l.id), wallet: lc(l.wallet), amount, unlock,
      value_usd: fablesUsd ? r2(amount * fablesUsd) : null });
  }
  return { rows, locks: lockRows, fables_usd: fablesUsd };
}

/* the dashboard's own row for a Fables range, and for a veFABLES lock */
export function fablesDashRow(row) {
  const amt = Object.entries(row.amounts || {}).map(([s, a]) => (a >= 1 ? a.toFixed(2) : a.toPrecision(3)) + ' ' + s).join(' + ');
  return { type: 'LP', protocol: 'Fables', chain: FABLES.chain, wallet: row.wallet,
    pair: row.pair, pool_fee: 'dynamic', token_id: row.id, range_status: row.range_status,
    staked: false, apr: null, value_usd: row.value_usd, fees_usd: row.fees_usd,
    note: 'Fables range — ' + amt };
}
export function fablesLockRow(l) {
  const permanent = l.unlock > 4102444800;   /* past 2100: a permanent lock */
  return { type: 'Staking', protocol: 'Fables veFABLES', wallet: l.wallet,
    market: 'Voting escrow · veNFT #' + l.id, locked: { amount: l.amount, token: 'FABLES' }, value_usd: l.value_usd,
    note: Math.round(l.amount).toLocaleString('en-US') + ' FABLES locked'
      + (permanent ? ' · permanent' : ' · unlocks ' + new Date(l.unlock * 1000).toISOString().slice(0, 10)) };
}

/* ---------- the LP book's side of Fables ----------
   A range is a position: shares received (not while staking) are money in, shares sent out
   are money out, each valued at the pool's price of its block; FeesClaimed is a claim. */
async function fablesWindow(book, ch, a, b, tsCache, walletTopics) {
  const q = (topics) => rpc(ch.rpc, 'eth_getLogs', [{ address: FABLES.ramp, fromBlock: hx(a), toBlock: hx(b), topics }]);
  const [tin, tout, claimed, stk] = await Promise.all([
    q([FB.T6909, null, walletTopics]), q([FB.T6909, walletTopics]), q([FB.CLAIMED, walletTopics]),
    q([[FB.STAKED, FB.UNSTAKED], walletTopics]),
  ]);
  if (!tin.length && !tout.length && !claimed.length) return;
  /* staking moves shares within the hook; it is neither money in nor out */
  const stakeTx = new Set(stk.map((l) => l.transactionHash));
  const evs = [];
  for (const l of tin) if (!stakeTx.has(l.transactionHash)) evs.push({ l, dir: 1, wallet: lc(toAddr(l.topics[2].slice(2))), id: lc('0x' + l.topics[3].slice(2)) });
  for (const l of tout) if (!stakeTx.has(l.transactionHash)) evs.push({ l, dir: -1, wallet: lc(toAddr(l.topics[1].slice(2))), id: lc('0x' + l.topics[3].slice(2)) });
  for (const l of claimed) evs.push({ l, claim: true, wallet: lc(toAddr(l.topics[1].slice(2))), id: lc('0x' + l.topics[2].slice(2)) });
  evs.sort((x, y) => (Number(toBig(x.l.blockNumber.slice(2))) - Number(toBig(y.l.blockNumber.slice(2))))
    || (Number(toBig(x.l.logIndex.slice(2))) - Number(toBig(y.l.logIndex.slice(2)))));
  await blockTimes(ch, evs.filter((e) => !e.l.blockTimestamp || e.l.blockTimestamp === '0x0').map((e) => Number(toBig(e.l.blockNumber.slice(2)))), tsCache);
  const info = await fablesRanges(ch, [...new Set(evs.map((e) => e.id))]);
  const meta = await tokenMeta(ch, Object.values(info).flatMap((x) => [x.c0, x.c1]));
  for (const e of evs) {
    const inf = info[e.id];
    if (!inf) continue;
    const block = Number(toBig(e.l.blockNumber.slice(2)));
    const ts = e.l.blockTimestamp && e.l.blockTimestamp !== '0x0' ? Number(BigInt(e.l.blockTimestamp)) : tsCache[block];
    const pid = fablesPid(e.id, e.wallet), key = ch.key + ':' + pid;
    let P = book.positions[key];
    if (!P) {
      if (e.dir !== 1) continue;
      const m0 = meta[inf.c0], m1 = meta[inf.c1];
      P = newPosition(ch.key, pid, e.wallet, { lo: inf.lo, hi: inf.hi, fee: 'dynamic' }, m0, m1, null);
      P.kind = 'fables'; P.range_id = e.id; P.pool_id = inf.poolId; P.slot = inf.slot;
      for (const [m, o] of [[m0, m1], [m1, m0]]) {
        const k = registerToken(book, ch.key, m, null, o);
        if (!m.stable && o.stable && !book.tokens[k].v4) book.tokens[k].v4 = { pool_id: inf.poolId, slot: inf.slot };
      }
      P.opened_block = block; P.opened_ts = ts;
      book.positions[key] = P;
      book.events.push({ t: 'open', chain: ch.key, wallet: P.wallet, id: P.id, block, ts });
    }
    const sp = await sqrtAtV4(ch, P.pool_id, block);
    const px = sp ? legPrices(P, sp) : {};
    if (e.claim) {
      const t0 = Number(toBig(w(e.l.data, 0))) / 10 ** P.d0, t1 = Number(toBig(w(e.l.data, 1))) / 10 ** P.d1;
      const tokens = {};
      if (t0 > 0) tokens[P.t0] = t0;
      if (t1 > 0) tokens[P.t1] = t1;
      if (!Object.keys(tokens).length) continue;
      sumInto(P.fees, tokens);
      let usd = 0, ok = true;
      for (const [k, x] of Object.entries(tokens)) { if (px[k] === undefined) ok = false; else usd += x * px[k]; }
      (P.claims = P.claims || []).push({ ts, block, tokens, prices: px, usd: ok ? r2(usd) : null });
      continue;
    }
    const L = toBig(w(e.l.data, 1));
    let usd = null, x0 = 0, x1 = 0;
    if (sp) {
      const [r0, r1] = v3Amounts(L, P.lo, P.hi, BigInt(Math.round(sp * 2 ** 96)));
      x0 = r0 / 10 ** P.d0; x1 = r1 / 10 ** P.d1;
      if (px[P.t0] !== undefined) usd = x0 * px[P.t0] + x1 * px[P.t1];
    }
    if (e.dir === 1) {
      P.liq = (big0(P.liq) + L).toString();
      P.deposits.push({ block, ts, a0: x0, a1: x1, usd: usd === null ? null : r2(usd) });
      if (usd === null) P.unpriced = true; else P.cost_usd = r2(P.cost_usd + usd);
      if (P.status === 'closed') P.status = 'open';
    } else {
      const left = big0(P.liq) - L;
      P.liq = (left > 0n ? left : 0n).toString();
      P.withdrawals.push({ block, ts, a0: x0, a1: x1, usd: usd === null ? null : r2(usd) });
      if (usd === null) P.unpriced = true; else P.out_usd = r2(P.out_usd + usd);
      if (sp) P.close_sp = sp;
      if (left <= 0n && P.status === 'open') {
        P.status = 'closed'; P.closed_ts = ts; P.closed_block = block;
        book.events.push({ t: 'close', chain: ch.key, wallet: P.wallet, id: P.id, block, ts });
        await freeze(book, ch, P, null);
      }
    }
  }
}

/* ============================================================================
   The Tiger Vault — a wallet of its own, valued live like everything else.

   It used to be a figure typed into the page. It is this address, so it is read:
   every LP position the wallet holds on any chain in V3, and the gas money and
   tokens it keeps on each chain, priced from the chain's own pools.

   `complete` is false if any part could not be read. A caller must then keep the
   last good figure rather than show the partial one — a chain that failed to
   answer is not money that left the vault.
   ========================================================================== */
export const VAULT = {
  address: '0x4da1d0d5f7b123364d7580f19b716de2ed4e9770',
  /* what to look for on each chain beside its LP positions: the native gas coin, and
     the tokens worth checking. A token not listed here is not counted — add it. */
  chains: {
    katana: { rpc: CFG.katRpc, native: { s: 'ETH', d: 18, px: 'eth' }, tokens: [
      { s: 'vbUSDC', a: '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36', d: 6, px: 'usd' },
      { s: 'vbUSDT', a: '0x2dca96907fde857dd3d816880a0df407eeb2d2f2', d: 6, px: 'usd' },
      { s: 'vbWBTC', a: '0x0913da6da4b42f538b445599b46bb4622342cf52', d: 8, px: 'btc' },
      { s: 'vbETH', a: '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62', d: 18, px: 'eth' },
      { s: 'KAT', a: '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d', d: 18, px: 'kat' },
    ] },
    robinhood: { rpc: CFG.rhRpc, native: { s: 'ETH', d: 18, px: 'eth' }, tokens: [
      { s: 'USDG', a: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', d: 6, px: 'usd' },
      { s: 'WETH', a: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', d: 18, px: 'eth' },
    ] },
    /* Arc's gas coin is USDC itself, carried at 18 decimals */
    arc: { rpc: CFG.arcRpc, native: { s: 'USDC', d: 18, px: 'usd' }, tokens: [] },
  },
  /* where each price comes from: Katana pools quoted against USDC */
  pricePools: {
    eth: '0x2a2c512beaa8eb15495726c235472d82effb7a6b',
    kat: '0x10045367e619caae6f60cc80046c43c6cd55f629',
    btc: '0x744676b3ced942d78f9b8e9cd22246db5c32395c',
  },
};

export async function vaultValue(address = VAULT.address, { book, fables } = {}) {
  const errors = {};
  const who = lc(address);

  /* Prices, LP positions and loose balances are read side by side; only putting dollars on
     the balances has to wait for the prices. */
  const pricesP = (async () => {
    const px = { usd: 1 };
    try {
      const tmp = { tokens: {} };
      await registerRefPools(tmp, { ...chainOf('katana'), refPools: Object.values(VAULT.pricePools) });
      const live = await livePrices(tmp);
      for (const [name, pool] of Object.entries(VAULT.pricePools)) {
        const hit = Object.entries(tmp.tokens).find(([, e]) => e.pool === pool && !e.stable);
        if (hit && live[hit[0]]) px[name] = live[hit[0]];
      }
    } catch (e) { errors.prices = String((e && e.message) || e).slice(0, 120); }
    return px;
  })();

  /* Every LP the wallet holds. The LP book already follows this wallet, so its open
     positions are the seeds; the wallet's own NFT list and a short reach back for anything
     staked since catch what the book has not met yet. That keeps a weeks-wide log search
     out of a request that runs every minute. */
  const positionsP = Promise.all(V3.map(async (ch) => {
    const out = [];
    try {
      const owner = await v3Candidates(ch, {}, {}, [], { wallets: [address], wholeList: true });
      for (const P of Object.values((book && book.positions) || {})) {
        if (P.chain === ch.key && P.status === 'open' && P.kind !== 'fables' && lc(P.wallet) === who) owner.set(P.id, address);
      }
      for (const r of await v3Rows(ch, {}, owner, { noEntry: true })) {
        if (r.value_usd === null) { errors[ch.key + ' #' + r.id] = 'unpriced'; continue; }
        out.push({ chain: ch.key, id: r.id, pair: r.pair, value_usd: r.value_usd,
          liquidity_usd: r.liquidity_usd, fees_usd: r.fees_mine ? r.fees_usd : 0, in_range: r.in_range });
      }
    } catch (e) { errors[ch.key + ' LP'] = String((e && e.message) || e).slice(0, 120); }
    return out;
  })).then((lists) => lists.flat());

  const rawP = Promise.all(Object.entries(VAULT.chains).map(async ([chain, c]) => {
    try {
      const [nat, r] = await Promise.all([
        rpc(c.rpc, 'eth_getBalance', [address, 'latest']),
        multi(c.rpc, c.tokens.map((t) => ({ to: t.a, data: '0x70a08231' + pad(address) }))),
      ]);
      const got = [[c.native, BigInt(nat)]];
      c.tokens.forEach((t, i) => { got.push([t, toBig(w(requiredRead(r[i], 1, chain + ' ' + t.s + ' balance'), 0))]); });
      return got.map(([t, raw]) => ({ chain, t, amount: Number(raw) / 10 ** t.d }));
    } catch (e) { errors[chain + ' wallet'] = String((e && e.message) || e).slice(0, 120); return []; }
  })).then((lists) => lists.flat());

  /* Fables ranges and veFABLES locks held by this wallet */
  const fabP = fablesRead(fables || FABLES.seed).catch((e) => { errors.fables = String((e && e.message) || e).slice(0, 120); return { rows: [], locks: [] }; });
  const [px, positions, raw, fab] = await Promise.all([pricesP, positionsP, rawP, fabP]);
  for (const r of fab.rows.filter((x) => lc(x.wallet) === who)) {
    if (r.value_usd === null) { errors['fables ' + r.id] = 'unpriced'; continue; }
    positions.push({ chain: r.chain, id: r.id, pair: r.pair, protocol: 'Fables', value_usd: r.value_usd,
      liquidity_usd: r.liquidity_usd, fees_usd: r.fees_usd || 0, in_range: r.in_range });
  }
  const locks = fab.locks.filter((l) => {
    if (lc(l.wallet) !== who) return false;
    if (!Number.isFinite(l.value_usd)) { errors['Fables lock ' + l.id] = 'unpriced'; return false; }
    return true;
  });
  const balances = [];
  for (const b of raw) {
    if (!(b.amount > 0)) continue;
    if (px[b.t.px] === undefined) { errors[b.chain + ' ' + b.t.s] = 'no price'; continue; }
    balances.push({ chain: b.chain, sym: b.t.s, amount: b.amount, usd: r2(b.amount * px[b.t.px]) });
  }

  const lp = positions.reduce((s2, p) => s2 + p.value_usd, 0);
  const loose = balances.reduce((s2, b) => s2 + b.usd, 0);
  const lockUsd = locks.reduce((s2, l) => s2 + l.value_usd, 0);
  return {
    address, total_usd: r2(lp + loose + lockUsd), lp_usd: r2(lp), wallet_usd: r2(loose), locks_usd: r2(lockUsd),
    positions, balances, locks, prices: px,
    complete: Object.keys(errors).length === 0,
    errors: Object.keys(errors).length ? errors : undefined,
    at: new Date().toISOString(),
  };
}
