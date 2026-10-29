/* Run the actual server-side readers against ABI-encoded, local RPC fixtures.
   A failed required read must remain an error, never an empty or cheaper LP list. */
import assert from 'node:assert/strict';
import {
  CFG, V3, multi, v3Rows, v3Candidates, tokenMeta, bookLiveRows, bookView,
  FABLES, fablesRead, VAULT, vaultValue,
} from '../api/_core.mjs';

const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = value => (typeof value === 'string' && value.startsWith('0x')
  ? value.slice(2) : BigInt.asUintN(256, BigInt(value)).toString(16)).padStart(64, '0');
const abi = (...values) => '0x' + values.map(word).join('');
const symbol = name => abi(32, Buffer.byteLength(name)) + Buffer.from(name).toString('hex').padEnd(64, '0');
const good = data => ({ ok: true, data });
const failed = { ok: false, data: '0x' };
const URL = 'https://fixture.invalid/rpc';
const WALLET = CFG.wallets[0].address, TOKEN = address(1), STABLE = address(2), POOL = address(3);
const SQRT = 1n << 96n, LIQ = 10n ** 12n;
const chain = { ...V3[1], rpc: URL, staker: null, closed: () => [] };
let checks = 0, mode = 'complete', callsSeen = [];
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const rejects = async (promise, note) => { await assert.rejects(promise, note); checks++; };

// Multicall3's return value is (bool,bytes)[], including the dynamic tuple offsets.
function aggregate(results) {
  let tail = '', offsets = '';
  for (const result of results) {
    const bytes = result.data.slice(2);
    offsets += word(results.length * 32 + tail.length / 2);
    tail += word(result.ok ? 1 : 0) + word(64) + word(bytes.length / 2)
      + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
  }
  return abi(32, results.length) + offsets + tail;
}
function decodeCalls(data) {
  const hex = data.slice(10);
  const at = byte => hex.slice(byte * 2, byte * 2 + 64);
  const count = Number(BigInt('0x' + at(32)));
  return Array.from({ length: count }, (_, i) => {
    const start = 64 + Number(BigInt('0x' + at(64 + i * 32)));
    const bytesAt = start + Number(BigInt('0x' + at(start + 64)));
    const length = Number(BigInt('0x' + at(bytesAt)));
    return { to: '0x' + at(start).slice(24), data: '0x' + hex.slice((bytesAt + 32) * 2, (bytesAt + 32 + length) * 2) };
  });
}
function replaceWord(hex, index, value) {
  return hex.slice(0, 2 + index * 64) + word(value) + hex.slice(2 + (index + 1) * 64);
}
function fixture(call) {
  const selector = call.data.slice(0, 10);
  callsSeen.push(call);
  if (mode === 'failed-' + selector) return failed;
  if (mode === 'short-' + selector) return good('0x1234');
  if (selector === '0x99fbab88') {
    const id = BigInt('0x' + call.data.slice(10));
    if (mode === 'second-position-failed' && id === 2n) return failed;
    return good(abi(0, 0, TOKEN, STABLE, 3000, 100, 200,
      mode === 'closed' ? 0 : LIQ, 0, 0, mode === 'closed' ? 0 : 5000000, mode === 'closed' ? 0 : 7000000));
  }
  if (selector === '0x6352211e') return good(abi(mode === 'zero-owner' ? address(0) : mode === 'transferred' ? address(99) : WALLET));
  if (selector === '0x1698ee82') return good(abi(mode === 'zero-pool' ? address(0) : POOL));
  if (selector === '0x95d89b41') return good(symbol(call.to === STABLE ? 'USDG' : 'COIN'));
  if (selector === '0x313ce567') return good(abi(mode === 'invalid-decimals' ? 256 : 6));
  if (selector === '0x3850c7bd') return good(abi(mode === 'zero-price' ? 0 : SQRT, 0));
  if (selector === '0xf3058399' || selector === '0x46141319') return good(abi(0));
  if (selector === '0xf30dba93') return good(abi(0, 0, 0, 0));
  if (selector === '0x2f745c59') return good(abi(1n + BigInt('0x' + call.data.slice(-64))));
  if (selector === '0x70a08231') return good(abi(0));
  throw Error('Unexpected fixture selector ' + selector);
}

