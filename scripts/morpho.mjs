/* Append a pinned Morpho observation every job run. On first use, recover the
   preceding fortnight from Katana's archive state at roughly six-hour steps.
   Every historical point uses its own block's collateral, accrued debt, oracle,
   avKAT conversion rate and KAT pool price. No point is priced at today's price.

   Run manually: node scripts/morpho.mjs [--backfill-days 14]
   Existing samples are immutable and the file is saved after each read, so an
   interrupted bootstrap resumes without losing the observations already read. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readMorpho, katanaRpc, mergeHistory, WALLET, MARKETS } from '../morpho-core.mjs';

export function validateMorphoHistory(history) {
  const fail = reason => { throw new Error('Invalid Morpho history: ' + reason + '. Existing file was not changed.'); };
  const positiveInteger = n => Number.isSafeInteger(n) && n > 0;
  const finiteAmount = n => Number.isFinite(n) && n >= 0;
  const marketDefs = new Map(MARKETS.map(m => [m.id, m]));
  if (!history || typeof history !== 'object' || Array.isArray(history)) fail('expected an object');
  if (history.version !== 1) fail('unsupported version');
  if (history.chain !== 747474 || history.wallet !== WALLET) fail('chain or wallet mismatch');
  if (!Array.isArray(history.markets) || history.markets.length !== MARKETS.length
    || new Set(history.markets.map(m => m?.id)).size !== MARKETS.length
    || history.markets.some(m => !m || marketDefs.get(m.id)?.key !== m.key)) fail('market definitions do not match');
  if (history.interval_seconds !== 21600) fail('unsupported observation interval');
  if (!Array.isArray(history.samples)) fail('samples must be an array');
  const blocks = new Set();
  let previousTs = 0;
  for (const sample of history.samples) {
    if (!sample || sample.version !== 1 || sample.chain !== 747474 || sample.wallet !== WALLET) fail('sample identity mismatch');
    if (typeof sample.full !== 'boolean' || !sample.errors || typeof sample.errors !== 'object' || Array.isArray(sample.errors)) fail('invalid sample completeness');
    if (!positiveInteger(sample.block) || !positiveInteger(sample.ts) || sample.ts < previousTs || blocks.has(sample.block)) fail('invalid, unordered or duplicate sample block/time');
    blocks.add(sample.block); previousTs = sample.ts;
    if (!Array.isArray(sample.markets) || sample.markets.length !== MARKETS.length
      || new Set(sample.markets.map(m => m?.id)).size !== MARKETS.length) fail('sample markets must contain each tracked market once');
    for (const market of sample.markets) {
      const definition = marketDefs.get(market?.id);
      if (!definition || market.key !== definition.key || market.collateral_token !== definition.collateral_token
        || market.loan_token !== definition.loan_token || market.ts !== sample.ts || market.block !== sample.block) fail('sample market identity or timestamp mismatch');
      if (market.error) { if (typeof market.error !== 'string') fail('market error must be text'); continue; }
      for (const field of ['collateral_amount', 'debt_amount', 'liquidity_amount', 'liquidation_debt_amount']) if (!finiteAmount(market[field])) fail('invalid ' + field);
      if (!finiteAmount(market.lltv) || market.lltv >= 1) fail('invalid LLTV');
      for (const field of ['collateral_usd', 'debt_usd', 'oracle_collateral_usd', 'liquidation_usd', 'health']) {
        if (market[field] !== null && !finiteAmount(market[field])) fail('invalid ' + field);
      }
      if (!market.no_position && (!market.raw || typeof market.raw !== 'object')) fail('position is missing raw chain amounts');
      if (!market.no_position && ['debt', 'borrow_shares', 'liquidation_debt', 'total_borrow_assets', 'total_borrow_shares', 'liquidity']
        .some(key => typeof market.raw[key] !== 'string')) fail('position is missing a required raw chain amount');
      if (market.raw && Object.values(market.raw).some(v => typeof v !== 'string' || !/^\d+$/.test(v))) fail('invalid raw chain amount');
    }
  }
  if (history.bootstrap) {
    const plan = history.bootstrap;
    if (!positiveInteger(plan.start_block) || !positiveInteger(plan.end_block) || plan.end_block < plan.start_block
      || !Array.isArray(plan.blocks) || typeof plan.complete !== 'boolean'
      || plan.blocks.some(b => !positiveInteger(b) || b < plan.start_block || b > plan.end_block)
      || new Set(plan.blocks).size !== plan.blocks.length) fail('invalid pinned bootstrap plan');
  }
  return history;
}

export function loadMorphoHistory(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let history;
  try { history = JSON.parse(text); }
  catch { throw new Error('Invalid Morpho history JSON. Existing file was not changed.'); }
  return validateMorphoHistory(history);
}
async function blockAtOrBefore(ts, head) {
  let lo = 0, hi = Number(BigInt(head.number));
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const b = await katanaRpc('eth_getBlockByNumber', ['0x' + mid.toString(16), false]);
    if (Number(BigInt(b.timestamp)) <= ts) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export async function updateMorphoHistory(root, options = {}) {
  const path = join(root, 'morpho-history.json');
  // Validate before the first network request or write. A corrupted ledger must
  // fail closed instead of being mistaken for a missing file and rebuilt.
  let history = loadMorphoHistory(path);
  const backfillDays = options.backfillDays ?? (history?.samples?.length ? 0 : 14);
  const head = await katanaRpc('eth_getBlockByNumber', ['latest', false]);
  const headBlock = Number(BigInt(head.number)), headTs = Number(BigInt(head.timestamp));
  const blocks = [];
  if (history?.bootstrap && !history.bootstrap.complete) {
    blocks.push(...history.bootstrap.blocks);
    console.log('Morpho archive: resuming the original pinned bootstrap blocks.');
  } else if (backfillDays > 0) {
    const start = await blockAtOrBefore(headTs - backfillDays * 86400, head);
    // Probe an actual archive read before scheduling the rest of the bootstrap.
    const probe = await readMorpho({ block: start });
    if (!probe.full) throw new Error('Archive probe incomplete: ' + JSON.stringify(probe.errors));
    history = mergeHistory(history, probe);
    const count = Math.ceil(backfillDays * 4);
    for (let i = 1; i <= count; i++) blocks.push(Math.round(start + (headBlock - start) * i / count));
    history.bootstrap = { start_block: start, end_block: headBlock, interval_seconds: 21600, blocks, complete: false };
    writeFileSync(path, JSON.stringify(history, null, 2) + '\n');
    console.log('Morpho archive probe passed at block ' + start + '; reading ' + count + ' more pinned blocks.');
  } else if (!history?.samples?.length || headTs - history.samples.at(-1).ts >= 10800) blocks.push(headBlock);

  let added = 0, partial = 0;
  for (const block of [...new Set(blocks)]) {
    if (history?.samples?.some(s => s.block === block)) continue;
    const sample = await readMorpho({ block });
    history = mergeHistory(history, sample);
    writeFileSync(path, JSON.stringify(history, null, 2) + '\n');
    added++;
    if (!sample.full) partial++;
    console.log('Morpho ' + sample.generated_at + ' #' + block + ': ' + (sample.full ? '3 markets read' : 'partial ' + JSON.stringify(sample.errors)));
  }
  if (history?.bootstrap && !history.bootstrap.complete) {
    history.bootstrap.complete = history.bootstrap.blocks.every(b => history.samples.some(s => s.block === b));
    writeFileSync(path, JSON.stringify(history, null, 2) + '\n');
  }
  console.log('Morpho history: ' + (history?.samples?.length || 0) + ' observations; ' + added + ' added; ' + partial + ' partial.');
  return history;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--backfill-days');
  const days = i < 0 ? undefined : Number(process.argv[i + 1]);
  if (days !== undefined && (!Number.isFinite(days) || days <= 0 || days > 60)) throw new Error('Backfill days must be greater than 0 and no more than 60');
  await updateMorphoHistory(join(dirname(fileURLToPath(import.meta.url)), '..'), { backfillDays: days });
}
