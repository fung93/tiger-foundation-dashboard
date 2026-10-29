/* An explicitly reassigned KAT balance must move once, retain prior claim history,
   and remain assigned to the destination when it is eventually claimed. All
   reads below use local fixtures; no historical file or chain is changed. */
import assert from 'node:assert/strict';
import * as core from '../api/_core.mjs';

const { CFG, V3, r2, merklLp, advanceBook, bookView, feeTotals, positionFees } = core;
const SOURCE = '492291', TARGET = '492626', KAT = 'KAT@katana';
const SOURCE_KEY = 'katana:' + SOURCE, TARGET_KEY = 'katana:' + TARGET;
const WALLET = '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1';
const POOL = '0x744676b3ced942d78f9b8e9cd22246db5c32395c';
const CUTOFF = 1338.1368961866224, CARRY = 2651.4569888919086;
const OWN = 604.749678658545, PRICE = .004, NOW = 1900000000, HOUR = 3600;
const clone = value => structuredClone(value);
let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const near = (actual, expected, note) => {
  assert.ok(Math.abs(actual - expected) < 1e-8, note + ': ' + actual + ' versus ' + expected); checks++;
};
const attributed = input => core.attributeMerklRewards(input);

function reading(sourceEarned = CUTOFF + CARRY, sourceClaimed = CUTOFF,
  targetEarned = OWN, targetClaimed = 0) {
  return {
    total_usd: 45, lp_usd: 30,
    earned_tokens_by_id: {
      [SOURCE]: { [KAT]: sourceEarned, 'BONUS@katana': 2 },
      [TARGET]: { [KAT]: targetEarned, 'BONUS@katana': 3 },
      other: { [KAT]: 17 },
    },
    claimed_tokens_by_id: { [SOURCE]: { [KAT]: sourceClaimed, 'BONUS@katana': 1 },
      [TARGET]: { [KAT]: targetClaimed, 'BONUS@katana': 0 }, other: { [KAT]: 8 } },
    earned_by_id: { [SOURCE]: r2(sourceEarned * PRICE + 2), [TARGET]: r2(targetEarned * PRICE + 3), other: .07 },
    wallet_by_id: { [SOURCE]: WALLET, [TARGET]: WALLET, other: CFG.wallets[1].address },
    token_price: { [KAT]: PRICE, 'BONUS@katana': 1 },
  };
}

