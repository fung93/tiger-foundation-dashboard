/* ============================================================================
   scripts/lpbook.mjs — keeps lpbook.json, the LP book's ledger, on disk.

   Run by the 6-hourly Action after update-data.mjs, and runnable on its own:

       node scripts/lpbook.mjs

   The first run photographs every open position and that moment is when tracking
   starts. Every run after moves the book forward through the chain's own events
   and adds one point to the fee curve. The reading and the arithmetic are in
   api/_core.mjs, shared with the page's endpoint, so the two cannot drift apart.
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBook, advanceBook, merklLp, bookLiveRows, feeTotals, BOOK_VERSION } from '../api/_core.mjs';

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1e8) / 1e8]));

export async function updateLpBook(root) {
  const path = join(root, 'lpbook.json');
  const merkl = await merklLp();
  let book = readJson(path);
  const ts = Math.floor(Date.now() / 1000);
  let errors = {}, behind = {}, started = false;

  if (!book || book.version !== BOOK_VERSION) {
    book = await startBook({ pos: readJson(join(root, 'positions.json')) || {},
      data: readJson(join(root, 'data.json')) || {}, merkl });
    started = true;
    console.log(`  lp book: tracking starts now — ${Object.keys(book.positions).length} open position(s) photographed`);
  } else {
    ({ book, errors, behind } = await advanceBook(book, { merkl, maxWindows: 80,
      pos: readJson(join(root, 'positions.json')) || {}, data: readJson(join(root, 'data.json')) || {} }));
    /* One point on the fee curve per run, unless a chain could not be read — a point
       missing a chain's uncollected fees would draw as a drop that never happened. */
    const live = await bookLiveRows(book);
    if (!Object.keys(live.errors).length && !Object.keys(errors).length) {
      book.fee_series.push({ ts, tokens: round(feeTotals(book, live.rows)) });
    }
    errors = { ...errors, ...Object.fromEntries(Object.entries(live.errors).map(([k, v]) => [k + ' (live)', v])) };
  }

  book.runs = (book.runs || []).concat({ ts, started: started || undefined,
    errors: Object.keys(errors).length ? errors : undefined, behind }).slice(-30);
  writeFileSync(path, JSON.stringify(book, null, 1) + '\n');

  const open = Object.values(book.positions).filter((P) => P.status === 'open').length;
  const closed = Object.values(book.positions).length - open;
  console.log(`  lp book: ${open} open, ${closed} closed since ${book.started.iso.slice(0, 16)}`
    + (Object.keys(errors).length ? `, errors: ${JSON.stringify(errors)}` : '')
    + (Object.values(behind).some((n) => n > 0) ? `, still behind: ${JSON.stringify(behind)}` : ''));
  return { book, errors, behind };
}

/* run directly: the repo root is one level up from this file */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  updateLpBook(root).catch((e) => { console.error('lp book failed:', e); process.exit(1); });
}
