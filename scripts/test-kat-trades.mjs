/* The KAT page's trade finder and book, checked offline against Alex's real transfers
   from 26 Oct 2026 18:5x to 1 Nov 11:18 MYT (scripts/fixtures/kat-trades-2026-10.json)
   and a few made-up cases. No network. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { START as CURRENT_START, KAT, WALLETS, walletTxs, scanTrades, prunePending, replay, summary, pnlSeries, mergeCloses,
  usdAtTick, usdFromSqrt, emptyBook, validateBook, units, simulate, flowsOf, addFlows, noFlows, reconcile, PENDING_SECONDS } from '../kat-core.mjs';

const START={block:46345344,ts:1793088155};
let checks = 0;
const ok = (v, note) => { assert.ok(v, note); checks++; };
const eq = (a, b, note) => { assert.deepEqual(a, b, note); checks++; };
const near = (a, b, tol, note) => { assert.ok(Math.abs(a - b) <= tol, `${note}: ${a} vs ${b}`); checks++; };

const fx = JSON.parse(readFileSync(new URL('./fixtures/kat-trades-2026-10.json', import.meta.url), 'utf8'));
const getReceipt = async (h) => { if (!fx.receipts[h]) throw new Error('fixture has no receipt for ' + h); return fx.receipts[h]; };
const found = await scanTrades({ trades: [], pending: [] }, walletTxs(fx.transfers), { getReceipt, ethUsd: fx.eth_usd });
const T = found.trades;

/* every trade in the window, in order, with its exact amounts */
eq(T.map((t) => [t.side, t.route, +t.kat.toFixed(6), +t.usd.toFixed(6)]), [
  ['sell', 'swap', 5500.262788, 26.706596],      /* 26 Oct 18:51, a router swap */
  ['sell', 'deposit', 8083.690013, 39.92723],     /* 26 Oct 18:53, the swap service */
  ['sell', 'deposit', 30000, 142.176228],         /* 26 Oct 19:03 */
  ['buy', 'swap', 5978.847409, 25],               /* 27 Oct 16:02, a filled limit order: 5,952.38 + 26.47 surplus */
  ['sell', 'deposit', 5600, 25.864268],           /* 29 Oct 14:11 */
  ['buy', 'deposit', 7299.830781, 30],            /* 30 Oct 10:14 */
  ['buy', 'deposit', 6260.979832, 25],            /* 1 Nov 11:11 */
], 'the seven trades between 26 Oct and 1 Nov');
eq(T.map((t) => t.token), Array(7).fill('vbUSDC'), 'all against vbUSDC');
const at = (prefix) => T.find((t) => t.hash.startsWith(prefix) || (t.deposit_hash || '').startsWith(prefix));
eq(at('0x4b283605').hash.slice(0, 10), '0x7edd6750', 'a deposit sale is booked at its payout, with the deposit kept beside it');
eq(at('0x67daea23').hash.slice(0, 10), '0x5ee8a09b', 'the 1 Nov buy pairs the 25 vbUSDC deposit with the KAT payout');

/* loans, avKAT and rewards are not trades, though KAT and vbUSDC cross in some of them */
for (const [h, what] of [['0x414722e9', 'borrowing KAT'], ['0x3682c1be', 'repaying vbUSDC and taking KAT collateral back'],
  ['0x6242322d', 'borrowing 30,000 KAT'], ['0xf4830219', 'an avKAT deposit'], ['0x1546ec9d', 'a Merkl claim of KAT and vbUSDC'],
  ['0xd89495b2', 'borrowing 2,800 KAT'], ['0xa2ce841d', 'supplying KAT as collateral'], ['0x62f05788', 'borrowing vbUSDC']]) {
  ok(!T.some((t) => t.hash.startsWith(h) || (t.deposit_hash || '').startsWith(h)), what + ' is not a trade');
}
ok(fx.transfers.some((t) => t.hash.startsWith('0x3682c1be') && t.token === KAT), 'the fixture does hold that Morpho KAT transfer');

