/* Per-position APR observations can survive an unrelated chain's failure. These
   never contain aggregate fee or PnL totals, which require a complete reading. */
const amounts = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every(a => Number.isFinite(a) && a >= 0);
const lower = value => String(value).toLowerCase();

function positionBlocked(P, errors) {
  return Object.keys(errors).some(key => {
    const name = lower(key), chain = lower(P.chain);
    return name === 'wallets' || name === chain || name.startsWith(chain + ' ')
      || (P.kind === 'fables' && name.startsWith('fables'))
      || (P.chain === 'katana' && name === 'merkl');
  });
}

export function positionAprObservation(book, { rows, fees, merkl, errors = {}, behind = {}, ts }) {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const pos = {}, pp = {};
  for (const P of Object.values(book.positions || {})) {
    const row = rows?.[P.key];
    if (P.status !== 'open' || behind[P.chain] !== 0 || positionBlocked(P, errors)
      || !row || row.error || row.incomplete || row.stale
      || !Number.isFinite(row.liquidity_usd) || row.liquidity_usd < 0
      || (row.wallet && P.wallet && lower(row.wallet) !== lower(P.wallet))
      || !Number.isFinite(P.cost_usd) || !Number.isFinite(P.out_usd)
      || !amounts(fees?.[P.key])) continue;

    if (P.chain === 'katana') {
      const fresh = merkl?.earned_tokens_by_id;
      if (!merkl || merkl.error || !fresh || !Object.hasOwn(fresh, P.id)
        || !amounts(fresh[P.id]) || !amounts(P.merkl || {}) || !amounts(P.start_merkl || {})
        || (merkl.reward_rollover_basis && !amounts(merkl.reward_rollover_basis))) continue;
      // The saved cumulative amounts must come from this complete reward read.
      const keys = new Set([...Object.keys(fresh[P.id]), ...Object.keys(P.merkl || {}), ...Object.keys(P.start_merkl || {})]);
      if ([...keys].some(k => (fresh[P.id][k] || 0) !== (P.merkl?.[k] || 0)
        || (fresh[P.id][k] || 0) < (P.start_merkl?.[k] || 0))) continue;
    } else {
      if (!amounts(P.fees) || !amounts(P.start_uncollected || {})
        || !row.raw || !Number.isFinite(row.raw.fee0) || row.raw.fee0 < 0
        || !Number.isFinite(row.raw.fee1) || row.raw.fee1 < 0) continue;
      const current = { ...P.fees };
      current[P.t0] = (current[P.t0] || 0) + row.raw.fee0;
      current[P.t1] = (current[P.t1] || 0) + row.raw.fee1;
      if (Object.entries(P.start_uncollected || {}).some(([k, a]) => (current[k] || 0) < a)) continue;
    }

    const pnl = row.liquidity_usd + P.out_usd - P.cost_usd;
    if (!Number.isFinite(pnl)) continue;
    pos[P.key] = Object.fromEntries(Object.entries(fees[P.key]).map(([k, a]) => [k, Number(a.toFixed(8))]));
    pp[P.key] = Number(pnl.toFixed(2));
  }
  if (!Object.keys(pos).length) return null;
  return { ts, pos, pp,
    ...(merkl?.reward_attribution_version ? { reward_attribution_version: merkl.reward_attribution_version } : {}),
    ...(merkl?.reward_rollover_basis ? { reward_rollover_basis: { ...merkl.reward_rollover_basis } } : {}) };
}
