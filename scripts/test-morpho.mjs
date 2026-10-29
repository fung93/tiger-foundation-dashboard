/* Meaningful money-math boundaries: Oracle LLTV, virtual shares, rounding,
   insufficient liquidity, unavailable reads, and immutable block history. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debtAssets, targetMetrics, liquidationMetrics, mergeHistory, WALLET } from '../morpho-core.mjs';
import { loadMorphoHistory, updateMorphoHistory } from './morpho.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const WAD = 10n ** 18n, VS = 1000000n;
const ceil = (a, b) => (a + b - 1n) / b;
function row({ debt = 20n, collateral = 100n, lltv = WAD * 625n / 1000n, liquidity = 100n, shares = debt * VS, A = 1000n, S = 1000n * VS } = {}) {
  const limit = collateral * lltv / WAD;
  const debtRaw = debtAssets(shares, A, S);
  return { lltv: Number(lltv) / 1e18, loan_decimals: 0, loan_usd: 1, raw: {
    debt: String(debtRaw), collateral: String(collateral), lltv: String(lltv), oracle_price: String(10n ** 36n),
    borrow_shares: String(shares), liquidation_debt: String(limit), total_borrow_assets: String(A), total_borrow_shares: String(S), liquidity: String(liquidity),
  } };
}

check(debtAssets(1n, 1n, 1n), 1n, 'A fractional raw-unit debt rounds up');
check(debtAssets(0n, 1n, 1n), 0n, 'No shares means no debt');
let m = targetMetrics(row(), 2);
check(m.target_ltv, .3125, 'Health 2 in a 62.5% LLTV market is 31.25% personal LTV');
check(m.target_debt_amount, 31, 'Target debt rounds down to whole raw units');
check(m.borrow_amount, 11, 'Only room below the personal target is borrowable');
check(m.status, 'borrow', 'Borrow state');
const rr = row();
const b = BigInt(rr.raw.borrow_shares), A = BigInt(rr.raw.total_borrow_assets), S = BigInt(rr.raw.total_borrow_shares), borrow = BigInt(m.max_borrow_raw);
const newDebt = amount => { const shares = ceil(amount * (S + VS), A + 1n); return debtAssets(b + shares, A + amount, S + shares); };
check(newDebt(borrow) <= BigInt(m.target_debt_raw), true, 'Share-rounded borrow stays below target');
check(newDebt(borrow + 1n) > BigInt(m.target_debt_raw), true, 'One more raw unit would breach the target');

m = targetMetrics(row({ liquidity: 3n }), 2);
check(m.borrow_amount, 3, 'Borrow capped by real market liquidity');
check(m.headroom_amount, 11, 'Collateral room remains separately visible');
check(m.liquidity_limited, true, 'Liquidity limit is explicit');
m = targetMetrics(row({ liquidity: 0n }), 2);
check(m.borrow_amount, 0, 'An empty lending market cannot fund another borrow');
check(m.status, 'borrow', 'No liquidity is distinguished from no collateral room');
check(m.liquidity_limited, true, 'Zero liquidity is explicitly limiting');

const over = row({ debt: 50n });
m = targetMetrics(over, 2);
check(m.status, 'repay', 'Debt over the personal target asks for repayment');
check(m.borrow_amount, 0, 'No further borrowing while over the target');
check(m.repay_amount >= 19, true, 'Repayment rounds conservatively up');
const burn = BigInt(m.repay_raw) * (BigInt(over.raw.total_borrow_shares) + VS) / (BigInt(over.raw.total_borrow_assets) + 1n);
const after = debtAssets(BigInt(over.raw.borrow_shares) - burn, BigInt(over.raw.total_borrow_assets) - BigInt(m.repay_raw), BigInt(over.raw.total_borrow_shares) - burn);
check(after <= BigInt(m.target_debt_raw), true, 'Actual assets repayment burns enough shares to reach the target');

m = targetMetrics(row({ debt: 0n }), 2);
check(m.status, 'borrow', 'Zero debt can have collateral capacity');
check(m.repay_amount, 0, 'Zero debt never asks for repayment');
m = targetMetrics({ error: 'oracle unavailable', lltv: .625 }, 2);
check(m.status, 'unavailable', 'No oracle never implies healthy');
check(m.borrow_amount, null, 'Unknown capacity does not show a false zero');
m = targetMetrics({ no_position: true, lltv: .625 }, 2);
check(m.status, 'no-position', 'Before-position history is distinct from an error');
check(m.target_debt_usd, 0, 'No position has zero debt capacity');
for (const invalid of [0, -1, NaN, Infinity, -Infinity, '', 'invalid', null]) {
  assert.throws(() => targetMetrics(row(), invalid), /finite positive/); checks++;
}
m = targetMetrics(row(), 1);
check(m.target_health, 1, 'Exact liquidation-boundary health is a valid personal target');
check(m.target_ltv, .625, 'Health 1 matches the market LLTV');
check(m.target_debt_amount, 62, 'Health 1 uses the protocol-rounded liquidation debt');
check(m.protocol_limited, false, 'A target at the boundary needs no additional protocol cap');

m = targetMetrics(row(), .5);
check(m.target_health, .5, 'Health below 1 is accepted without raising it to the boundary');
check(m.target_ltv, 1.25, 'A personal max LTV above 100% remains visible');
check(m.target_debt_amount, 124, 'The selected debt scenario can exceed the protocol limit');
check(m.headroom_amount, 104, 'Personal scenario headroom remains separate from actual borrowing capacity');
check(m.protocol_limited, true, 'The protocol borrowing cap is explicit for a below-boundary target');
check(m.liquidity_limited, false, 'Liquidity above real protocol headroom is not falsely called limiting');
check(m.borrow_amount, 42, 'Actual borrowing stops at health 1 even when the chosen target is lower');
check(newDebt(BigInt(m.max_borrow_raw)) <= BigInt(rr.raw.liquidation_debt), true,
  'Share-rounded borrowing stays within the on-chain liquidation limit');
check(newDebt(BigInt(m.max_borrow_raw) + 1n) > BigInt(rr.raw.liquidation_debt), true,
  'One more raw unit would breach the on-chain limit');
m = targetMetrics(row({ liquidity: 3n }), .5);
check(m.borrow_amount, 3, 'The protocol-limited scenario still respects lower market liquidity');
check(m.liquidity_limited, true, 'Liquidity limiting the protocol-constrained capacity is explicit');
check(m.protocol_limited, true, 'Protocol and liquidity caps may both constrain a scenario');
m = targetMetrics(row({ debt: 80n }), .5);
check(m.borrow_amount, 0, 'An already-liquidatable position has no further executable borrowing');
check(m.target_debt_amount, 124, 'The chosen scenario is retained even if current debt already exceeds the protocol limit');
check(m.repay_amount, 0, 'The personal scenario alone does not invent a repayment to its higher target');
m = targetMetrics(row({ debt: 150n }), .5);
check(m.status, 'repay', 'A below-boundary target still calculates repayment when exceeded');
check(m.repay_amount >= 26, true, 'Repayment to a below-boundary personal target remains conservatively rounded');

check(targetMetrics(row(), 200).target_health, 200, 'Health above the old 100 ceiling is accepted');
check(targetMetrics(row(), 1e21).target_health, 1e21, 'Large scientific-notation targets parse correctly');
check(targetMetrics(row(), Number.MAX_VALUE).target_health, Number.MAX_VALUE,
  'The largest finite health avoids overflowing the intermediate WAD conversion');
check(targetMetrics(row(), 1e-7).target_health, .000001, 'Tiny positive targets round up to the supported health precision');
check(targetMetrics(row(), Number.MIN_VALUE).target_health, .000001,
  'The smallest positive input stays positive after decimal rounding');
check(targetMetrics(row(), .1234567).target_health, .123457, 'Below-boundary targets retain conservative six-decimal rounding');
m = targetMetrics(row(), 1.0000004);
check(m.target_health, 1.000001, 'A sub-micro health minimum rounds up conservatively');
check(m.target_ltv, .625 / 1.000001, 'Personal LTV uses the effective minimum health');
check(targetMetrics(row(), 1.000001).target_health, 1.000001, 'An exact six-decimal target is not rounded again');

function liquidationRow(options = {}) {
  return { collateral_token: 'KAT', loan_token: 'vbUSDC', collateral_decimals: 18,
    loan_decimals: 6, kat_price_usd: .6, collateral_price_usd: .6, loan_usd: 1,
    raw: { collateral: String(100n * WAD), debt: '20000000', lltv: String(WAD * 625n / 1000n),
      oracle_price: String(5n * 10n ** 23n), ...options.raw }, ...options,
    // Keep partial raw overrides instead of replacing the fixture's complete shape.
    ...(options.raw ? { raw: { collateral: String(100n * WAD), debt: '20000000',
      lltv: String(WAD * 625n / 1000n), oracle_price: String(5n * 10n ** 23n), ...options.raw } } : {}) };
}
let liq = liquidationMetrics(liquidationRow());
check(liq.kind, 'kat-usd', 'USDC borrowing can have a conditional KAT USD estimate');
check(liq.oracle_current_price, .5, 'Oracle price retains collateral/loan decimal adjustment');
check(liq.oracle_liquidation_price, .32, 'Critical KAT oracle quote follows raw collateral and LLTV');
check(liq.estimated_kat_liquidation_usd, .384, 'KAT USD estimate scales the oracle move, not the redemption quote');
check(liq.kat_price_basis, 'pool', 'Older or failed-feed reads identify the market-pool estimate basis');
const oracleBased = liquidationMetrics(liquidationRow({ kat_oracle_price_usd: .5 }));
check(oracleBased.kat_price_usd, .5, 'The actual oracle feed takes precedence over a different pool price');
check(oracleBased.kat_price_basis, 'oracle', 'Actual KAT/USD feed basis is explicit');
check(oracleBased.estimated_kat_liquidation_usd, .32, 'Conditional liquidation estimate uses the actual KAT/USD oracle basis');
check(liquidationMetrics(liquidationRow({ kat_oracle_price_usd: 0 })).kat_price_basis, 'pool', 'A zero feed quote falls back explicitly instead of generating zero liquidation price');
check(liquidationMetrics(liquidationRow({ kat_oracle_price_usd: -1 })).kat_price_basis, 'pool', 'A negative feed quote is not a valid liquidation estimate basis');
check(Math.abs(liq.kat_drop_pct - 36) < 1e-10, true, 'Conditional USD drop uses the same oracle ratio');
check(liq.liquidatable, false, 'A currently healthy position is not liquidatable');
const boundary = BigInt(liq.oracle_liquidation_raw);
const capacityAt = rawPrice => (100n * WAD * rawPrice / (10n ** 36n)) * (WAD * 625n / 1000n) / WAD;
check(capacityAt(boundary) >= 20000000n, true, 'Exact boundary is still healthy under both Morpho floors');
check(capacityAt(boundary - 1n) < 20000000n, true, 'One raw oracle unit lower is liquidatable');
check(liquidationMetrics(liquidationRow({ raw: { oracle_price: String(boundary) } })).liquidatable, false, 'Health 1 boundary is not reported as below 1');
check(liquidationMetrics(liquidationRow({ raw: { oracle_price: String(boundary - 1n) } })).liquidatable, true, 'A raw oracle step below the boundary is detected');
check(liquidationMetrics(liquidationRow({ raw: { oracle_price: String(boundary) } })).kat_drop_pct, 0, 'At-boundary price headroom is exactly zero');
const coarse = liquidationRow({ collateral_decimals: 0, loan_decimals: 0,
  raw: { collateral: '7', debt: '3', oracle_price: String(10n ** 36n) } });
const coarseBoundary = BigInt(liquidationMetrics(coarse).oracle_liquidation_raw);
check(coarseBoundary, ceil(5n * 10n ** 36n, 7n), 'Boundary inversion preserves the inner collateral-quote floor');
check((7n * coarseBoundary / (10n ** 36n)) * 625n / 1000n, 3n, 'Double-floor boundary covers the full debt');
check((7n * (coarseBoundary - 1n) / (10n ** 36n)) * 625n / 1000n, 2n, 'One lower raw oracle value crosses the actual contract boundary');

const ratioRow = liquidationRow({ collateral_token: 'avKAT', loan_token: 'KAT', loan_decimals: 18,
  avkat_rate: 1.4, loan_usd: .6, raw: { debt: String(77n * WAD), lltv: String(WAD * 77n / 100n), oracle_price: String(14n * 10n ** 35n) } });
liq = liquidationMetrics(ratioRow);
check(liq.kind, 'kat-ratio', 'avKAT/KAT liquidation depends on their ratio');
check(liq.oracle_liquidation_price, 1, 'Ratio collateral has an exact critical KAT-per-avKAT quote');
check(liq.oracle_current_price, 1.4, 'Current oracle ratio is retained');
check(liq.estimated_kat_liquidation_usd, null, 'A KAT-denominated loan never invents a KAT USD liquidation price');
check(liq.kat_drop_pct, null, 'A shared KAT USD drop is not called liquidation headroom');
check(Math.abs(liq.ratio_headroom_pct - 28.57142857142857) < 1e-10, true, 'Ratio headroom remains visible');
check(liquidationMetrics({ ...ratioRow, kat_price_usd: .0001, loan_usd: .0001 }).oracle_liquidation_price, 1, 'Changing KAT USD does not move the KAT-per-avKAT liquidation boundary');

const avkatUsd = liquidationRow({ collateral_token: 'avKAT', kat_price_usd: undefined, collateral_price_usd: .84, avkat_rate: 1.4 });
check(liquidationMetrics(avkatUsd).kat_price_usd, .6, 'Older avKAT history derives KAT USD from redemption rate and market quote');
check(liquidationMetrics({ ...ratioRow, kat_price_usd: undefined }).kat_price_usd, .6, 'Older KAT debt history derives KAT USD from loan USD');
check(liquidationMetrics(liquidationRow({ kat_price_usd: undefined })).kat_price_usd, .6, 'Older KAT collateral history derives KAT USD from its market quote');
liq = liquidationMetrics(liquidationRow({ kat_price_usd: undefined, collateral_price_usd: null }));
check(liq.estimated_kat_liquidation_usd, null, 'Missing KAT market price cannot become a zero USD liquidation estimate');
check(liq.oracle_liquidation_price, .32, 'Exact oracle boundary remains available when USD valuation fails');
check(liq.kat_drop_pct, null, 'Missing market price does not claim a market-price drop');
check(liq.kat_price_basis, null, 'A missing oracle and market quote has no price basis');
check(liquidationMetrics(liquidationRow({ raw: { debt: '0' } })).status, 'no-debt', 'No debt has no liquidation threshold');
check(liquidationMetrics(liquidationRow({ raw: { debt: '0' } })).estimated_kat_liquidation_usd, null, 'No debt never fabricates a zero liquidation price');
check(liquidationMetrics({ no_position: true }).status, 'no-debt', 'No position has no liquidation threshold');
check(liquidationMetrics(liquidationRow({ raw: { collateral: '0' } })).status, 'no-collateral', 'Debt with no collateral has no finite price boundary');
check(liquidationMetrics(liquidationRow({ raw: { collateral: '0' } })).liquidatable, true, 'Debt without collateral is already unprotected');
check(liquidationMetrics(liquidationRow({ raw: { oracle_price: '0' } })).status, 'unavailable', 'Zero oracle cannot supply a price estimate');
check(liquidationMetrics(liquidationRow({ raw: { oracle_price: undefined } })).status, 'unavailable', 'Missing oracle cannot supply a price estimate');
check(liquidationMetrics(liquidationRow({ raw: { lltv: '0' } })).status, 'unavailable', 'Missing LLTV cannot supply a price estimate');
check(liquidationMetrics(liquidationRow({ error: 'oracle read failed' })).status, 'unavailable', 'Failed reads cannot produce an actionable liquidation threshold');
liq = liquidationMetrics(liquidationRow({ raw: { oracle_price: String(2n * 10n ** 23n) } }));
check(liq.liquidatable, true, 'A position already below health 1 is identified');
check(liq.kat_drop_pct < 0, true, 'An already-breached boundary reports a negative margin instead of a future drop');

const sample = { wallet: WALLET, ts: 123, block: 1, markets: [{ collateral_usd: 10 }] };
const original = mergeHistory(null, sample);
const replaced = mergeHistory(original, { ...sample, markets: [{ collateral_usd: 99 }] });
check(replaced.samples[0].markets[0].collateral_usd, 10, 'History never reprices at today\'s value');
check(replaced.samples.length, 1, 'Same block is not duplicated');
const extended = mergeHistory(original, { ...sample, block: 2, ts: 456 });
check(extended.samples.length, 2, 'A new block is appended');
check(original.samples.length, 1, 'A merge does not mutate the previous history');

// Existing bad files must fail before any chain request, preserving their bytes.
const scratch = mkdtempSync(join(tmpdir(), 'tiger-morpho-tests-'));
const ledger = join(scratch, 'morpho-history.json');
const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('A bad ledger must fail before network access'); };
try {
  check(loadMorphoHistory(ledger), null, 'Only a genuinely absent file starts a history');
  const valid = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'morpho-history.json'), 'utf8'));
  const invalidFiles = [
    '{"version":1,broken',
    JSON.stringify({ ...valid, version: 99 }),
    JSON.stringify({ ...valid, wallet: '0x0000000000000000000000000000000000000000' }),
    JSON.stringify({ ...valid, chain: 1 }),
    JSON.stringify({ ...valid, samples: {} }),
    JSON.stringify({ ...valid, samples: [{ ...valid.samples[0], block: null }] }),
    JSON.stringify({ ...valid, samples: [{ ...valid.samples[0], ts: -1 }] }),
    JSON.stringify({ ...valid, samples: [{ ...valid.samples[0], markets: [] }] }),
  ];
  for (const text of invalidFiles) {
    writeFileSync(ledger, text);
    await assert.rejects(updateMorphoHistory(scratch), /Invalid Morpho history/); checks++;
    check(readFileSync(ledger, 'utf8'), text, 'Invalid existing history remains byte-identical');
  }
  check(networkCalls, 0, 'Malformed and unsupported histories never reach the network');
  writeFileSync(ledger, JSON.stringify(valid));
  check(loadMorphoHistory(ledger).samples.length, valid.samples.length, 'Current stored history passes strict validation');
} finally {
  globalThis.fetch = realFetch;
  // Remove only the two exact test paths created above; no recursive deletion.
  unlinkSync(ledger);
  rmdirSync(scratch);
}
console.log('Morpho lending: ' + checks + ' assertions passed.');
