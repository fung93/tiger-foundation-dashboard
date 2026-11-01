/* ============================================================================
   kat-core.mjs: the KAT trading book. Pure maths shared by the KAT page, its API
   (api/kat-trades.mjs) and the six-hourly job (scripts/kat-trades.mjs). No network:
   the one function that needs receipts is handed a reader.

   A trade is KAT swapped against a stablecoin by one of Alex's wallets on Katana. His
   history (Oct 2026) shows two shapes, and both are found:
   - in one transaction: KAT and a stablecoin move opposite ways (a router swap, a filled
     limit order);
   - across two: the wallet sends one token to a one-time deposit address, and a later
     transaction, sent by someone else, moves that address's tokens on and pays the wallet
     the other (the swap service he uses on Katana). Only a whole deposit counts: a service
     that filled one in parts would leave it unmatched, and the page says a KAT deposit is
     still waiting.
   Transfers with a lending, staking or reward contract are never trades: borrowing or
   repaying KAT, avKAT deposits, Merkl claims and LPs stay off this page.

   The book is average cost, long only, from 27 Oct 2026 16:02 MYT (Alex's choice, 1 Nov).
   ========================================================================== */

export const CHAIN = 747474;
export const KAT = '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d';
export const KAT_DECIMALS = 18;
export const KAT_POOL = '0x10045367e619caae6f60cc80046c43c6cd55f629';   /* Sushi KAT/vbUSDC 0.05%: vbUSDC token0 (6), KAT token1 (18) */
export const ETH_POOL = '0x2a2c512beaa8eb15495726c235472d82effb7a6b';   /* vbUSDC token0 (6), vbETH token1 (18): prices the gas */
export const WALLETS = ['0xb378207ab46aa2105eb1cb94ae8a5bab57316de1', '0x4da1d0d5f7b123364d7580f19b716de2ed4e9770'];
/* the first buy after the 26 Oct sales: 25 vbUSDC for 5,978.85 KAT, 27 Oct 2026 16:02:35 MYT */
export const START = { block: 46345344, ts: 1793088155 };
export const STABLES = {
  '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36': { symbol: 'vbUSDC', decimals: 6 },
  '0x2dca96907fde857dd3d816880a0df407eeb2d2f2': { symbol: 'vbUSDT', decimals: 6 },
};
/* contracts whose transfers are never trades: they lend, stake, pay rewards or hold LPs */
export const NOT_TRADES = new Set([
  '0xd50f2dfffd62f94ee4aed9ca05c61d0753268abc',   /* Morpho Blue */
  '0xa8c5e23c9c0df2b6ff716486c6bbebb6661548c8',   /* Morpho Bundler3 */
  '0x916aa175c36e845db45ff6ddb886ae437d403b61',   /* its general adapter */
  '0x7231dbacdfc968e07656d12389ab20de82fbfceb',   /* avKAT vault */
  '0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae',   /* Merkl distributor */
  '0x2659c6085d26144117d904c46b48b6d180393d27',   /* Sushi V3 positions (NPM) */
  '0xbe12e1b5c4859a3d141412748279b67458f729e9',   /* Sushi LP staker */
]);
/* where the swap routes he uses take their cut, read off his Oct 2026 trades */
export const FEE_TAKERS = {
  '0x631002609ac3d88097d31c8aec7ea48cf4c9c648': 'Service fee',
  '0x76008498f26789dd8b691bebe24c889a3dd1a2fc': 'Relayer fee',
  '0x000e474c0d7084eaa35a501035e73269f4b009a5': 'Order fee',
  '0x69a3136b94daa2dd4a76c5c1560e0d95dc9022ba': 'Router fee',
  '0xd97c3d4e6f36d0aed73cf3bc83d38b9ce4ba91bc': 'Router fee',
  '0x5c2e112783a6854653b4bc7dc22248d3e592559c': 'Router fee',
};
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const PENDING_SECONDS = 3 * 86400;   /* a deposit not paid back within three days was not a trade */
export const HOUR = 3600;