const originalFetch = globalThis.fetch;
const originalRpcs = V3.map(ch => ch.rpc);
const originalVaultRpcs = Object.values(VAULT.chains).map(ch => ch.rpc);
globalThis.fetch = async (url, init) => {
  assert.equal(url, URL, 'Tests must never contact a real RPC endpoint');
  const request = JSON.parse(init.body);
  let result;
  if (request.method === 'eth_call' && request.params[0].to.toLowerCase() === CFG.multicall.toLowerCase()) {
    result = aggregate(decodeCalls(request.params[0].data).map(fixture));
    if (mode === 'aggregate-truncated') result = result.slice(0, -100);
    if (mode === 'aggregate-count') result = replaceWord(result, 1, 0);
    if (mode === 'aggregate-root-offset') result = replaceWord(result, 0, 0);
    if (mode === 'aggregate-tuple-offset') result = replaceWord(result, 2, 0);
    if (mode === 'aggregate-flag') result = replaceWord(result, 3, 2);
    if (mode === 'aggregate-data-offset') result = replaceWord(result, 4, 32);
    if (mode === 'aggregate-length') result = replaceWord(result, 5, 1000000);
    if (mode === 'aggregate-empty') result = '0x';
  } else if (request.method === 'eth_call') {
    const selector = request.params[0].data.slice(0, 10);
    assert.equal(selector, '0x70a08231', 'Direct fixture calls only read the NFT count');
    result = mode === 'count-malformed' ? '0x' : abi(mode === 'count-invalid' ? 10001 : mode.startsWith('enumeration') ? 2 : 0);
  } else if (request.method === 'eth_getBalance') result = '0x0';
  else if (request.method === 'eth_blockNumber') result = '0x64';
  else if (request.method === 'eth_getLogs') result = [];
  else throw Error('Unexpected fixture method ' + request.method);
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
};

