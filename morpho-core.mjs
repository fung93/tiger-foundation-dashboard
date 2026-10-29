/* Morpho Blue reader and personal lending maths, shared by browser, API and job.
   All chain operations use eth_call / block reads. Interest is accrued inside an
   eth_call simulation only: no transaction, signature or persistent state change.
   Prices, balances, interest and the oracle are read at the same pinned block.

   Sources: morpho-org/morpho-blue, Morpho.sol (_accrueInterest, _isHealthy,
   borrow, repay) and SharesMathLib.sol. Keep debt rounded up and capacity down. */
export const WALLET = '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1';
export const MORPHO = '0xd50f2dfffd62f94ee4aed9ca05c61d0753268abc';
export const RPCS = ['https://rpc.katanarpc.com', 'https://katana.drpc.org', 'https://747474.rpc.thirdweb.com'];
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const KAT_POOL = '0x10045367e619caae6f60cc80046c43c6cd55f629';
// The immutable BASE_FEED_1 of the KAT/vbUSDC oracle, read and verified on chain.
// The avKAT/vbUSDC oracle uses the same KAT/USD feed as BASE_FEED_2.
const KAT_USD_FEED = '0xc62782910529ee50efda9a0273b20d8bd1c1e4b2';
const AVKAT = '0x7231dbacdfc968e07656d12389ab20de82fbfceb';
const KAT = '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d';
const USDC = '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36';
const WAD = 10n ** 18n, ORACLE_SCALE = 10n ** 36n, VIRTUAL_SHARES = 1000000n;
export const MARKETS = [
  { key: 'avkat-kat', id: '0x80e60fe453223b0f84a567724f88190bef708420d24397157067d424429783e9', label: 'avKAT / KAT', collateral_token: 'avKAT', loan_token: 'KAT', collateral_decimals: 18, loan_decimals: 18, lltv: .77 },
  { key: 'avkat-usdc', id: '0xbd48214a2f12e951da20ad0b8fd83b611c693b5bbaa280b68ba4075678f2a138', label: 'avKAT / USDC', collateral_token: 'avKAT', loan_token: 'vbUSDC', collateral_decimals: 18, loan_decimals: 6, lltv: .625 },
  { key: 'kat-usdc', id: '0x913c787d438ca1dab5f5485c2d2d6e2aa2dfee47a5f02edd11331ad25b219dcf', label: 'KAT / USDC', collateral_token: 'KAT', loan_token: 'vbUSDC', collateral_decimals: 18, loan_decimals: 6, lltv: .625 },
];
const pad = value => String(value).replace(/^0x/, '').padStart(64, '0');
const word = (hex, i) => hex.slice(2 + i * 64, 66 + i * 64);
const big = (hex, i) => BigInt('0x' + word(hex, i));
const address = (hex, i) => '0x' + word(hex, i).slice(24).toLowerCase();
const units = (raw, decimals) => Number(raw) / 10 ** decimals;
const ceilDiv = (a, b) => (a + b - 1n) / b;
const max = (a, b) => a > b ? a : b;
const min = (a, b) => a < b ? a : b;
export const debtAssets = (shares, assets, totalShares) => ceilDiv(shares * (assets + 1n), totalShares + VIRTUAL_SHARES);

function aggregateData(calls) {
  let offsets = '', tails = '';
  for (const c of calls) {
    offsets += pad((calls.length * 32 + tails.length / 2).toString(16));
    const data = c.data.slice(2);
    tails += pad(c.to) + pad('1') + pad('60') + pad((data.length / 2).toString(16)) + data + '0'.repeat((64 - data.length % 64) % 64);
  }
  return '0x82ad56cb' + pad('20') + pad(calls.length.toString(16)) + offsets + tails;
}
function aggregateResult(hex) {
  const n = Number(big(hex, 1)), out = [];
  if (!Number.isSafeInteger(n) || n > 100) throw new Error('Invalid multicall response');
  for (let i = 0; i < n; i++) {
    const at = Number(big(hex, i + 2)) / 32 + 2;
    const dataAt = Number(big(hex, at + 1)) / 32 + at;
    const len = Number(big(hex, dataAt));
    out.push({ ok: big(hex, at) === 1n, data: '0x' + hex.slice(2 + (dataAt + 1) * 64, 2 + (dataAt + 1) * 64 + len * 2) });
  }
  return out;
}
let nextId = 0;
export async function katanaRpc(method, params, { rpcs = RPCS, timeout = 6500 } = {}) {
  let last;
  for (const url of rpcs) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }), signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error('Katana RPC HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'Katana RPC error');
      if (j.result == null) throw new Error('Katana RPC returned no result');
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('No Katana RPC endpoints are configured');
}
const callMany = async (calls, tag, opts) => aggregateResult(await katanaRpc('eth_call', [{ to: MULTICALL, data: aggregateData(calls) }, tag], opts));