const lc = (a) => String(a || '').toLowerCase();
const addr = (topic) => '0x' + topic.slice(26).toLowerCase();
const decimalsOf = (token) => (token === KAT ? KAT_DECIMALS : STABLES[token] ? STABLES[token].decimals : null);
export const isWallet = (a) => WALLETS.includes(lc(a));

/* a raw token amount as a number of whole tokens, exact to the last unit that a double keeps */
export function units(raw, decimals) {
  const v = BigInt(raw), scale = 10n ** BigInt(decimals);
  return Number(v / scale) + Number(v % scale) / Number(scale);
}

/* a V3 pool quoted vbUSDC (token0, 6 decimals) against an 18-decimal token1: dollars per token1 */
export const usdAtTick = (tick) => 1e12 / Math.pow(1.0001, tick);
export const usdFromSqrt = (sqrtPriceX96) => { const s = Number(sqrtPriceX96) / 2 ** 96; return s > 0 ? 1e12 / (s * s) : null; };

/* an ERC-20 Transfer log (three topics; an NFT's has four) as { token, from, to, raw } */
function rawTransfer(log) {
  if (!log || !log.topics || log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) return null;
  return { token: lc(log.address), from: addr(log.topics[1]), to: addr(log.topics[2]), raw: BigInt(log.data).toString() };
}

/* the same with where and when: { hash, block, index, ts, token, from, to, raw } */
export function transferFromLog(log) {
  const t = rawTransfer(log);
  if (!t) return null;
  if (!log.blockTimestamp || log.blockTimestamp === '0x0') throw new Error('A transfer log came without its block time');
  return { hash: lc(log.transactionHash), block: Number(BigInt(log.blockNumber)), index: Number(BigInt(log.logIndex)), ts: Number(BigInt(log.blockTimestamp)), ...t };
}

/* the wallets' transfers, one entry per transaction in chain order, each leg seen from the
   wallet: + in, - out. A transfer between the two wallets moves nothing and is dropped. */
export function walletTxs(transfers) {
  const seen = new Set(), byTx = new Map();
  for (const t of [...transfers].sort((a, b) => a.block - b.block || a.index - b.index)) {
    const key = t.hash + ':' + t.index;
    if (seen.has(key)) continue;
    seen.add(key);
    const fromW = isWallet(t.from), toW = isWallet(t.to);
    if (fromW === toW) continue;
    const d = decimalsOf(t.token);
    if (d === null) continue;
    const tx = byTx.get(t.hash) || { hash: t.hash, block: t.block, index: t.index, ts: t.ts, legs: [] };
    tx.legs.push({ token: t.token, amount: units(t.raw, d) * (toW ? 1 : -1), counterparty: toW ? t.from : t.to });
    byTx.set(t.hash, tx);
  }
  return [...byTx.values()];
}

/* the service fees inside a receipt, in dollars at the trade's own price, plus the gas the
   wallet paid for its own transactions in the trade */
function feesOf(receipts, katUsd, ethUsd, own) {
  const parts = [];
  let usd = 0, gasEth = 0;
  for (const rc of receipts) {
    if (!rc) continue;
    for (const l of rc.logs || []) {
      const t = rawTransfer(l);
      if (!t || !FEE_TAKERS[t.to]) continue;
      const d = decimalsOf(t.token);
      if (d === null) continue;
      const amount = units(t.raw, d), value = t.token === KAT ? amount * katUsd : amount;
      parts.push({ what: FEE_TAKERS[t.to], token: t.token === KAT ? 'KAT' : STABLES[t.token].symbol, amount, usd: value });
      usd += value;
    }
  }
  for (const rc of own) if (rc && isWallet(rc.from)) gasEth += Number(BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice)) / 1e18;
  const gasUsd = Number.isFinite(ethUsd) ? gasEth * ethUsd : 0;
  return { usd: usd + gasUsd, gas_eth: gasEth, gas_usd: gasUsd, parts };
}

const sumLegs = (legs, pick) => legs.filter(pick).reduce((s, l) => s + l.amount, 0);
const isStable = (token) => !!STABLES[token];