function position(id, overrides = {}) {
  const opened = id === TARGET ? NOW - 10 * HOUR : NOW - 3 * 86400;
  return { key: 'katana:' + id, chain: 'katana', id, wallet: WALLET, pool: POOL,
    pair: 'vbWBTC / vbUSDC', t0: 'vbWBTC@katana', t1: 'vbUSDC@katana',
    s0: 'vbWBTC', s1: 'vbUSDC', d0: 8, d1: 6, status: 'open', at_start: false,
    opened_ts: opened, opened_block: 1, cost_usd: 851.78,
    deposits: [{ ts: opened, block: 1, a0: .00355262, a1: 562.265331, usd: 851.78 }],
    out_usd: 0, withdrawals: [], fees: {}, start_uncollected: {}, start_merkl: {},
    merkl: { [KAT]: id === TARGET ? OWN : CUTOFF + CARRY }, claimed_seen: {}, claims: [],
    ...overrides };
}
function ledger() {
  const closed = NOW - 10 * HOUR - 300, claimTs = closed - 100;
  const source = position(SOURCE, { status: 'closed', closed_ts: closed, closed_block: 2,
    out_usd: 844.5, withdrawals: [{ ts: closed, block: 2, a0: 0, a1: 844.5, usd: 844.5 }],
    claimed_seen: { [KAT]: CUTOFF }, last_claim_ts: claimTs,
    claims: [{ ts: claimTs, block: 2, tokens: { [KAT]: CUTOFF }, prices: { [KAT]: .003 }, usd: r2(CUTOFF * .003) }],
    frozen: { at_ts: closed, at_block: 2, cost_usd: 851.78, principal_usd: 844.5,
      pnl_usd: -7.28, fee_tokens: { [KAT]: CUTOFF + CARRY }, fee_usd: 18,
      net_usd: 10.72, prices: { 'vbWBTC@katana': 80000, 'vbUSDC@katana': 1, [KAT]: .0045 } } });
  const target = position(TARGET);
  return { version: core.BOOK_VERSION, started: { ts: NOW - 5 * 86400, iso: new Date((NOW - 5 * 86400) * 1000).toISOString() },
    wallets: CFG.wallets.map(w => w.address.toLowerCase()), events: [], runs: [],
    last_block: Object.fromEntries(V3.map(ch => [ch.key, 100])),
    positions: { [SOURCE_KEY]: source, [TARGET_KEY]: target },
    tokens: { [KAT]: { s: 'KAT' }, 'vbWBTC@katana': { s: 'vbWBTC' }, 'vbUSDC@katana': { s: 'vbUSDC' } },
    merkl_claimed: { [KAT]: CUTOFF },
    claims: [{ wallet: WALLET, token: KAT, ts: claimTs, block: 2, amount: CUTOFF, price: .003, assigned: CUTOFF }],
    fee_series: [{ ts: NOW - 6 * HOUR, pos: { [TARGET_KEY]: { [KAT]: 100 } }, pp: { [TARGET_KEY]: 0 } }],
  };
}
function rows(book) {
  const P = book.positions[TARGET_KEY];
  return { [TARGET_KEY]: { id: TARGET, chain: 'katana', wallet: WALLET, pair: P.pair,
    value_usd: 850, liquidity_usd: 850, fees_usd: 9, fees_mine: false, pnl_usd: null,
    il_usd: null, in_range: true, held_days: 1,
    range: { now: 80000, lower: 79000, upper: 82000, position_pct: 33,
      to_lower_pct: 1.25, to_upper_pct: 2.5, width_pct: 3.8 },
    raw: { sqrt: String(BigInt(Math.floor(Math.sqrt(800) * 2 ** 96))),
      t0: { s: 'vbWBTC', d: 8, stable: false }, t1: { s: 'vbUSDC', d: 6, stable: true }, fee0: 0, fee1: 9 } } };
}
function view(book, merkl) {
  return bookView(book, { rows: rows(book), merkl, prices: { [KAT]: PRICE,
    'vbWBTC@katana': 80000, 'vbUSDC@katana': 1, 'BONUS@katana': 1 }, errors: {}, behind: {} });
}
async function advance(book, merkl) {
  const result = await advanceBook(book, { merkl, maxWindows: 0 });
  check(result.errors, {}, 'Local cursor reads finish without chain errors');
  return result.book;
}

const realFetch = globalThis.fetch, realNow = Date.now;
const realRpcs = V3.map(ch => ch.rpc);
let merklMode = false, merklFailure = false, requests = [];
globalThis.fetch = async (url, init) => {
  requests.push(String(url));
  if (merklMode) {
    assert.ok(String(url).startsWith(CFG.merklApi + '/users/'));
    if (merklFailure && String(url).includes(WALLET)) return { ok: false, status: 503 };
    const reason = id => 'SUSHI_SWAP_' + POOL + '_' + id + '~fixture';
    const payload = String(url).includes(WALLET) ? [{ chain: { id: 747474 }, rewards: [{
      token: { symbol: 'KAT', decimals: 18, price: PRICE },
      amount: '4315340887242828930511', claimed: '1338136896186622417983', pending: '279002676494246984545',
      breakdowns: [
        { reason: reason(SOURCE), amount: '2651456988891908565825', claimed: '0', pending: '0' },
        { reason: reason(SOURCE), amount: '1338136896186622417983', claimed: '1338136896186622417983', pending: '0' },
        { reason: reason(TARGET), amount: '325747002164297956763', claimed: '0', pending: '279002676494246984545' },
      ],
    }] }] : [];
    return { ok: true, json: async () => payload };
  }
  const call = JSON.parse(init.body);
  assert.equal(call.method, 'eth_blockNumber', 'Reward-only tests must never scan or move chain state');
  return { ok: true, json: async () => ({ result: '0x64' }) };
};
Date.now = () => NOW * 1000;
V3.forEach((ch, i) => { ch.rpc = 'https://local-reward-fixture.invalid/' + i; });

