/* One-time, resumable archive backfill from the wallet's first actual Borrow.
   Recent six-hour samples are immutable. Earlier samples are daily, at their
   own pinned blocks. Exact opening-block observations are also retained.
   Only eth_getLogs, receipt/block reads and read-only eth_call are used.

   node scripts/backfill-morpho-starts.mjs --checkpoint <outside-repo.json>
   The checkpoint is saved atomically after every completed observation. */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MARKETS, MORPHO, WALLET, katanaRpc, readMorpho } from '../morpho-core.mjs';
import { loadMorphoHistory } from './morpho.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(ROOT, 'morpho-history.json');
const arg = process.argv.indexOf('--checkpoint');
const checkpointPath = arg < 0 ? join(tmpdir(), 'tiger-morpho-starts-backfill.json') : resolve(process.argv[arg + 1]);
const hex = n => '0x' + n.toString(16);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save = (file, value) => {
  const temporary = file + '.pending';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, file);
};
// Keccak256("Borrow(bytes32,address,address,address,uint256,uint256)"),
// derived from Morpho's EventsLib and verified against actual receipt topics.
const BORROW_TOPIC = '0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43';
const OWNER_TOPIC = '0x' + WALLET.slice(2).padStart(64, '0');
const headers = new Map();
async function header(block) {
  if (!headers.has(block)) {
    const b = await katanaRpc('eth_getBlockByNumber', [hex(block), false]);
    if (!b || Number(BigInt(b.number)) !== block) throw new Error('Unexpected archive block');
    headers.set(block, { ...b, block, ts: Number(BigInt(b.timestamp)) });
  }
  return headers.get(block);
}

async function borrowStarts(headBlock) {
  // Contract + one event topic + indexed onBehalf returns only this wallet's
  // small event set. No OR-topic range restriction and no unfiltered sweep.
  const logs = await katanaRpc('eth_getLogs', [{ address: MORPHO, fromBlock: '0x0', toBlock: hex(headBlock),
    topics: [BORROW_TOPIC, null, OWNER_TOPIC] }], { rpcs: ['https://rpc.katanarpc.com'], timeout: 15000 });
  if (!Array.isArray(logs) || logs.length >= 10000) throw new Error('Borrow log scan is missing or may be truncated');
  const starts = [];
  for (const market of MARKETS) {
    const matching = logs.filter(l => !l.removed && l.address.toLowerCase() === MORPHO
      && l.topics[0] === BORROW_TOPIC && l.topics[1] === market.id && l.topics[2] === OWNER_TOPIC)
      .sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    if (!matching.length) throw new Error('No first Borrow found for ' + market.key);
    const first = matching[0], block = Number(BigInt(first.blockNumber)), b = await header(block);
    const receipt = await katanaRpc('eth_getTransactionReceipt', [first.transactionHash]);
    if (receipt.status !== '0x1' || receipt.blockHash !== b.hash || !receipt.logs.some(l => l.address.toLowerCase() === MORPHO
      && l.topics[0] === BORROW_TOPIC && l.topics[1] === market.id && l.topics[2] === OWNER_TOPIC)) {
      throw new Error('First Borrow receipt could not be verified for ' + market.key);
    }
    starts.push({ id: market.id, key: market.key, ts: b.ts, block, tx_hash: first.transactionHash });
  }
  return starts;
}

async function blockAtOrBefore(ts, lowBlock, highBlock) {
  let lo = await header(lowBlock), hi = await header(highBlock);
  if (ts < lo.ts || ts >= hi.ts) throw new Error('Archive target is outside its bracket');
  let probes = 0;
  while (hi.block - lo.block > 1) {
    // Interpolation usually needs only a few reads on Katana; fall back to
    // bisection if timestamp spacing prevents it from narrowing quickly.
    const guessed = ++probes <= 12
      ? lo.block + Math.floor((ts - lo.ts) / (hi.ts - lo.ts) * (hi.block - lo.block))
      : Math.floor((lo.block + hi.block) / 2);
    const mid = await header(Math.max(lo.block + 1, Math.min(hi.block - 1, guessed)));
    if (mid.ts <= ts) lo = mid; else hi = mid;
  }
  return lo.block;
}

let history = loadMorphoHistory(path);
if (!history || history.version !== 1 || history.chain !== 747474 || history.wallet !== WALLET
  || !Array.isArray(history.samples) || !history.samples.length) throw new Error('Invalid baseline history');
