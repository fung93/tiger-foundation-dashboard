/* Hypothetical live-input fixtures, never real wallet/provider calls. */
import { reviewContext } from './agent-review.mjs';

export const fundingFixture = (owner, now, extra = {}) => ({ schemaVersion: 'agent-lp-funding-v1', chain: 'katana', owner,
  status: 'fresh', observedAt: new Date(now).toISOString(), block: 100, cashComplete: true, cashUsd: 150,
  stableBalances: [{ symbol: 'vbUSDC', raw: '150000000', decimals: 6, amount: 150 }],
  gasUsd: 6, gasUnits: 2000000, gasPriceWei: '1000000000', nativeSymbol: 'ETH', nativePriceUsd: 3000,
  priceObservedAt: new Date(now).toISOString(), priceBlock: 100, nativeBalanceRaw: '1000000000000000000', gasBalanceSufficient: true,
  assumptions: ['Fixture cash uses a hypothetical $1 stablecoin valuation.', 'Fixture gas uses a two-million-unit scenario budget.'], notes: [], ...extra });
export async function autofillContext(now) {
  const context = await reviewContext(now);
  context.strategy.kat_usd = .01;
  return context;
}
