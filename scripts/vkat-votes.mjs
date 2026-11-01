/* Alex's vKAT votes and their rewards: vkat-votes.json, for the vKAT page.

   Each run reads only the blocks since the last one for new votes, asks Merkl for every
   vote reward (fetching a campaign's dates the first time it is seen), prices each reward
   once its campaign has ended, and records KAT's price when each vote week closed. The
   file is checked before any network read.

   Run manually: node scripts/vkat-votes.mjs */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { advanceVkat, vkatReaders } from '../api/vkat.mjs';
import { emptyLedger, validateLedger } from '../vkat-core.mjs';

export const VKAT_FILE = 'vkat-votes.json';

/* one vote event and one reward per line, so the six-hourly commits diff by what changed */
export function formatLedger(f) {
  const list = (rows) => (rows.length ? '\n' + rows.map((r) => '    ' + JSON.stringify(r)).join(',\n') + '\n  ' : '');
  return `{"version": ${f.version}, "chain": ${f.chain}, "last_block": ${f.last_block}, "last_ts": ${f.last_ts},\n`
    + `  "pools": ${JSON.stringify(f.pools)},\n  "kat_usd": ${JSON.stringify(f.kat_usd)},\n  "campaigns": ${JSON.stringify(f.campaigns)},\n`
    + `  "events": [${list(f.events)}],\n  "rewards": [${list(f.rewards)}]\n}\n`;
}

export async function updateVkatVotes(root) {
  const path = join(root, VKAT_FILE);
  const file = existsSync(path) ? validateLedger(JSON.parse(readFileSync(path, 'utf8'))) : emptyLedger();
  const io = vkatReaders();
  const { file: next, notes } = await advanceVkat(file, io, await io.tip());
  for (const n of notes) console.warn('vkat votes:', n);
  writeFileSync(path, formatLedger(validateLedger(next)));
  console.log(`vkat votes: ${next.events.length} vote events, ${next.rewards.length} rewards, to block ${next.last_block}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await updateVkatVotes(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
