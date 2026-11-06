/* Actual D1 SQL plus the real policy helpers: previews, confirmation, races,
   persistence and immutable history. No model, bot or network is contacted. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentStore } from '../api/_agent-store.mjs';
import { getAgentPolicy, draftAgentPolicy, confirmAgentPolicy, listAgentPolicies, normalizeAgentPolicyPatch } from '../api/_agent-policy.mjs';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const rejects = async (run, status, note) => { await assert.rejects(run, error => error.status === status, note); checks++; };
const fixture = createAgentSQLiteFixture();
let at = Date.now() + 86400000;
const options = { now: () => at }, store = createAgentStore({ AGENT_DB: fixture.db }, options);
const reloaded = createAgentStore({ AGENT_DB: fixture.db }, options);
const owner = extra => ({ source: 'owner', now: () => at, ...extra });
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Policy tests must not contact a provider'); };
const pageBefore = readFileSync(new URL('../lending.js', import.meta.url), 'utf8');
try {
  await store.set('settings', { healthThreshold: 1.2, ltvThreshold: 70 });
  check(await getAgentPolicy(store), { schemaVersion: 'agent-policy.v1', version: 0, status: 'unconfirmed', constraints: {} },
    'Notification defaults never become an investment policy');
  for (const source of [undefined, 'model', 'research', 'quoted']) {
    await rejects(() => draftAgentPolicy(store, { horizonDays: 30 }, { source, expectedVersion: 0 }), 403,
      'Only the direct authenticated owner route can authorize a policy draft');
  }
  const patch = { horizonDays: 30, minLiquidReserveUsd: 100, exposureLimits: { KAT: 40 },
    eligibleAssets: ['KAT', 'vbUSDC'], eligibleProtocols: ['Morpho', 'Sushi V3'],
    marketLimits: { 'avkat-kat': { targetHealth: 1.5, maxLtvPct: 50 } },
    lpReviewTriggers: { outOfRange: true, rewardChangePct: 20 }, allowedAnalysisTypes: ['lending', 'lp', 'research'], reviewFrequencyDays: 7 };
  const first = await draftAgentPolicy(store, patch, owner({ expectedVersion: 0 }));
  check(first.status, 'draft', 'Drafting creates a preview rather than a confirmed mandate');
  check(first.changes.length, 9, 'The preview exposes every changed field');
  check(first.changes.find(row => row.field === 'horizonDays'), { field: 'horizonDays', before: null, after: 30 },
    'Unknown values stay unknown in the before/after preview');
  check((await getAgentPolicy(reloaded)).version, 0, 'A separate session still has no confirmed policy before confirmation');
  await rejects(() => confirmAgentPolicy(store, first.draftId, { source: 'model' }), 403, 'A model cannot confirm an owner preview');
  const confirmed = await confirmAgentPolicy(store, first.draftId, owner());
  check(confirmed.version, 1, 'Explicit confirmation creates the first immutable version');
  check(confirmed.constraints, patch, 'Only reviewed owner constraints are saved');
  check((await getAgentPolicy(reloaded)).constraints, patch, 'Policy persists through a separate store/session');
  check((await confirmAgentPolicy(reloaded, first.draftId, owner())).version, 1, 'A repeated confirmation is idempotent');
  check((await listAgentPolicies(store)).items.length, 1, 'Repeated confirmation creates one version');
  check((await store.get('settings')).healthThreshold, 1.2, 'Policy saves do not change notification settings');
  await rejects(() => draftAgentPolicy(store, { horizonDays: 60 }, owner({ expectedVersion: 0 })), 409,
    'An outdated editor cannot silently replace a newer policy');

  const superseded = await draftAgentPolicy(store, { horizonDays: 45 }, owner({ expectedVersion: 1 }));
  const latest = await draftAgentPolicy(reloaded, { horizonDays: 60 }, owner({ expectedVersion: 1 }));
  await rejects(() => confirmAgentPolicy(store, superseded.draftId, owner()), 409, 'A replaced preview cannot be confirmed');
  check((await confirmAgentPolicy(store, latest.draftId, owner())).version, 2, 'The current preview advances the version once');
  check((await store.get('policy:version:000000000001')).constraints.horizonDays, 30, 'Later policy edits preserve earlier versions');
  const page = await listAgentPolicies(store, { limit: 1 });
  check(page.items[0].version, 2, 'History pages newest versions first');
  check((await listAgentPolicies(store, { limit: 1, cursor: page.cursor })).items[0].version, 1, 'The history cursor resumes without losing a version');

  const held = await store.lock('policy', 30);
  await rejects(() => draftAgentPolicy(reloaded, { horizonDays: 90 }, owner({ expectedVersion: 2 })), 409,
    'Concurrent policy writers cannot bypass the short policy lease');
  await held.release();
  const expired = await draftAgentPolicy(store, { horizonDays: 90 }, owner({ expectedVersion: 2 }));
  at += 86400000;
  await rejects(() => confirmAgentPolicy(store, expired.draftId, owner()), 409, 'Expired previews require a new review');
  check((await getAgentPolicy(store)).version, 2, 'Expired previews cannot create a policy');

  const clear = await draftAgentPolicy(store, { minLiquidReserveUsd: null }, owner({ expectedVersion: 2 }));
  check(clear.changes[0], { field: 'minLiquidReserveUsd', before: 100, after: null }, 'Clearing a constraint is previewed explicitly');
  const cleared = await confirmAgentPolicy(store, clear.draftId, owner());
  check(Object.hasOwn(cleared.constraints, 'minLiquidReserveUsd'), false, 'A cleared preference becomes unknown rather than a guessed default');
  const tampered = await draftAgentPolicy(store, { horizonDays: 50 }, owner({ expectedVersion: 3 }));
  await store.set('policy:draft:' + tampered.draftId, { ...tampered, constraints: { horizonDays: 99 } });
  await rejects(() => confirmAgentPolicy(store, tampered.draftId, owner()), 409, 'Changed preview contents cannot be confirmed as though they were reviewed');

  for (const invalid of [
    { horizonDays: 0 }, { horizonDays: 1.5 }, { reviewFrequencyDays: 366 }, { minLiquidReserveUsd: -1 },
    { exposureLimits: { KAT: 101 } }, { exposureLimits: JSON.parse('{"__proto__":30}') },
    { eligibleAssets: ['KAT', 'kat'] }, { eligibleProtocols: ['Sushi; execute code'] },
    { marketLimits: { unknown: { targetHealth: 2 } } }, { marketLimits: { 'avkat-kat': { targetHealth: .99 } } },
    { marketLimits: { 'avkat-kat': { maxLtvPct: 77.01 } } }, { marketLimits: { 'kat-usdc': { maxLtvPct: 62.51 } } },
    { marketLimits: { 'kat-usdc': { maxLtvPct: 0 } } }, { marketLimits: { 'kat-usdc': { execute: true } } },
    { lpReviewTriggers: { arbitraryCode: 'x' } }, { allowedAnalysisTypes: ['trade'] }, { accessKey: 'secret' },
  ]) {
    await rejects(() => draftAgentPolicy(store, invalid, owner({ expectedVersion: 3 })), 400, 'Invalid or unrelated fields cannot enter a draft');
  }
  check(normalizeAgentPolicyPatch({ marketLimits: { 'avkat-kat': { targetHealth: 1, maxLtvPct: 77 }, 'kat-usdc': { maxLtvPct: 62.5 } } })
    .marketLimits['avkat-kat'].maxLtvPct, 77, 'Exact LLTV and health-one boundary values remain allowed');
  check(readFileSync(new URL('../lending.js', import.meta.url), 'utf8'), pageBefore, 'Persistent policy never edits the Lending per-visit page controls');
  console.log('Versioned strategy policy: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = realFetch; fixture.close(); }
