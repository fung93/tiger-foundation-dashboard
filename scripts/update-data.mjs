/**
 * Auto-update dashboard data from Katana, Solana, Robinhood Chain and Arc.
 * Runs in GitHub Actions (Node 20+, no dependencies).
 * Writes data.json (full snapshot incl. meteora_refs for the browser's live mode)
 * and history.json (one entry per UTC date).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CFG = {
  /* Robinhood Chain (4663). Addresses discovered on-chain, not from docs — see the same
     note in index.html. No archive state here, and the public RPC rate-limits hard, so the
     Action reads it in a single multicall exactly as the browser does. */
  rhRpc: 'https://rpc.mainnet.chain.robinhood.com',
  rhNpm: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  rhFactory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  rhTokens: { USDG: { a: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', d: 6, stable: true } },
  /* Arc (5042). Addresses read off the chain and the explorer; see the Arc section below and
     the same note in index.html. Lower-case throughout — the code compares them as strings. */
  arcRpc: 'https://rpc.mainnet.arc.io',
  arcNpm: '0x39654a85a4c05127f5fd6ed22caec077a0fb1377',      // Uniswap V3 NonfungiblePositionManager
  arcFactory: '0xf0db7b58379503491d857db50ac9ece64c653918',
  arcV4Posm: '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b',   // Uniswap V4 PositionManager
  arcV4Pool: '0x8366a39cc670b4001a1121b8f6a443a643e40951',   // Uniswap V4 PoolManager
  arcV4State: '0x6e43e7be27a11956218d6882ecc0cc1bed63e31f',  // StateView bound to that PoolManager
  arcUsdc: '0x3600000000000000000000000000000000000000',     // native USDC's ERC-20 face
  arcStartBlock: 21140000,                                   // just before the wallet's first Arc transaction
  rhStartBlock: 58600000,                                    // just before the first Robinhood position (2026-09-09)
  /* Allowlist, as on Robinhood: two unsolicited airdrops (TOLLY, GIMX) and a free mint sit
     in this wallet with no market. Each token here is priced off its own USDC pool. */
  arcTokens: {
    ARGUS: { a: '0xece5ca8bf9220718e5727754026757512212cb3c', d: 18, pool: '0x6a3bacaa6493734c1ac221ebf42cf530a96c1e02' },
    Minara: { a: '0xa163d7624da3b5d9182c50eab5b8cd247ae861bb', d: 18, pool: '0xfd0dc7b3591cb578fd1affcd652ca6e2907c63e9' },
  },
  rpcs: ['https://rpc.katanarpc.com', 'https://katana.drpc.org', 'https://747474.rpc.thirdweb.com'],
  wallet: '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1',
  solWallet: 'GSMtKVYnxLbhfGQUBkdYW5npnu1LWP58ruBxVya5VM4B',
  multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
  npm: '0x2659C6085D26144117D904C46B48B6d180393d27',
  vkatNft: '0x106F7D67Ea25Cb9eFf5064CF604ebf6259Ff296d',      // vKAT lock NFT (ERC-721)
  votingEscrow: '0x4d6fC15Ca6258b168225D283262743C623c13Ead', // locked(tokenId) lives here
  lpStaker: '0xbe12e1b5c4859a3d141412748279b67458f729e9',     // Sushi V3 LP NFTs are held here when staked
  logWindow: 150000,                                          // ~3d of blocks; >> the 6h run cadence
  logBootstrapWindow: 1500000,                                // ~1 month, only when nothing is persisted yet
  logChunk: 100000,                                           // keep each eth_getLogs request small enough for public RPCs
  factory: '0x203e8740894c8955cB8950759876d7E7E45E04c1',
  morpho: '0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc',
  marketId: '0x80e60fe453223b0f84a567724f88190bef708420d24397157067d424429783e9',
  tokens: {
    KAT:   { a: '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d', d: 18 },
    WETH:  { a: '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62', d: 18 },
    USDC:  { a: '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36', d: 6 },
    USDT:  { a: '0x2DCa96907fde857dd3D816880A0df407eeB2D2F2', d: 6 },
    avKAT: { a: '0x7231dbaCdFc968E07656D12389AB20De82FbfCeB', d: 18 },
  },
  poolKatUsdc: '0x10045367E619Caae6f60CC80046c43c6cD55f629',
  poolWethUsdc: '0x2A2C512beAA8eB15495726C235472D82EFFB7A6B',
  solRpcs: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
  dlmmProgram: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  solMint: 'So11111111111111111111111111111111111111112',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  merklApi: 'https://api.merkl.xyz/v4',
  merklDistributor: '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae', // emits Claimed(user, token, amount)
  tzOffsetSec: 8 * 3600,                                          // a "day" runs 00:00–23:59 UTC+8
  startValue: 502.29,
  startDate: '2026-05-02',
  katClaimed: 84937,
  target: 10000,
};

/* ---------- evm helpers ---------- */
async function rpc(method, params) {
  let lastErr;
  for (const url of CFG.rpcs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
const w = (hex, i) => hex.substr(2 + i * 64, 64);
const toBig = (word) => BigInt('0x' + word);
const toSigned = (word) => { const v = toBig(word); return v > (1n << 255n) ? v - (1n << 256n) : v; };
const toAddr = (word) => '0x' + word.slice(24);

function encodeAgg3(calls) {
  let head = '0x82ad56cb' + pad('20') + pad(calls.length.toString(16));
  let offsets = '', tails = '';
  const base = calls.length * 32;
  for (const c of calls) {
    offsets += pad((base + tails.length / 2).toString(16));
    const data = c.data.replace(/^0x/, '');
    const padded = data + '0'.repeat((64 - (data.length % 64)) % 64);
    tails += pad(c.to) + pad('01') + pad('60') + pad((data.length / 2).toString(16)) + padded;
  }
  return head + offsets + tails;
}
function decodeAgg3(hex) {
  const h = hex.replace(/^0x/, '');
  const W = (i) => h.substr(i * 64, 64);
  const n = parseInt(W(1), 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    const elOff = parseInt(W(2 + i), 16) / 32 + 2;
    const ok = parseInt(W(elOff), 16) === 1;
    const dOff = parseInt(W(elOff + 1), 16) / 32 + elOff;
    const dLen = parseInt(W(dOff), 16);
    out.push({ ok, data: '0x' + h.substr((dOff + 1) * 64, dLen * 2) });
  }
  return out;
}
const multicall = async (calls) => decodeAgg3(await ethCall(CFG.multicall, encodeAgg3(calls)));

function v3Amounts(L, tickLo, tickHi, sqrtPX96) {
  const sp = Number(sqrtPX96) / 2 ** 96;
  const sa = Math.pow(1.0001, tickLo / 2), sb = Math.pow(1.0001, tickHi / 2);
  const Lf = Number(L);
  if (sp <= sa) return [Lf * (1 / sa - 1 / sb), 0];
  if (sp >= sb) return [0, Lf * (sb - sa)];
  return [Lf * (1 / sp - 1 / sb), Lf * (sp - sa)];
}
const poolPrice = (sqrtPX96, dec0, dec1) => {
  const sp = Number(sqrtPX96) / 2 ** 96;
  return sp * sp * Math.pow(10, dec0 - dec1);
};

/* ---------- solana helpers ---------- */
async function solRpc(method, params) {
  let lastErr;
  for (const url of CFG.solRpcs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const b64bytes = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));
function b58enc(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const dv = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength);
const dvU64 = (d, off) => d.getBigUint64(off, true);
const dvU128 = (d, off) => dvU64(d, off) + (dvU64(d, off + 8) << 64n);

/* ---------- staked LP discovery ----------
   The staker holds the position NFTs, so the wallet's balanceOf can't see them and
   the proxy exposes no per-user enumeration. Union previously-known ids with ids seen
   moving wallet->staker in recent logs, then keep only those the staker still owns. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
async function discoverStakedLp(W, prevIds) {
  const known = new Set((prevIds || []).map(String));
  try {
    const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
    /* First run has nothing persisted, so sweep far enough back to catch older stakes;
       afterwards the rolling window only needs to cover the gap between runs. */
    const span = known.size ? CFG.logWindow : CFG.logBootstrapWindow;
    const start = Math.max(0, latest - span);
    for (let from = start; from <= latest; from += CFG.logChunk) {
      const to = Math.min(from + CFG.logChunk - 1, latest);
      const logs = await rpc('eth_getLogs', [{
        fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), address: CFG.npm,
        topics: [TRANSFER_TOPIC, '0x' + pad(W), '0x' + pad(CFG.lpStaker.replace(/^0x/, ''))],
      }]);
      for (const l of logs) known.add(String(BigInt(l.topics[3])));
    }
  } catch (e) {
    console.warn('staked-LP log scan failed, using known ids only:', e.message);
  }
  const idsArr = [...known].map((s) => BigInt(s));
  if (!idsArr.length) return [];
  const owners = await multicall(idsArr.map((id) => ({ to: CFG.npm, data: '0x6352211e' + pad(id.toString(16)) })));
  return idsArr.filter((id, i) =>
    owners[i].ok && toAddr(w(owners[i].data, 0)).toLowerCase() === CFG.lpStaker.toLowerCase());
}

/* ---------- KAT claim record ----------
   Daily log of KAT claimed from Merkl, bucketed by UTC+8 calendar day.
   Claimed events carry exact amounts and timestamps, so day boundaries are exact.
   Only days with claims are stored; the dashboard fills the gaps with "-". */
const CLAIMED_TOPIC = '0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683';
const dayKey = (tsSec) => new Date((tsSec + CFG.tzOffsetSec) * 1000).toISOString().slice(0, 10);

async function updateClaims(W, katPrice) {
  const path = join(ROOT, 'claims.json');
  const today = dayKey(Math.floor(Date.now() / 1000));
  let c;
  try { c = JSON.parse(readFileSync(path, 'utf8')); } catch { c = null; }
  if (!c || !c.days) c = { tz: 'UTC+8', start_date: today, last_block: 0, days: {} };

  try {
    const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
    /* first run: look back far enough to cover start_date; later runs resume from last_block */
    let from = c.last_block ? c.last_block + 1 : Math.max(0, latest - CFG.logWindow);
    const startSec = Math.floor(Date.parse(c.start_date + 'T00:00:00Z') / 1000) - CFG.tzOffsetSec;
    for (; from <= latest; from += CFG.logChunk) {
      const to = Math.min(from + CFG.logChunk - 1, latest);
      const logs = await rpc('eth_getLogs', [{
        fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
        address: CFG.merklDistributor,
        topics: [CLAIMED_TOPIC, '0x' + pad(W), '0x' + pad(CFG.tokens.KAT.a.replace(/^0x/, ''))],
      }]);
      for (const l of logs) {
        const ts = l.blockTimestamp
          ? Number(BigInt(l.blockTimestamp))
          : Number(BigInt((await rpc('eth_getBlockByNumber', [l.blockNumber, false])).timestamp));
        if (ts < startSec) continue; /* record begins at start_date */
        const k = dayKey(ts);
        const amt = Number(BigInt(l.data)) / 1e18;
        const d = c.days[k] || (c.days[k] = { kat: 0, kat_price: katPrice, value_usd: 0 });
        d.kat = round2(d.kat + amt);
        d.kat_price = katPrice;                    /* that day's price, as seen when recorded */
        d.value_usd = round2(d.kat * d.kat_price);
      }
    }
    c.last_block = latest;
  } catch (e) {
    console.warn('claim scan failed, keeping existing record:', e.message);
  }
  writeFileSync(path, JSON.stringify(c, null, 2) + '\n');
  return c;
}

/* ---------- LP fee claim record ----------
   Fees the LP positions have actually paid out, by UTC+8 day and by chain, each valued at the
   price of the block it was collected in — the same rule as the KAT record beside it.
   A V3 Collect pays out two things at once: principal that a DecreaseLiquidity released, and
   fees. So each position carries a running "principal owed", and a Collect counts as fees
   only past it. Stored in claims.json under lp_fees; the browser adds collections made since
   the last run on top, from the per-chain state kept alongside.
   These fees are already inside each position's P&L — a close books everything it paid out —
   so the record lists them and the P&L total does not add them a second time. */
function feeStore(claims) {
  const f = claims.lp_fees || (claims.lp_fees = {});
  f.tz = 'UTC+8';
  f.days = f.days || {};
  f.state = f.state || {};
  return f;
}
function feeBook(fees, chain, ts, usd) {
  const k = dayKey(ts);
  const v = Math.round((((fees.days[k] && fees.days[k][chain]) || 0) + (usd > 0 ? usd : 0)) * 10000) / 10000;
  if (!v) return;                     /* dust that rounds to nothing is not a day with fees */
  (fees.days[k] || (fees.days[k] = {}))[chain] = v;
}
function feeClear(fees, chain) {
  for (const k of Object.keys(fees.days)) {
    delete fees.days[k][chain];
    if (!Object.keys(fees.days[k]).length) delete fees.days[k];
  }
}

/* One ordered pass over a V3 position manager's DecreaseLiquidity / Collect logs.
   All or nothing: owed principal and bookings are applied only once the whole pass has
   read cleanly, so a pass that fails part-way can simply be run again next time.
   Only a Collect that paid this wallet is income, and "paid" has two shapes on chain:
   - straight to the wallet, or
   - to a helper contract that passes the tokens on in the same transaction (the Robinhood
     app closes positions that way).
   What it must not include: a staked Katana position has its trading fees collected by the
   staker and sent to the Katana DAO (0xb722…b675), which keeps them — the staker's reward is
   the KAT claimed separately. Checked against the chain: that address is an Aragon DAO and
   never forwards to this wallet. */