/* fees: what each route took, and the gas the wallet paid for its own part */
const nov1 = at('0x5ee8a09b');
eq(nov1.fees.parts.map((p) => [p.what, p.token, +p.amount.toFixed(6)]), [['Service fee', 'KAT', 2.505394], ['Relayer fee', 'vbUSDC', 0.034652]], '1 Nov fees');
near(nov1.fees.gas_eth, 3.358575e-6, 1e-12, '1 Nov gas is the deposit transaction\'s');
near(nov1.fees.usd, 2.505394 * 25 / 6260.979832 + 0.034652 + 3.358575e-6 * 2268, 1e-6, 'fees in dollars: KAT at the trade price, gas at the ETH price');
const oct27 = at('0xd249bc72');
eq(oct27.fees.parts.map((p) => [p.what, +p.amount.toFixed(6)]), [['Order fee', 0.407188]], 'the limit order\'s fee');
eq(oct27.fees.gas_eth, 0, 'a keeper sent the fill, so the wallet paid no gas');
eq(at('0x11d00ab3').fees.parts.map((p) => p.what), ['Router fee', 'Router fee', 'Router fee'], 'the router swap\'s three cuts');

/* the window split between a deposit and its payout finds the same trades */
const cut = 46511459;   /* the 29 Oct payout's block: its deposit is in the first part */
const first = await scanTrades({ trades: [], pending: [] }, walletTxs(fx.transfers.filter((t) => t.block < cut)), { getReceipt, ethUsd: fx.eth_usd });
ok(first.pending.some((p) => p.token === KAT && p.amount === 5600), 'the 5,600 KAT deposit waits across the cut');
const both = await scanTrades(first, walletTxs(fx.transfers.filter((t) => t.block >= cut)), { getReceipt, ethUsd: fx.eth_usd });
eq(both.trades.map((t) => t.hash), T.map((t) => t.hash), 'two runs find what one run finds');
eq(both.pending.filter((p) => p.token === KAT).length, 0, 'no KAT deposit left waiting');
const again = await scanTrades(both, walletTxs(fx.transfers), { getReceipt, ethUsd: fx.eth_usd });
eq(again.trades.length, T.length, 'reading the same transfers again adds nothing');

/* a deposit only pairs with a payout that passes the whole of it on */
const lpAdd = '0x744676b3ced942d78f9b8e9cd22246db5c32395c', usdc = '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36';
const w = WALLETS[0], pad = (a) => '0x' + a.slice(2).padStart(64, '0'), T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const fake = (n) => '0x' + String(n).padStart(64, 'a');
const mk = (hash, block, from, to, token, raw) => ({ hash, block, index: 0, ts: 1793300000 + block, token, from, to, raw: String(raw) });
const route = { from: '0x00', gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
  { address: usdc, topics: [T0, pad(lpAdd), pad('0x10045367e619caae6f60cc80046c43c6cd55f629')], data: '0x' + (10e6).toString(16) },
  { address: KAT, topics: [T0, pad('0x10045367e619caae6f60cc80046c43c6cd55f629'), pad(w)], data: '0x' + (2000n * 10n ** 18n).toString(16) }] };
const lp = await scanTrades({ trades: [], pending: [] }, walletTxs([mk(fake(1), 1, w, lpAdd, usdc, 562e6), mk(fake(2), 2, '0x0000000000000000000000000000000000000001', w, KAT, 2000n * 10n ** 18n)]),
  { getReceipt: async (h) => route, ethUsd: 2000 });
eq(lp.trades.length, 0, 'an LP add of 562 vbUSDC is not paid back by a route that moves 10 vbUSDC through that pool');

/* pending deposits age out */
eq(prunePending([{ ts: 100 }, { ts: 100 + PENDING_SECONDS + 1 }], 100 + PENDING_SECONDS + 2).length, 1, 'three days, then dropped');

