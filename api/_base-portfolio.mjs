/* Base holdings use the LP Book's actual V3 reader, not the UNI guide's pool list.
   One tracked wallet per reading; the other wallet is counted by Tiger Vault. */
import { BASE } from '../base-config.mjs';
import { CFG, chainOf, rpc, multi, pad, hx, v3Candidates, v3Rows, rowPrices, r2, baseDollarQuote } from './_core.mjs';

const word = (result, index = 0) => {
  if (!result?.ok || !/^0x[0-9a-f]+$/i.test(result.data || '') || result.data.length < 66 + index * 64)
    throw Error('A required Base contract reading is unavailable');
  return BigInt('0x' + result.data.slice(2 + index * 64, 66 + index * 64));
};
const checkedRaw = result => {
  if (typeof result !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(result)) throw Error('Invalid Base balance or block');
  return BigInt(result);
};

export function basePortfolioPosition(row) {
  const R = row.raw;
  return { type: 'LP', protocol: row.protocol, chain: 'base', wallet: row.wallet,
    token_id: row.id, pair: row.pair, pool_fee: R.fee / 10000 + '%',
    value_usd: row.value_usd, liquidity_usd: row.liquidity_usd, fees_usd: row.fees_usd,
    staked: false, in_range: row.in_range, range_status: row.range_status, range: row.range, amounts: row.amounts,
    meta: { kind: 'v3', pool: R.pool, token0: R.token0, token1: R.token1,
      d0: R.t0.d, d1: R.t1.d, s0: R.t0.s, s1: R.t1.s, lo: R.lo, hi: R.hi, fee: R.fee,
      liquidity: R.liq, valuation_block: R.valuation_block },
    note: '#' + row.id + ' · ' + Object.entries(row.amounts).map(([s, n]) => n.toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' ' + s).join(' + ') };
}

export async function readBasePortfolio({ address = CFG.wallet, now = Date.now,
  readRpc = rpc, readMulti = multi, discover = v3Candidates, readRows = v3Rows } = {}) {
  const owner = String(address).toLowerCase();
  if (!CFG.wallets.some(w => w.address.toLowerCase() === owner)) throw Error('Choose a tracked Base wallet');
  const chain = chainOf('base'), number = checkedRaw(await readRpc(CFG.baseRpc, 'eth_blockNumber', []));
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Invalid Base block');
  const tag = hx(Number(number)), block = await readRpc(CFG.baseRpc, 'eth_getBlockByNumber', [tag, false]);
  const ts = Number(checkedRaw(block?.timestamp)) * 1000, at = typeof now === 'function' ? now() : now;
  if (checkedRaw(block?.number) !== number || !Number.isFinite(ts) || at - ts < -30000 || at - ts > 90000)
    throw Error('The Base block is not current');
  const [native, balances, candidates] = await Promise.all([
    readRpc(CFG.baseRpc, 'eth_getBalance', [owner, tag]),
    readMulti(CFG.baseRpc, BASE.tokens.flatMap(t => [{ to: t.a, data: '0x70a08231' + pad(owner) }, { to: t.a, data: '0x313ce567' }]), tag),
    discover(chain, {}, {}, [], { wallets: [owner], wholeList: true, tag }),
  ]);
  const rows = await readRows(chain, {}, candidates, { noEntry: true, tag });
  if (rows.some(r => r.wallet?.toLowerCase() !== owner || !Number.isFinite(r.value_usd) || r.value_usd < 0
    || !Number.isFinite(r.fees_usd) || r.fees_usd < 0)) throw Error('Base LP valuation is incomplete');
  const quotes = new Map(BASE.tokens.filter(t => t.stable).map(t => [t.a, 1]));
  for (const row of rows) {
    const prices = rowPrices(row);
    for (const token of [row.raw.t0, row.raw.t1]) if (prices[token.s + '@base'] > 0) quotes.set(token.a, prices[token.s + '@base']);
  }
  const raw = [{ s: 'ETH', d: 18, a: null, raw: checkedRaw(native) }];
  BASE.tokens.forEach((token, i) => {
    if (word(balances[i * 2 + 1]) !== BigInt(token.d)) throw Error('Base token decimals changed');
    raw.push({ ...token, raw: word(balances[i * 2]) });
  });
  const weth = BASE.tokens.find(t => t.s === 'WETH');
  for (const token of raw.filter(t => t.raw > 0n && !quotes.has(t.a || weth.a))) {
    const quoted = token.a ? token : weth;
    quotes.set(quoted.a, await baseDollarQuote(quoted, tag, readMulti));
  }
  const tokens = Object.fromEntries(raw.map(token => {
    const amount = Number(token.raw) / 10 ** token.d, price = quotes.get(token.a || weth.a) ?? null;
    return [token.s, { balance: amount, raw: token.raw.toString(), decimals: token.d,
      address: token.a, priceUSD: price, valueUSD: amount === 0 ? 0 : amount * price }];
  }));
  if (Object.values(tokens).some(t => !Number.isFinite(t.valueUSD))) throw Error('Base wallet valuation is incomplete');
  const walletUsd = r2(Object.values(tokens).reduce((s, t) => s + t.valueUSD, 0)),
    lps = rows.map(basePortfolioPosition), lpUsd = r2(lps.reduce((s, p) => s + p.value_usd, 0));
  return { schemaVersion: 'base-portfolio-v1', name: 'Base', chain_id: BASE.id, owner, block: Number(number),
    read_at: new Date(ts).toISOString(), complete: true, live: true, color: '#0052ff', native_token: 'ETH',
    wallet: { balances: { tokens }, total_usd: walletUsd }, onchain_usd: walletUsd,
    lp_positions: lps, defi_positions: [], lp_total_usd: lpUsd, total_usd: r2(walletUsd + lpUsd) };
}
