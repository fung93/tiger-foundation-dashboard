/* Alex's KAT trades since 27 Oct 2026 16:02 MYT and the KAT/vbUSDC pool's hourly closing
   price: kat-trades.json, for the KAT page.

   Each run reads only the blocks since the last one: the two wallets' token transfers
   (trades are found in them with kat-core.mjs) and the pool's swaps. A deposit sent to a
   swap service and not yet paid back is kept in "pending" for up to three days, so a trade
   that straddles two runs is still found. The file is checked before any network read.

   Run manually: node scripts/kat-trades.mjs */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { advanceKat, katReaders, pricesNow } from '../api/kat-trades.mjs';
import { emptyBook, validateBook } from '../kat-core.mjs';

export const KAT_FILE = 'kat-trades.json';

/* one trade, one deposit and one hour per line, so the six-hourly commits diff by what changed */
export function formatBook(f) {
  const list = (rows) => (rows.length ? '\n' + rows.map((r) => '    ' + JSON.stringify(r)).join(',\n') + '\n  ' : '');
  return `{"version": ${f.version}, "chain": ${f.chain}, "start": ${JSON.stringify(f.start)}, "last_block": ${f.last_block}, "last_ts": ${f.last_ts},\n`
    + `  "trades": [${list(f.trades)}],\n  "pending": [${list(f.pending)}],\n  "hours": [${list(f.hours)}]\n}\n`;
}

export async function updateKatTrades(root) {
  const path = join(root, KAT_FILE);
  const file = existsSync(path) ? validateBook(JSON.parse(readFileSync(path, 'utf8'))) : emptyBook();
  const io = katReaders();
  const [{ head, headTs }, px] = await Promise.all([io.tip(), pricesNow()]);
  const next = validateBook(await advanceKat(file, { head, headTs, ethUsd: px.eth, ...io }));
  writeFileSync(path, formatBook(next));
  console.log(`kat trades: ${next.trades.length} trades, ${next.pending.length} deposits waiting, ${next.hours.length} hourly prices, to block ${head}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await updateKatTrades(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