export async function readMorpho({ block = 'latest', wallet = WALLET, ...rpcOptions } = {}) {
  const tag = typeof block === 'number' ? '0x' + block.toString(16) : block;
  const header = await katanaRpc('eth_getBlockByNumber', [tag, false], rpcOptions);
  const pinned = header.number, ts = Number(BigInt(header.timestamp)), blockNumber = Number(BigInt(pinned));
  const calls = [
    { to: KAT_POOL, data: '0x3850c7bd' },
    { to: AVKAT, data: '0x07a2d13a' + pad(WAD.toString(16)) },
    ...MARKETS.flatMap(m => [
      { to: MORPHO, data: '0x93c52062' + m.id.slice(2) + pad(wallet) },
      { to: MORPHO, data: '0x2c3c9157' + m.id.slice(2) },
    ]),
    { to: KAT_USD_FEED, data: '0x313ce567' },
    { to: KAT_USD_FEED, data: '0xfeaf968c' }, // latestRoundData()
  ];
  const first = await callMany(calls, pinned, rpcOptions);
  const positive = n => Number.isFinite(n) && n > 0 ? n : null;
  const katUsd = first[0]?.ok ? positive(1 / ((Number(big(first[0].data, 0)) / 2 ** 96) ** 2 * 1e-12)) : null;
  const avkatRate = first[1]?.ok ? positive(units(big(first[1].data, 0), 18)) : null;
  let katOracleUsd = null, katOracleUpdatedAt = null;
  const feedAt = 2 + MARKETS.length * 2;
  try {
    if (first[feedAt]?.ok && first[feedAt + 1]?.ok) {
      const decimals = Number(big(first[feedAt].data, 0));
      const round = first[feedAt + 1].data, answer = BigInt.asIntN(256, big(round, 1));
      const updated = Number(big(round, 3));
      // Match the price() feed's latestRoundData quote; Morpho itself deliberately
      // applies no max-age rule. Keep the timestamp rather than calling it new.
      if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 77 && answer > 0n
        && Number.isSafeInteger(updated) && updated > 0 && updated <= ts) {
        katOracleUsd = positive(units(answer, decimals));
        if (katOracleUsd !== null) katOracleUpdatedAt = updated;
      }
    }
  } catch { /* Current market health remains readable if this display-only quote fails. */ }
  const plans = MARKETS.map((m, i) => {
    const position = first[2 + i * 2], params = first[3 + i * 2];
    if (!position?.ok || !params?.ok) return { m, error: 'Position or market parameters could not be read' };
    const collateral = big(position.data, 2), shares = big(position.data, 1), supplyShares = big(position.data, 0);
    const lltvRaw = big(params.data, 4);
    if (!lltvRaw) return { m, collateral, shares, supplyShares, created: false };
    const loan = address(params.data, 0), col = address(params.data, 1);
    if (loan !== (m.loan_token === 'KAT' ? KAT : USDC) || col !== (m.collateral_token === 'avKAT' ? AVKAT : KAT)) {
      return { m, error: 'Market token addresses do not match this lending page' };
    }
    return { m, collateral, shares, supplyShares, params: params.data.slice(2, 322), oracle: address(params.data, 2), lltvRaw, created: true };
  });
  const active = plans.filter(p => p.created);
  const second = await callMany(active.flatMap(p => [
    // eth_call permits ephemeral writes; accrueInterest does not transfer tokens.
    { to: MORPHO, data: '0x151c1ade' + p.params },
    { to: MORPHO, data: '0x5c60e39a' + p.m.id.slice(2) },
    { to: p.oracle, data: '0xa035b1fe' },
  ]), pinned, rpcOptions);
  active.forEach((p, i) => { p.accrue = second[i * 3]; p.market = second[i * 3 + 1]; p.price = second[i * 3 + 2]; });
  const markets = plans.map(p => {
    const common = { ...p.m, ts, block: blockNumber, kat_price_usd: katUsd,
      kat_oracle_price_usd: katOracleUsd, kat_oracle_updated_at: katOracleUpdatedAt,
      ...(katOracleUsd === null ? { liquidation_price_warning: 'KAT/USD oracle feed unavailable; the conditional price estimate uses the market pool quote' } : {}) };
    if (p.error) return { ...common, error: p.error };
    if (!p.created) return { ...common, active: false, collateral_amount: 0, debt_amount: 0, collateral_usd: 0, debt_usd: 0,
      oracle_collateral_usd: 0, liquidation_debt_amount: 0, liquidation_usd: 0, health: null, liquidity_amount: 0, no_position: true };
    if (!p.accrue?.ok || !p.market?.ok || !p.price?.ok) return { ...common, error: 'Accrued debt or market oracle could not be read' };
    const priceRaw = big(p.price.data, 0);
    if (!priceRaw) return { ...common, error: 'Market oracle returned a zero price' };
    const tSA = big(p.market.data, 0), tSS = big(p.market.data, 1), tBA = big(p.market.data, 2), tBS = big(p.market.data, 3);
    const debtRaw = debtAssets(p.shares, tBA, tBS);
    const oracleColRaw = p.collateral * priceRaw / ORACLE_SCALE;
    const liqRaw = oracleColRaw * p.lltvRaw / WAD;
    const liquidityRaw = max(0n, tSA - tBA);
    const loanUsd = p.m.loan_token === 'KAT' ? katUsd : 1;
    const colUsd = p.m.collateral_token === 'KAT' ? katUsd : katUsd && avkatRate ? katUsd * avkatRate : null;
    const collateralAmount = units(p.collateral, p.m.collateral_decimals), debtAmount = units(debtRaw, p.m.loan_decimals);
    return { ...common, active: p.collateral > 0n || p.shares > 0n || p.supplyShares > 0n,
      no_position: p.collateral === 0n && p.shares === 0n && p.supplyShares === 0n,
      lltv: units(p.lltvRaw, 18), collateral_amount: collateralAmount, debt_amount: debtAmount,
      collateral_usd: colUsd === null ? null : collateralAmount * colUsd,
      debt_usd: loanUsd === null ? null : debtAmount * loanUsd,
      oracle_collateral_usd: loanUsd === null ? null : units(oracleColRaw, p.m.loan_decimals) * loanUsd,
      liquidation_debt_amount: units(liqRaw, p.m.loan_decimals), liquidation_usd: loanUsd === null ? null : units(liqRaw, p.m.loan_decimals) * loanUsd,
      health: debtRaw === 0n ? null : Number(liqRaw) / Number(debtRaw),
      ltv: oracleColRaw === 0n ? null : Number(debtRaw) / Number(oracleColRaw),
      oracle_price: Number(priceRaw) / 1e36 * 10 ** (p.m.collateral_decimals - p.m.loan_decimals),
      loan_usd: loanUsd, collateral_price_usd: colUsd, avkat_rate: avkatRate,
      liquidity_amount: units(liquidityRaw, p.m.loan_decimals), oracle: p.oracle, interest_accrued: true,
      ...(katUsd === null || colUsd === null ? { valuation_error: 'Market USD price could not be read; token health remains available' } : {}),
      raw: { collateral: String(p.collateral), borrow_shares: String(p.shares), debt: String(debtRaw), oracle_price: String(priceRaw),
        lltv: String(p.lltvRaw), liquidation_debt: String(liqRaw), total_borrow_assets: String(tBA), total_borrow_shares: String(tBS),
        total_supply_assets: String(tSA), total_supply_shares: String(tSS), liquidity: String(liquidityRaw) },
    };
  });
  const errors = Object.fromEntries(markets.filter(m => m.error || m.valuation_error).map(m => [m.key, m.error || m.valuation_error]));
  return { version: 1, chain: 747474, wallet, ts, block: blockNumber, generated_at: new Date(ts * 1000).toISOString(),
    full: Object.keys(errors).length === 0, errors, markets };
}

