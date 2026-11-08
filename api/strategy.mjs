/* ============================================================================
   api/strategy: Katana's KAT emissions for staked Sushi LPs, finished for the
   Strategy page.

   Sources, the ones the Katana MCP points to:
   - Katana's epoch clock and gauge voter, on chain: the epoch, its voting week, votes.
   - Merkl's live staking campaigns (identifier "<pool>SUSHI_STAKER"): each pool's KAT,
     its dates and its scoring rules.
   - Each pool, the Sushi staker's positions and the campaign's whitelisted vaults, on
     chain: the eligible liquidity in range now, which a new position's share is of, and
     the staked value in dollars (in range now, and in all).
   - KAT's price from the KAT/vbUSDC pool, as the Lending page prices it.
   - Each pool's recent low and high: the job's hourly rows (strategy-ranges.json) plus the
     swaps since its last run and the price now.

   Read-only: no keys, no wallet, nothing signed. The browser does the estimates with
   strategy-core.mjs, from the numbers this returns.
   ========================================================================== */
import { CFG, multi, pad, keccakHex, rpc } from './_core.mjs';
import { handleLPAutofillFunding } from './_lp-autofill-funding.mjs';
import { handleAgentObservation } from './_agent-observation-reader.mjs';
import { epochOf, amountsPerLiquidity, orientation, priceAtTick, mergeSwapHours, recentRanges, rangePrices,
  swapFromLog, SWAP_TOPIC, RANGE_DAYS, PERP_OF, feesFromGrowth } from '../strategy-core.mjs';

const KAT = '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d';
const CLOCK = '0x17049d374a2bcda70f8939c21ad92bcf6b2a95ab';
const VOTER = '0x5e755a3c5dc81a79de7a7cef192ffa60964c9352';
const KAT_POOL = '0x10045367e619caae6f60cc80046c43c6cd55f629';   /* KAT/vbUSDC 0.05%: vbUSDC is token0 */
const STAKER = CFG.lpStaker, NPM = CFG.npm, RPC = CFG.katRpc;
const SEL = {
  currentEpoch: '0x76671808', epochDuration: '0x4ff0876a', elapsedInEpoch: '0xc8f3e13f',
  voteDuration: '0x56364499', voteWindowBuffer: '0x358c3f46',
  votingActive: '0x408e2727', totalVotingPowerCast: '0xf0363ae4', gaugeVotes: '0x9ef13a41',
  slot0: '0x3850c7bd', liquidity: '0x1a686502', tickSpacing: '0xd0c93a7c', poolPosition: '0x514ea4bf',
  balanceOf: '0x70a08231', tokenOfOwnerByIndex: '0x2f745c59', npmPosition: '0x99fbab88',
  /* the two vault kinds Merkl whitelists here: Charm keeps a base and a limit range,
     Steer reports its ranges as arrays */
  baseLower: '0xfa082743', baseUpper: '0x888a9134', limitLower: '0x51e87af7', limitUpper: '0x0f35bcac',
  getPositions: '0x80275860',
  feeGrowthGlobal0X128: '0xf3058399', feeGrowthGlobal1X128: '0x46141319',
};

/* Pools with no KAT emission, under the page's "Show pools without KAT emissions" (Alex,
   3 Nov 2026). They earn trading fees only, read from the pool itself: no campaign, no
   staking. For now the KAT/vbUSDC 0.05% pool, the KAT market (the 0.01% and 1% pools are
   empty and the 0.3% holds about $11,000). Checked on chain 3 Nov 2026: token0 vbUSDC,
   token1 KAT, fee 500, tick spacing 10, feeProtocol 34 (Sushi keeps half of each fee).
   baseIndex 1 quotes it in vbUSDC per KAT; dollar is the token valued at $1, as KAT's price
   is everywhere on this page. */
