/* ============================================================================
   api/fables — Fables on Robinhood Chain, read live: every Fables liquidity range
   (shares in the FablesRamp Uniswap V4 hook) and every veFABLES lock, for both
   wallets. The dashboard asks every fifteen seconds and keeps the main wallet's;
   the Tiger Vault's are counted by /api/vault.

   The list of ranges and locks comes from data.json, which the six-hourly job keeps
   up to date by scanning for new ones; the seed in _core covers a missing snapshot.
   ========================================================================== */
import { fablesRead, fablesDashRow, fablesLockRow } from './_core.mjs';
import { createLiveCache, requestOrigin, fetchJSON, responseHeaders, savedFables } from './_live-cache.mjs';

const readLive = createLiveCache();

export default async function handler(req, res) {
  responseHeaders(res);
  try {
    const origin = requestOrigin(req);
    const view = await readLive(origin, async () => {
      const state = savedFables(await fetchJSON(origin + '/data.json'));
      const read = await fablesRead(state);
      if (read.complete === false || Object.keys(read.errors || {}).length
        || !Number.isFinite(read.fables_usd) || read.fables_usd <= 0
        || !Array.isArray(read.rows) || !Array.isArray(read.locks)
        || [...read.rows, ...read.locks].some((row) => !Number.isFinite(row.value_usd) || row.value_usd < 0))
        throw new Error('A complete Fables reading is unavailable.');
      return { lps: read.rows.map(fablesDashRow), locks: read.locks.map(fablesLockRow),
        fables_usd: read.fables_usd, at: new Date().toISOString() };
    });
    responseHeaders(res, true);
    res.status(200).end(JSON.stringify(view));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}