const readRows = ids => v3Rows(chain, {}, new Map((ids || ['1']).map(id => [id, WALLET])), { noEntry: true });
try {
  check(await multi(URL, []), [], 'An empty batch needs no RPC');
  check(await multi(URL, [{ to: POOL, data: '0x3850c7bd' }]), [good(abi(SQRT, 0))], 'Actual aggregate encoding and decoding preserve ABI bytes');
  for (mode of ['aggregate-truncated', 'aggregate-count', 'aggregate-root-offset', 'aggregate-tuple-offset',
    'aggregate-flag', 'aggregate-data-offset', 'aggregate-length', 'aggregate-empty']) {
    await rejects(multi(URL, [{ to: POOL, data: '0x3850c7bd' }]), mode + ' cannot become a successful partial aggregate');
  }

  mode = 'complete';
  let rows = await readRows();
  check(rows.length, 1, 'A fully read LP is included');
  check(rows[0].fees_usd, 12, 'Verified owed token fees are part of the whole LP reading');
  check(rows[0].value_usd, rows[0].liquidity_usd + 12, 'Principal and owned fees reconcile to the whole LP value');
  assert.ok(rows[0].liquidity_usd > 4900 && rows[0].liquidity_usd < 5000, 'ABI decimals and sqrt price preserve the fixture principal'); checks++;
  check(rows[0].raw.t1.stable, true, 'On-chain USDG metadata supplies its stable-dollar identity');

  for (mode of ['failed-0x99fbab88', 'short-0x99fbab88', 'failed-0x6352211e', 'short-0x6352211e',
    'failed-0x1698ee82', 'short-0x1698ee82', 'zero-pool', 'failed-0x313ce567', 'short-0x313ce567', 'invalid-decimals',
    'failed-0x3850c7bd', 'short-0x3850c7bd', 'zero-price', 'zero-owner', 'failed-0xf3058399', 'failed-0x46141319',
    'failed-0xf30dba93', 'short-0xf30dba93', 'second-position-failed']) {
    await rejects(readRows(mode === 'second-position-failed' ? ['1', '2'] : undefined), mode + ' must reject the whole required LP read');
  }
  mode = 'closed';
  check(await readRows(), [], 'A successfully verified zero-liquidity, zero-fee LP is removed');
  mode = 'transferred';
  check(await readRows(), [], 'Verified ownership transfer removes an old wallet candidate');
  mode = 'complete';
  check((await readRows()).length, 1, 'A complete recovery restores the LP in the same reader context');

  mode = 'failed-0x95d89b41';
  const metadata = await tokenMeta(chain, [TOKEN, TOKEN.toUpperCase()]);
  check(Object.keys(metadata), [TOKEN], 'Token metadata reads each address only once');
  check(metadata[TOKEN].d, 6, 'An unavailable optional symbol preserves verified decimals');
  for (mode of ['failed-0x313ce567', 'short-0x313ce567', 'invalid-decimals'])
    await rejects(tokenMeta(chain, [TOKEN]), mode + ' cannot invent token decimals');

  for (mode of ['count-malformed', 'count-invalid'])
    await rejects(v3Candidates(chain, {}, {}, [], { wallets: [WALLET], wholeList: true }), mode + ' cannot prove an empty NFT wallet');
  mode = 'enumeration';
  const candidates = await v3Candidates(chain, {}, { 1: {} }, ['1'], { wallets: [WALLET], wholeList: true });
  check([...candidates], [['1', WALLET], ['2', WALLET]], 'Enumeration discovers a new NFT and deduplicates saved candidates');
  // Keep the positive count while failing the enumeration batch itself.
  mode = 'enumeration-failed';
  const enumFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.params?.[0]?.to?.toLowerCase() === CFG.multicall.toLowerCase()) {
      const calls = decodeCalls(body.params[0].data);
      if (calls[0]?.data.startsWith('0x2f745c59'))
        return { ok: true, json: async () => ({ result: aggregate(calls.map(() => failed)) }) };
    }
    return enumFetch(url, init);
  };
  await rejects(v3Candidates(chain, {}, {}, [], { wallets: [WALLET], wholeList: true }), 'A failed enumeration cannot silently omit wallet NFTs');
  globalThis.fetch = enumFetch;

  V3.forEach(ch => { ch.rpc = URL; });
  const P = { key: 'robinhood:1', chain: 'robinhood', id: '1', wallet: WALLET, status: 'open' };
  const book = { positions: { [P.key]: P } };
  mode = 'failed-0x99fbab88';
  let live = await bookLiveRows(book);
  check(Object.keys(live.rows), [], 'A failed chain does not contribute an omitted or cheaper successful row');
  assert.match(live.errors.robinhood, /position/, 'LP Book records the required-read failure against its chain'); checks++;
  mode = 'complete';
  live = await bookLiveRows(book);
  check(Object.keys(live.rows), [P.key], 'A full chain recovery restores its live row');
  check(live.errors, {}, 'A full chain recovery clears the failure');

  const NOW = 1900000000, unknown = 'UNKNOWN@robinhood', token = 'COIN@robinhood', stable = 'USDG@robinhood';
  const performancePosition = { ...P, pair: 'COIN / USDG', t0: token, t1: stable, s0: 'COIN', s1: 'USDG',
    opened_ts: NOW - 86400, cost_usd: 120, out_usd: 0, at_start: false,
    deposits: [{ ts: NOW - 86400, a0: 10, a1: 100, usd: 120 }], withdrawals: [],
    fees: {}, start_uncollected: {}, start_merkl: {}, merkl: {}, claims: [{ ts: NOW - 3600, tokens: { [unknown]: 0 } }] };
  const performanceRow = { id: '1', chain: 'robinhood', wallet: WALLET, pair: 'COIN / USDG', protocol: 'Uniswap V3',
    value_usd: 135, liquidity_usd: 135, fees_usd: 0, fees_mine: true, in_range: true, held_days: 1,
    pnl_usd: null, il_usd: null,
    range: { now: 4, lower: 3, upper: 5, position_pct: 50, to_lower_pct: 25, to_upper_pct: 25, width_pct: 66.67 },
    raw: { sqrt: String(2n * SQRT), t0: { s: 'COIN', d: 0, stable: false }, t1: { s: 'USDG', d: 0, stable: true }, fee0: 0, fee1: 0 } };
  const performanceBook = { started: { ts: NOW - 172800 }, wallets: [WALLET], events: [], fee_series: [],
    tokens: { [token]: { s: 'COIN' }, [stable]: { s: 'USDG' } }, positions: { [P.key]: performancePosition } };
  const view = () => bookView(performanceBook, { rows: { [P.key]: performanceRow }, prices: { [token]: 4, [stable]: 1 }, merkl: {} });
  check(view().health.unpriced, [], 'A verified zero amount needs no token price and must not trigger incomplete-read handling');
  performancePosition.claims[0].tokens[unknown] = 1;
  check(view().health.unpriced, [unknown], 'A positive unpriced token remains incomplete instead of being called zero');

  // Fables has its own ERC-6909 balance and V4 storage reads. Exercise their actual
  // encoded batches, including the positive locks that the vault must price.
  const FB = { rangeKey: '0x2e32a3b0', rangeState: '0x41b69b2a', userPosition: '0x4eb5c4fd',
    claimFee: '0xd677eaad', extsload: '0x1e2eaeaf', balance: '0x00fdd58e', locks: '0xf4dadc61', owner: '0x6352211e' };
  const Q128 = 1n << 128n;
  let fablesMode = 'complete';
  function fablesFixture(call, index, batch) {
    const selector = call.data.slice(0, 10);
    // The first extsload is slot0. The remaining nine words are fee growth,
    // hook-position liquidity/checkpoints, and the lower/upper tick checkpoints.
    const extIndex = batch.slice(0, index).filter(x => x.data.startsWith(FB.extsload)).length;
    const reading = selector === FB.extsload ? (extIndex === 0 ? 'pool-price' : 'fee-growth')
      : ({ [FB.rangeKey]: 'range-key', [FB.rangeState]: 'range-state', [FB.userPosition]: 'user-position',
        [FB.claimFee]: 'claim-fee', [FB.balance]: 'range-balance', [FB.locks]: 'lock-amount', [FB.owner]: 'lock-owner' })[selector];
    if (fablesMode === 'failed-' + reading) return failed;
    if (fablesMode === 'short-' + reading) return good('0x1234');
    if (selector === FB.rangeKey) return good(abi(TOKEN, STABLE, 3000, 10, FABLES.ramp, -100, 100));
    if (selector === FB.extsload) {
      if (extIndex === 0) return good(abi(fablesMode === 'zero-pool-price' ? 0 : SQRT));
      return good(abi([Q128, 2n * Q128, 1000000n, 0, 0, 0, 0, 0, 0][extIndex - 1]));
    }
    if (selector === FB.rangeState) return good(abi(LIQ, 0, 0, 0, 0, 0));
    if (selector === FB.claimFee) return good(abi(fablesMode === 'invalid-claim-fee' ? 10001 : 1000));
    if (selector === FB.balance) return good(abi(fablesMode === 'closed-range' ? 0 : LIQ / 2n));
    if (selector === FB.userPosition) return good(abi(fablesMode === 'closed-range' ? 0 : LIQ / 2n,
      fablesMode === 'closed-range' ? 0 : 5000000, fablesMode === 'closed-range' ? 0 : 7000000, 0, 0, 0, 0));
    if (selector === FB.locks) return good(abi(fablesMode === 'zero-lock-owner-failed' ? 0 : 25n * 10n ** 18n, 2000000000));
    if (selector === FB.owner) return fablesMode === 'zero-lock-owner-failed' ? failed
      : good(abi(fablesMode === 'transferred-lock' ? address(99) : call.data.endsWith(word(560)) ? VAULT.address : WALLET));
    if (selector === '0x95d89b41') return good(symbol(call.to === STABLE
      ? fablesMode === 'unpriced-lock' ? 'OTHER' : 'USDG' : 'FABLES'));
    if (selector === '0x313ce567') return good(abi(6));
    // Vault reference pools and loose-token balances: all verified zero, so the
    // test can attribute incompleteness to one chosen balance or lock read.
    if (selector === '0x0dfe1681') return good(abi(TOKEN));
    if (selector === '0xd21220a7') return good(abi(STABLE));
    if (selector === '0x3850c7bd') return good(abi(SQRT, 0));
    if (selector === '0x70a08231') return fablesMode === 'failed-wallet-balance'
      && call.to === VAULT.chains.katana.tokens[0].a ? failed : good(abi(0));
    throw Error('Unexpected Fables/vault fixture selector ' + selector);
  }
  globalThis.fetch = async (url, init) => {
    assert.equal(url, URL, 'Fables and vault tests must never contact a real RPC endpoint');
    const request = JSON.parse(init.body);
    let result;
    if (request.method === 'eth_call' && request.params[0].to.toLowerCase() === CFG.multicall.toLowerCase())
      result = aggregate(decodeCalls(request.params[0].data).map(fablesFixture));
    else if (request.method === 'eth_call') {
      assert.equal(request.params[0].data.slice(0, 10), '0x70a08231', 'Direct vault calls only read NFT counts');
      result = abi(0);
    } else if (request.method === 'eth_getBalance') result = '0x0';
    else if (request.method === 'eth_blockNumber') result = '0x64';
    else if (request.method === 'eth_getLogs') result = [];
    else throw Error('Unexpected Fables/vault fixture method ' + request.method);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  Object.values(VAULT.chains).forEach(ch => { ch.rpc = URL; });
  const fablesState = { ranges: FABLES.seed.ranges, locks: FABLES.seed.locks };
  let fab = await fablesRead(fablesState);
  check(fab.rows.length, 1, 'A fully read Fables range is included');
  check(fab.rows[0].raw.liq, String(LIQ), 'Fables adds the verified wallet and staked shares');
  check(fab.rows[0].staked, true, 'The Fables row identifies its staked shares');
  check([fab.rows[0].raw.fee0, fab.rows[0].raw.fee1], [5.95, 8.9], 'Fables fees include owed tokens and hook growth with the unstaked claim cut');
  check(fab.rows[0].fees_usd, 14.85, 'Fables owned fees are priced from its verified pool');
  check(fab.fables_usd, 1, 'The verified seed pool prices FABLES');
  check(fab.locks, [{ id: '559', wallet: WALLET, amount: 25, unlock: 2000000000, value_usd: 25 }], 'Positive owned locks retain their amount, unlock time and value');
  for (const reading of ['range-key', 'pool-price', 'range-state', 'fee-growth', 'claim-fee',
    'range-balance', 'user-position', 'lock-amount', 'lock-owner']) {
    for (const failure of ['failed-', 'short-']) {
      fablesMode = failure + reading;
      await rejects(fablesRead(fablesState), fablesMode + ' must reject the whole Fables reading');
    }
  }
  for (fablesMode of ['zero-pool-price', 'invalid-claim-fee'])
    await rejects(fablesRead(fablesState), fablesMode + ' cannot produce a successful Fables reading');
  fablesMode = 'zero-lock-owner-failed';
  fab = await fablesRead(fablesState);
  check(fab.locks, [], 'A verified zero lock amount permits an unavailable burned-NFT owner');
  check(fab.rows.length, 1, 'A verified empty lock leaves the fully read range intact');
  fablesMode = 'transferred-lock';
  check((await fablesRead(fablesState)).locks, [], 'Verified lock transfer removes the former wallet lock');
  fablesMode = 'closed-range';
  check((await fablesRead(fablesState)).rows, [], 'Verified zero wallet and staked shares remove a closed Fables range');
  fablesMode = 'complete';
  check((await fablesRead(fablesState)).rows.length, 1, 'A full Fables recovery restores its range');

  const emptyVault = { book: { positions: {} }, fables: { ranges: [], locks: [] } };
  let vault = await vaultValue(VAULT.address, emptyVault);
  check(vault.complete, true, 'A vault with verified zero balances and positions is complete');
  check(vault.total_usd, 0, 'Verified zero wallet and position balances produce a zero vault');
  fablesMode = 'failed-wallet-balance';
  vault = await vaultValue(VAULT.address, emptyVault);
  check(vault.complete, false, 'One failed raw ERC-20 balance makes the vault incomplete');
  assert.match(vault.errors['katana wallet'], /vbUSDC balance/, 'The vault identifies the failed raw-token read'); checks++;
  fablesMode = 'unpriced-lock';
  vault = await vaultValue(VAULT.address, { book: { positions: {} }, fables: { ranges: [], locks: [{ id: '560', wallet: VAULT.address }] } });
  check(vault.complete, false, 'A positive owned lock without a price makes the vault incomplete');
  check(vault.errors['Fables lock 560'], 'unpriced', 'The vault names its positive unpriced lock');
  fablesMode = 'complete';
  vault = await vaultValue(VAULT.address, emptyVault);
  check(vault.complete, true, 'A full vault recovery clears required-read and pricing failures');
} finally {
  globalThis.fetch = originalFetch;
  V3.forEach((ch, i) => { ch.rpc = originalRpcs[i]; });
  Object.values(VAULT.chains).forEach((ch, i) => { ch.rpc = originalVaultRpcs[i]; });
}
console.log('Core read completeness: ' + checks + ' assertions passed.');
