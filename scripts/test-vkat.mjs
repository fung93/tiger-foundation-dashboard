/* The vKAT page's book, checked offline against Alex's real votes and vote rewards
   (scripts/fixtures/vkat-2026-11.json, recorded 1 Nov 2026) and a few made-up cases.
   No network. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voteFromLog, epochVotes, standingVotes, bribeRows, voteBook, validateLedger, emptyLedger, epochOf, epochStart, voteClose,
  PER_YEAR, VOTE_TOPIC, RESET_TOPIC } from '../vkat-core.mjs';

let checks = 0;
const ok = (v, note) => { assert.ok(v, note); checks++; };
const eq = (a, b, note) => { assert.deepEqual(a, b, note); checks++; };
const near = (a, b, tol, note) => { assert.ok(Math.abs(a - b) <= tol, `${note}: ${a} vs ${b}`); checks++; };

const fx = JSON.parse(readFileSync(new URL('./fixtures/vkat-2026-11.json', import.meta.url), 'utf8'));
const W = '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1';
const POOL = { ethUsdc: '0x2a2c512beaa8eb15495726c235472d82effb7a6b', btcUsdc: '0x744676b3ced942d78f9b8e9cd22246db5c32395c',
  weeth: '0xdfc0ba24be7f93bf1a9401635815ece4cc579282', kat3: '0x6d8a30f4b2501de8f0b443cb11eb512f12d5355f', kat05: '0x10045367e619caae6f60cc80046c43c6cd55f629' };

/* the gauge voter's events */
const events = fx.logs.map((l) => voteFromLog(l)).filter(Boolean);
eq(events.length, 45, 'all 45 vote and reset events decode');
eq([events.filter((e) => e[3] === 1).length, events.filter((e) => e[3] === 0).length], [23, 22], '23 votes, 22 resets');
ok(events.every((e) => e[7] === W), 'every one names the main wallet');
eq(voteFromLog({ ...fx.logs[0], topics: ['0x' + '1'.repeat(64), ...fx.logs[0].topics.slice(1)] }), null, 'another event is not a vote');
assert.throws(() => voteFromLog({ ...fx.logs[0], blockTimestamp: '0x0' }), /block time/); checks++;

/* each epoch's vote: the allocation with the most vKAT behind it, the latest if equal */
const epochs = epochVotes(events, 1482);
eq(epochs.map((e) => [e.epoch, e.pools.map((p) => p.gauge), Math.round(e.total)]), [
  [1473, [POOL.ethUsdc], 130897],
  [1474, [POOL.weeth], 144027],     /* four pools in a week; weETH/vbETH stood last, with the most */
  [1475, [POOL.kat3], 146559],
  [1476, [POOL.btcUsdc], 148286],
  [1477, [POOL.kat05], 149868],
  [1478, [POOL.ethUsdc], 151262],
  [1479, [POOL.btcUsdc], 257872],   /* after the 9 Sep merge of 106,610 KAT */
  [1480, [POOL.ethUsdc], 257872],
  [1481, [POOL.ethUsdc], 257872],
  [1482, [POOL.btcUsdc], 257872],
], 'ten epochs, each with the pool its rewards came from');
eq(standingVotes(events).map((s) => [s.gauge, +s.votes.toFixed(2)]), [[POOL.btcUsdc, 257871.86]], 'the vote standing now');

/* made-up: a vote carries into the next epoch; a lock moved out after the vote does not hide it; two locks on one pool add up */
const ev = (block, kind, gauge, epoch, votes) => [block, 0, epochStart(epoch) + block, kind, gauge, epoch, votes, W];
const carried = epochVotes([ev(1, 1, POOL.ethUsdc, 10, 100)], 12);
eq(carried.map((e) => [e.epoch, e.total]), [[10, 100], [11, 100], [12, 100]], 'a vote stands until it is changed');
const moved = epochVotes([ev(1, 1, POOL.ethUsdc, 10, 100), ev(2, 0, POOL.ethUsdc, 10, 100)], 11);
eq(moved.map((e) => [e.epoch, e.total]), [[10, 100]], 'reset after voting: the epoch still counts, the next does not');
const two = epochVotes([ev(1, 1, POOL.ethUsdc, 10, 100), ev(2, 1, POOL.ethUsdc, 10, 50)], 10);
eq(two[0].pools, [{ gauge: POOL.ethUsdc, votes: 150 }], 'two locks on one pool add up');
const split = epochVotes([ev(1, 1, POOL.ethUsdc, 10, 60), ev(1, 1, POOL.btcUsdc, 10, 40)], 10);
eq(split[0].pools.map((p) => p.votes), [60, 40], 'a split vote keeps both pools, the bigger first');

