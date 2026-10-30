/* Future Katana reward ownership follows LP replacements. Fixtures exercise the
   real book advancement/view, with local cursor replies and no ledger writes.
   Durable replacement boundaries preserve earlier claims and reconstruct the
   same reward ownership in warm API reads, cold reads and scheduled jobs. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { CFG, V3, BOOK_VERSION, advanceBook, bookView, feeTotals, positionFees, r2 } from '../api/_core.mjs';
import { positionAprObservation } from '../api/_fee-observations.mjs';

const NOW = 1900000000, HOUR = 3600, DAY = 86400, KAT = 'KAT@katana';
const A = '810001', B = '810002', C = '810003', D = '810004';
const W = '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1';
const W2 = '0x4da1d0d5f7b123364d7580f19b716de2ed4e9770';
const POOL = '0x744676b3ced942d78f9b8e9cd22246db5c32395c';
const OTHER_POOL = '0x1111111111111111111111111111111111111111';
const PRICE = .01, key = id => 'katana:' + id, clone = value => structuredClone(value);
let checks = 0, clock = NOW, head = 100, failKatana = false, cursorReads = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const near = (actual, expected, note) => { assert.ok(Math.abs(actual - expected) < 1e-8, note + ': ' + actual + ' versus ' + expected); checks++; };
const claimed = P => (P.claims || []).reduce((sum, c) => sum + (c.tokens[KAT] || 0), 0);
const amount = (m, id, field = 'earned_tokens_by_id') => m[field]?.[id]?.[KAT] || 0;
const pending = (m, id) => amount(m, id) - amount(m, id, 'claimed_tokens_by_id');
function position(id, overrides = {}) {
  const opened = NOW - 3 * DAY;
  return { key: key(id), chain: 'katana', id, wallet: W, pool: POOL,
    pair: 'vbWBTC / vbUSDC', t0: 'vbWBTC@katana', t1: 'vbUSDC@katana',
    s0: 'vbWBTC', s1: 'vbUSDC', d0: 8, d1: 6, status: 'open', at_start: false,
    opened_ts: opened, opened_block: 1, cost_usd: 900,
    deposits: [{ ts: opened, block: 1, a0: .005, a1: 500, usd: 900 }],
    out_usd: 0, withdrawals: [], fees: {}, start_uncollected: {}, start_merkl: {},
    merkl: {}, claimed_seen: {}, claims: [], ...overrides };
}
function opened(id, ts, overrides = {}) {
  return position(id, { opened_ts: ts, deposits: [{ ts, block: 2, a0: .005, a1: 500, usd: 900 }], ...overrides });
}
function close(P, ts) {
  P.status = 'closed'; P.closed_ts = ts; P.closed_block = 2; P.out_usd = 901;
  P.withdrawals = [{ ts, block: 2, a0: 0, a1: 901, usd: 901 }];
  P.frozen = { at_ts: ts, at_block: 2, cost_usd: 900, principal_usd: 901,
    pnl_usd: 1, prices: { [P.t0]: 80000, [P.t1]: 1, [KAT]: .005 } };
  return P;
}
function ledger(positions) {
  return { version: BOOK_VERSION, started: { ts: NOW - 10 * DAY, iso: new Date((NOW - 10 * DAY) * 1000).toISOString() },
    wallets: CFG.wallets.map(w => w.address.toLowerCase()), events: [], runs: [], reward_rollovers: [],
    last_block: Object.fromEntries(V3.map(ch => [ch.key, 100])),
    positions: Object.fromEntries(positions.map(P => [P.key, P])),
    tokens: { [KAT]: { s: 'KAT' }, 'vbWBTC@katana': { s: 'vbWBTC' }, 'vbUSDC@katana': { s: 'vbUSDC' } },
    merkl_claimed: {}, claims: [], fee_series: [] };
}
function reading(values, owners = {}) {
  const earned = {}, got = {}, dollars = {}, wallets = {};
  for (const [id, [e, c]] of Object.entries(values)) {
    earned[id] = { [KAT]: e }; got[id] = { [KAT]: c }; dollars[id] = r2(e * PRICE); wallets[id] = owners[id] || W;
  }
  return { total_usd: 88, lp_usd: 55, token_price: { [KAT]: PRICE },
    earned_tokens_by_id: earned, claimed_tokens_by_id: got, earned_by_id: dollars, wallet_by_id: wallets };
}
function record(book, id, n, ts, px = PRICE, assigned = true) {
  const P = book.positions[key(id)];
  if (assigned) {
    P.claims.push({ ts, block: 3, tokens: { [KAT]: n }, prices: { [KAT]: px }, usd: r2(n * px) });
    P.claimed_seen[KAT] = (P.claimed_seen[KAT] || 0) + n;
    P.last_claim_ts = Math.max(P.last_claim_ts || 0, ts);
  }
  book.claims.push({ wallet: P.wallet, token: KAT, ts, block: 3, amount: n, price: px, assigned: assigned ? n : 0 });
  book.merkl_claimed[KAT] = (book.merkl_claimed[KAT] || 0) + n;
}
function rows(book) {
  return Object.fromEntries(Object.values(book.positions).filter(P => P.status === 'open' && P.chain === 'katana').map(P => [P.key, {
    id: P.id, chain: P.chain, wallet: P.wallet, pair: P.pair, value_usd: 901, liquidity_usd: 901,
    fees_usd: 0, fees_mine: false, pnl_usd: null, il_usd: null, in_range: true, held_days: 1,
    range: { now: 80000, lower: 79000, upper: 82000, position_pct: 33, to_lower_pct: 1.25, to_upper_pct: 2.5, width_pct: 3.8 },
    raw: { sqrt: String(BigInt(Math.floor(Math.sqrt(800) * 2 ** 96))),
      t0: { s: P.s0, d: P.d0, stable: false }, t1: { s: P.s1, d: P.d1, stable: true }, fee0: 0, fee1: 0 },
  }]));
}
function view(result) {
  return bookView(result.book, { rows: rows(result.book), merkl: result.merkl,
    prices: { [KAT]: PRICE, 'vbWBTC@katana': 80000, 'vbUSDC@katana': 1 }, errors: result.errors, behind: result.behind });
}
async function advance(book, merkl, complete = true) {
  const before = JSON.stringify(book), rawBefore = JSON.stringify(merkl);
  const result = await advanceBook(book, { merkl, maxWindows: 0 });
  check(JSON.stringify(book), before, 'Advancement preserves the input ledger');
  check(JSON.stringify(merkl), rawBefore, 'Advancement preserves raw reward observations');
  if (complete) { check(result.errors, {}, 'Complete cursor/reward reads are healthy'); check(Boolean(result.merkl.error), false, 'Effective rewards are complete'); }
  return result;
}
function edge(book, source, target) { return book.reward_rollovers.find(e => e.source === source && e.target === target); }
function conserve(raw, effective, ids) {
  for (const field of ['earned_tokens_by_id', 'claimed_tokens_by_id'])
    near(ids.reduce((n, id) => n + amount(effective, id, field), 0), ids.reduce((n, id) => n + amount(raw, id, field), 0), field + ' conserves native amounts');
  check(effective.total_usd, raw.total_usd, 'Wallet reward total stays unchanged');
  check(effective.lp_usd, raw.lp_usd, 'Aggregate LP reward total stays unchanged');
}

const realFetch = globalThis.fetch, realNow = Date.now, realRpcs = V3.map(ch => ch.rpc);
Date.now = () => clock * 1000;
V3.forEach((ch, i) => { ch.rpc = 'https://local-rollover-fixture.invalid/' + i; });
globalThis.fetch = async (url, init) => {
  const call = JSON.parse(init.body);
  assert.equal(call.method, 'eth_blockNumber', 'Automatic reward tests never scan or write chain state');
  cursorReads++;
  if (failKatana && String(url).endsWith('/0')) throw new Error('Katana cursor unavailable');
  return { ok: true, json: async () => ({ result: '0x' + head.toString(16) }) };
};
try {
  // A's 80 unclaimed plus B's 30 native unclaimed follow the replacement chain.
  const a = close(position(A), NOW - 10 * HOUR), b = opened(B, NOW - 10 * HOUR + 100);
  const original = ledger([a, b]);
  original.positions[key(A)].merkl[KAT] = 100; original.positions[key(B)].merkl[KAT] = 40;
  record(original, A, 20, a.closed_ts - 100, .005);
  record(original, B, 10, NOW - 8 * HOUR);
  const native = reading({ [A]: [100, 20], [B]: [40, 10] });
  const savedAClaims = clone(a.claims), savedAFrozen = clone(a.frozen), originalPoints = clone(original.fee_series);
  let result = await advance(original, native);
  check(Boolean(edge(result.book, A, B)), true, 'A new Katana close/open pair gets a persisted rollover');
  near(edge(result.book, A, B).claimedBefore, 20, 'The first complete reading anchors already collected source rewards');
  near(edge(result.book, A, B).initialCarry, 80, 'Only outstanding source rewards become the initial carry');
  near(amount(result.merkl, A), 20, 'Closed A retains its historical earned-and-claimed portion');
  near(amount(result.merkl, B), 120, 'B owns native earnings and the carried balance');
  near(pending(result.merkl, B), 110, 'B pending combines its own and inherited outstanding rewards once');
  check(result.book.positions[key(A)].claims, savedAClaims, 'A earlier claims remain exact');
  check(result.book.positions[key(A)].frozen, savedAFrozen, 'A frozen principal and prices remain exact');
  check(result.book.fee_series, originalPoints, 'Automatic attribution never rewrites old observations');
  conserve(native, result.merkl, [A, B]);
  const firstView = view(result);
  check(firstView.cards.unclaimed_usd, 1.1, 'Actual Live summary uses carried pending KAT');
  check(firstView.live.find(P => P.id === '#' + B).yield_value, '$1.20', 'The actual position card uses all attributed income');
  check(firstView.live.find(P => P.id === '#' + B).comparison.earned_usd, 1.2, 'LP versus holding agrees with the card');
  near(positionFees(result.book, rows(result.book))[key(B)][KAT], 120, 'Scheduled observations see the same effective earnings');
  check(feeTotals(result.book, rows(result.book)), feeTotals(original, rows(original)), 'Whole-book claimed fee totals do not grow');
  const repeated = await advance(result.book, native);
  check(repeated.book, result.book, 'Repeated polling cannot create another edge or transfer');
  const resumed = await advance(JSON.parse(JSON.stringify(result.book)), native);
  check(resumed.book, result.book, 'A cold API/cron resume preserves the persisted allocation');

  const partiallyClaimedInput = clone(result.book);
  record(partiallyClaimedInput, B, 30, NOW - 3 * HOUR, .02, false);
  const partialNative = reading({ [A]: [100, 50], [B]: [40, 10] });
  result = await advance(partiallyClaimedInput, partialNative);
  near(claimed(result.book.positions[key(A)]), 20, 'A keeps its earlier claims after inherited KAT is collected');
  near(claimed(result.book.positions[key(B)]), 40, 'B retains native plus subsequently collected inherited KAT');
  near(pending(result.merkl, B), 80, 'A partial inherited claim reduces B pending exactly once');
  check(result.book.positions[key(A)].claims, savedAClaims, 'A dated claim records never absorb B later claims');
  conserve(partialNative, result.merkl, [A, B]);

  const coldInput = clone(original);
  record(coldInput, B, 30, NOW - 3 * HOUR, .02, false);
  const coldResult = await advance(coldInput, partialNative);
  check(coldResult.book.positions[key(A)].claims, result.book.positions[key(A)].claims,
    'Cold reconstruction cannot move a later inherited claim back to closed A');
  check(coldResult.book.positions[key(B)].claims, result.book.positions[key(B)].claims,
    'Warm and cold reconstruction credit the same later claim to B at the same price');
  check(coldResult.book.reward_rollovers, result.book.reward_rollovers,
    'Cold reconstruction keeps the same immutable rollover boundary as a warm checkpoint');
  check(coldResult.merkl.earned_tokens_by_id, result.merkl.earned_tokens_by_id,
    'Warm and cold reads retain exactly the same effective reward ownership');
  check(coldResult.merkl.claimed_tokens_by_id, result.merkl.claimed_tokens_by_id,
    'Warm and cold reads retain exactly the same claimed reward ownership');

  const toC = clone(result.book), closeB = NOW - 2 * HOUR;
  close(toC.positions[key(B)], closeB);
  toC.positions[key(C)] = opened(C, closeB + 100);
  const bHistorical = clone(toC.positions[key(B)].claims), bFrozen = clone(toC.positions[key(B)].frozen);
  const deferredToC = await advance(toC, partialNative, false);
  check(Boolean(deferredToC.errors['Katana reward rollover']), true,
    'An API-only anchor defers a second rollover when an earlier claim has not entered a durable snapshot');
  check(Boolean(edge(deferredToC.book, B, C)), false, 'A warm checkpoint cannot create a floating cutoff for B');
  check(deferredToC.book.positions[key(B)].claims, bHistorical, 'Deferral preserves the already recorded B claim prices and amounts');
  const durablyResolvedToC = await advanceBook(toC, { merkl: partialNative, maxWindows: 0, persistRollovers: true });
  check(durablyResolvedToC.errors, {}, 'A scheduled durable pass resolves and persists the B boundary');
  near(edge(durablyResolvedToC.book, B, C).claimedBefore, 40, 'The durable B cutoff retains all already collected native and inherited KAT');
  // A new committed snapshot resets the runtime anchor, exactly as the API and
  // scheduled writer do. Historical claims and established edges stay intact.
  delete toC.reward_rollover_anchor;
  result = await advance(toC, partialNative); // C has no native reward API entry yet.
  check(result.merkl.earned_tokens_by_id, durablyResolvedToC.merkl.earned_tokens_by_id,
    'A fresh committed anchor and scheduled resolution agree on current reward ownership');
  check(Boolean(edge(result.book, B, C)), true, 'B closes and its new replacement C is registered automatically');
  near(edge(result.book, B, C).claimedBefore, 40, 'B outgoing cutoff includes already collected inherited rewards');
  near(edge(result.book, B, C).initialCarry, 80, 'C inherits only the outstanding total across native and inherited sources');
  near(amount(result.merkl, B), 40, 'Closed B keeps exactly the reward amount it already collected');
  near(amount(result.merkl, C), 80, 'C receives B native and A inherited outstanding KAT');
  near(pending(result.merkl, C), 80, 'A new LP without native Merkl rewards can own its verified inherited balance');
  check(result.book.positions[key(B)].claims, bHistorical, 'Moving outstanding balances leaves B historical claims unchanged');
  check(result.book.positions[key(B)].frozen, bFrozen, 'Moving outstanding balances leaves B close unchanged');
  conserve(partialNative, result.merkl, [A, B, C]);
  check(view(result).cards.unclaimed_usd, .8, 'The current Live page counts the chained balance once');

  const fullClaimInput = clone(result.book);
  record(fullClaimInput, C, 80, NOW - 30, .03, false);
  const fullyClaimedNative = reading({ [A]: [100, 100], [B]: [40, 40] });
  result = await advance(fullClaimInput, fullyClaimedNative);
  near(claimed(result.book.positions[key(A)]), 20, 'A final historical reward ownership is preserved');
  near(claimed(result.book.positions[key(B)]), 40, 'B final historical reward ownership is preserved');
  near(claimed(result.book.positions[key(C)]), 80, 'Later claims from both original NFTs credit C once');
  near(pending(result.merkl, C), 0, 'Claiming the complete chained balance clears pending');
  check(result.book.positions[key(C)].claims[0].usd, 2.4, 'C claims use the actual claim price');
  conserve(fullyClaimedNative, result.merkl, [A, B, C]);
  check((await advance(result.book, fullyClaimedNative)).book, result.book, 'Full claim refresh is idempotent');

  const lateNative = reading({ [A]: [105, 100], [B]: [40, 40], [C]: [25, 0] });
  const settled = await advance(result.book, lateNative);
  near(amount(settled.merkl, C), 110, 'Late settlement on original A follows the persisted chain to C');
  near(pending(settled.merkl, C), 30, 'Late rewards plus C native rewards remain outstanding once');
  check(view(settled).live.find(P => P.id === '#' + C).apr_detail.earned_usd, .25,
    'Late inherited settlement is excluded from C APR while C native income remains included');
  conserve(lateNative, settled.merkl, [A, B, C]);

  const omitted = clone(lateNative); delete omitted.earned_tokens_by_id[A]; delete omitted.claimed_tokens_by_id[A]; delete omitted.wallet_by_id[A];
  const missing = await advance(settled.book, omitted, false);
  check(Boolean(missing.errors.merkl || missing.merkl.error), true, 'A missing previously positive source is incomplete');
  check(missing.book.positions, settled.book.positions, 'An omitted source cannot reset saved attributed balances');
  check(view(missing).live[0].comparison.available, false, 'Missing source rewards cannot produce a fresh comparison');
  check((await advance(missing.book, lateNative)).book.positions, settled.book.positions, 'Recovery restores the same complete allocation');

  for (const field of ['earned_tokens_by_id', 'claimed_tokens_by_id']) {
    const staleNative = clone(lateNative);
    staleNative[field][A][KAT] -= 1;
    const staleResult = await advance(settled.book, staleNative, false);
    check(Boolean(staleResult.errors.merkl || staleResult.merkl.error), true, 'A decreasing cached ' + field + ' amount is incomplete');
    check(staleResult.book.positions, settled.book.positions, 'An older ' + field + ' observation cannot undo a complete allocation');
    check(staleResult.book.reward_rollovers, settled.book.reward_rollovers, 'An older reward observation cannot change relationships');
  }

  const failing = await advance(settled.book, { error: true, earned_tokens_by_id: {}, claimed_tokens_by_id: {} }, false);
  check(failing.book.positions, settled.book.positions, 'A failed Merkl read preserves all saved reward/claim values');
  check(failing.book.reward_rollovers, settled.book.reward_rollovers, 'A failed Merkl read never changes established edges');

  // APR compares native accrual and removes the one-time initial carry even for
  // a position younger than the first saved observation.
  const aprBook = clone(original);
  aprBook.fee_series = [{ ts: NOW - 6 * HOUR, pos: { [key(B)]: { [KAT]: 30 } }, pp: { [key(B)]: 0 } }];
  const aprResult = await advance(aprBook, native), apr = view(aprResult).live.find(P => P.id === '#' + B).apr_detail;
  check(apr.available, true, 'A legacy native-only baseline supports APR on the effective reward basis');
  check(apr.earned_usd, .1, 'Recent APR includes only the ten newly earned native KAT');
  const markedBook = clone(aprResult.book);
  markedBook.fee_series[0].reward_attribution_version = 2;
  markedBook.fee_series[0].reward_rollover_basis = { [key(B)]: 80 };
  markedBook.fee_series[0].pos[key(B)][KAT] = 110;
  const marked = await advance(markedBook, native);
  check(view(marked).live.find(P => P.id === '#' + B).apr_detail, apr, 'A new marked sample and legacy native sample yield identical APR');
  const v1NativeBook = clone(aprResult.book);
  v1NativeBook.fee_series[0].reward_attribution_version = 1;
  const v1Native = await advance(v1NativeBook, native);
  check(view(v1Native).live.find(P => P.id === '#' + B).apr_detail, apr,
    'An older version-one observation of an unrelated future LP remains a native-only baseline');
  const lifetimeBook = clone(aprResult.book); lifetimeBook.fee_series = [];
  const lifetime = view(await advance(lifetimeBook, native)).live.find(P => P.id === '#' + B).apr_detail;
  check(lifetime.available, true, 'A complete short-lived replacement can measure lifetime native income');
  check(lifetime.earned_usd, .4, 'Lifetime APR excludes the initial inherited balance');

  // A close can wait for a replacement without an arbitrary 24-hour expiry.
  const waitingSource = close(position(A), NOW - 4 * DAY), waiting = ledger([waitingSource]);
  waitingSource.merkl[KAT] = 100; record(waiting, A, 20, waitingSource.closed_ts - 100);
  const waitingResult = await advance(waiting, reading({ [A]: [100, 20] }));
  check(waitingResult.book.reward_rollovers.length, 0, 'Without a replacement the closed LP retains its rewards');
  const beforeOpen = clone(waitingResult.book); record(beforeOpen, A, 30, NOW - 5 * HOUR, .02, false);
  const collectedBeforeOpen = await advance(beforeOpen, reading({ [A]: [100, 50] }));
  near(claimed(collectedBeforeOpen.book.positions[key(A)]), 50, 'Rewards collected while waiting remain with the closed LP');
  const replacedLate = clone(collectedBeforeOpen.book); replacedLate.positions[key(B)] = opened(B, NOW - HOUR);
  delete replacedLate.reward_rollover_anchor; // The preceding claims are now in the committed snapshot.
  const lateReplacement = await advance(replacedLate, reading({ [A]: [100, 50] }));
  near(edge(lateReplacement.book, A, B).claimedBefore, 50, 'Already collected rewards stay with their owner at first complete replacement verification');
  near(edge(lateReplacement.book, A, B).initialCarry, 50, 'Only the still-unclaimed portion rolls after a multi-day wait');
  near(pending(lateReplacement.merkl, B), 50, 'A replacement after several days still receives outstanding KAT');

  const allAtOnce = ledger([close(position(A), NOW - 10 * HOUR),
    close(opened(B, NOW - 10 * HOUR + 100), NOW - 2 * HOUR), opened(C, NOW - 2 * HOUR + 100)]);
  record(allAtOnce, A, 20, NOW - 10 * HOUR - 100, .005);
  record(allAtOnce, B, 10, NOW - 8 * HOUR);
  const samePassChain = await advance(allAtOnce, native);
  check(samePassChain.book.reward_rollovers.map(r => [r.source, r.target]), [[A, B], [B, C]],
    'One catch-up pass reconstructs the same canonical intermediate LPs as separate warm reads');
  near(amount(samePassChain.merkl, A), 20, 'Same-pass A keeps already claimed rewards');
  near(amount(samePassChain.merkl, B), 10, 'Same-pass B keeps already claimed rewards');
  near(pending(samePassChain.merkl, C), 110, 'Same-pass C receives all outstanding native and inherited rewards once');
  conserve(native, samePassChain.merkl, [A, B, C]);

  const samePass = clone(waitingResult.book); samePass.positions[key(B)] = opened(B, NOW - HOUR);
  record(samePass, A, 30, NOW - 30, .02, false);
  const samePassResult = await advance(samePass, reading({ [A]: [100, 50] }));
  near(claimed(samePassResult.book.positions[key(A)]), 20, 'A post-opening claim follows the replacement even when both are discovered in one catch-up pass');
  near(edge(samePassResult.book, A, B).initialCarry, 80, 'The immutable replacement carry is the same in warm and cold discovery');
  near(claimed(samePassResult.book.positions[key(B)]), 30, 'The actual post-opening claim is credited to the replacement once');
  near(pending(samePassResult.merkl, B), 50, 'The post-opening claim reduces only the replacement pending portion');

  const preOpening = clone(waitingResult.book), replacementTime = NOW - HOUR;
  preOpening.positions[key(B)] = opened(B, replacementTime);
  record(preOpening, A, 30, replacementTime - 30, .02, false);
  const preOpeningRaw = reading({ [A]: [100, 50] });
  const preOpeningResult = await advance(preOpening, preOpeningRaw, false);
  check(Boolean(preOpeningResult.errors['Katana reward rollover']), true,
    'An API read defers a replacement when an unprocessed pre-opening wallet claim makes the immutable cutoff ambiguous');
  check(preOpeningResult.book.reward_rollovers.length, 0, 'An ambiguous pre-opening claim never creates a provisional rollover edge');
  const persistedPreOpening = await advanceBook(preOpening, { merkl: preOpeningRaw, maxWindows: 0, persistRollovers: true });
  check(persistedPreOpening.errors, {}, 'The scheduled durable pass can resolve and persist the conservative current claim boundary');
  near(claimed(persistedPreOpening.book.positions[key(A)]), 50, 'A pre-opening claim retains its source owner in the durable ledger');
  near(edge(persistedPreOpening.book, A, B).claimedBefore, 50, 'The durable rollover boundary includes already collected ambiguous rewards');
  near(pending(persistedPreOpening.merkl, B), 50, 'Pre-opening collected rewards are excluded from the new LP pending balance');

  const preferred = ledger([close(position(A), NOW - 5 * HOUR), opened(B, NOW - 4 * HOUR), opened(C, NOW - 4 * HOUR, { pool: OTHER_POOL })]);
  const preferredResult = await advance(preferred, reading({ [A]: [100, 0], [B]: [0, 0], [C]: [0, 0] }));
  check(Boolean(edge(preferredResult.book, A, B)), true, 'A same-pool replacement takes precedence over another pool');
  near(amount(preferredResult.merkl, C), 0, 'Another open pool does not receive the same balance');
  const differentPool = ledger([close(position(A), NOW - 5 * HOUR), opened(B, NOW - 4 * HOUR, { pool: OTHER_POOL })]);
  check(Boolean(edge((await advance(differentPool, reading({ [A]: [100, 0], [B]: [0, 0] }))).book, A, B)), true,
    'A new Katana replacement with the same token pair can receive rewards when the pool changes');
  const differentPair = clone(original);
  Object.assign(differentPair.positions[key(B)], { pair: 'vbWBTC / vbUSDT', pool: OTHER_POOL,
    t1: 'vbUSDT@katana', s1: 'vbUSDT' });
  differentPair.tokens['vbUSDT@katana'] = { s: 'vbUSDT' };
  differentPair.fee_series = [{ ts: NOW - 6 * HOUR, pos: { [key(B)]: { [KAT]: 30 } }, pp: { [key(B)]: 0 } }];
  const differentPairResult = await advance(differentPair, native);
  check(Boolean(edge(differentPairResult.book, A, B)), true, 'A new Katana token pair in the same wallet inherits the outstanding KAT');
  near(pending(differentPairResult.merkl, A), 0, 'The old token pair no longer owns the transferred outstanding balance');
  near(amount(differentPairResult.merkl, B), 120, 'The different-pair LP owns its native earnings plus the inherited balance');
  near(pending(differentPairResult.merkl, B), 110, 'The different-pair LP pending balance counts native and inherited KAT once');
  check(differentPairResult.book.positions[key(A)].claims, savedAClaims, 'Changing token pair preserves the old LP dated claims');
  check(differentPairResult.book.positions[key(A)].frozen, savedAFrozen, 'Changing token pair preserves historical principal and prices');
  conserve(native, differentPairResult.merkl, [A, B]);
  const differentPairView = view(differentPairResult), pairCard = differentPairView.live.find(p => p.id === '#' + B);
  check(pairCard.yield_value, '$1.20', 'The actual different-pair card displays all attributed earnings');
  check(pairCard.comparison.earned_usd, 1.2, 'The different-pair holding comparison agrees with the card');
  check(pairCard.apr_detail.available, true, 'A different-pair LP retains its verified native earning interval');
  check(pairCard.apr_detail.earned_usd, .1, 'Changing pair does not turn inherited KAT into new APR income');
  near(pairCard.apr_detail.pct, apr.pct, 'Same-pair and different-pair LPs with the same native accrual have the same APR');
  const persistedDifferentPair = await advance(JSON.parse(JSON.stringify(differentPairResult.book)), native);
  check(persistedDifferentPair.book.reward_rollovers, differentPairResult.book.reward_rollovers,
    'A serialized cross-pair relationship remains valid on a cold API read');
  check(persistedDifferentPair.merkl.earned_tokens_by_id, differentPairResult.merkl.earned_tokens_by_id,
    'A cold read retains the same cross-pair earned ownership');

  const crossClaimInput = clone(differentPairResult.book);
  record(crossClaimInput, B, 30, NOW - 3 * HOUR, .02, false);
  const crossPartial = await advance(crossClaimInput, partialNative);
  near(claimed(crossPartial.book.positions[key(A)]), 20, 'A partial inherited claim keeps the old-pair claims unchanged');
  near(claimed(crossPartial.book.positions[key(B)]), 40, 'The different-pair LP owns later inherited claims together with native claims');
  near(pending(crossPartial.merkl, B), 80, 'A cross-pair partial claim reduces pending exactly once');
  const crossNextInput = clone(crossPartial.book);
  delete crossNextInput.reward_rollover_anchor; // The preceding claims are now committed.
  close(crossNextInput.positions[key(B)], NOW - 2 * HOUR);
  crossNextInput.positions[key(C)] = opened(C, NOW - 2 * HOUR + 100,
    { pair: 'vbWBTC / USDT', pool: '0x2222222222222222222222222222222222222222', t1: 'USDT@katana', s1: 'USDT' });
  crossNextInput.tokens['USDT@katana'] = { s: 'USDT' };
  const crossNext = await advance(crossNextInput, partialNative);
  check(crossNext.book.reward_rollovers.map(r => [r.source, r.target]), [[A, B], [B, C]],
    'Successive new token pairs keep the complete inherited reward chain');
  near(pending(crossNext.merkl, C), 80, 'A third token pair inherits both older sources outstanding KAT');
  const crossNextApr = view(crossNext).live.find(p => p.id === '#' + C).apr_detail;
  check(crossNextApr.available, true, 'The latest different-pair LP can report its own native lifetime APR');
  check(crossNextApr.earned_usd, 0, 'A new pair with only inherited rewards does not report fresh APR income');
  const crossFullInput = clone(crossNext.book);
  record(crossFullInput, C, 80, NOW - 30, .03, false);
  const crossFull = await advance(crossFullInput, fullyClaimedNative);
  near(claimed(crossFull.book.positions[key(A)]), 20, 'A full cross-pair claim preserves the first LP historical claim amount');
  near(claimed(crossFull.book.positions[key(B)]), 40, 'A full cross-pair claim preserves the intermediate LP historical claim amount');
  near(claimed(crossFull.book.positions[key(C)]), 80, 'The final different-pair LP receives the eventual full inherited claim');
  near(pending(crossFull.merkl, C), 0, 'Fully claiming a cross-pair rollover clears its pending balance');
  check(crossFull.book.positions[key(C)].claims[0].usd, 2.4, 'A cross-pair inherited claim keeps its actual claim-time price');
  conserve(fullyClaimedNative, crossFull.merkl, [A, B, C]);

  const pairLaterWarmInput = clone(differentPairResult.book);
  pairLaterWarmInput.positions[key(C)] = opened(C, NOW - 9 * HOUR);
  const pairLaterColdInput = clone(differentPair);
  pairLaterColdInput.positions[key(C)] = clone(pairLaterWarmInput.positions[key(C)]);
  const pairLaterNative = reading({ [A]: [100, 20], [B]: [40, 10], [C]: [0, 0] });
  const pairLaterWarm = await advance(pairLaterWarmInput, pairLaterNative);
  const pairLaterCold = await advance(pairLaterColdInput, pairLaterNative);
  check(Boolean(edge(pairLaterCold.book, A, B)), true, 'An earlier different-pair successor wins over a later LP matching the old pair');
  check(pairLaterCold.book.reward_rollovers, pairLaterWarm.book.reward_rollovers,
    'A later original-pair mint cannot change cross-pair ownership after a cold restart');
  near(amount(pairLaterCold.merkl, C), 0, 'A later original-pair LP does not duplicate already attributed KAT');
  const reversedPair = ledger([close(position(A), NOW - 5 * HOUR), opened(B, NOW - 4 * HOUR,
    { t0: 'vbUSDC@katana', t1: 'vbWBTC@katana', s0: 'vbUSDC', s1: 'vbWBTC' })]);
  check(Boolean(edge((await advance(reversedPair, reading({ [A]: [100, 0], [B]: [0, 0] }))).book, A, B)), true,
    'Token ordering does not change the identity of the replacement pair');

  const ambiguous = ledger([close(position(A), NOW - 5 * HOUR), opened(B, NOW - 4 * HOUR), opened(C, NOW - 4 * HOUR)]);
  const ambiguity = await advance(ambiguous, reading({ [A]: [100, 0], [B]: [0, 0], [C]: [0, 0] }), false);
  check(typeof ambiguity.errors['Katana reward rollover'], 'string', 'An ambiguous replacement is reported instead of silently selecting one');
  check(ambiguity.book.reward_rollovers.length, 0, 'Two equally eligible replacements cannot receive an arbitrary allocation');
  near(amount(ambiguity.merkl, A), 100, 'An ambiguous match retains source rewards until resolved');
  const wrongWallet = ledger([close(position(A), NOW - 5 * HOUR), opened(B, NOW - 4 * HOUR, { wallet: W2 })]);
  const walletResult = await advance(wrongWallet, reading({ [A]: [100, 0], [B]: [0, 0] }, { [B]: W2 }));
  check(walletResult.book.reward_rollovers.length, 0, 'A replacement in another wallet never inherits rewards');
  const wrongChain = ledger([close(position(A), NOW - 5 * HOUR), opened(B, NOW - 4 * HOUR, { chain: 'robinhood', key: 'robinhood:' + B })]);
  const chainResult = await advance(wrongChain, reading({ [A]: [100, 0] }));
  check(chainResult.book.reward_rollovers.length, 0, 'A replacement on another chain never inherits Katana rewards');

  const beforeClose = ledger([close(position(A), NOW - 5 * HOUR), opened(B, NOW - 5 * HOUR - 600)]);
  check(Boolean(edge((await advance(beforeClose, reading({ [A]: [100, 0], [B]: [0, 0] }))).book, A, B)), true,
    'A verified replacement minted shortly before closing the old LP is supported');
  const beforeNative = reading({ [A]: [100, 0], [B]: [0, 0] });
  const beforeWarm = await advance(beforeClose, beforeNative), beforeLater = clone(beforeWarm.book);
  beforeLater.positions[key(C)] = opened(C, NOW - 5 * HOUR + 1);
  const beforeLaterNative = reading({ [A]: [100, 0], [B]: [0, 0], [C]: [0, 0] });
  const beforeWarmLater = await advance(beforeLater, beforeLaterNative), beforeColdInput = clone(beforeClose);
  beforeColdInput.positions[key(C)] = clone(beforeLater.positions[key(C)]);
  const beforeCold = await advance(beforeColdInput, beforeLaterNative);
  check(Boolean(edge(beforeCold.book, A, B)), true,
    'A later closer post-close mint cannot replace the canonical pre-close successor in a cold read');
  check(beforeCold.book.reward_rollovers, beforeWarmLater.book.reward_rollovers,
    'Warm and cold reads preserve the same pre-close replacement identity');
  near(amount(beforeCold.merkl, B), 100, 'The earlier verified pre-close successor retains its inherited balance');
  near(amount(beforeCold.merkl, C), 0, 'A later closer post-close LP cannot receive the same balance');

  const earlierDifferentPool = ledger([close(position(A), NOW - 5 * HOUR),
    opened(B, NOW - 4 * HOUR, { pool: OTHER_POOL })]);
  const poolWarm = await advance(earlierDifferentPool, beforeNative), poolLater = clone(poolWarm.book);
  poolLater.positions[key(C)] = opened(C, NOW - 3 * HOUR);
  const poolColdInput = clone(earlierDifferentPool); poolColdInput.positions[key(C)] = clone(poolLater.positions[key(C)]);
  const poolWarmLater = await advance(poolLater, beforeLaterNative), poolCold = await advance(poolColdInput, beforeLaterNative);
  check(Boolean(edge(poolCold.book, A, B)), true,
    'A later exact-pool mint cannot replace the earlier post-close successor with the same token pair');
  check(poolCold.book.reward_rollovers, poolWarmLater.book.reward_rollovers,
    'Pool preference cannot change replacement identity between warm and cold reads');
  near(amount(poolCold.merkl, B), 100, 'The first same-pair post-close LP keeps its carry when a later exact-pool LP appears');
  near(amount(poolCold.merkl, C), 0, 'The later exact-pool LP does not duplicate inherited KAT');
  const oldExisting = ledger([close(position(A), NOW - 5 * HOUR), opened(B, NOW - 3 * DAY)]);
  check((await advance(oldExisting, reading({ [A]: [100, 0], [B]: [0, 0] }))).book.reward_rollovers.length, 0,
    'An unrelated longstanding open LP is not assumed to be the replacement');

  // Two replacements and an intermediate claim can all happen before the next
  // scheduled writer. A cold writer must reconstruct the same claim owners.
  const rapidBase = clone(coldResult.book);
  delete rapidBase.reward_rollover_anchor; // The A→B allocation and B's earlier claim are committed.
  const rapidBClosed = clone(rapidBase), rapidBClose = NOW - 2 * HOUR;
  close(rapidBClosed.positions[key(B)], rapidBClose);
  rapidBClosed.positions[key(C)] = opened(C, rapidBClose + 100);
  const rapidC = await advance(rapidBClosed, partialNative);
  const rapidCClaimInput = clone(rapidC.book), rapidClaimTime = NOW - HOUR;
  record(rapidCClaimInput, C, 10, rapidClaimTime, .03, false);
  const rapidClaimRaw = reading({ [A]: [100, 60], [B]: [40, 10] });
  const rapidClaimed = await advance(rapidCClaimInput, rapidClaimRaw);
  near(claimed(rapidClaimed.book.positions[key(C)]), 10, 'The intermediate current LP records its actual claim before the next close');
  const rapidDInput = clone(rapidClaimed.book), rapidCClose = NOW - 1800;
  close(rapidDInput.positions[key(C)], rapidCClose);
  rapidDInput.positions[key(D)] = opened(D, rapidCClose + 100);
  const rapidDeferred = await advance(rapidDInput, rapidClaimRaw, false);
  check(Boolean(rapidDeferred.errors['Katana reward rollover']), true,
    'A second warm rollover with an uncommitted earlier claim waits for a durable boundary');
  near(claimed(rapidDeferred.book.positions[key(C)]), 10, 'Deferral cannot move or erase the intermediate LP claim');
  const rapidWarmWriter = await advanceBook(rapidDInput,
    { merkl: rapidClaimRaw, maxWindows: 0, persistRollovers: true });
  check(rapidWarmWriter.errors, {}, 'A durable writer completes the rapid warm transition');

  const rapidColdInput = clone(rapidBase);
  close(rapidColdInput.positions[key(B)], rapidBClose);
  rapidColdInput.positions[key(C)] = close(opened(C, rapidBClose + 100), rapidCClose);
  rapidColdInput.positions[key(D)] = opened(D, rapidCClose + 100);
  record(rapidColdInput, C, 10, rapidClaimTime, .03, false);
  const rapidColdWriter = await advanceBook(rapidColdInput,
    { merkl: rapidClaimRaw, maxWindows: 0, persistRollovers: true });
  check(rapidColdWriter.errors, {}, 'A cold writer reconstructs both rapid replacements from the original committed snapshot');
  check(rapidColdWriter.book.reward_rollovers.map(r => [r.source, r.target]), [[A, B], [B, C], [C, D]],
    'A cold writer preserves every canonical intermediate LP in topological order');
  for (const id of [A, B, C, D]) {
    check(rapidColdWriter.book.positions[key(id)].claims, rapidWarmWriter.book.positions[key(id)].claims,
      'Warm and cold writers retain identical dated claim ownership for LP ' + id);
    near(amount(rapidColdWriter.merkl, id), amount(rapidWarmWriter.merkl, id),
      'Warm and cold writers retain identical earned ownership for LP ' + id);
    near(amount(rapidColdWriter.merkl, id, 'claimed_tokens_by_id'), amount(rapidWarmWriter.merkl, id, 'claimed_tokens_by_id'),
      'Warm and cold writers retain identical claimed ownership for LP ' + id);
  }
  near(claimed(rapidColdWriter.book.positions[key(C)]), 10, 'The final cold ledger preserves C claim at its original amount');
  check(rapidColdWriter.book.positions[key(C)].claims[0].usd, .3, 'The intermediate claim retains its actual price across cold reconstruction');
  near(pending(rapidColdWriter.merkl, D), 70, 'Only the remaining unclaimed balance reaches the newest LP');
  conserve(rapidClaimRaw, rapidColdWriter.merkl, [A, B, C, D]);

  const failurePair = ledger([close(position(A), NOW - 5 * HOUR), opened(B, NOW - 4 * HOUR)]);
  failKatana = true;
  const failedDiscovery = await advance(failurePair, reading({ [A]: [100, 0], [B]: [0, 0] }), false);
  check(typeof failedDiscovery.errors.katana, 'string', 'A failed Katana scan is visible');
  check(failedDiscovery.book.reward_rollovers.length, 0, 'A failed lifecycle read cannot authorize a new rollover');
  failKatana = false;
  check(Boolean(edge((await advance(failedDiscovery.book, reading({ [A]: [100, 0], [B]: [0, 0] }))).book, A, B)), true,
    'Complete lifecycle recovery can register the waiting rollover');
  head = 101;
  const behind = await advance(failurePair, reading({ [A]: [100, 0], [B]: [0, 0] }), false);
  check(behind.behind.katana, 1, 'The fixture exposes an actual unfinished lifecycle backlog');
  check(behind.book.reward_rollovers.length, 0, 'A positive Katana backlog cannot authorize a new rollover');
  head = 100;

  const malformedNew = reading({ [A]: [100, 0] });
  malformedNew.claimed_tokens_by_id[B] = { [KAT]: 5 };
  malformedNew.wallet_by_id[B] = W;
  const malformedResult = await advance(failurePair, malformedNew, false);
  check(Boolean(malformedResult.errors.merkl || malformedResult.merkl.error), true,
    'A new position with a half-present positive claim counter is incomplete rather than verified native zero');
  check(malformedResult.book.reward_rollovers.length, 0, 'A malformed new native counter cannot authorize a transfer');

  const zeroPair = ledger([close(position(A), NOW - 5 * HOUR), opened(B, NOW - 4 * HOUR)]);
  record(zeroPair, A, 100, NOW - 6 * HOUR);
  const zero = await advance(zeroPair, reading({ [A]: [100, 100], [B]: [0, 0] }));
  const lateZero = await advance(zero.book, reading({ [A]: [105, 100], [B]: [0, 0] }));
  near(pending(lateZero.merkl, B), 5, 'Delayed settlement follows the replacement even when no reward was outstanding at close');

  // Execute the actual scheduled-job function against a temporary workspace.
  // Its chain dependencies are controlled; no repository ledger is written.
  const workspace = mkdtempSync(join(tmpdir(), 'tiger-rollover-job-'));
  try {
    writeFileSync(join(workspace, 'lpbook.json'), JSON.stringify(differentPair));
    writeFileSync(join(workspace, 'positions.json'), '{}');
    writeFileSync(join(workspace, 'data.json'), '{}');
    let cronReading = native;
    const cronSource = readFileSync(new URL('./lpbook.mjs', import.meta.url), 'utf8')
      .replace(/^import[^\n]*\n/gm, '')
      .replace('export async function updateLpBook', 'async function updateLpBook')
      .split('/* run directly:')[0];
    const update = vm.runInNewContext(cronSource + '\nupdateLpBook;', {
      CFG: {}, readFileSync, writeFileSync, join, Date,
      console: { log() {} }, merklLp: async () => clone(cronReading), advanceBook,
      bookLiveRows: async book => ({ rows: rows(book), errors: {} }),
      feeTotals, bookPnl: () => 0, positionFees, positionAprObservation, BOOK_VERSION,
      startBook: async () => { throw new Error('A valid temporary ledger must not be rebuilt'); },
    }, { filename: 'scheduled-rollover-check.mjs' });
    await update(workspace);
    const saved = JSON.parse(readFileSync(join(workspace, 'lpbook.json')));
    check(saved.reward_rollover_anchor, undefined, 'The scheduled writer never commits a stale runtime-only claim anchor');
    check(Boolean(edge(saved, A, B)), true, 'The actual scheduled job persists a cross-pair rollover edge');
    check(saved.positions[key(B)].t1, 'vbUSDT@katana', 'The scheduled target retains its new token-pair identity');
    check(saved.fee_series.at(-1).reward_attribution_version, 2, 'The actual job marks the effective observation basis');
    check(saved.fee_series.at(-1).reward_rollover_basis[key(B)], 80, 'The job persists the initial carry basis with the sample');
    near(saved.fee_series.at(-1).pos[key(B)][KAT], 120, 'The job sample contains attributed earnings rather than raw native income');
    check(saved.fee_series.slice(0, differentPair.fee_series.length), differentPair.fee_series, 'The scheduled job preserves prior earning observations');
    const reloaded = await advance(saved, native);
    near(amount(reloaded.merkl, B), 120, 'A cold API read of a cron snapshot retains the same attributed earnings');
    check(reloaded.book.reward_rollovers, saved.reward_rollovers, 'A cron snapshot and API read use the same persisted rollover ledger');
    const pointsBeforeFailure = saved.fee_series.length;
    cronReading = clone(native);
    delete cronReading.earned_tokens_by_id[A]; delete cronReading.claimed_tokens_by_id[A]; delete cronReading.wallet_by_id[A];
    await update(workspace);
    const failedSaved = JSON.parse(readFileSync(join(workspace, 'lpbook.json')));
    check(failedSaved.fee_series.length, pointsBeforeFailure, 'An incomplete effective allocation cannot append a misleading cron APR sample');
    check(failedSaved.reward_rollovers, saved.reward_rollovers, 'A failed scheduled attribution retains the saved relationships');
    check(failedSaved.positions, saved.positions, 'A failed scheduled attribution retains saved reward and claim values');
  } finally { rmSync(workspace, { recursive: true, force: true }); }

  check(cursorReads > 0, true, 'All integrated scenarios exercise real per-chain cursor reads');
  console.log('PASS automatic reward rollover: ' + checks + ' assertions');
} finally {
  globalThis.fetch = realFetch; Date.now = realNow;
  V3.forEach((ch, i) => { ch.rpc = realRpcs[i]; });
}
