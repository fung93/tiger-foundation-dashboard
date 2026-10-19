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

export async function rpc(url, method, params) {
  /* The public nodes drop a connection now and then; a figure that fails because of one
     reset socket is a figure nobody trusts, so every call gets a few attempts. */
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 250 * (i + 1))); }
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
function decodeAgg3(hex) {
  const h = hex.replace(/^0x/, '');
  const W = (i) => h.substr(i * 64, 64);
  const n = parseInt(W(1), 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    const el = parseInt(W(2 + i), 16) / 32 + 2;
    const ok = parseInt(W(el), 16) === 1;
    const dOff = parseInt(W(el + 1), 16) / 32 + el;
    const dLen = parseInt(W(dOff), 16);
    out.push({ ok, data: '0x' + h.substr((dOff + 1) * 64, dLen * 2) });
  }
  return out;
}
export const multi = async (url, calls, tag = 'latest') =>
  calls.length ? decodeAgg3(await rpc(url, 'eth_call', [{ to: CFG.multicall, data: encodeAgg3(calls) }, tag])) : [];

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
    const bal = Number(toBig(w(await rpc(ch.rpc, 'eth_call',
      [{ to: ch.npm, data: '0x70a08231' + pad(address) }, 'latest']), 0)));
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
      r.forEach((x) => { if (x.ok) out.push([String(toBig(w(x.data, 0))), address]); });
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
    const d = r[i * 2 + 1] && r[i * 2 + 1].ok ? Number(toBig(w(r[i * 2 + 1].data, 0))) : 18;
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
    if (!res || !res.ok) return;
    const d = res.data;
    const liq = toBig(w(d, 7)), owed0 = toBig(w(d, 10)), owed1 = toBig(w(d, 11));
    if (liq === 0n && owed0 === 0n && owed1 === 0n) return;   /* closed */
    const own = posRes[k * 2 + 1];
    const ownerNow = own && own.ok ? lc(toAddr(w(own.data, 0))) : '';
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
  live.forEach((p, i) => { p.pool = poolRes[i].ok ? lc(toAddr(w(poolRes[i].data, 0))) : null; });

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
    if (!slotRes[i] || !slotRes[i].ok) return;
    const T0 = meta[p.token0], T1 = meta[p.token1];
    if (!T0 || !T1) return;

    const sqrtP = toBig(w(slotRes[i].data, 0));
    const tick = Number(toSigned(w(slotRes[i].data, 1)));
    const [a0, a1] = v3Amounts(p.liq, p.lo, p.hi, sqrtP);

    /* fees already owed, plus everything earned since the position was last touched */
    let f0 = p.owed0, f1 = p.owed1;
    const got = (k) => slotRes[i + k] && slotRes[i + k].ok;
    if (got(1) && got(2) && got(3) && got(4)) {
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
        const arr = await (await fetch(CFG.merklApi + '/users/' + address + '/rewards?chainId=' + ch.merklChain)).json();
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
  return { total_usd: r2(total), lp_usd: r2(lp), earned_by_id: byId, earned_tokens_by_id: tokensById,
    claimed_tokens_by_id: claimedById, wallet_by_id: walletById,
    token_price: tokenPrice, error: failed || undefined };
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
/* 2: tracking starts at each chain's current positions' own mint, not at a photograph */
export const BOOK_VERSION = 2;
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
  if (!entry.pool || !entry.other || !sp) return null;
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
    if (!e.pool) continue;
    (byChain[e.chain] = byChain[e.chain] || []).push([k, e]);
  }
  await Promise.all(Object.entries(byChain).map(async ([chain, list]) => {
    const ch = chainOf(chain);
    const pools = [...new Set(list.map(([, e]) => e.pool))];
    try {
      const r = await multi(ch.rpc, pools.map((p) => ({ to: p, data: '0x3850c7bd' })));
      const sp = {};
      pools.forEach((p, i) => { if (r[i] && r[i].ok) sp[p] = Number(toBig(w(r[i].data, 0))) / 2 ** 96; });
      for (const [k, e] of list) { const v = priceFromSqrt(e, sp[e.pool]); if (v) out[k] = v; }
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
    const blk = await rpc(ch.rpc, 'eth_getBlockByNumber', [hx(start + 1), false]);
    const ts = Number(BigInt(blk.timestamp));
    book.last_block[ch.key] = start;
    book.started.blocks[ch.key] = start;
    book.started.chains[ch.key] = { block: start, ts, iso: new Date(ts * 1000).toISOString(), positions: opened };
  }
  const first = Math.min(...Object.values(book.started.chains).map((c) => c.ts));
  book.started.ts = first;
  book.started.iso = new Date(first * 1000).toISOString();
  book.fee_series.push({ ts: first, tokens: {} });
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

async function applyWindow(book, ch, a, b, merkl, tsCache) {
  const walletTopics = book.wallets.map((x) => '0x' + pad(x));
  const nowTs = Math.floor(Date.now() / 1000);

  /* 1. mints to any tracked wallet: positions the book has not met yet */
  const mints = await rpc(ch.rpc, 'eth_getLogs', [{ address: ch.npm, fromBlock: hx(a), toBlock: hx(b),
    topics: [TRANSFER, ZERO32, walletTopics] }]);
  const fresh = mints.map((l) => ({ id: String(toBig(l.topics[3].slice(2))), wallet: toAddr(l.topics[2].slice(2)),
    block: Number(toBig(l.blockNumber.slice(2))), ts: l.blockTimestamp && l.blockTimestamp !== '0x0' ? Number(BigInt(l.blockTimestamp)) : null }))
    .filter((m) => !book.positions[ch.key + ':' + m.id]);
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
  const watch = Object.values(book.positions).filter((P) => P.chain === ch.key
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
        sumInto(P.fees, { [P.t0]: Number(c0 - p0) / 10 ** P.d0, [P.t1]: Number(c1 - p1) / 10 ** P.d1 });
      }
    }
  }

  /* 3. a position that closed in this window is written into history now, at the prices of
     the block it closed in, and does not change again */
  for (const P of closedNow) await freeze(book, ch, P, merkl);
}

async function freeze(book, ch, P, merkl) {
  if (merkl && merkl.earned_tokens_by_id && merkl.earned_tokens_by_id[P.id]) P.merkl = { ...merkl.earned_tokens_by_id[P.id] };
  const tokens = feeTokensOf(P, null);
  let sp = P.close_sp || null;
  if (!sp && P.pool) sp = await sqrtAt(ch, P.pool, P.closed_block);
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
export async function advanceBook(input, { merkl, maxWindows = 60, pos, data } = {}) {
  const book = JSON.parse(JSON.stringify(input));
  const errors = {}, behind = {};

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
        await applyWindow(book, ch, from, to, merkl, tsCache);
        book.last_block[ch.key] = to;
        from = to + 1;
      }
      behind[ch.key] = Math.max(0, head - book.last_block[ch.key]);
    } catch (e) {
      Object.assign(book, JSON.parse(before));
      errors[ch.key] = String((e && e.message) || e).slice(0, 160);
    }
  }
  /* Merkl keeps settling a position's rewards for a while after it closes, so every
     position's earned total is refreshed; only the frozen history row stays put. */
  if (merkl && merkl.earned_tokens_by_id) {
    for (const P of Object.values(book.positions)) {
      const t = merkl.earned_tokens_by_id[P.id];
      if (t && chainOf(P.chain).yield === 'merkl') P.merkl = { ...t };
    }
  }
  return { book, errors, behind };
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
      .filter((P) => P.chain === ch.key && P.status === 'open').map((P) => [P.id, P.wallet]));
    if (!owner.size) return;
    try {
      for (const r of await v3Rows(ch, {}, owner, { noEntry: true })) rows[ch.key + ':' + r.id] = r;
    } catch (e) { errors[ch.key] = String((e && e.message) || e).slice(0, 160); }
  }));
  return { rows, errors };
}

