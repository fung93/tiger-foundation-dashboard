/* Read-only wallet funding for automatic LP scenarios. Reuse the existing
   Strategy endpoint, RPC allowlist and token metadata; no new API or account. */
import { CFG, VAULT, rpc, multi, pad } from './_core.mjs';

const fresh = (ts, now) => Number.isFinite(ts) && now - ts >= -30000 && now - ts < 90000;
const uint = value => typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value) ? BigInt(value) : null;
const word = item => item?.ok && typeof item.data === 'string' && /^0x[0-9a-f]+$/i.test(item.data) && item.data.length >= 66
  ? uint(item.data.slice(0, 66)) : null;
const addressWord = item => word(item) === null ? null : '0x' + item.data.slice(26, 66).toLowerCase();
const roundUpUsd = value => Number.isFinite(value) && value >= 0 && value < 1e12 ? Math.ceil(value * 1e6) / 1e6 : null;
const GAS_UNITS = 2000000;

export async function readLPAutofillFunding({ chain, owner, now = Date.now, readRpc = rpc, readMulti = multi } = {}) {
  const wallet = typeof owner === 'string' ? owner.toLowerCase() : '';
  const cfg = typeof chain === 'string' && Object.hasOwn(VAULT.chains, chain) && VAULT.chains[chain];
  if (!cfg || !CFG.wallets.some(item => item.address.toLowerCase() === wallet))
    throw Object.assign(Error('Choose one of the dashboard wallets and a supported chain.'), { status: 400 });
  const at = typeof now === 'function' ? now() : now;
  const out = { schemaVersion: 'agent-lp-funding-v1', chain, owner: wallet, status: 'unavailable',
    observedAt: null, block: null, cashUsd: null, cashComplete: false, stableBalances: [],
    gasUsd: null, gasUnits: GAS_UNITS, gasPriceWei: null, nativeBalanceRaw: null,
    nativeSymbol: cfg.native.s, nativePriceUsd: null, gasBalanceSufficient: null,
    assumptions: ['Cash covers listed stablecoins in this wallet on this chain, valued at $1 per token.',
      'Gas is a scenario budget of 2,000,000 gas units at the current gas price; it is not a transaction quote.'], notes: [] };
  let head, block;
  try {
    const rawHead = uint(await readRpc(cfg.rpc, 'eth_blockNumber', []));
    if (rawHead === null || rawHead > BigInt(Number.MAX_SAFE_INTEGER)) throw Error();
    head = '0x' + rawHead.toString(16); block = await readRpc(cfg.rpc, 'eth_getBlockByNumber', [head, false]);
    const timestamp = uint(block?.timestamp), number = uint(block?.number);
    if (timestamp === null || number !== rawHead || !fresh(Number(timestamp) * 1000, at)) throw Error();
    out.block = Number(rawHead); out.observedAt = new Date(Number(timestamp) * 1000).toISOString();
  } catch { out.notes.push('The wallet block is unavailable or too old. Refresh the live inputs.'); return out; }
  const stable = cfg.tokens.filter(token => token.px === 'usd');
  const settled = await Promise.allSettled([
    readMulti(cfg.rpc, stable.flatMap(token => [{ to: token.a, data: '0x70a08231' + pad(wallet) }, { to: token.a, data: '0x313ce567' }]), head),
    readRpc(cfg.rpc, 'eth_getBalance', [wallet, head]), readRpc(cfg.rpc, 'eth_gasPrice', []),
    cfg.native.px === 'usd' ? Promise.resolve({ price: 1, block: out.block, observedAt: out.observedAt }) : (async () => {
      const priceHead = chain === 'katana' ? head : await readRpc(CFG.katRpc, 'eth_blockNumber', []);
      const [rows, priceBlock] = await Promise.all([readMulti(CFG.katRpc,
        ['0x3850c7bd', '0x0dfe1681', '0xd21220a7'].map(data => ({ to: VAULT.pricePools.eth, data })), priceHead),
        chain === 'katana' ? Promise.resolve(block) : readRpc(CFG.katRpc, 'eth_getBlockByNumber', [priceHead, false])]);
      const sqrt = word(rows[0]), token0 = addressWord(rows[1]), token1 = addressWord(rows[2]);
      const usdToken = VAULT.chains.katana.tokens.find(token => token.s === 'vbUSDC');
      const ethToken = VAULT.chains.katana.tokens.find(token => token.s === 'vbETH');
      const timestamp = uint(priceBlock?.timestamp), quoteBlock = uint(priceBlock?.number);
      if (!sqrt || sqrt >= 1n << 160n || !timestamp || quoteBlock === null || quoteBlock > BigInt(Number.MAX_SAFE_INTEGER)
        || uint(priceHead) !== quoteBlock || !fresh(Number(timestamp) * 1000, at)) throw Error();
      let price;
      if (token0 === usdToken.a && token1 === ethToken.a) price = 1 / ((Number(sqrt) / 2 ** 96) ** 2 * 10 ** (usdToken.d - ethToken.d));
      else if (token0 === ethToken.a && token1 === usdToken.a) price = (Number(sqrt) / 2 ** 96) ** 2 * 10 ** (ethToken.d - usdToken.d);
      if (!Number.isFinite(price) || price <= 0 || price > 1e9) throw Error();
      return { price, block: Number(quoteBlock), observedAt: new Date(Number(timestamp) * 1000).toISOString(),
        quote: { pool: VAULT.pricePools.eth, token0, token1, sqrtPriceX96: sqrt.toString(), usdAnchorPerStablecoin: 1 } };
    })(),
  ]);
  const value = index => settled[index].status === 'fulfilled' ? settled[index].value : null;
  const balances = value(0), native = uint(value(1)), gasPrice = uint(value(2)), price = value(3);
  out.nativeBalanceRaw = native?.toString() ?? null; out.gasPriceWei = gasPrice?.toString() ?? null;
  if (Array.isArray(balances) && balances.length === stable.length * 2) {
    out.cashComplete = stable.every((token, index) => word(balances[index * 2]) !== null && word(balances[index * 2 + 1]) === BigInt(token.d));
    if (out.cashComplete) out.stableBalances = stable.map((token, index) => ({ symbol: token.s, address: token.a, decimals: token.d,
      raw: word(balances[index * 2]).toString(), amount: Number(word(balances[index * 2])) / 10 ** token.d }));
  }
  if (cfg.native.px === 'usd') { out.cashComplete = native !== null; out.cashUsd = native === null ? null : Number(native) / 10 ** cfg.native.d; }
  else if (out.cashComplete) out.cashUsd = out.stableBalances.reduce((sum, token) => sum + token.amount, 0);
  if (!Number.isFinite(out.cashUsd) || out.cashUsd < 0 || out.cashUsd > 1e12) { out.cashUsd = null; out.cashComplete = false; }
  if (price) { out.nativePriceUsd = price.price; out.priceBlock = price.block; out.priceObservedAt = price.observedAt;
    if (price.quote) out.nativePriceQuote = price.quote; }
  if (gasPrice !== null && price) out.gasUsd = roundUpUsd(Number(gasPrice * BigInt(GAS_UNITS)) / 10 ** cfg.native.d * price.price);
  if (gasPrice !== null && native !== null) out.gasBalanceSufficient = native >= gasPrice * BigInt(GAS_UNITS);
  if (!out.cashComplete) out.notes.push('One or more stablecoin balances could not be verified; available cash stays unknown.');
  if (out.gasUsd === null) out.notes.push('The current gas budget could not be priced.');
  if (native === null) out.notes.push('The native gas balance could not be verified.');
  if (out.gasBalanceSufficient === false) out.notes.push('The native gas balance is below the scenario budget.');
  out.status = out.cashComplete && out.gasUsd !== null ? 'fresh' : 'partial';
  return out;
}

export async function handleLPAutofillFunding(req, res, read = readLPAutofillFunding) {
  const query = req.query || Object.fromEntries(new URL(req.url || '/', 'https://dashboard.invalid').searchParams);
  if (query.view !== 'lp-funding') return false;
  res.setHeader('cache-control', 'no-store');
  if (req.method && req.method !== 'GET') { res.setHeader('allow', 'GET'); res.status(405).end(JSON.stringify({ error: 'Use GET.' })); return true; }
  try { res.status(200).end(JSON.stringify(await read({ chain: query.chain, owner: query.owner }))); }
  catch (error) { res.status(error.status === 400 ? 400 : 502).end(JSON.stringify({ error: error.status === 400
    ? 'Choose one of the dashboard wallets and a supported chain.' : 'The live funding reading is unavailable.' })); }
  return true;
}