/* the book from 27 Oct: average cost, long only */
const book = T.filter((t) => t.block >= START.block);
eq(book.length, 4, 'four trades from the start');
const r = replay(book);
/* worked by hand: the 29 Oct sale takes 5,600 of the 27 Oct buy's KAT at that buy's price */
const basis29 = 5600 * 25 / 5978.847409;
near(r.qty, 5978.847409 - 5600 + 7299.830781 + 6260.979832, 1e-5, 'KAT held');
near(r.cost, 25 - basis29 + 30 + 25, 1e-5, 'its cost');
near(r.realized, 25.864268 - basis29, 1e-5, 'realised: 5,600 KAT sold at $0.004619 against $0.004181');
near(r.rows[1].basis, basis29, 1e-7, 'the sale\'s cost basis is its KAT at the average cost then');
const s = summary(book, 0.004121734102003788);
near(s.avg, (25 - basis29 + 55) / (5978.847409 - 5600 + 7299.830781 + 6260.979832), 1e-10, 'average buy price of what is held');
near(s.avg, 0.0040592, 1e-7, 'about $0.0040592');
near(s.unrealized, 0.871, 0.001, 'unrealised at $0.0041217');
near(s.total, s.realized + s.unrealized, 1e-12, 'total is the two together');
eq([s.bought.n, s.sold.n], [3, 1], 'three buys, one sell');
near(s.bought.usd / s.bought.kat, 80 / 19539.658022, 1e-12, 'all buys average');

/* a sale bigger than the book holds: only the held part is P&L */
const over = replay([{ side: 'buy', kat: 100, usd: 1, block: 1, ts: 1 }, { side: 'sell', kat: 150, usd: 3, block: 2, ts: 2 }]);
near(over.realized, 2 - 1, 1e-12, 'realised on the 100 held: $2 of the $3, less its $1 cost');
eq([over.qty, over.cost, over.rows[1].outside], [0, 0, 50], 'the other 50 came from outside the book');
const none = replay([{ side: 'sell', kat: 10, usd: 1, block: 1, ts: 1 }]);
eq([none.realized, none.rows[0].realized, none.rows[0].outside], [0, null, 10], 'a sale with nothing held books nothing');

/* the chart: hourly closes between trades, each trade at its own price, now at the live price */
const hours = mergeCloses([], [{ ts: 1793087000, tick: 331000 }, { ts: 1793090000, tick: 331100 }, { ts: 1793090500, tick: 331200 }]);
eq(hours, [[1793084400, 331000], [1793088000, 331200]], 'the last swap in each hour is its close');
const series = pnlSeries(book, fx.hours || hours, { now: 1793538000, priceUsd: 0.004121734102003788 });
eq(series[0].ts, START.ts, 'the line starts at the first trade');
near(series[0].total, 0, 1e-9, 'worth what it cost at the moment of buying');
const last = series[series.length - 1];
near(last.total, s.total, 1e-9, 'the last point is the summary');
near(last.realized, s.realized, 1e-9, 'with the same realised');
const sale = series.find((p) => p.trade === 'sell');
near(sale.realized, 25.864268 - basis29, 1e-5, 'realised steps up at the sale');
ok(series.every((p, i) => !i || p.ts >= series[i - 1].ts), 'in time order');
ok(series.filter((p) => !p.trade).slice(0, -1).every((p) => p.ts % 3600 === 0), 'between trades, one point at each hour end');

/* the trade simulator: a plan run after the real trades, valued at today's price */
const nowPx = 0.004121734102003788;
const buy = simulate(book, [{ side: 'buy', usd: 25, price: 0.004 }], nowPx);
near(buy.after.qty - buy.before.qty, 6250, 1e-9, 'a $25 buy at $0.004 adds 6,250 KAT');
near(buy.after.avg, (s.cost + 25) / (s.qty + 6250), 1e-12, 'and averages the cost down');
ok(buy.after.avg < buy.before.avg, 'a buy below the average lowers it');
eq(buy.after.realized, buy.before.realized, 'a buy realises nothing');
near(buy.before.total, s.total, 1e-12, '"before" is the real book');
near(buy.after.unrealized, (s.qty + 6250) * nowPx - (s.cost + 25), 1e-9, 'after is valued at today\'s price');
const sell = simulate(book, [{ side: 'sell', kat: 5000, price: 0.0045 }], nowPx);
near(sell.after.realized - sell.before.realized, 5000 * 0.0045 - 5000 * s.avg, 1e-9, 'a sale realises against the average cost');
near(sell.after.avg, s.avg, 1e-12, 'and leaves the average where it was');
near(sell.rows[0].basis, 5000 * s.avg, 1e-9, 'the sale\'s cost basis');
const plan = simulate(book, [{ side: 'buy', usd: 30, price: 0.0039 }, { side: 'sell', kat: 30000, price: 0.0046 }], nowPx);
eq(plan.rows.map((r) => r.side), ['buy', 'sell'], 'steps run in the order typed, after every real trade');
near(plan.rows[1].outside, 30000 - (s.qty + 30 / 0.0039), 1e-6, 'selling more than the book holds leaves the extra out');
eq([plan.after.qty, plan.after.avg, plan.after.breakEven], [0, null, null], 'nothing held after selling it all');
near(sell.after.breakEven, (sell.after.cost - sell.after.realized) / sell.after.qty, 1e-15, 'break-even: total P&L is zero there');
near(simulate(book, [{ side: 'sell', kat: 5000, price: 0.0045 }], sell.after.breakEven).after.total, 0, 1e-9, 'checked by valuing the book after the sale at it');
eq(simulate(book, [{ side: 'buy', usd: 0, price: 0.004 }, { side: 'sell', kat: 10, price: 0 }], nowPx).rows.length, 0, 'empty or priceless steps are skipped');
eq(simulate([{ side: 'buy', kat: 100, usd: 1, block: 1, ts: 1, fees: { usd: 0 } }], [{ side: 'sell', kat: 50, price: 0.05 }], 0.01).after.breakEven, 0, 'a book already paid for breaks even at any price');

