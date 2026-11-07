import assert from 'node:assert/strict';
import { CFG, VAULT } from '../api/_core.mjs';
import { readLPAutofillFunding, handleLPAutofillFunding } from '../api/_lp-autofill-funding.mjs';
import { prepareAutomaticLP, detectedLPPositions, validateAutomaticLP } from '../api/_agent-lp-autofill.mjs';
import { compareAgentStrategies, renderAgentStrategyResult } from '../api/_agent-scenarios.mjs';
import { reviewPolicy } from './fixtures/agent-review.mjs';
import { autofillContext, fundingFixture } from './fixtures/agent-lp-autofill.mjs';

let count = 0; const check = (a,b,n) => { assert.deepEqual(a,b,n); count++; };
const at = Date.now(), policy = reviewPolicy(), context = await autofillContext(at);
const calls = [], owner = CFG.wallets[0].address, hex = value => '0x' + BigInt(value).toString(16), data = value => ({ ok: true, data: '0x' + BigInt(value).toString(16).padStart(64, '0') });
const usd = VAULT.chains.katana.tokens.find(row => row.s === 'vbUSDC'), eth = VAULT.chains.katana.tokens.find(row => row.s === 'vbETH');
let failedStable = false, badPrice = false, old = false;
const readers = {
  readRpc: async (url, method, params) => {
    calls.push({ url, method, params });
    if (method === 'eth_blockNumber') return '0x64';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: hex(Math.floor((at - (old ? 120000 : 0)) / 1000)) };
    if (method === 'eth_getBalance') return hex(10n ** 18n);
    if (method === 'eth_gasPrice') return hex(10n ** 9n);
    throw Error('Unexpected or state-changing RPC');
  },
  readMulti: async (url, entries, tag) => {
    calls.push({ url, method: 'eth_call', entries, tag });
    if (entries[0]?.to === VAULT.pricePools.eth) return [data(BigInt(Math.round(Math.sqrt(10 ** 12 / 3000) * 2 ** 96))),
      data(BigInt(badPrice ? '0x' + '1'.repeat(40) : usd.a)), data(BigInt(eth.a))];
    return entries.map((entry,index) => index === 2 && failedStable ? { ok: false, data: '0x' } : data(index % 2 ? 6 : index ? 50000000 : 100000000));
  },
};
const before = globalThis.fetch; globalThis.fetch = () => { throw Error('No real network in LP autofill tests'); };
try {
  let funding = await readLPAutofillFunding({ chain: 'katana', owner, now: at, ...readers });
  check(funding.cashUsd, 150, 'Automatic cash sums same-wallet stablecoins, excluding the LP principal');
  check(funding.cashComplete, true, 'A cash total requires every configured stablecoin balance and decimals');
  check(Math.abs(funding.gasUsd - 6) <= .000001, true, 'Gas budget uses current gas price and the verified native-token quote');
  check(funding.gasBalanceSufficient, true, 'Gas affordability is checked separately from stablecoin cash');
  check(funding.nativePriceQuote.pool === VAULT.pricePools.eth && /^\d+$/.test(funding.nativePriceQuote.sqrtPriceX96), true, 'Gas-price conversion retains the original on-chain pool quote for audit');
  check(calls.filter(call => call.method === 'eth_call').every(call => call.tag === '0x64'), true, 'Balance and quote calls are pinned to a verified source block');
  check(calls.every(call => ['eth_blockNumber','eth_getBlockByNumber','eth_getBalance','eth_gasPrice','eth_call'].includes(call.method)), true, 'All automatic reads are read-only');
  failedStable = true; funding = await readLPAutofillFunding({ chain: 'katana', owner, now: at, ...readers });
  check(funding.cashUsd, null, 'One failed balance never becomes a complete smaller cash total or zero');
  check(funding.gasUsd > 0, true, 'Independent gas observations survive a failed balance read'); failedStable = false;
  badPrice = true; funding = await readLPAutofillFunding({ chain: 'katana', owner, now: at, ...readers });
  check(funding.gasUsd, null, 'Mismatched price-pool tokens cannot fabricate a gas quote'); badPrice = false;
  old = true; funding = await readLPAutofillFunding({ chain: 'katana', owner, now: at, ...readers });
  check(funding.status, 'unavailable', 'Old blocks are not labelled as live wallet funding'); old = false;
  const failedNative = await readLPAutofillFunding({ chain: 'arc', owner, now: at, ...readers,
    readRpc: (url,method,params) => method === 'eth_getBalance' ? Promise.reject(Error('Fixture unavailable')) : readers.readRpc(url,method,params) });
  check(failedNative.cashUsd, null, 'An unread Arc native-USDC balance cannot become zero cash');
  const beforeRejected = calls.length;
  for (const input of [{ chain: 'katana', owner: '0x' + '9'.repeat(40) }, { chain: 'http://127.0.0.1', owner }]) {
    await assert.rejects(() => readLPAutofillFunding({ ...input, now: at, ...readers }), error => error.status === 400); count++;
  }
  check(calls.length, beforeRejected, 'Unknown wallets/targets are rejected before RPC access');
  const response = { headers: {}, setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},end(text){this.value=JSON.parse(text);} };
  check(await handleLPAutofillFunding({ method: 'GET', query: {} }, response), false, 'Ordinary Strategy requests retain their original handler');
  await handleLPAutofillFunding({ method: 'GET', query: { view: 'lp-funding', chain: 'katana', owner } }, response,
    args => readLPAutofillFunding({ ...args, now: at, ...readers }));
  check(response.code, 200, 'The existing Strategy route serves the bounded funding reading');
  check(response.headers['cache-control'], 'no-store', 'Wallet funding does not acquire a stale shared cache label');

  const setup = await prepareAutomaticLP({ context, policy, now: at, readFunding: p => fundingFixture(p.owner, at) });
  check(setup.status, 'ready', 'A fresh open LP is ready without manual position IDs or financial fields');
  check(setup.inputs.cashUsd, 150, 'The comparison uses observed same-wallet cash');
  check(setup.inputs.owner, context.lp.positions[0].canonical.owner, 'Automatic position identity retains the wallet');
  check(setup.inputs.swapFeeBps, 5, 'Pool fee units are converted from millionths to basis points');
  check(setup.inputs.horizonDays, 7, 'The confirmed policy supplies the comparison horizon');
  check(setup.inputs.paths.length, 6, 'Automatic stress cases cross three price moves with current/no incentives');
  check(setup.fieldSources.slippageBps.basis, 'scenario', 'Slippage is disclosed as a scenario assumption, not an observed execution quote');
  check(setup.fieldSources.gasUsd.basis, 'estimate', 'Gas units are disclosed as a budget estimate');
  check(setup.inputs.comparisonBasis, 'before_financing', 'Unknown LP financing is excluded explicitly rather than fabricated as verified zero cost');
  const result = await compareAgentStrategies({ context, policy, input: setup.inputs, now: at });
  check(result.options.some(row => row.id === 'reposition' && row.outcomes?.some(out => out.netUsd !== null)), true, 'Automatic inputs run the real LP comparison arithmetic');
  check(renderAgentStrategyResult(result).includes('before borrowing costs'), true, 'The displayed values identify their financing scope');
  const adjusted = await prepareAutomaticLP({ context, policy, now: at, request: { positionKey: setup.position.key,
    overrides: { cashUsd: 100, gasUsd: 2, borrowingCostUsd: 5, horizonDays: 14 } }, readFunding: p => fundingFixture(p.owner, at) });
  check(adjusted.fieldSources.gasUsd.basis, 'owner', 'Owner overrides are never presented as automatic observations');
  check(adjusted.inputs.comparisonBasis, undefined, 'An explicit financing assumption uses the ordinary cost-inclusive case');
  check(adjusted.inputs.paths.every(path => path.points.at(-1).day === 14), true, 'Changing only the horizon updates every default price-path endpoint');
  const unknown = await prepareAutomaticLP({ context, policy, now: at, readFunding: () => { throw Error('Fixture provider outage'); } });
  check(unknown.inputs.cashUsd, null, 'A failed cash source remains unknown');
  check(unknown.inputs.gasUsd, null, 'A failed gas source is never zero');
  const unrelated = await prepareAutomaticLP({ context, policy, now: at,
    readFunding: () => fundingFixture('0x' + 'f'.repeat(40), at) });
  check(unrelated.inputs.cashUsd, null, 'A different wallet’s funding cannot populate the selected LP');
  const stale = await prepareAutomaticLP({ context, policy, now: at, readFunding: p => fundingFixture(p.owner, at - 120000) });
  check(stale.inputs.gasUsd, null, 'A stale funding reading cannot become a current gas estimate');
  const archived = structuredClone(context); archived.lp.positions[0].status = 'closed';
  check(detectedLPPositions(archived, at), [], 'Closed positions never appear in the open-position selector');
  await assert.rejects(() => prepareAutomaticLP({ context: archived, policy, now: at, request: { positionKey: setup.position.key } }), error => error.status === 409); count++;
  for (const request of [{ positionKey: 'https://evil.invalid' }, { positionKey: setup.position.key, overrides: { owner: 'foreign-wallet' } },
    { positionKey: setup.position.key, overrides: { slippageBps: -1 } }]) {
    assert.throws(() => validateAutomaticLP(request)); count++;
  }
  const duplicate = structuredClone(context), second = structuredClone(duplicate.lp.positions[0]);
  second.id = '1002'; second.canonical.id = second.canonical.positionId = '1002'; second.canonical.owner = '0x' + '2'.repeat(40);
  duplicate.lp.positions.push(second);
  const positions = detectedLPPositions(duplicate, at);
  const selected = await prepareAutomaticLP({ context: duplicate, policy, now: at, request: { positionKey: positions[1].key }, readFunding: p => fundingFixture(p.owner, at, { cashUsd: 200 }) });
  check(selected.inputs.owner, second.canonical.owner, 'Selecting a second wallet does not reuse the first wallet’s identity');
  check(selected.inputs.cashUsd, 200, 'Selecting a second position refreshes its own funding');
  check(JSON.stringify(context.lp.positions[0].canonical).includes('cashUsd'), false, 'Preparing a scenario never changes LP accounting');
  console.log('Automatic LP detection, funding and scenarios: ' + count + ' assertions passed.');
} finally { globalThis.fetch = before; }