async function paidToUs(l, tokens, receipt) {
  const W = CFG.wallet.toLowerCase();
  const to = toAddr(w(l.data, 0)).toLowerCase();
  if (to === W) return true;
  const tk = new Set(tokens.map((t) => t.toLowerCase()));
  const rc = await receipt(l.transactionHash);
  return rc.logs.some((x) => x.topics[0] === TRANSFER_TOPIC && x.topics.length === 3 &&
    tk.has(x.address.toLowerCase()) && '0x' + x.topics[1].slice(26) === to && '0x' + x.topics[2].slice(26) === W);
}
async function v3FeePass(chain, logs, st, fees, io) {
  const owed = { ...st.owed }, pending = [];
  const n = (x) => BigInt(x);
  logs.sort((a, b) => (n(a.blockNumber) === n(b.blockNumber)
    ? Number(n(a.logIndex) - n(b.logIndex)) : Number(n(a.blockNumber) - n(b.blockNumber))));
  for (const l of logs) {
    const id = BigInt(l.topics[1]).toString();
    const blk = Number(BigInt(l.blockNumber));
    const r0 = toBig(w(l.data, 1)), r1 = toBig(w(l.data, 2));
    const ow = owed[id] || ['0', '0'];
    let o0 = BigInt(ow[0]), o1 = BigInt(ow[1]);
    if (l.topics[0] === DEC_TOPIC) {
      o0 += r0; o1 += r1;
    } else {
      const f0 = r0 > o0 ? r0 - o0 : 0n, f1 = r1 > o1 ? r1 - o1 : 0n;
      o0 = o0 > r0 ? o0 - r0 : 0n; o1 = o1 > r1 ? o1 - r1 : 0n;
      const m = (f0 || f1) ? await io.metaFor(id, blk) : null;
      if ((f0 || f1) && !m) console.warn(`  ${chain} fees: #${id} could not be described, collection at ${blk} skipped`);
      if (m && await paidToUs(l, [m.token0, m.token1], io.receipt)) {
        const px = await io.priceAt(m, blk);
        const a0 = Number(f0) / 10 ** m.d0, a1 = Number(f1) / 10 ** m.d1;
        let usd = null;
        if (io.isStable(m.token0) && (px || !a1)) usd = a0 + (px ? a1 / px : 0);
        else if (io.isStable(m.token1) && (px || !a0)) usd = a1 + a0 * (px || 0);
        if (usd === null) console.warn(`  ${chain} fees: #${id} collection at ${blk} unpriced, skipped`);
        else {
          const ts = await io.blockTime(l, blk);
          if (!ts) throw new Error(`no timestamp for block ${blk}`);   /* retry, never date it 1970 */
          pending.push([ts, usd]);
        }
      }
    }
    if (o0 || o1) owed[id] = [String(o0), String(o1)]; else delete owed[id];
  }
  st.owed = owed;
  for (const [ts, usd] of pending) feeBook(fees, chain, ts, usd);
}

/* last block at or before a timestamp — the fee record's first run starts from here */
async function blockAtTs(getTs, ts, hi) {
  let lo = 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await getTs(mid)) <= ts) lo = mid; else hi = mid;
  }
  return lo;
}

async function katanaFees(fees, positions, stakedIds) {
  const st = fees.state.katana || (fees.state.katana = { last_block: 0, owed: {}, meta: {} });
  const T = CFG.tokens;
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  /* open and staked positions, plus anything closed in the last month — a collection can
     trail a close. The first run takes every position the ledger has ever seen. */
  const ids = new Set([...Object.keys(positions.open || {}), ...(stakedIds || []).map(String)]);
  const monthAgo = Date.now() / 1000 - 30 * 86400;
  for (const c of positions.closed || []) if (!st.last_block || (c.closed_ts || 0) > monthAgo) ids.add(String(c.id));
  if (!ids.size) { st.ids = []; st.last_block = latest; return; }
  let from = st.last_block + 1;
  if (!st.last_block) {
    const first = Math.min(...(positions.closed || []).map((c) => c.opened_ts || Infinity),
      ...Object.values(positions.open || {}).map((o) => o.opened_ts || Infinity));
    const tsOf = async (b) => Number(BigInt((await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), false])).timestamp));
    from = isFinite(first) ? await blockAtTs(tsOf, first - 3600, latest) : latest;
    console.log(`  katana fees: first run, reading from block ${from}`);
  }
  const stable = new Set([T.USDC.a.toLowerCase(), T.USDT.a.toLowerCase()]);
  const pxc = {};
  const io = {
    isStable: (a) => stable.has(a.toLowerCase()),
    receipt: (h) => rpc('eth_getTransactionReceipt', [h]),
    /* read the position just before the block that paid out — it may be burnt at that block */
    metaFor: async (id, blk) => {
      if (st.meta[id]) return st.meta[id];
      try {
        const r = await rpc('eth_call', [{ to: CFG.npm, data: '0x99fbab88' + pad(BigInt(id).toString(16)) }, '0x' + (blk - 1).toString(16)]);
        const t0 = toAddr(w(r, 2)), t1 = toAddr(w(r, 3)), fee = Number(toBig(w(r, 4)));
        const pool = toAddr(w(await ethCall(CFG.factory, '0x1698ee82' + pad(t0) + pad(t1) + pad(fee.toString(16))), 0));
        const dec = async (a) => { const k = symOf(a); return k ? T[k].d : parseInt(await ethCall(a, '0x313ce567'), 16); };
        st.meta[id] = { pool, token0: t0, token1: t1, d0: await dec(t0), d1: await dec(t1) };
        return st.meta[id];
      } catch { return null; }
    },
    priceAt: async (m, blk) => {
      const k = m.pool + '@' + blk;
      if (pxc[k] === undefined) {
        const r = await rpc('eth_call', [{ to: m.pool, data: '0x3850c7bd' }, '0x' + blk.toString(16)]);
        pxc[k] = poolPrice(toBig(w(r, 0)), m.d0, m.d1);
      }
      return pxc[k];
    },
    blockTime: async (l, blk) => (l.blockTimestamp && l.blockTimestamp !== '0x0'
      ? Number(BigInt(l.blockTimestamp))
      : Number(BigInt((await rpc('eth_getBlockByNumber', ['0x' + blk.toString(16), false])).timestamp))),
  };
  /* the ids the browser keeps watching after this run; open ones are described now, so it
     can price a collection before the next run gets to it */
  st.ids = [...ids];
  for (const id of Object.keys(positions.open || {})) await io.metaFor(id, latest + 1);
  const topics = [[DEC_TOPIC, COL_TOPIC], [...ids].map((id) => '0x' + pad(BigInt(id).toString(16)))];
  for (; from <= latest; from += CFG.logChunk) {
    const to = Math.min(from + CFG.logChunk - 1, latest);
    const logs = await rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      address: CFG.npm, topics }]);
    await v3FeePass('katana', logs, st, fees, io);
    st.last_block = to;               /* advanced per chunk, so a failure resumes where it stopped */
  }
}

async function robinhoodFees(fees, led) {
  const st = fees.state.robinhood || (fees.state.robinhood = { last_block: 0, owed: {}, meta: {} });
  const recs = [...Object.values(led.open || {}), ...(led.closed || [])];
  /* Closed records written before they kept pool details borrow them from a record of the
     same pair and fee tier — a pair and a tier name exactly one pool. */
  for (const r of recs) {
    if (st.meta[r.id]) continue;
    const src = r.pool ? r : recs.find((x) => x.pool && x.pair === r.pair && x.pool_fee === r.pool_fee);
    if (src) st.meta[r.id] = { pool: src.pool, token0: src.token0, token1: src.token1, d0: src.d0, d1: src.d1 };
  }
  const latest = await (async () => {
    const r = await fetch(CFG.rhRpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) }).then((x) => x.json());
    return parseInt(r.result, 16);
  })();
  const monthAgo = Date.now() / 1000 - 30 * 86400;
  const ids = recs.filter((r) => st.meta[r.id] && (!st.last_block || !r.closed_ts || r.closed_ts > monthAgo)).map((r) => r.id);
  st.ids = ids;
  if (!ids.length) { st.last_block = latest; return; }
  const stable = new Set(Object.values(CFG.rhTokens).filter((t) => t.stable).map((t) => t.a.toLowerCase()));
  const io = {
    isStable: (a) => stable.has(a.toLowerCase()),
    receipt: (h) => rhCall('eth_getTransactionReceipt', [h]),
    metaFor: async (id) => st.meta[id] || null,
    /* no archive state here — the pool's own swap history prices the block, as in the ledger */
    priceAt: async (m, blk) => { const px = await rhPriceAt(m.pool, blk, m.d0, m.d1); return px ? px.p1per0 : null; },
    blockTime: async (l, blk) => rhBlockTime(blk),
  };
  const topics = [[DEC_TOPIC, COL_TOPIC], ids.map((id) => '0x' + pad(BigInt(id).toString(16)))];
  /* filtered queries are allowed wide ranges here; 4M blocks is well inside what answers */
  for (let from = st.last_block ? st.last_block + 1 : CFG.rhStartBlock; from <= latest; from += 4000000) {
    const to = Math.min(from + 3999999, latest);
    const logs = await rhLogs({ address: CFG.rhNpm, topics, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) });
    await v3FeePass('robinhood', logs, st, fees, io);
    st.last_block = to;
  }
}

/* ---------- closed LP position ledger ----------
   A V3 position's whole life is on chain: IncreaseLiquidity puts principal in, Collect
   takes principal AND fees back out. Valuing each leg at the pool price of its own block
   gives true realised USD PnL — the Katana RPCs serve archive state, so these are exact
   figures, not estimates. A position is closed once its liquidity reaches 0. */
const INC_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const DEC_TOPIC = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const COL_TOPIC = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

const pxCache = new Map();
async function katPriceAtBlock(block) {
  if (pxCache.has(block)) return pxCache.get(block);
  const r = await rpc('eth_call', [{ to: CFG.poolKatUsdc, data: '0x3850c7bd' }, block]);
  const raw = Number(toBig(w(r, 0))) ** 2 / 2 ** 192;               // token1/token0 in raw units
  const p = 1 / (raw * 10 ** (CFG.tokens.USDC.d - CFG.tokens.KAT.d));
  pxCache.set(block, p);
  return p;
}

/* Replay one position's events into USD in / USD out. */
async function lifecycle(tokenId, fromBlock) {
  const logs = await rpc('eth_getLogs', [{
    fromBlock: '0x' + fromBlock.toString(16), toBlock: 'latest', address: CFG.npm,
    topics: [null, '0x' + pad(tokenId.toString(16))],
  }]);
  let inUsd = 0, outUsd = 0, openTs = null, closeTs = null;
  for (const l of logs) {
    const t = l.topics[0];
    if (t !== INC_TOPIC && t !== DEC_TOPIC && t !== COL_TOPIC) continue;
    /* all three carry (_, amount0, amount1) — word0 is liquidity or recipient */
    const a0 = Number(toBig(w(l.data, 1))) / 10 ** CFG.tokens.USDC.d;
    const a1 = Number(toBig(w(l.data, 2))) / 10 ** CFG.tokens.KAT.d;
    if (!a0 && !a1) continue;
    const ts = Number(BigInt(l.blockTimestamp));
    const usd = a0 + a1 * (await katPriceAtBlock(l.blockNumber));
    if (t === INC_TOPIC) { inUsd += usd; if (openTs === null) openTs = ts; }
    else if (t === COL_TOPIC) {
      /* principal and fees both exit via Collect — but only what came back to this wallet is
         ours; a staked position's fees go to the Katana DAO (see paidToUs) */
      if (await paidToUs(l, [CFG.tokens.USDC.a, CFG.tokens.KAT.a], (h) => rpc('eth_getTransactionReceipt', [h]))) outUsd += usd;
    }
    else closeTs = ts;                          // DecreaseLiquidity — the last one closes it
  }
  return { inUsd, outUsd, openTs, closeTs };
}

const symOf = (addr) => {
  const a = addr.toLowerCase();
  for (const [s, t] of Object.entries(CFG.tokens)) if (t.a.toLowerCase() === a) return s;
  return null;
};

async function updatePositions(W) {
  const path = join(ROOT, 'positions.json');
  let p;
  try { p = JSON.parse(readFileSync(path, 'utf8')); } catch { p = null; }
  if (!p || !p.closed) p = { start_date: null, last_block: 0, open: {}, closed: [] };

  try {
    const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
    /* v2: v1 counted every Collect as money back, including the trading fees a staked
       position pays to the Katana DAO, which overstated each staked position's result.
       Closed records are settled history, so they are replayed once under the corrected
       rule and never again. */
    if (p.version !== 2 && p.closed.length) {
      const first = Math.min(...p.closed.map((c) => c.opened_ts || Infinity));
      const tsOf = async (b) => Number(BigInt((await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), false])).timestamp));
      const fromBlk = await blockAtTs(tsOf, first - 3600, latest);
      let moved = 0;
      for (const c of p.closed) {
        const lc = await lifecycle(BigInt(c.id), fromBlk);
        if (lc.openTs === null) continue;
        const was = c.pnl_usd;
        c.open_value_usd = round2(lc.inUsd);
        c.close_value_usd = round2(lc.outUsd);
        c.pnl_usd = round2(lc.outUsd - lc.inUsd);
        c.pnl_pct = lc.inUsd > 0 ? round2((lc.outUsd - lc.inUsd) / lc.inUsd * 100) : 0;
        moved += c.pnl_usd - was;
      }
      p.version = 2;
      console.log(`  position ledger: replayed ${p.closed.length} closed positions, realised moved by ${round2(moved)}`);
    }
    p.version = 2;
    const done = new Set(p.closed.map((c) => String(c.id)));
    /* candidate id -> earliest block we've seen it at (where its event replay starts) */
    const cand = new Map();
    for (const [id, o] of Object.entries(p.open || {})) cand.set(id, o.opened_block);

    /* every position NFT the wallet has received — minted, or returned by the staker */
    const from = p.last_block ? Math.max(0, p.last_block - 1000)
                              : Math.max(0, latest - CFG.logBootstrapWindow);
    for (let f = from; f <= latest; f += CFG.logChunk) {
      const to = Math.min(f + CFG.logChunk - 1, latest);
      const logs = await rpc('eth_getLogs', [{
        fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16), address: CFG.npm,
        topics: [TRANSFER_TOPIC, null, '0x' + pad(W)],
      }]);
      for (const l of logs) {
        const k = String(BigInt(l.topics[3]));
        if (done.has(k)) continue;
        const b = Number(BigInt(l.blockNumber));
        if (!cand.has(k) || b < cand.get(k)) cand.set(k, b);
      }
    }

    const ids = [...cand.keys()].map(BigInt);
    if (ids.length) {
      const res = await multicall(ids.map((id) => ({ to: CFG.npm, data: '0x99fbab88' + pad(id.toString(16)) })));
      for (let i = 0; i < ids.length; i++) {
        if (!res[i].ok) continue;
        const k = String(ids[i]);
        const d = res[i].data;
        const sym0 = symOf(toAddr(w(d, 2))), sym1 = symOf(toAddr(w(d, 3)));
        /* only the vbUSDC/KAT pool can be priced from poolKatUsdc — skip anything else
           rather than book a wrong number */
        if (sym0 !== 'USDC' || sym1 !== 'KAT') { console.warn(`position #${k}: unpriceable pair, skipped`); continue; }
        const pair = 'vbUSDC / KAT';
        const poolFee = parseInt(w(d, 4), 16) / 10000 + '%';
        const liq = toBig(w(d, 7));
        if (liq === 0n) {
          const lc = await lifecycle(ids[i], cand.get(k));
          if (lc.openTs === null) { console.warn(`position #${k}: opened before scan window, skipped`); continue; }
          p.closed.push({
            id: k, pair, pool_fee: poolFee,
            opened: dayKey(lc.openTs), opened_ts: lc.openTs,
            closed: dayKey(lc.closeTs || lc.openTs), closed_ts: lc.closeTs || lc.openTs,
            open_value_usd: round2(lc.inUsd), close_value_usd: round2(lc.outUsd),
            pnl_usd: round2(lc.outUsd - lc.inUsd),
            pnl_pct: lc.inUsd > 0 ? round2((lc.outUsd - lc.inUsd) / lc.inUsd * 100) : 0,
          });
          delete p.open[k];
        } else {
          /* still open: replay the deposit side so the dashboard can list it alongside the
             closed ones. Recomputed each run, so topping a position up is picked up. */
          const lc = await lifecycle(ids[i], cand.get(k));
          p.open[k] = {
            pair, pool_fee: poolFee, opened_block: cand.get(k),
            opened: lc.openTs ? dayKey(lc.openTs) : null,
            opened_ts: lc.openTs || null,
            open_value_usd: lc.openTs ? round2(lc.inUsd) : null,
          };
        }
      }
    }
    p.closed.sort((a, b) => b.closed_ts - a.closed_ts);   // newest first
    p.last_block = latest;
    if (!p.start_date) {
      p.start_date = p.closed.length ? p.closed[p.closed.length - 1].opened
                                     : dayKey(Math.floor(Date.now() / 1000));
    }
  } catch (e) {
    console.warn('position ledger scan failed, keeping existing record:', e.message);
  }
  writeFileSync(path, JSON.stringify(p, null, 2) + '\n');
  return p;
}

