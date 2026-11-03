/* Hourly low and high tick of every pool paying KAT to staked LPs, and of the pools without
   KAT the page also shows (FEE_POOLS): strategy-ranges.json, for the Strategy page's
   7D / 14D / 21D / 30D range buttons.

   Each run reads only the swaps since the last one; a pool seen for the first time gets its
   last 31 days (about 60,000 swaps across the five pools on 1 Nov 2026). Ticks are stored,
   not prices, so nothing here depends on a token's dollar price. The file is checked before
   any network read and saved after each pool, so an interrupted first run resumes where it
   stopped.

   Run manually: node scripts/strategy-ranges.mjs */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CFG, rpc } from '../api/_core.mjs';
import { readCampaigns, FEE_POOLS, swapLogs } from '../api/strategy.mjs';
import { mergeSwapHours, pruneHours, swapFromLog, RANGE_KEEP_DAYS, HOUR } from '../strategy-core.mjs';

export const RANGES_FILE = 'strategy-ranges.json';
const SPAN = 200000;   /* Katana serves wide windows for one pool's swaps; ~2.3 days of blocks */

export const emptyRanges = () => ({ version: 1, chain: 747474, hour_seconds: HOUR, keep_days: RANGE_KEEP_DAYS, updated_at: 0, pools: {} });

export function validateRanges(f) {
  const fail = (why) => { throw new Error('Invalid strategy ranges: ' + why + '. Existing file was not changed.'); };
  if (!f || typeof f !== 'object' || Array.isArray(f)) fail('expected an object');
  if (f.version !== 1 || f.chain !== 747474 || f.hour_seconds !== HOUR) fail('unsupported version, chain or interval');
  if (!f.pools || typeof f.pools !== 'object' || Array.isArray(f.pools)) fail('pools must be an object');
  for (const [pool, e] of Object.entries(f.pools)) {
    if (!/^0x[0-9a-f]{40}$/.test(pool)) fail('bad pool address ' + pool);
    if (!e || !Number.isSafeInteger(e.last_block) || e.last_block < 0 || !Number.isSafeInteger(e.recorded_from) || !Array.isArray(e.hours)) fail('bad entry for ' + pool);
    let prev = -Infinity;
    for (const h of e.hours) {
      if (!Array.isArray(h) || h.length !== 5 || !h.every(Number.isSafeInteger) || h[0] % HOUR || h[0] <= prev
        || h[1] > h[2] || h[3] < 1 || h[4] < h[1] || h[4] > h[2]) fail('bad hour row in ' + pool);
      prev = h[0];
    }
  }
  return f;
}

/* Move every pool forward to the head. The log reader is passed in, so the tests run this
   without a network. A pool that stopped paying keeps its rows until they age out. */
export async function advanceRanges(file, { pools, head, headTs, blocksPerSecond, getLogs, onPool }) {
  const out = structuredClone(file);
  const cutoff = headTs - RANGE_KEEP_DAYS * 86400;
  for (const pool of pools) {
    const prev = out.pools[pool];
    const start = prev ? prev.last_block + 1 : Math.max(0, head - Math.ceil(RANGE_KEEP_DAYS * 86400 * blocksPerSecond * 1.02));
    const swaps = [];
    for (let a = start; a <= head; a += SPAN) for (const l of await getLogs(pool, a, Math.min(head, a + SPAN - 1))) swaps.push(swapFromLog(l));
    const hours = pruneHours(mergeSwapHours(prev ? prev.hours : [], swaps.filter((s) => s.ts >= cutoff)), cutoff);
    out.pools[pool] = { last_block: head, last_ts: headTs, recorded_from: prev ? Math.max(prev.recorded_from, cutoff) : cutoff, hours };
    if (onPool) await onPool(out);
  }
  for (const [pool, e] of Object.entries(out.pools)) {
    e.hours = pruneHours(e.hours, cutoff);
    e.recorded_from = Math.max(e.recorded_from, cutoff);
    if (!pools.includes(pool) && !e.hours.length) delete out.pools[pool];
  }
  out.updated_at = headTs;
  return out;
}

/* one hour per line, so the six-hourly commits diff by the hours that changed */
export function formatRanges(f) {
  const pools = Object.entries(f.pools).map(([pool, e]) => `  ${JSON.stringify(pool)}: {"last_block": ${e.last_block}, "last_ts": ${e.last_ts}, "recorded_from": ${e.recorded_from}, "hours": [\n`
    + e.hours.map((h) => '    ' + JSON.stringify(h)).join(',\n') + '\n  ]}');
  return `{"version": ${f.version}, "chain": ${f.chain}, "hour_seconds": ${f.hour_seconds}, "keep_days": ${f.keep_days}, "updated_at": ${f.updated_at}, "pools": {\n${pools.join(',\n')}\n}}\n`;
}

export async function updateStrategyRanges(root) {
  const path = join(root, RANGES_FILE);
  const file = existsSync(path) ? validateRanges(JSON.parse(readFileSync(path, 'utf8'))) : emptyRanges();
  const pools = [...new Set([...(await readCampaigns(Math.floor(Date.now() / 1000))).map((p) => p.pool), ...FEE_POOLS.map((p) => p.pool)])];
  const head = Number(BigInt(await rpc(CFG.katRpc, 'eth_blockNumber', [])));
  const [hb, ob] = await Promise.all([head, head - 1000000].map((n) => rpc(CFG.katRpc, 'eth_getBlockByNumber', ['0x' + n.toString(16), false])));
  const headTs = Number(BigInt(hb.timestamp));
  const blocksPerSecond = 1000000 / (headTs - Number(BigInt(ob.timestamp)));
  const getLogs = swapLogs;   /* a window over the node's 10,000-log cap is read in halves */
  const save = (f) => writeFileSync(path, formatRanges(validateRanges(f)));
  const next = await advanceRanges(file, { pools, head, headTs, blocksPerSecond, getLogs, onPool: save });
  save(next);
  const rows = Object.values(next.pools).reduce((n, e) => n + e.hours.length, 0);
  console.log(`strategy ranges: ${Object.keys(next.pools).length} pools, ${rows} hourly rows, to block ${head}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await updateStrategyRanges(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
