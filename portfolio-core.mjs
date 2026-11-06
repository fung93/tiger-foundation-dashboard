/* Canonical, read-only portfolio observations. Browser-safe and network-free.
   Historical values are references, never silently promoted to a current NAV. */
export const PORTFOLIO_SCHEMA_VERSION = 'portfolio-v1';
export const CHAIN_IDS = Object.freeze({ katana: 747474, robinhood: 4663, arc: 5042, solana: 'solana-mainnet' });
const finite = n => Number.isFinite(n) ? n : null;
const amount = n => Number.isFinite(n) && n >= 0 ? n : null;
const integer = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const raw = n => typeof n === 'string' && /^\d{1,160}$/.test(n) ? n : null;
const text = (s, max = 180) => typeof s === 'string' ? s.slice(0, max) : null;
const lower = s => typeof s === 'string' ? s.toLowerCase() : null;
const time = s => {
  const n = typeof s === 'number' ? (s < 1e12 ? s * 1000 : s) : Date.parse(s);
  return Number.isFinite(n) && n > 0 && Number.isFinite(new Date(n).getTime()) ? new Date(n).toISOString() : null;
};
const clock = value => typeof value === 'function' ? value() : value;
const fresh = (ts, now) => !!ts && now - Date.parse(ts) >= -30000 && now - Date.parse(ts) <= 90000;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
async function identity(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(stable(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'portfolio:' + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function positionIdentity({ chain, protocolContract, positionId, owner }) {
  if (!Object.hasOwn(CHAIN_IDS, chain) || !protocolContract || !positionId || !owner) return null;
  if (chain !== 'solana' && (!/^0x[0-9a-f]{40}$/i.test(protocolContract) || !/^0x[0-9a-f]{40}$/i.test(owner))) return null;
  const normalize = value => chain === 'solana' ? String(value) : lower(String(value));
  return [CHAIN_IDS[chain], normalize(protocolContract), chain === 'solana' ? String(positionId)
    : String(positionId).replace(/^#/, '').toLowerCase(), normalize(owner)]
    .map(encodeURIComponent).join(':');
}
const sum = rows => rows.reduce((n, row) => n + row.valueUsd, 0);

/** Input observations must already be sourced by trusted adapters, never by a model.
 * `representationOf` describes an alternate underlying representation; it is exposure
 * only. `claimedRaw` removes rewards already moved into wallet balances. */
export async function canonicalPortfolioSnapshot({ observations = [], coverage = [], requiredSources = [], now = Date.now } = {}) {
  const at = clock(now);
  if (!Number.isFinite(at) || observations.length > 250 || coverage.length > 50) throw Error('Invalid bounded portfolio observations');
  const reasons = [], missing = [], seen = new Map(), exposures = [], restrictions = [];
  for (const source of coverage) {
    if (!source || typeof source.id !== 'string') continue;
    const valid = source.complete === true && source.basis === 'live' && fresh(time(source.ts), at);
    if (!valid) missing.push({ sourceId: source.id, reason: source.complete !== true ? 'source_incomplete'
      : source.basis !== 'live' ? 'saved_source_not_live' : 'source_stale' });
  }
  for (const name of requiredSources) if (!coverage.some(s => s?.id === name)) missing.push({ sourceId: name, reason: 'source_unavailable' });
  for (const source of observations) {
    if (!source || typeof source !== 'object') continue;
    const ts = time(source.observedAt), status = source.basis === 'live' && source.complete === true && fresh(ts, at) ? 'fresh'
      : source.complete === false ? 'unavailable' : 'stale';
    const entry = { id: text(source.id, 400), chain: text(source.chain, 25), chainId: CHAIN_IDS[source.chain] ?? null,
      owner: text(source.owner), scope: ['main', 'vault', 'combined'].includes(source.scope) ? source.scope : 'combined',
      kind: text(source.kind, 30), protocol: text(source.protocol), protocolContract: text(source.protocolContract),
      positionId: text(String(source.positionId ?? ''), 180), symbol: text(source.symbol, 40), tokenAddress: text(source.tokenAddress),
      rawAmount: raw(source.rawAmount), decimals: integer(source.decimals), amount: amount(source.amount),
      valueUsd: amount(source.valueUsd), priceUsd: amount(source.priceUsd), observedAt: ts,
      block: integer(source.block), ledgerBlock: integer(source.ledgerBlock), basis: source.basis === 'live' ? 'live' : 'saved',
      sourceId: text(source.sourceId), priceSource: text(source.priceSource), status,
      representationOf: text(source.representationOf, 400), restriction: text(source.restriction, 240),
      metadata: source.metadata && typeof source.metadata === 'object' ? source.metadata : null };
    if (!entry.id || !entry.chain || !entry.sourceId) { reasons.push('position_identity_unavailable'); continue; }
    if (entry.kind === 'reward' && raw(source.earnedRaw) !== null && raw(source.claimedRaw) !== null) {
      const remaining = BigInt(source.earnedRaw) - BigInt(source.claimedRaw);
      if (remaining < 0n) { entry.status = 'unavailable'; reasons.push('reward_claims_exceed_earnings'); }
      else if (entry.decimals !== null && entry.decimals <= 36 && entry.priceUsd !== null) {
        entry.rawAmount = remaining.toString(); entry.amount = Number(remaining) / 10 ** entry.decimals;
        entry.valueUsd = entry.amount * entry.priceUsd;
      }
    }
    if (entry.representationOf || entry.kind === 'exposure') { exposures.push(entry); continue; }
    if (entry.restriction) restrictions.push({ assetId: entry.id, restriction: entry.restriction });
    if (seen.has(entry.id)) {
      const prior = seen.get(entry.id);
      // The same NFT discovered through a wallet and staker is one economic asset.
      if (prior.observedAt === entry.observedAt && prior.valueUsd !== entry.valueUsd) {
        reasons.push('conflicting_position_valuation'); prior.status = 'unavailable'; continue;
      }
      if ((prior.status === 'fresh' && entry.status !== 'fresh')
        || (prior.status === entry.status && Date.parse(prior.observedAt) >= Date.parse(entry.observedAt))) continue;
    }
    seen.set(entry.id, entry);
  }
  const entries = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (exposures.some(row => row.representationOf && !seen.has(row.representationOf))) reasons.push('represented_asset_unavailable');
  const assets = entries.filter(row => row.kind !== 'debt'), liabilities = entries.filter(row => row.kind === 'debt');
  const verified = rows => rows.filter(row => row.status === 'fresh' && row.valueUsd !== null);
  const unpriced = entries.filter(row => row.valueUsd === null).map(row => ({ assetId: row.id, rawAmount: row.rawAmount,
    decimals: row.decimals, symbol: row.symbol, reason: 'valuation_unavailable' }));
  if (unpriced.length) reasons.push('unpriced_assets');
  if (entries.some(row => row.status === 'fresh' && row.rawAmount === null)) reasons.push('raw_amounts_unavailable');
  if (entries.some(row => row.status === 'fresh' && row.block === null)) reasons.push('valuation_block_unavailable');
  if (missing.length) reasons.push('missing_coverage');
  if (entries.some(row => row.status !== 'fresh')) reasons.push('retained_or_unavailable_observations');
  const dedupedReasons = [...new Set(reasons)];
  const complete = coverage.length > 0 && !dedupedReasons.length;
  const status = reasons.includes('conflicting_position_valuation') ? 'unreconciled'
    : complete ? 'complete' : verified(entries).length ? 'partial' : entries.length ? 'stale' : 'partial';
  const scopeTotal = scope => sum(verified(assets).filter(row => scope === 'combined' || row.scope === scope))
    - sum(verified(liabilities).filter(row => scope === 'combined' || row.scope === scope));
  const result = { schemaVersion: PORTFOLIO_SCHEMA_VERSION, valuationBasis: 'USD at each source observation; no synchronized cross-chain block',
    status, reasons: dedupedReasons, assets, liabilities, exposures, unpriced, liquidityRestrictions: restrictions,
    coverage: coverage.map(row => ({ id: row.id, ts: time(row.ts), block: integer(row.block),
      ledgerBlock: integer(row.ledgerBlock), basis: row.basis, complete: row.complete === true })), missingCoverage: missing,
    chainObservations: Object.fromEntries(Object.keys(CHAIN_IDS).map(chain => [chain, entries.filter(row => row.chain === chain)
      .map(row => ({ sourceId: row.sourceId, observedAt: row.observedAt, block: row.block, ledgerBlock: row.ledgerBlock, status: row.status }))])),
    verifiedSubtotalUsd: scopeTotal('combined'), scopes: { main: { verifiedSubtotalUsd: scopeTotal('main') },
      vault: { verifiedSubtotalUsd: scopeTotal('vault') }, combined: { verifiedSubtotalUsd: scopeTotal('combined') } },
    navUsd: complete ? scopeTotal('combined') : null, allocationBlocked: !complete,
    inclusionBasis: 'Main portfolio and Tiger Vault are separate scopes. Combined includes each asset once. LP look-through and receipt underlyings are exposures, not additional assets.' };
  return { ...result, snapshotId: await identity(result), requestedAt: new Date(at).toISOString() };
}

/** Pure additive compact view for api/lpbook, using reads already completed there. */
export function compactLPPositions(book, rows, { contracts = {}, generated = null } = {}) {
  return Object.values(book?.positions || {}).filter(p => p?.status === 'open').slice(0, 60).map(p => {
    const row = rows?.[p.key], r = row?.raw, ts = time(generated);
    return { schemaVersion: 'lp-position-v1', id: String(p.id), chain: p.chain, chainId: CHAIN_IDS[p.chain] ?? null,
      owner: lower(p.wallet), protocol: row?.protocol || null, contract: p.kind === 'fables' ? contracts.fables : contracts[p.chain] || null,
      pool: p.pool || r?.pool || null, positionId: p.kind === 'fables' ? p.range_id || p.id : p.id,
      status: row && row.liquidity_usd !== null ? 'observed' : 'unavailable', observedAt: ts,
      // last_block is an event-ledger cursor, never falsely labeled the valuation block.
      block: null, ledgerBlock: integer(book.last_block?.[p.chain]), valuationBlockStatus: 'not_supplied_by_source',
      principalUsd: amount(row?.liquidity_usd), feesMine: typeof row?.fees_mine === 'boolean' ? row.fees_mine : null,
      staked: typeof row?.staked === 'boolean' ? row.staked : null, inRange: typeof row?.in_range === 'boolean' ? row.in_range : null,
      range: row?.range || null, amounts: row?.amounts || null,
      raw: r ? { liquidity: raw(r.liq), sqrtPriceX96: raw(r.sqrt), lowerTick: finite(r.lo), upperTick: finite(r.hi),
        token0: { address: r.t0?.a || r.token0 || null, symbol: r.t0?.s || null, decimals: integer(r.t0?.d) },
        token1: { address: r.t1?.a || r.token1 || null, symbol: r.t1?.s || null, decimals: integer(r.t1?.d) } } : null,
      accounting: { principalExcludesFeesAndRewards: true, carriedRewardsExcludedFromApr: true,
        stakedTradingFeesToDao: p.chain === 'katana' && row?.fees_mine === false } };
  });
}

/** Adapt actual dashboard producers. Saved wallets/locks deliberately remain stale. */
export async function buildPortfolioSnapshot({ saved, lending, lp, now = Date.now, mainOwner = null, expectedMarketIds = [] } = {}) {
  const at = clock(now), savedTs = time(saved?.last_updated), vaultOwner = lower(saved?.vault?.address);
  const observations = [], coverage = [], requiredSources = ['wallets', 'other_defi', 'lending', 'lp', 'unclaimed_rewards'];
  const add = row => observations.push(row);
  const savedBase = { complete: true, basis: 'saved', observedAt: savedTs, sourceId: 'data.json', priceSource: 'data.json recorded price' };
  coverage.push({ id: 'wallets', ts: savedTs, basis: 'saved', complete: !!saved?.chains },
    { id: 'other_defi', ts: savedTs, basis: 'saved', complete: !!saved?.defi_positions });
  for (const [chain, data] of Object.entries(saved?.chains || {}).slice(0, 8)) {
    if (!Object.hasOwn(CHAIN_IDS, chain)) continue;
    const owner = chain === 'solana' ? data.wallet_address : mainOwner;
    const tokens = data.wallet?.balances?.tokens || data.balances || {};
    for (const [symbol, token] of Object.entries(tokens).slice(0, 40)) if (token && typeof token === 'object') {
      add({ ...savedBase, id: [chain, owner || 'unknown-owner', 'wallet', token.address || symbol].join(':'), chain, owner,
        scope: 'main', kind: 'wallet', symbol, tokenAddress: token.address, amount: token.balance,
        rawAmount: token.raw, decimals: token.decimals, valueUsd: token.valueUSD, priceUsd: token.priceUSD });
    }
    for (const p of Array.isArray(data.defi_positions) ? data.defi_positions.slice(0, 30) : []) {
      if (!p || typeof p !== 'object') continue;
      // Lending is represented by the dedicated producer, never by a net row and
      // separate gross collateral/debt at the same time.
      if (p.type === 'Lending') continue;
      add({ ...savedBase, id: [chain, p.wallet || owner || 'unknown-owner', p.protocol, p.market].join(':'), chain,
        owner: p.wallet || owner, scope: 'main', kind: p.locked ? 'locked' : 'other_defi', protocol: p.protocol,
        positionId: p.market, symbol: p.locked?.token, amount: p.locked?.amount, valueUsd: p.value_usd,
        restriction: p.locked ? 'Locked protocol position; withdrawal timing/fees require verification.' : null });
    }
  }
  const vaultTs = time(saved?.vault?.at);
  if (saved?.vault) {
    coverage.push({ id: 'vault_wallets_and_locks', ts: vaultTs, basis: 'saved', complete: saved.vault.complete === true });
    for (const [i, row] of (Array.isArray(saved.vault.balances) ? saved.vault.balances.slice(0, 40) : []).entries()) if (row && typeof row === 'object') add({ ...savedBase, observedAt: vaultTs,
      id: [row.chain, vaultOwner || 'unknown-owner', 'wallet', row.sym].join(':'), chain: row.chain, owner: vaultOwner,
      scope: 'vault', kind: 'wallet', symbol: row.sym, amount: row.amount, valueUsd: row.usd, positionId: String(i) });
    for (const [i, row] of (Array.isArray(saved.vault.locks) ? saved.vault.locks.slice(0, 30) : []).entries()) if (row && typeof row === 'object') add({ ...savedBase, observedAt: vaultTs,
      id: [row.chain, vaultOwner || 'unknown-owner', 'lock', row.id || i].join(':'), chain: row.chain, owner: vaultOwner,
      scope: 'vault', kind: 'locked', symbol: row.symbol, amount: row.amount, valueUsd: row.value_usd,
      restriction: 'Locked capital; withdrawal conditions require verification.' });
  } else requiredSources.push('vault_wallets_and_locks');
  const lendingTs = time(lending?.ts), marketList = Array.isArray(lending?.markets) ? lending.markets : [];
  const lendingComplete = lending?.full === true && expectedMarketIds.every(id => marketList.some(row => row?.id === id))
    && marketList.every(row => row && !row.error && !row.valuation_error
    && amount(row.collateral_usd) !== null && amount(row.debt_usd) !== null);
  coverage.push({ id: 'lending', ts: lendingTs, block: integer(lending?.block), basis: 'live', complete: lendingComplete });
  for (const row of marketList.slice(0, 6)) {
    if (!row?.id || row.error || row.valuation_error) continue;
    if (row.no_position === true && row.collateral_amount === 0 && row.debt_amount === 0) continue;
    const base = { chain: 'katana', owner: lending.wallet || mainOwner, scope: 'main', protocol: 'Morpho Blue',
      protocolContract: '0xd50f2dfffd62f94ee4aed9ca05c61d0753268abc', positionId: row.id,
      observedAt: lendingTs, block: integer(lending.block), basis: 'live', complete: amount(row.collateral_usd) !== null && amount(row.debt_usd) !== null,
      sourceId: '/api/morpho', priceSource: 'Pinned market pool quote; oracle basis retained separately' };
    const id = positionIdentity({ ...base, chain: 'katana' });
    if (!id) { coverage.push({ id: 'lending_identity:' + row.id, basis: 'live', complete: false, ts: lendingTs }); continue; }
    for (const [kind, symbol, valueUsd, units, rawAmount, decimals] of [
      ['collateral', row.collateral_token, row.collateral_usd, row.collateral_amount, row.raw?.collateral, row.collateral_decimals],
      ['debt', row.loan_token, row.debt_usd, row.debt_amount, row.raw?.debt, row.loan_decimals],
    ]) add({ ...base, id: id + ':' + kind, kind, symbol, amount: units, rawAmount, decimals, valueUsd,
      priceUsd: kind === 'collateral' ? row.collateral_price_usd : row.loan_usd,
      restriction: kind === 'collateral' ? 'Pledged collateral; releasing it changes loan health.' : null,
      metadata: { oracleCollateralUsd: row.oracle_collateral_usd ?? null, interestAccrued: row.interest_accrued === true } });
  }
  const lpTs = time(lp?.generated), health = lp?.health;
  const lpComplete = !!health && !lp.error && amount(lp?.cards?.value_usd) !== null && amount(lp?.cards?.unclaimed_usd) !== null
    && integer(lp?.cards?.open) !== null && !Object.keys(health.errors || {}).length && !(health.unread || []).length
    && !(health.unpriced || []).length && Object.values(health.behind || {}).every(n => n === 0);
  const detailed = Array.isArray(lp?.position_data) && lp.position_data.length <= 60 && lp.position_data.length === lp?.cards?.open;
  const identitiesComplete = detailed && lp.position_data.every(row => row && positionIdentity({ chain: row.chain,
    protocolContract: row.contract, positionId: row.positionId || row.id, owner: row.owner }));
  coverage.push({ id: 'lp', ts: lpTs, basis: 'live', complete: lpComplete && identitiesComplete });
  if (detailed) for (const row of lp.position_data) {
    if (!row || typeof row !== 'object') continue;
    const id = positionIdentity({ chain: row.chain, protocolContract: row.contract, positionId: row.positionId || row.id, owner: row.owner });
    if (!id) continue;
    add({ id, chain: row.chain, owner: row.owner, scope: lower(row.owner) === vaultOwner ? 'vault' : lower(row.owner) === lower(mainOwner) ? 'main' : 'combined',
      kind: 'lp', protocol: row.protocol, protocolContract: row.contract, positionId: row.positionId || row.id,
      valueUsd: row.principalUsd, rawAmount: row.raw?.liquidity, decimals: 0, observedAt: lpTs, block: row.block,
      ledgerBlock: row.ledgerBlock, basis: 'live', complete: lpComplete && row.status === 'observed', sourceId: '/api/lpbook',
      priceSource: 'LP Book live pool valuation; principal excludes fees/rewards', metadata: row });
  }
  // A legacy response can support a clearly scoped LP subtotal, but not ownership,
  // exposure or allocation. Its formatted live rows are never parsed as numbers.
  else if (amount(lp?.cards?.value_usd) !== null) add({ id: 'combined:lp:aggregate', chain: 'multiple', scope: 'combined',
    kind: 'lp', valueUsd: lp.cards.value_usd, observedAt: lpTs, basis: 'live', complete: lpComplete,
    sourceId: '/api/lpbook', priceSource: 'LP Book aggregate; individual metadata unavailable' });
  coverage.push({ id: 'unclaimed_rewards', ts: lpTs, basis: 'live', complete: false });
  if (amount(lp?.cards?.unclaimed_usd) !== null) add({ id: 'combined:open-lp:unclaimed', chain: 'multiple', scope: 'combined',
    kind: 'reward', valueUsd: lp.cards.unclaimed_usd, observedAt: lpTs, basis: 'live', complete: lpComplete,
    sourceId: '/api/lpbook', priceSource: 'Open-position unclaimed fees/rewards only; not cumulative claimed earnings' });
  const result = await canonicalPortfolioSnapshot({ observations, coverage, requiredSources, now: at });
  const principal = sum(result.assets.filter(row => row.kind === 'lp' && row.status === 'fresh' && row.valueUsd !== null));
  const lpComparable = lpComplete && detailed && fresh(lpTs, at);
  const matched = lpComparable && Math.abs(principal - lp.cards.value_usd) <= Math.max(.02, lp.cards.open * .01);
  const final = { ...result, reconciliation: { lp: { status: !lpComparable ? 'unavailable' : matched ? 'matched' : 'mismatch',
    principalUsd: principal, bookPrincipalUsd: amount(lp?.cards?.value_usd), observedAt: lpTs } },
    savedReference: { ts: savedTs, mainUsd: finite(saved?.summary?.grand_total_usd),
    vaultUsd: finite(saved?.vault?.total_usd), basis: 'Recorded main and vault amounts; neither is a current complete NAV.' },
    accountingLimitations: ['Closed-position claimable rewards and non-LP rewards require a fresh dedicated reading.',
      'Saved wallets and other DeFi positions are historical, so portfolio-wide allocation remains blocked.',
      'LP event-ledger cursors are distinct from valuation blocks; missing valuation blocks remain explicit.'] };
  if (lpComparable && !matched) { final.status = 'unreconciled'; final.reasons = [...final.reasons, 'lp_total_mismatch'];
    final.navUsd = null; final.allocationBlocked = true; }
  const { snapshotId, requestedAt, ...fingerprint } = final;
  return { ...final, snapshotId: await identity(fingerprint), requestedAt };
}

export function comparablePortfolioPerformance({ before, after, flows, coverageComparable = false } = {}) {
  const a = finite(before?.valueUsd), b = finite(after?.valueUsd);
  const wealthChangeUsd = a === null || b === null ? null : b - a;
  const base = { wealthChangeUsd, pnlUsd: null, returnPct: null, timeWeightedReturn: null,
    basis: 'Wealth change includes cash flows and coverage changes; it is not automatically profit.' };
  if (wealthChangeUsd === null) return { ...base, status: 'unavailable', reason: 'valuation_unavailable' };
  if (!coverageComparable) return { ...base, status: 'unavailable', reason: 'coverage_not_comparable' };
  if (!Array.isArray(flows) || flows.some(row => !['deposit', 'withdrawal', 'internal_transfer', 'lp_open', 'migration', 'staking', 'lending'].includes(row?.kind)
    || !Number.isFinite(row.usd) || row.usd < 0)) return { ...base, status: 'unavailable', reason: 'cash_flows_unverified' };
  const externalNet = flows.reduce((n, row) => n + (row.kind === 'deposit' ? row.usd : row.kind === 'withdrawal' ? -row.usd : 0), 0);
  return { ...base, status: 'available', reason: null, externalNetUsd: externalNet, pnlUsd: wealthChangeUsd - externalNet,
    basis: 'Cash-flow-adjusted dollar change on comparable coverage. No time-weighted return without intraperiod valuations.' };
}
