/* Optional live verification. Reads public chain state and a local book copy;
   never changes a ledger, sends a transaction or requires a credential. */
import { readFile, appendFile } from 'node:fs/promises';
import { CFG, advanceBook, bookLiveRows } from '../api/_core.mjs';
import { readBasePortfolio } from '../api/_base-portfolio.mjs';

const readings = [];
for (const wallet of CFG.wallets) readings.push(await readBasePortfolio({ address: wallet.address }));
const source = JSON.parse(await readFile(new URL('../lpbook.json', import.meta.url), 'utf8'));
const advanced = await advanceBook(source, { onlyChains: ['base'], maxWindows: 80 });
if (advanced.errors.base || advanced.behind.base > 0) throw Error('Base LP Book catch-up is incomplete: ' + (advanced.errors.base || advanced.behind.base));
const positions = Object.fromEntries(Object.entries(advanced.book.positions).filter(([, p]) => p.chain === 'base'));
const live = await bookLiveRows({ ...advanced.book, positions });
if (live.errors.base) throw Error('Base LP Book live valuation is incomplete: ' + live.errors.base);
for (const view of readings) for (const p of view.lp_positions.filter(p => p.liquidity_usd > 0)) {
  if (!positions['base:' + p.token_id] || !live.rows['base:' + p.token_id]) throw Error('An owned Base LP is missing from the book: #' + p.token_id);
}
const lines = ['Base Uniswap V3 live verification', '', '| Wallet | Source block | Open LPs | Position IDs |', '|---|---:|---:|---|'];
for (const [i, view] of readings.entries()) lines.push('| ' + (i === 0 ? 'Main' : 'Tiger Vault') + ' | ' + view.block + ' | ' + view.lp_positions.length + ' | '
  + (view.lp_positions.map(p => '#' + p.token_id).join(', ') || 'None') + ' |');
lines.push('', 'Verified ownership, pinned balances/fees and LP Book inclusion. No ledger was written.');
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
