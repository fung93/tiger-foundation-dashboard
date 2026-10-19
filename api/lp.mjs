/* ============================================================================
   api/lp — the live numbers an LP range widget needs, for a phone.

   A home-screen widget has no browser, so the arithmetic is finished here. The
   chain reading itself lives in api/_core.mjs, shared with the LP book.

   Two sources, deliberately split:
     - the slow facts (which positions are open, what went in) come from
       positions.json, which the 6-hourly Action maintains;
     - the fast facts (pool price, liquidity, accrued fees, Merkl) are read live
       on every request, because the point of a range widget is where the price
       sits right now.
   ========================================================================== */
import { V3, merklLp, v3Candidates, v3Rows, arcRows, widgetView, rowPrices, feeTokensOf } from './_core.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const want = url.searchParams.get('pos');          /* a token id, to pin the widget to one */

  res.setHeader('access-control-allow-origin', '*');
  /* A widget refreshes every half hour at best, so a short shared cache costs nothing and
     keeps a stuck widget from hammering a public RPC. */
  res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=240');
  res.setHeader('content-type', 'application/json; charset=utf-8');

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const base = proto + '://' + host;
    const [pos, data, book] = await Promise.all([
      (await fetch(base + '/positions.json?t=' + Date.now())).json(),
      fetch(base + '/data.json?t=' + Date.now()).then((r) => r.json()).catch(() => ({})),
      fetch(base + '/lpbook.json?t=' + Date.now()).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const seed = ((data.chains || {}).katana || {}).staked_lp_ids || [];
    /* Every chain and Merkl run side by side; none waits on another's discovery. */
    const jobs = V3.map((ch) => v3Candidates(ch, pos, ch.open(pos), ch.key === 'katana' ? seed : [])
      .catch(() => Object.keys(ch.open(pos)))        /* discovery failing costs the new ones, not the known */
      .then((c) => v3Rows(ch, ch.open(pos), c))
      .then((rows) => ({ key: ch.key, rows }))
      .catch((e) => ({ key: ch.key, error: ch.key + ': ' + e.message })));
    jobs.push(arcRows(pos.arc && pos.arc.open)
      .then((rows) => ({ key: 'arc', rows }))
      .catch((e) => ({ key: 'arc', error: 'arc: ' + e.message })));

    const [results, merkl] = await Promise.all([Promise.all(jobs), merklLp()]);
    const errors = [], rows = [], checked = {};
    for (const r of results) {
      if (r.error) { errors.push(r.error); checked[r.key] = 'failed'; }
      else { rows.push(...r.rows); checked[r.key] = r.rows.length; }
    }
    /* A position with no cost of its own — older than the mint search reaches, and never in
       positions.json — takes the LP book's: what it was worth when tracking began, or what
       its mint took if it opened since. Its P&L then runs from that point, and says so. */
    const booked = (book && book.positions) || {};
    for (const r of rows) {
      const P = booked[r.chain + ':' + r.id];
      if (r.pnl_usd !== null || !P || r.liquidity_usd === null) continue;
      r.pnl_usd = Math.round((r.liquidity_usd + (P.out_usd || 0) - P.cost_usd) * 100) / 100;
      r.open_value_usd = P.cost_usd;
      r.pending = false;
      r.pnl_since = P.at_start ? book.started.iso : null;
      /* and its yield over the same stretch: what the book counts as earned since then */
      const px = { ...rowPrices(r), ...(merkl.token_price || {}) };
      const tokens = feeTokensOf({ ...P, merkl: (merkl.earned_tokens_by_id || {})[r.id] || P.merkl },
        r.raw ? { [P.t0]: r.raw.fee0, [P.t1]: r.raw.fee1 } : null);
      r.yield_override_usd = Math.round(Object.entries(tokens)
        .reduce((sum, [k, a]) => sum + a * (px[k] || 0), 0) * 100) / 100;
    }
    /* tightest band first: the position that needs watching is the one with least room */
    rows.sort((a, b) => a.range.width_pct - b.range.width_pct);
    const pick = want ? rows.find((r) => r.id === want) : rows[0];
    /* the book's raw fields are not the widget's business */
    for (const r of rows) delete r.raw;

    res.status(200).end(JSON.stringify({
      generated: new Date().toISOString(),
      rewards_pending_usd: merkl.lp_usd,
      rewards_all_usd: merkl.total_usd,
      count: rows.length,
      /* what each chain answered, so a chain that went quiet is visible rather than absent */
      chains: checked,
      widget: widgetView(pick, merkl),
      widgets: rows.map((r) => widgetView(r, merkl)),
      positions: rows,
      errors: errors.length ? errors : undefined,
    }, null, 2));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}
