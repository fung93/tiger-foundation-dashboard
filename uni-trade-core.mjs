/* Pure UNI swap accounting. No providers, wallet access or ledger writes.
   The trade balance is buys minus sells; wallet/LP balances remain separate. */
export const UNI_TRADE_VERSION = 1;
export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const SWAPS = new Set(['0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f']);
const LP_EVENTS = new Set(['0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f',
  '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4',
  '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01',
  '0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683']);
const address = value => /^0x[0-9a-f]{40}$/i.test(value || '') ? value.toLowerCase() : null;
const hash = value => /^0x[0-9a-f]{64}$/i.test(value || '');
const amount = value => Number.isFinite(value) && value >= 0;
const units = raw => Number(BigInt(raw)) / 1e18;
const ordered = (a, b) => a.ts - b.ts || a.block - b.block || a.index - b.index || a.id.localeCompare(b.id);
export function uniTransfers(receipt) {
  return (receipt.logs || []).filter(l => l.topics?.[0] === TRANSFER && l.topics.length === 3).map(l => {
    if (!address(l.address) || !/^0x[0-9a-f]{64}$/i.test(l.data || '') || !l.topics.slice(1).every(hash)) throw Error('Malformed token transfer');
    return { token: l.address.toLowerCase(), from: '0x' + l.topics[1].slice(-40).toLowerCase(),
      to: '0x' + l.topics[2].slice(-40).toLowerCase(), raw: BigInt(l.data) };
  });
}
export function receiptUniTrade({ chain, wallets, receipt, transaction, ts, verifiedPools = [] }) {
  if (receipt.status !== '0x1' || !hash(receipt.transactionHash) || receipt.transactionHash !== transaction.hash
    || !Number.isSafeInteger(ts) || ts <= 0) throw Error('The UNI transaction could not be verified');
  const owned = new Set(wallets.map(w => w.toLowerCase())), transfers = uniTransfers(receipt), token = chain.uni.address;
  if (!owned.has(transaction.from?.toLowerCase())) return { trade: null, reason: 'not_wallet_initiated' };
  const net = address => transfers.filter(t => t.token === address).reduce((sum, t) => sum
    + (owned.has(t.to) ? t.raw : 0n) - (owned.has(t.from) ? t.raw : 0n), 0n);
  const raw = net(token);
  if (raw === 0n) return { trade: null, reason: 'internal_or_no_uni_change' };
  if ((receipt.logs || []).some(l => LP_EVENTS.has(l.topics?.[0]))) return { trade: null, reason: 'liquidity_or_claim' };
  const swaps = receipt.logs.filter(l => SWAPS.has(l.topics?.[0]) && transfers.some(t => t.token === token
    && (t.from === l.address.toLowerCase() || t.to === l.address.toLowerCase())));
  if (!swaps.length) return { trade: null, reason: 'transfer_only' };
  const side = raw > 0n ? 'buy' : 'sell', parts = [];
  for (const stable of chain.stables) {
    const delta = net(stable.address);
    if (delta !== 0n) parts.push({ symbol: stable.symbol, address: stable.address, raw: delta.toString(), decimals: stable.decimals });
  }
  const opposite = parts.length > 0 && parts.every(p => side === 'buy' ? BigInt(p.raw) < 0n : BigInt(p.raw) > 0n);
  const verified = swaps.some(l => verifiedPools.includes(l.address.toLowerCase()));
  const usd = verified && opposite ? parts.reduce((sum, p) => sum + Number(BigInt(p.raw) < 0n ? -BigInt(p.raw) : BigInt(p.raw)) / 10 ** p.decimals, 0) : null;
  const gasRaw = receipt.gasUsed && receipt.effectiveGasPrice ? BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) + BigInt(receipt.l1Fee || '0') : null;
  const owner = owned.has(transaction.from?.toLowerCase()) ? transaction.from.toLowerCase()
    : transfers.find(t => t.token === token && (owned.has(t.from) || owned.has(t.to)))?.[side === 'buy' ? 'to' : 'from'];
  return { reason: null, trade: { id: chain.key + ':' + receipt.transactionHash, chain: chain.key, chainId: chain.id,
    hash: receipt.transactionHash, owner, side, raw: (raw < 0n ? -raw : raw).toString(), uni: units(raw < 0n ? -raw : raw),
    usd, price: usd === null ? null : usd / units(raw < 0n ? -raw : raw), quote: parts, verified,
    block: Number(BigInt(receipt.blockNumber)), blockHash: receipt.blockHash, index: Number(BigInt(receipt.transactionIndex || '0')),
    ts, gasRaw: gasRaw?.toString() ?? null, gasToken: chain.key === 'bnb' ? 'BNB' : 'ETH', gas: gasRaw === null ? null : Number(gasRaw) / 1e18,
    note: !verified ? 'Swap verification pending' : !opposite ? 'Dollar cost unavailable' : null } };
}
export function replayUniTrades(trades, prices = {}) {
  const books = {}, rows = [];
  for (const trade of [...trades].sort(ordered)) {
    const b = books[trade.chain] ||= { qty: 0, cost: 0, realized: 0, realizedComplete: true };
    const priced = trade.verified && amount(trade.usd), q = trade.uni;
    let basis = null, realized = null, outside = 0;
    if (trade.side === 'buy') { b.qty += q; b.cost = b.cost !== null && priced ? b.cost + trade.usd : null; basis = priced ? trade.usd : null; }
    else {
      const inside = Math.min(q, b.qty), avg = b.qty > 0 && b.cost !== null ? b.cost / b.qty : null;
      outside = Math.max(0, q - inside);
      basis = avg === null ? null : inside * avg;
      if (priced && basis !== null && inside > 0) { realized = trade.usd * inside / q - basis; b.realized += realized; }
      else if (inside > 0) b.realizedComplete = false;
      if (outside > 1e-10) b.realizedComplete = false;
      b.qty = Math.max(0, b.qty - inside); if (b.cost !== null && basis !== null) b.cost = Math.max(0, b.cost - basis);
      if (b.qty < 1e-10) { b.qty = 0; b.cost = 0; }
    }
    rows.push({ ...trade, basis, realized, outside, balance: b.qty, avg: b.qty > 0 && b.cost !== null ? b.cost / b.qty : null });
  }
  let qty = 0, cost = 0, value = 0, realized = 0, basisComplete = true, priceComplete = true, realizedComplete = true;
  for (const [chain, b] of Object.entries(books)) {
    const px = prices[chain]?.priceUsd;
    b.value = b.qty === 0 ? 0 : px > 0 ? b.qty * px : null;
    b.unrealized = b.value !== null && b.cost !== null ? b.value - b.cost : null;
    qty += b.qty; if (b.cost === null) basisComplete = false; else cost += b.cost;
    if (b.value === null) priceComplete = false; else value += b.value;
    realized += b.realized; realizedComplete &&= b.realizedComplete;
  }
  return { qty, cost: basisComplete ? cost : null, avg: qty > 0 && basisComplete ? cost / qty : null,
    value: priceComplete ? value : null, unrealized: basisComplete && priceComplete ? value - cost : null,
    realized: realizedComplete ? realized : null, books, rows: rows.sort(ordered).reverse(),
    bought: trades.filter(t => t.side === 'buy').length, sold: trades.filter(t => t.side === 'sell').length,
    basis: 'Swap-only average-cost trade balance. Wallet and LP inventory are separate. Network fees excluded.' };
}
export function validateUniTradeBook(file, chains, wallets) {
  if (!file || file.version !== UNI_TRADE_VERSION || !Array.isArray(file.trades) || !file.chains || !Array.isArray(file.wallets)
    || file.wallets.length !== wallets.length || file.wallets.some((w, i) => w !== wallets[i]) || file.trades.length > 10000) throw Error('Invalid UNI trade ledger');
  const ids = new Set();
  for (const t of file.trades) {
    if (!chains[t.chain] || t.chainId !== chains[t.chain].id || !hash(t.hash) || t.id !== t.chain + ':' + t.hash || ids.has(t.id)
      || !wallets.includes(t.owner) || !['buy', 'sell'].includes(t.side) || !(t.uni > 0) || !Number.isFinite(t.uni)
      || !/^\d{1,78}$/.test(t.raw) || Math.abs(units(t.raw) - t.uni) > 1e-9 || !(t.ts > 0) || !Number.isSafeInteger(t.block)
      || t.block < 0 || !Number.isSafeInteger(t.ts) || !Number.isSafeInteger(t.index) || t.index < 0
      || !hash(t.blockHash) || typeof t.verified !== 'boolean' || !(t.usd === null || amount(t.usd)) || (!t.verified && t.usd !== null)
      || !(t.price === null && t.usd === null || t.usd !== null && amount(t.price) && Math.abs(t.price * t.uni - t.usd) <= Math.max(1e-8, t.usd * 1e-10))) throw Error('Invalid UNI trade record');
    if (t.gasRaw !== null && !/^\d{1,78}$/.test(t.gasRaw) || !(t.gas === null || amount(t.gas)) || typeof t.note !== 'string' && t.note !== null) throw Error('Invalid UNI trade metadata');
    const coverage = file.chains[t.chain];
    if (!coverage || t.block < coverage.startBlock || t.block > coverage.cursor) throw Error('UNI fill outside saved history coverage');
    ids.add(t.id);
  }
  for (const [key, state] of Object.entries(file.chains)) {
    if (!chains[key] || state.chainId !== chains[key].id || state.uni !== chains[key].uni.address || !Number.isSafeInteger(state.cursor)
      || state.cursor < 0 || !Number.isSafeInteger(state.startBlock) || state.startBlock < 0 || !Number.isSafeInteger(state.head) || state.head < state.cursor
      || !Number.isSafeInteger(state.ts) || state.ts <= 0 || state.cursor < state.startBlock - 1
      || state.nonces && (Object.keys(state.nonces).length !== wallets.length || wallets.some(owner => !Number.isSafeInteger(state.nonces[owner]) || state.nonces[owner] < 0))
      || !(state.cursorHash === null || hash(state.cursorHash)) || (state.cursor >= state.startBlock && !state.cursorHash)) throw Error('Invalid UNI history cursor');
  }
  for (const [key, quote] of Object.entries(file.quotes || {})) {
    if (!chains[key] || !(quote.priceUsd > 0) || !Number.isFinite(quote.priceUsd) || !address(quote.pool)
      || !Number.isSafeInteger(quote.block) || quote.block < 0 || !Number.isSafeInteger(quote.ts) || quote.ts <= 0) throw Error('Invalid saved UNI quote');
  }
  for (const balance of file.walletReadings || []) {
    if (!chains[balance.chain] || !wallets.includes(balance.owner) || !/^\d{1,78}$/.test(balance.raw) || !amount(balance.uni)
      || Math.abs(units(balance.raw) - balance.uni) > 1e-9 || !amount(balance.valueUsd)
      || !Number.isSafeInteger(balance.block) || balance.block < 0 || !Number.isSafeInteger(balance.ts) || balance.ts <= 0) throw Error('Invalid saved UNI balance');
  }
  return file;
}

