/* ============================================================================
   api/vault — the Tiger Vault's live total.

   The vault is a wallet of its own, read the way every other figure on the
   dashboard is read. `complete: false` means a part could not be read, and the
   page then keeps the last good figure instead of showing a smaller one.
   ========================================================================== */
import { vaultValue, BOOK_VERSION } from './_core.mjs';
import { createLiveCache, requestOrigin, fetchJSON, responseHeaders, savedBookValid, savedFables } from './_live-cache.mjs';

const complete = (view) => view && view.complete === true && !Object.keys(view.errors || {}).length;
const readLive = createLiveCache({ complete });

export default async function handler(req, res) {
  responseHeaders(res);
  try {
    const origin = requestOrigin(req);
    const view = await readLive(origin, async () => {
      const [book, data] = await Promise.all([fetchJSON(origin + '/lpbook.json'), fetchJSON(origin + '/data.json')]);
      if (!savedBookValid(book, BOOK_VERSION)) throw new Error('The saved LP book is unavailable or malformed.');
      return vaultValue(undefined, { book, fables: savedFables(data) });
    });
    responseHeaders(res, complete(view));
    res.status(200).end(JSON.stringify(view));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}
