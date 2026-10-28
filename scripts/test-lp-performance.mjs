/* Holding benchmarks use original deposited tokens; APR reports actual measured income.
   No RPCs, ledger writes, reconstructed entry balances or historical repricing. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookView, r2 } from '../api/_core.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const near = (actual, expected, note) => { assert.ok(Math.abs(actual - expected) < 1e-8, note + ': ' + actual); checks++; };
const NOW = 1900000000, HOUR = 3600, DAY = 86400, wallet = '0x1111111111111111111111111111111111111111';
const token = 'COIN@robinhood', stable = 'USDG@robinhood';
const dollars = { [token]: 99999, [stable]: 1, 'KAT@katana': 2 };
const fields = ['cost_usd', 'principal_usd', 'hold_usd', 'market_usd', 'il_usd', 'earned_usd', 'lp_outcome_usd', 'difference_usd'];
function position(id = '1', overrides = {}) {
  const opened = NOW - DAY;
  return { key: 'robinhood:' + id, chain: 'robinhood', id, wallet, pair: 'COIN / USDG',
    t0: token, t1: stable, s0: 'COIN', s1: 'USDG', status: 'open', at_start: false,
    opened_ts: opened, cost_usd: 120, out_usd: 0,
    deposits: [{ ts: opened, a0: 10, a1: 100, usd: 120 }], withdrawals: [],
    fees: { [token]: 1, [stable]: 1 }, start_uncollected: {}, start_merkl: {}, merkl: {}, claims: [],
    ...overrides };
}
function row(P, overrides = {}) {
  return { id: P.id, chain: P.chain, wallet: P.wallet, pair: P.pair, protocol: 'Uniswap V3',
    value_usd: 142, liquidity_usd: 135, fees_usd: 7, fee_yield_usd: 10, fees_mine: true,
    pnl_usd: null, il_usd: null, in_range: true, pending: true, held_days: 1,
    range: { now: 4, lower: 3, upper: 5, position_pct: 50, to_lower_pct: 25, to_upper_pct: 25, width_pct: 66.67 },
    raw: { sqrt: String(2n * (1n << 96n)), t0: { s: 'COIN', d: 0, stable: false },
      t1: { s: 'USDG', d: 0, stable: true }, fee0: .5, fee1: 3 }, ...overrides };
}
function ledger(positions, fee_series = []) {
  return { started: { ts: NOW - 20 * DAY }, wallets: [wallet], events: [], fee_series,
    tokens: Object.fromEntries(positions.flatMap(p => [[p.t0, { s: p.s0 }], [p.t1, { s: p.s1 }]])),
    positions: Object.fromEntries(positions.map(p => [p.key, p])) };
}
const observation = (P, hours, tokens = { [P.t0]: 1, [P.t1]: 1 }) =>
  ({ ts: NOW - hours * HOUR, pos: { [P.key]: tokens }, pp: { [P.key]: 0 } });
const render = (book, rows, options = {}) => bookView(book, { rows, prices: dollars,
  merkl: { earned_tokens_by_id: {}, earned_by_id: {} }, ...options });
function unavailable(c, note) {
  check(c.available, false, note + ': unavailable');
  check(c.complete, false, note + ': incomplete');
  check(typeof c.reason === 'string' && c.reason.length > 0, true, note + ': explains why');
  for (const field of fields) check(c[field], null, note + ': ' + field + ' is unknown, not zero');
}
function unavailableRate(a, note) {
  check(a.available, false, note + ': unavailable');
  check(a.complete, false, note + ': incomplete');
  check(typeof a.reason === 'string' && a.reason.length > 0, true, note + ': explains why');
  check(a.pct, null, note + ': unknown rate is not zero');
  check(a.earned_usd, null, note + ': unknown earned dollars are not zero');
}
function identities(c, note) {
  check(c.market_usd, r2(c.hold_usd - c.cost_usd), note + ': market movement reconciles to displayed capital');
  check(c.il_usd, r2(c.principal_usd - c.hold_usd), note + ': IL reconciles to displayed principal and hold');
  check(c.lp_outcome_usd, r2(c.principal_usd + c.earned_usd), note + ': LP outcome adds displayed principal and income');
  check(c.difference_usd, r2(c.lp_outcome_usd - c.hold_usd), note + ': advantage reconciles to displayed outcomes');
  check(c.difference_usd, r2(c.il_usd + c.earned_usd), note + ': advantage equals IL plus earned income');
}

const originalNow = Date.now, originalFetch = globalThis.fetch;
Date.now = () => NOW * 1000;
globalThis.fetch = () => { throw new Error('Performance views must not make network requests'); };
try {
  let P = position(), R = row(P), book = ledger([P], [observation(P, 6)]);
  let v = render(book, { [P.key]: R }), c = v.live[0].comparison, a = v.live[0].apr_detail;
  check(c.available && c.complete, true, 'A full deposit and live quote support the comparison');
  check(c.hold_usd, 140, 'Original human-unit deposit tokens use the principal read\'s $4 price, not the unrelated global price');
  check(c.cost_usd, 120, 'Historical deposited dollar capital is unchanged');
  check(c.market_usd, 20, 'Market movement is the holding value less original capital');
  check(c.il_usd, -5, 'IL is LP principal less holding value before fees');
  check(c.earned_usd, 10, 'Owned fees include collected and currently unclaimed tokens once');
  check(c.principal_usd, 135, 'The benchmark separates principal from accrued fees');
  check(c.lp_outcome_usd, 145, 'LP outcome adds its owned earnings to principal');
  check(c.difference_usd, 5, 'LP versus holding includes the fee benefit');
  check(c.start_ts, P.opened_ts, 'Comparison starts at the original deposit');
  check(c.end_ts, NOW, 'The live benchmark states its valuation time');
  check(c.deposit_count, 1, 'Original deposit count is reported');
  check(a.available && a.complete, true, 'A complete recent observation supports APR');
  check(a.elapsed_hours, 6, 'APR reports the actual six-hour interval');
  check(a.start_ts, NOW - 6 * HOUR, 'APR exposes its exact baseline time');
  check(a.end_ts, NOW, 'APR exposes its exact final time');
  check(a.earned_usd, 5, 'Both cumulative snapshots use the same current prices to isolate earned tokens');
  check(a.capital_usd, 120, 'APR names the capital denominator');
  near(a.pct, 5 / 120 / .25 * 36500, 'Recent APR is simple annualisation of that actual interval');
  check(a.period_label, 'Last 6.0 hours', 'A six-hour measurement is not labelled 24h');
  check(v.cards.comparison.available_count, 1, 'Summary counts supported positions');
  check(v.cards.comparison.expected_count, 1, 'Summary counts all applicable positions');
  check(v.cards.comparison.difference_usd, 5, 'A complete summary uses the same complete comparison');
  check(R.pending, true, 'Legacy no-entry pending flag does not falsely reject verified deposits');
  identities(c, 'Live position');
  identities(v.cards.comparison, 'Live summary');

  const fractional = position('fractional', { cost_usd: 843.66, fees: {},
    deposits: [{ ts: NOW - DAY, a0: 10, a1: 803.7751, usd: 843.66 }] });
  const fractionalRow = row(fractional, { liquidity_usd: 843.77 });
  fractionalRow.raw.fee0 = 0; fractionalRow.raw.fee1 = .1249;
  v = render(ledger([fractional]), { [fractional.key]: fractionalRow });
  c = v.live[0].comparison;
  check(c.hold_usd, 843.78, 'Fractional holding value is stated at displayed cents');
  check(c.earned_usd, .12, 'Fractional income is stated at displayed cents');
  check(c.lp_outcome_usd, 843.89, 'Fractional LP outcome adds the displayed components');
  check(c.difference_usd, .11, 'Advantage is $843.89 minus $843.78, not a separately rounded raw delta');
  identities(c, 'Fractional-cent position');
  const fractional2 = { ...structuredClone(fractional), id: 'fractional2', key: 'robinhood:fractional2' };
  v = render(ledger([fractional, fractional2]), { [fractional.key]: fractionalRow, [fractional2.key]: row(fractional2,
    { liquidity_usd: 843.77, raw: structuredClone(fractionalRow.raw) }) });
  check(v.cards.comparison.difference_usd, .22, 'Aggregate sums the rounded capital and income components consistently');
  identities(v.cards.comparison, 'Fractional-cent summary');

  v = render(ledger([P]), { [P.key]: row(P, { liquidity_usd: 110 }) });
  check(v.live[0].comparison.il_usd, -30, 'A losing LP principal is measured against the holding benchmark');
  check(v.live[0].comparison.difference_usd, -20, 'Fees do not turn an underperforming LP into a gain by omission');
  check(v.live[0].apr_detail.period_label, 'Since opened (24.0 hours)', 'A single full-lifetime deposit can use the since-open fallback');
  check(v.live[0].apr_detail.earned_usd, 10, 'Since-open income uses all earned tokens only once');

  const katToken = 'COIN@katana', katStable = 'USDG@katana', reward = 'KAT@katana';
  const KP = position('kat', { key: 'katana:kat', chain: 'katana', t0: katToken, t1: katStable,
    deposits: [{ ts: NOW - DAY, a0: 10, a1: 100, usd: 120 }], fees: { [katToken]: 99999 }, merkl: { [reward]: 5 } });
  const KR = row(KP, { chain: 'katana', fees_mine: false, fees_usd: 99999 });
  const freshMerkl = { earned_tokens_by_id: { kat: { [reward]: 5 } }, earned_by_id: { kat: 10 } };
  v = render(ledger([KP]), { [KP.key]: KR }, { merkl: freshMerkl });
  check(v.live[0].comparison.earned_usd, 10, 'Katana comparison counts only this position\'s Merkl rewards');
  check(v.live[0].comparison.difference_usd, 5, 'DAO trading fees are excluded from the LP result');
  check(v.live[0].apr_detail.earned_usd, 10, 'Katana APR excludes DAO trading fees too');
  v = render(ledger([KP]), { [KP.key]: KR }, { merkl: { ...freshMerkl, error: true } });
  unavailable(v.live[0].comparison, 'Unavailable current Merkl reading');
  unavailableRate(v.live[0].apr_detail, 'Unavailable current Merkl reading');
  v = render(ledger([KP]), { [KP.key]: KR }, { merkl: { earned_tokens_by_id: {} } });
  unavailable(v.live[0].comparison, 'Saved positive rewards without a fresh per-ID reading');

  const topup = position('topup', { cost_usd: 150, deposits: [
    { ts: NOW - DAY, a0: 10, a1: 100, usd: 120 }, { ts: NOW - 12 * HOUR, a0: 0, a1: 30, usd: 30 },
  ] });
  v = render(ledger([topup], [observation(topup, 20), observation(topup, 6)]), { [topup.key]: row(topup, { liquidity_usd: 165 }) });
  check(v.live[0].comparison.hold_usd, 170, 'Top-ups add their actual deposited token amounts to holding');
  check(v.live[0].comparison.deposit_count, 2, 'Top-up benchmark discloses both deposits');
  check(v.live[0].comparison.basis.includes('2 recorded deposits'), true, 'Top-up comparison explains its capital coverage');
  check(v.live[0].apr_detail.elapsed_hours, 6, 'APR skips observations from before the latest top-up');
  check(v.live[0].apr_detail.capital_usd, 150, 'Recent post-top-up APR uses the capital present throughout that interval');
  v = render(ledger([topup], [observation(topup, 20)]), { [topup.key]: row(topup) });
  unavailableRate(v.live[0].apr_detail, 'Top-up without a post-deposit earning baseline');

  for (const [name, overrides] of [
    ['partial withdrawal', { out_usd: 10, withdrawals: [{ ts: NOW - HOUR, a0: 1, a1: 6, usd: 10 }] }],
    ['missing original amounts', { deposits: [{ ts: NOW - DAY, a1: 100, usd: 120 }] }],
    ['zero original amounts', { deposits: [{ ts: NOW - DAY, a0: 0, a1: 0, usd: 120 }] }],
    ['unpriced deposit', { unpriced: true }],
    ['photographed position', { at_start: true }],
    ['transferred position', { transferred: true }],
    ['incomplete capital coverage', { cost_usd: 150 }],
  ]) {
    const bad = position(name, overrides);
    v = render(ledger([bad]), { [bad.key]: row(bad) });
    unavailable(v.live[0].comparison, name);
    unavailableRate(v.live[0].apr_detail, name);
  }
  const priceLess = structuredClone(KR);
  v = render(ledger([KP]), { [KP.key]: priceLess }, { merkl: freshMerkl, prices: {} });
  unavailable(v.live[0].comparison, 'Missing reward price');
  unavailableRate(v.live[0].apr_detail, 'Missing reward price');
  v = render(ledger([KP]), { [KP.key]: KR }, { merkl: freshMerkl, prices: { [reward]: 0 } });
  unavailable(v.live[0].comparison, 'Zero reward price');
  v = render(ledger([P]), { [P.key]: row(P, { raw: undefined }) });
  unavailable(v.live[0].comparison, 'Incomplete raw quote and unclaimed-fee reading');
  const zeroPriceRow = row(P); zeroPriceRow.raw.sqrt = '0';
  v = render(ledger([P]), { [P.key]: zeroPriceRow });
  unavailable(v.live[0].comparison, 'Zero required deposit-token dollar price');
  unavailableRate(v.live[0].apr_detail, 'Zero required earning-token dollar price');
  v = render(ledger([P]), { [P.key]: R }, { errors: { 'robinhood (live)': 'unavailable' } });
  unavailable(v.live[0].comparison, 'Live chain error');
  v = render(ledger([P]), { [P.key]: R }, { behind: { robinhood: 5 } });
  unavailable(v.live[0].comparison, 'Incomplete chain catch-up');

  const other = position('missing-row');
  v = render(ledger([P, other]), { [P.key]: R });
  check(v.live[0].comparison.available, true, 'A supported position remains available individually');
  unavailable(v.cards.comparison, 'Incomplete aggregate coverage');
  check(v.cards.comparison.available_count, 1, 'Incomplete summary identifies the supported count');
  check(v.cards.comparison.expected_count, 2, 'Incomplete summary includes the missing position in coverage');

  const zero = position('zero', { fees: {} }), zeroRow = row(zero);
  zeroRow.raw.fee0 = 0; zeroRow.raw.fee1 = 0;
  v = render(ledger([zero], [observation(zero, 4, {})]), { [zero.key]: zeroRow });
  check(v.live[0].apr_detail.available, true, 'A verified zero-earning interval is valid');
  check(v.live[0].apr_detail.earned_usd, 0, 'Verified no income is zero dollars');
  check(v.live[0].apr_detail.pct, 0, 'Verified no income has zero APR');
  check(v.live[0].comparison.difference_usd, -5, 'With no fees, comparison still includes IL');

  v = render(ledger([P], [observation(P, 23.25), observation(P, 6)]), { [P.key]: R });
  check(v.live[0].apr_detail.elapsed_hours, 23.25, 'The oldest recent 3–26h observation retains its exact duration');
  check(v.live[0].apr_detail.period_label, 'Last 23.3 hours', 'APR label reflects a fractional actual interval');
  const badBase = observation(P, 6); delete badBase.pp[P.key];
  v = render(ledger([P], [badBase]), { [P.key]: R });
  unavailableRate(v.live[0].apr_detail, 'Historical baseline lacks a complete position observation');
  v = render(ledger([P], [observation(P, 6, { [token]: 2, [stable]: 0 })]), { [P.key]: R });
  unavailableRate(v.live[0].apr_detail, 'One cumulative token decreases despite total dollar earnings increasing');
  const missingPriceBase = observation(P, 6, { 'UNKNOWN@robinhood': 1 });
  v = render(ledger([P], [missingPriceBase]), { [P.key]: R });
  unavailableRate(v.live[0].apr_detail, 'A historical token cannot be valued at current prices');
  const tiny = position('newborn', { opened_ts: NOW - 100, deposits: [{ ts: NOW - 100, a0: 10, a1: 100, usd: 120 }] });
  v = render(ledger([tiny]), { [tiny.key]: row(tiny) });
  unavailableRate(v.live[0].apr_detail, 'Insufficient measurement time');

  const rounded = position('rounded', { fees: { [token]: .123456789, [stable]: 0 } }), roundedRow = row(rounded);
  roundedRow.raw.fee0 = 0; roundedRow.raw.fee1 = 0;
  v = render(ledger([rounded], [observation(rounded, 6, { [token]: .12345679 })]), { [rounded.key]: roundedRow });
  check(v.live[0].apr_detail.available, true, 'Saved 1e-8 token precision does not create a false decrease');
  check(v.live[0].apr_detail.earned_usd, 0, 'Unchanged cumulative earnings at saved precision are zero');

  const closed = position('closed', { status: 'closed', opened_ts: NOW - 10 * DAY, closed_ts: NOW - 5 * DAY,
    deposits: [{ ts: NOW - 10 * DAY, a0: 10, a1: 100, usd: 120 }], out_usd: 135,
    withdrawals: [{ ts: NOW - 5 * DAY, a0: 5, a1: 115, usd: 135 }],
    frozen: { at_ts: NOW - 5 * DAY, principal_usd: 135, pnl_usd: 15,
      prices: { [token]: 4, [stable]: 1 }, fee_usd: 99999 },
    claims: [{ ts: NOW - 4 * DAY, usd: 5, tokens: { [token]: 2 }, prices: { [token]: 2.5 } }],
  });
  const closedBook = ledger([closed]);
  v = render(closedBook, {}, { prices: { [token]: 999999 }, merkl: { error: true }, errors: { robinhood: 'offline' } });
  c = v.alltime.history[0].comparison;
  check(c.available && c.complete, true, 'Closed benchmark is independent of today\'s chain or reward failures');
  check(c.hold_usd, 140, 'Closed holding benchmark uses saved close prices, not current prices');
  check(c.earned_usd, 5, 'Closed earnings use actual claim-date dollars, not frozen close-price fee estimates');
  check(c.difference_usd, 0, 'Closed final principal plus actual claims is compared against holding at close');
  check(c.end_ts, closed.closed_ts, 'The closed benchmark states the actual close date');
  check(c.basis.includes('fees at their recorded claim prices'), true, 'Late-claim valuation basis is explicit');
  identities(c, 'Closed position');
  identities(v.alltime.cards.comparison, 'Closed summary');
  check(v.alltime.cards.apr_detail.earned_usd, 5, 'Closed APR names actual claimed income');
  check(v.alltime.cards.apr_detail.start_ts, closed.opened_ts, 'Closed APR exposes its first opening date');
  check(v.alltime.cards.apr_detail.end_ts, closed.closed_ts, 'Closed APR exposes its final closing date');
  check(v.alltime.cards.apr_detail.capital_days_usd, 600, 'Closed APR exposes the existing capital-day weighting');
  check(v.alltime.cards.apr_detail.pct, v.alltime.cards.apr_pct, 'Closed APR metadata preserves the existing weighted calculation');
  check(render(closedBook, {}, { prices: { [token]: .00001 } }).alltime, v.alltime, 'Changing live prices cannot reprice closed performance');

  const closedTopup = structuredClone(closed);
  closedTopup.cost_usd = 150; closedTopup.out_usd = 165; closedTopup.frozen.principal_usd = 165;
  closedTopup.deposits.push({ ts: NOW - 8 * DAY, a0: 0, a1: 30, usd: 30 });
  closedTopup.withdrawals[0].usd = 165; closedTopup.withdrawals[0].a1 = 145;
  v = render(ledger([closedTopup]), {});
  check(v.alltime.history[0].comparison.available, true, 'Closed top-up holding benchmark uses all recorded deposit lots');
  check(v.alltime.history[0].comparison.hold_usd, 170, 'Closed top-up benchmark values each actual lot at the same closing prices');
  unavailableRate(v.alltime.cards.apr_detail, 'Later top-up cannot label final capital as present throughout the full closed lifetime');
  check(v.alltime.cards.apr_pct, 243.33, 'Existing closed headline APR calculation is preserved for compatibility');

  const missingClose = structuredClone(closed); missingClose.id = 'missing-close'; missingClose.key = 'robinhood:missing-close';
  delete missingClose.frozen.prices[token];
  v = render(ledger([closed, missingClose]), {});
  unavailable(v.alltime.history.find(p => p.id === missingClose.id).comparison, 'Missing frozen close price');
  unavailable(v.alltime.cards.comparison, 'Closed aggregate with incomplete price coverage');
  check(v.alltime.cards.comparison.available_count, 1, 'Closed coverage counts only complete benchmarks');
  const partialClosed = structuredClone(closed);
  partialClosed.withdrawals.unshift({ ts: NOW - 6 * DAY, a0: 1, a1: 0, usd: 4 });
  v = render(ledger([partialClosed]), {});
  unavailable(v.alltime.history[0].comparison, 'Partial withdrawal before final close');
  const unknownClaim = structuredClone(closed); unknownClaim.claims[0].usd = null;
  v = render(ledger([unknownClaim]), {});
  unavailable(v.alltime.history[0].comparison, 'Missing historical claimed dollars');
  unavailableRate(v.alltime.cards.apr_detail, 'Incomplete closed APR fee history');

  const saved = JSON.parse(readFileSync(new URL('../lpbook.json', import.meta.url), 'utf8'));
  const original = structuredClone(saved), savedView = render(saved, {});
  const actualClosed = Object.values(saved.positions).filter(p => p.status !== 'open');
  const supported = actualClosed.filter(p => Array.isArray(p.deposits) && p.deposits.length
    && p.withdrawals?.length === 1 && p.frozen?.prices && !p.unpriced && !p.frozen.incomplete && !p.at_start);
  check(savedView.alltime.cards.comparison.available_count, supported.length, 'Saved ledger coverage reflects its actual complete records');
  for (const p of supported) {
    const benchmark = savedView.alltime.history.find(h => h.id === p.id && h.chain === p.chain).comparison;
    const hold = p.deposits.reduce((s, d) => s + d.a0 * p.frozen.prices[p.t0] + d.a1 * p.frozen.prices[p.t1], 0);
    const fees = (p.claims || []).reduce((s, claim) => s + (claim.usd ?? 0), 0);
    check(benchmark.hold_usd, r2(hold), 'Actual saved original deposit benchmark: ' + p.key);
    check(benchmark.difference_usd, r2(p.frozen.principal_usd + r2(fees) - hold), 'Actual saved LP-versus-hold result: ' + p.key);
    identities(benchmark, 'Actual saved comparison ' + p.key);
  }
  if (savedView.alltime.cards.comparison.available) identities(savedView.alltime.cards.comparison, 'Actual saved closed aggregate');
  check(savedView.alltime.cards.apr_detail.pct, savedView.alltime.cards.apr_pct, 'Saved closed APR stays identical');
  check(saved, original, 'All performance views leave the saved ledger completely unchanged');
  const immutableBook = ledger([P], [observation(P, 6)]), immutableRows = { [P.key]: R };
  const originals = structuredClone({ immutableBook, immutableRows });
  render(immutableBook, immutableRows);
  check({ immutableBook, immutableRows }, originals, 'Live performance does not mutate deposits, earnings, rows or observations');
  unavailable(render(ledger([]), {}).cards.comparison, 'An empty book has no comparison, not a fictitious zero result');
  console.log('Saved closed comparison: ' + JSON.stringify(savedView.alltime.cards.comparison));
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}
console.log('LP performance: ' + checks + ' assertions passed.');