const VBUSDC = '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36';
export const FEE_POOLS = [{
  pool: KAT_POOL, fee: 500, baseIndex: 1, dollar: 0,
  token0: { address: VBUSDC, symbol: 'vbUSDC', decimals: 6 }, token1: { address: KAT, symbol: 'KAT', decimals: 18 },
  link: 'https://www.sushi.com/katana/pool/v3/' + KAT_POOL,
}];
const FEE_WINDOW = 7 * 86400;

const lc = (s) => String(s || '').toLowerCase();
const word = (hex, i = 0) => BigInt('0x' + (hex.slice(2 + i * 64, 66 + i * 64) || '0'));
const int24 = (hex, i) => { const v = word(hex, i); return Number(v >= 2n ** 255n ? v - 2n ** 256n : v); };
const whole = (raw, decimals) => Number(raw) / 10 ** decimals;
const enc24 = (t) => BigInt.asUintN(24, BigInt(t)).toString(16).padStart(6, '0');
const need = (r, label) => { if (!r || !r.ok || r.data.length < 66) throw new Error('Could not read ' + label); return r.data; };

async function merkl(path) {
  const r = await fetch(CFG.merklApi + path, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Merkl HTTP ' + r.status);
  return r.json();
}
/* Multicall in slices, so a long list never becomes one oversized request */
async function multiAll(calls, size = 300) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) out.push(...await multi(RPC, calls.slice(i, i + size)));
  return out;
}

/* the live KAT staking campaigns, one row per pool */
export async function readCampaigns(now) {
  const list = await merkl('/opportunities?chainId=747474&action=POOL&status=LIVE&items=100');
  const staking = list.filter((o) => /SUSHI_STAKER$/i.test(o.identifier || ''));
  const detail = await Promise.all(staking.map((o) => merkl('/opportunities/' + o.id + '?campaigns=true')));
  const rows = [];
  for (const o of detail) {
    const live = (o.campaigns || []).filter((c) => c.startTimestamp <= now && c.endTimestamp > now
      && lc(c.rewardToken && c.rewardToken.address) === KAT);
    if (!live.length) continue;
    const p = live[0].params;
    const kat = (c) => Number(BigInt(c.amount) / 10n ** 12n) / 1e6;
    const token = (address, decimals) => {
      const t = (o.tokens || []).find((x) => lc(x.address) === lc(address)) || {};
      return { address: lc(address), symbol: t.displaySymbol || t.symbol || '?', decimals: Number(decimals), merklUsd: Number(t.price) || null };
    };
    rows.push({
      opportunity: o.id, pool: lc(p.poolId), fee: Number(p.lpFee), fee_tier: Number(p.lpFee) / 1e6,
      token0: token(p.currency0, p.decimalsCurrency0), token1: token(p.currency1, p.decimalsCurrency1),
      apr: Number.isFinite(o.apr) ? o.apr / 100 : null, tvl: Number.isFinite(o.tvl) ? o.tvl : null,
      kat: live.reduce((s, c) => s + kat(c), 0),
      katPerDay: live.reduce((s, c) => s + kat(c) / ((c.endTimestamp - c.startTimestamp) / 86400), 0),
      campaign: { start: Math.min(...live.map((c) => c.startTimestamp)), end: Math.max(...live.map((c) => c.endTimestamp)) },
      rules: { weightFees: p.weightFees, weightToken0: p.weightToken0, weightToken1: p.weightToken1, outOfRange: !!p.isOutOfRangeIncentivized },
      whitelist: (p.whitelist || []).map(lc), blacklist: (p.blacklist || []).map(lc),
      link: o.depositUrl || null,
    });
  }
  return rows;
}

/* Each pool without KAT, at one block: its price, liquidity and balances, and its fee growth
   now, a week ago and a day ago (archive reads; Katana makes a block a second, and the blocks'
   own times are used). The rows have the KAT pools' shape, so the page's range, edges and
   hedge run on them unchanged. */
