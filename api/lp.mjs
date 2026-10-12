/* ============================================================================
   api/lp — the live numbers an LP range widget needs, for a phone.

   Why this exists as an endpoint rather than in the page: a home-screen widget
   has no browser. Android's widget makers (KWGT and friends) can fetch a URL
   and read a JSON path, but they cannot do Uniswap maths, so the arithmetic has
   to be finished before it leaves the server.

   Two sources, deliberately split:
     - the slow facts (which positions are open, what went in, the pair labels)
       come from positions.json, which the 6-hourly Action already maintains;
     - the fast facts (pool price, liquidity, accrued fees, Merkl) are read live
       on every request, because the whole point of a range widget is where the
       price sits right now.

   Zero dependencies, like the rest of this repo.
   ========================================================================== */

const CFG = {
  katRpc: 'https://rpc.katanarpc.com',
  arcRpc: 'https://rpc.mainnet.arc.io',
  wallet: '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1',
  multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
  npm: '0x2659C6085D26144117D904C46B48B6d180393d27',
  factory: '0x203e8740894c8955cB8950759876d7E7E45E04c1',
  arcV4State: '0x6e43e7be27a11956218d6882ecc0cc1bed63e31f',
  arcV4Posm: '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b',
  lpStaker: '0xbe12e1b5c4859a3d141412748279b67458f729e9',   /* holds staked Sushi position NFTs */
  /* Katana caps a log query at 1,000 blocks and runs at about a second a block, so each
     window is a quarter of an hour. Eight of them reach back a couple of hours, which is
     what it takes to notice a position staked since the ledger's last pass; anything older
     than that the ledger already knows about. */
  stakedChunk: 1000,
  stakedChunks: 6,
  stakedLookback: 250000,   /* about three days at a second a block */
  walletTail: 25,          /* how far up the owner's token list a new NFT could sit */
  merklApi: 'https://api.merkl.xyz/v4',
  /* Katana's token list, by address. A pair whose legs are not both here cannot be
     priced, and the position is reported with its range but no dollar figures. */
  tokens: {
    '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36': { s: 'vbUSDC', d: 6, stable: true },
    '0x2dca96907fde857dd3d816880a0df407eeb2d2f2': { s: 'vbUSDT', d: 6, stable: true },
    '0x0913da6da4b42f538b445599b46bb4622342cf52': { s: 'vbWBTC', d: 8 },
    '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62': { s: 'vbETH', d: 18 },
    '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d': { s: 'KAT', d: 18 },
  },
};

/* ---------- abi plumbing (the same helpers the Action uses) ---------- */
const MOD256 = 1n << 256n;
const pad = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const w = (hex, i) => hex.substr(2 + i * 64, 64);
const toBig = (word) => BigInt('0x' + word);
const toSigned = (word) => { const v = toBig(word); return v > (1n << 255n) ? v - MOD256 : v; };
const toAddr = (word) => '0x' + word.slice(24);
const enc24 = (t) => pad(BigInt.asUintN(256, BigInt(t)).toString(16));
const lc = (s) => String(s).toLowerCase();

