/* ============================================================================
   api/vault — the Tiger Vault's live total.

   The vault is a wallet of its own, read the way every other figure on the
   dashboard is read. `complete: false` means a part could not be read, and the
   page then keeps the last good figure instead of showing a smaller one.
   ========================================================================== */
import { vaultValue } from './_core.mjs';

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  /* asked every fifteen seconds by the dashboard; ten at the edge keeps it fresh */
  res.setHeader('cache-control', 's-maxage=10, stale-while-revalidate=5');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const get = (p) => fetch(proto + '://' + host + p + '?t=' + Date.now()).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [book, data] = await Promise.all([get('/lpbook.json'), get('/data.json')]);
    res.status(200).end(JSON.stringify(await vaultValue(undefined, { book, fables: data && data.fables })));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}