/* ---------- katana ---------- */
async function getKatana(prevStakedIds) {
  const W = CFG.wallet.replace(/^0x/, '');
  const T = CFG.tokens;
  const calls = [
    { to: T.KAT.a, data: '0x70a08231' + pad(W) },
    { to: T.WETH.a, data: '0x70a08231' + pad(W) },
    { to: T.USDC.a, data: '0x70a08231' + pad(W) },
    { to: T.USDT.a, data: '0x70a08231' + pad(W) },
    { to: T.avKAT.a, data: '0x70a08231' + pad(W) },
    { to: T.avKAT.a, data: '0x07a2d13a' + pad('de0b6b3a7640000') }, // convertToAssets(1e18)
    { to: CFG.poolKatUsdc, data: '0x3850c7bd' },  // slot0
    { to: CFG.poolWethUsdc, data: '0x3850c7bd' }, // slot0
    { to: CFG.morpho, data: '0x93c52062' + CFG.marketId.slice(2) + pad(W) }, // position
    { to: CFG.morpho, data: '0x5c60e39a' + CFG.marketId.slice(2) },          // market
    { to: CFG.npm, data: '0x70a08231' + pad(W) }, // NFT count
    { to: CFG.vkatNft, data: '0x70a08231' + pad(W) }, // vKAT lock count
  ];
  const [ethHex, r] = await Promise.all([rpc('eth_getBalance', [CFG.wallet, 'latest']), multicall(calls)]);
  const ethBal = Number(BigInt(ethHex)) / 1e18;
  const bal = {
    KAT: Number(toBig(w(r[0].data, 0))) / 1e18,
    WETH: Number(toBig(w(r[1].data, 0))) / 1e18,
    USDC: Number(toBig(w(r[2].data, 0))) / 1e6,
    USDT: Number(toBig(w(r[3].data, 0))) / 1e6,
    avKAT: Number(toBig(w(r[4].data, 0))) / 1e18,
  };
  const avkatRate = Number(toBig(w(r[5].data, 0))) / 1e18;
  const katPrice = 1 / poolPrice(toBig(w(r[6].data, 0)), 6, 18);
  const ethPrice = 1 / poolPrice(toBig(w(r[7].data, 0)), 6, 18);
  const borrowShares = toBig(w(r[8].data, 1));
  const collateral = Number(toBig(w(r[8].data, 2))) / 1e18;
  const totBA = toBig(w(r[9].data, 2)), totBS = toBig(w(r[9].data, 3));
  const debt = totBS > 0n ? Number(borrowShares * totBA / totBS) / 1e18 : 0;
  let nftCount = Number(toBig(w(r[10].data, 0)));
  if (nftCount > 200) nftCount = 200;

  // vKAT staking locks: enumerate lock NFTs, read locked() amounts from the escrow
  let vkat = { totalKat: 0, ids: [] };
  let lockCount = Number(toBig(w(r[11].data, 0)));
  if (lockCount > 20) lockCount = 20;
  if (lockCount > 0) {
    try {
      const lidCalls = [];
      for (let li = 0; li < lockCount; li++)
        lidCalls.push({ to: CFG.vkatNft, data: '0x2f745c59' + pad(W) + pad(li.toString(16)) });
      const lids = (await multicall(lidCalls)).filter((x) => x.ok).map((x) => toBig(w(x.data, 0)));
      if (lids.length) {
        const la = await multicall(lids.map((id) => ({ to: CFG.votingEscrow, data: '0xb45a3c0e' + pad(id.toString(16)) })));
        let tot = 0;
        for (const res of la) if (res.ok) tot += Number(toBig(w(res.data, 0))) / 1e18;
        vkat = { totalKat: tot, ids: lids.map((x) => Number(x)) };
      }
    } catch { /* leave vkat empty on RPC failure */ }
  }

  // enumerate position NFTs, keep active ones
  const idCalls = [];
  for (let i = 0; i < nftCount; i++)
    idCalls.push({ to: CFG.npm, data: '0x2f745c59' + pad(W) + pad(i.toString(16)) });
  const idRes = nftCount ? await multicall(idCalls) : [];
  const ownedIds = idRes.filter((x) => x.ok).map((x) => toBig(w(x.data, 0)));

  // staked LP NFTs live in the staker contract, so balanceOf(wallet) misses them.
  // Discover via Transfer logs, union with previously-known ids, then keep only
  // those the staker still holds (unstaked ones drop out automatically).
  const stakedIds = await discoverStakedLp(W, prevStakedIds);
  const stakedSet = new Set(stakedIds.map(String));
  const ids = [...ownedIds, ...stakedIds];

  const posRes = ids.length ? await multicall(ids.map((id) => ({ to: CFG.npm, data: '0x99fbab88' + pad(id.toString(16)) }))) : [];
  const active = [];
  posRes.forEach((res, i) => {
    if (!res.ok) return;
    const d = res.data;
    const liq = toBig(w(d, 7)), owed0 = toBig(w(d, 10)), owed1 = toBig(w(d, 11));
    if (liq === 0n && owed0 === 0n && owed1 === 0n) return;
    active.push({
      tokenId: ids[i], token0: toAddr(w(d, 2)), token1: toAddr(w(d, 3)),
      fee: Number(toBig(w(d, 4))), tickLo: Number(toSigned(w(d, 5))), tickHi: Number(toSigned(w(d, 6))),
      liq, owed0, owed1, staked: stakedSet.has(String(ids[i])),
    });
  });
  const poolRes = active.length ? await multicall(active.map((p) => ({
    to: CFG.factory, data: '0x1698ee82' + pad(p.token0) + pad(p.token1) + pad(p.fee.toString(16)),
  }))) : [];
  const slotRes = poolRes.length ? await multicall(poolRes.map((x) => ({ to: toAddr(w(x.data, 0)), data: '0x3850c7bd' }))) : [];

  const lc = (s) => s.toLowerCase();
  const priceOf = { [lc(T.USDC.a)]: 1, [lc(T.USDT.a)]: 1, [lc(T.KAT.a)]: katPrice, [lc(T.WETH.a)]: ethPrice, [lc(T.avKAT.a)]: katPrice * avkatRate };
  const decOf = { [lc(T.USDC.a)]: 6, [lc(T.USDT.a)]: 6, [lc(T.KAT.a)]: 18, [lc(T.WETH.a)]: 18, [lc(T.avKAT.a)]: 18 };
  const symOf = { [lc(T.USDC.a)]: 'vbUSDC', [lc(T.USDT.a)]: 'vbUSDT', [lc(T.KAT.a)]: 'KAT', [lc(T.WETH.a)]: 'vbETH', [lc(T.avKAT.a)]: 'avKAT' };

  const lps = [];
  active.forEach((p, i) => {
    if (!slotRes[i]?.ok) return;
    const sqrtP = toBig(w(slotRes[i].data, 0));
    const [a0, a1] = v3Amounts(p.liq, p.tickLo, p.tickHi, sqrtP);
    const t0 = lc(p.token0), t1 = lc(p.token1);
    if (decOf[t0] === undefined || decOf[t1] === undefined) return;
    const h0 = a0 / 10 ** decOf[t0] + Number(p.owed0) / 10 ** decOf[t0];
    const h1 = a1 / 10 ** decOf[t1] + Number(p.owed1) / 10 ** decOf[t1];
    const val = h0 * (priceOf[t0] || 0) + h1 * (priceOf[t1] || 0);
    if (val < 0.5) return;
    /* Out of range? Below tickLower the position is entirely token0, above tickUpper
       entirely token1. Judged via whichever side is the stable coin so it holds whichever
       way the pair is ordered: holding stables means price ran up, volatile means it fell. */
    const curTick = Number(toSigned(w(slotRes[i].data, 1)));
    const isStable = (a) => a === lc(T.USDC.a) || a === lc(T.USDT.a);
    let range = 'in';
    if (curTick < p.tickLo) range = isStable(t0) ? 'above' : 'below';
    else if (curTick > p.tickHi) range = isStable(t1) ? 'above' : 'below';
    lps.push({
      type: 'LP', protocol: 'SushiSwap V3',
      pair: `${symOf[t0]} / ${symOf[t1]}`, pool_fee: `${p.fee / 10000}%`,
      value_usd: round2(val), apr: null, staked: p.staked,
      token_id: String(p.tokenId),   // lets the position ledger price an open position
      range_status: range,
      note: `NFT #${p.tokenId}${p.staked ? ' · STAKED' : ''} — ${h0.toFixed(2)} ${symOf[t0]} + ${Math.round(h1).toLocaleString('en-US')} ${symOf[t1]} (auto-detected on-chain)`,
    });
  });

  return { ethBal, bal, avkatRate, katPrice, ethPrice, morpho: { collateral, debt }, lps, vkat,
    stakedLpIds: stakedIds.map((x) => String(x)) };
}

/* ---------- solana ---------- */
/* Robinhood Chain: one multicall for native ETH, the allowlisted tokens, and the count of
   Uniswap V3 position NFTs. Deliberately an allowlist — this wallet already holds two
   unsolicited airdrops with no market, and counting them would inflate the total with
   fiction. A failure here returns zeros rather than throwing: one chain must not take the
   whole snapshot down. */
async function getRobinhood(ethPrice) {
  const W = CFG.wallet.replace(/^0x/, '');
  const syms = Object.keys(CFG.rhTokens);
  const calls = [{ to: CFG.multicall, data: '0x4d2301cc' + pad(W) }];
  for (const k of syms) calls.push({ to: CFG.rhTokens[k].a, data: '0x70a08231' + pad(W) });
  calls.push({ to: CFG.rhNpm, data: '0x70a08231' + pad(W) });

  try {
    const res = await fetch(CFG.rhRpc, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: CFG.multicall, data: encodeAgg3(calls) }, 'latest'] }),
    }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    if (res.error) throw new Error(res.error.message);
    const out = decodeAgg3(res.result);
    const eth = out[0].ok ? Number(toBig(w(out[0].data, 0))) / 1e18 : 0;
    const tokens = {}; let walletUsd = eth * (ethPrice || 0);
    syms.forEach((k, i) => {
      const t = CFG.rhTokens[k], r = out[i + 1];
      if (!r || !r.ok) return;
      const amt = Number(toBig(w(r.data, 0))) / 10 ** t.d;
      const usd = t.stable ? amt : 0;
      walletUsd += usd;
      tokens[k] = { balance: amt, priceUSD: t.stable ? 1 : null, valueUSD: round2(usd) };
    });
    const lpCount = out[syms.length + 1].ok ? Number(toBig(w(out[syms.length + 1].data, 0))) : 0;
    const lps = lpCount ? await rhPositions(lpCount) : [];
    return { eth, tokens, walletUsd, lpCount, lps, ok: true };
  } catch (e) {
    console.warn('robinhood read failed:', e.message);
    return { eth: 0, tokens: {}, walletUsd: 0, lpCount: 0, lps: [], ok: false };
  }
}

/* Values the Uniswap V3 positions held on Robinhood Chain. Same tick maths as Katana's —
   both are V3 forks — and the same self-contained pricing: one leg of each pool is an
   allowlisted stable, so the pool's own ratio prices the other. A pool with no stable leg
   is reported unpriced rather than guessed at, because a tokenised equity is not on any
   free price feed and a made-up number is worse than an absent one. */