async function rpc(url, method, params) {
  /* The public nodes drop a connection now and then; a widget that fails because of one
     reset socket is a widget nobody trusts, so every call gets a few attempts. */
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
const multi = async (url, calls, tag = 'latest') =>
  decodeAgg3(await rpc(url, 'eth_call', [{ to: CFG.multicall, data: encodeAgg3(calls) }, tag]));

/* ---------- uniswap v3 maths ---------- */
function v3Amounts(L, lo, hi, sqrtPX96) {
  const sp = Number(sqrtPX96) / 2 ** 96;
  const sa = Math.pow(1.0001, lo / 2), sb = Math.pow(1.0001, hi / 2);
  const Lf = Number(L);
  if (sp <= sa) return [Lf * (1 / sa - 1 / sb), 0];
  if (sp >= sb) return [0, Lf * (sb - sa)];
  return [Lf * (1 / sp - 1 / sb), Lf * (sp - sa)];
}
const poolPrice = (sqrtPX96, d0, d1) => {
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

/* ---------- presentation ----------
   The strings are built here so the widget never has to format anything. KWGT's
   formula language can read a JSON path but makes a meal of arithmetic. */
const money = (n, dp = 2) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US',
  { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signed = (n) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* a price is quoted with as many decimals as it needs to be legible at any scale */
const price = (n) => n >= 1000 ? money(n, 0) : n >= 1 ? money(n, 2) : n >= 0.01 ? money(n, 4) : money(n, 8);
const pct = (n, dp = 2) => n.toFixed(dp) + '%';
const r2 = (n) => Math.round(n * 100) / 100;

/* Where the price sits inside the band, as a percentage of the band's width.
   Measured on a log scale because that is the scale ticks are spaced on — a
   linear reading would put the marker in the wrong place on a wide range. */
function bandPosition(now, lower, upper) {
  if (!(upper > lower) || !(now > 0)) return null;
  const p = Math.log(now / lower) / Math.log(upper / lower) * 100;
  return Math.round(p * 10) / 10;
}

/* ---------- which Katana positions are open, right now ----------
   The ledger is written by a job that runs every six hours, so a position opened since its
   last pass is not in it — which is exactly when someone looks at the widget, having just
   re-ranged. Three sources, cheapest first:

     1. the ledger, for everything already settled;
     2. the NFTs the wallet itself holds, which is one read and catches an unstaked
        position the moment it is minted;
     3. Transfer logs for a position handed to the staker, because a staked NFT leaves the
        wallet and no enumeration can see it. Newest window first, and only back as far as
        the ledger already reaches.

   Positions the ledger has already closed are dropped from the candidates — the wallet goes
   on holding the spent NFT of every position it has ever closed, 99 of them here, and there
   is no sense asking the chain about those again. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function katanaCandidates(pos, stakedSeed) {
  const ids = new Set(Object.keys(pos.open || {}));
  (stakedSeed || []).forEach((id) => ids.add(String(id)));
  const closed = new Set((pos.closed || []).map((c) => String(c.id)));

  const walletHeld = (async () => {
    const bal = Number(toBig(w(await rpc(CFG.katRpc, 'eth_call',
      [{ to: CFG.npm, data: '0x70a08231' + pad(CFG.wallet) }, 'latest']), 0)));
    if (!bal) return [];
    /* Only the tail of the list can hold something new. ERC721Enumerable appends a token it
       receives at the owner's last index, and closing a V3 position burns its liquidity
       rather than the NFT, so nothing is removed to shuffle it away. Reading the last few
       indices instead of all ninety-nine is the difference between 300ms and 1.1s. */
    const batch = [];
    for (let k = Math.max(0, bal - CFG.walletTail); k < bal; k++)
      batch.push({ to: CFG.npm, data: '0x2f745c59' + pad(CFG.wallet) + pad(k.toString(16)) });
    const r = await multi(CFG.katRpc, batch);
    return r.filter((x) => x.ok).map((x) => String(toBig(w(x.data, 0))));
  })();

  const staked = (async () => {
    const head = Number(toBig((await rpc(CFG.katRpc, 'eth_blockNumber', [])).slice(2)));
    const logs = async (from, to) => rpc(CFG.katRpc, 'eth_getLogs', [{
      address: CFG.npm, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      topics: [TRANSFER, '0x' + pad(CFG.wallet), '0x' + pad(CFG.lpStaker)],
    }]);
    /* The node's documented thousand-block limit is on the size of the answer, not the
       width of the question. Naming the contract and all three topics makes this one
       return a handful of logs at most, and it is accepted across days of blocks — one
       request where a chunked sweep took six and still reached back only an hour. */
    let out;
    try {
      out = await logs(head - CFG.stakedLookback, head);
    } catch {
      const windows = [];
      for (let to = head; windows.length < CFG.stakedChunks; to -= CFG.stakedChunk)
        windows.push([to - CFG.stakedChunk + 1, to]);
      const got = await Promise.all(windows.map(([a, b]) => logs(a, b).catch(() => [])));
      out = got.flat();
    }
    return (out || []).map((l) => String(toBig(l.topics[3].slice(2))));
  })();

  for (const id of await walletHeld) ids.add(id);
  for (const id of await staked) ids.add(id);
  for (const id of closed) ids.delete(id);
  return [...ids];
}

