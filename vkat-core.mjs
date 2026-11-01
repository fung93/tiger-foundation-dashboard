/* ============================================================================
   vkat-core.mjs: Alex's vKAT votes and what they earned, epoch by epoch. Pure maths
   shared by the vKAT page, its API (api/vkat.mjs) and the six-hourly job
   (scripts/vkat-votes.mjs). No network.

   - Votes: the gauge voter's events naming his wallet. Each carries the epoch, the pool
     (the gauge is the pool) and the votes added (vote) or taken off (reset); a vote
     stands from epoch to epoch until it is changed. An epoch's vote is the standing
     allocation with the most votes in it (the latest, if equal), so a lock moved into
     avKAT after the vote week does not hide the vote it cast.
   - Rewards: Merkl's breakdowns named AragonBribes_<pool>_<vKAT id>. Each belongs to the
     epoch its campaign ends in, and is valued at its token's price when it ended.
   - APY: an epoch's reward over the vKAT that voted, valued at KAT's price when that
     epoch's vote week closed, compounded over the 26 epochs of a year (365 / 14).
   ========================================================================== */

export const CHAIN = 747474;
export const VOTER = '0x5e755a3c5dc81a79de7a7cef192ffa60964c9352';   /* gauge voter: the gauges are the pools */
export const VKAT_NFT = '0x106f7d67ea25cb9eff5064cf604ebf6259ff296d';
export const ESCROW = '0x4d6fc15ca6258b168225d283262743c623c13ead';   /* locked(id), votingPower(id) */
export const KAT = '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d';
export const WALLETS = ['0xb378207ab46aa2105eb1cb94ae8a5bab57316de1', '0x4da1d0d5f7b123364d7580f19b716de2ed4e9770'];
/* vote and reset: topics [event, voter, gauge, epoch], data [votes, gauge total, all votes, time] */
export const VOTE_TOPIC = '0x9597ca1d5e7730de0b0614eeeea16ce1a90d9798253c18b1b4941ae3d2d454ec';
export const RESET_TOPIC = '0xe87470fcfb5344dc8e12bed9dd48daacd950077df9304ffc65c423ee4fb44355';
export const EPOCH = 14 * 86400;
export const VOTE_WEEK = 7 * 86400 - 3600;   /* voteDuration less the hour's buffer: the week closes at 07:00 MYT */
export const PER_YEAR = 365 / 14;

export const epochOf = (ts) => Math.floor(ts / EPOCH);
export const epochStart = (n) => n * EPOCH;
export const voteClose = (n) => n * EPOCH + VOTE_WEEK;
const lc = (a) => String(a || '').toLowerCase();

/* a gauge voter log as [block, index, ts, kind (1 vote, 0 reset), gauge, epoch, votes, wallet] */
export function voteFromLog(log, topics = { vote: VOTE_TOPIC, reset: RESET_TOPIC }) {
  const kind = log.topics[0] === topics.vote ? 1 : log.topics[0] === topics.reset ? 0 : -1;
  if (kind < 0 || log.topics.length !== 4) return null;
  if (!log.blockTimestamp || log.blockTimestamp === '0x0') throw new Error('A vote log came without its block time');
  return [Number(BigInt(log.blockNumber)), Number(BigInt(log.logIndex)), Number(BigInt(log.blockTimestamp)), kind,
    '0x' + log.topics[2].slice(26).toLowerCase(), Number(BigInt(log.topics[3])), Number(BigInt('0x' + log.data.slice(2, 66))) / 1e18,
    '0x' + log.topics[1].slice(26).toLowerCase()];
}

/* Each epoch's vote, from the first epoch that had one to `through`: the pools and the
   votes in each. A vote adds its votes to its pool, a reset takes them off; the state
   after each transaction is a candidate, and so is the vote carried in from before. */