async function rhPositions(count) {
  const W = CFG.wallet.replace(/^0x/, '');
  const stable = {};
  for (const k of Object.keys(CFG.rhTokens))
    if (CFG.rhTokens[k].stable) stable[CFG.rhTokens[k].a.toLowerCase()] = 1;

  const rhCall = async (calls) => {
    const r = await fetch(CFG.rhRpc, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: CFG.multicall, data: encodeAgg3(calls) }, 'latest'] }),
    }).then(x => { if (!x.ok) throw new Error('HTTP ' + x.status); return x.json(); });
    if (r.error) throw new Error(r.error.message);
    return decodeAgg3(r.result);
  };
  const str = (h) => { try {
    const d = h.replace(/^0x/, ''), l = parseInt(d.slice(64, 128), 16);
    return Buffer.from(d.slice(128, 128 + l * 2), 'hex').toString('utf8');
  } catch { return '?'; } };

  try {
    const n = Math.min(count, 20);
    const idCalls = [];
    for (let i = 0; i < n; i++)
      idCalls.push({ to: CFG.rhNpm, data: '0x2f745c59' + pad(W) + pad(i.toString(16)) });
    const ids = (await rhCall(idCalls)).filter(r => r.ok).map(r => toBig(w(r.data, 0)));
    if (!ids.length) return [];

    const posRes = await rhCall(ids.map(id => ({ to: CFG.rhNpm, data: '0x99fbab88' + pad(id.toString(16)) })));
    const pos = [];
    posRes.forEach((r, i) => {
      if (!r.ok) return;
      const liq = toBig(w(r.data, 7));
      if (liq <= 0n) return;
      pos.push({ id: ids[i].toString(), token0: toAddr(w(r.data, 2)), token1: toAddr(w(r.data, 3)),
        fee: Number(toBig(w(r.data, 4))),
        tickLo: Number(toSigned(w(r.data, 5))), tickHi: Number(toSigned(w(r.data, 6))),
        liq, owed0: toBig(w(r.data, 10)), owed1: toBig(w(r.data, 11)) });
    });
    if (!pos.length) return [];

    const meta = await rhCall(pos.flatMap(p => [
      { to: p.token0, data: '0x313ce567' }, { to: p.token0, data: '0x95d89b41' },
      { to: p.token1, data: '0x313ce567' }, { to: p.token1, data: '0x95d89b41' },
      { to: CFG.rhFactory, data: '0x1698ee82' + pad(p.token0) + pad(p.token1) + pad(p.fee.toString(16)) },
    ]));
    pos.forEach((p, i) => {
      const b = i * 5;
      p.d0 = meta[b].ok ? parseInt(meta[b].data, 16) : 18;
      p.s0 = meta[b + 1].ok ? str(meta[b + 1].data) : '?';
      p.d1 = meta[b + 2].ok ? parseInt(meta[b + 2].data, 16) : 18;
      p.s1 = meta[b + 3].ok ? str(meta[b + 3].data) : '?';
      p.pool = meta[b + 4].ok ? toAddr(w(meta[b + 4].data, 0)) : null;
    });

    const pools = pos.filter(p => p.pool);
    if (!pools.length) return [];
    const slots = await rhCall(pools.map(p => ({ to: p.pool, data: '0x3850c7bd' })));
    const out = [];
    pools.forEach((p, i) => {
      if (!slots[i].ok) return;
      const sqrtP = toBig(w(slots[i].data, 0));
      const tick = Number(toSigned(w(slots[i].data, 1)));
      const [r0, r1] = v3Amounts(p.liq, p.tickLo, p.tickHi, sqrtP);
      const a0 = r0 / 10 ** p.d0 + Number(p.owed0) / 10 ** p.d0;
      const a1 = r1 / 10 ** p.d1 + Number(p.owed1) / 10 ** p.d1;
      const p1per0 = poolPrice(sqrtP, p.d0, p.d1);
      let usd = null;
      if (stable[p.token0]) usd = a0 + a1 * (p1per0 ? 1 / p1per0 : 0);
      else if (stable[p.token1]) usd = a1 + a0 * p1per0;
      out.push({ type: 'LP', protocol: 'Uniswap V3', chain: 'robinhood',
        /* internals kept alongside the display fields so the P&L ledger does not have to
           re-read decimals, symbols and the pool address it already fetched */
        _id: p.id, _pool: p.pool, _token0: p.token0, _token1: p.token1,
        _d0: p.d0, _d1: p.d1, _s0: p.s0, _s1: p.s1, _fee: p.fee,
        pair: `${p.s0} / ${p.s1}`, pool_fee: `${p.fee / 10000}%`, token_id: p.id,
        /* through the stable side, as on Katana: all-stable means the other leg ran up */
        range_status: tick < p.tickLo ? (stable[p.token0] ? 'above' : 'below')
                    : tick >= p.tickHi ? (stable[p.token1] ? 'above' : 'below') : 'in',
        staked: false, apr: null, value_usd: usd === null ? null : round2(usd),
        note: `NFT #${p.id} — ${a0.toFixed(2)} ${p.s0} + ${a1.toFixed(4)} ${p.s1}` +
              (usd === null ? ' (no stable leg — unpriced)' : '') });
    });
    return out;
  } catch (e) {
    console.warn('robinhood LP scan failed:', e.message);
    return [];
  }
}

/* ---- Robinhood realised P&L ------------------------------------------------------
   This chain serves no archive state, so a position's value at the block it opened
   cannot be read the usual way. The workaround is that the pool records its own price
   history: every Uniswap V3 Swap log carries the post-swap sqrtPriceX96, so the nearest
   swap at or before a block gives the price at that block without an archive node.

   The ledger is built from raw token flows rather than from liquidity maths — what went
   in on IncreaseLiquidity, what came out on Collect (which carries principal AND fees).
   That closes the books without needing to split the two.

   It accrues forward rather than reconstructing history: each run records the open of any
   position it has not seen before, and settles any it was watching that has since gone.
   A burnt NFT can no longer be asked which pool it belonged to, so anything that closed
   before this code existed is simply not in the ledger — which is the honest outcome. */

const RH_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const RH_INC_TOPIC  = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const RH_COL_TOPIC  = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

/* the public RPC has a burst limit as well as a range limit, and this ledger makes several
   calls back to back — a short gap between them is cheaper than a failed run */
let rhLastCall = 0;
/* A wide log query can time out on the node's side ("context deadline exceeded") as the chain
   grows — that is how a new position went unrecorded on 2026-09-19. A timed-out range is
   halved and each half asked again, down to 20,000 blocks, rather than failing the lookup.
   Halves are returned in order, so "first" and "last" still mean what callers expect. */
async function rhLogs(params) {
  try {
    return await rhCall('eth_getLogs', [params]);
  } catch (e) {
    if (!/deadline|timeout|timed out/i.test(e.message)) throw e;
    const from = parseInt(params.fromBlock, 16);
    const to = params.toBlock === 'latest' ? parseInt(await rhCall('eth_blockNumber', []), 16) : parseInt(params.toBlock, 16);
    if (!(to - from > 20000)) throw e;
    const mid = Math.floor((from + to) / 2), h = (n) => '0x' + n.toString(16);
    return [...await rhLogs({ ...params, fromBlock: h(from), toBlock: h(mid) }),
            ...await rhLogs({ ...params, fromBlock: h(mid + 1), toBlock: h(to) })];
  }
}

/* Paced, and patient with the rate limit: a 429 waits and tries again rather than failing a
   run that has only been asked to slow down. Any other error is returned at once. */
async function rhCall(method, params) {
  for (let attempt = 0; ; attempt++) {
    const gap = 250 - (Date.now() - rhLastCall);
    if (gap > 0) await new Promise((k) => setTimeout(k, gap));
    rhLastCall = Date.now();
    const x = await fetch(CFG.rhRpc, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const r = await x.json().catch(() => null);
    const limited = x.status === 429 || /rate limit|too many/i.test((r && r.error && r.error.message) || '');
    if (limited && attempt < 4) { await new Promise((k) => setTimeout(k, 1500 * (attempt + 1))); continue; }
    if (!x.ok || !r) throw new Error('HTTP ' + x.status);
    if (r.error) throw new Error(r.error.message);
    return r.result;
  }
}

/* Robinhood's RPC returns a blockTimestamp field on every log but leaves it at "0x0", so
   the timestamp has to be fetched per block after all. Cached, because a position's open
   and close each resolve to one block and the ledger is rebuilt every run. */
const RH_TS = {};
async function rhBlockTime(block) {
  if (RH_TS[block]) return RH_TS[block];
  try {
    const b = await rhCall('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
    /* only a real answer is remembered — a failure used to be cached as "no timestamp" for
       the rest of the run, and a collection then went undated */
    if (b && b.timestamp) RH_TS[block] = parseInt(b.timestamp, 16);
  } catch { /* the caller decides whether a missing time is fatal */ }
  return RH_TS[block] || null;
}

/* price of token1 in token0 terms at a block, from the pool's own swap history */
async function rhPriceAt(pool, block, d0, d1) {
  /* widen until a swap is found — a quiet pool may not trade for a while */
  for (const span of [50000, 500000, 4000000]) {
    const logs = await rhLogs({ address: pool, topics: [RH_SWAP_TOPIC],
      fromBlock: '0x' + Math.max(0, block - span).toString(16), toBlock: '0x' + block.toString(16) });
    if (logs.length) {
      const last = logs[logs.length - 1];
      const sqrtP = toBig(w(last.data, 2));
      return { p1per0: poolPrice(sqrtP, d0, d1), atBlock: parseInt(last.blockNumber, 16) };
    }
  }
  return null;
}

/* value a token pair at a block, using the allowlisted stable as the anchor */
function rhValue(a0, a1, token0, token1, p1per0) {
  const stable = {};
  for (const k of Object.keys(CFG.rhTokens))
    if (CFG.rhTokens[k].stable) stable[CFG.rhTokens[k].a.toLowerCase()] = 1;
  if (stable[token0.toLowerCase()]) return a0 + a1 * (p1per0 ? 1 / p1per0 : 0);
  if (stable[token1.toLowerCase()]) return a1 + a0 * p1per0;
  return null;   /* no stable leg — unpriceable, and a guess would be worse */
}

async function rhBuildLedger(current, prevLedger) {
  const latestBlock = await (async () => {
    const r = await fetch(CFG.rhRpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) }).then(x => x.json());
    return parseInt(r.result, 16);
  })();
  const led = { last_block: 0, open: {}, closed: [], ...(prevLedger || {}) };
  led.last_block = latestBlock;
  led.open = { ...(led.open || {}) };
  led.closed = [...(led.closed || [])];
  const held = {};
  current.forEach(p => { held[p.id] = p; });

  /* 0. repair records written before the timestamp fetch existed. Driven off the ledger
        rather than off the live positions, or a run where the position read fails would
        skip the repair entirely — which is exactly how this stayed broken for two runs. */
  for (const e of Object.values(led.open)) {
    if (e.opened_ts || !e.opened_block) continue;
    const ts = await rhBlockTime(e.opened_block);
    if (ts) {
      e.opened_ts = ts;
      e.opened = new Date(ts * 1000).toISOString().slice(0, 10);
      console.log(`  robinhood ledger: backfilled open date for #${e.id} -> ${e.opened}`);
    }
  }

  /* 1. record the open of anything new */
  for (const p of current) {
    if (led.open[p.id]) continue;
    try {
      /* Bounded, widening. A 0x0->latest scan over 58M blocks is refused with a 429 even
         with a tight topic filter; 8M blocks (~9 days here) answers in under 300ms. */
      const topic = '0x' + pad(BigInt(p.id).toString(16));
      let inc = [];
      for (const span of [2000000, 8000000, 24000000]) {
        inc = await rhLogs({ address: CFG.rhNpm, topics: [RH_INC_TOPIC, topic],
          fromBlock: '0x' + Math.max(0, latestBlock - span).toString(16), toBlock: 'latest' });
        if (inc.length) break;
      }
      if (!inc.length) { console.warn(`  robinhood: no open event found for #${p.id} within 24M blocks`); continue; }
      const first = inc[0];
      const blk = parseInt(first.blockNumber, 16);
      const a0 = Number(toBig(w(first.data, 1))) / 10 ** p.d0;
      const a1 = Number(toBig(w(first.data, 2))) / 10 ** p.d1;
      const px = await rhPriceAt(p.pool, blk, p.d0, p.d1);
      const val = px ? rhValue(a0, a1, p.token0, p.token1, px.p1per0) : null;
      const openTs = await rhBlockTime(blk);
      led.open[p.id] = {
        id: p.id, chain: 'robinhood', pair: `${p.s0} / ${p.s1}`, pool_fee: `${p.fee / 10000}%`,
        pool: p.pool, token0: p.token0, token1: p.token1, d0: p.d0, d1: p.d1,
        s0: p.s0, s1: p.s1,
        opened_block: blk,
        opened: openTs ? new Date(openTs * 1000).toISOString().slice(0, 10) : null,
        opened_ts: openTs,
        in0: a0, in1: a1,
        open_value_usd: val === null ? null : round2(val),
      };
      console.log(`  robinhood ledger: opened #${p.id} ${p.s0}/${p.s1} at block ${blk} = $${val === null ? '?' : val.toFixed(2)}`);
    } catch (e) { console.warn(`  robinhood open scan failed for #${p.id}:`, e.message); }
  }

  /* 2. settle anything we were watching that is no longer held */
  for (const id of Object.keys(led.open)) {
    if (held[id]) continue;
    const o = led.open[id];
    try {
      const col = await rhLogs({ address: CFG.rhNpm, topics: [RH_COL_TOPIC, '0x' + pad(BigInt(id).toString(16))],
        fromBlock: '0x' + Math.max(0, o.opened_block).toString(16), toBlock: 'latest' });
      if (!col.length) continue;   /* gone but nothing collected yet — leave it open */
      const last = col[col.length - 1];
      const blk = parseInt(last.blockNumber, 16);
      const a0 = Number(toBig(w(last.data, 1))) / 10 ** o.d0;
      const a1 = Number(toBig(w(last.data, 2))) / 10 ** o.d1;
      const px = await rhPriceAt(o.pool, blk, o.d0, o.d1);
      const val = px ? rhValue(a0, a1, o.token0, o.token1, px.p1per0) : null;
      const pnl = (val !== null && o.open_value_usd !== null) ? val - o.open_value_usd : null;
      const closeTs = await rhBlockTime(blk);
      led.closed.push({
        id: o.id, chain: 'robinhood', pair: o.pair, pool_fee: o.pool_fee,
        /* kept so the fee record can still price this position's collections */
        pool: o.pool, token0: o.token0, token1: o.token1, d0: o.d0, d1: o.d1, s0: o.s0, s1: o.s1,
        opened_block: o.opened_block,
        opened: o.opened, opened_ts: o.opened_ts,
        closed: closeTs ? new Date(closeTs * 1000).toISOString().slice(0, 10) : null,
        closed_ts: closeTs,
        open_value_usd: o.open_value_usd,
        close_value_usd: val === null ? null : round2(val),
        pnl_usd: pnl === null ? null : round2(pnl),
        pnl_pct: (pnl !== null && o.open_value_usd) ? round2(pnl / o.open_value_usd * 100) : null,
      });
      delete led.open[id];
      console.log(`  robinhood ledger: closed #${id} realised $${pnl === null ? '?' : pnl.toFixed(2)}`);
    } catch (e) { console.warn(`  robinhood close scan failed for #${id}:`, e.message); }
  }
  return led;
}

