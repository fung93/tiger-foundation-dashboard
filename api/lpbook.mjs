/* ============================================================================
   api/lpbook — every card on the LP book page, finished.

   The ledger on disk (lpbook.json) is moved forward by the Action every six
   hours. That is too slow on its own: re-ranging is exactly when the page gets
   looked at. So each request carries the book the rest of the way to the head of
   every chain in memory — the same code the Action runs, so what the page shows
   now is what the ledger will say after the next run — then values it all at
   live prices.
   ========================================================================== */
import { merklLp, advanceBook, bookLiveRows, livePrices, bookView } from './_core.mjs';

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  /* Ten seconds at the edge: the LP Book and the widget ask every fifteen, so price and fees
     are never more than a few seconds behind the chain, while a page and a widget open at the
     same moment share one read instead of doubling the load on Robinhood's rate limit. */
  res.setHeader('cache-control', 's-maxage=10, stale-while-revalidate=5');
  res.setHeader('content-type', 'application/json; charset=utf-8');

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const r = await fetch(proto + '://' + host + '/lpbook.json?t=' + Date.now());
    if (!r.ok) {
      res.status(503).end(JSON.stringify({ error: 'The LP book has not started yet.' }));
      return;
    }
    const book = await r.json();
    const merkl = await merklLp();
    /* Four windows a chain covers the gap the Action leaves, with room to spare. If the
       Action has stopped and the gap is wider, the page is told how far behind it is
       rather than being kept waiting on a request that would time out. */
    /* 'new': time in range is read here only for a position opened since the job last ran */
    const { book: now, errors, behind } = await advanceBook(book, { merkl, maxWindows: 4, ranges: 'new' });
    const [live, prices] = await Promise.all([bookLiveRows(now), livePrices(now, merkl.token_price)]);
    const view = bookView(now, {
      rows: live.rows, prices, merkl,
      errors: { ...errors, ...Object.fromEntries(Object.entries(live.errors).map(([k, v]) => [k + ' (live)', v])),
        ...(merkl.error ? { merkl: 'rewards could not be read' } : {}) },
      behind,
    });
    view.generated = new Date().toISOString();
    res.status(200).end(JSON.stringify(view));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}