export function epochVotes(events, through) {
  const list = [...events].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const standing = new Map(), byEpoch = new Map();
  const total = (m) => [...m.values()].reduce((s, v) => s + v, 0);
  const snap = (epoch, at) => {
    const t = total(standing);
    const best = byEpoch.get(epoch);
    if (t > 1e-6 && (!best || t >= best.total - 1e-9)) {
      byEpoch.set(epoch, { epoch, at, total: t, pools: [...standing.entries()].filter(([, v]) => v > 1e-6).map(([gauge, votes]) => ({ gauge, votes })).sort((a, b) => b.votes - a.votes) });
    }
  };
  let i = 0, epoch = list.length ? list[0][5] : through;
  for (; epoch <= through; epoch++) {
    snap(epoch, epochStart(epoch));   /* the vote carried in */
    while (i < list.length && list[i][5] <= epoch) {
      const block = list[i][0];
      for (; i < list.length && list[i][0] === block; i++) {
        const [, , , kind, gauge, , votes] = list[i];
        const v = (standing.get(gauge) || 0) + (kind ? votes : -votes);
        if (v > 1e-6) standing.set(gauge, v); else standing.delete(gauge);
      }
      snap(list[i - 1][5], list[i - 1][2]);
    }
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

/* the vote standing now: each pool and its votes */
export function standingVotes(events) {
  const standing = new Map();
  for (const [, , , kind, gauge, , votes] of [...events].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const v = (standing.get(gauge) || 0) + (kind ? votes : -votes);
    if (v > 1e-6) standing.set(gauge, v); else standing.delete(gauge);
  }
  return [...standing.entries()].map(([gauge, votes]) => ({ gauge, votes })).sort((a, b) => b.votes - a.votes);
}

/* Merkl's breakdowns for the vote: { campaign, gauge, id, token, address, decimals, amount, claimed } */
export function bribeRows(merklUser, wallet) {
  const out = [];
  for (const ch of merklUser || []) for (const r of ch.rewards || []) for (const b of r.breakdowns || []) {
    const m = /^AragonBribes_(0x[0-9a-fA-F]{40})_(\d+)$/.exec(b.reason || '');
    if (!m || !r.token) continue;
    const d = Number(r.token.decimals);
    const raw = BigInt(b.amount || '0'), scale = 10n ** BigInt(d);
    const amount = Number(raw / scale) + Number(raw % scale) / Number(scale);
    if (!(amount > 0)) continue;
    out.push({ campaign: lc(b.campaignId), gauge: lc(m[1]), id: Number(m[2]), token: r.token.symbol, address: lc(r.token.address), decimals: d,
      amount, claimed: Number(BigInt(b.claimed || '0')) / 10 ** d, wallet: lc(wallet) });
  }
  return out;
}

/* The page's view: each epoch's vote and reward, newest last, and the totals.
   rewards carry { epoch, token, amount, usd }; katUsd maps an epoch to KAT's price when
   its vote week closed (or now, while it is open). The average counts the epochs whose
   vote week has closed by `now`, when their rewards are settled. */
export function voteBook(events, rewards, katUsd, through, now = epochStart(through)) {
  const epochs = epochVotes(events, through).map((e) => ({ ...e, rewards: {}, usd: 0, kat_usd: katUsd[e.epoch] ?? null }));
  const at = new Map(epochs.map((e) => [e.epoch, e]));
  for (const r of rewards) {
    let e = at.get(r.epoch);
    if (!e) { e = { epoch: r.epoch, at: epochStart(r.epoch), total: 0, pools: [], rewards: {}, usd: 0, kat_usd: katUsd[r.epoch] ?? null }; at.set(r.epoch, e); epochs.push(e); }
    e.rewards[r.token] = (e.rewards[r.token] || 0) + r.amount;
    e.usd += r.usd || 0;
  }
  epochs.sort((a, b) => a.epoch - b.epoch);
  let cumulative = 0, usdSum = 0, valueSum = 0;
  for (const e of epochs) {
    cumulative += e.usd; e.cumulative = cumulative;
    const value = e.total > 0 && e.kat_usd > 0 ? e.total * e.kat_usd : null;
    e.value_usd = value;
    e.rate = value ? e.usd / value : null;
    e.apr = e.rate === null ? null : e.rate * PER_YEAR;
    e.apy = e.rate === null ? null : Math.pow(1 + e.rate, PER_YEAR) - 1;
    e.settled = voteClose(e.epoch) <= now;
    if (value && e.settled) { usdSum += e.usd; valueSum += value; }
  }
  const rate = valueSum > 0 ? usdSum / valueSum : null;
  const tokens = {}, tokens_usd = {};
  for (const r of rewards) { tokens[r.token] = (tokens[r.token] || 0) + r.amount; tokens_usd[r.token] = (tokens_usd[r.token] || 0) + (r.usd || 0); }
  return { epochs, total_usd: cumulative, tokens, tokens_usd, voted: epochs.filter((e) => e.total > 0).length,
    claimed: rewards.every((r) => !(r.claimed < r.amount - 1e-12)),
    rate, apr: rate === null ? null : rate * PER_YEAR, apy: rate === null ? null : Math.pow(1 + rate, PER_YEAR) - 1 };
}

/* the ledger the job keeps, checked before anything is added to it */
export const emptyLedger = () => ({ version: 1, chain: CHAIN, last_block: 0, last_ts: 0, events: [], pools: {}, campaigns: {}, rewards: [], kat_usd: {} });

export function validateLedger(f) {
  const fail = (why) => { throw new Error('Invalid vKAT votes file: ' + why + '. Existing file was not changed.'); };
  if (!f || typeof f !== 'object' || Array.isArray(f)) fail('expected an object');
  if (f.version !== 1 || f.chain !== CHAIN) fail('unsupported version or chain');
  if (!Number.isSafeInteger(f.last_block) || f.last_block < 0 || !Number.isSafeInteger(f.last_ts)) fail('bad last block');
  if (!Array.isArray(f.events) || !Array.isArray(f.rewards) || [f.pools, f.campaigns, f.kat_usd].some((o) => !o || typeof o !== 'object' || Array.isArray(o))) fail('bad shape');
  const seen = new Set();
  for (const e of f.events) {
    if (!Array.isArray(e) || e.length !== 8 || !Number.isSafeInteger(e[0]) || !Number.isSafeInteger(e[1]) || !Number.isSafeInteger(e[2]) || ![0, 1].includes(e[3])
      || !/^0x[0-9a-f]{40}$/.test(e[4]) || !Number.isSafeInteger(e[5]) || !(e[6] >= 0) || !/^0x[0-9a-f]{40}$/.test(e[7])) fail('bad vote event');
    const k = e[0] + ':' + e[1];
    if (seen.has(k)) fail('a vote event twice');
    seen.add(k);
  }
  for (const r of f.rewards) {
    if (!r || !/^0x[0-9a-f]{64}$/.test(r.campaign) || !/^0x[0-9a-f]{40}$/.test(r.gauge) || !Number.isSafeInteger(r.id) || !(r.amount > 0) || typeof r.token !== 'string') fail('bad reward');
    if (!f.campaigns[r.campaign]) fail('a reward without its campaign dates');
  }
  for (const [id, c] of Object.entries(f.campaigns)) if (!/^0x[0-9a-f]{64}$/.test(id) || !Array.isArray(c) || c.length !== 2 || !Number.isSafeInteger(c[0]) || !Number.isSafeInteger(c[1]) || c[1] < c[0]) fail('bad campaign ' + id);
  return f;
}
