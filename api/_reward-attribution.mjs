/* Katana KAT follows a verified replacement LP in the same wallet and pair.
   A committed claim boundary keeps ownership stable across server restarts;
   ambiguous earlier claims wait for a durable complete allocation. No tokens move. */
export const REWARD_ATTRIBUTION_VERSION = 2;
// The current LP was independently verified open at this time. Earlier closed
// positions retain their history, apart from Alex's original explicit transfer.
const START = 1793317439;
const TOKEN = 'KAT@katana', EPS = 1e-8;
const seed = {
  wallet: '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1',
  source: '492291', target: '492626', token: TOKEN,
  claimedBefore: 1338.1368961866224, initialCarry: 2651.4569888919086,
  ts: 1793290481,
};
const amount = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const cents = n => Math.round(n * 100) / 100;
const key = id => 'katana:' + id;
const owner = p => typeof p?.wallet === 'string' ? p.wallet.toLowerCase() : '';
const katana = p => p?.chain === 'katana' && p.kind !== 'fables';
const samePair = (a, b) => a.t0 && a.t1 && b.t0 && b.t1
  ? [a.t0, a.t1].sort().join('|') === [b.t0, b.t1].sort().join('|')
  : !!a.pool && a.pool === b.pool;
const copyMaps = map => Object.fromEntries(Object.entries(map || {}).map(([id, tokens]) => [id, { ...tokens }]));
const claimId = c => [c.wallet?.toLowerCase(), c.token, c.block, c.ts, c.amount].join('|');

export function anchorRewardRollovers(book) {
  if (!book.reward_rollover_anchor) book.reward_rollover_anchor = {
    claimed: Object.fromEntries(Object.values(book.positions || {}).filter(katana)
      .map(p => [p.key, p.claimed_seen?.[TOKEN] || 0])),
    claims: (book.claims || []).map(claimId),
  };
}

function rulesOf(book) {
  if (!book) return [{ ...seed }];
  if (book.reward_rollovers !== undefined) {
    if (!Array.isArray(book.reward_rollovers)) throw new Error('The saved reward rollover ledger is invalid.');
    return book.reward_rollovers.map(r => ({ ...r })).sort((a, b) =>
      (book.positions?.[key(a.source)]?.opened_ts || 0) - (book.positions?.[key(b.source)]?.opened_ts || 0));
  }
  const source = book.positions?.[key(seed.source)], target = book.positions?.[key(seed.target)];
  return source && target && owner(source) === seed.wallet && owner(target) === seed.wallet ? [{ ...seed }] : [];
}

export function attributeMerklRewards(merkl, book) {
  if (!merkl || merkl.error) throw new Error('A complete reward reading is required for KAT rollovers.');
  const rules = rulesOf(book), signature = JSON.stringify(rules);
  if (merkl.reward_attribution_version !== undefined) {
    if (merkl.reward_attribution_version === REWARD_ATTRIBUTION_VERSION
      && merkl.reward_rollover_signature === signature) return merkl;
    throw new Error('A raw reward reading is required for this rollover ledger.');
  }
  const result = { ...merkl, earned_tokens_by_id: copyMaps(merkl.earned_tokens_by_id),
    claimed_tokens_by_id: copyMaps(merkl.claimed_tokens_by_id), earned_by_id: { ...merkl.earned_by_id },
    reward_attribution_version: REWARD_ATTRIBUTION_VERSION, reward_rollover_signature: signature,
    reward_rollover_basis: {} };
  const used = new Set(), touched = new Set();
  for (const r of rules) {
    if (!r || r.token !== TOKEN || r.source === r.target || used.has(r.source)
      || !amount(r.claimedBefore) || !amount(r.initialCarry) || !r.wallet)
      throw new Error('The saved reward rollover relationship is invalid.');
    if (used.has(r.target)) throw new Error('The reward rollover ledger is cyclic or out of order.');
    const sourcePosition = book?.positions?.[key(r.source)], targetPosition = book?.positions?.[key(r.target)];
    if (book && (!katana(sourcePosition) || sourcePosition.status !== 'closed' || !katana(targetPosition)
      || owner(sourcePosition) !== r.wallet.toLowerCase() || owner(targetPosition) !== r.wallet.toLowerCase()
      || !samePair(sourcePosition, targetPosition) || targetPosition.opened_ts <= sourcePosition.opened_ts))
      throw new Error('The reward rollover positions do not have the same wallet and token pair.');
    used.add(r.source);
    for (const id of [r.source, r.target]) {
      const e = result.earned_tokens_by_id[id]?.[TOKEN], c = result.claimed_tokens_by_id[id]?.[TOKEN];
      if (merkl.wallet_by_id?.[id]?.toLowerCase() !== r.wallet.toLowerCase()
        || !amount(e) || !amount(c) || c > e + EPS)
        throw new Error('KAT rollovers need verified rewards for both positions in the same wallet.');
      touched.add(id);
    }
    const e = result.earned_tokens_by_id[r.source][TOKEN], c = result.claimed_tokens_by_id[r.source][TOKEN];
    if (Math.min(e, c) < r.claimedBefore - EPS)
      throw new Error('The reward reading fell below the recorded rollover claim boundary.');
    result.earned_tokens_by_id[r.source][TOKEN] = Math.min(e, r.claimedBefore);
    result.claimed_tokens_by_id[r.source][TOKEN] = Math.min(c, r.claimedBefore);
    result.earned_tokens_by_id[r.target][TOKEN] += Math.max(0, e - r.claimedBefore);
    result.claimed_tokens_by_id[r.target][TOKEN] += Math.max(0, c - r.claimedBefore);
  }
  // Inherited rewards belong in Rewards and Net. Exclude their entire balance
  // from the replacement's APR, including late settlements from older NFTs.
  for (const r of rules) result.reward_rollover_basis[key(r.target)] = Math.max(0,
    result.earned_tokens_by_id[r.target][TOKEN] - (merkl.earned_tokens_by_id[r.target]?.[TOKEN] || 0));
  for (const id of touched) result.earned_by_id[id] = cents(Object.entries(result.earned_tokens_by_id[id])
    .reduce((sum, [token, n]) => sum + n * (merkl.token_price?.[token] || 0), 0));
  return result;
}

