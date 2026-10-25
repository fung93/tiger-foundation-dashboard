/* The lending page's live read. Historical observations remain immutable in
   morpho-history.json; the browser requests that separately. */
import { readMorpho } from '../morpho-core.mjs';

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 's-maxage=10, stale-while-revalidate=5');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try { res.status(200).end(JSON.stringify(await readMorpho())); }
  catch (e) { res.status(502).end(JSON.stringify({ error: String(e?.message || e) })); }
}
