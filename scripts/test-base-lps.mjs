/* Synthetic, ABI-encoded Base chain. No real provider or wallet access. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { BASE } from '../base-config.mjs';
import { CFG, V3, BOOK_VERSION, pad, hx, v3Amounts, v3Candidates, tokenMeta, advanceBook,
  bookLiveRows, bookView, livePrices, feeTokensOf, rpc } from '../api/_core.mjs';
import { readBasePortfolio } from '../api/_base-portfolio.mjs';
import { positionIdentity } from '../portfolio-core.mjs';
import { buildUniLPAccounting, uniPortfolioPerformance } from '../uni-accounting.mjs';

let checks = 0;
const eq = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const ok = (value, note) => { assert.ok(value, note); checks++; };
const near = (a, b, note) => { assert.ok(Math.abs(a - b) < .025, note + ': ' + a + ' vs ' + b); checks++; };
const word = value => pad(BigInt.asUintN(256, BigInt(value)).toString(16));
const abi = (...values) => '0x' + values.map(word).join('');
const good = data => ({ ok: true, data }), bad = { ok: false, data: '0x' };
const symbol = value => abi(32, value.length) + Buffer.from(value).toString('hex').padEnd(64, '0');
const aggregate = results => {
  let tail = '', offsets = '';
  for (const result of results) { const bytes = result.data.slice(2);
    offsets += word(results.length * 32 + tail.length / 2);
    tail += word(result.ok ? 1 : 0) + word(64) + word(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0'); }
  return abi(32, results.length) + offsets + tail;
};
function calls(data) {
  const hex = data.slice(10), at = byte => hex.slice(byte * 2, byte * 2 + 64), n = Number(BigInt('0x' + at(32)));
  return Array.from({ length: n }, (_, i) => {
    const start = 64 + Number(BigInt('0x' + at(64 + i * 32))), bytes = start + Number(BigInt('0x' + at(start + 64))), size = Number(BigInt('0x' + at(bytes)));
    return { to: '0x' + at(start).slice(24), data: '0x' + hex.slice((bytes + 32) * 2, (bytes + 32 + size) * 2) };
  });
}
const main = CFG.wallets[0].address, vault = CFG.wallets[1].address,
  usdc = BASE.tokens.find(t => t.s === 'USDC'), uni = BASE.tokens.find(t => t.s === 'UNI'), weth = BASE.tokens.find(t => t.s === 'WETH');
const pool = '0x' + '3'.repeat(40), ethPool = '0x' + '4'.repeat(40), other = '0x' + '9'.repeat(40),
  tick = 255520, lo = tick - 1000, hi = tick + 1000, sqrt = BigInt(Math.round(1.0001 ** (tick / 2) * 2 ** 96)),
  L = 10n ** 15n, remaining = L * 9n / 10n, Q128 = 1n << 128n,
  now = Math.floor(Date.now() / 1000) * 1000, mint = { 7: 7001, 9: 10001 };
let head = 12000;
const price = 1 / ((Number(sqrt) / 2 ** 96) ** 2 * 10 ** (usdc.d - uni.d));
const amounts = liquidity => v3Amounts(liquidity, lo, hi, sqrt).map(n => BigInt(Math.round(n)));
const startAmounts = amounts(L), withdrawn = amounts(L / 10n);
const TR = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  INC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f',
  DEC = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4',
  COL = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const event = (topic, id, block, data, index = 1) => ({ address: BASE.npm, blockNumber: hx(block), logIndex: hx(index),
  transactionHash: '0x' + word(block), topics: [topic, '0x' + word(id)], data });
const events = [7, 9].flatMap(id => [
  { ...event(TR, id, mint[id], '0x', 0), topics: [TR, '0x' + word(0), '0x' + pad(id === 7 ? main : vault), '0x' + word(id)] },
  event(INC, id, mint[id], abi(L, ...startAmounts)),
]).concat([event(DEC, 7, 9000, abi(L / 10n, ...withdrawn), 0),
  event(COL, 7, 9000, abi(main, withdrawn[0] + 2000000n, withdrawn[1] + 10n ** 17n), 1)]);
const owners = owner => mode === 'empty' ? [] : owner === main ? ['7', ...Array.from({ length: 30 }, (_, i) => String(i + 100))] : ['9'];
let mode = 'complete', seen = [], chainWrong = true;
function contract(call, tag) {
  const sel = call.data.slice(0, 10), owner = '0x' + call.data.slice(34, 74), id = call.data.length >= 74 ? Number(BigInt('0x' + call.data.slice(-64))) : 0;
  seen.push({ ...call, tag });
  if (mode === 'failed-' + sel) return bad;
  if (sel === '0x70a08231') {
    if (call.to === BASE.npm) return good(abi(owners(owner).length));
    const amount = mode === 'empty' ? 0n : call.to === usdc.a ? 10000000n : call.to === uni.a ? 10n ** 18n : 0n;
    return good(abi(amount));
  }
  if (sel === '0x2f745c59') return good(abi(owners(owner)[id]));
  if (sel === '0x6352211e') {
    if (tag !== 'latest' && Number(BigInt(tag)) < (mint[id] || 0)) return bad;
    return good(abi(mode === 'transferred' && id === 7 ? other : id === 9 ? vault : main));
  }
  if (sel === '0x99fbab88') return good(abi(0, 0, usdc.a, uni.a, 3000, lo, hi,
    id === 7 ? remaining : id === 9 ? L : 0, 0, 0, id < 100 ? 2000000n : 0n, id < 100 ? 5n * 10n ** 17n : 0n));
  if (sel === '0x1698ee82') return good(abi(mode === 'zero-pool' ? 0 : call.data.includes(pad(weth.a)) ? ethPool : pool));
  if (sel === '0x95d89b41') return good(symbol(BASE.tokens.find(t => t.a === call.to)?.s || 'USDC'));
  if (sel === '0x313ce567') return good(abi(mode === 'invalid-decimals' ? 256 : BASE.tokens.find(t => t.a === call.to)?.d ?? 6));
  if (sel === '0x3850c7bd') return good(abi(mode === 'zero-price' ? 0 : call.to === ethPool ? BigInt(Math.round(Math.sqrt(2000 * 1e-12) * 2 ** 96)) : sqrt, tick));
  if (sel === '0x0dfe1681') return good(abi(call.to === ethPool ? weth.a : usdc.a));
  if (sel === '0xd21220a7') return good(abi(call.to === ethPool ? usdc.a : uni.a));
  if (sel === '0xf3058399' || sel === '0x46141319') return good(abi(0));
  if (sel === '0xf30dba93') return good(abi(0, 0, 0, 0));
  throw Error('Unexpected Base fixture selector ' + sel);
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  ok(BASE.rpcs.includes(url) || V3.some(ch => ch.rpc === url), 'Only configured chain RPCs are accessed');
  const { method, params } = JSON.parse(init.body); let result;
  if (mode === 'transport-failed') return { ok: false, status: 503 };
  if (method === 'eth_chainId') result = chainWrong && url === BASE.rpcs[0] ? '0x1' : hx(BASE.id);
  else if (method === 'eth_blockNumber') result = hx(head);
  else if (method === 'eth_getBlockByNumber') result = { number: params[0], timestamp: hx(now / 1000 - (head - Number(BigInt(params[0]))) * 2 - (mode === 'stale-block' ? 100 : 0)) };
  else if (method === 'eth_getBalance') result = mode === 'empty' ? '0x0' : hx(10 ** 16);
  else if (method === 'eth_call') {
    if (params[0].to.toLowerCase() === CFG.multicall.toLowerCase()) result = aggregate(calls(params[0].data).map(call => contract(call, params[1])));
    else result = contract(params[0], params[1]).data;
  } else if (method === 'eth_getLogs') {
    if (mode === 'log-failed') throw Error('fixture log failure');
    const q = params[0], from = Number(BigInt(q.fromBlock)), to = Number(BigInt(q.toBlock));
    assert.ok(to - from + 1 <= 50000, 'Base log windows stay within the verified public-provider limit');
    result = events.filter(e => Number(BigInt(e.blockNumber)) >= from && Number(BigInt(e.blockNumber)) <= to
      && q.topics.every((filter, i) => filter === null || filter === undefined || (Array.isArray(filter) ? filter.includes(e.topics[i]) : filter === e.topics[i])));
  } else throw Error('Unexpected Base fixture method ' + method);
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
};
try {
  eq(await rpc(CFG.baseRpc, 'eth_chainId', []), hx(8453), 'A provider on another chain is rejected before reading Base');
  chainWrong = false;
  seen = [];
  const mainRead = await readBasePortfolio({ now }), vaultRead = await readBasePortfolio({ address: vault, now });
  eq(mainRead.lp_positions.map(p => p.token_id), ['7'], 'Full NFT enumeration finds an open LP before 30 closed NFTs');
  eq(vaultRead.lp_positions.map(p => p.token_id), ['9'], 'The second wallet has its own independently discovered position');
  eq(mainRead.lp_positions[0].wallet, main, 'The main reading cannot include the vault wallet');
  eq(mainRead.lp_positions[0].pair, 'UNI / USDC', 'Address ordering is inverted into a human dollar quote');
  near(mainRead.wallet.balances.tokens.ETH.valueUSD, 20, 'Native Base ETH uses its pinned WETH/USDC price');
  near(mainRead.wallet.balances.tokens.UNI.valueUSD, price, 'Loose UNI uses the actual owned pool quote');
  near(mainRead.onchain_usd, 30 + price, 'Native gas, stablecoins and loose UNI count once');
  near(mainRead.lp_positions[0].fees_usd, 2 + .5 * price, 'Only verified owner fees are included');
  near(mainRead.total_usd, mainRead.onchain_usd + mainRead.lp_total_usd, 'The chain total includes wallet and whole LP value once');
  ok(seen.every(call => call.tag === hx(head)), 'Discovery, ownership, decimals, fees and wallet quotes are pinned to one block');
  eq(mainRead.read_at, new Date(now).toISOString(), 'The source block timestamp is preserved');
  for (const failure of ['0x2f745c59','0x99fbab88','0x6352211e','0x313ce567','0x3850c7bd','0xf3058399','0xf30dba93']) {
    mode = 'failed-' + failure; await assert.rejects(readBasePortfolio({ now })); checks++;
  }
  for (mode of ['invalid-decimals','zero-pool','zero-price','stale-block']) { await assert.rejects(readBasePortfolio({ now })); checks++; }
  mode = 'complete';
  eq((await readBasePortfolio({ now })).lp_positions.length, 1, 'A complete recovery restores the LP');
  mode = 'transferred'; eq((await readBasePortfolio({ now })).lp_positions.length, 0, 'Verified ownership transfer excludes the old owner');
  mode = 'empty'; eq((await readBasePortfolio({ now })).total_usd, 0, 'Verified empty holdings produce a real zero');
  mode = 'complete';
  const spoof = '0x' + 'a'.repeat(40), meta = await tokenMeta(V3.find(ch => ch.key === 'base'), [spoof, BASE.tokens.find(t => t.s === 'USDbC').a]);
  eq(meta[spoof].stable, false, 'An unknown contract named USDC is not a dollar anchor');
  eq(meta[BASE.tokens.find(t => t.s === 'USDbC').a].stable, true, 'The verified USDbC address is recognized');
  await assert.rejects(readBasePortfolio({ address: other, now })); checks++;

  const source = JSON.parse(readFileSync(new URL('../lpbook.json', import.meta.url), 'utf8'));
  // Simulate a pre-Base book even after real Base snapshots are committed later.
  delete source.last_block.base;
  source.positions = Object.fromEntries(Object.entries(source.positions).filter(([, p]) => p.chain !== 'base'));
  source.tokens = Object.fromEntries(Object.entries(source.tokens).filter(([, t]) => t.chain !== 'base'));
  delete source.started.chains.base; delete source.started.blocks.base;
  const before = JSON.stringify(source);
  const oldChains = JSON.stringify(Object.fromEntries(Object.entries(source.positions).filter(([, p]) => p.chain !== 'base')));
  const result = await advanceBook(source, { onlyChains: ['base'], maxWindows: 4 });
  eq(result.errors, {}, 'An existing version-9 book adds Base without a rebuild');
  eq(result.book.version, BOOK_VERSION, 'Book version is unchanged');
  eq(result.book.last_block.base, head, 'The new chain reaches head after replaying its original mint');
  eq(result.book.positions['base:7'].opened_block, mint[7], 'A new chain starts at the actual mint rather than after head');
  eq(result.book.positions['base:9'].wallet, vault, 'Base book includes the second wallet independently');
  eq(result.book.positions['base:7'].at_start, false, 'The current value is not invented as an opening cost');
  eq(result.book.positions['base:7'].fees['USDC@base'], 2, 'Collected withdrawal principal is excluded from fees');
  near(result.book.positions['base:7'].fees['UNI@base'], .1, 'Only the fee part of a mixed UNI collection is counted');
  near(result.book.positions['base:7'].claims[0].usd, 2 + .1 * price, 'Claim dollars use the event block quote');
  eq(JSON.stringify(Object.fromEntries(Object.entries(result.book.positions).filter(([, p]) => p.chain !== 'base'))), oldChains,
    'All original positions, reward allocations and frozen outcomes stay byte-for-byte unchanged');
  eq(JSON.stringify(source), before, 'The caller ledger is never mutated');
  const prices = await livePrices(result.book), live = await bookLiveRows({ ...result.book, positions: Object.fromEntries(Object.entries(result.book.positions).filter(([, p]) => p.chain === 'base')) });
  eq(live.errors, {}, 'Base live rows use the same verified LP reader');
  const view = bookView(result.book, { rows: live.rows, prices, merkl: {}, errors: {}, behind: { base: 0 } });
  ok(view.live.some(row => row.chain === 'base' && row.id === '#7'), 'The new Base position is visible in the real LP Book card view');
  near(view.cards.chains.base.value_usd, mainRead.lp_positions[0].liquidity_usd + vaultRead.lp_positions[0].liquidity_usd, 'Base card principal matches both independently read wallets');
  const earnings = buildUniLPAccounting(result.book, view);
  near(earnings.earnedUsd, 6 + 1.1 * price, 'UNI fee totals use actual claimed plus unclaimed owner fees across both LPs');
  near(earnings.earnedTokens.UNI, 1.1, 'UNI fee inventory includes unclaimed fees and excludes principal');
  near(earnings.earnedTokens.USDC, 6, 'USDC fee inventory includes unclaimed fees and excludes principal');
  near(earnings.netUsd, view.position_metrics.reduce((sum, metric) => sum + metric.pnlUsd, 0) + earnings.earnedUsd,
    'Actual LP Book net already contains all claimed and unclaimed fees');
  const afterClaim = structuredClone(result.book), afterRows = structuredClone(live.rows), claimed = afterClaim.positions['base:7'];
  claimed.fees['USDC@base'] += 2; claimed.fees['UNI@base'] += .5;
  claimed.claims.push({ block: head, ts: now / 1000, tokens: { 'USDC@base': 2, 'UNI@base': .5 }, usd: 2 + .5 * price, prices });
  afterRows['base:7'].raw.fee0 = 0; afterRows['base:7'].raw.fee1 = 0;
  const afterEarnings = buildUniLPAccounting(afterClaim, bookView(afterClaim, { rows: afterRows, prices, merkl: {}, errors: {}, behind: { base: 0 } }));
  near(afterEarnings.earnedUsd, earnings.earnedUsd, 'Claiming existing earnings cannot increase total LP fees');
  near(afterEarnings.netUsd, earnings.netUsd, 'Claiming existing earnings cannot increase P&L');
  const emptyWallets = ['base', 'bnb'].flatMap(chain => CFG.wallets.map(wallet => ({ chain, owner: wallet.address, uni: 0 })));
  near(uniPortfolioPerformance({ lp: earnings, wallets: emptyWallets }).pnlUsd, earnings.netUsd,
    'The UNI page adds no extra fee amount on top of LP Book net');
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ holdings: mainRead, vaultHoldings: vaultRead,
    view: { ...bookView({ ...result.book, positions: Object.fromEntries(Object.entries(result.book.positions).filter(([, p]) => p.chain === 'base')) },
      { rows: live.rows, prices, merkl: {}, errors: {}, behind: { base: 0 } }), generated: new Date(now).toISOString() } }));
  near(feeTokensOf(result.book.positions['base:7'], { 'USDC@base': 2, 'UNI@base': .5 })['USDC@base'], 4, 'Earned fees combine claims and outstanding owner fees');
  const second = await advanceBook(result.book, { onlyChains: ['base'], maxWindows: 4 });
  eq(second.book.positions['base:7'], result.book.positions['base:7'], 'A repeat refresh cannot replay deposits or collections twice');
  const savedHead = head;
  head += 150000; // A cold function after an ordinary six-hour snapshot gap.
  const caughtUp = await advanceBook(result.book, { onlyChains: ['base'], maxWindows: 4 });
  eq(caughtUp.errors, {}, 'Base catches up a six-hour backlog without provider errors');
  eq(caughtUp.behind.base, 0, 'Four live windows cover the Base backlog on the first request');
  eq(caughtUp.book.last_block.base, head, 'The complete Base cursor reaches the pinned head');
  eq(caughtUp.book.positions, result.book.positions, 'Catch-up never rewrites existing deposits, fees, claims or frozen outcomes');
  head = savedHead;
  mode = 'log-failed';
  const failed = await advanceBook(source, { onlyChains: ['base'], maxWindows: 4 });
  ok(!!failed.errors.base, 'A failed bootstrap reports Base as incomplete');
  eq(failed.book.last_block.base, undefined, 'A failed bootstrap never advances a missing cursor');
  eq(failed.book.positions['base:7'], undefined, 'Partial chain replay is rolled back');
  mode = 'complete'; eq((await advanceBook(failed.book, { onlyChains: ['base'], maxWindows: 4 })).book.last_block.base, head,
    'The next successful read retries discovery and recovers automatically');
  const future = structuredClone(source); future.last_block.base = 7000;
  mode = 'failed-0x99fbab88';
  const missingMint = await advanceBook(future, { onlyChains: ['base'], maxWindows: 4 });
  ok(!!missingMint.errors.base, 'An unreadable new mint cannot become a successful empty window');
  eq(missingMint.book.last_block.base, 7000, 'A failed new-position description cannot skip its mint block');
  mode = 'complete';
  ok((await advanceBook(missingMint.book, { onlyChains: ['base'], maxWindows: 4 })).book.positions['base:7'], 'A later successful read still discovers the previously unreadable mint');
  mode = 'transport-failed'; await assert.rejects(readBasePortfolio({ now })); checks++;
  mode = 'complete'; eq((await readBasePortfolio({ now })).lp_positions.length, 1, 'Temporary RPC outages recover without dropping the Base LP');
  const identity = { protocolContract: BASE.npm, positionId: '7', owner: main };
  ok(positionIdentity({ ...identity, chain: 'base' }) !== positionIdentity({ ...identity, chain: 'katana' }), 'The same token ID on different chains is a different asset');
  ok(positionIdentity({ ...identity, chain: 'base' }).startsWith('8453:'), 'Canonical portfolio identities retain the real Base chain ID');
  console.log('Base wallet discovery, pinned valuation, additive book replay and recovery: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = originalFetch; }
