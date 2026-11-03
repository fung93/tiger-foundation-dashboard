/* ============================================================================
   api/vkat: Alex's vKAT votes and their rewards, for the vKAT page.

   The job's ledger (vkat-votes.json, every six hours) plus what is new since: the gauge
   voter's events naming either wallet, Merkl's vote rewards (AragonBribes) with each
   campaign's dates, each reward priced when its campaign ended, and KAT's price when each
   vote week closed. Live on every request: the vKAT locks both wallets hold, the epoch
   clock and KAT's price now. The book itself is vkat-core.mjs's voteBook.

   Read-only: no keys, no wallet, nothing signed.
   ========================================================================== */
import { CFG, multi, rpc, keccakHex } from './_core.mjs';
import { VOTER, VKAT_NFT, ESCROW, KAT, WALLETS, VOTE_TOPIC, RESET_TOPIC, epochOf, epochStart, voteClose, voteFromLog,
  bribeRows, voteBook, standingVotes, emptyLedger, validateLedger } from '../vkat-core.mjs';

const RPC = CFG.katRpc, MERKL = 'https://api.merkl.xyz/v4';
const SPAN = 5000000;
const hex = (n) => '0x' + n.toString(16);
const pad = (x) => '0x' + String(x).replace(/^0x/, '').padStart(64, '0');
const sel = (sig) => '0x' + keccakHex(Buffer.from(sig).toString('hex')).replace(/^0x/, '').slice(0, 8);
const word = (h, i) => BigInt('0x' + (h.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'));

/* where each reward token's dollar price comes from: a vbUSDC pool, read at a block */
const STABLE = new Set(['0x203a662b0bd271a6ed5a60edfbd04bfce608fd36', '0x2dca96907fde857dd3d816880a0df407eeb2d2f2', '0x00000000efe302beaa2b3e6e1b18d08d69a9012a']);
const PRICED = {
  [KAT]: { pool: '0x10045367e619caae6f60cc80046c43c6cd55f629', usd: (s) => 1e12 / (s * s) },                         /* vbUSDC/KAT: KAT token1 */
  '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62': { pool: '0x2a2c512beaa8eb15495726c235472d82effb7a6b', usd: (s) => 1e12 / (s * s) },   /* vbUSDC/vbETH */
  '0x0913da6da4b42f538b445599b46bb4622342cf52': { pool: '0x744676b3ced942d78f9b8e9cd22246db5c32395c', usd: (s) => s * s * 100 },       /* vbWBTC/vbUSDC: vbWBTC token0 */
};

export function vkatReaders() {
  const blocks = new Map();
  const io = {
    getLogs: (filter) => rpc(RPC, 'eth_getLogs', [filter]),
    tip: async () => {
      const n = Number(BigInt(await rpc(RPC, 'eth_blockNumber', [])));
      const b = await rpc(RPC, 'eth_getBlockByNumber', [hex(n), false]);
      return { head: n, headTs: Number(BigInt(b.timestamp)) };
    },
    /* the block at a time: Katana makes one a second, so guess and correct twice */
    blockAt: async (ts, head, headTs) => {
      let n = Math.max(1, Math.min(head, head - (headTs - ts)));
      for (let k = 0; k < 3; k++) {
        if (!blocks.has(n)) blocks.set(n, Number(BigInt((await rpc(RPC, 'eth_getBlockByNumber', [hex(n), false])).timestamp)));
        const off = ts - blocks.get(n);
        if (Math.abs(off) <= 2) break;
        n = Math.max(1, Math.min(head, n + off));
      }
      return n;
    },
    priceAt: async (token, block) => {
      if (STABLE.has(token)) return 1;
      const p = PRICED[token];
      if (!p) return null;
      const r = await rpc(RPC, 'eth_call', [{ to: p.pool, data: '0x3850c7bd' }, block === 'latest' ? 'latest' : hex(block)]);
      return p.usd(Number(word(r, 0)) / 2 ** 96);
    },
    merklUser: async (wallet) => {
      const r = await fetch(`${MERKL}/users/${wallet}/rewards?chainId=747474&breakdownPage=0`, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('Merkl rewards HTTP ' + r.status);
      return r.json();
    },
    campaign: async (id) => {
      const r = await fetch(`${MERKL}/campaigns?campaignId=${id}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('Merkl campaign HTTP ' + r.status);
      const j = await r.json(), c = Array.isArray(j) ? j[0] : j;
      if (!c || !Number.isFinite(c.startTimestamp)) throw new Error('Merkl has no campaign ' + id.slice(0, 10));
      return [c.startTimestamp, c.endTimestamp];
    },
    poolName: async (pool) => {
      const r = await multi(RPC, [{ to: pool, data: '0x0dfe1681' }, { to: pool, data: '0xd21220a7' }, { to: pool, data: '0xddca3f43' }]);
      if (!r[0].ok || !r[1].ok) return pool.slice(0, 10);
      const syms = await multi(RPC, [r[0], r[1]].map((x) => ({ to: '0x' + x.data.slice(26, 66), data: '0x95d89b41' })));
      const sym = (x) => { if (!x.ok) return '?'; const h = x.data.slice(2); const n = parseInt(h.slice(64, 128), 16); return Buffer.from(h.slice(128, 128 + n * 2), 'hex').toString(); };
      const fee = r[2].ok ? Number(word(r[2].data, 0)) / 1e4 : null;
      return `${sym(syms[0])}/${sym(syms[1])}${fee !== null ? ' ' + fee + '%' : ''}`;
    },
  };
  return io;
}

/* Move the ledger to the head: new vote events, pool names, every vote reward Merkl knows
   (with campaign dates fetched once), each priced when its campaign ended, and KAT's price
   when each vote week closed. A failed Merkl read keeps the rewards already saved. */
export async function advanceVkat(file, io, { head, headTs }) {
  const out = structuredClone(file), notes = [];
  const seen = new Set(out.events.map((e) => e[0] + ':' + e[1]));
  for (let a = out.last_block + 1; a <= head; a += SPAN) {
    for (const w of WALLETS) {
      for (const l of await io.getLogs({ address: VOTER, topics: [[VOTE_TOPIC, RESET_TOPIC], pad(w)], fromBlock: hex(a), toBlock: hex(Math.min(head, a + SPAN - 1)) })) {
        const e = voteFromLog(l);
        if (e && !seen.has(e[0] + ':' + e[1])) { seen.add(e[0] + ':' + e[1]); out.events.push(e); }
      }
    }
  }
  out.events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const g of new Set(out.events.map((e) => e[4]))) if (!out.pools[g]) out.pools[g] = await io.poolName(g);

  const prices = new Map();   /* one read per token and moment */
  const priceWhen = async (token, ts) => {
    const k = token + '@' + ts;
    if (!prices.has(k)) prices.set(k, await io.priceAt(token, await io.blockAt(ts, head, headTs)));
    return prices.get(k);
  };
  try {
    const rows = [];
    for (const w of WALLETS) rows.push(...bribeRows(await io.merklUser(w), w));
    const old = new Map(out.rewards.map((r) => [r.campaign + r.address + r.id + r.wallet, r]));
    const next = [];
    for (const r of rows) {
      if (!out.campaigns[r.campaign]) out.campaigns[r.campaign] = await io.campaign(r.campaign);
      if (!out.pools[r.gauge]) out.pools[r.gauge] = await io.poolName(r.gauge);
      const [, end] = out.campaigns[r.campaign], prev = old.get(r.campaign + r.address + r.id + r.wallet);
      /* priced once its campaign has ended, at that moment; until then at today's price */
      let px = prev && prev.final ? prev.px : null, final = !!(prev && prev.final);
      if (px === null) {
        if (end <= headTs) { px = await priceWhen(r.address, end); final = px !== null; }
        else px = await io.priceAt(r.address, 'latest');
      }
      if (px === null) notes.push(`No price for ${r.token}; its vote reward is left out of the dollar total`);
      const { decimals, ...keep } = r;
      next.push({ ...keep, px, usd: px === null ? 0 : r.amount * px, final });
    }
    out.rewards = next.sort((a, b) => out.campaigns[a.campaign][1] - out.campaigns[b.campaign][1] || a.token.localeCompare(b.token));
  } catch (e) { notes.push('Merkl could not be read this time (' + String(e.message || e).slice(0, 60) + '); showing the rewards saved before'); }

  /* KAT's price when each vote week closed, kept once the week is over */
  const epochs = new Set(out.events.map((e) => e[5]));
  for (const r of out.rewards) epochs.add(epochOf(out.campaigns[r.campaign][1] - 1));
  for (let n = Math.min(...epochs); n <= epochOf(headTs); n++) {
    if (out.kat_usd[n] !== undefined || voteClose(n) > headTs) continue;
    out.kat_usd[n] = await priceWhen(KAT, voteClose(n));
  }
  out.last_block = head; out.last_ts = headTs;
  return { file: out, notes };
}

/* the rewards as voteBook wants them: each with its epoch */
export const rewardsByEpoch = (f) => f.rewards.map((r) => ({ ...r, epoch: epochOf(f.campaigns[r.campaign][1] - 1) }));

/* the vKAT locks both wallets hold now */
async function readLocks() {
  const bal = await multi(RPC, WALLETS.map((w) => ({ to: VKAT_NFT, data: '0x70a08231' + pad(w).slice(2) })));
  const owned = [];
  WALLETS.forEach((w, i) => { const n = bal[i].ok ? Number(word(bal[i].data, 0)) : 0; for (let k = 0; k < n; k++) owned.push({ w, k }); });
  const ids = await multi(RPC, owned.map(({ w, k }) => ({ to: VKAT_NFT, data: '0x2f745c59' + pad(w).slice(2) + pad(k.toString(16)).slice(2) })));
  const locks = owned.map((o, i) => ({ wallet: o.w, id: ids[i].ok ? Number(word(ids[i].data, 0)) : null })).filter((l) => l.id !== null);
  const reads = await multi(RPC, locks.flatMap((l) => [{ to: ESCROW, data: sel('locked(uint256)') + pad(l.id.toString(16)).slice(2) }, { to: ESCROW, data: sel('votingPower(uint256)') + pad(l.id.toString(16)).slice(2) }]));
  return locks.map((l, i) => ({ ...l, kat: reads[2 * i].ok ? Number(word(reads[2 * i].data, 0)) / 1e18 : null, since: reads[2 * i].ok ? Number(word(reads[2 * i].data, 1)) : null,
    power: reads[2 * i + 1].ok ? Number(word(reads[2 * i + 1].data, 0)) / 1e18 : null }));
}

/* Katana-wide (Alex, 3 Nov 2026): all the KAT locked in vKAT (the escrow's totalLocked, which
   is its KAT balance), how many locks there are, KAT's supply, and the avKAT vault: its supply,
   the KAT behind it and its rate (convertToAssets of one avKAT), now and a week back (archive,
   a block a second). avKAT's KAT is itself one vKAT lock, its compound strategy's, so it is
   part of the total locked. */
const AVKAT = '0x7231dbacdfc968e07656d12389ab20de82fbfceb';
async function readNetwork(head) {
  const one = pad((10n ** 18n).toString(16)).slice(2);
  const calls = [{ to: ESCROW, data: sel('totalLocked()') }, { to: VKAT_NFT, data: sel('totalSupply()') }, { to: KAT, data: sel('totalSupply()') },
    { to: AVKAT, data: sel('totalSupply()') }, { to: AVKAT, data: sel('totalAssets()') }, { to: AVKAT, data: sel('convertToAssets(uint256)') + one }];
  const [now, week] = await Promise.all([multi(RPC, calls, hex(head)), multi(RPC, [calls[5]], hex(head - 7 * 86400))]);
  const val = (r, d = 18) => { if (!r || !r.ok || r.data.length < 66) throw new Error('a network total did not answer'); return Number(word(r.data, 0)) / 10 ** d; };
  return { locked: val(now[0]), locks: val(now[1], 0), kat_supply: val(now[2]), avkat_supply: val(now[3]), avkat_kat: val(now[4]),
    avkat_rate: val(now[5]), avkat_rate_7d: week[0] && week[0].ok && week[0].data.length >= 66 ? val(week[0]) : null };
}

export async function readVkat(saved, now = Math.floor(Date.now() / 1000)) {
  const notes = [];
  let file = emptyLedger();
  if (saved) {
    try { file = validateLedger(saved); }
    catch (e) { notes.push('The saved ledger could not be used (' + e.message.slice(0, 80) + '); read from the chain instead.'); }
  } else notes.push('The saved ledger could not be read; read from the chain instead.');
  const io = vkatReaders();
  const { head, headTs } = await io.tip();
  const [adv, locks, katNow, network] = await Promise.all([advanceVkat(file, io, { head, headTs }), readLocks(), io.priceAt(KAT, 'latest'),
    readNetwork(head).catch((e) => { notes.push('The Katana network totals could not be read this time (' + String(e.message || e).slice(0, 60) + ').'); return null; })]);
  notes.push(...adv.notes);
  const f = adv.file, epochNow = epochOf(headTs);
  const katUsd = { ...f.kat_usd, [epochNow]: f.kat_usd[epochNow] ?? katNow };
  const book = voteBook(f.events, rewardsByEpoch(f), katUsd, epochNow, headTs);
  const open = headTs < voteClose(epochNow);
  return {
    at: now, head, head_ts: headTs, kat_usd: katNow, epoch: epochNow,
    vote_week: open ? { open: true, opens: epochStart(epochNow), closes: voteClose(epochNow) } : { open: false, opens: epochStart(epochNow + 1), closes: voteClose(epochNow + 1) },
    locks, standing: standingVotes(f.events), pools: f.pools, book, ledger_to: file.last_ts, network, health: { notes },
  };
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  /* a minute at the edge: votes change once a fortnight, rewards once a week */
  res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=60');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  let saved = null;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host, proto = req.headers['x-forwarded-proto'] || 'https';
    const r = await fetch(proto + '://' + host + '/vkat-votes.json?t=' + Date.now(), { signal: AbortSignal.timeout(8000) });
    if (r.ok) saved = await r.json();
  } catch (e) { /* read everything from the chain instead */ }
  try { res.status(200).end(JSON.stringify(await readVkat(saved))); }
  catch (e) { res.status(502).end(JSON.stringify({ error: String((e && e.message) || e) })); }
}