/* the wallets' other KAT, and the reconciliation with the book (Alex asked, 2 Nov) */
const since = fx.transfers.filter((t) => t.block >= START.block);
const flows = flowsOf(since);
near(flows.rewards, 215.108188 + 3236.499419, 0.001, 'rewards claimed from Merkl on 30 Oct');
near(flows.avkat, -350 - 3480, 1e-9, 'KAT moved into avKAT on 28 and 30 Oct');
near(flows.morpho, 0, 1e-9, 'the 2,800 KAT borrowed went straight back in as collateral');
eq(flows.vkat, 0, 'no vKAT lock in the window');
eq(flowsOf([...since, ...since]), flows, 'a transfer read twice counts once');
eq(addFlows(noFlows(), flows), flows, 'flows add');
/* the wallets held 0 KAT before the first buy and 13,561.27 at block 46,760,300 (read 2 Nov) */
const rec = reconcile(book, flows, 0, 13561.26565653549);
near(rec.held, r.qty, 1e-9, 'held is the book');
near(rec.held + rec.rewards + rec.avkat + rec.morpho + rec.vkat + rec.other, rec.wallet, 1e-9, 'the lines add up to the wallets');
near(rec.other, 0, 0.01, 'and nothing is left unexplained');
const over2 = reconcile([{ side: 'sell', kat: 10, usd: 1, block: 1, ts: 1 }], noFlows(), 10, 0);
eq([over2.outside, over2.held, Math.abs(over2.other) < 1e-9], [10, 0, true], 'a sale from outside the book is shown as such, not as other');
assert.throws(() => validateBook({ ...emptyBook(), flows: { rewards: 1 } }), /wallet flows/); checks++;

/* prices */
near(usdAtTick(331244), 0.0041217, 0.000002, 'KAT at the 1 Nov 20:00 close, within a tick of slot0 then ($0.0041217)');
near(usdFromSqrt(BigInt(Math.round(Math.sqrt(1e12 / 0.0041) * 2 ** 96 / 1e0))), 0.0041, 1e-9, 'slot0 and the tick agree');
eq(units('5978847409331783000000', 18) > 5978.8474, true, 'units keeps the fraction');

/* the saved file */
ok(validateBook(emptyBook()), 'an empty ledger is valid');
assert.throws(() => validateBook({ ...emptyBook(), start: { block: 1, ts: 1 } }), /start moved/); checks++;
assert.throws(() => validateBook({ ...emptyBook(), trades: [book[0], book[0]] }), /bad trade/); checks++;
assert.throws(() => validateBook({ ...emptyBook(), hours: [[3600, 1], [3600, 2]] }), /bad hour/); checks++;
ok(validateBook({ ...emptyBook(), trades: book.map((t,i)=>({...t,block:CURRENT_START.block+i,ts:CURRENT_START.ts+i,swap_verified:true})), last_block: CURRENT_START.block+100, last_ts: CURRENT_START.ts+100 }), 'the real trades pass');

console.log(`KAT trades: ${checks} assertions passed.`);
