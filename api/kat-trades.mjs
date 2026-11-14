/* ============================================================================
   api/kat-trades: Alex's KAT trades since 27 Oct 2026, for the KAT page.

   The job's ledger (kat-trades.json, every six hours) plus everything since its last
   block, read here: the wallets' transfers (trades are found from them with kat-core.mjs),
   the KAT/vbUSDC pool's swaps (the hourly closing price the chart is valued at), and the
   price now from the pool's slot0. The page does the book itself, with kat-core.mjs.

   Read-only: no keys, no wallet, nothing signed.
   ========================================================================== */
import { CFG, multi, rpc } from './_core.mjs';
import { KAT, KAT_POOL, ETH_POOL, WALLETS, START, TRANSFER_TOPIC, emptyBook, validateBook, transferFromLog, walletTxs,
  scanTrades, prunePending, mergeCloses, usdFromSqrt, flowsOf, addFlows } from '../kat-core.mjs';
import { swapFromLog, SWAP_TOPIC } from '../strategy-core.mjs';

const RPC = CFG.katRpc;
const WALLET_SPAN = 250000, SWAP_SPAN = 100000;   /* about 3,000 pool swaps a day on 1 Nov 2026 */
const hex = (n) => '0x' + n.toString(16);
const pad = (a) => '0x' + a.slice(2).padStart(64, '0');

/* the KAT both wallets hold now; null if either cannot be read */
export async function walletKat() {
  const r = await multi(RPC, WALLETS.map((w) => ({ to: KAT, data: '0x70a08231' + pad(w).slice(2) })));
  return r.every((x) => x.ok) ? r.reduce((s, x) => s + Number(BigInt(x.data.slice(0, 66))) / 1e18, 0) : null;
}

/* the KAT and ETH prices now, from their vbUSDC pools */
export async function pricesNow() {
  const r = await multi(RPC, [KAT_POOL, ETH_POOL].map((to) => ({ to, data: '0x3850c7bd' })));
  const read = (x) => (x && x.ok ? usdFromSqrt(BigInt('0x' + x.data.slice(2, 66))) : null);
  return { kat: read(r[0]), eth: read(r[1]) };
}

/* Move the ledger from its last block to the head: trades, deposits still waiting and
   hourly closes. The readers are passed in, so the job, this API and the tests share it. */
export async function advanceKat(file, { head, headTs, ethUsd, getLogs, getReceipt }) {
  const from = Math.max(file.last_block + 1,START.block);
  if (head < from) return file;
  const transfers = [];
  for (let a = from; a <= head; a += WALLET_SPAN) {
    const b = Math.min(head, a + WALLET_SPAN - 1);
    for (const w of WALLETS) for (const at of [1, 2]) {
      const topics = [TRANSFER_TOPIC, null, null];
      topics[at] = pad(w);
      for (const l of await getLogs({ topics, fromBlock: hex(a), toBlock: hex(b) })) { const t = transferFromLog(l); if (t) transfers.push(t); }
    }
  }
  const swaps = [];
  for (let a = from; a <= head; a += SWAP_SPAN) {
    for (const l of await getLogs({ address: KAT_POOL, topics: [SWAP_TOPIC], fromBlock: hex(a), toBlock: hex(Math.min(head, a + SWAP_SPAN - 1)) })) swaps.push(swapFromLog(l));
  }
  const scanned = await scanTrades(file, walletTxs(transfers), { getReceipt, ethUsd });
  return { ...file, last_block: head, last_ts: headTs, trades: scanned.trades, pending: prunePending(scanned.pending, headTs),
    flows: addFlows(file.flows, flowsOf(transfers)), hours: mergeCloses(file.hours, swaps) };
}

/* the chain readers, for the job and this API alike */
export function katReaders() {
  const receipts = new Map();
  return {
    getLogs: (filter) => rpc(RPC, 'eth_getLogs', [filter]),
    getReceipt: async (hash) => { if (!receipts.has(hash)) receipts.set(hash, await rpc(RPC, 'eth_getTransactionReceipt', [hash])); return receipts.get(hash); },
    tip: async () => {
      const n = Number(BigInt(await rpc(RPC, 'eth_blockNumber', [])));
      const b = await rpc(RPC, 'eth_getBlockByNumber', [hex(n), false]);
      return { head: n, headTs: Number(BigInt(b.timestamp)) };
    },
  };
}

export async function readKatTrades(saved, now = Math.floor(Date.now() / 1000)) {
  const notes = [];
  let file = emptyBook();
  if (saved) {
    try { file = validateBook(saved); }
    catch (e) { notes.push('The saved ledger could not be used (' + e.message.slice(0, 80) + '); reading from the 14 Nov reset instead.'); }
  } else notes.push('The saved ledger could not be read; reading from the 14 Nov reset instead.');
  const io = katReaders();
  const [{ head, headTs }, px, held] = await Promise.all([io.tip(), pricesNow(), walletKat()]);
  if (!(px.kat > 0)) throw new Error('KAT price could not be read');
  const behind = headTs - file.last_ts;
  if (saved && behind > 12 * 3600) notes.push(`The six-hourly ledger is ${Math.round(behind / 3600)} hours behind; the trades since were read live.`);
  const live = await advanceKat(file, { head, headTs, ethUsd: px.eth, ...io });
  return {
    at: now, head, head_ts: headTs, start: START, price_usd: px.kat, eth_usd: px.eth,
    trades: live.trades, hours: live.hours,
    /* the wallets' KAT now and what moved it besides trades, for the page's reconciliation */
    wallet_kat: held, start_kat: live.start_kat, flows: live.flows,
    /* KAT sent to a deposit address and not paid back yet: a sale in progress, or one the page cannot see */
    waiting: live.pending.filter((p) => p.token === KAT).map((p) => ({ kat: p.amount, ts: p.ts, hash: p.hash })),
    ledger_to: file.last_ts, health: { notes },
  };
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 's-maxage=15, stale-while-revalidate=15');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  /* the job's ledger, fetched from this same site as /api/strategy fetches its ranges */
  let saved = null;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host, proto = req.headers['x-forwarded-proto'] || 'https';
    const r = await fetch(proto + '://' + host + '/kat-trades.json?t=' + Date.now(), { signal: AbortSignal.timeout(8000) });
    if (r.ok) saved = await r.json();
  } catch (e) { /* read everything since the start instead */ }
  try { res.status(200).end(JSON.stringify(await readKatTrades(saved))); }
  catch (e) { res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) })); }
}
