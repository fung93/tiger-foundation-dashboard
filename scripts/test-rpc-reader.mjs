/* Fault-test the actual shared RPC transport without a chain or API key.
   Fixtures here are transport responses, never portfolio balances. */
import assert from 'node:assert/strict';
import '../rpc-reader.js';

const { create } = globalThis.TigerRpc;
const URL_A = 'https://rpc.example.test', URL_B = 'https://other.example.test';
const BASE = Date.UTC(2026, 9, 29, 0, 0, 0);
let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const reject = async (promise, expected, note) => { await assert.rejects(promise, expected, note); checks++; };
const response = (payload, status = 200, retryAfter = null) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null },
  json: async () => payload,
});
const success = result => response({ jsonrpc: '2.0', id: 1, result });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function virtual(fetch, options = {}) {
  const clock = { at: BASE, waits: [] };
  const read = create({ paceMs: 0, timeoutMs: 100, totalTimeoutMs: 16000,
    retryBaseMs: 1000, retryMaxMs: 10000, ...options,
    now: () => clock.at,
    sleep: async ms => { clock.waits.push(ms); clock.at += ms; },
    fetch: (url, init) => fetch(url, init, clock),
  });
  return { read, clock };
}

// Identical work is shared only while pending, with isolated result objects.
{
  const gate = deferred(), source = [{ blockNumber: '0x10', data: { amount: '123' } }];
  let calls = 0, firstInit;
  const { read } = virtual(async (url, init) => {
    calls++; firstInit ||= init;
    if (calls === 1) await gate.promise;
    return success(source);
  });
  const a = read(URL_A, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x10' }]);
  const b = read(URL_A, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x10' }]);
  check(calls, 1, 'Concurrent identical calls make one network request');
  gate.resolve();
  const [one, two] = await Promise.all([a, b]);
  check(one, source, 'The first caller receives the actual RPC result');
  one[0].data.amount = 'changed';
  check(two[0].data.amount, '123', 'Deduplicated callers cannot mutate each other’s nested result');
  check(source[0].data.amount, '123', 'Caller mutations do not change the transport result');
  await read(URL_A, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x10' }]);
  check(calls, 2, 'A later request reads the chain again instead of reusing a completed result');
  check(JSON.parse(firstInit.body), { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x10' }] }, 'JSON-RPC request preserves method and params');
  check(firstInit.method, 'POST', 'RPC uses POST');
  check(firstInit.signal instanceof AbortSignal, true, 'Every network attempt is abortable');
}

// Pace endpoint calls, serialize their work and prioritize queued live reads.
{
  const gate = deferred(), order = [], starts = [];
  let active = 0, peak = 0;
  const { read, clock } = virtual(async (url, init, time) => {
    const { method, params } = JSON.parse(init.body);
    order.push(method + ':' + params[0]); starts.push(time.at);
    active++; peak = Math.max(peak, active);
    if (order.length === 1) await gate.promise;
    active--; return success(params[0]);
  }, { paceMs: 120 });
  const first = read(URL_A, 'eth_getLogs', ['first']);
  const background = read(URL_A, 'eth_getLogs', ['second']);
  const foreground = read(URL_A, 'eth_call', ['live']);
  check(order, ['eth_getLogs:first'], 'Pending work does not burst while one request runs');
  gate.resolve(); await Promise.all([first, background, foreground]);
  check(peak, 1, 'Requests to one RPC endpoint never run concurrently');
  check(order, ['eth_getLogs:first', 'eth_call:live', 'eth_getLogs:second'], 'A queued foreground read overtakes queued background log work');
  check(starts, [BASE, BASE + 120, BASE + 240], 'Requests start at the configured endpoint pace');
  check(clock.waits, [120, 120], 'Only the required spacing is waited out');
}
{
  const gate = deferred(); let callsA = 0, callsB = 0;
  const { read } = virtual(async url => {
    if (url === URL_A) { callsA++; await gate.promise; }
    else callsB++;
    return success(url);
  });
  const first = read(URL_A, 'eth_blockNumber', []);
  check(await read(URL_B, 'eth_blockNumber', []), URL_B, 'A stalled endpoint does not block another chain');
  check([callsA, callsB], [1, 1], 'Different endpoints have independent queues');
  gate.resolve(); await first;
}
{
  const pause = deferred(), order = []; let at = BASE, waits = 0;
  const read = create({ paceMs: 120, timeoutMs: 100, totalTimeoutMs: 1000,
    now: () => at,
    sleep: async ms => { if (++waits === 1) await pause.promise; at += ms; },
    fetch: async (url, init) => { const payload = JSON.parse(init.body); order.push(payload.method); return success('0x1'); },
  });
  await read(URL_A, 'eth_blockNumber', []);
  const background = read(URL_A, 'eth_getLogs', ['background']);
  check(waits, 1, 'A pending log waits for the next paced request slot');
  const foreground = read(URL_A, 'eth_call', ['live']);
  pause.resolve(); await Promise.all([background, foreground]);
  check(order, ['eth_blockNumber', 'eth_call', 'eth_getLogs'], 'A foreground read arriving during the pacing wait takes the next slot');
}

// A provider’s Retry-After applies to the complete URL queue, not just one caller.
for (const [status, header, wait] of [[429, '10', 10000], [503, new Date(BASE + 5000).toUTCString(), 5000]]) {
  const starts = []; let count = 0;
  const { read } = virtual(async (url, init, clock) => {
    starts.push(clock.at); count++;
    return count === 1 ? response(null, status, header) : success('0x123');
  });
  check(await read(URL_A, 'eth_blockNumber', []), '0x123', status + ' retries and recovers');
  check(starts, [BASE, BASE + wait], status + ' respects Retry-After seconds/date');
}
for (const status of [429, 503]) {
  let count = 0, aborted = 0, successSignal;
  const { read } = virtual(async (url, init) => {
    count++;
    if (count === 1) {
      init.signal.addEventListener('abort', () => { aborted++; });
      return { ...response(null, status), body: { cancel: () => { throw new Error('Native fetch abort should cancel its stream'); } },
        json: () => new Promise(() => {}) };
    }
    successSignal = init.signal; return success('0x40');
  });
  check(await read(URL_A, 'eth_blockNumber', []), '0x40', status + ' streaming error response recovers');
  check(aborted, 1, status + ' aborts the rejected HTTP response instead of leaving its stream open');
  check(successSignal.aborted, false, 'A fully consumed successful response does not get spuriously aborted');
}
{
  const starts = []; let calls = 0;
  const { read } = virtual(async (url, init, clock) => {
    starts.push(clock.at); calls++;
    return calls === 1 ? response(null, 429, '2') : success('0x50');
  });
  await reject(read(URL_A, 'eth_getLogs', ['limited'], { maxAttempts: 1 }), /429/, 'A request can stop at its attempt limit');
  check(await read(URL_A, 'eth_call', ['next']), '0x50', 'A different request recovers after the shared provider cooldown');
  check(starts, [BASE, BASE + 2000], 'Retry-After still applies to the next queued request after final-attempt failure');
}
{
  const starts = []; let count = 0;
  const { read } = virtual(async (url, init, clock) => {
    starts.push(clock.at); count++;
    return count <= 2 ? response({ error: { code: -32005, message: 'Request quota exceeded' } }) : success('0x99');
  });
  check(await read(URL_A, 'eth_blockNumber', []), '0x99', 'JSON-RPC rate limiting recovers without becoming a false empty response');
  check(starts, [BASE, BASE + 1000, BASE + 3000], 'Rate-limit retries back off instead of immediately repeating');
}
{
  let calls = 0;
  const { read, clock } = virtual(async () => { calls++; return response(null, 429, '3600'); });
  await reject(read(URL_A, 'eth_blockNumber', []), /deadline|timed out/, 'A long server cooldown cannot exceed the caller deadline');
  check(calls, 1, 'An over-budget Retry-After does not cause extra requests');
  check(clock.waits, [], 'An over-budget Retry-After does not sleep indefinitely');
}

// Broken HTTP or JSON replies cannot masquerade as a successful result.
for (const bad of [response(null), response({}), response({ result: undefined }), response({}, 503),
  { ...response(null), json: async () => { throw new SyntaxError('Unexpected token'); } }]) {
  let calls = 0;
  const { read } = virtual(async () => ++calls === 1 ? bad : success('0x10'));
  check(await read(URL_A, 'eth_blockNumber', []), '0x10', 'Malformed/transient HTTP or JSON reply is retried before publishing a result');
  check(calls, 2, 'A transient bad reply costs exactly one retry');
}
{
  let calls = 0;
  const { read } = virtual(async () => { calls++; return response({}); });
  await reject(read(URL_A, 'eth_blockNumber', []), /result is missing/, 'Repeated missing results reject rather than return undefined');
  check(calls, 3, 'A persistent bad reply stops at the attempt limit');
}
for (const bad of [response({}, 403), response({ error: { code: -32000, message: 'execution reverted' } })]) {
  let calls = 0;
  const { read } = virtual(async () => { calls++; return bad; });
  await reject(read(URL_A, 'eth_call', []), /403|execution reverted/, 'Permanent provider/contract errors are returned honestly');
  check(calls, 1, 'A permanent error is not retried against the rate limit');
}
{
  let calls = 0;
  const { read } = virtual(async () => { if (++calls === 1) throw new TypeError('Socket reset'); return success(null); });
  check(await read(URL_A, 'eth_getTransactionReceipt', []), null, 'A transient connection reset can recover to a legitimate null RPC result');
  check(calls, 2, 'A connection reset receives a bounded retry');
}

// Bound both fetch and response-body hangs; do not poison later refreshes.
for (const phase of ['network', 'body']) {
  let broken = true, signal;
  const read = create({ paceMs: 0, timeoutMs: 5, totalTimeoutMs: 100, maxAttempts: 1, retryBaseMs: 1,
    fetch: async (url, init) => {
      signal = init.signal;
      if (!broken) return success('0x20');
      if (phase === 'network') return new Promise(() => {});
      return { ...response(null), json: () => new Promise(() => {}) };
    },
  });
  await reject(read(URL_A, 'eth_blockNumber', []), /timed out/, 'A stalled ' + phase + ' is bounded');
  check(signal.aborted, true, 'A timed-out ' + phase + ' aborts the underlying fetch');
  broken = false;
  check(await read(URL_A, 'eth_blockNumber', []), '0x20', 'A later refresh recovers after a ' + phase + ' timeout, including the same dedup key');
}
{
  const gate = deferred(); let calls = 0;
  const read = create({ paceMs: 0, timeoutMs: 100, totalTimeoutMs: 200, maxAttempts: 1,
    fetch: async () => { calls++; if (calls === 1) await gate.promise; return success('0x30'); },
  });
  const active = read(URL_A, 'eth_call', ['active']);
  const queued = read(URL_A, 'eth_getLogs', ['expired'], { totalTimeoutMs: 5 });
  await reject(queued, /timed out/, 'A queued request has its own deadline while another request runs');
  check(calls, 1, 'An expired queued request never reaches the endpoint');
  gate.resolve(); await active;
  check(await read(URL_A, 'eth_getLogs', ['expired']), '0x30', 'The same request key can recover after queue expiry');
  check(calls, 2, 'Expired queue entries are skipped rather than sent later');
}

// Busy Robinhood pools must narrow overflowing log ranges instead of replaying
// the same rejected 100,000-block query. Disjoint leaves reconstruct one reading.
{
  const requests = [], matches = [];
  const filter = { address: ['0xpool-a', '0xpool-b'], topics: ['0xswap', null, ['0xwallet-a', '0xwallet-b']],
    fromBlock: '0x1', toBlock: '0x8' };
  const original = structuredClone(filter);
  const { read, clock } = virtual(async (url, init) => {
    const { method, params } = JSON.parse(init.body), query = params[0];
    check(method, 'eth_getLogs', 'Adaptive work remains an eth_getLogs query');
    check(query.address, filter.address, 'Every narrowed query preserves address alternatives');
    check(query.topics, filter.topics, 'Every narrowed query preserves topic positions and alternatives');
    const from = Number(BigInt(query.fromBlock)), to = Number(BigInt(query.toBlock));
    requests.push([from, to]);
    if (to - from > 1) return response({ error: { code: -32005, message: 'logs matched by query exceeds limit of 10000' } });
    const logs = Array.from({ length: to - from + 1 }, (_, i) => ({ blockNumber: '0x' + (from + i).toString(16),
      logIndex: '0x0', transactionHash: '0xtx-' + (from + i) }));
    matches.push(...logs.map(log => Number(BigInt(log.blockNumber))));
    return success(logs);
  });
  const logs = await read(URL_A, 'eth_getLogs', [filter]);
  check(logs.map(log => Number(BigInt(log.blockNumber))), [1, 2, 3, 4, 5, 6, 7, 8], 'Recursive range splits reconstruct the full ordered log result');
  check(matches, [1, 2, 3, 4, 5, 6, 7, 8], 'Inclusive child ranges cover every original block exactly once');
  check(requests, [[1, 8], [1, 4], [1, 2], [3, 4], [5, 8], [5, 6], [7, 8]], 'An overflow narrows immediately without retrying the same rejected range');
  check(filter, original, 'Adaptive queries do not mutate a caller’s original filter');
  check(clock.waits, [], 'A log-cap response does not trigger rate-limit backoff');
}

// A successful reply at the known cap could be truncated. Ask smaller ranges to
// establish completeness, and discard the possibly truncated parent response.
{
  const source = Array.from({ length: 10000 }, (_, i) => ({ blockNumber: '0x' + (1 + Math.floor(i / 2500)).toString(16),
    logIndex: '0x' + (i % 2500).toString(16), transactionHash: '0xtx-' + i }));
  const ranges = [];
  const { read } = virtual(async (url, init) => {
    const query = JSON.parse(init.body).params[0], from = Number(BigInt(query.fromBlock)), to = Number(BigInt(query.toBlock));
    ranges.push([from, to]);
    return success(source.filter(log => Number(BigInt(log.blockNumber)) >= from && Number(BigInt(log.blockNumber)) <= to));
  });
  check(await read(URL_A, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x4' }]), source, 'A cap-sized successful response is verified through smaller complete queries');
  check(ranges, [[1, 4], [1, 2], [3, 4]], 'The parent cap response is replaced by two disjoint child readings');
}

// Split requests still share the original pending work, and callers receive
// isolated copies rather than sharing the merged array or its log objects.
{
  const gate = deferred(), ranges = [];
  const { read } = virtual(async (url, init) => {
    const query = JSON.parse(init.body).params[0], from = Number(BigInt(query.fromBlock)), to = Number(BigInt(query.toBlock));
    ranges.push([from, to]);
    if (from !== to) { await gate.promise; return response({ error: { code: -32005, message: 'logs matched by query exceeds limit of 10000' } }); }
    return success([{ blockNumber: query.fromBlock, logIndex: '0x0', data: { amount: '123' } }]);
  });
  const params = [{ fromBlock: '0x5', toBlock: '0x6' }];
  const first = read(URL_A, 'eth_getLogs', params), second = read(URL_A, 'eth_getLogs', params);
  check(ranges, [[5, 6]], 'Concurrent overflow callers initially share one request');
  gate.resolve();
  const [one, two] = await Promise.all([first, second]);
  check(ranges, [[5, 6], [5, 5], [6, 6]], 'Concurrent overflow callers share the full split reconstruction');
  one[0].data.amount = 'changed';
  check(two[0].data.amount, '123', 'Merged adaptive results remain isolated between callers');
}

// A failed leaf invalidates the whole reading. Repeating the query later must
// retry its full range and must never reuse a successful partial branch.
{
  let broken = true;
  const ranges = [];
  const { read } = virtual(async (url, init) => {
    const query = JSON.parse(init.body).params[0], from = Number(BigInt(query.fromBlock)), to = Number(BigInt(query.toBlock));
    ranges.push([from, to]);
    if (from !== to) return response({ error: { code: -32005, message: 'logs matched by query exceeds limit of 10000' } });
    if (from === 2 && broken) return response({ error: { code: -32000, message: 'execution reverted' } });
    return success([{ blockNumber: query.fromBlock, logIndex: '0x0' }]);
  });
  const params = [{ fromBlock: '0x1', toBlock: '0x2' }];
  await reject(read(URL_A, 'eth_getLogs', params), /execution reverted/, 'A failed split branch cannot publish the other branch as complete logs');
  broken = false;
  check((await read(URL_A, 'eth_getLogs', params)).map(log => log.blockNumber), ['0x1', '0x2'], 'A later identical query recovers after a split-branch failure');
  check(ranges, [[1, 2], [1, 1], [2, 2], [1, 2], [1, 1], [2, 2]], 'Recovery reads both branches afresh after a partial failure');
}

// A single-block overflow cannot safely be split further. An explicit rejection
// and a cap-sized response both fail closed, without unbounded recursive work.
for (const cappedSuccess of [false, true]) {
  let calls = 0;
  const { read, clock } = virtual(async () => {
    calls++;
    return cappedSuccess ? success(Array.from({ length: 10000 }, () => ({ blockNumber: '0x8', logIndex: '0x0' })))
      : response({ error: { code: -32005, message: 'logs matched by query exceeds limit of 10000' } });
  });
  await reject(read(URL_A, 'eth_getLogs', [{ fromBlock: '0x8', toBlock: '0x8' }]), /log|limit|complete|split|range/i,
    'A single-block ' + (cappedSuccess ? 'saturated response' : 'overflow') + ' remains visibly unavailable');
  check(calls, 1, 'A single-block cap stops after one request');
  check(clock.waits, [], 'A single-block log cap does not back off as a rate limit');
}

// A numeric provider code alone cannot mean log overflow: quota failures still
// need ordinary bounded retry/backoff, while permanent errors do not split.
{
  let calls = 0;
  const ranges = [];
  const { read, clock } = virtual(async (url, init) => {
    calls++; ranges.push(JSON.parse(init.body).params[0]);
    return calls < 3 ? response({ error: { code: -32005, message: 'Request quota exceeded' } }) : success([]);
  });
  const params = [{ fromBlock: '0x1', toBlock: '0x8' }];
  check(await read(URL_A, 'eth_getLogs', params), [], 'An actual quota failure recovers through rate-limit retries');
  check(ranges, [params[0], params[0], params[0]], 'A quota error does not change the caller’s block range');
  check(clock.waits, [1000, 2000], 'Actual quota failures retain exponential backoff');
}
for (const bad of [response({}, 403), response({ error: { code: -32000, message: 'execution reverted' } })]) {
  let calls = 0;
  const { read } = virtual(async () => { calls++; return bad; });
  await reject(read(URL_A, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x8' }]), /403|execution reverted/, 'A permanent log-query error remains an honest failure');
  check(calls, 1, 'Permanent log-query errors do not spawn smaller ranges');
}

// Numeric range subdivision must not invent block boundaries for tags or a
// block-hash filter, and provider limits cannot create unlimited requests.
for (const query of [{ fromBlock: 'earliest', toBlock: 'latest' }, { blockHash: '0xblock' }]) {
  let calls = 0;
  const { read } = virtual(async () => {
    calls++;
    return response({ error: { code: -32005, message: 'logs matched by query exceeds limit of 10000' } });
  });
  await reject(read(URL_A, 'eth_getLogs', [query]), /log|limit|range/i, 'An overflowing nonnumeric log query fails without inventing a block range');
  check(calls, 1, 'An unsplittable tag or block-hash query stops after its actual failure');
}
{
  let calls = 0;
  const { read } = virtual(async () => {
    calls++;
    return response({ error: { code: -32005, message: 'logs matched by query exceeds limit of 10000' } });
  });
  await reject(read(URL_A, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x100000' }], { logMaxRequests: 2 }),
    /budget|request|limit|range/i, 'An oversized recursive split fails within its configured request budget');
  check(calls, 2, 'Split work never exceeds logMaxRequests');
}

// Narrowed queries use the paced endpoint queue, allowing a live state read to
// overtake background history work rather than waiting for an entire scan.
{
  const gate = deferred(), order = [];
  const { read } = virtual(async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    order.push(method === 'eth_getLogs' ? method + ':' + params[0].fromBlock + '-' + params[0].toBlock : method);
    if (order.length === 1) {
      await gate.promise;
      return response({ error: { code: -32005, message: 'logs matched by query exceeds limit of 10000' } });
    }
    return success(method === 'eth_getLogs' ? [{ blockNumber: params[0].fromBlock, logIndex: '0x0' }] : '0xlive');
  });
  const history = read(URL_A, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }]);
  const live = read(URL_A, 'eth_call', ['live']);
  gate.resolve();
  const [logs, state] = await Promise.all([history, live]);
  check(state, '0xlive', 'Foreground state reads still succeed while a log range subdivides');
  check(logs.map(log => log.blockNumber), ['0x1', '0x2'], 'Background work reconstructs complete logs after the foreground read');
  check(order, ['eth_getLogs:0x1-0x2', 'eth_call', 'eth_getLogs:0x1-0x1', 'eth_getLogs:0x2-0x2'],
    'A queued foreground read runs before newly created split children');
}

// Each child inherits the original logical reading’s deadline. Splitting may
// not reset the budget and turn a bounded browser read into a long scan.
{
  let calls = 0;
  const { read } = virtual(async (url, init, clock) => {
    calls++; clock.at += 6;
    const query = JSON.parse(init.body).params[0];
    if (query.fromBlock !== query.toBlock)
      return response({ error: { code: -32005, message: 'logs matched by query exceeds limit of 10000' } });
    return success([{ blockNumber: query.fromBlock, logIndex: '0x0' }]);
  }, { totalTimeoutMs: 10 });
  await reject(read(URL_A, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x4' }]), /deadline|timed out/,
    'Recursive work preserves the original total deadline');
  check(calls, 2, 'Once the original deadline passes, later split branches are never fetched');
}

// Independent scans can overlap on a raw child query. The shorter logical
// scan must time out without cancelling work still needed by the longer one.
{
  const parentGate = deferred(), childGate = deferred(), childStarted = deferred(), ranges = [];
  let childSignal;
  const read = create({ paceMs: 0, timeoutMs: 1000, totalTimeoutMs: 500, maxAttempts: 1,
    fetch: async (url, init) => {
      const query = JSON.parse(init.body).params[0];
      ranges.push([query.fromBlock, query.toBlock]);
      if (query.fromBlock !== query.toBlock) {
        await parentGate.promise;
        return response({ error: { code: -32005, message: 'logs matched by query exceeds limit of 10000' } });
      }
      childSignal = init.signal; childStarted.resolve();
      await childGate.promise;
      return success([{ blockNumber: query.fromBlock, logIndex: '0x0' }]);
    },
  });
  const shorter = read(URL_A, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }], { totalTimeoutMs: 20 });
  const longer = read(URL_A, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x1' }])
    .then(value => ({ value }), error => ({ error }));
  parentGate.resolve();
  await childStarted.promise;
  await reject(shorter, /timed out/, 'An overlapping shared child cannot extend the shorter logical deadline');
  check(childSignal.aborted, false, 'Timing out one logical scan does not abort another caller’s shared raw request');
  check(ranges, [['0x1', '0x2'], ['0x1', '0x1']], 'The overlapping child is fetched only once and the expired scan starts no later branch');
  childGate.resolve();
  check(await longer, { value: [{ blockNumber: '0x1', logIndex: '0x0' }] }, 'The longer independent caller still completes its valid reading');
}

{
  const ranges = [];
  const { read, clock } = virtual(async (url, init) => {
    ranges.push(JSON.parse(init.body).params[0]);
    return ranges.length === 1 ? response({ error: { code: -32005, message: 'log request rate limit exceeded' } }) : success([]);
  });
  const query = { fromBlock: '0x1', toBlock: '0x8' };
  check(await read(URL_A, 'eth_getLogs', [query]), [], 'Log-specific rate-limit wording still recovers through retry');
  check(ranges, [query, query], 'A log rate limit does not subdivide an otherwise valid block range');
  check(clock.waits, [1000], 'A log rate limit retains provider backoff');
}

console.log('RPC transport: ' + checks + ' assertions passed.');