/* ---------- Arc (5042) ----------
   Circle's L1, where gas is paid in USDC. That shapes the reads below:
   - The wallet's native balance IS its USDC. The ERC-20 at 0x3600…0000 is a second face on
     the same balance (6 dp where native reports 18), so it is read once, natively, and never
     added again — counting both would double the cash.
   - Every native USDC movement also emits an ERC-20 Transfer from 0x3600…0000, so token flows
     can be followed through logs even when the value moved as msg.value.
   The RPC serves archive state, so history is priced at its own block as on Katana. But it
   caps eth_getLogs at 10,000 blocks (~80 minutes here) and rate-limits log queries hard: 11 of
   18 back-to-back queries were refused in testing, 10 of 10 went through at a 500ms pace. */
let arcLast = 0;
async function arcRpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const gap = 450 - (Date.now() - arcLast);
    if (gap > 0) await new Promise((k) => setTimeout(k, gap));
    arcLast = Date.now();
    let j = null, status = 0;
    try {
      const r = await fetch(CFG.arcRpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      status = r.status;
      j = await r.json().catch(() => null);
    } catch (e) { if (attempt >= 3) throw e; }
    /* the limit arrives either as HTTP 429 or as a JSON-RPC error on a 200 — back off on both */
    const limited = status === 429 || /rate limit/i.test((j && j.error && j.error.message) || '');
    if (limited && attempt < 5) { await new Promise((k) => setTimeout(k, 1500 * (attempt + 1))); continue; }
    if (!j) { if (attempt < 3) continue; throw new Error('HTTP ' + status); }
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
}
/* Log queries are capped twice: 10,000 blocks, and 2,000 results. The pool manager is busy
   enough to hit the second inside a few minutes of blocks, so a full window halves itself
   until each piece fits rather than failing the run. */
async function arcLogs(filter, from, to) {
  try {
    return await arcRpc('eth_getLogs', [{ ...filter, fromBlock: hexBlock(from), toBlock: hexBlock(to) }]);
  } catch (e) {
    if (!/max results/i.test(e.message) || to <= from) throw e;
    const mid = Math.floor((from + to) / 2);
    return [...await arcLogs(filter, from, mid), ...await arcLogs(filter, mid + 1, to)];
  }
}
const arcMulti = async (calls, tag = 'latest') => calls.length
  ? decodeAgg3(await arcRpc('eth_call', [{ to: CFG.multicall, data: encodeAgg3(calls) }, tag]))
  : [];
const hexBlock = (n) => '0x' + n.toString(16);
const enc24 = (t) => pad((t < 0 ? (1n << 256n) + BigInt(t) : BigInt(t)).toString(16));
const MOD256 = 1n << 256n;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const arcIsUsdc = (a) => { const x = a.toLowerCase(); return x === CFG.arcUsdc || x === ZERO_ADDR; };
/* a V4 pool can hold USDC natively, and native USDC counts in 18 dp */
const arcDec = (a, d) => (a.toLowerCase() === ZERO_ADDR ? 18 : d);
const abiStr = (h) => { try {
  const d = h.replace(/^0x/, ''), l = parseInt(d.slice(64, 128), 16);
  return Buffer.from(d.slice(128, 128 + l * 2), 'hex').toString('utf8');
} catch { return '?'; } };
const amt = (n) => (n >= 1000 ? Math.round(n).toLocaleString('en-US') : n >= 1 ? n.toFixed(2) : n.toFixed(4));

/* USD value of a token pair, anchored on the USDC leg. p1per0 is token1 per token0. */
function arcPairUsd(a0, a1, t0, t1, p1per0) {
  if (arcIsUsdc(t0)) return a0 + (p1per0 ? a1 / p1per0 : 0);
  if (arcIsUsdc(t1)) return a1 + a0 * p1per0;
  return null;   /* no USDC leg — unpriced rather than guessed */
}

/* Fees earned since the position was last touched. positions() only carries tokensOwed as of
   the last interaction; on a 1% pool that is collected several times a day, leaving out the
   accrual since then understates the position by dollars, not cents. */
const accrued = (liq, insideNow, insideLast) => (((insideNow - insideLast) % MOD256 + MOD256) % MOD256) * liq / (1n << 128n);
function v3Inside(tick, lo, hi, global, outLo, outHi) {
  const below = tick >= lo ? outLo : global - outLo;
  const above = tick < hi ? outHi : global - outHi;
  return ((global - below - above) % MOD256 + MOD256) % MOD256;
}

function arcLpRow(kind, p, v) {
  /* Read through the USDC side, as on Katana: sitting entirely in USDC means the other token
     ran up past the band (fine), sitting entirely in the other token means it fell through. */
  let range = 'in';
  if (v.tick < p.lo) range = arcIsUsdc(p.token0) ? 'above' : 'below';
  else if (v.tick >= p.hi) range = arcIsUsdc(p.token1) ? 'above' : 'below';
  return {
    type: 'LP', protocol: kind === 'v4' ? 'Uniswap V4' : 'Uniswap V3', chain: 'arc',
    uid: `arc:${kind}:${p.id}`, token_id: String(p.id),
    pair: `${p.s0} / ${p.s1}`, pool_fee: `${p.fee / 10000}%`,
    range_status: range, staked: !!p.staked, apr: null,
    value_usd: v.usd === null ? null : round2(v.usd),
    fees_usd: v.feeUsd === null ? null : round2(v.feeUsd),
    note: `${kind.toUpperCase()} #${p.id}${p.staked ? ' · STAKED' : ''} — ${amt(v.h0)} ${p.s0} + ${amt(v.h1)} ${p.s1}` +
      (v.feeUsd ? ` incl. $${v.feeUsd.toFixed(2)} unclaimed fees` : '') +
      (v.usd === null ? ' (no USDC leg — unpriced)' : ''),
  };
}

async function arcV3Positions(tag, count, stakedIds) {
  const W = CFG.wallet.replace(/^0x/, '');
  const idCalls = [];
  for (let i = 0; i < count; i++) idCalls.push({ to: CFG.arcNpm, data: '0x2f745c59' + pad(W) + pad(i.toString(16)) });
  const owned = (await arcMulti(idCalls, tag)).filter((r) => r.ok).map((r) => toBig(w(r.data, 0)).toString());
  const ids = [...new Set([...owned, ...stakedIds.map(String)])];
  if (!ids.length) return [];

  const pr = await arcMulti(ids.map((id) => ({ to: CFG.arcNpm, data: '0x99fbab88' + pad(BigInt(id).toString(16)) })), tag);
  const pos = [];
  pr.forEach((r, i) => {
    if (!r.ok) return;                                   /* burnt */
    const liq = toBig(w(r.data, 7)), owed0 = toBig(w(r.data, 10)), owed1 = toBig(w(r.data, 11));
    if (liq === 0n && owed0 === 0n && owed1 === 0n) return;
    pos.push({ id: ids[i], staked: !owned.includes(ids[i]),
      token0: toAddr(w(r.data, 2)), token1: toAddr(w(r.data, 3)), fee: Number(toBig(w(r.data, 4))),
      lo: Number(toSigned(w(r.data, 5))), hi: Number(toSigned(w(r.data, 6))),
      liq, last0: toBig(w(r.data, 8)), last1: toBig(w(r.data, 9)), owed0, owed1 });
  });
  if (!pos.length) return [];

  const meta = await arcMulti(pos.flatMap((p) => [
    { to: p.token0, data: '0x313ce567' }, { to: p.token0, data: '0x95d89b41' },
    { to: p.token1, data: '0x313ce567' }, { to: p.token1, data: '0x95d89b41' },
    { to: CFG.arcFactory, data: '0x1698ee82' + pad(p.token0) + pad(p.token1) + pad(p.fee.toString(16)) },
  ]), tag);
  pos.forEach((p, i) => {
    const b = i * 5;
    p.d0 = meta[b].ok ? parseInt(meta[b].data, 16) : 18;
    p.s0 = meta[b + 1].ok ? abiStr(meta[b + 1].data) : '?';
    p.d1 = meta[b + 2].ok ? parseInt(meta[b + 2].data, 16) : 18;
    p.s1 = meta[b + 3].ok ? abiStr(meta[b + 3].data) : '?';
    p.pool = meta[b + 4].ok ? toAddr(w(meta[b + 4].data, 0)) : null;
  });
  const live = pos.filter((p) => p.pool && p.pool !== ZERO_ADDR);

  /* price and fee growth in one round: slot0, both global accumulators, both boundary ticks */
  const st = await arcMulti(live.flatMap((p) => [
    { to: p.pool, data: '0x3850c7bd' }, { to: p.pool, data: '0xf3058399' }, { to: p.pool, data: '0x46141319' },
    { to: p.pool, data: '0xf30dba93' + enc24(p.lo) }, { to: p.pool, data: '0xf30dba93' + enc24(p.hi) },
  ]), tag);
  const out = [];
  live.forEach((p, i) => {
    const b = i * 5;
    if (!st[b].ok) return;
    const sq = toBig(w(st[b].data, 0)), tick = Number(toSigned(w(st[b].data, 1)));
    const [r0, r1] = v3Amounts(p.liq, p.lo, p.hi, sq);
    let f0 = p.owed0, f1 = p.owed1;
    if (st[b + 1].ok && st[b + 2].ok && st[b + 3].ok && st[b + 4].ok) {
      const g0 = toBig(w(st[b + 1].data, 0)), g1 = toBig(w(st[b + 2].data, 0));
      f0 += accrued(p.liq, v3Inside(tick, p.lo, p.hi, g0, toBig(w(st[b + 3].data, 2)), toBig(w(st[b + 4].data, 2))), p.last0);
      f1 += accrued(p.liq, v3Inside(tick, p.lo, p.hi, g1, toBig(w(st[b + 3].data, 3)), toBig(w(st[b + 4].data, 3))), p.last1);
    }
    const fee0 = Number(f0) / 10 ** p.d0, fee1 = Number(f1) / 10 ** p.d1;
    const h0 = r0 / 10 ** p.d0 + fee0, h1 = r1 / 10 ** p.d1 + fee1;
    const px = poolPrice(sq, p.d0, p.d1);
    out.push(arcLpRow('v3', p, { tick, h0, h1,
      usd: arcPairUsd(h0, h1, p.token0, p.token1, px), feeUsd: arcPairUsd(fee0, fee1, p.token0, p.token1, px) }));
  });
  return out;
}

/* V4 positions live in one singleton, and its position NFT is not enumerable — so the ids
   come from the ledger, which finds them in Transfer logs, along with the pool id and ticks
   that never change for a position. */
async function arcV4Positions(tag, rows) {
  if (!rows.length) return [];
  const W = CFG.wallet.toLowerCase();
  const r = await arcMulti(rows.flatMap((p) => {
    const id = pad(BigInt(p.id).toString(16)), pid = p.pool_id.slice(2);
    return [
      { to: CFG.arcV4Posm, data: '0x6352211e' + id },                                  /* ownerOf */
      { to: CFG.arcV4State, data: '0xc815641c' + pid },                                /* getSlot0 */
      { to: CFG.arcV4State, data: '0x53e9c1fb' + pid + enc24(p.lo) + enc24(p.hi) },    /* getFeeGrowthInside */
      { to: CFG.arcV4State, data: '0xdacf1d2f' + pid + pad(CFG.arcV4Posm) + enc24(p.lo) + enc24(p.hi) + id }, /* getPositionInfo */
    ];
  }), tag);
  const out = [];
  rows.forEach((p, i) => {
    const b = i * 4;
    if (!r[b + 1].ok || !r[b + 3].ok) return;
    const owner = r[b].ok ? toAddr(w(r[b].data, 0)).toLowerCase() : '';
    if (owner !== W && !p.staked) return;                /* burnt, sold or given away */
    const liq = toBig(w(r[b + 3].data, 0));
    if (liq === 0n) return;
    const sq = toBig(w(r[b + 1].data, 0)), tick = Number(toSigned(w(r[b + 1].data, 1)));
    const d0 = arcDec(p.token0, p.d0), d1 = arcDec(p.token1, p.d1);
    const [r0, r1] = v3Amounts(liq, p.lo, p.hi, sq);
    let f0 = 0n, f1 = 0n;
    if (r[b + 2].ok) {
      f0 = accrued(liq, toBig(w(r[b + 2].data, 0)), toBig(w(r[b + 3].data, 1)));
      f1 = accrued(liq, toBig(w(r[b + 2].data, 1)), toBig(w(r[b + 3].data, 2)));
    }
    const fee0 = Number(f0) / 10 ** d0, fee1 = Number(f1) / 10 ** d1;
    const h0 = r0 / 10 ** d0 + fee0, h1 = r1 / 10 ** d1 + fee1;
    const px = poolPrice(sq, d0, d1);
    out.push(arcLpRow('v4', p, { tick, h0, h1,
      usd: arcPairUsd(h0, h1, p.token0, p.token1, px), feeUsd: arcPairUsd(fee0, fee1, p.token0, p.token1, px) }));
  });
  return out;
}

/* Wallet + LP in one pass. `tag` lets the same code value the wallet at a past block, which is
   how the history was backfilled. known.staked = V3 ids a contract holds for the wallet;
   known.v4 = the ledger's open V4 rows. */