export function rewardAttributionLedgerIssue(book, merkl) {
  if (merkl?.error) return null;
  for (const r of rulesOf(book)) {
    const source = book.positions?.[key(r.source)];
    if (!source) continue;
    const seen = source.claimed_seen?.[TOKEN] ?? 0;
    const credited = (source.claims || []).reduce((sum, claim) => sum + (claim.tokens?.[TOKEN] ?? 0), 0);
    if (!amount(seen) || !amount(credited) || Math.max(seen, credited) > r.claimedBefore + EPS)
      return 'Saved claims overlap a KAT rollover. Retaining the previous reward allocation until the ledger is reconciled.';
  }
  return null;
}

/* Native observations are separate from effective balances: a new NFT can have
   no Merkl campaign yet, but a previously positive native reading cannot vanish. */
export function prepareBookRewards(book, raw) {
  if (!raw || raw.error || raw.reward_attribution_version !== undefined)
    throw new Error('A complete raw reward reading is required for KAT rollovers.');
  const rules = rulesOf(book), participants = new Set(rules.flatMap(r => [r.source, r.target]));
  const normalized = { ...raw, earned_tokens_by_id: copyMaps(raw.earned_tokens_by_id),
    claimed_tokens_by_id: copyMaps(raw.claimed_tokens_by_id), wallet_by_id: { ...raw.wallet_by_id } };
  const native = { ...book.reward_native };
  for (const p of Object.values(book.positions || {}).filter(katana)) {
    if (p.status !== 'open' && !(p.closed_ts >= START) && !participants.has(p.id)) continue;
    const e = normalized.earned_tokens_by_id[p.id]?.[TOKEN], c = normalized.claimed_tokens_by_id[p.id]?.[TOKEN];
    const previous = native[p.key], known = previous?.earned ?? (p.merkl?.[TOKEN] || 0);
    if (e === undefined) {
      if (c !== undefined && c !== 0) throw new Error('The Katana reward counters are incomplete.');
      if (known > EPS) throw new Error('A previously recorded Katana reward is missing from Merkl.');
      normalized.earned_tokens_by_id[p.id] = { ...normalized.earned_tokens_by_id[p.id], [TOKEN]: 0 };
      normalized.claimed_tokens_by_id[p.id] = { ...normalized.claimed_tokens_by_id[p.id], [TOKEN]: 0 };
      normalized.wallet_by_id[p.id] = owner(p);
    } else if (!amount(e) || !amount(c) || c > e + EPS || normalized.wallet_by_id[p.id]?.toLowerCase() !== owner(p)) {
      throw new Error('The Katana native reward reading is invalid.');
    }
    if (previous && (normalized.earned_tokens_by_id[p.id][TOKEN] < previous.earned - EPS
      || normalized.claimed_tokens_by_id[p.id][TOKEN] < previous.claimed - EPS))
      throw new Error('The Katana reward reading is older than its last complete observation.');
    native[p.key] = { earned: normalized.earned_tokens_by_id[p.id][TOKEN], claimed: normalized.claimed_tokens_by_id[p.id][TOKEN] };
  }
  const effective = attributeMerklRewards(normalized, { ...book, reward_rollovers: rules });
  const issue = rewardAttributionLedgerIssue({ ...book, reward_rollovers: rules }, effective);
  if (issue) throw new Error(issue);
  book.reward_native = native;
  book.reward_rollovers = rules;
  book.reward_rollover_basis = effective.reward_rollover_basis;
  return effective;
}