try {
  check(typeof core.attributeMerklRewards, 'function', 'Reward attribution has one shared pure implementation');
  check(core.REWARD_ATTRIBUTION_VERSION, 1, 'Attribution uses an explicit observation basis version');
  const input = reading(), savedInput = clone(input), moved = attributed(input);
  check(moved.reward_attribution_version, 1, 'The adjusted reward reading identifies its basis');
  check(input, savedInput, 'Attribution never mutates raw source readings');
  near(moved.earned_tokens_by_id[SOURCE][KAT], CUTOFF, 'Closed LP retains only its earlier claimed reward');
  near(moved.earned_tokens_by_id[TARGET][KAT], OWN + CARRY, 'Current LP receives all outstanding source KAT');
  near(moved.claimed_tokens_by_id[SOURCE][KAT], CUTOFF, 'Prior source claims stay assigned to the closed LP');
  near(moved.claimed_tokens_by_id[TARGET][KAT], 0, 'Moving unclaimed KAT does not invent a claim');
  near(moved.earned_tokens_by_id[SOURCE][KAT] + moved.earned_tokens_by_id[TARGET][KAT],
    input.earned_tokens_by_id[SOURCE][KAT] + input.earned_tokens_by_id[TARGET][KAT], 'Total earned tokens are conserved');
  near(moved.claimed_tokens_by_id[SOURCE][KAT] + moved.claimed_tokens_by_id[TARGET][KAT], CUTOFF, 'Total claimed tokens are conserved');
  check(moved.total_usd, input.total_usd, 'Wallet reward value is unchanged');
  check(moved.lp_usd, input.lp_usd, 'Aggregate LP reward value is unchanged');
  for (const id of [SOURCE, TARGET]) {
    check(moved.earned_tokens_by_id[id]['BONUS@katana'], input.earned_tokens_by_id[id]['BONUS@katana'], 'Other reward tokens retain attribution');
    check(moved.claimed_tokens_by_id[id]['BONUS@katana'], input.claimed_tokens_by_id[id]['BONUS@katana'], 'Other reward claims retain attribution');
    check(moved.earned_by_id[id], r2(moved.earned_tokens_by_id[id][KAT] * PRICE
      + moved.earned_tokens_by_id[id]['BONUS@katana']), 'Per-position dollar rewards agree with attributed tokens');
  }
  check(moved.earned_tokens_by_id.other, input.earned_tokens_by_id.other, 'Unrelated positions are unchanged');
  check(attributed(moved), moved, 'Repeated attribution is idempotent');

  const later = attributed(reading(CUTOFF + CARRY + 25, CUTOFF + 40, OWN + 50, 10));
  near(later.earned_tokens_by_id[TARGET][KAT], OWN + 50 + CARRY + 25, 'Late source settlement stays with the selected destination');
  near(later.claimed_tokens_by_id[TARGET][KAT], 50, 'A later source claim moves to destination together with its own claim');
  near(later.claimed_tokens_by_id[SOURCE][KAT], CUTOFF, 'Later claims do not increase old source claim history');

  const invalid = [
    ['failed reward source', m => { m.error = true; }],
    ['missing source position', m => { delete m.earned_tokens_by_id[SOURCE]; }],
    ['missing destination position', m => { delete m.earned_tokens_by_id[TARGET]; }],
    ['missing source token', m => { delete m.earned_tokens_by_id[SOURCE][KAT]; }],
    ['missing destination claimed value', m => { delete m.claimed_tokens_by_id[TARGET][KAT]; }],
    ['unverified source wallet', m => { delete m.wallet_by_id[SOURCE]; }],
    ['different destination wallet', m => { m.wallet_by_id[TARGET] = CFG.wallets[1].address; }],
    ['nonfinite reward amount', m => { m.earned_tokens_by_id[SOURCE][KAT] = Infinity; }],
    ['negative reward amount', m => { m.earned_tokens_by_id[TARGET][KAT] = -1; }],
    ['source below historical claim cutoff', m => { m.earned_tokens_by_id[SOURCE][KAT] = CUTOFF - 1; m.claimed_tokens_by_id[SOURCE][KAT] = 0; }],
    ['claims exceed earnings', m => { m.claimed_tokens_by_id[TARGET][KAT] = OWN + 1; }],
    ['unsupported attribution basis', m => { m.reward_attribution_version = 999; }],
    ['failed already attributed source', m => { m.reward_attribution_version = 1; m.error = true; }],
  ];
  for (const [name, change] of invalid) {
    const bad = reading(); change(bad);
    const beforeBad = clone(bad);
    assert.throws(() => attributed(bad), undefined, name + ' must not produce a complete adjusted reading'); checks++;
    check(bad, beforeBad, name + ' leaves the input untouched');
  }

  merklMode = true; requests = [];
  const fromReader = await merklLp();
  check(Boolean(fromReader.error), false, 'The actual reader accepts complete local Merkl rewards');
  near(fromReader.earned_tokens_by_id[SOURCE][KAT], CUTOFF, 'Reader aggregates duplicate source breakdowns before attribution');
  near(fromReader.earned_tokens_by_id[TARGET][KAT], OWN + CARRY, 'Reader includes target amount and pending tokens exactly once');
  check(requests.length, CFG.wallets.length * V3.filter(ch => ch.merklChain).length, 'Attribution adds no remote reads');
  merklFailure = true;
  const failedReader = await merklLp();
  check(failedReader.error, true, 'A failed Merkl request stays incomplete');
  check(failedReader.earned_tokens_by_id, {}, 'A failed adjusted reading cannot overwrite saved position amounts');
  check(failedReader.claimed_tokens_by_id, {}, 'A failed adjusted reading cannot fabricate claim amounts');
  check(failedReader.earned_by_id, {}, 'A failed adjusted reading cannot fabricate dollar rewards');
  merklFailure = false;
  merklMode = false;

  const original = ledger(), originalBytes = JSON.stringify(original);
  const plainReading = reading();
  // This fixture has one KAT reward; separate pure tests above cover unrelated tokens.
  for (const id of [SOURCE, TARGET]) {
    delete plainReading.earned_tokens_by_id[id]['BONUS@katana'];
    delete plainReading.claimed_tokens_by_id[id]['BONUS@katana'];
    plainReading.earned_by_id[id] = r2(plainReading.earned_tokens_by_id[id][KAT] * PRICE);
  }
  const before = view(original, plainReading), adjusted = attributed(plainReading);
  const updated = await advance(original, adjusted), after = view(updated, adjusted);
  check(JSON.stringify(original), originalBytes, 'Advancing rewards does not mutate the source ledger');
  check(updated.positions[SOURCE_KEY].claims, original.positions[SOURCE_KEY].claims, 'All earlier claim dates, token amounts and prices stay intact');
  check(updated.positions[SOURCE_KEY].frozen, original.positions[SOURCE_KEY].frozen, 'The frozen close is never repriced');
  check(updated.fee_series, original.fee_series, 'Saved earning observations are not rewritten');
  check(after.alltime, before.alltime, 'All-time cards, history, APR and curves remain identical before a new claim');
  check(after.cards.fees_usd, 0, 'Live claimed-fees card does not include a transfer of unclaimed KAT');
  check(after.cards.unclaimed_usd, r2((OWN + CARRY) * PRICE), 'Live unclaimed balance includes the reassigned KAT once');
  check(after.live[0].yield_value, '$' + r2((OWN + CARRY) * PRICE).toFixed(2), 'Current card rewards use the same reassigned total');
  check(after.live[0].comparison.earned_usd, r2((OWN + CARRY) * PRICE), 'LP versus holding includes the same reassigned income');
  check(after.live[0].apr_detail.available, true, 'An old complete observation still supports a measured APR');
  check(after.live[0].apr_detail.earned_usd, r2((OWN - 100) * PRICE), 'APR excludes the bookkeeping transfer from recent earned income');
  check(after.live[0].apr_detail.elapsed_hours, 6, 'The actual observation interval is retained');
  const markedBook = clone(updated);
  markedBook.fee_series[0].reward_attribution_version = core.REWARD_ATTRIBUTION_VERSION;
  markedBook.fee_series[0].pos[TARGET_KEY][KAT] += CARRY;
  const markedView = view(markedBook, adjusted);
  check(markedView.live[0].apr_detail, after.live[0].apr_detail,
    'Already adjusted samples and legacy samples produce the same rate without double adjustment');
  const unsupportedBook = clone(markedBook);
  unsupportedBook.fee_series[0].reward_attribution_version = 2;
  const unsupportedBytes = JSON.stringify(unsupportedBook), unsupportedView = view(unsupportedBook, adjusted);
  const unsupportedApr = unsupportedView.live[0].apr_detail;
  check(unsupportedApr.available, false, 'An unsupported historical attribution basis cannot produce APR');
  check(unsupportedApr.complete, false, 'An unknown observation basis is explicitly incomplete');
  check(unsupportedApr.reason, 'The cumulative earning amounts are incomplete.',
    'An unsupported basis is rejected before arithmetic rather than double-offset as legacy income');
  check(unsupportedApr.pct, null, 'Unknown-basis APR is unavailable rather than zero');
  check(unsupportedApr.earned_usd, null, 'Unknown-basis income is unavailable rather than an invented interval');
  check(unsupportedView.live[0].yield_value, after.live[0].yield_value,
    'An unsupported historical baseline does not hide verified current rewards');
  check(unsupportedView.live[0].comparison, after.live[0].comparison,
    'An unsupported APR baseline does not alter the complete current holding comparison');
  check(JSON.stringify(unsupportedBook), unsupportedBytes, 'Unknown-version samples are never rewritten');
  check(feeTotals(updated, rows(updated)), feeTotals(original, rows(original)), 'Whole-book fee totals do not grow when rewards are reassigned');
  near(positionFees(updated, rows(updated))[TARGET_KEY][KAT], OWN + CARRY, 'Scheduled samples receive the same attributed position rewards');
  check(await advance(updated, adjusted), updated, 'Repeated API advancement cannot apply the transfer twice');

  const failedRefresh = await advance(updated, { error: true,
    earned_tokens_by_id: { [SOURCE]: { [KAT]: 0 }, [TARGET]: { [KAT]: 0 } },
    claimed_tokens_by_id: { [SOURCE]: { [KAT]: 0 }, [TARGET]: { [KAT]: 0 } } });
  check(failedRefresh.positions, updated.positions, 'Failed rewards never replace a retained full attribution with zero');
  const failedView = view(failedRefresh, { error: true, earned_tokens_by_id: {}, claimed_tokens_by_id: {} });
  check(failedView.live[0].yield_value, after.live[0].yield_value, 'Reward failure retains the displayed reward value');
  check(failedView.live[0].comparison.available, false, 'Reward failure cannot claim a fresh complete comparison');
  check(failedView.live[0].apr_detail.available, false, 'Reward failure cannot claim a fresh complete APR');

  for (const conflict of ['cursor only', 'records only']) {
    const overlappingBook = clone(original), extra = 40, eventTs = NOW - 300;
    const source = overlappingBook.positions[SOURCE_KEY];
    if (conflict === 'cursor only') source.claimed_seen[KAT] += extra;
    else source.claims.push({ ts: eventTs, block: 3, tokens: { [KAT]: extra },
      prices: { [KAT]: .005 }, usd: r2(extra * .005) });
    overlappingBook.claims.push({ wallet: WALLET, token: KAT, ts: eventTs, block: 3,
      amount: extra, price: .005, assigned: extra });
    overlappingBook.merkl_claimed[KAT] += extra;
    const overlappingRaw = clone(plainReading);
    overlappingRaw.claimed_tokens_by_id[SOURCE][KAT] += extra;
    const overlappingMerkl = attributed(overlappingRaw), merklBytes = JSON.stringify(overlappingMerkl);
    const overlappingBytes = JSON.stringify(overlappingBook), requestsBefore = requests.length;
    const guarded = await advanceBook(overlappingBook, { merkl: overlappingMerkl, maxWindows: 0 });
    check(typeof guarded.errors.merkl, 'string', conflict + ': overlapping historical claims make rewards incomplete');
    check(guarded.errors.merkl.includes('Saved claims overlap'), true,
      conflict + ': the failure identifies the attribution overlap');
    check(Object.keys(guarded.errors), ['merkl'], conflict + ': unrelated chain reads remain healthy');
    check(requests.length - requestsBefore, V3.length, conflict + ': every chain still reads its cursor');
    check(guarded.behind, Object.fromEntries(V3.map(ch => [ch.key, 0])), conflict + ': chain freshness is still measured');
    check(guarded.book.positions, overlappingBook.positions,
      conflict + ': saved reward balances, claim cursors, records and frozen positions stay intact');
    check(guarded.book.claims, overlappingBook.claims,
      conflict + ': an already assigned wallet claim is never assigned a second time');
    check(guarded.book.positions[TARGET_KEY].claims, [], conflict + ': the destination receives no duplicate claim');
    check(guarded.book.fee_series, overlappingBook.fee_series, conflict + ': historical earning samples remain intact');
    check(JSON.stringify(overlappingBook), overlappingBytes, conflict + ': the input ledger is never mutated');
    check(JSON.stringify(overlappingMerkl), merklBytes, conflict + ': local failure does not mutate the valid source reading');
    const guardedView = bookView(guarded.book, { rows: rows(guarded.book),
      merkl: overlappingMerkl, prices: { [KAT]: PRICE, 'vbWBTC@katana': 80000, 'vbUSDC@katana': 1 },
      errors: guarded.errors, behind: guarded.behind });
    check(guardedView.health.errors.merkl, guarded.errors.merkl,
      conflict + ': the actual view exposes incomplete rewards to the refresh controller');
    check(guardedView.live[0].comparison.available, false, conflict + ': a conflicted reward allocation cannot present a complete comparison');
    check(guardedView.live[0].apr_detail.available, false, conflict + ': a conflicted reward allocation cannot present a complete APR');
    check(guardedView.cards.fees_usd, 0, conflict + ': destination claimed-fees totals cannot double count old claims');
  }

  const partialInput = clone(updated), partialAmount = 50, claimPrice = .005, partialTs = NOW - 180;
  partialInput.claims.push({ wallet: WALLET, token: KAT, ts: partialTs, block: 3,
    amount: partialAmount, price: claimPrice, assigned: 0 });
  partialInput.merkl_claimed[KAT] += partialAmount;
  const partialRaw = clone(plainReading);
  partialRaw.claimed_tokens_by_id[SOURCE][KAT] += 40;
  partialRaw.claimed_tokens_by_id[TARGET][KAT] += 10;
  const partialMerkl = attributed(partialRaw), partialBook = await advance(partialInput, partialMerkl);
  const partialView = view(partialBook, partialMerkl);
  near(partialBook.positions[TARGET_KEY].claims.reduce((n, c) => n + c.tokens[KAT], 0), partialAmount,
    'A partial source plus destination claim is credited once to the destination');
  check(partialView.cards.fees_usd, r2(partialAmount * PRICE), 'Partial claims enter claimed fees once');
  check(partialView.cards.unclaimed_usd, r2((OWN + CARRY - partialAmount) * PRICE),
    'Partial claims reduce only the pending portion');
  check(partialView.live[0].yield_value, after.live[0].yield_value, 'Partial claims preserve total earned rewards');
  check(partialView.live[0].comparison.earned_usd, after.live[0].comparison.earned_usd,
    'Partial claims do not change the holding comparison income');
  check(partialView.alltime, after.alltime, 'A partial reassigned claim never enters closed-source history');
  check(await advance(partialBook, partialMerkl), partialBook, 'Repeated partial claims cannot double credit rewards');

  const claimAmount = OWN + CARRY, claimTs = NOW - 30;
  const claimInput = clone(partialBook);
  claimInput.claims.push({ wallet: WALLET, token: KAT, ts: claimTs, block: 3,
    amount: claimAmount - partialAmount, price: claimPrice, assigned: 0 });
  claimInput.merkl_claimed[KAT] += claimAmount - partialAmount;
  const allClaimedRaw = clone(plainReading);
  allClaimedRaw.claimed_tokens_by_id[SOURCE][KAT] = CUTOFF + CARRY;
  allClaimedRaw.claimed_tokens_by_id[TARGET][KAT] = OWN;
  const allClaimed = attributed(allClaimedRaw), claimedBook = await advance(claimInput, allClaimed);
  const claimedView = view(claimedBook, allClaimed);
  check(claimedBook.positions[SOURCE_KEY].claims, original.positions[SOURCE_KEY].claims,
    'Claiming the reassigned balance later does not change the old LP claim records');
  near(claimedBook.positions[TARGET_KEY].claims.reduce((n, c) => n + c.tokens[KAT], 0), claimAmount,
    'The destination receives the later claim exactly once');
  near(claimedBook.positions[TARGET_KEY].claimed_seen[KAT], claimAmount,
    'The destination claim cursor includes its own and the reassigned rewards');
  check(claimedView.cards.unclaimed_usd, 0, 'An actual full claim clears the pending balance');
  check(claimedView.cards.fees_usd, r2(claimAmount * PRICE), 'Claimed fees move into the live claim total once');
  check(claimedView.live[0].yield_value, after.live[0].yield_value, 'Claiming does not reduce lifetime rewards');
  check(claimedView.alltime, after.alltime, 'Claiming the reassigned balance cannot add it to closed source history');
  check(await advance(claimedBook, allClaimed), claimedBook, 'Repeated claimed reading cannot duplicate a claim');

  const closedInput = clone(updated), closedTarget = closedInput.positions[TARGET_KEY], closeTs = NOW - HOUR;
  closedTarget.status = 'closed'; closedTarget.closed_ts = closeTs; closedTarget.closed_block = 3;
  closedTarget.out_usd = 850;
  closedTarget.withdrawals = [{ ts: closeTs, block: 3, a0: 0, a1: 850, usd: 850 }];
  closedTarget.frozen = { at_ts: closeTs, at_block: 3, cost_usd: closedTarget.cost_usd, principal_usd: 850,
    pnl_usd: r2(850 - closedTarget.cost_usd), prices: { [KAT]: .006, 'vbWBTC@katana': 80000, 'vbUSDC@katana': 1 } };
  closedInput.claims.push({ wallet: WALLET, token: KAT, ts: claimTs, block: 4,
    amount: claimAmount, price: claimPrice, assigned: 0 });
  const targetFrozen = clone(closedTarget.frozen);
  const afterClosedClaim = await advance(closedInput, allClaimed), closedView = view(afterClosedClaim, allClaimed);
  const sourceHistory = closedView.alltime.history.find(p => p.id === SOURCE);
  const targetHistory = closedView.alltime.history.find(p => p.id === TARGET);
  check(closedView.cards.open, 0, 'Closing the destination does not move its rewards to a different open LP');
  check(afterClosedClaim.positions[TARGET_KEY].frozen, targetFrozen, 'A later claim never reprices destination principal or its close');
  check(sourceHistory, after.alltime.history.find(p => p.id === SOURCE), 'Source history remains unchanged after destination closes and claims');
  near(targetHistory.fee_tokens.KAT, claimAmount, 'Reassigned KAT stays with the same destination after its close');
  check(targetHistory.fee_usd, r2(claimAmount * claimPrice), 'Closed destination fees use the actual claim price, not current or closing KAT price');
  check(await advance(afterClosedClaim, allClaimed), afterClosedClaim, 'Closed destination claims stay idempotent');

  console.log('PASS reward attribution: ' + checks + ' assertions');
} finally {
  globalThis.fetch = realFetch; Date.now = realNow;
  V3.forEach((ch, i) => { ch.rpc = realRpcs[i]; });
}
