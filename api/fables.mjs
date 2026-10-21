/* ============================================================================
   api/fables — Fables on Robinhood Chain, read live: every Fables liquidity range
   (shares in the FablesRamp Uniswap V4 hook) and every veFABLES lock, for both
   wallets. The dashboard asks every fifteen seconds and keeps the main wallet's;
   the Tiger Vault's are counted by /api/vault.

   The list of ranges and locks comes from data.json, which the six-hourly job keeps
   up to date by scanning for new ones; the seed in _core covers a missing snapshot.
   ========================================================================== */
import { fablesRead, fablesDashRow, fablesLockRow, FABLES } from './_core.mjs';

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 's-maxage=10, stale-while-revalidate=5');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const data = await fetch(proto + '://' + host + '/data.json?t=' + Date.now())
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const read = await fablesRead((data && data.fables) || FABLES.seed);
    res.status(200).end(JSON.stringify({
      lps: read.rows.map(fablesDashRow), locks: read.locks.map(fablesLockRow),
      fables_usd: read.fables_usd, at: new Date().toISOString(),
    }));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}