/* Only complete lifecycle reads may establish new relationships. A replacement
   may be minted before the close; later mints have no arbitrary expiry date. */
export function registerKatanaRollovers(book, effective, { persistRollovers = false } = {}) {
  const issues = [], rules = rulesOf(book), positions = Object.values(book.positions || {}).filter(katana);
  const sources = new Set(rules.map(r => r.source));
  const closed = positions.filter(p => p.status === 'closed' && p.closed_ts >= START && !sources.has(p.id))
    .sort((a, b) => a.closed_ts - b.closed_ts);
  for (const source of closed) {
    let candidates = positions.filter(p => p.id !== source.id && owner(p) === owner(source) && samePair(p, source)
      && p.opened_ts >= START && p.opened_ts > source.opened_ts
      && p.opened_ts >= source.closed_ts - 86400 && (!p.closed_ts || p.closed_ts >= source.closed_ts));
    if (!candidates.length) continue;
    // Make identity independent of future observations: a later mint must never
    // replace an earlier verified successor on a cold server reconstruction.
    const before = candidates.filter(p => p.opened_ts <= source.closed_ts);
    const first = before.length ? Math.max(...before.map(p => p.opened_ts)) : Math.min(...candidates.map(p => p.opened_ts));
    candidates = candidates.filter(p => p.opened_ts === first);
    const samePool = candidates.filter(p => p.pool && p.pool === source.pool);
    if (samePool.length) candidates = samePool;
    if (candidates.length > 1) {
      issues.push('Unclaimed KAT remains with LP #' + source.id + ' because more than one replacement matches.');
      continue;
    }
    const target = candidates[0], e = effective.earned_tokens_by_id[source.id]?.[TOKEN], c = effective.claimed_tokens_by_id[source.id]?.[TOKEN];
    if (!amount(e) || !amount(c) || c > e + EPS) throw new Error('The closing LP reward balance is incomplete.');
    const ts = Math.max(source.closed_ts, target.opened_ts), anchor = book.reward_rollover_anchor;
    const knownClaims = new Set(anchor?.claims || []);
    const ambiguousClaims = (book.claims || []).some(claim => claim.token === TOKEN
      && claim.wallet?.toLowerCase() === owner(source) && claim.ts >= source.opened_ts && claim.ts <= ts
      && (!knownClaims.has(claimId(claim)) || claim.amount - (claim.assigned || 0) > EPS));
    if (ambiguousClaims && !persistRollovers) {
      issues.push('Unclaimed KAT from LP #' + source.id + ' is waiting for earlier claims to be confirmed.');
      continue;
    }
    const cutoff = ambiguousClaims ? c : (anchor?.claimed?.[source.key] || 0);
    if (cutoff > c + EPS) throw new Error('The rollover claim boundary exceeds the verified claimed balance.');
    const edge = { source: source.id, target: target.id, wallet: owner(source), token: TOKEN,
      claimedBefore: cutoff, initialCarry: Math.max(0, e - cutoff), ts };
    rules.push(edge);
    // The caller reapplies the complete graph before registering another edge.
    // That propagates newly found upstream balances through existing successors.
    break;
  }
  book.reward_rollovers = rulesOf({ ...book, reward_rollovers: rules });
  return issues;
}

/* Compare every sample on today's carry basis. This isolates actual accrued
   rewards from the one-off reassignment, including a replacement's first APR. */
export function attributedAprBaseline(position, sample, book) {
  const tokens = sample.pos[position.key];
  if (!katana(position)) return tokens;
  const current = book?.reward_rollover_basis?.[position.key]
    ?? rulesOf(book).filter(r => key(r.target) === position.key).reduce((sum, r) => sum + r.initialCarry, 0);
  if (!current) return tokens;
  let previous = 0;
  if (sample.reward_attribution_version === 1) previous = position.key === key(seed.target) ? seed.initialCarry : 0;
  else if (sample.reward_attribution_version === REWARD_ATTRIBUTION_VERSION) {
    if (!sample.reward_rollover_basis || !amount(sample.reward_rollover_basis[position.key] ?? 0)) return null;
    previous = sample.reward_rollover_basis[position.key] || 0;
  } else if (sample.reward_attribution_version !== undefined) return null;
  if (previous > current + EPS) return null;
  return { ...tokens, [TOKEN]: (tokens[TOKEN] || 0) + current - previous };
}
