/* Alex, 29 Oct 2026: attribute the unclaimed KAT from closed LP #492291 to
   current LP #492626. Earlier claims remain with #492291. This is accounting
   only: the wallet's rewards and the distributor's claim amounts never change. */
export const REWARD_ATTRIBUTION_VERSION = 1;
const rule = {
  wallet: '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1',
  source: '492291', target: '492626', token: 'KAT@katana',
  claimedBefore: 1338.1368961866224,
  initialCarry: 2651.4569888919086,
};
const amount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const cents = (n) => Math.round(n * 100) / 100;

export function attributeMerklRewards(merkl) {
  if (!merkl || merkl.error) throw new Error('A complete reward reading is required for the KAT attribution.');
  if (merkl.reward_attribution_version === REWARD_ATTRIBUTION_VERSION) return merkl;
  if (merkl.reward_attribution_version !== undefined)
    throw new Error('The reward attribution version is unsupported.');
  const earned = merkl.earned_tokens_by_id, claimed = merkl.claimed_tokens_by_id;
  for (const id of [rule.source, rule.target]) {
    const owner = merkl.wallet_by_id?.[id];
    const e = earned?.[id]?.[rule.token], c = claimed?.[id]?.[rule.token];
    if (typeof owner !== 'string' || owner.toLowerCase() !== rule.wallet
      || !amount(e) || !amount(c) || c > e + 1e-9)
      throw new Error('The KAT attribution needs verified rewards for both positions in the same wallet.');
  }
  const sourceEarned = earned[rule.source][rule.token], sourceClaimed = claimed[rule.source][rule.token];
  if (sourceEarned < rule.claimedBefore - 1e-9 || sourceClaimed < rule.claimedBefore - 1e-9)
    throw new Error('The closed position reward reading fell below its recorded claims.');
  const movedEarned = Math.max(0, sourceEarned - rule.claimedBefore);
  const movedClaimed = Math.max(0, sourceClaimed - rule.claimedBefore);
  const move = (map, moved) => ({ ...map,
    [rule.source]: { ...map[rule.source], [rule.token]: Math.min(map[rule.source][rule.token], rule.claimedBefore) },
    [rule.target]: { ...map[rule.target], [rule.token]: map[rule.target][rule.token] + moved },
  });
  const result = { ...merkl,
    earned_tokens_by_id: move(earned, movedEarned),
    claimed_tokens_by_id: move(claimed, movedClaimed),
    earned_by_id: { ...merkl.earned_by_id },
    reward_attribution_version: REWARD_ATTRIBUTION_VERSION,
  };
  for (const id of [rule.source, rule.target]) {
    result.earned_by_id[id] = cents(Object.entries(result.earned_tokens_by_id[id])
      .reduce((sum, [token, n]) => sum + n * (merkl.token_price?.[token] || 0), 0));
  }
  return result;
}

/* An older scheduled job may finish during rollout. Do not credit its already
   assigned source claims to the destination a second time. */
export function rewardAttributionLedgerIssue(book, merkl) {
  if (merkl?.reward_attribution_version !== REWARD_ATTRIBUTION_VERSION) return null;
  const source = book.positions?.['katana:' + rule.source];
  if (!source) return null;
  const seen = source.claimed_seen?.[rule.token] ?? 0;
  const credited = (source.claims || []).reduce((sum, claim) => sum + (claim.tokens?.[rule.token] ?? 0), 0);
  return !amount(seen) || !amount(credited) || Math.max(seen, credited) > rule.claimedBefore + 1e-8
    ? 'Saved claims overlap the KAT reassignment. Retaining the previous reward allocation until the ledger is reconciled.'
    : null;
}

/* Legacy samples contain only #492626's native earnings. Compare them on the
   same attribution basis as new samples without rewriting stored observations
   or treating the assignment itself as new income in a recent APR interval. */
export function attributedAprBaseline(position, sample) {
  const tokens = sample.pos[position.key];
  if (position.key !== 'katana:' + rule.target || position.wallet?.toLowerCase() !== rule.wallet
    || sample.reward_attribution_version === REWARD_ATTRIBUTION_VERSION) return tokens;
  if (sample.reward_attribution_version !== undefined) return null;
  return { ...tokens, [rule.token]: (tokens[rule.token] || 0) + rule.initialCarry };
}