/* ---------- katana: sushi v3 ---------- */
async function katanaRows(open, candidates) {
  const ids = candidates || Object.keys(open || {});
  if (!ids.length) return [];
  /* positions() for the band and the liquidity, and ownerOf to settle whether it is staked.
     The ledger does not record staking, and whether the trading fees are his turns on it —
     a staked Sushi position's fees are collected by the Katana DAO. The staker holding the
     NFT is the only authority on that, so it is read rather than inferred. */
  const posRes = await multi(CFG.katRpc, ids.flatMap((id) => {
    const h = pad(BigInt(id).toString(16));
    return [{ to: CFG.npm, data: '0x99fbab88' + h }, { to: CFG.npm, data: '0x6352211e' + h }];
  }));

  const live = [];
  ids.forEach((id, k) => {
    const res = posRes[k * 2];
    if (!res || !res.ok) return;
    const d = res.data;
    const liq = toBig(w(d, 7)), owed0 = toBig(w(d, 10)), owed1 = toBig(w(d, 11));
    if (liq === 0n && owed0 === 0n && owed1 === 0n) return;   /* closed since the last run */
    const own = posRes[k * 2 + 1];
    live.push({
      id: id, ledger: open[id],
      staked: !!(own && own.ok && lc(toAddr(w(own.data, 0))) === lc(CFG.lpStaker)),
      token0: lc(toAddr(w(d, 2))), token1: lc(toAddr(w(d, 3))), fee: Number(toBig(w(d, 4))),
      lo: Number(toSigned(w(d, 5))), hi: Number(toSigned(w(d, 6))),
      liq, last0: toBig(w(d, 8)), last1: toBig(w(d, 9)), owed0, owed1,
    });
  });
  if (!live.length) return [];

  const poolRes = await multi(CFG.katRpc, live.map((p) => ({
    to: CFG.factory, data: '0x1698ee82' + pad(p.token0) + pad(p.token1) + pad(p.fee.toString(16)),
  })));
  live.forEach((p, i) => { p.pool = poolRes[i].ok ? toAddr(w(poolRes[i].data, 0)) : null; });

  const slotRes = await multi(CFG.katRpc, live.flatMap((p) => p.pool ? [
    { to: p.pool, data: '0x3850c7bd' },                      /* slot0 */
    { to: p.pool, data: '0xf3058399' },                      /* feeGrowthGlobal0 */
    { to: p.pool, data: '0x46141319' },                      /* feeGrowthGlobal1 */
    { to: p.pool, data: '0xf30dba93' + enc24(p.lo) },        /* ticks(lower) */
    { to: p.pool, data: '0xf30dba93' + enc24(p.hi) },        /* ticks(upper) */
  ] : []));

  /* The entry price, read from the pool at the block the position was minted. It is what
     turns a P&L into a market move plus an impermanent loss, and the only figure here that
     needs archive state — so a node that has pruned it costs the IL line, nothing else. */
  const entry = await Promise.all(live.map(async (p) => {
    if (!p.pool || !p.ledger || !p.ledger.opened_block) return null;
    try {
      const d = await rpc(CFG.katRpc, 'eth_call',
        [{ to: p.pool, data: '0x3850c7bd' }, '0x' + Number(p.ledger.opened_block).toString(16)]);
      return toBig(w(d, 0));
    } catch { return null; }
  }));

  const out = [];
  live.forEach((p, j) => {
    const i = j * 5;
    if (!slotRes[i] || !slotRes[i].ok) return;
    const T0 = CFG.tokens[p.token0], T1 = CFG.tokens[p.token1];
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
    out.push(shape({
      chain: 'katana', id: p.id, protocol: 'SushiSwap V3',
      /* found on chain but not yet in the ledger: its range and its value are known, what
         went into it is not, so it reports no P&L rather than a P&L of nothing */
      pending: !p.ledger,
      staked: p.staked, feesMine: !p.staked,
      T0, T1, lo: p.lo, hi: p.hi, sqrtP, sqrtEntry: entry[j], liq: p.liq,
      a0: a0 / 10 ** T0.d, a1: a1 / 10 ** T1.d,
      fee0: Number(f0) / 10 ** T0.d, fee1: Number(f1) / 10 ** T1.d,
      inUsd: L.open_value_usd, withdrawn: L.withdrawn_usd || 0, topup: L.topup_usd || 0,
      openedTs: L.opened_ts, opened: L.opened,
    }));
  });
  return out;
}