/* every fee token earned since the start, across the whole book, at this moment */
export function feeTotals(book, rows) {
  const total = carriedTokens(book);
  for (const P of Object.values(book.positions)) sumInto(total, feeTokensOf(P, uncollectedOf(P, rows[P.key])));
  return total;
}

/* ---------- the page's view: every card, finished ---------- */
export function bookView(book, { rows, prices, merkl, errors, behind }) {
  const usdOf = (tokens) => {
    let v = 0; const missing = [];
    for (const [k, a] of Object.entries(tokens || {})) {
      if (prices[k] === undefined) missing.push(k); else v += a * prices[k];
    }
    return { usd: r2(v), missing };
  };
  const chains = {};
  const touch = (c) => chains[c] || (chains[c] = { value_usd: 0, pnl_usd: 0, realised_usd: 0, unrealised_usd: 0,
    fees_usd: 0, open: 0, closed: 0 });
  V3.forEach((c) => touch(c.key));

  let value = 0, realised = 0, unrealised = 0;
  const live = [], history = [], unread = [];
  /* rewards claimable when tracking began, to each chain they were earned on */
  const carried = carriedTokens(book);
  const feeTokens = { ...carried };
  for (const [k, a] of Object.entries(carried)) touch(k.split('@')[1]).fees_usd += usdOf({ [k]: a }).usd;
  for (const P of Object.values(book.positions)) {
    const C = touch(P.chain);
    const row = rows[P.key];
    const tokens = feeTokensOf(P, uncollectedOf(P, row));
    sumInto(feeTokens, tokens);
    C.fees_usd += usdOf(tokens).usd;
    if (P.status === 'open') {
      C.open++;
      if (!row || row.liquidity_usd === null) { unread.push(P.key); continue; }
      const u = row.liquidity_usd + P.out_usd - P.cost_usd;
      value += row.liquidity_usd; unrealised += u;
      C.value_usd += row.liquidity_usd; C.unrealised_usd += u; C.pnl_usd += u;
      const view = widgetView(row, merkl);
      /* the widget's yield is all-time; the book's is since tracking began */
      const earned = usdOf(tokens).usd;
      view.yield_value = money(earned);
      view.pnl = signed(u); view.pnl_up = u >= 0;
      view.net = signed(u + earned); view.net_up = u + earned >= 0;
      view.cost = money(P.cost_usd);
      view.since = (P.at_start ? 'tracked since ' : 'opened ') + new Date(P.opened_ts * 1000).toISOString().slice(0, 10);
      live.push(view);
    } else {
      C.closed++;
      const f = P.frozen || { pnl_usd: r2(P.out_usd - P.cost_usd), fee_usd: 0, net_usd: r2(P.out_usd - P.cost_usd) };
      realised += f.pnl_usd; C.realised_usd += f.pnl_usd; C.pnl_usd += f.pnl_usd;
      history.push({
        chain: P.chain, id: P.id, pair: P.pair, wallet: walletLabel(P.wallet),
        opened: P.opened_ts ? new Date(P.opened_ts * 1000).toISOString() : null,
        closed: P.closed_ts ? new Date(P.closed_ts * 1000).toISOString() : null,
        held_hours: P.opened_ts && P.closed_ts ? r2((P.closed_ts - P.opened_ts) / 3600) : null,
        at_start: P.at_start,
        cost_usd: f.cost_usd !== undefined ? f.cost_usd : r2(P.cost_usd),
        principal_usd: f.principal_usd !== undefined ? f.principal_usd : r2(P.out_usd),
        pnl_usd: f.pnl_usd, fee_usd: f.fee_usd, fee_tokens: f.fee_tokens || {},
        net_usd: f.net_usd, net_pct: f.net_pct === undefined ? null : f.net_pct,
        incomplete: !!f.incomplete,
      });
    }
  }
  for (const c of Object.values(chains)) for (const k of Object.keys(c)) if (typeof c[k] === 'number' && k.endsWith('_usd')) c[k] = r2(c[k]);
  history.sort((x, y) => String(y.closed).localeCompare(String(x.closed)));
  live.sort((x, y) => (x.chain + x.id).localeCompare(y.chain + y.id));

  const feeNow = usdOf(feeTokens);
  /* the fee curve, every point repriced at today's prices: it shows how much was earned
     by when, in what the tokens are worth now, and can fall on a day prices fall */
  const nowTs = Math.floor(Date.now() / 1000);
  const series = book.fee_series.map((p) => ({ ts: p.ts, usd: usdOf(p.tokens).usd }));
  series.push({ ts: nowTs, usd: feeNow.usd, live: true });

  const pairs = rebalances(book.events);
  return {
    started: book.started,
    wallets: book.wallets.map((a) => ({ address: a, label: walletLabel(a) })),
    cards: {
      value_usd: r2(value),
      pnl_usd: r2(realised + unrealised), realised_usd: r2(realised), unrealised_usd: r2(unrealised),
      chains,
      fees_usd: feeNow.usd, fee_tokens: feeTokens,
      fee_tokens_usd: Object.fromEntries(Object.entries(feeTokens).map(([k, a]) => [k, prices[k] === undefined ? null : r2(a * prices[k])])),
      carried_usd: usdOf(carried).usd, carried_tokens: carried,
      rebalances: pairs.length,
    },
    rebalances: pairs.slice().reverse(),
    live, history, series, prices,
    health: {
      errors: errors || {}, behind: behind || {}, unread,
      unpriced: feeNow.missing,
      last_run: (book.runs || []).slice(-1)[0] || null,
    },
  };
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

export async function vaultValue(address = VAULT.address, { book } = {}) {
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
        if (P.chain === ch.key && P.status === 'open' && lc(P.wallet) === who) owner.set(P.id, address);
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
      c.tokens.forEach((t, i) => { if (r[i] && r[i].ok) got.push([t, toBig(w(r[i].data, 0))]); });
      return got.map(([t, raw]) => ({ chain, t, amount: Number(raw) / 10 ** t.d }));
    } catch (e) { errors[chain + ' wallet'] = String((e && e.message) || e).slice(0, 120); return []; }
  })).then((lists) => lists.flat());

  const [px, positions, raw] = await Promise.all([pricesP, positionsP, rawP]);
  const balances = [];
  for (const b of raw) {
    if (!(b.amount > 0)) continue;
    if (px[b.t.px] === undefined) { errors[b.chain + ' ' + b.t.s] = 'no price'; continue; }
    balances.push({ chain: b.chain, sym: b.t.s, amount: b.amount, usd: r2(b.amount * px[b.t.px]) });
  }

  const lp = positions.reduce((s2, p) => s2 + p.value_usd, 0);
  const loose = balances.reduce((s2, b) => s2 + b.usd, 0);
  return {
    address, total_usd: r2(lp + loose), lp_usd: r2(lp), wallet_usd: r2(loose),
    positions, balances, prices: px,
    complete: Object.keys(errors).length === 0,
    errors: Object.keys(errors).length ? errors : undefined,
    at: new Date().toISOString(),
  };
}
