/* Canonical accounting and provenance using actual producer shapes. No network. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalPortfolioSnapshot, buildPortfolioSnapshot, compactLPPositions, positionIdentity,
  comparablePortfolioPerformance } from '../portfolio-core.mjs';
import { loadAgentContext, calculateAgentLending } from '../api/_agent-context.mjs';
import { MARKETS, WALLET } from '../morpho-core.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const saved = JSON.parse(readFileSync(new URL('../data.json', import.meta.url)));
const lending = JSON.parse(readFileSync(new URL('../morpho-history.json', import.meta.url))).samples.at(-1);
const NOW = lending.ts * 1000 + 1000, TS = new Date(NOW - 1000).toISOString();
const vault = saved.vault.address, contract = '0x2659c6085d26144117d904c46b48b6d180393d27';
const health = { errors: {}, unread: [], unpriced: [], behind: { katana: 0, robinhood: 0 } };
const row = extra => ({ id: 'wallet:KAT', chain: 'katana', owner: WALLET, scope: 'main', kind: 'wallet',
  rawAmount: '100000000000000000000', decimals: 18, valueUsd: 100, priceUsd: 1, observedAt: TS,
  block: 123, basis: 'live', complete: true, sourceId: 'wallet', ...extra });
const coverage = [{ id: 'wallet', ts: TS, block: 123, basis: 'live', complete: true }];
const canonical = observations => canonicalPortfolioSnapshot({ observations, coverage, requiredSources: ['wallet'], now: NOW });
const oldFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Canonical portfolio tests cannot access a provider'); };
try {
  const single = await canonical([row({})]);
  check(single.status, 'complete', 'A complete current observation set can produce a canonical NAV');
  check(single.navUsd, 100, 'The canonical NAV is the asset subtotal less debt');
  check(single.allocationBlocked, false, 'Only complete coverage permits portfolio-wide allocation');
  const repeated = await canonicalPortfolioSnapshot({ observations: [row({})], coverage, requiredSources: ['wallet'], now: NOW + 1000 });
  check(repeated.snapshotId, single.snapshotId, 'Polling time alone cannot change an input snapshot ID');
  check((await canonical([row({ valueUsd: 101 })])).snapshotId !== single.snapshotId, true, 'A valuation change produces a different immutable input ID');
  check(single.chainObservations.katana[0].block, 123, 'Pinned blocks retain per-chain provenance');
  check(single.chainObservations.robinhood.length, 0, 'An unrelated chain does not inherit a synchronized block');
  const empty = await canonicalPortfolioSnapshot({ observations: [], coverage, requiredSources: ['wallet'], now: NOW });
  check(empty.navUsd, 0, 'A verified empty portfolio can be complete without fabricating an asset');
  check(empty.status, 'complete', 'Successfully verified emptiness differs from missing coverage');
  check((await canonicalPortfolioSnapshot({ observations: [], coverage: [], requiredSources: ['wallet'], now: NOW })).navUsd, null,
    'Absent inputs never become a verified zero NAV');
  check((await canonical([row({ observedAt: NOW - 1000 })])).assets[0].observedAt, TS, 'Canonical millisecond timestamps do not become far-future dates');

  const id = positionIdentity({ chain: 'katana', protocolContract: contract, positionId: '42', owner: WALLET });
  check(positionIdentity({ chain: 'katana', protocolContract: contract.toUpperCase().replace('0X', '0x'), positionId: '#42', owner: WALLET.toUpperCase().replace('0X', '0x') }), id, 'Address case and display # do not change economic identity');
  check(positionIdentity({ chain: 'robinhood', protocolContract: contract, positionId: '42', owner: WALLET }) !== id, true, 'Position IDs on different chains cannot collide');
  check(positionIdentity({ chain: 'katana', protocolContract: contract, positionId: '42', owner: vault }) !== id, true, 'Different owners never share the same position identity');
  check(positionIdentity({ chain: 'katana', protocolContract: contract, positionId: '42', owner: 'Main' }), null, 'A display label is not accepted as an owner address');
  const solanaId = positionIdentity({ chain: 'solana', protocolContract: 'ProgramAbc', positionId: 'NftAbc', owner: 'WalletAbc' });
  check(positionIdentity({ chain: 'solana', protocolContract: 'Programabc', positionId: 'NftAbc', owner: 'WalletAbc' }) !== solanaId, true,
    'Solana program address case remains part of economic identity');
  check(positionIdentity({ chain: 'solana', protocolContract: 'ProgramAbc', positionId: 'Nftabc', owner: 'WalletAbc' }) !== solanaId, true,
    'Solana position address case cannot collide');
  const deduped = await canonical([row({ id, kind: 'lp' }), row({ id, kind: 'lp' })]);
  check(deduped.assets.length, 1, 'Wallet and staker discovery of the same NFT counts one asset');
  check(deduped.navUsd, 100, 'Duplicate discovery cannot inflate principal');
  const newer = await canonical([row({ id, observedAt: new Date(NOW - 60000).toISOString(), valueUsd: 90 }), row({ id, valueUsd: 110 })]);
  check(newer.navUsd, 110, 'A newer compatible fresh valuation replaces an earlier fresh observation');
  const collision = await canonical([row({ id }), row({ id, valueUsd: 200 })]);
  check(collision.status, 'unreconciled', 'Conflicting same-observation valuations are a reconciliation failure');
  check(collision.navUsd, null, 'A conflicting valuation cannot produce complete NAV');

  const receipt = await canonical([row({ id: 'receipt', symbol: 'avKAT', valueUsd: 500 }),
    row({ id: 'underlying', kind: 'exposure', representationOf: 'receipt', symbol: 'KAT', valueUsd: 700 }),
    row({ id: 'debt', kind: 'debt', valueUsd: 200 })]);
  check(receipt.navUsd, 300, 'Receipt assets and their represented underlying are never both added to NAV');
  check(receipt.exposures[0].valueUsd, 700, 'Look-through exposure remains available for risk analysis');
  check(receipt.liabilities.length, 1, 'Accrued debt has one separate liability representation');
  const claimed = await canonical([row({ id: 'wallet', valueUsd: 20 }), row({ id: 'reward', kind: 'reward',
    earnedRaw: '30', claimedRaw: '20', decimals: 0, priceUsd: 1, valueUsd: 30 })]);
  check(claimed.navUsd, 30, 'Claimed rewards already in the wallet are removed from claimable rewards');
  check(claimed.assets.find(a => a.id === 'reward').rawAmount, '10', 'Reward subtraction keeps exact native units');
  const corrupt = await canonical([row({ kind: 'reward', earnedRaw: '10', claimedRaw: '20', decimals: 0 })]);
  check(corrupt.navUsd, null, 'An invalid reward history does not fabricate negative rewards or a complete total');
  const locked = await canonical([row({ kind: 'locked', restriction: '60-day exit window' })]);
  check(locked.liquidityRestrictions[0].restriction, '60-day exit window', 'Locked capital is explicitly distinguished from liquid wealth');
  const unknown = await canonical([row({ valueUsd: null, rawAmount: '123456', decimals: 6 })]);
  check(unknown.assets[0].valueUsd, null, 'An unread price remains unknown rather than zero');
  check(unknown.unpriced[0].rawAmount, '123456', 'Unpriced native amounts remain visible');
  check(unknown.navUsd, null, 'A subtotal is never presented as complete NAV');
  check((await canonical([row({ block: null })])).reasons.includes('valuation_block_unavailable'), true,
    'Missing pinned valuation provenance blocks a supposedly complete snapshot');
  const stale = await canonical([row({ observedAt: new Date(NOW - 90001).toISOString() })]);
  check(stale.status, 'stale', 'An old asset cannot acquire request freshness');
  check(stale.verifiedSubtotalUsd, 0, 'Historical observations are excluded from the current verified subtotal');
  const missing = await canonicalPortfolioSnapshot({ observations: [row({})], coverage: [], requiredSources: ['wallet'], now: NOW });
  check(missing.missingCoverage[0].reason, 'source_unavailable', 'Missing coverage is machine readable');
  check(missing.allocationBlocked, true, 'A verified market does not authorize allocation across missing portfolio sources');

  const book = { last_block: { katana: 12345 }, positions: { 'katana:42': { id: '42', key: 'katana:42', chain: 'katana',
    wallet: WALLET, pool: 'pool-address', status: 'open' }, 'katana:old': { status: 'closed', cost_usd: 999999 } } };
  const live = { 'katana:42': { protocol: 'SushiSwap V3', liquidity_usd: 123.45, value_usd: 99999, fees_usd: 10000,
    fees_mine: false, staked: true, in_range: true, amounts: { vbWBTC: .001, vbUSDC: 50 },
    range: { lower: 90000, now: 100000, upper: 110000, quote: 'vbUSDC' },
    raw: { liq: '12345678901234567890', sqrt: '123456', lo: 1, hi: 2,
      t0: { a: contract, s: 'vbWBTC', d: 8 }, t1: { a: contract, s: 'vbUSDC', d: 6 } } } };
  const compact = compactLPPositions(book, live, { generated: TS, contracts: { katana: contract } });
  check(compact.length, 1, 'Closed positions and repeated historical capital never enter current wealth');
  check(compact[0].principalUsd, 123.45, 'Canonical principal uses numeric producer value, never formatted UI or cumulative earnings');
  check(compact[0].owner, WALLET, 'The compact producer carries the actual owner address');
  check(compact[0].raw.liquidity, '12345678901234567890', 'LP liquidity does not lose integer precision');
  check(compact[0].raw.token0.decimals, 8, 'The producer retains token unit metadata');
  check(compact[0].block, null, 'An event-ledger block is not invented as a pinned valuation block');
  check(compact[0].ledgerBlock, 12345, 'The actual event cursor remains available under its honest name');
  check(compactLPPositions(book, {}, { generated: TS, contracts: { katana: contract } })[0].status, 'unavailable', 'A missing position read cannot become an empty or zero-valued position');
  check(compactLPPositions({ positions: {} }, {}).length, 0, 'A successfully verified empty book remains distinct from a failed row');
  check(compactLPPositions(book, live, { generated: TS })[0].contract, null, 'Missing contract metadata is not inferred from labels');

  const lp = { generated: TS, health, cards: { value_usd: 123.45, unclaimed_usd: 7, open: 1 }, position_data: compact };
  const combined = await buildPortfolioSnapshot({ saved, lending, lp, now: NOW, mainOwner: WALLET,
    expectedMarketIds: MARKETS.map(m => m.id) });
  check(combined.navUsd, null, 'Fresh lending and LP data cannot turn saved wallets into a current full NAV');
  check(combined.assets.find(a => a.kind === 'lp').valueUsd, 123.45, 'LP value matches the LP Book principal exactly');
  check(combined.assets.find(a => a.kind === 'lp').metadata.feesMine, false, 'Staked fee routing stays explicit in the canonical asset');
  check(combined.assets.find(a => a.kind === 'reward').valueUsd, 7, 'Only outstanding open-position rewards are included, once');
  check(combined.assets.every(a => a.valueUsd !== 10000), true, 'Katana DAO trading fees cannot enter owner wealth');
  check(combined.liabilities.length, lending.markets.filter(m => !m.no_position).length, 'Each active lending debt is counted once, without saved net lending duplication');
  check(combined.savedReference.mainUsd, saved.summary.grand_total_usd, 'The main saved reference retains the original recorded scope');
  check(combined.savedReference.vaultUsd, saved.vault.total_usd, 'Tiger Vault is a separate reference rather than duplicated inside main');
  check(combined.assets.filter(a => a.scope === 'vault').every(a => a.owner === vault), true, 'Vault identity never depends on display labels');
  check(combined.missingCoverage.some(m => m.sourceId === 'unclaimed_rewards'), true, 'Closed or non-LP reward coverage is not falsely claimed complete');
  check(combined.reconciliation.lp.status, 'matched', 'Fresh canonical principal reconciles to the matching LP Book observation');
  const mismatch = await buildPortfolioSnapshot({ saved, lending, lp: { ...lp, cards: { ...lp.cards, value_usd: 999 } }, now: NOW, mainOwner: WALLET });
  check(mismatch.status, 'unreconciled', 'A fresh LP subtotal mismatch cannot be silently accepted');
  check(mismatch.snapshotId !== combined.snapshotId, true, 'Reconciliation inputs participate in snapshot identity');
  const badIdentity = await buildPortfolioSnapshot({ lp: { ...lp, position_data: [{ ...compact[0], owner: 'Main' }] }, now: NOW });
  check(badIdentity.coverage.find(s => s.id === 'lp').complete, false, 'Invalid LP ownership cannot falsely claim complete LP coverage');
  check(badIdentity.missingCoverage.some(s => s.sourceId === 'lp'), true, 'An invalid compact identity is visibly missing coverage, never a zero position');
  const failedLending = structuredClone(lending); failedLending.markets[0].error = 'read failed';
  const failed = await buildPortfolioSnapshot({ saved, lending: failedLending, lp, now: NOW, mainOwner: WALLET });
  check(failed.missingCoverage.some(m => m.sourceId === 'lending'), true, 'A failed market remains visible as missing coverage');
  check(failed.liabilities.some(m => m.positionId === failedLending.markets[0].id), false, 'A failed market does not fabricate a zero debt record');
  const legacy = await buildPortfolioSnapshot({ saved, lp: { ...lp, position_data: undefined }, now: NOW, mainOwner: WALLET });
  check(legacy.assets.find(a => a.kind === 'lp').scope, 'combined', 'Legacy aggregate amounts cannot imply unverified ownership');
  check(legacy.missingCoverage.some(m => m.sourceId === 'lp'), true, 'Legacy LP metadata gaps block portfolio allocation');

  check(comparablePortfolioPerformance({ before: { valueUsd: 100 }, after: { valueUsd: 200 },
    flows: [{ kind: 'deposit', usd: 100 }], coverageComparable: true }).pnlUsd, 0, 'An external deposit is not investment profit');
  check(comparablePortfolioPerformance({ before: { valueUsd: 200 }, after: { valueUsd: 100 },
    flows: [{ kind: 'withdrawal', usd: 100 }], coverageComparable: true }).pnlUsd, 0, 'An external withdrawal is not investment loss');
  const migration = comparablePortfolioPerformance({ before: { valueUsd: 100 }, after: { valueUsd: 100 },
    flows: [{ kind: 'lp_open', usd: 100 }, { kind: 'internal_transfer', usd: 100 }], coverageComparable: true });
  check(migration.pnlUsd, 0, 'LP movements and internal transfers are not external flows');
  check(migration.timeWeightedReturn, null, 'Missing intraperiod valuations cannot support a manufactured time-weighted return');
  const gap = comparablePortfolioPerformance({ before: { valueUsd: 200 }, after: { valueUsd: 100 }, flows: [] });
  check(gap.wealthChangeUsd, -100, 'The observable wealth difference remains available with an honest definition');
  check(gap.pnlUsd, null, 'Coverage changes are never hidden as a comparable investment loss');
  check(comparablePortfolioPerformance({ before: { valueUsd: 1 }, after: { valueUsd: 2 }, coverageComparable: true }).reason,
    'cash_flows_unverified', 'A lack of cash-flow records is not taken to mean zero deposits');

  const values = { '/data.json': saved, '/api/morpho': { ...lending, full: true }, '/api/lpbook': lp,
    '/history.json': JSON.parse(readFileSync(new URL('../history.json', import.meta.url))) };
  const before = JSON.stringify(values);
  const context = await loadAgentContext({ origin: 'https://fixture.test', now: NOW,
    fetcher: async url => new Response(JSON.stringify(values[new URL(url).pathname]), { headers: { 'content-type': 'application/json' } }) });
  check(context.snapshot.snapshotId.startsWith('portfolio:'), true, 'The actual context adapter carries the canonical snapshot ID');
  check(context.snapshot.allocationBlocked, true, 'Context prevents portfolio-wide sizing on mixed current and saved data');
  check(context.history.performance.pnlUsd, null, 'Legacy daily history cannot silently become verified P&L');
  check(calculateAgentLending(context, { market: 'avkat-kat', targetHealth: 1.5 }, { now: NOW }).available, true,
    'An unaffected fresh market calculation remains available despite portfolio coverage gaps');
  check(JSON.stringify(values), before, 'Canonical context never rewrites snapshots, reward attribution or financial history');
  console.log('Canonical agent portfolio: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = oldFetch; }