/* ---------- arc: uniswap v4 ----------
   V4 keeps no position data on the NFT, so the pool id and the band come from the ledger
   the Action builds; StateView answers for the rest. */
async function arcRows(open) {
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

  /* the entry price, same as on Katana — Arc's node keeps the state */
  const entry = await Promise.all(rows.map(async (p) => {
    if (!p.opened_block) return null;
    try {
      const d = await rpc(CFG.arcRpc, 'eth_call', [{ to: CFG.arcV4State, data: '0xc815641c' + p.pool_id.slice(2) },
        '0x' + Number(p.opened_block).toString(16)]);
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
    /* The V4 ledger books every deposit and every payout. What went in is the deposit; the
       payouts are fee claims already in hand, so they count as money returned rather than
       as capital never committed. shape() checks the entry against this figure and drops
       the IL if the two disagree, which is what would happen had liquidity been changed. */
    out.push(shape({
      chain: 'arc', id: String(p.id), protocol: 'Uniswap V4', staked: !!p.staked, feesMine: true,
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

/* ---------- one position, shaped for a widget ----------
   Everything downstream of the chain reads lives here, so both chains produce
   identically shaped rows and the widget never has to branch. */
function shape(p) {
  const T0 = p.T0, T1 = p.T1;
  /* The band is quoted in the stable leg, the way a human reads a chart: dollars per BTC,
     not BTC per dollar. When the stable is token0 the pool's own price is upside down, so
     the quote is inverted and the bounds swap ends with it. */
  const invert = !!T0.stable && !T1.stable;
  const px = poolPrice(p.sqrtP, T0.d, T1.d);
  const raw = [tickPrice(p.lo, T0.d, T1.d), tickPrice(p.hi, T0.d, T1.d)];
  const now = invert ? 1 / px : px;
  const lower = invert ? 1 / raw[1] : raw[0];
  const upper = invert ? 1 / raw[0] : raw[1];
  const base = invert ? T1.s : T0.s, quote = invert ? T0.s : T1.s;

  /* Priced through the stable leg: one side of the pair is a dollar, so the other side's
     price is the pool's own. A pair with no stable leg gets its range and nothing more. */
  const priced = !!(T0.stable || T1.stable);
  const usd = (x0, x1) => (T1.stable ? x0 * px + x1 : x1 / px + x0);
  const liq = priced ? usd(p.a0, p.a1) : null;
  const fees = priced ? usd(p.fee0, p.fee1) : null;
  /* Uncollected fees are part of what the position is worth only when they are his. They
     are on a position he holds; on a staked Sushi position the Katana DAO collects them. */
  const value = liq === null ? null : liq + (p.feesMine ? fees : 0);

  /* Out of range below the floor the position is all of one leg, above the ceiling all of
     the other. Named from the volatile leg's point of view, so "below" always means the
     price fell through and "above" means it ran past. */
  const status = now < lower ? (invert ? 'above' : 'below')
    : now > upper ? (invert ? 'below' : 'above') : 'in';
  const inRange = status === 'in';

  /* What the money would be worth had it never been put in a pool, valued at today's price.
     The gap between that and the LP is the impermanent loss; the gap between it and what
     went in is the market simply moving.

     Only honest if the position's liquidity has not changed since the mint, because the
     entry amounts are reconstructed from today's liquidity at the entry price. That gets
     checked rather than assumed: priced at the entry price those amounts must come back to
     what the ledger says went in. A top-up or a partial burn breaks the match, and then the
     IL is reported as unknown instead of as a number that looks right and is not. */
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
      /* Measured on the liquidity alone. Fees are what compensates for impermanent loss,
         not part of it, so counting them here would flatter the figure. */
      il = liq - hodl;
    }
  }

  /* Already paid out counts as money back, not as capital that was never committed. */
  const withdrawn = p.withdrawn || 0;
  /* Three figures that add up, kept apart because they answer different questions.

     P&L is what happened to the money that was put in: the price moving against the
     capital, plus the impermanent loss of having been an LP while it moved. It is measured
     on the liquidity alone, so earnings cannot disguise a position that is down.

     Yield is what the position paid out for holding it — its own trading fees, collected
     and uncollected, or on a staked position the Merkl rewards that replace them.

     Net is simply the two together. */
  const tradePnl = priced && liq !== null && p.inUsd ? liq - p.inUsd : null;
  /* His own fees, whether still in the position or already taken out. A staked position
     earns none — the DAO collects them — and is paid in Merkl instead, which is added
     where the rewards are known. */
  const feeYield = p.feesMine ? (fees || 0) + withdrawn : 0;
  const heldDays = p.openedTs ? (Date.now() / 1000 - p.openedTs) / 86400 : null;
  const amounts = {};
  amounts[base] = invert ? p.a1 : p.a0;
  amounts[quote] = invert ? p.a0 : p.a1;

  return {
    chain: p.chain, id: p.id, pair: base + ' / ' + quote, protocol: p.protocol,
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
    /* Fees on a staked Sushi position are collected by the Katana DAO, not by this wallet.
       They are reported with a flag rather than dropped, because the figure is real — it is
       simply not his, and a widget that added it to his yield would be lying. */
    fees_usd: fees === null ? null : r2(fees),
    fees_mine: p.feesMine,
    market_usd: market === null ? null : r2(market),
    il_usd: il === null ? null : r2(il),
    hodl_usd: hodl === null ? null : r2(hodl),
    /* the capital's own move plus the impermanent loss on it — market_usd + il_usd */
    pnl_usd: tradePnl === null ? null : r2(tradePnl),
    fee_yield_usd: r2(feeYield),
  };
}

/* ---------- merkl ---------- */
async function merklLp() {
  try {
    const arr = await (await fetch(CFG.merklApi + '/users/' + CFG.wallet + '/rewards?chainId=747474')).json();
    let total = 0, lp = 0;
    const byId = {};
    for (const chain of arr || []) {
      for (const rw of chain.rewards || []) {
        const dec = (rw.token && rw.token.decimals) !== undefined ? rw.token.decimals : 18;
        const px = (rw.token && rw.token.price) || 0;
        const un = BigInt(rw.amount || '0') - BigInt(rw.claimed || '0') + BigInt(rw.pending || '0');
        if (un > 0n) total += Number(un) / 10 ** dec * px;
        /* SUSHI campaigns pay staked liquidity; Aragon bribes pay the vKAT vote. Only the
           first is this LP's earnings, and the reason names the position it paid for:
             SUSHI_SWAP_<pool>_<tokenId>~..._SushiStaker_...
           so each position is credited with its own rather than the whole pot. */
        for (const br of rw.breakdowns || []) {
          const reason = String(br.reason || '');
          if (!reason.startsWith('SUSHI')) continue;
          const b = BigInt(br.amount || '0') - BigInt(br.claimed || '0') + BigInt(br.pending || '0');
          if (b > 0n) lp += Number(b) / 10 ** dec * px;
          /* earned, not outstanding: claiming moves `amount` into `claimed` and must not
             make a position's yield fall */
          const earned = BigInt(br.amount || '0') + BigInt(br.pending || '0');
          const m = reason.match(/^SUSHI_SWAP_0x[0-9a-fA-F]{40}_(\d+)~/);
          if (m && earned > 0n) byId[m[1]] = r2((byId[m[1]] || 0) + Number(earned) / 10 ** dec * px);
        }
      }
    }
    return { total_usd: r2(total), lp_usd: r2(lp), earned_by_id: byId };
  } catch { return { total_usd: 0, lp_usd: 0, earned_by_id: {}, error: true }; }
}

/* ---------- the widget's own view ----------
   One position, every field already a string. A widget maker should need to do nothing
   but place these. */
function widgetView(pos, merkl) {
  if (!pos) return null;
  const R = pos.range;
  /* What the position paid out: its own trading fees where he holds it, or the Merkl
     rewards earned against this very NFT where it is staked and the DAO takes the fees. */
  const earned = (merkl && merkl.earned_by_id) || {};
  const mine = pos.fees_mine ? (pos.fee_yield_usd || 0) : (earned[pos.id] || 0);
  /* The move needs a cost to measure against; what it earned is known either way, so a
     position the ledger has not booked yet still shows its yield. */
  const known = pos.pnl_usd !== null;
  const net = (pos.pnl_usd || 0) + mine;
  const edge = Math.min(R.to_lower_pct, R.to_upper_pct);
  return {
    pair: pos.pair,
    id: '#' + pos.id,
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
    /* labelled for what it actually is, so the card cannot imply the DAO's fees are his */
    yield_label: pos.fees_mine ? 'Fees' : 'Rewards',
    yield_value: money(mine),
    fees_to_dao: pos.fees_mine ? null : money(pos.fees_usd || 0),
    /* The position's own move: the capital gaining or losing, plus the impermanent loss
       of having been an LP while it did. Earnings are the next column along, not folded
       in here, so a position that is down cannot look level. */
    pnl: known ? signed(pos.pnl_usd) : '--',
    pnl_up: known ? pos.pnl_usd >= 0 : true,
    il: pos.il_usd === null ? '--' : signed(pos.il_usd),
    net: known ? signed(net) : '--',
    net_up: known ? net >= 0 : true,
    pending: !!pos.pending,
    held: pos.held_days === null ? '' : pos.held_days.toFixed(1) + 'd',
  };
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const want = url.searchParams.get('pos');          /* a token id, to pin the widget to one */

  res.setHeader('access-control-allow-origin', '*');
  /* A widget refreshes every half hour at best, so a short shared cache costs nothing and
     keeps a stuck widget from hammering a public RPC. */
  res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=240');
  res.setHeader('content-type', 'application/json; charset=utf-8');

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const base = proto + '://' + host;
    const [pos, data] = await Promise.all([
      (await fetch(base + '/positions.json?t=' + Date.now())).json(),
      fetch(base + '/data.json?t=' + Date.now()).then((r) => r.json()).catch(() => ({})),
    ]);
    const seed = ((data.chains || {}).katana || {}).staked_lp_ids || [];
    /* Arc and Merkl do not wait on Katana's discovery; the three run side by side. */
    const settled = await Promise.all([
      katanaCandidates(pos, seed)
        .catch(() => Object.keys(pos.open || {}))      /* discovery failing costs the new ones, not the known */
        .then((c) => katanaRows(pos.open, c))
        .catch((e) => ({ error: 'katana: ' + e.message })),
      arcRows(pos.arc && pos.arc.open).catch((e) => ({ error: 'arc: ' + e.message })),
      merklLp(),
    ]);
    const merkl = settled[2];
    const errors = [], rows = [];
    for (const r of [settled[0], settled[1]]) {
      if (Array.isArray(r)) rows.push(...r);
      else if (r && r.error) errors.push(r.error);
    }
    /* tightest band first: the position that needs watching is the one with least room */
    rows.sort((a, b) => a.range.width_pct - b.range.width_pct);

    const pick = want ? rows.find((r) => r.id === want) : rows[0];

    res.status(200).end(JSON.stringify({
      generated: new Date().toISOString(),
      rewards_pending_usd: merkl.lp_usd,
      rewards_all_usd: merkl.total_usd,
      count: rows.length,
      /* `widget` is the one position a home-screen widget shows, and stays first so a
         widget maker's JSON path never moves. `widgets` is every open position, for the
         installed app, which has a whole screen rather than a 4x2 strip. */
      widget: widgetView(pick, merkl),
      widgets: rows.map((r) => widgetView(r, merkl)),
      positions: rows,
      errors: errors.length ? errors : undefined,
    }, null, 2));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}