function targetWad(target) {
  const value = Number(target);
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('Target health must be a finite positive number');
  // Round the chosen minimum health UP at six decimals. Rounding it down could
  // permit more debt than requested. Parse scientific notation too, keeping very
  // small or large finite inputs out of floating-point multiplication/overflow.
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction), shift = Number(exponent) - fraction.length + 6;
  const micro = shift >= 0 ? digits * 10n ** BigInt(shift) : ceilDiv(digits, 10n ** BigInt(-shift));
  return micro * 1000000000000n;
}
function maximum(lo, hi, predicate) {
  while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (predicate(mid)) lo = mid; else hi = mid - 1n; }
  return lo;
}

export function targetMetrics(row, target = 2) {
  const tw = targetWad(target), effectiveTarget = Number(String(tw / 1000000000000n) + 'e-6');
  const common = { target_health: effectiveTarget, target_ltv: row.lltv / effectiveTarget };
  if (row.error || row.no_position || !row.raw) return { ...common, status: row.no_position ? 'no-position' : 'unavailable', borrow_amount: null, repay_amount: null,
    target_debt_amount: row.no_position ? 0 : null, target_debt_usd: row.no_position ? 0 : null };
  const r = row.raw, debt = BigInt(r.debt), liq = BigInt(r.liquidation_debt), limit = liq * WAD / tw;
  const b = BigInt(r.borrow_shares), A = BigInt(r.total_borrow_assets), S = BigInt(r.total_borrow_shares), liquidity = BigInt(r.liquidity);
  const headroom = max(0n, limit - debt);
  // A personal scenario may exceed the liquidation limit; Morpho still rejects
  // borrowing beyond it. Keep the chosen debt target separate from real capacity.
  const borrowLimit = min(limit, liq), borrowHeadroom = max(0n, borrowLimit - debt);
  const afterBorrow = amount => { const shares = ceilDiv(amount * (S + VIRTUAL_SHARES), A + 1n); return debtAssets(b + shares, A + amount, S + shares); };
  const borrow = debt <= borrowLimit ? maximum(0n, min(borrowHeadroom, liquidity), amount => afterBorrow(amount) <= borrowLimit) : 0n;
  let repay = 0n;
  if (debt > limit) {
    // Pick shares first, then quote their assets rounded up. Burning these shares
    // leaves debt at or below the personal target, even at the raw-unit boundary.
    const keep = maximum(0n, b, shares => debtAssets(shares, A, S) <= limit);
    repay = debtAssets(b - keep, A, S);
  }
  const scale = n => units(n, row.loan_decimals);
  return { ...common, status: debt > limit ? 'repay' : headroom > 0n ? 'borrow' : 'at-target',
    target_debt_amount: scale(limit), target_debt_usd: row.loan_usd == null ? null : scale(limit) * row.loan_usd,
    headroom_amount: scale(headroom), borrow_amount: scale(borrow), repay_amount: scale(repay),
    borrow_usd: row.loan_usd == null ? null : scale(borrow) * row.loan_usd,
    repay_usd: row.loan_usd == null ? null : scale(repay) * row.loan_usd,
    liquidity_amount: scale(liquidity), liquidity_limited: liquidity < borrowHeadroom,
    protocol_limited: limit > liq,
    target_debt_raw: String(limit), max_borrow_raw: String(borrow), repay_raw: String(repay),
  };
}

