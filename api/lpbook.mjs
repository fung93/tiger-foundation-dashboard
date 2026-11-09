/* ============================================================================
   api/lpbook — every card on the LP book page, finished.

   The ledger on disk (lpbook.json) is moved forward by the Action every six
   hours. That is too slow on its own: re-ranging is exactly when the page gets
   looked at. So each request carries the book the rest of the way to the head of
   every chain in memory — the same code the Action runs, so what the page shows
   now is what the ledger will say after the next run — then values it all at
   live prices.
   ========================================================================== */
import { merklLp, advanceBook, bookLiveRows, livePrices, bookView, BOOK_VERSION, V3, FABLES } from './_core.mjs';
import { createLiveCache, requestOrigin, fetchJSON, lpViewComplete, responseHeaders, savedBookValid } from './_live-cache.mjs';
import { compactLPPositions } from '../portfolio-core.mjs';
import { attributeLPPerformance } from '../agent-performance.mjs';
import { readPositionCostEvidence } from './_agent-cost-reader.mjs';
import {createHash} from 'node:crypto';

const readLive = createLiveCache({ complete: lpViewComplete });
const checkpoints = new Map();

async function readBook(origin) {
  const source = await fetchJSON(origin + '/lpbook.json');
  if (!savedBookValid(source, BOOK_VERSION)) throw new Error('The saved LP book is unavailable or malformed.');
  const identity = JSON.stringify(source);
  let checkpoint = checkpoints.get(origin);
  if (!checkpoint || checkpoint.identity !== identity) {
    const book = { ...source };
    // A committed snapshot starts a new warm-instance provenance boundary.
    delete book.reward_rollover_anchor;
    checkpoint = { identity, book };
    checkpoints.set(origin, checkpoint);
    if (checkpoints.size > 8) checkpoints.delete(checkpoints.keys().next().value);
  }
  const rawMerkl = await merklLp();
  /* Resume a warm function's validated ledger instead of replaying the same six-hour
     backlog on every page poll. A new committed snapshot replaces the checkpoint whole;
     advanceBook itself rolls back a failed chain while retaining successful chains. */
  const { book: now, errors, behind, merkl = rawMerkl } = await advanceBook(checkpoint.book,
    { merkl: rawMerkl, maxWindows: 4, ranges: 'new' });
  checkpoint.book = now;
  const [live, prices] = await Promise.all([bookLiveRows(now), livePrices(now, merkl.token_price)]);
  const view = bookView(now, {
    rows: live.rows, prices, merkl,
    errors: { ...errors, ...Object.fromEntries(Object.entries(live.errors).map(([k, v]) => [k + ' (live)', v])),
      ...(merkl.error && !errors.merkl ? { merkl: 'rewards could not be read' } : {}) },
    behind,
  });
  view.generated = new Date().toISOString();
  view.position_data = compactLPPositions(now, live.rows, { generated: view.generated,
    contracts: { ...Object.fromEntries(V3.map(chain => [chain.key, chain.npm])), fables: FABLES.ramp } });
  for (const position of view.position_data) {
    position.performance = (view.position_metrics || []).find(metric => metric.chain === position.chain
      && metric.owner === position.owner && metric.id === String(position.id)) || null;
    const original=now.positions[position.chain+':'+position.id];
    if(original&&position.performance){
      const row=(view.live||[]).find(row=>row.chain===position.chain&&String(row.id).replace(/^#/,'')===String(position.id));
      position.performance.attribution=attributeLPPerformance({position:{...original,contract:position.contract},metric:position.performance,
        comparison:row?.comparison,observedAt:view.generated});
      position.performance.attribution.capitalVersion=createHash('sha256').update(JSON.stringify([original.deposits,original.withdrawals,original.wallet,
        original.transferred,original.at_start])).digest('hex');
    }
  }
  return view;
}

export default async function handler(req, res) {
  responseHeaders(res);
  try {
    const origin = requestOrigin(req);
    const view = await readLive(origin, () => readBook(origin));
    const query=req.query||Object.fromEntries(new URL(req.url||'/','https://dashboard.invalid').searchParams);
    if(query.view==='cost-evidence'){
      res.setHeader('cache-control','no-store');
      const result=await readPositionCostEvidence({book:checkpoints.get(origin)?.book,chain:query.chain,positionId:query.positionId});
      return res.status(200).end(JSON.stringify(result));
    }
    responseHeaders(res, lpViewComplete(view));
    res.status(200).end(JSON.stringify(view));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}