/* Walk the wallets' transactions in chain order and add what they trade to the book.
   state = { trades, pending }; getReceipt(hash) reads a receipt; ethUsd prices the gas. The
   deposits still waiting to be paid back carry over to the next run in state.pending. */
export async function scanTrades(state, txs, { getReceipt, ethUsd }) {
  const trades = [...(state.trades || [])], pending = [...(state.pending || [])].map((p) => ({ ...p }));
  const known = new Set(trades.flatMap((t) => [t.hash, t.deposit_hash].filter(Boolean)));
  for (const tx of txs) {
    if (known.has(tx.hash)) continue;
    const legs = tx.legs.filter((l) => !NOT_TRADES.has(l.counterparty));
    if (!legs.length) continue;
    const kat = sumLegs(legs, (l) => l.token === KAT), usd = sumLegs(legs, (l) => isStable(l.token));
    const stableToken = (legs.find((l) => isStable(l.token)) || {}).token;

    /* one transaction: KAT one way, a stablecoin the other */
    if ((kat > 0 && usd < 0) || (kat < 0 && usd > 0)) {
      const rc = await getReceipt(tx.hash);
      const side = kat > 0 ? 'buy' : 'sell', k = Math.abs(kat), u = Math.abs(usd);
      trades.push({ hash: tx.hash, deposit_hash: null, block: tx.block, ts: tx.ts, side, kat: k, usd: u,
        token: STABLES[stableToken].symbol, route: 'swap', fees: feesOf([rc], u / k, ethUsd, [rc]) });
      known.add(tx.hash);
      continue;
    }

    const ins = legs.filter((l) => l.amount > 0), outs = legs.filter((l) => l.amount < 0);
    /* the wallet only sends: perhaps a deposit, to be paid back later */
    if (!ins.length) {
      for (const l of outs) if (l.token === KAT || isStable(l.token)) {
        pending.push({ to: l.counterparty, token: l.token, amount: -l.amount, block: tx.block, ts: tx.ts, hash: tx.hash });
      }
      continue;
    }
    /* the wallet only receives: a deposit paid back? Its receipt shows the deposit address
       passing on what the wallet sent it, 98-100% (the rest is the service's cut). A pool
       the wallet added liquidity to also "received" from it, but never hands the same
       amount on in someone's swap, so the amount is the test, not just the address. */
    if (!outs.length) {
      const got = ins.filter((l) => l.token === KAT || isStable(l.token));
      if (!got.length) continue;
      const gotKat = got.some((l) => l.token === KAT);
      const waiting = pending.filter((p) => (gotKat ? isStable(p.token) : p.token === KAT) && tx.ts >= p.ts && tx.ts - p.ts <= PENDING_SECONDS);
      if (!waiting.length) continue;
      const rc = await getReceipt(tx.hash);
      const sent = new Map();
      for (const t of (rc.logs || []).map(rawTransfer).filter(Boolean)) sent.set(t.from + t.token, (sent.get(t.from + t.token) || 0n) + BigInt(t.raw));
      const p = waiting.find((w) => {
        const out = sent.get(w.to + w.token);
        if (!out) return false;
        const u = units(out, decimalsOf(w.token));
        return u >= w.amount * 0.98 && u <= w.amount * 1.000001;
      });
      if (!p) continue;
      const received = sumLegs(got, (l) => (gotKat ? l.token === KAT : isStable(l.token)));
      const own = await getReceipt(p.hash);
      const side = gotKat ? 'buy' : 'sell';
      const k = gotKat ? received : p.amount, u = gotKat ? p.amount : received;
      trades.push({ hash: tx.hash, deposit_hash: p.hash, block: tx.block, ts: tx.ts, side, kat: k, usd: u,
        token: STABLES[gotKat ? p.token : got.find((l) => isStable(l.token)).token].symbol, route: 'deposit',
        fees: feesOf([rc], u / k, ethUsd, [own]) });
      pending.splice(pending.indexOf(p), 1);
      known.add(tx.hash);
    }
  }
  return { trades, pending };
}

/* drop deposits too old to be paid back now */
export const prunePending = (pending, now) => pending.filter((p) => now - p.ts <= PENDING_SECONDS);