export async function readFeePools() {
  const head = Number(BigInt(await rpc(RPC, 'eth_blockNumber', [])));
  const at = [head, head - FEE_WINDOW, head - 86400], tag = (n) => '0x' + n.toString(16);
  const ts = (await Promise.all(at.map((n) => rpc(RPC, 'eth_getBlockByNumber', [tag(n), false])))).map((b) => Number(BigInt(b.timestamp)));
  const growth = FEE_POOLS.flatMap((f) => [{ to: f.pool, data: SEL.feeGrowthGlobal0X128 }, { to: f.pool, data: SEL.feeGrowthGlobal1X128 }]);
  const calls = FEE_POOLS.flatMap((f) => [{ to: f.pool, data: SEL.slot0 }, { to: f.pool, data: SEL.liquidity }, { to: f.pool, data: SEL.tickSpacing },
    { to: f.token0.address, data: SEL.balanceOf + pad(f.pool) }, { to: f.token1.address, data: SEL.balanceOf + pad(f.pool) }]);
  const [now, week, day] = await Promise.all([multi(RPC, [...calls, ...growth], tag(at[0])), multi(RPC, growth, tag(at[1])), multi(RPC, growth, tag(at[2]))]);
  const grown = (rows, k) => [0, 1].map((i) => word(need(rows[k * 2 + i], 'the fee growth')));
  return FEE_POOLS.map((f, k) => {
    const r = now.slice(k * 5, k * 5 + 5), slot0 = need(r[0], f.pool);
    const p = {
      kind: 'fees', pool: f.pool, fee: f.fee, fee_tier: f.fee / 1e6, baseIndex: f.baseIndex, link: f.link,
      token0: { ...f.token0 }, token1: { ...f.token1 },
      sqrtPrice: Number(word(slot0, 0)) / 2 ** 96, tick: int24(slot0, 1), fee_protocol: Number(word(slot0, 5)),
      activeLiquidity: Number(word(need(r[1], f.pool))), tickSpacing: int24(need(r[2], f.pool), 0),
      rules: { weightFees: 10000, weightToken0: 0, weightToken1: 0, outOfRange: false },
    };
    p.price = priceAtTick(p.tick, p);
    const toks = [p.token0, p.token1], other = 1 - f.dollar;
    toks[f.dollar].usd = 1;
    toks[other].usd = f.baseIndex === other ? p.price : 1 / p.price;
    const o = orientation(p);
    p.base = toks[o.base].symbol; p.quote = toks[o.quote].symbol;
    const after = grown(now.slice(calls.length), k), base = { after, fee: f.fee, feeProtocol: p.fee_protocol, pool: p };
    p.fees = { ...feesFromGrowth({ ...base, before: grown(week, k), seconds: ts[0] - ts[1] }), window_days: (ts[0] - ts[1]) / 86400 };
    const last = feesFromGrowth({ ...base, before: grown(day, k), seconds: ts[0] - ts[2] });
    p.fees.usd_24h = last.usd_per_day; p.fees.volume_usd_24h = last.volume_usd_per_day;
    p.balances = { amount0: whole(word(need(r[3], 'the pool balance')), f.token0.decimals), amount1: whole(word(need(r[4], 'the pool balance')), f.token1.decimals) };
    p.tvl_usd = p.balances.amount0 * p.token0.usd + p.balances.amount1 * p.token1.usd;
    p.apr = p.tvl_usd > 0 ? (p.fees.usd_per_day * 365) / p.tvl_usd : null;
    return p;
  });
}

/* Each pool's 7D/14D/21D/30D low and high, in the pool's own quoting. The job's rows run to
   its last block; the swaps after it are read here, at most TAIL blocks (~4.6 days at one
   block a second), so a stalled job leaves the windows marked incomplete, never wrong. */
const TAIL = 400000;
/* A pool's swap logs between two blocks. Katana's node answers at most 10,000 logs a query,
   and the KAT/vbUSDC pool passes that on busy days, so a window over the cap is read in halves. */