let checkpoint;
try { checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!checkpoint) {
  const head = await katanaRpc('eth_getBlockByNumber', ['latest', false]);
  const starts = await borrowStarts(Number(BigInt(head.number)));
  const earliest = starts.reduce((a, b) => a.ts < b.ts ? a : b);
  const cutoff = history.samples.reduce((a, b) => a.ts < b.ts ? a : b);
  const tasks = [];
  for (let ts = earliest.ts; ts < cutoff.ts; ts += 86400) {
    tasks.push({ key: 'daily:' + ts, ts, interval_seconds: 86400,
      ...(ts === earliest.ts ? { block: earliest.block } : {}) });
  }
  for (const start of starts) tasks.push({ key: 'opening:' + start.key, ts: start.ts, block: start.block,
    interval_seconds: start.ts < cutoff.ts ? 86400 : 21600 });
  checkpoint = { version: 1, wallet: WALLET, chain: 747474, cutoff_block: cutoff.block, cutoff_ts: cutoff.ts,
    earliest_block: earliest.block, borrow_starts: starts, tasks, completed: [],
    baseline_hashes: Object.fromEntries(history.samples.map(s => [s.block, hash(s)])) };
  save(checkpointPath, checkpoint);
}
if (checkpoint.version !== 1 || checkpoint.wallet !== WALLET || checkpoint.chain !== 747474
  || !Array.isArray(checkpoint.tasks) || !Array.isArray(checkpoint.completed)) throw new Error('Invalid backfill checkpoint');
const originalByBlock = new Map(history.samples.map(s => [s.block, s]));
for (const [block, digest] of Object.entries(checkpoint.baseline_hashes)) {
  if (hash(originalByBlock.get(Number(block))) !== digest) throw new Error('A baseline observation changed; stopping');
}
const finished = new Set(checkpoint.completed.map(entry => entry.key));
const addedByBlock = new Map(checkpoint.completed.map(entry => [entry.sample.block, entry.sample]));
const pending = checkpoint.tasks.filter(t => !finished.has(t.key));
console.log('Verified first borrowing dates: ' + checkpoint.borrow_starts.map(s => s.key + ' ' + new Date(s.ts * 1000).toISOString()).join('; '));
console.log('Archive checkpoint: ' + finished.size + '/' + checkpoint.tasks.length + ' targets complete; keeping ' + originalByBlock.size + ' existing observations immutable.');
let cursor = 0, failed;
async function worker() {
  while (!failed && cursor < pending.length) {
    const task = pending[cursor++];
    try {
      const block = task.block ?? await blockAtOrBefore(task.ts, checkpoint.earliest_block, checkpoint.cutoff_block);
      let sample = originalByBlock.get(block) || addedByBlock.get(block);
      if (!sample) {
        sample = await readMorpho({ block });
        if (!sample.full || sample.markets.length !== MARKETS.length) throw new Error('Incomplete archived sample: ' + JSON.stringify(sample.errors));
        sample.interval_seconds = task.interval_seconds;
        addedByBlock.set(block, sample);
      }
      checkpoint.completed.push({ key: task.key, sample });
      finished.add(task.key);
      save(checkpointPath, checkpoint);
      if (finished.size % 10 === 0 || task.key.startsWith('opening:')) {
        console.log('Archive ' + finished.size + '/' + checkpoint.tasks.length + ': ' + sample.generated_at + ' #' + block);
      }
    } catch (error) { failed = error; }
  }
}
await Promise.all([worker(), worker()]);
if (failed) throw new Error('Backfill stopped safely; resume with the same checkpoint: ' + failed.message);

// Re-read before the one final replacement so unrelated appended samples survive.
history = loadMorphoHistory(path);
const merged = new Map(history.samples.map(s => [s.block, s]));
for (const [block, digest] of Object.entries(checkpoint.baseline_hashes)) {
  if (hash(merged.get(Number(block))) !== digest) throw new Error('An existing sample changed during backfill');
}
for (const [block, sample] of addedByBlock) if (!merged.has(block)) merged.set(block, sample);
for (const start of checkpoint.borrow_starts) {
  const opening = merged.get(start.block), row = opening?.markets.find(m => m.id === start.id);
  if (!opening?.full || opening.ts !== start.ts || !row || row.error || !(row.debt_amount > 0)) throw new Error('Missing exact Borrow opening observation');
}
history = { ...history, borrow_starts: checkpoint.borrow_starts,
  generated_at: new Date().toISOString(), samples: [...merged.values()].sort((a, b) => a.ts - b.ts || a.block - b.block) };
save(path, history);
checkpoint.complete = true; save(checkpointPath, checkpoint);
console.log('Saved ' + history.samples.length + ' pinned observations, with all ' + Object.keys(checkpoint.baseline_hashes).length + ' original sample objects unchanged.');
