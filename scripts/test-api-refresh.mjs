/* Exercise the actual endpoint handlers with controlled upstream reads. The warm
   ledger, complete-only cache, response headers and recovery paths are production
   code; no RPC, DNS or historical data is changed by these fault scenarios. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createLiveCache, requestOrigin, fetchJSON, lpViewComplete, responseHeaders,
  savedBookValid, savedFables } from '../api/_live-cache.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const clone = (value) => JSON.parse(JSON.stringify(value));
const seed = JSON.parse(readFileSync(new URL('../lpbook.json', import.meta.url), 'utf8'));
const discovery = JSON.parse(readFileSync(new URL('../data.json', import.meta.url), 'utf8')).fables;
const originalSeed = JSON.stringify(seed);
const realNow = Date.now, realFetch = globalThis.fetch;
let clock = Date.now();
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}
function handler(file, dependencies) {
  const source = readFileSync(new URL('../api/' + file, import.meta.url), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace('export default async function handler', 'async function handler');
  return vm.runInNewContext(source + '\nhandler', { Date: TestDate, URL, Map, Promise,
    createLiveCache, requestOrigin, lpViewComplete, responseHeaders, savedBookValid, savedFables,
    BOOK_VERSION: seed.version, ...dependencies }, { filename: file });
}
async function call(run, host = 'dashboard.example') {
  const response = { headers: {}, code: null, text: '',
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; },
    end(text) { this.text = text; } };
  await run({ headers: { host, 'x-forwarded-host': 'untrusted.example', 'x-forwarded-proto': 'https' } }, response);
  return { code: response.code, headers: response.headers, body: JSON.parse(response.text) };
}
const healthy = () => ({ errors: {}, unread: [], unpriced: [], behind: { katana: 0, robinhood: 0 } });

try {
  Date.now = () => clock;
  check(requestOrigin({ headers: { host: 'dashboard.example', 'x-forwarded-host': 'other.example' } }),
    'https://dashboard.example', 'The routed host owns the cache/source origin, not a forwarded override');
  for (const host of [undefined, ['dashboard.example'], 'dashboard.example/evil', 'user@dashboard.example', 'a.example,b.example']) {
    assert.throws(() => requestOrigin({ headers: { host } })); checks++;
  }
  check(requestOrigin({ headers: { host: '127.0.0.1:4200', 'x-forwarded-proto': 'http' } }),
    'http://127.0.0.1:4200', 'A local HTTP function keeps its local source origin');
  check(savedBookValid(seed, seed.version), true, 'The current saved book passes structural validation');
  check(savedBookValid({ ...seed, version: seed.version + 1 }, seed.version), false, 'A different book schema is not read as this ledger');
  check(savedBookValid({ ...seed, last_block: { robinhood: 'unknown' } }, seed.version), false, 'An invalid cursor cannot seed a warm ledger');
  check(lpViewComplete({ health: healthy() }), true, 'A full read may use the short shared cache');
  for (const delta of [{ errors: { robinhood: 'limited' } }, { unread: ['robinhood:1'] },
    { unpriced: ['WETH@robinhood'] }, { behind: { robinhood: 1 } }])
    check(lpViewComplete({ health: { ...healthy(), ...delta } }), false, 'Incomplete health never qualifies for a complete cache');

  const state = { source: clone(seed), head: seed.last_block.robinhood + 250000,
    katHead: seed.last_block.katana + 1, failRH: false, snapshotError: false,
    unread: [], unpriced: [], advanceInputs: [], snapshots: 0, advances: 0, rowReads: 0, scanWindows: 0,
    failReward: false, pricedReward: null };
  state.source.reward_rollover_anchor = { claimed: { 'katana:closed': 999 }, claims: ['obsolete runtime reading'] };
  const lp = handler('lpbook.mjs', {
    fetchJSON: async (url) => { check(new URL(url).pathname, '/lpbook.json', 'LP reads the canonical saved-book path');
      state.snapshots++; await Promise.resolve(); if (state.snapshotError) throw new Error('snapshot unavailable'); return clone(state.source); },
    merklLp: async () => ({ token_price: { 'KAT@katana': .001 },
      earned_tokens_by_id: { replacement: { 'KAT@katana': 0 } }, raw: true }),
    advanceBook: async (input, options) => {
      state.advances++; state.advanceInputs.push(clone(input));
      check(options.maxWindows, 4, 'A page refresh retains its bounded catch-up window');
      check(options.merkl.raw, true, 'The ledger receives the raw reward reading before applying rollovers');
      const book = clone(input), previous = book.last_block.robinhood;
      book.reward_rollovers = [{ source: 'closed', target: 'replacement', token: 'KAT@katana', claimedBefore: 20, initialCarry: 80 }];
      book.reward_native = { 'katana:closed': { earned: 100, claimed: 20 } };
      book.reward_rollover_anchor = { claimed: { 'katana:closed': 20 }, claims: [] };
      book.last_block.katana = state.katHead;
      if (!state.failRH) {
        state.scanWindows += Math.ceil(Math.max(0, state.head - previous) / 100000);
        book.last_block.robinhood = state.head;
      }
      return { book, errors: { ...(state.failRH ? { robinhood: 'rate limited' } : {}),
        ...(state.failReward ? { merkl: 'the rollover reward reading is incomplete' } : {}) },
      behind: { katana: 0, robinhood: 0 },
      merkl: { token_price: { 'KAT@katana': .004 }, earned_tokens_by_id: { replacement: { 'KAT@katana': 80 } },
        reward_attribution_version: 2, reward_rollover_basis: { 'katana:replacement': 80 },
        error: state.failReward || undefined } };
    },
    bookLiveRows: async () => { state.rowReads++; return { rows: {}, errors: {} }; },
    livePrices: async (book, extra) => { state.pricedReward = extra['KAT@katana']; return {}; },
    bookView: (book, input) => ({ cards: { frozen: book.positions[Object.keys(book.positions)[0]].frozen },
      alltime: { marker: book.test_revision || 'initial' },
      effective_reward: input.merkl.earned_tokens_by_id.replacement['KAT@katana'],
      reward_basis: input.merkl.reward_rollover_basis,
      health: { ...healthy(), errors: input.errors, behind: input.behind, unread: state.unread, unpriced: state.unpriced } }),
  });
  const first = await Promise.all(Array.from({ length: 6 }, () => call(lp)));
  check(state.snapshots, 1, 'Simultaneous LP requests fetch the saved book once');
  check(state.advances, 1, 'Simultaneous LP requests run one ledger scan');
  check(state.rowReads, 1, 'Simultaneous LP requests share live position reads');
  check(state.advanceInputs[0].reward_rollover_anchor, undefined,
    'A new saved source discards an obsolete runtime claim anchor before rebuilding effective rewards');
  check(first[0].body.effective_reward, 80, 'The actual endpoint renders ledger-attributed rewards rather than raw native rewards');
  check(first[0].body.reward_basis, { 'katana:replacement': 80 }, 'The view receives the same rollover basis used by the ledger');
  check(state.pricedReward, .004, 'Live pricing uses the effective reward reading returned by advancement');
  check(state.scanWindows, 3, 'The controlled six-hour backlog takes three RH windows');
  check(first.every((answer) => answer.code === 200 && answer.headers['cache-control'].startsWith('s-maxage=10')), true,
    'Complete concurrent answers use the short edge cache');
  check(first.every((answer) => answer.body.generated === first[0].body.generated), true, 'Shared callers retain one real generation time');
  clock += 7000;
  const within = await call(lp);
  check(state.advances, 1, 'A complete answer is reused within the eight-second warm cache');
  check(within.body.generated, first[0].body.generated, 'A cache hit never rewrites the source generation time');
  clock += 1001;
  await call(lp);
  check(state.advances, 2, 'The complete cache expires and reads again');
  check(state.advanceInputs.at(-1).last_block.robinhood, state.head, 'The next pass resumes the advanced checkpoint');
  check(state.advanceInputs.at(-1).reward_rollovers, [{ source: 'closed', target: 'replacement', token: 'KAT@katana', claimedBefore: 20, initialCarry: 80 }],
    'The next warm request retains the complete advanced rollover ledger');
  check(state.advanceInputs.at(-1).reward_native, { 'katana:closed': { earned: 100, claimed: 20 } },
    'The next warm request retains native reward observations separately from effective balances');
  check(state.advanceInputs.at(-1).reward_rollover_anchor, { claimed: { 'katana:closed': 20 }, claims: [] },
    'Routine warm requests retain their immutable source anchor');
  check(state.scanWindows, 3, 'The unchanged backlog is not scanned a second time');

  clock += 15000;
  state.source = clone(seed); state.source.test_revision = 'new committed snapshot';
  state.source.last_block.robinhood += 100;
  const changed = await call(lp);
  check(state.advanceInputs.at(-1).last_block.robinhood, state.source.last_block.robinhood,
    'A new committed snapshot replaces the in-memory ledger instead of merging histories');
  check(state.advanceInputs.at(-1).reward_rollover_anchor, undefined,
    'A changed committed snapshot starts a fresh runtime anchor instead of reusing the old checkpoint boundary');
  check(changed.body.alltime.marker, 'new committed snapshot', 'Updated saved content is visible after cache expiry');
  check(changed.body.cards.frozen, state.source.positions[Object.keys(seed.positions)[0]].frozen,
    'Frozen position information comes intact from the canonical new snapshot');
  await call(lp, 'preview.example');
  check(state.advanceInputs.at(-1).last_block.robinhood, state.source.last_block.robinhood,
    'Another routed origin starts with its own checkpoint');

  clock += 15000; state.failRH = true; state.katHead += 10;
  const partial = await call(lp);
  check(partial.headers['cache-control'], 'no-store', 'A failed chain is never edge cached as a healthy answer');
  check(partial.body.health.errors.robinhood, 'rate limited', 'The endpoint preserves its actual failure reason');
  const failedRHCursor = state.advanceInputs.at(-1).last_block.robinhood;
  const beforeRetry = state.advances;
  await call(lp);
  check(state.advances, beforeRetry + 1, 'Incomplete answers do not enter the warm result cache');
  check(state.advanceInputs.at(-1).last_block.katana, state.katHead, 'A successful sibling chain keeps its ledger progress');
  check(state.advanceInputs.at(-1).last_block.robinhood, failedRHCursor, 'A failed chain retains its previous cursor for retry');
  state.failRH = false;
  const recovered = await call(lp);
  check(Object.keys(recovered.body.health.errors).length, 0, 'An immediate full recovery clears the error');
  check(recovered.headers['cache-control'].startsWith('s-maxage=10'), true, 'A recovered complete view is cacheable again');

  clock += 15000; state.failReward = true;
  const incompleteReward = await call(lp), beforeRewardRetry = state.advances;
  check(incompleteReward.headers['cache-control'], 'no-store', 'An incomplete effective rollover reading cannot be edge cached');
  check(incompleteReward.body.health.errors.merkl, 'the rollover reward reading is incomplete',
    'The endpoint preserves the ledger attribution failure instead of replacing its reason');
  await call(lp);
  check(state.advances, beforeRewardRetry + 1, 'Incomplete effective rewards are retried without entering the complete warm cache');
  state.failReward = false;
  const rewardRecovery = await call(lp);
  check(rewardRecovery.body.health.errors, {}, 'A fresh complete rollover reading clears the reward failure');
  check(rewardRecovery.body.effective_reward, 80, 'Recovery still renders attributed earnings rather than raw native zero');

  for (const kind of ['unread', 'unpriced']) {
    clock += 15000; state[kind] = ['robinhood:unavailable'];
    const incomplete = await call(lp); const before = state.advances; await call(lp);
    check(incomplete.headers['cache-control'], 'no-store', 'Missing ' + kind + ' values are not cached as full readings');
    check(state.advances, before + 1, 'Missing ' + kind + ' values are retried instead of memoized');
    state[kind] = [];
  }
  clock += 15000; state.snapshotError = true;
  const unavailable = await call(lp);
  check(unavailable.code, 502, 'A failed new refresh returns a failure instead of an expired success');
  check(unavailable.headers['cache-control'], 'no-store', 'Snapshot errors cannot poison the edge cache');
  check(unavailable.body.generated, undefined, 'A failure has no fabricated fresh generation time');
  state.snapshotError = false;
  check((await call(lp)).code, 200, 'A failed refresh does not lock out the next recovery');
  clock += 15000; state.source.version++;
  const beforeInvalid = state.advances;
  check((await call(lp)).code, 502, 'A malformed canonical snapshot is rejected');
  check(state.advances, beforeInvalid, 'A malformed snapshot never reaches the chain scanner');
  state.source.version--;

  let fableSnapshots = 0, fableReads = 0, fableError = false, badFableSource = false;
  const fables = handler('fables.mjs', {
    fetchJSON: async () => { fableSnapshots++; return badFableSource ? {} : { fables: clone(discovery) }; },
    fablesRead: async () => { fableReads++; await Promise.resolve(); return {
      rows: [], locks: [{ value_usd: 50 }], fables_usd: .25, ...(fableError ? { complete: false, errors: { owner: 'unreadable' } } : {}) }; },
    fablesDashRow: (row) => row, fablesLockRow: (row) => row,
  });
  const fabFirst = await Promise.all([call(fables), call(fables), call(fables)]);
  check(fableSnapshots, 1, 'Concurrent Fables requests share discovery');
  check(fableReads, 1, 'Concurrent Fables requests share the chain read');
  check(fabFirst.every((answer) => answer.body.at === fabFirst[0].body.at), true, 'Fables cache hits retain their observation time');
  clock += 15000; fableError = true;
  check((await call(fables)).code, 502, 'An incomplete Fables read cannot become a fresh empty balance');
  const badFab = await call(fables);
  check(badFab.headers['cache-control'], 'no-store', 'Incomplete Fables errors bypass both caches');
  check(fableReads, 3, 'Incomplete Fables responses are retried');
  fableError = false;
  check((await call(fables)).code, 200, 'Fables recovers on the next request');
  clock += 15000; badFableSource = true;
  const fableReadsBefore = fableReads;
  check((await call(fables)).code, 502, 'Missing discovery cannot masquerade as a complete seed-only portfolio');
  check(fableReads, fableReadsBefore, 'Malformed discovery is rejected before upstream calls');

  let vaultSnapshots = 0, vaultReads = 0, vaultPartial = false, vaultSnapshotError = false;
  const vault = handler('vault.mjs', {
    fetchJSON: async (url) => { vaultSnapshots++; if (vaultSnapshotError) throw new Error('saved source unavailable');
      return url.endsWith('/lpbook.json') ? clone(seed) : { fables: clone(discovery) }; },
    vaultValue: async () => { vaultReads++; await Promise.resolve(); return { total_usd: 100, at: new TestDate().toISOString(),
      complete: !vaultPartial, ...(vaultPartial ? { errors: { robinhood: 'rate limited' } } : {}) }; },
  });
  const vaultFirst = await Promise.all([call(vault), call(vault), call(vault)]);
  check(vaultSnapshots, 2, 'Concurrent vault callers fetch each saved source once');
  check(vaultReads, 1, 'Concurrent vault callers share one portfolio read');
  check(vaultFirst.every((answer) => answer.body.at === vaultFirst[0].body.at), true, 'Vault cached replies retain their reading time');
  clock += 15000; vaultPartial = true;
  const partialVault = await call(vault); await call(vault);
  check(partialVault.code, 200, 'The vault retains explicit partial-result semantics');
  check(partialVault.body.complete, false, 'The client can distinguish an incomplete vault');
  check(partialVault.headers['cache-control'], 'no-store', 'Incomplete vault responses are never shared-cache successes');
  check(vaultReads, 3, 'Incomplete vault reads are retried rather than cached');
  vaultPartial = false; check((await call(vault)).body.complete, true, 'A complete vault read recovers immediately');
  clock += 15000; vaultSnapshotError = true;
  const vaultFailed = await call(vault);
  check(vaultFailed.code, 502, 'Failed vault source loading never falls back to incomplete discovery');
  check(vaultFailed.headers['cache-control'], 'no-store', 'Failed vault source loading is not cached');

  globalThis.fetch = async (_url, options) => ({ ok: true, status: 200,
    json: () => new Promise(() => {}), signal: options.signal });
  await assert.rejects(fetchJSON('https://dashboard.example/lpbook.json', { timeoutMs: 15 }), /timed out/); checks++;
  let jsonRead = false;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => { jsonRead = true; return {}; } });
  await assert.rejects(fetchJSON('https://dashboard.example/lpbook.json'), /HTTP 503/); checks++;
  check(jsonRead, false, 'HTTP errors are rejected before parsing a misleading JSON body');
  for (const malformed of [null, [], 42]) {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => malformed });
    await assert.rejects(fetchJSON('https://dashboard.example/lpbook.json'), /malformed/); checks++;
  }
  check(JSON.stringify(seed), originalSeed, 'Fault scenarios never mutate the saved seed ledger');
} finally { Date.now = realNow; globalThis.fetch = realFetch; }

console.log('API refresh reliability: ' + checks + ' assertions passed.');
