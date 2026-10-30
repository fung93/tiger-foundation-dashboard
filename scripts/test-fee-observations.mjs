/* Healthy positions keep real APR observations when another chain cannot finish.
   Run both the observation filter and the scheduled writer without any RPC access. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { positionFees, bookView } from '../api/_core.mjs';
import { positionAprObservation } from '../api/_fee-observations.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const NOW = 1900000000, HOUR = 3600, WALLET = '0x1111111111111111111111111111111111111111';
const KAT = 'KAT@katana', BTC = 'vbWBTC@katana', USDC = 'vbUSDC@katana';
const ETH = 'WETH@robinhood', USDG = 'USDG@robinhood';
function fixture() {
  const common = { wallet: WALLET, status: 'open', opened_ts: NOW - 24 * HOUR,
    cost_usd: 120, out_usd: 0, fees: {}, start_uncollected: {}, start_merkl: {},
    withdrawals: [], claims: [], at_start: false };
  const kat = { ...common, key: 'katana:42', chain: 'katana', id: '42',
    t0: BTC, t1: USDC, s0: 'vbWBTC', s1: 'vbUSDC', merkl: { [KAT]: 100 },
    deposits: [{ ts: common.opened_ts, a0: 10, a1: 80, usd: 100 },
      { ts: NOW - 6 * HOUR, a0: 2, a1: 16, usd: 20 }] };
  const rh = { ...common, key: 'robinhood:43', chain: 'robinhood', id: '43',
    t0: ETH, t1: USDG, s0: 'WETH', s1: 'USDG', fees: { [ETH]: 2, [USDG]: 3 },
    start_uncollected: { [ETH]: .2, [USDG]: 1 },
    deposits: [{ ts: common.opened_ts, a0: 10, a1: 100, usd: 120 }] };
  const row = P => ({ id: P.id, wallet: P.wallet, chain: P.chain, liquidity_usd: 125,
    pair: P.s0 + ' / ' + P.s1, held_days: 1, pnl_usd: null, il_usd: null, in_range: true,
    range: { now: 1, lower: .5, upper: 2, position_pct: 50, to_lower_pct: 50, to_upper_pct: 100, width_pct: 150 },
    value_usd: 125, raw: { fee0: .1, fee1: 4,
      sqrt: String(1n << 96n), t0: { s: P.s0, d: 0 }, t1: { s: P.s1, d: 0, stable: true } } });
  const book = { version: 9, started: { ts: NOW - 48 * HOUR, iso: new Date((NOW - 48 * HOUR) * 1000).toISOString() }, wallets: [WALLET], events: [],
    positions: { [kat.key]: kat, [rh.key]: rh }, tokens: {},
    fee_series: [{ ts: NOW - 12 * HOUR, tokens: { [KAT]: 50 }, pnl_usd: 3, pos: {}, pp: {} }] };
  for (const [key, s] of [[BTC, 'vbWBTC'], [USDC, 'vbUSDC'], [ETH, 'WETH'], [USDG, 'USDG'], [KAT, 'KAT']]) book.tokens[key] = { s };
  return { book, kat, rh, rows: { [kat.key]: row(kat), [rh.key]: row(rh) },
    merkl: { earned_tokens_by_id: { [kat.id]: { [KAT]: 100 } }, earned_by_id: { [kat.id]: 100 },
      reward_attribution_version: 2, reward_rollover_basis: { [kat.key]: 20 } },
    errors: {}, behind: { katana: 0, robinhood: 0 }, ts: NOW };
}
const observe = f => positionAprObservation(f.book, { ...f, fees: positionFees(f.book, f.rows) });
const noNetwork = globalThis.fetch;
globalThis.fetch = () => { throw new Error('APR observation tests must not access the network'); };
const originalNow = Date.now;
try {
  let f = fixture(), observation = observe(f);
  check(Object.keys(observation.pos), [f.kat.key, f.rh.key], 'A complete reading observes both positions');
  check(observation.pos[f.kat.key], { [KAT]: 100 }, 'Katana saves only owned KAT rewards, excluding DAO trading fees');
  check(observation.pos[f.rh.key], { [ETH]: 1.9, [USDG]: 6 }, 'Trading fee baseline includes collected plus unclaimed, less initial fees');
  check(observation.pp, { [f.kat.key]: 5, [f.rh.key]: 5 }, 'Each accepted baseline includes its own complete principal PnL');
  check(observation.ts, NOW, 'The reading keeps its actual completion time');
  check('tokens' in observation || 'pnl_usd' in observation, false, 'Position samples never fabricate aggregate fee or PnL totals');
  check(observation.reward_rollover_basis, { [f.kat.key]: 20 }, 'A sample retains the carry basis for future APR normalization');
  observation.reward_rollover_basis[f.kat.key] = 999;
  check(f.merkl.reward_rollover_basis[f.kat.key], 20, 'The saved carry metadata is not a mutable reference to the reading');

  for (const error of ['robinhood', 'robinhood (live)', 'Robinhood history']) {
    f = fixture(); f.errors[error] = 'logs matched by query exceeds limit of 10000';
    observation = observe(f);
    check(Object.keys(observation.pos), [f.kat.key], error + ' does not block verified Katana earnings');
  }
  f = fixture(); f.errors.merkl = 'rewards unavailable';
  check(Object.keys(observe(f).pos), [f.rh.key], 'A Merkl failure does not block Robinhood fee observations');
  f = fixture(); f.merkl.error = true;
  check(Object.keys(observe(f).pos), [f.rh.key], 'An error-marked Merkl response cannot save retained Katana rewards');
  f = fixture(); f.errors['Katana reward rollover'] = 'replacement uncertain';
  check(Object.keys(observe(f).pos), [f.rh.key], 'Uncertain KAT ownership cannot enter an APR baseline');
  f = fixture(); f.errors.wallets = 'new wallet history unavailable';
  check(observe(f), null, 'An incomplete wallet history cannot create observations for either chain');

  for (const [note, mutate] of [
    ['chain backlog', f => { f.behind.katana = 1; }],
    ['missing scan confirmation', f => { delete f.behind.katana; }],
    ['missing live principal', f => { delete f.rows[f.kat.key]; }],
    ['retained stale row', f => { f.rows[f.kat.key].stale = true; }],
    ['incomplete row', f => { f.rows[f.kat.key].incomplete = true; }],
    ['failed row', f => { f.rows[f.kat.key].error = 'failed'; }],
    ['invalid principal', f => { f.rows[f.kat.key].liquidity_usd = NaN; }],
    ['negative principal', f => { f.rows[f.kat.key].liquidity_usd = -1; }],
    ['wrong live wallet', f => { f.rows[f.kat.key].wallet = '0x2'; }],
    ['missing fresh reward', f => { delete f.merkl.earned_tokens_by_id[f.kat.id]; }],
    ['invalid fresh reward', f => { f.merkl.earned_tokens_by_id[f.kat.id][KAT] = NaN; }],
    ['negative reward hidden by positive filter', f => { f.kat.merkl[KAT] = -1; f.merkl.earned_tokens_by_id[f.kat.id][KAT] = -1; }],
    ['retained earlier reward balance', f => { f.kat.merkl[KAT] = 90; }],
    ['invalid initial reward', f => { f.kat.start_merkl[KAT] = NaN; }],
    ['rewards below tracking baseline', f => { f.kat.start_merkl[KAT] = 110; }],
    ['invalid carried reward metadata', f => { f.merkl.reward_rollover_basis[f.kat.key] = -1; }],
  ]) {
    f = fixture(); mutate(f);
    check(Object.keys(observe(f).pos), [f.rh.key], note + ' is excluded without suppressing healthy Robinhood earnings');
  }
  for (const [note, mutate] of [
    ['failed collected fee', f => { f.rh.fees[ETH] = NaN; }],
    ['negative collected fee', f => { f.rh.fees[ETH] = -1; }],
    ['missing raw fees', f => { delete f.rows[f.rh.key].raw; }],
    ['negative unclaimed fee', f => { f.rows[f.rh.key].raw.fee0 = -1; }],
    ['unreadable unclaimed fee', f => { f.rows[f.rh.key].raw.fee1 = undefined; }],
    ['fees below initial baseline', f => { f.rh.start_uncollected[ETH] = 3; }],
  ]) {
    f = fixture(); mutate(f);
    check(Object.keys(observe(f).pos), [f.kat.key], note + ' cannot enter a saved APR baseline');
  }
  f = fixture(); f.kat.merkl = {}; f.merkl.earned_tokens_by_id[f.kat.id] = {};
  check(observe(f).pos[f.kat.key], {}, 'An explicitly verified zero reward reading can be recorded');
  f = fixture(); f.rows[f.rh.key].liquidity_usd = 0;
  check(observe(f).pp[f.rh.key], -120, 'A verified zero principal is distinct from a missing reading');
  f = fixture(); f.kat.status = 'closed';
  check(Object.keys(observe(f).pos), [f.rh.key], 'Closed positions do not acquire live APR observations');
  f = fixture(); f.ts = NaN;
  check(observe(f), null, 'A missing source time cannot create a saved reading');

  // Exercise the real scheduled writer with local source files and deterministic reads.
  // Only its remote reader import is substituted; serialization and save branching run unchanged.
  const root = mkdtempSync(join(tmpdir(), 'tiger-apr-observations-'));
  const fixtureKey = '__tigerFeeObservationFixture';
  let state;
  const core = {
    CFG: {}, BOOK_VERSION: 9, positionFees,
    merklLp: async () => state.merkl,
    startBook: async () => { throw new Error('An existing book must never be rebuilt'); },
    advanceBook: async book => ({ book, errors: state.errors, behind: state.behind, merkl: state.merkl }),
    bookLiveRows: async () => { Date.now = () => (NOW + 60) * 1000; return { rows: state.rows, errors: state.liveErrors || {} }; },
    feeTotals: () => ({ [KAT]: 50, [ETH]: 2 }), bookPnl: () => 10,
  };
  globalThis[fixtureKey] = core;
  const writerURL = new URL('./lpbook.mjs', import.meta.url);
  const writerSource = readFileSync(writerURL, 'utf8')
    .replace(/import \{ CFG, startBook, advanceBook, merklLp, bookLiveRows, feeTotals, bookPnl, positionFees, BOOK_VERSION \} from '\.\.\/api\/_core\.mjs';/,
      `const { CFG, startBook, advanceBook, merklLp, bookLiveRows, feeTotals, bookPnl, positionFees, BOOK_VERSION } = globalThis.${fixtureKey};`)
    .replace("'../api/_fee-observations.mjs'", JSON.stringify(new URL('../api/_fee-observations.mjs', import.meta.url).href));
  const fixtureWriter = join(root, 'fixture-writer.mjs');
  writeFileSync(fixtureWriter, writerSource);
  const { updateLpBook } = await import(pathToFileURL(fixtureWriter).href);
  const run = async next => {
    state = next;
    Date.now = () => NOW * 1000;
    writeFileSync(join(root, 'lpbook.json'), JSON.stringify(state.book));
    writeFileSync(join(root, 'positions.json'), '{}');
    writeFileSync(join(root, 'data.json'), '{}');
    await updateLpBook(root);
    return JSON.parse(readFileSync(join(root, 'lpbook.json'), 'utf8'));
  };
  try {
    f = fixture(); f.errors.robinhood = 'logs matched by query exceeds limit of 10000';
    let saved = await run(f);
    check(saved.fee_series, f.book.fee_series, 'A failed Robinhood pass never appends or rewrites aggregate history');
    check(Object.keys(saved.apr_series[0].pos), [f.kat.key], 'The writer persists the healthy Katana APR observation independently');
    check(saved.apr_series[0].ts, NOW + 60, 'A scheduled read is dated after completion rather than before a potentially long scan');
    check(saved.runs.at(-1).errors, f.errors, 'The saved run keeps the Robinhood warning');
    check('tokens' in saved.apr_series[0] || 'pnl_usd' in saved.apr_series[0], false, 'The serialized partial observation cannot masquerade as a full chart point');
    check(saved.apr_series[0].reward_rollover_basis[f.kat.key], 20, 'The scheduled sample preserves the carried KAT normalization basis');

    const initialSample = structuredClone(saved.apr_series[0]);
    state = fixture(); state.book = saved; state.rows[state.kat.key].liquidity_usd = 127;
    state.book.positions[state.kat.key].merkl[KAT] = 110;
    state.book.reward_rollover_basis = { [state.kat.key]: 25 };
    state.merkl.earned_tokens_by_id[state.kat.id][KAT] = 110;
    Date.now = () => (NOW + 60 + 4 * HOUR) * 1000;
    const view = bookView(state.book, { rows: state.rows, prices: { [KAT]: 1, [BTC]: 2, [USDC]: 1, [ETH]: 1, [USDG]: 1 },
      merkl: state.merkl, errors: { robinhood: 'temporarily unavailable' }, behind: state.behind });
    const katView = view.live.find(p => p.id === '#' + state.kat.id);
    check(katView.apr_detail.available, true, 'The independently saved Katana sample restores APR once its measurement interval is old enough');
    check(katView.apr_detail.earned_usd, 5, 'Recovered APR counts only the five newly accrued KAT, excluding inherited rewards');
    check(katView.apr_detail.elapsed_hours, 4, 'Recovered APR states the exact post-top-up observation interval');
    check(state.book.apr_series[0], initialSample, 'Reading APR never rewrites the saved observation or its original carry basis');

    f = fixture(); f.liveErrors = { robinhood: 'live read failed' };
    saved = await run(f);
    check(Object.keys(saved.apr_series[0].pos), [f.kat.key], 'A live Robinhood failure also preserves valid Katana observations');
    check(saved.fee_series.length, f.book.fee_series.length, 'Failed live fee totals do not create a chart drop');

    f = fixture(); f.behind.robinhood = 100;
    saved = await run(f);
    check(Object.keys(saved.apr_series[0].pos), [f.kat.key], 'A backlog is incomplete even if no RPC threw an error');
    check(saved.fee_series, f.book.fee_series, 'Positive scan backlog cannot create a supposedly complete aggregate point');

    f = fixture(); f.errors.wallets = 'wallet history failed';
    saved = await run(f);
    check(saved.apr_series, undefined, 'An entirely unverifiable pass appends no substitute observations');

    f = fixture();
    saved = await run(f);
    check(saved.fee_series.length, f.book.fee_series.length + 1, 'A complete recovery resumes the full aggregate history');
    check(Object.keys(saved.fee_series.at(-1).pos), [f.kat.key, f.rh.key], 'The complete point includes both position baselines');
    check(saved.fee_series.at(-1).ts, NOW + 60, 'Full observations also use the completed reading time');
    check(saved.apr_series, undefined, 'A full fee observation does not duplicate the same data in the independent series');
    check(saved.runs.at(-1).errors, undefined, 'A recovered writer clears the failed-run warning');
  } finally {
    delete globalThis[fixtureKey];
    rmSync(root, { recursive: true, force: true });
  }
} finally {
  globalThis.fetch = noNetwork;
  Date.now = originalNow;
}
console.log(`Independent fee observations: ${checks} assertions passed`);