async function getArc(tag = 'latest', known = {}) {
  const W = CFG.wallet.replace(/^0x/, '');
  const toks = Object.entries(CFG.arcTokens);
  let head;
  try {
    head = await arcMulti([
      { to: CFG.multicall, data: '0x4d2301cc' + pad(W) },     /* native USDC, 18 dp */
      { to: CFG.arcNpm, data: '0x70a08231' + pad(W) },
      ...toks.map(([, t]) => ({ to: t.a, data: '0x70a08231' + pad(W) })),
      ...toks.map(([, t]) => ({ to: t.pool, data: '0x3850c7bd' })),
    ], tag);
  } catch (e) {
    console.warn('arc read failed:', e.message);
    return { usdc: 0, tokens: {}, walletUsd: 0, lps: [], ok: false, lpOk: false };
  }
  const usdc = head[0].ok ? Number(toBig(w(head[0].data, 0))) / 1e18 : 0;
  const nV3 = head[1].ok ? Math.min(Number(toBig(w(head[1].data, 0))), 30) : -1;
  const tokens = { USDC: { balance: usdc, priceUSD: 1, valueUSD: round2(usdc) } };
  let walletUsd = usdc;
  toks.forEach(([sym, t], i) => {
    const b = head[2 + i], s = head[2 + toks.length + i];
    let px = null;
    if (s && s.ok && s.data.length >= 130) {
      /* each allowlisted token is priced off its own USDC pool; order is by address */
      const sq = toBig(w(s.data, 0));
      px = CFG.arcUsdc < t.a ? 1 / poolPrice(sq, 6, t.d) : poolPrice(sq, t.d, 6);
      if (!isFinite(px)) px = null;
    }
    const bal = b && b.ok ? Number(toBig(w(b.data, 0))) / 10 ** t.d : 0;
    const usd = px ? bal * px : 0;
    walletUsd += usd;
    if (bal > 0) tokens[sym] = { balance: bal, priceUSD: px, valueUSD: round2(usd) };
  });
  let lps = [], lpOk = true;
  try {
    /* a failed count must not read as "no positions" */
    if (nV3 < 0) throw new Error('position count unreadable');
    lps = [...await arcV3Positions(tag, nV3, known.staked || []), ...await arcV4Positions(tag, known.v4 || [])];
  } catch (e) {
    console.warn('arc LP read failed:', e.message);
    lpOk = false;
  }
  return { usdc, tokens, walletUsd, lps, ok: true, lpOk };
}

/* ---- Arc position ledger ------------------------------------------------------------
   Incremental, because a 10,000-block log cap makes re-reading a position's whole life each
   run a few hundred queries. Each run scans only the blocks since the last one and folds what
   it finds into running totals per position:
     in_usd  — every deposit, valued at its own block
     out_usd — every withdrawal, principal and fees alike, valued at its own block
   A closed position books out_usd − in_usd, as Katana's does. An open one is worth its live
   value plus what it has already paid out, less what went in — on a pool whose fees are
   collected several times a day, leaving the payouts out would report a loss that is not one.

   V3 carries amounts on its own events. V4 does not: ModifyLiquidity says only that liquidity
   changed, so the amounts are read from that transaction's token transfers between the wallet
   and Uniswap. That covers fees too, which V4 pays out on every modification. */
const ARC_TR = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ARC_INC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const ARC_DEC = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
/* bumped when the ledger starts recording something it did not before; an older ledger is
   rebuilt from the chain's first block so the new figure covers the whole history */
const ARC_LEDGER_VERSION = 2;   /* 2: fee claims */
const ARC_COL = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const ARC_MODLIQ = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';

async function arcBuildLedger(prev, fees) {
  if (prev && prev.version !== ARC_LEDGER_VERSION) {
    console.log('  arc ledger: older format, rebuilding from the first block');
    prev = null;
  }
  /* a rebuild recounts every collection, so the fee days it wrote before go first */
  if (!prev) feeClear(fees, 'arc');
  const led = { last_block: 0, open: {}, closed: [], ...(prev || {}), version: ARC_LEDGER_VERSION };
  led.open = { ...led.open };
  led.closed = [...led.closed];
  const W = CFG.wallet.toLowerCase(), Wt = '0x' + pad(W);
  const posmT = '0x' + pad(CFG.arcV4Posm);
  const latest = Number(BigInt(await arcRpc('eth_blockNumber', [])));
  const known = new Set([...Object.keys(led.open), ...led.closed.map((c) => c.uid)]);

  const tsCache = {};
  const blockTs = async (block, hint) => {
    if (hint && hint !== '0x0') return Number(BigInt(hint));      /* inline, and real here */
    if (tsCache[block] === undefined)
      tsCache[block] = Number(BigInt((await arcRpc('eth_getBlockByNumber', [hexBlock(block), false])).timestamp));
    return tsCache[block];
  };
  const day = (ts) => dayKey(ts);
  const slotCache = {};
  const slotAt = async (o, block) => {                /* pool price at that block */
    const k = o.uid + '@' + block;
    if (slotCache[k] === undefined) {
      const call = o.kind === 'v4' ? { to: CFG.arcV4State, data: '0xc815641c' + o.pool_id.slice(2) }
                                   : { to: o.pool, data: '0x3850c7bd' };
      const r = await arcRpc('eth_call', [call, hexBlock(block)]);
      const sqrt = toBig(w(r, 0));
      slotCache[k] = { sqrt, px: poolPrice(sqrt, arcDec(o.token0, o.d0), arcDec(o.token1, o.d1)) };
    }
    return slotCache[k];
  };
  const pxAt = async (o, block) => (await slotAt(o, block)).px;   /* token1 per token0 */
  let feePending = [];
  async function bookFee(o, block, tsHex, f0, f1) {
    const usd = arcPairUsd(f0, f1, o.token0, o.token1, await pxAt(o, block));
    if (usd === null || !(usd > 0)) return;
    o.fees_usd = (o.fees_usd || 0) + usd;
    feePending.push([await blockTs(block, tsHex), usd]);   /* booked when the window completes */
  }

  /* what a newly-seen position is, read at the block it arrived — a position burnt before
     this run can still be described there, thanks to archive state */
  async function describe(kind, id, block, blockTsHex) {
    const tag = hexBlock(block), idHex = pad(BigInt(id).toString(16));
    const rec = { uid: `arc:${kind}:${id}`, id: String(id), kind, chain: 'arc', opened_block: block,
      in_usd: 0, out_usd: 0, in0: 0, in1: 0, out0: 0, out1: 0, staked: false };
    if (kind === 'v3') {
      const r = await arcRpc('eth_call', [{ to: CFG.arcNpm, data: '0x99fbab88' + idHex }, tag]);
      rec.token0 = toAddr(w(r, 2)); rec.token1 = toAddr(w(r, 3)); rec.fee = Number(toBig(w(r, 4)));
      rec.lo = Number(toSigned(w(r, 5))); rec.hi = Number(toSigned(w(r, 6)));
      const m = await arcMulti([
        { to: CFG.arcFactory, data: '0x1698ee82' + pad(rec.token0) + pad(rec.token1) + pad(rec.fee.toString(16)) },
      ], tag);
      rec.pool = toAddr(w(m[0].data, 0));
    } else {
      const r = await arcRpc('eth_call', [{ to: CFG.arcV4Posm, data: '0x7ba03aad' + idHex }, tag]);
      rec.token0 = toAddr(w(r, 0)); rec.token1 = toAddr(w(r, 1)); rec.fee = Number(toBig(w(r, 2)));
      const info = toBig(w(r, 5));
      const s24 = (x) => { const v = Number(x & 0xffffffn); return v >= 0x800000 ? v - 0x1000000 : v; };
      rec.lo = s24(info >> 8n); rec.hi = s24(info >> 32n);
      /* the full pool id is not stored on the NFT (it keeps a 25-byte prefix), but the pool
         manager emits it on the ModifyLiquidity that opened the position, salted with the id */
      const logs = await arcLogs({ address: CFG.arcV4Pool, topics: [ARC_MODLIQ, null, posmT] }, block, block);
      const hit = logs.find((l) => BigInt('0x' + w(l.data, 3)) === BigInt(id));
      if (!hit) throw new Error(`no ModifyLiquidity for V4 #${id} in block ${block}`);
      rec.pool_id = hit.topics[1];
    }
    const sym = await arcMulti([
      { to: rec.token0, data: '0x313ce567' }, { to: rec.token0, data: '0x95d89b41' },
      { to: rec.token1, data: '0x313ce567' }, { to: rec.token1, data: '0x95d89b41' },
    ], tag);
    const nat = (a) => a.toLowerCase() === ZERO_ADDR;
    rec.d0 = nat(rec.token0) ? 18 : parseInt(sym[0].data, 16); rec.s0 = nat(rec.token0) ? 'USDC' : abiStr(sym[1].data);
    rec.d1 = nat(rec.token1) ? 18 : parseInt(sym[2].data, 16); rec.s1 = nat(rec.token1) ? 'USDC' : abiStr(sym[3].data);
    rec.pair = `${rec.s0} / ${rec.s1}`;
    rec.pool_fee = `${rec.fee / 10000}%`;
    rec.protocol = kind === 'v4' ? 'Uniswap V4' : 'Uniswap V3';
    rec.opened_ts = await blockTs(block, blockTsHex);
    rec.opened = day(rec.opened_ts);
    return rec;
  }

  async function book(o, block, tsHex, a0, a1, dir) {
    const px = await pxAt(o, block);
    const usd = arcPairUsd(a0, a1, o.token0, o.token1, px);
    if (dir === 'in') { o.in0 += a0; o.in1 += a1; o.in_usd += usd || 0; }
    else { o.out0 += a0; o.out1 += a1; o.out_usd += usd || 0; }
    if (usd === null) o.unpriced = true;
    o.last_block = block;
    o.last_ts = await blockTs(block, tsHex);
  }

  let from = led.last_block ? led.last_block + 1 : CFG.arcStartBlock;
  let reached = from - 1;
  const seenTx = new Set();
  try {
    for (; from <= latest; from += 10000) {
      const to = Math.min(from + 9999, latest);
      const nfts = [CFG.arcNpm, CFG.arcV4Posm];
      /* A window is all or nothing: if any read in it fails, the positions go back to how
         they stood before it and its fees are dropped, so the next run replays it cleanly
         instead of counting its first half twice. */
      const before = JSON.stringify(led.open), knownBefore = new Set(known);
      feePending = [];
      try {

      /* 1. position NFTs arriving — minted, or handed back by a contract */
      for (const l of await arcLogs({ address: nfts, topics: [ARC_TR, null, Wt] }, from, to)) {
        const kind = l.address.toLowerCase() === CFG.arcNpm ? 'v3' : 'v4';
        const id = BigInt(l.topics[3]).toString();
        const uid = `arc:${kind}:${id}`;
        if (led.open[uid]) { led.open[uid].staked = false; continue; }
        if (known.has(uid)) continue;
        led.open[uid] = await describe(kind, id, Number(BigInt(l.blockNumber)), l.blockTimestamp);
        known.add(uid);
        console.log(`  arc ledger: found ${uid} ${led.open[uid].pair}`);
      }

      /* 2. position NFTs leaving. To a contract it is still ours — a staking or farming
            contract holds it on our behalf, and it keeps being valued. To anyone else it
            is gone, and the settle step closes it out at what it had paid back. */
      for (const l of await arcLogs({ address: nfts, topics: [ARC_TR, Wt] }, from, to)) {
        const kind = l.address.toLowerCase() === CFG.arcNpm ? 'v3' : 'v4';
        const uid = `arc:${kind}:${BigInt(l.topics[3])}`;
        const o = led.open[uid];
        const dest = '0x' + l.topics[2].slice(26);
        if (!o || dest === ZERO_ADDR) continue;                 /* a burn — settle handles it */
        const code = await arcRpc('eth_getCode', [dest, hexBlock(Number(BigInt(l.blockNumber)))]);
        if (code && code !== '0x') { o.staked = true; o.staked_in = dest; console.log(`  arc ledger: ${uid} staked in ${dest}`); }
        else { o.left_to = dest; console.warn(`  arc ledger: ${uid} sent to ${dest}`); }
      }

      /* 3. V3 deposits and withdrawals, by token id */
      const v3 = Object.values(led.open).filter((o) => o.kind === 'v3');
      if (v3.length) {
        const byId = Object.fromEntries(v3.map((o) => [o.id, o]));
        const logs = await arcLogs({ address: CFG.arcNpm,
          topics: [[ARC_INC, ARC_DEC, ARC_COL], v3.map((o) => '0x' + pad(BigInt(o.id).toString(16)))] }, from, to);
        logs.sort((a, b) => (BigInt(a.blockNumber) === BigInt(b.blockNumber)
          ? Number(BigInt(a.logIndex) - BigInt(b.logIndex)) : Number(BigInt(a.blockNumber) - BigInt(b.blockNumber))));
        for (const l of logs) {
          const o = byId[BigInt(l.topics[1]).toString()];
          if (!o) continue;
          const blk = Number(BigInt(l.blockNumber));
          const r0 = toBig(w(l.data, 1)), r1 = toBig(w(l.data, 2));
          /* principal released, not yet paid — the next Collect pays this out first */
          if (l.topics[0] === ARC_DEC) {
            o.owed0 = String(BigInt(o.owed0 || 0) + r0); o.owed1 = String(BigInt(o.owed1 || 0) + r1);
            continue;
          }
          /* amounts as the pool moved them; a token with a transfer tax (ARGUS takes 1%)
             lands slightly short of this in the wallet */
          const a0 = Number(r0) / 10 ** o.d0, a1 = Number(r1) / 10 ** o.d1;
          if (l.topics[0] === ARC_INC) { await book(o, blk, l.blockTimestamp, a0, a1, 'in'); continue; }
          const ours = await paidToUs(l, [o.token0, o.token1], (h) => arcRpc('eth_getTransactionReceipt', [h]));
          if (ours) await book(o, blk, l.blockTimestamp, a0, a1, 'out');
          const ow0 = BigInt(o.owed0 || 0), ow1 = BigInt(o.owed1 || 0);
          const f0 = r0 > ow0 ? r0 - ow0 : 0n, f1 = r1 > ow1 ? r1 - ow1 : 0n;
          o.owed0 = String(ow0 > r0 ? ow0 - r0 : 0n); o.owed1 = String(ow1 > r1 ? ow1 - r1 : 0n);
          if (ours && (f0 || f1)) await bookFee(o, blk, l.blockTimestamp, Number(f0) / 10 ** o.d0, Number(f1) / 10 ** o.d1);
        }
      }

      /* 4. V4: find the transactions that touched our positions, then read the money moved */
      const v4 = Object.values(led.open).filter((o) => o.kind === 'v4');
      if (v4.length) {
        const logs = await arcLogs({ address: CFG.arcV4Pool,
          topics: [ARC_MODLIQ, [...new Set(v4.map((o) => o.pool_id))], posmT] }, from, to);
        /* one entry per transaction, with every liquidity change it made to the position */
        const txs = new Map();
        for (const l of logs) {
          const salt = BigInt('0x' + w(l.data, 3)).toString();
          const o = v4.find((x) => x.id === salt && x.pool_id === l.topics[1]);
          if (!o || seenTx.has(l.transactionHash)) continue;
          if (!txs.has(l.transactionHash)) txs.set(l.transactionHash, { o, l, dL: 0n });
          txs.get(l.transactionHash).dL += toSigned(w(l.data, 2));
        }
        for (const [hash, { o, l, dL }] of txs) {
          seenTx.add(hash);
          const rc = await arcRpc('eth_getTransactionReceipt', [l.transactionHash]);
          const leg = (a) => (a.toLowerCase() === ZERO_ADDR ? CFG.arcUsdc : a.toLowerCase());
          const t0 = leg(o.token0), t1 = leg(o.token1);
          const uni = new Set([CFG.arcV4Pool, CFG.arcV4Posm]);
          const flows = { in: [0, 0], out: [0, 0] };
          for (const x of rc.logs) {
            if (x.topics[0] !== ARC_TR || x.topics.length !== 3) continue;
            const a = x.address.toLowerCase();
            const side = a === t0 ? 0 : a === t1 ? 1 : -1;
            if (side < 0) continue;
            const src = '0x' + x.topics[1].slice(26), dst = '0x' + x.topics[2].slice(26);
            /* flows are logged by the ERC-20, so native USDC arrives in the face's 6 dp */
            const dec = a === CFG.arcUsdc ? 6 : side === 0 ? o.d0 : o.d1;
            const v = Number(BigInt(x.data)) / 10 ** dec;
            if (src === W && uni.has(dst)) flows.in[side] += v;
            else if (uni.has(src) && dst === W) flows.out[side] += v;
          }
          const blk = Number(BigInt(l.blockNumber));
          /* V4 routes the whole movement through one transaction, so a mint that refunds
             change shows both directions — net them rather than book both */
          const n0 = flows.in[0] - flows.out[0], n1 = flows.in[1] - flows.out[1];
          const i0 = Math.max(n0, 0), i1 = Math.max(n1, 0), o0 = Math.max(-n0, 0), o1 = Math.max(-n1, 0);
          if (i0 || i1) await book(o, blk, l.blockTimestamp, i0, i1, 'in');
          if (o0 || o1) await book(o, blk, l.blockTimestamp, o0, o1, 'out');

          /* V4 pays accrued fees on every modification, netted into the same transfer. What
             the liquidity change moved is known from the pool price at that block, so the
             rest is fees. Block-end price: a swap later in the same block can shift the split
             by a hair, so a negative remainder is taken as none rather than booked. A position
             with no liquidity before this transaction has earned nothing yet. */
          const had = BigInt(o.v4_liq || 0);
          o.v4_liq = String(had + dL);
          if (had > 0n) {
            const L = dL < 0n ? -dL : dL;
            const { sqrt } = await slotAt(o, blk);
            const [q0, q1] = L ? v3Amounts(L, o.lo, o.hi, sqrt) : [0, 0];
            const p0 = q0 / 10 ** arcDec(o.token0, o.d0), p1 = q1 / 10 ** arcDec(o.token1, o.d1);
            const f0 = Math.max(0, dL > 0n ? p0 - n0 : -n0 - p0);
            const f1 = Math.max(0, dL > 0n ? p1 - n1 : -n1 - p1);
            if (f0 || f1) await bookFee(o, blk, l.blockTimestamp, f0, f1);
          }
        }
      }
      } catch (e) {
        led.open = JSON.parse(before);
        known.clear(); knownBefore.forEach((k) => known.add(k));
        throw e;
      }
      for (const [ts, usd] of feePending) feeBook(fees, 'arc', ts, usd);
      reached = to;
    }
  } catch (e) {
    console.warn(`  arc ledger: scan stopped at block ${reached}:`, e.message);
  }
  led.last_block = reached;

  /* 5. settle — only once the scan has caught up, or a close could be booked before the
        withdrawal that went with it has been read */
  if (reached >= latest) {
    const open = Object.values(led.open);
    const res = await arcMulti(open.map((o) => o.kind === 'v3'
      ? { to: CFG.arcNpm, data: '0x99fbab88' + pad(BigInt(o.id).toString(16)) }
      : { to: CFG.arcV4Posm, data: '0x1efeed33' + pad(BigInt(o.id).toString(16)) }));
    open.forEach((o, i) => {
      const r = res[i];
      let done;
      if (o.kind === 'v3') done = !r.ok || (toBig(w(r.data, 7)) === 0n && toBig(w(r.data, 10)) === 0n && toBig(w(r.data, 11)) === 0n);
      else done = !r.ok || toBig(w(r.data, 0)) === 0n;
      if (o.left_to) done = true;
      if (!done) return;
      const pnl = o.out_usd - o.in_usd;
      led.closed.push({
        uid: o.uid, id: o.id, chain: 'arc', protocol: o.protocol, pair: o.pair, pool_fee: o.pool_fee,
        opened: o.opened, opened_ts: o.opened_ts,
        closed: o.last_ts ? day(o.last_ts) : o.opened, closed_ts: o.last_ts || o.opened_ts,
        open_value_usd: round2(o.in_usd), close_value_usd: round2(o.out_usd),
        pnl_usd: round2(pnl), pnl_pct: o.in_usd > 0 ? round2(pnl / o.in_usd * 100) : 0,
        fees_usd: round2(o.fees_usd || 0),
        in0: o.in0, in1: o.in1, out0: o.out0, out1: o.out1,
        ...(o.unpriced ? { unpriced: true } : {}),
      });
      delete led.open[o.uid];
      console.log(`  arc ledger: closed ${o.uid} ${o.pair} realised $${pnl.toFixed(2)}`);
    });
    led.closed.sort((a, b) => b.closed_ts - a.closed_ts);
  }
  return led;
}