/* Morpho's _isHealthy checks floor(floor(collateral * oracle / 1e36)
   * LLTV / 1e18) >= debt. Invert both floors with ceilings to find the
   minimum healthy oracle price; a price strictly below it is liquidatable.
   Source: morpho-org/morpho-blue/src/Morpho.sol, _isHealthy.

   avKAT/KAT is a KAT-per-avKAT ratio: changing KAT's USD price on both
   sides does not provide a single USD liquidation price. For USDC loans,
   the USD estimate assumes the oracle moves proportionally with KAT while
   balances, avKAT conversion, loan value and other oracle inputs stay fixed. */
export function liquidationMetrics(row) {
  const positive = value => Number.isFinite(value) && value > 0 ? value : null;
  const kind = row?.loan_token === 'KAT' && row?.collateral_token === 'avKAT' ? 'kat-ratio' : 'kat-usd';
  const katOracleUsd = positive(row?.kat_oracle_price_usd);
  const katPoolUsd = positive(row?.kat_price_usd)
    ?? (row?.loan_token === 'KAT' ? positive(row.loan_usd)
      : row?.collateral_token === 'KAT' ? positive(row.collateral_price_usd)
        : row?.collateral_token === 'avKAT' && positive(row.avkat_rate)
          ? positive(row.collateral_price_usd / row.avkat_rate) : null);
  const katUsd = katOracleUsd ?? katPoolUsd;
  const base = { status: 'unavailable', kind, kat_price_usd: katUsd,
    kat_price_basis: katOracleUsd !== null ? 'oracle' : katPoolUsd !== null ? 'pool' : null,
    estimated_kat_liquidation_usd: null, kat_drop_pct: null,
    oracle_liquidation_price: null, oracle_current_price: null,
    ratio_headroom_pct: null, oracle_liquidation_raw: null, liquidatable: null };
  if (!row || row.error) return base;
  if (row.no_position) return { ...base, status: 'no-debt', liquidatable: false };
  const r = row.raw;
  if (!r) return base;
  let debt, collateral, price, lltv;
  try {
    debt = BigInt(r.debt); collateral = BigInt(r.collateral);
    price = BigInt(r.oracle_price); lltv = BigInt(r.lltv);
  } catch { return base; }
  if (debt < 0n || collateral < 0n || price < 0n || lltv < 0n) return base;
  if (debt === 0n) return { ...base, status: 'no-debt', liquidatable: false };
  if (collateral === 0n) return { ...base, status: 'no-collateral', liquidatable: true };
  if (price === 0n || lltv === 0n || lltv > WAD
    || !Number.isInteger(row.collateral_decimals) || !Number.isInteger(row.loan_decimals)
    || row.collateral_decimals < 0 || row.loan_decimals < 0) return base;
  const critical = ceilDiv(ceilDiv(debt * WAD, lltv) * ORACLE_SCALE, collateral);
  const quoteScale = value => Number(value) / 1e36 * 10 ** (row.collateral_decimals - row.loan_decimals);
  const currentPrice = quoteScale(price), criticalPrice = quoteScale(critical);
  const factor = Number(critical) / Number(price);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(criticalPrice) || !Number.isFinite(factor)) return base;
  const headroomPct = critical === price ? 0 : (1 - factor) * 100;
  return { ...base, status: 'ok', oracle_liquidation_price: criticalPrice,
    oracle_current_price: currentPrice, oracle_liquidation_raw: String(critical),
    liquidatable: price < critical, ratio_headroom_pct: headroomPct,
    estimated_kat_liquidation_usd: kind === 'kat-usd' && katUsd !== null ? katUsd * factor : null,
    kat_drop_pct: kind === 'kat-usd' && katUsd !== null ? headroomPct : null };
}

export function mergeHistory(history, sample) {
  const base = history || { version: 1, chain: 747474, wallet: WALLET, interval_seconds: 21600, markets: MARKETS, samples: [] };
  if (base.version !== 1 || base.wallet !== sample.wallet) throw new Error('Morpho history wallet or version mismatch');
  // Existing pinned samples are immutable, including a recorded gap. A live read
  // never revalues an earlier point or overwrites a partial historical answer.
  if (base.samples.some(s => s.block === sample.block)) return base;
  return { ...base, generated_at: new Date().toISOString(), samples: [...base.samples, sample].sort((a, b) => a.ts - b.ts) };
}