export async function swapLogs(pool, from, to) {
  try { return await rpc(RPC, 'eth_getLogs', [{ address: pool, topics: [SWAP_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]); }
  catch (e) {
    if (!/limit exceeded|more than \d+ results/i.test(String((e && e.message) || e)) || to <= from) throw e;
    const mid = Math.floor((from + to) / 2);
    return [...await swapLogs(pool, from, mid), ...await swapLogs(pool, mid + 1, to)];
  }
}
async function addRecentRanges(pools, ranges, now, notes) {
  if (!ranges || !ranges.pools) { notes.push('Recent price ranges are not recorded yet; they appear after the next data update.'); return; }
  const head = Number(BigInt(await rpc(RPC, 'eth_blockNumber', [])));
  await Promise.all(pools.map(async (p) => {
    const e = ranges.pools[p.pool];
    if (!e) { p.recent = null; return; }
    const gap = head - e.last_block > TAIL, from = gap ? head - TAIL : e.last_block + 1;
    const logs = from <= head ? await swapLogs(p.pool, from, head) : [];
    const hours = mergeSwapHours(e.hours, logs.map(swapFromLog));
    const r = recentRanges(hours, now, p.tick, [1, ...RANGE_DAYS], e.recorded_from);
    p.recent = Object.fromEntries(Object.entries(r).map(([d, x]) => [d, x && { ...x, ...rangePrices(x, p), complete: x.complete && !gap }]));
    if (gap) notes.push(`${p.base}/${p.quote}: the recorded price history is more than four days behind, so its recent ranges may miss some prices.`);
  }));
}

/* Katana Perps, for each pool's hedge: the markets its volatile tokens map to (fees, margin
   fractions, sizes), funding now and its average over the last 30 days (90 payments), the
   order book's top 50 levels each side, and the fee to withdraw margin back to Katana. Read
   here, not in the browser: the exchange's API does not answer other sites' pages. */
const PERPS = 'https://api-perps.katana.network/v1';
/* The exchange takes about five requests in a burst, then answers 429 until its bucket
   refills, a few a second (measured 3 Nov 2026). So the reads go one at a time, a quarter of
   a second apart, with one retry after a pause. */
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
let lastPerpsCall = 0;
const getJson = async (url, retry = 1) => {
  const wait = lastPerpsCall + 250 - Date.now();
  if (wait > 0) await pause(wait);
  lastPerpsCall = Date.now();
  try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error('Katana Perps HTTP ' + r.status); return await r.json(); }
  catch (e) { if (!retry) throw e; await pause(700); return getJson(url, retry - 1); }
};
export async function readPerps(symbols) {
  const want = [...new Set(symbols)];
  if (!want.length) return null;
  const markets = await getJson(PERPS + '/markets');
  const gas = await getJson(PERPS + '/gasFees').catch(() => null);
  const out = { at: Math.floor(Date.now() / 1000), markets: {}, funding: {}, book: {}, withdraw_fee: gas && gas.withdrawal ? Number(gas.withdrawal['katana.katana']) || 0 : 0.05 };
  for (const sym of want) {   /* one market at a time, gentle on the exchange */
    const m = markets.find((x) => x.market === sym && x.status === 'active');
    if (!m) continue;
    out.markets[sym] = { taker: Number(m.takerFeeRate), maker: Number(m.makerFeeRate), imf: Number(m.initialMarginFraction), mmf: Number(m.maintenanceMarginFraction),
      min: Number(m.minimumPositionSize), step: Number(m.stepSize), index: Number(m.indexPrice), next_funding: Math.floor(Number(m.nextFundingTime) / 1000) };
    const rates = await getJson(`${PERPS}/fundingRates?market=${sym}&limit=90`).catch(() => []);
    const book = await getJson(`${PERPS}/orderbook?market=${sym}&level=2&limit=50`).catch(() => null);
    const r = rates.map((x) => Number(x.fundingRate)).filter(Number.isFinite);
    out.funding[sym] = { now: Number(m.currentFundingRate), avg: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null, n: r.length,
      from: rates.length ? Math.floor(rates[0].time / 1000) : null, to: rates.length ? Math.floor(rates[rates.length - 1].time / 1000) : null };
    if (book) out.book[sym] = { mark: Number(book.markPrice), bids: book.bids.map((l) => [Number(l[0]), Number(l[1])]), asks: book.asks.map((l) => [Number(l[0]), Number(l[1])]) };
  }
  return out;
}

export async function readStrategy(now = Math.floor(Date.now() / 1000), { ranges } = {}) {
  const pools = await readCampaigns(now);
  const notes = [];
  /* the perps read runs beside the chain reads; a failure costs only the hedge */
  const perpsP = readPerps([...pools, ...FEE_POOLS].flatMap((p) => [p.token0.symbol, p.token1.symbol]).map((t) => PERP_OF[t]).filter(Boolean))
    .catch((e) => { notes.push('Katana Perps could not be read this time (' + String(e.message || e).slice(0, 60) + '); the hedge cannot be simulated.'); return null; });
  /* the pools without KAT run beside the rest too; a failure costs only their section */
  const feeP = readFeePools()
    .catch((e) => { notes.push('The pools without KAT could not be read this time: ' + String((e && e.message) || e).slice(0, 80)); return []; });

  /* 1 · the clock, the votes, KAT's price, each pool's state and the staker's count */
  const fixed = [
    { to: CLOCK, data: SEL.currentEpoch }, { to: CLOCK, data: SEL.epochDuration }, { to: CLOCK, data: SEL.elapsedInEpoch },
    { to: CLOCK, data: SEL.voteDuration }, { to: CLOCK, data: SEL.voteWindowBuffer },
    { to: VOTER, data: SEL.votingActive }, { to: VOTER, data: SEL.totalVotingPowerCast },
    { to: KAT_POOL, data: SEL.slot0 }, { to: NPM, data: SEL.balanceOf + pad(STAKER) },
  ];
  const perPool = pools.flatMap((p) => [{ to: p.pool, data: SEL.slot0 }, { to: p.pool, data: SEL.liquidity },
    { to: p.pool, data: SEL.tickSpacing }, { to: VOTER, data: SEL.gaugeVotes + pad(p.pool) }]);
  const first = await multiAll([...fixed, ...perPool]);
  const clock = {
    current: Number(word(need(first[0], 'the epoch clock'))), duration: Number(word(need(first[1], 'the epoch length'))),
    elapsed: Number(word(need(first[2], 'the epoch clock'))), voteDuration: Number(word(need(first[3], 'the voting week'))),
    voteBuffer: Number(word(need(first[4], 'the voting window'))),
  };
  const votingOpen = word(need(first[5], 'the gauge voter')) === 1n;
  const totalVotes = whole(word(need(first[6], 'the gauge votes')), 18);
  const katSqrt = Number(word(need(first[7], 'the KAT price'))) / 2 ** 96;
  const katUsd = katSqrt > 0 ? 1 / (katSqrt * katSqrt * 1e-12) : null;
  const stakedCount = Number(word(need(first[8], 'the staker')));
  pools.forEach((p, k) => {
    const r = first.slice(fixed.length + k * 4, fixed.length + k * 4 + 4);
    const slot0 = need(r[0], p.pool);
    p.sqrtPrice = Number(word(slot0, 0)) / 2 ** 96;
    p.tick = int24(slot0, 1);
    p.activeLiquidity = Number(word(need(r[1], p.pool)));
    p.tickSpacing = int24(need(r[2], p.pool), 0);
    p.votes = r[3] && r[3].ok ? whole(word(r[3].data), 18) : null;
    p.voteShare = p.votes !== null && totalVotes > 0 ? p.votes / totalVotes : null;
    /* dollar prices that agree with the pool: the cheaper token at Merkl's price, the other
       through the pool's own price, so a deposit is valued at the rate it would be made at */
    const dearIs0 = (p.token0.merklUsd || 0) >= (p.token1.merklUsd || 0);
    const [cheap, dear] = dearIs0 ? [p.token1, p.token0] : [p.token0, p.token1];
    p.baseIndex = dearIs0 ? 0 : 1;   /* fixed here, so the quoting cannot flip with a price */
    p.price = priceAtTick(p.tick, p);
    cheap.usd = cheap.merklUsd || null;
    dear.usd = cheap.usd ? p.price * cheap.usd : null;
    const o = orientation(p);
    p.base = o.base === 0 ? p.token0.symbol : p.token1.symbol;
    p.quote = o.base === 0 ? p.token1.symbol : p.token0.symbol;
    if (!p.token0.usd || !p.token1.usd) notes.push(`${p.base}/${p.quote}: no dollar price, so its estimate is unavailable`);
  });

  /* 2 · the staker's position ids, and the whitelisted vaults' ranges */
  const ids = (await multiAll(Array.from({ length: stakedCount }, (_, i) => ({ to: NPM, data: SEL.tokenOfOwnerByIndex + pad(STAKER) + pad(i.toString(16)) }))))
    .map((r, i) => word(need(r, 'staked position ' + i)));
  const vaults = [];
  for (const p of pools) for (const v of p.whitelist) if (v !== lc(STAKER)) vaults.push({ pool: p, address: v });
  const probe = await multiAll(vaults.flatMap((v) => ['baseLower', 'baseUpper', 'limitLower', 'limitUpper', 'getPositions'].map((f) => ({ to: v.address, data: SEL[f] }))));
  vaults.forEach((v, k) => {
    const r = probe.slice(k * 5, k * 5 + 5);
    if (r.slice(0, 4).every((x) => x.ok && x.data.length >= 66)) {
      v.kind = 'Charm'; v.ranges = [[int24(r[0].data, 0), int24(r[1].data, 0)], [int24(r[2].data, 0), int24(r[3].data, 0)]];
    } else if (r[4].ok && r[4].data.length > 66) {
      const h = r[4].data, at = (i) => Number(word(h, i)) / 32, list = (o) => Array.from({ length: Number(word(h, o)) }, (_, j) => int24(h, o + 1 + j));
      const lo = list(at(0)), hi = list(at(1));
      v.kind = 'Steer'; v.ranges = lo.map((l, j) => [l, hi[j]]);
    } else { v.kind = null; v.ranges = []; notes.push(`A whitelisted holder in ${v.pool.base}/${v.pool.quote} could not be read; its share may read a little high`); }
  });

  /* 3 · every staked position, and the vaults' liquidity in each range */
  const staked = await multiAll(ids.map((id) => ({ to: NPM, data: SEL.npmPosition + pad(id.toString(16)) })), 200);
  const keys = vaults.flatMap((v) => v.ranges.map(([lo, hi]) => ({ v, lo, hi, key: keccakHex(v.address.slice(2) + enc24(lo) + enc24(hi)) })));
  const held = await multiAll(keys.map((k) => ({ to: k.v.pool.pool, data: SEL.poolPosition + k.key })));

  for (const p of pools) {
    p.eligible = { liquidity: 0, amount0: 0, amount1: 0, positions: 0, inRange: 0, vaults: 0 };
    p.staked = p.whitelist.length ? { amount0: 0, amount1: 0 } : null;
    if (!p.whitelist.length) {
      /* no whitelist: every in-range position counts, which is the pool's active liquidity */
      p.eligible.liquidity = p.activeLiquidity; p.eligible.amount0 = null; p.eligible.amount1 = null;
    }
    if (p.blacklist.length) notes.push(`${p.base}/${p.quote} excludes some holders that cannot be told apart here; its share may read a little low`);
  }
  staked.forEach((r) => {
    const h = need(r, 'a staked position');
    const t0 = '0x' + h.slice(2 + 2 * 64 + 24, 2 + 3 * 64), t1 = '0x' + h.slice(2 + 3 * 64 + 24, 2 + 4 * 64), fee = Number(word(h, 4));
    const p = pools.find((x) => x.whitelist.includes(lc(STAKER)) && x.token0.address === t0 && x.token1.address === t1 && x.fee === fee);
    if (!p) return;
    p.eligible.positions++;
    addTo(p, Number(word(h, 7)), int24(h, 5), int24(h, 6));
  });
  keys.forEach((k, i) => { const L = held[i] && held[i].ok ? Number(word(held[i].data, 0)) : 0; if (L > 0) { k.v.pool.eligible.vaults++; addTo(k.v.pool, L, k.lo, k.hi); } });

  const feePools = await feeP;
  try { await addRecentRanges([...pools, ...feePools], ranges, now, notes); }
  catch (e) { notes.push('Recent price ranges could not be read this time: ' + String((e && e.message) || e).slice(0, 80)); }

  /* the epoch that funded the running campaigns: they start when its voting week closes */
  const start = Math.min(...pools.map((p) => p.campaign.start)), end = Math.max(...pools.map((p) => p.campaign.end));
  const funded = pools.length ? epochOf(start, clock) : null;
  const clockEpoch = epochOf(now - clock.elapsed + 1, clock);
  return {
    at: now,
    epoch: funded && { ...funded, clock_current: clock.current, clock_start: clockEpoch.start, clock_end: clockEpoch.end, voting_open: votingOpen,
      next_vote_end: clockEpoch.voteEnd > now ? clockEpoch.voteEnd : null },
    reward: { start, end },
    total: { kat: pools.reduce((s, p) => s + p.kat, 0), katPerDay: pools.reduce((s, p) => s + p.katPerDay, 0) },
    kat_usd: katUsd, total_votes: totalVotes, staked_positions: stakedCount,
    perps: await perpsP,
    pools: pools.map(({ whitelist, blacklist, staked, ...p }) => ({ ...p, eligible: { ...p.eligible, holders: whitelist.length },
      staked_usd: { in_range: usdOf(p, p.eligible), all: usdOf(p, staked) } })),
    fee_pools: feePools,
    health: { notes },
  };
}

/* the dollar value of some token amounts in a pool; null when an amount or a price is missing */
const usdOf = (p, a) => (a && a.amount0 !== null && p.token0.usd > 0 && p.token1.usd > 0 ? a.amount0 * p.token0.usd + a.amount1 * p.token1.usd : null);

/* every staked position and vault range adds to the pool's staked value; only the ones in
   range now share the KAT, so only they add to the eligible liquidity and its amounts */
function addTo(p, L, lo, hi) {
  if (!(L > 0) || !p.whitelist.length) return;
  const a = amountsPerLiquidity(lo, hi, p.sqrtPrice, p.token0.decimals, p.token1.decimals);
  p.staked.amount0 += L * a.amount0; p.staked.amount1 += L * a.amount1;
  if (!(p.tick >= lo && p.tick < hi)) return;
  p.eligible.liquidity += L; p.eligible.amount0 += L * a.amount0; p.eligible.amount1 += L * a.amount1; p.eligible.inRange++;
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  /* half a minute at the edge: campaigns change once a fortnight, liquidity slowly */
  res.setHeader('cache-control', 's-maxage=30, stale-while-revalidate=30');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (await handleLPAutofillFunding(req, res)) return;
  if (await handleAgentObservation(req, res)) return;
  /* the job's hourly ranges, fetched from this same site as /api/lpbook fetches its ledger */
  let ranges = null;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host, proto = req.headers['x-forwarded-proto'] || 'https';
    const r = await fetch(proto + '://' + host + '/strategy-ranges.json?t=' + Date.now(), { signal: AbortSignal.timeout(8000) });
    if (r.ok) ranges = await r.json();
  } catch (e) { /* the page still works; the range buttons say they are waiting */ }
  try { res.status(200).end(JSON.stringify(await readStrategy(undefined, { ranges }))); }
  catch (e) { res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) })); }
}