/* Merkl's vote rewards */
const rows = bribeRows(fx.merkl, W);
eq(rows.length, 24, 'the 24 vote rewards with something in them');
ok(rows.every((r) => /^0x[0-9a-f]{64}$/.test(r.campaign) && r.amount > 0), 'each with its campaign and an amount');
ok(!rows.some((r) => r.gauge === POOL.btcUsdc && r.token === 'KAT'), 'LP rewards (SUSHI_SWAP) are left out');
near(rows.filter((r) => r.token === 'vbUSDC').reduce((s, r) => s + r.amount, 0), 108.775046, 1e-9, 'vbUSDC from voting');
eq([...new Set(rows.map((r) => r.id))].sort(), [19560, 20080, 20455, 21641, 22124, 22447, 22712], 'the vKAT locks paid');

/* the book from the saved ledger */
const L = validateLedger(structuredClone(fx.ledger));
const rewards = L.rewards.map((r) => ({ ...r, epoch: epochOf(L.campaigns[r.campaign][1] - 1) }));
const book = voteBook(L.events, rewards, L.kat_usd, 1482, voteClose(1482) + 3600);
eq(book.voted, 10, 'ten epochs voted');
near(book.total_usd, rewards.reduce((s, r) => s + r.usd, 0), 1e-9, 'the total is every reward at its payout price');
near(book.total_usd, 113.62, 0.01, 'which came to $113.62');
eq(book.claimed, true, 'all claimed');
near(Object.values(book.tokens_usd).reduce((s, v) => s + v, 0), book.total_usd, 1e-9, 'the breakdown by token adds up to the total');
near(book.tokens_usd.vbUSDC, 108.775046, 1e-6, 'vbUSDC counts at a dollar');
const e1474 = book.epochs.find((e) => e.epoch === 1474);
near(e1474.usd, 29.222730, 1e-6, 'epoch 1474: the weETH/vbETH vote paid 29.22 vbUSDC, though its campaign began hours before the epoch');
near(e1474.rate, e1474.usd / (e1474.total * L.kat_usd[1474]), 1e-15, 'an epoch\'s rate is its reward over the vKAT that voted, at that epoch\'s KAT price');
near(e1474.apy, Math.pow(1 + e1474.rate, PER_YEAR) - 1, 1e-12, 'APY compounds it over 26 epochs a year');
near(e1474.apr, e1474.rate * PER_YEAR, 1e-12, 'APR does not');
const settled = book.epochs.filter((e) => e.settled && e.value_usd);
near(book.rate, settled.reduce((s, e) => s + e.usd, 0) / settled.reduce((s, e) => s + e.value_usd, 0), 1e-15, 'the average weighs each epoch by its vKAT\'s value');
near(book.apy, 0.407, 0.001, 'about 40.7% APY across the ten epochs');
eq(book.epochs.at(-1).cumulative, book.total_usd, 'the chart ends at the total');
const open = voteBook(L.events, rewards, L.kat_usd, 1482, voteClose(1482) - 60);
eq(open.epochs.at(-1).settled, false, 'an epoch still in its vote week is not settled');
ok(Math.abs(open.rate - book.rate) > 1e-6, 'and stays out of the average until it is');

/* the saved file */
ok(validateLedger(emptyLedger()), 'an empty ledger is valid');
assert.throws(() => validateLedger({ ...structuredClone(L), events: [L.events[0], L.events[0]] }), /twice/); checks++;
assert.throws(() => validateLedger({ ...structuredClone(L), campaigns: {} }), /campaign dates/); checks++;
assert.throws(() => validateLedger({ ...structuredClone(L), version: 2 }), /version/); checks++;
eq([VOTE_TOPIC.length, RESET_TOPIC.length], [66, 66], 'full event topics');

console.log(`vKAT votes: ${checks} assertions passed.`);
