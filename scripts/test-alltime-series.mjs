/* Closed-position Net uses recorded claim dollars and real close dates, never live prices. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookView, r2 } from '../api/_core.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const wallet = '0x1111111111111111111111111111111111111111';
const token = 'KAT@katana';
const claim = (ts, usd) => ({ ts, usd, tokens: { [token]: 100 }, prices: { [token]: .01 } });
function position(id, overrides = {}) {
  return { key: 'katana:' + id, id, chain: 'katana', wallet, pair: 'KAT / USDC',
    t0: token, t1: 'USDC@katana', status: 'closed', opened_ts: 100, closed_ts: 300,
    cost_usd: 100, out_usd: 100, claims: [], withdrawals: [], frozen: { pnl_usd: 0 }, ...overrides };
}
const ledger = positions => ({ started: { ts: 100 }, wallets: [wallet], tokens: {
  [token]: { s: 'KAT' }, 'USDC@katana': { s: 'USDC' },
}, positions: Object.fromEntries(positions.map(p => [p.key, p])), events: [] });
const view = (book, prices = {}) => bookView(book, { rows: {}, prices, merkl: {} }).alltime;
const point = (v, ts) => v.series.find(p => p.ts === ts);
function consistent(v, note) {
  check(v.series.every((p, i, all) => !i || p.ts > all[i - 1].ts), true, note + ': strictly increasing timestamps');
  if (v.series.length) {
    check(v.series.at(-1).usd, v.cards.fees_usd, note + ': final fees equal the card');
    check(v.series.at(-1).net, v.cards.net_usd, note + ': final Net equals the card');
  }
}

// Fix only the read-only view's terminal date; every saved event keeps its own timestamp.
const realNow = Date.now;
Date.now = () => 1900000000000;
try {
  const loss = ledger([position('loss', { frozen: { pnl_usd: -12, fee_usd: 999, net_usd: 987 },
    // Unsorted records must still follow their original claim dates, including after close.
    claims: [claim(400, 2), claim(200, 5)] })]);
  const untouched = structuredClone(loss);
  let v = view(loss, { [token]: 99999 });
  check(point(v, 100), { ts: 100, usd: 0, net: 0 }, 'Net starts at zero when the position opens');
  check(point(v, 199), { ts: 199, usd: 0, net: 0 }, 'The fee step has a pre-claim boundary');
  check(point(v, 200), { ts: 200, usd: 5, net: 5 }, 'Original claim dollars enter Net before the position closes');
  check(point(v, 299), { ts: 299, usd: 5, net: 5 }, 'A later loss is not recognized early');
  check(point(v, 300), { ts: 300, usd: 5, net: -7 }, 'Realised loss enters at the actual close');
  check(point(v, 399), { ts: 399, usd: 5, net: -7 }, 'Net holds the loss until a later claim');
  check(point(v, 400), { ts: 400, usd: 7, net: -5 }, 'A claim after close enters on its own claim date');
  check(v.cards.net_usd, -5, 'The curve ignores close-price frozen fees, matching the existing Net card');
  check(view(loss, { [token]: .00000001 }), v, 'Changing current token prices cannot reprice closed history');
  check(loss, untouched, 'Building the series does not mutate the input ledger');
  consistent(v, 'loss and late claim');

  v = view(ledger([position('profit', { frozen: { pnl_usd: 10 } })]));
  check(point(v, 299), { ts: 299, usd: 0, net: 0 }, 'A fee-free profit has a pre-close step');
  check(point(v, 300), { ts: 300, usd: 0, net: 10 }, 'A close with no fee claim still appears');
  consistent(v, 'fee-free profit');
  v = view(ledger([position('loss', { frozen: { pnl_usd: -20 } })]));
  check(point(v, 300).net, -20, 'A fee-free negative Net remains negative');
  consistent(v, 'fee-free loss');

  v = view(ledger([
    position('a', { frozen: { pnl_usd: 7 }, claims: [claim(300, 3), claim(301, 1)] }),
    position('b', { frozen: { pnl_usd: -10 }, claims: [claim(300, 4)] }),
  ]));
  check(point(v, 299), { ts: 299, usd: 0, net: 0 }, 'Simultaneous events share one previous balance');
  check(point(v, 300), { ts: 300, usd: 7, net: 4 }, 'Same-timestamp claims and closes are aggregated together');
  check(v.series.filter(p => p.ts === 300).length, 1, 'No duplicate point at a simultaneous event/adjacent boundary');
  check(point(v, 301), { ts: 301, usd: 8, net: 5 }, 'An adjacent-second event retains the previous event');
  consistent(v, 'same-time and adjacent events');

  v = view(ledger([
    position('a', { frozen: { pnl_usd: .006 }, claims: [claim(200, .004), claim(220, .004)] }),
    position('b', { frozen: { pnl_usd: .006 }, claims: [claim(200, .004)] }),
    position('c', { claims: [claim(200, .004)] }),
  ]));
  check(point(v, 200).usd, 0, 'Fractional fees round per position, matching the cards');
  check(point(v, 220).usd, .01, 'Repeated fractional claims accumulate before position-level rounding');
  check(point(v, 300).net, .02, 'Net retains raw frozen PnL until the combined amount is rounded');
  consistent(v, 'rounding');

  v = view(ledger([position('fallback', { frozen: undefined, cost_usd: 100.111, out_usd: 90.123 })]));
  check(point(v, 300).net, -9.99, 'Missing frozen PnL uses the existing fixed principal-minus-cost fallback');
  consistent(v, 'fallback PnL');

  v = view(ledger([position('unknown-fee', { frozen: { pnl_usd: 3 }, claims: [claim(200, null), claim(210, undefined), claim(220, 2)] })]));
  check(v.cards.incomplete, true, 'Unknown claim dollars preserve the existing incomplete indicator');
  check(v.cards.fees_usd, 2, 'Unknown fee values are not repriced from current token prices');
  check(point(v, 300).net, 5, 'Only known fixed dollars contribute to incomplete Net');
  consistent(v, 'unknown fee dollars');

  v = view(ledger([]));
  check(v.series, [], 'No closed positions produce an empty series');
  check(v.cards.net_usd, 0, 'An empty book has no realised Net');
  v = view(ledger([position('open', { status: 'open', closed_ts: null, claims: [claim(200, 100)] })]));
  check(v.series, [], 'Currently open positions are excluded from the all-time curve');
  check(v.cards.net_usd, 0, 'Open-position claims cannot inflate closed-position Net');

  const saved = JSON.parse(readFileSync(new URL('../lpbook.json', import.meta.url), 'utf8'));
  const original = structuredClone(saved);
  const savedView = view(saved, { [token]: 99999 });
  consistent(savedView, 'checked-in ledger');
  check(view(saved, { [token]: .00000001 }), savedView, 'Checked-in history is independent of live prices');
  check(saved, original, 'Rendering checked-in history leaves every stored value untouched');
  const closed = Object.values(saved.positions).filter(p => p.status !== 'open');
  const expectedFees = closed.reduce((sum, p) => sum + r2((p.claims || []).reduce((s, c) => s + (c.usd ?? 0), 0)), 0);
  const expectedPnl = closed.reduce((sum, p) => sum + (p.frozen?.pnl_usd ?? r2(p.out_usd - p.cost_usd)), 0);
  check(savedView.series.at(-1)?.net ?? 0, r2(expectedFees + expectedPnl), 'Saved ledger Net matches original claims and frozen realised PnL');
  for (const p of closed) check(!!point(savedView, p.closed_ts), true, 'Saved close timestamp is represented: ' + p.key);
  console.log('Saved ledger: ' + closed.length + ' closed positions; fees $' + r2(expectedFees).toFixed(2)
    + ', realised PnL $' + r2(expectedPnl).toFixed(2) + ', Net $' + r2(expectedFees + expectedPnl).toFixed(2) + '.');
} finally {
  Date.now = realNow;
}
console.log('All-time chart series: ' + checks + ' assertions passed.');