async function getSolana() {
  const [balRes, usdcRes, posAccounts] = await Promise.all([
    solRpc('getBalance', [CFG.solWallet]),
    solRpc('getTokenAccountsByOwner', [CFG.solWallet, { mint: CFG.usdcMint }, { encoding: 'jsonParsed' }]),
    solRpc('getProgramAccounts', [CFG.dlmmProgram, {
      encoding: 'base64', dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: 40, bytes: CFG.solWallet } }],
    }]),
  ]);
  const sol = balRes.value / 1e9;
  const usdc = usdcRes.value.length ? Number(usdcRes.value[0].account.data.parsed.info.tokenAmount.uiAmount) : 0;
  /* Publish the token account address. getTokenAccountsByOwner hangs on the only
     browser-reachable Solana endpoint, so the dashboard reads this account directly. */
  const usdcAta = usdcRes.value.length ? usdcRes.value[0].pubkey : null;

  const lps = [], refs = [];
  let poolSolPrice = null;
  for (const acc of posAccounts) {
    const posInfo = await solRpc('getAccountInfo', [acc.pubkey, { encoding: 'base64' }]);
    if (!posInfo.value) continue;
    const pos = b64bytes(posInfo.value.data[0]);
    const pdv = dv(pos);
    const lbPair = b58enc(pos.slice(8, 40));
    const lower = pdv.getInt32(7912, true), upper = pdv.getInt32(7916, true);
    const pairInfo = await solRpc('getAccountInfo', [lbPair, { encoding: 'base64' }]);
    const pair = b64bytes(pairInfo.value.data[0]);
    const padv = dv(pair);
    const binStep = padv.getUint16(80, true);
    const activeId = padv.getInt32(76, true);
    const mintX = b58enc(pair.slice(88, 120)), mintY = b58enc(pair.slice(120, 152));
    if (mintX !== CFG.solMint || mintY !== CFG.usdcMint) continue; // only SOL/USDC supported
    const base = 1 + binStep / 10000;
    poolSolPrice = Math.pow(base, activeId) * 1000;

    const idxs = [];
    for (let b = Math.floor(lower / 70); b <= Math.floor(upper / 70); b++) idxs.push(b);
    const binArrays = [];
    let totX = 0n, totY = 0n;
    for (const idx of idxs) {
      const le = new Uint8Array(8);
      let v = BigInt.asUintN(64, BigInt(idx));
      for (let i = 0; i < 8; i++) { le[i] = Number(v & 255n); v >>= 8n; }
      const gpa = await solRpc('getProgramAccounts', [CFG.dlmmProgram, {
        encoding: 'base64',
        filters: [{ memcmp: { offset: 8, bytes: b58enc(le) } }, { memcmp: { offset: 24, bytes: lbPair } }],
      }]);
      if (!gpa.length) continue;
      binArrays.push(gpa[0].pubkey);
      const arr = b64bytes(gpa[0].account.data[0]);
      const adv = dv(arr);
      const arrLower = idx * 70;
      for (let binId = lower; binId <= upper; binId++) {
        const j = binId - arrLower;
        if (j < 0 || j >= 70) continue;
        const share = dvU128(pdv, 72 + (binId - lower) * 16);
        if (share === 0n) continue;
        const off = 56 + j * 144;
        const supply = dvU128(adv, off + 32);
        if (supply === 0n) continue;
        totX += dvU64(adv, off) * share / supply;
        totY += dvU64(adv, off + 8) * share / supply;
      }
    }
    let feeX = 0n, feeY = 0n;
    for (let i = 0; i <= upper - lower; i++) {
      feeX += dvU64(pdv, 4552 + i * 48 + 32);
      feeY += dvU64(pdv, 4552 + i * 48 + 40);
    }
    refs.push({ position: acc.pubkey, lbPair, binArrays });
    lps.push({
      _sol: Number(totX + feeX) / 1e9, _usdc: Number(totY + feeY) / 1e6,
      _rangeLow: Math.pow(base, lower) * 1000, _rangeHigh: Math.pow(base, upper) * 1000,
      _pubkey: acc.pubkey,
    });
  }

  // SOL price: CoinGecko with on-chain pool price as fallback
  let solPrice = poolSolPrice;
  try {
    const j = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')).json();
    if (j?.solana?.usd) solPrice = j.solana.usd;
  } catch { /* keep pool price */ }
  if (!solPrice) solPrice = 0;

  const lpPositions = lps.map((p) => ({
    type: 'LP', protocol: 'Meteora DLMM', pair: 'SOL / USDC', pool_fee: 'DLMM',
    value_usd: round2(p._sol * solPrice + p._usdc), apr: null,
    note: `#${p._pubkey.slice(0, 6)} — range $${p._rangeLow.toFixed(1)}-$${p._rangeHigh.toFixed(1)}, ${p._sol.toFixed(3)} SOL + ${p._usdc.toFixed(2)} USDC (auto-detected on-chain)`,
  }));
  return { sol, usdc, solPrice, lps: lpPositions, refs, usdcAta };
}

/* ---------- merkl ---------- */
async function getMerkl(katPrice, chainId = 747474) {
  try {
    const arr = await (await fetch(`${CFG.merklApi}/users/${CFG.wallet}/rewards?chainId=${chainId}`)).json();
    let totalUsd = 0;
    const rewards = [];
    for (const chain of arr || []) {
      for (const rw of chain.rewards || []) {
        const dec = rw.token?.decimals ?? 18;
        const unclaimed = BigInt(rw.amount || '0') - BigInt(rw.claimed || '0') + BigInt(rw.pending || '0');
        if (unclaimed <= 0n) continue;
        const amt = Number(unclaimed) / 10 ** dec;
        const sym = rw.token?.symbol || '?';
        const px = rw.token?.price || (sym === 'KAT' ? katPrice : 0);
        totalUsd += amt * px;
        rewards.push({ symbol: sym, amount: amt, usd: round2(amt * px) });
      }
    }
    return { total_usd: round2(totalUsd), rewards };
  } catch {
    return { total_usd: 0, rewards: [] };
  }
}
async function getAprs() {
  try {
    const arr = await (await fetch(`${CFG.merklApi}/opportunities?chainId=747474&action=POOL&items=50`)).json();
    const map = {};
    for (const o of Array.isArray(arr) ? arr : []) {
      const m = (o.name || '').match(/SushiSwap (\S+)-(\S+) ([\d.]+%)/);
      if (m) map[`${m[1]} / ${m[2]}|${m[3]}`] = o.apr;
    }
    return map;
  } catch { return {}; }
}

/* ---------- compose ---------- */
const round2 = (v) => Math.round(v * 100) / 100;

/* carry forward previously-discovered staked LP ids so detection survives a log-scan hiccup */
let prevStakedIds = [], prevSnap = null;
try {
  prevSnap = JSON.parse(readFileSync(join(ROOT, 'data.json'), 'utf8'));
  prevStakedIds = prevSnap.staked_lp_ids || [];
} catch { /* first run or unreadable snapshot */ }
/* A chain whose read failed keeps its last snapshot's figures rather than reading as zero.
   The history series now includes every chain, so a zero would chart as a crash that never
   happened — and the next run would chart the recovery as a gain. */
const prevChain = (key) => (prevSnap && prevSnap.chains && prevSnap.chains[key]) || null;

const [kat, sol] = await Promise.all([getKatana(prevStakedIds), getSolana()]);
const [merkl, aprMap] = await Promise.all([getMerkl(kat.katPrice), getAprs()]);
/* after Katana, because it needs the ETH price that read already fetched */
const rh = await getRobinhood(kat.ethPrice);
if (!rh.ok && prevChain('robinhood')) {
  const pr = prevChain('robinhood');
  rh.walletUsd = pr.onchain_usd || 0;
  rh.tokens = (pr.wallet && pr.wallet.balances && pr.wallet.balances.tokens) || {};
  rh.lps = pr.lp_positions || [];
  console.warn('robinhood: carrying the last snapshot forward');
}
const rhLpUsd = rh.lps.reduce((a, l) => a + (l.value_usd || 0), 0);
const rhTotal = rh.walletUsd + rhLpUsd;
const claims = await updateClaims(CFG.wallet.replace(/^0x/, ''), kat.katPrice);
const positions = await updatePositions(CFG.wallet.replace(/^0x/, ''));
/* Robinhood keeps its own section: its positions are priced from swap history rather than
   archive state, and mixing the two ledgers would hide which method produced a figure. */
if (rh.lps.length || (positions.robinhood && Object.keys(positions.robinhood.open || {}).length)) {
  try {
    const cur = rh.lps.map((l) => ({
      id: l._id, pool: l._pool, token0: l._token0, token1: l._token1,
      d0: l._d0, d1: l._d1, s0: l._s0, s1: l._s1, fee: l._fee,
    }));
    positions.robinhood = await rhBuildLedger(cur, positions.robinhood);
    writeFileSync(join(ROOT, 'positions.json'), JSON.stringify(positions, null, 2) + String.fromCharCode(10));
  } catch (e) {
    console.warn('robinhood ledger failed, keeping existing record:', e.message);
  }
}