/* fold KAT/vbUSDC swaps ({ ts, tick }) into hourly closing ticks [[hour, tick], …] */
export function mergeCloses(hours, swaps) {
  const map = new Map((hours || []).map((h) => [h[0], h[1]]));
  for (const s of swaps) if (Number.isFinite(s.ts) && Number.isInteger(s.tick)) map.set(Math.floor(s.ts / HOUR) * HOUR, s.tick);
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

/* ---------------------------------------------------------------------------
   The book: average cost, long only. A buy adds its KAT and its cost; a sell takes KAT
   out at the average cost so far and books the difference as realised. A sell of more
   KAT than the book holds came partly from outside it (rewards, borrowing): that part is
   kept out of the P&L and shown as such.
   --------------------------------------------------------------------------- */
export const byTime = (a, b) => a.block - b.block || a.ts - b.ts;

export function replay(trades) {
  let qty = 0, cost = 0, realized = 0;
  const rows = [];
  for (const t of [...trades].sort(byTime)) {
    const price = t.usd / t.kat;
    if (t.side === 'buy') {
      qty += t.kat; cost += t.usd;
      rows.push({ ...t, price, basis: t.usd, realized: null, outside: 0, qty, cost, avg: cost / qty });
      continue;
    }
    const k = Math.min(t.kat, qty), avg = qty > 0 ? cost / qty : 0, basis = k * avg;
    const pnl = k > 0 ? t.usd * (k / t.kat) - basis : 0;
    realized += pnl; cost -= basis; qty -= k;
    if (qty <= 1e-9) { qty = 0; cost = 0; }
    rows.push({ ...t, price, basis, realized: k > 0 ? pnl : null, outside: t.kat - k, qty, cost, avg: qty > 0 ? cost / qty : null });
  }
  return { rows, qty, cost, realized };
}

export function summary(trades, priceUsd) {
  const r = replay(trades);
  const value = r.qty * priceUsd, unrealized = r.qty > 0 ? value - r.cost : 0;
  const side = (s) => trades.filter((t) => t.side === s).reduce((a, t) => ({ n: a.n + 1, kat: a.kat + t.kat, usd: a.usd + t.usd }), { n: 0, kat: 0, usd: 0 });
  return { ...r, avg: r.qty > 0 ? r.cost / r.qty : null, value, unrealized, total: r.realized + unrealized,
    bought: side('buy'), sold: side('sell'), fees: trades.reduce((s, t) => s + ((t.fees && t.fees.usd) || 0), 0) };
}

/* A plan of trades not made yet, run after the real ones at the prices given: each step is
   { side: 'buy', usd, price } (spend dollars) or { side: 'sell', kat, price } (sell KAT).
   Returns the book before and after (valued at priceNow), each step's fills, and the
   break-even price: the KAT price at which the total P&L would be zero. */
export function simulate(trades, plan, priceNow) {
  const last = trades.reduce((m, t) => Math.max(m, t.block, t.ts), 0);
  const steps = [];
  for (const p of plan) {
    if (!(p.price > 0)) continue;
    if (p.side === 'buy' && p.usd > 0) steps.push({ side: 'buy', kat: p.usd / p.price, usd: p.usd });
    else if (p.side === 'sell' && p.kat > 0) steps.push({ side: 'sell', kat: p.kat, usd: p.kat * p.price });
  }
  steps.forEach((s, i) => { s.block = last + 1 + i; s.ts = last + 1 + i; s.fees = { usd: 0, parts: [] }; s.planned = true; });
  const before = summary(trades, priceNow), after = summary(trades.concat(steps), priceNow);
  const rows = replay(trades.concat(steps)).rows.filter((r) => r.planned);
  const breakEven = (b) => (b.qty > 0 ? Math.max(0, (b.cost - b.realized) / b.qty) : null);
  return { before: { ...before, breakEven: breakEven(before) }, after: { ...after, breakEven: breakEven(after) }, rows };
}

/* P&L through time: one point at the end of every hour (valued at that hour's closing
   price, carried over hours without a swap), one at every trade (valued at its own price)
   and one now. Starts at the first trade. */
export function pnlSeries(trades, hours, { now, priceUsd }) {
  const list = [...trades].sort(byTime);
  if (!list.length) return [];
  const t0 = list[0].ts, closes = (hours || []).filter((h) => h[0] + HOUR > t0);
  const points = [];
  for (const t of list) points.push({ ts: t.ts, price: t.usd / t.kat, trade: t });
  let h = Math.floor(t0 / HOUR) * HOUR, ci = 0, tick = null;
  for (const c of hours || []) if (c[0] < h) tick = c[1];
  for (; h + HOUR < now; h += HOUR) {
    while (ci < closes.length && closes[ci][0] <= h) { tick = closes[ci][1]; ci++; }
    if (h + HOUR > t0 && tick !== null) points.push({ ts: h + HOUR, price: usdAtTick(tick) });
  }
  if (Number.isFinite(priceUsd)) points.push({ ts: now, price: priceUsd });
  points.sort((a, b) => a.ts - b.ts || (a.trade ? -1 : 0) - (b.trade ? -1 : 0));
  let qty = 0, cost = 0, realized = 0, next = 0;
  const out = [];
  for (const p of points) {
    while (next < list.length && (list[next] === p.trade || list[next].ts < p.ts)) {
      const t = list[next++];
      if (t.side === 'buy') { qty += t.kat; cost += t.usd; }
      else { const k = Math.min(t.kat, qty), avg = qty > 0 ? cost / qty : 0; if (k > 0) realized += t.usd * (k / t.kat) - k * avg; cost -= k * avg; qty -= k; if (qty <= 1e-9) { qty = 0; cost = 0; } }
    }
    const unrealized = qty > 0 ? qty * p.price - cost : 0;
    out.push({ ts: p.ts, price: p.price, qty, realized, unrealized, total: realized + unrealized, trade: p.trade ? p.trade.side : null });
  }
  return out;
}

/* the ledger file the job keeps, checked before anything is added to it */
export const emptyBook = () => ({ version: 1, chain: CHAIN, start: { ...START }, last_block: START.block - 1, last_ts: START.ts, trades: [], pending: [], hours: [] });

export function validateBook(f) {
  const fail = (why) => { throw new Error('Invalid KAT trades file: ' + why + '. Existing file was not changed.'); };
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!f || typeof f !== 'object' || Array.isArray(f)) fail('expected an object');
  if (f.version !== 1 || f.chain !== CHAIN) fail('unsupported version or chain');
  if (!f.start || f.start.block !== START.block || f.start.ts !== START.ts) fail('the start moved');
  if (!Number.isSafeInteger(f.last_block) || f.last_block < START.block - 1 || !Number.isSafeInteger(f.last_ts)) fail('bad last block');
  if (!Array.isArray(f.trades) || !Array.isArray(f.pending) || !Array.isArray(f.hours)) fail('trades, pending and hours must be lists');
  const hashes = new Set();
  for (const t of f.trades) {
    if (!t || !/^0x[0-9a-f]{64}$/.test(t.hash) || hashes.has(t.hash) || !['buy', 'sell'].includes(t.side) || !(t.kat > 0) || !(t.usd > 0)
      || !Number.isSafeInteger(t.block) || t.block < START.block || !Number.isSafeInteger(t.ts) || !t.fees || !num(t.fees.usd)) fail('bad trade ' + (t && t.hash));
    hashes.add(t.hash);
  }
  for (const p of f.pending) if (!p || !/^0x[0-9a-f]{40}$/.test(p.to) || !(p.amount > 0) || !Number.isSafeInteger(p.ts) || !/^0x[0-9a-f]{64}$/.test(p.hash)) fail('bad pending deposit');
  let prev = -Infinity;
  for (const h of f.hours) {
    if (!Array.isArray(h) || h.length !== 2 || !Number.isSafeInteger(h[0]) || !Number.isSafeInteger(h[1]) || h[0] % HOUR || h[0] <= prev) fail('bad hour row');
    prev = h[0];
  }
  return f;
}