/* Arc: the ledger runs before the valuation, because it is what knows the V4 positions and
   any staked V3 ones — neither NFT contract can list those for a wallet. */
const fees = feeStore(claims);
try {
  positions.arc = await arcBuildLedger(positions.arc, fees);
  writeFileSync(join(ROOT, 'positions.json'), JSON.stringify(positions, null, 2) + String.fromCharCode(10));
} catch (e) {
  console.warn('arc ledger failed, keeping existing record:', e.message);
}
/* LP fee claims on the other two EVM chains — each failure costs that chain's record only */
try { await robinhoodFees(fees, positions.robinhood || {}); }
catch (e) { console.warn('robinhood fee scan failed, resuming next run:', e.message); }
try { await katanaFees(fees, positions, kat.stakedLpIds); }
catch (e) { console.warn('katana fee scan failed, resuming next run:', e.message); }
/* Arc's scan state lives in its ledger; copy what the browser needs to add collections made
   after this run: where the ledger stopped, and each open V3 position's pool and owed principal */
{
  const a = { last_block: (positions.arc && positions.arc.last_block) || 0, ids: [], owed: {}, meta: {} };
  for (const o of Object.values((positions.arc && positions.arc.open) || {})) {
    if (o.kind !== 'v3') continue;
    a.ids.push(o.id);
    a.meta[o.id] = { pool: o.pool, token0: o.token0, token1: o.token1, d0: o.d0, d1: o.d1 };
    if (BigInt(o.owed0 || 0) || BigInt(o.owed1 || 0)) a.owed[o.id] = [String(o.owed0 || 0), String(o.owed1 || 0)];
  }
  fees.state.arc = a;
}
fees.start_date = Object.keys(fees.days).sort()[0] || null;
writeFileSync(join(ROOT, 'claims.json'), JSON.stringify(claims, null, 2) + '\n');
const arcOpen = Object.values((positions.arc && positions.arc.open) || {});
const arcKnown = {
  staked: arcOpen.filter((o) => o.kind === 'v3' && o.staked).map((o) => o.id),
  v4: arcOpen.filter((o) => o.kind === 'v4').map((o) => ({
    id: o.id, pool_id: o.pool_id, token0: o.token0, token1: o.token1, d0: o.d0, d1: o.d1,
    s0: o.s0, s1: o.s1, fee: o.fee, lo: o.lo, hi: o.hi, staked: !!o.staked })),
};
const arc = await getArc('latest', arcKnown);
if (!arc.ok && prevChain('arc')) {
  const pa = prevChain('arc');
  arc.walletUsd = pa.onchain_usd || 0;
  arc.tokens = (pa.wallet && pa.wallet.balances && pa.wallet.balances.tokens) || {};
  arc.lps = pa.lp_positions || [];
  console.warn('arc: carrying the last snapshot forward');
} else if (!arc.lpOk && prevChain('arc')) {
  arc.lps = prevChain('arc').lp_positions || [];
  console.warn('arc: positions unreadable, carrying the last snapshot forward');
}
const arcMerkl = await getMerkl(kat.katPrice, 5042);
const arcLpUsd = round2(arc.lps.reduce((a, l) => a + (l.value_usd || 0), 0));
const arcWalletUsd = round2(arc.walletUsd);
const arcTotal = round2(arcWalletUsd + arcLpUsd + arcMerkl.total_usd);

for (const lp of kat.lps) {
  const key = `${lp.pair}|${lp.pool_fee}`;
  if (aprMap[key] !== undefined) lp.apr = round2(aprMap[key]);
}

const katWalletUsd = round2(
  kat.ethBal * kat.ethPrice + kat.bal.KAT * kat.katPrice + kat.bal.WETH * kat.ethPrice +
  kat.bal.USDC + kat.bal.USDT + kat.bal.avKAT * kat.katPrice * kat.avkatRate);
const katLpUsd = round2(kat.lps.reduce((s, l) => s + l.value_usd, 0));
const colKat = kat.morpho.collateral * kat.avkatRate;
const morphoNet = round2(Math.max(0, (colKat - kat.morpho.debt) * kat.katPrice));
const vkatKat = kat.vkat.totalKat;
const vkatUsd = round2(vkatKat * kat.katPrice);
const katTotal = round2(katWalletUsd + katLpUsd + morphoNet + vkatUsd + merkl.total_usd);
const solWalletUsd = round2(sol.sol * sol.solPrice + sol.usdc);
const solLpUsd = round2(sol.lps.reduce((s, l) => s + l.value_usd, 0));
const solTotal = round2(solWalletUsd + solLpUsd);
const grand = round2(katTotal + solTotal);
const onchainUsd = round2(katWalletUsd + solWalletUsd);
const lpUsd = round2(katLpUsd + solLpUsd);
/* every chain — what the headline, the tracking figure and the history series all use.
   `grand` alone is Katana + Solana, and the history was written from it for eight days after
   Robinhood arrived, which charted a transfer between chains as a $470 loss. */
const grandAll = round2(grand + rhTotal + arcTotal);
const onchainAll = round2(onchainUsd + rh.walletUsd + arcWalletUsd);
const lpAll = round2(lpUsd + rhLpUsd + arcLpUsd);
const pendingAll = round2(merkl.total_usd + arcMerkl.total_usd);
const now = new Date();
const days = Math.floor((now - new Date(CFG.startDate + 'T00:00:00Z')) / 86400000);
const current = round2(grandAll - katLpUsd);
const gain = round2(current - CFG.startValue);

const tok = (balance, priceUSD, valueUSD) => ({ balance, priceUSD, valueUSD: round2(valueUSD) });
const defiPositions = [{
  type: 'Lending', protocol: 'Morpho Blue', market: 'KAT / avKAT',
  collateral: { amount: kat.morpho.collateral, token: 'avKAT' },
  debt: { amount: kat.morpho.debt, token: 'KAT' },
  lltv: '77%', avkat_rate: kat.avkatRate, value_usd: morphoNet,
  note: `Net ${Math.round(colKat - kat.morpho.debt).toLocaleString('en-US')} KAT = $${morphoNet} · avKAT rate ${kat.avkatRate.toFixed(4)}`,
}];
if (vkatKat > 0) defiPositions.push({
  type: 'Staking', protocol: 'Katana vKAT',
  market: 'Voting escrow' + (kat.vkat.ids.length ? ' · veNFT #' + kat.vkat.ids.join(', #') : ''),
  locked: { amount: vkatKat, token: 'vKAT' },
  value_usd: vkatUsd,
  note: `${Math.round(vkatKat).toLocaleString('en-US')} vKAT = $${vkatUsd} · backed 1:1 by locked KAT · 60d cooldown to exit (auto-detected on-chain)`,
});

const data = {
  last_updated: now.toISOString(),
  wealth_target_usdc: CFG.target,
  tracking: {
    start_date: CFG.startDate,
    start_value_usd: CFG.startValue,
    current_value_usd: current,
    value_gain_usd: gain,
    kat_price: kat.katPrice,
    kat_tokens_claimed: CFG.katClaimed,
    monthly_roi_pct: round2(gain / CFG.startValue * 100),
    days_elapsed: days,
  },
  chains: {
    katana: {
      name: 'Katana', chain_id: 747474, explorer: 'https://explorer.katana.network',
      wallet: { balances: { tokens: {
        ETH: tok(kat.ethBal, kat.ethPrice, kat.ethBal * kat.ethPrice),
        KAT: tok(kat.bal.KAT, kat.katPrice, kat.bal.KAT * kat.katPrice),
        WETH: tok(kat.bal.WETH, kat.ethPrice, kat.bal.WETH * kat.ethPrice),
        USDC: tok(kat.bal.USDC, 1, kat.bal.USDC),
        USDT: tok(kat.bal.USDT, 1, kat.bal.USDT),
        avKAT: tok(kat.bal.avKAT, kat.katPrice * kat.avkatRate, kat.bal.avKAT * kat.katPrice * kat.avkatRate),
      }, total_usd: katWalletUsd } },
      onchain_usd: katWalletUsd,
      merkl_rewards: merkl,
      lp_positions: kat.lps,
      defi_positions: defiPositions,
      lp_total_usd: katLpUsd,
      total_usd: katTotal,
      native_token: 'KAT', color: '#f59e0b',
    },
    robinhood: {
      name: 'Robinhood', chain_id: 4663, explorer: 'https://robinhoodchain.blockscout.com',
      wallet: { balances: { tokens: {
        ETH: tok(rh.eth, kat.ethPrice, rh.eth * kat.ethPrice),
        ...rh.tokens,
      } }, total_usd: rh.walletUsd },
      onchain_usd: rh.walletUsd,
      lp_positions: rh.lps,
      defi_positions: [],
      lp_total_usd: rhLpUsd,
      total_usd: rh.walletUsd + rhLpUsd,
      /* false when the read failed — the browser uses this to tell "no holdings" from
         "could not reach the chain", which look identical in the numbers alone */
      live: rh.ok,
      native_token: 'ETH', color: '#00c805',
    },
    arc: {
      name: 'Arc', chain_id: 5042, explorer: 'https://explorer.arc.io',
      wallet: { balances: { tokens: arc.tokens }, total_usd: arcWalletUsd },
      onchain_usd: arcWalletUsd,
      merkl_rewards: arcMerkl,
      lp_positions: arc.lps,
      defi_positions: [],
      lp_total_usd: arcLpUsd,
      total_usd: arcTotal,
      live: arc.ok,
      native_token: 'USDC', color: '#5b9cff',
      /* what the browser needs to value positions the NFT contracts cannot list for it,
         and the block the ledger has read to, so the browser only scans what came after */
      v4_positions: arcKnown.v4,
      staked_ids: arcKnown.staked,
      last_block: (positions.arc && positions.arc.last_block) || 0,
    },
    solana: {
      name: 'Solana', chain_id: 'solana-mainnet', explorer: 'https://solscan.io',
      wallet_address: CFG.solWallet,
      balances: {
        SOL: { balance: sol.sol, priceUSD: sol.solPrice, valueUSD: round2(sol.sol * sol.solPrice) },
        USDC: { balance: sol.usdc, priceUSD: 1, valueUSD: round2(sol.usdc) },
      },
      wallet_total_usd: solWalletUsd,
      onchain_usd: solWalletUsd,
      lp_positions: sol.lps,
      defi_positions: [],
      lp_total_usd: solLpUsd,
      total_usd: solTotal,
      native_token: 'SOL', color: '#9945ff',
    },
  },
  summary: {
    grand_total_usd: grandAll,
    katana_usd: katTotal, solana_usd: solTotal, robinhood_usd: round2(rhTotal), arc_usd: arcTotal,
    onchain_usd: onchainAll, lp_usd: lpAll, merkl_usd: pendingAll,
    total_defi_positions: defiPositions.length, chains_count: 4,
  },
  merkl_rewards: merkl,
  lp_positions: [...kat.lps, ...sol.lps,
    ...rh.lps.map((l) => { const c = { ...l }; Object.keys(c).forEach((k) => k[0] === '_' && delete c[k]); return c; }),
    ...arc.lps],
  defi_positions: defiPositions,
  meteora_refs: sol.refs,
  usdc_ata: sol.usdcAta,
  staked_lp_ids: kat.stakedLpIds,
  onchain_usd: onchainAll,
  total_usd: grandAll,
};

writeFileSync(join(ROOT, 'data.json'), JSON.stringify(data, null, 2) + '\n');

/* history: one entry per UTC date (replace same-date entry) */
const histPath = join(ROOT, 'history.json');
const hist = JSON.parse(readFileSync(histPath, 'utf8'));
const today = now.toISOString().slice(0, 10);
const entry = {
  date: today,
  timestamp: now.toISOString(),
  onchain_usd: onchainAll,
  pending_usd: pendingAll,
  lp_usd: lpAll,
  solana_usd: solTotal,
  robinhood_usd: round2(rhTotal),
  arc_usd: arcTotal,
  total_usd: grandAll,
};
const i = hist.data.findIndex((e) => e.date === today);
if (i >= 0) hist.data[i] = entry; else hist.data.push(entry);
writeFileSync(histPath, JSON.stringify(hist, null, 2) + '\n');

console.log(`Updated: total $${grandAll} | Katana $${katTotal} (wallet $${katWalletUsd}, LP $${katLpUsd}, Morpho $${morphoNet}, Merkl $${merkl.total_usd}) | Solana $${solTotal} | Robinhood $${round2(rhTotal)} (wallet $${round2(rh.walletUsd)}, LP $${round2(rhLpUsd)}) | Arc $${arcTotal} (wallet $${arcWalletUsd}, LP $${arcLpUsd}, Merkl $${arcMerkl.total_usd})`);
console.log(`KAT $${kat.katPrice.toFixed(6)} | ETH $${kat.ethPrice.toFixed(2)} | SOL $${sol.solPrice} | avKAT rate ${kat.avkatRate.toFixed(4)}`);
console.log(`Sushi LPs: ${kat.lps.length} | Meteora positions: ${sol.lps.length} | Arc LPs: ${arc.lps.length}`);
if (positions.arc) console.log(`Arc ledger: to block ${positions.arc.last_block}, ${Object.keys(positions.arc.open).length} open, ${positions.arc.closed.length} closed (realised ${round2(positions.arc.closed.reduce((a, c) => a + (c.pnl_usd || 0), 0))})`);
console.log(`Claim record: ${Object.keys(claims.days).length} day(s) with claims since ${claims.start_date}`);
{
  const tot = {};
  for (const d of Object.values(fees.days)) for (const [c, v] of Object.entries(d)) tot[c] = (tot[c] || 0) + v;
  console.log(`LP fee record: ${Object.keys(fees.days).length} day(s) since ${fees.start_date} | ` +
    Object.entries(tot).map(([c, v]) => `${c} $${round2(v)}`).join(' | '));
}
console.log(`Position ledger: ${positions.closed.length} closed (realised ${round2(positions.closed.reduce((s, c) => s + c.pnl_usd, 0))}), ${Object.keys(positions.open).length} open (${Object.values(positions.open).map((o) => '#' + (o.opened || '?') + ' $' + (o.open_value_usd ?? '-')).join(', ')})`);
