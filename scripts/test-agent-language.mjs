/* User-facing answers stay readable while amounts, stale guards and provenance
   remain deterministic. No provider, model, Telegram or production database. */
import assert from 'node:assert/strict';
import { renderAgentToolResult } from '../api/_agent-tools.mjs';
import { researchProtocol, validateEvidenceReferences } from '../api/_agent-evidence.mjs';
import { createResearchReport, renderResearchReport } from '../api/_agent-reports.mjs';
import { agentNumber, agentPrice, researchExplanation } from '../agent-language.mjs';
import { createAgentSQLiteFixture } from './fixtures/agent-sqlite.mjs';
import { createAgentStore } from '../api/_agent-store.mjs';

let count = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); count++; };
const at = Date.now(), stamp = new Date(at).toISOString();
const output = (toolName, data, status = 'ready', limitations = []) => ({ schemaVersion: 'agent-tool-v1', toolName,
  status, data, limitations, observedAt: stamp, policyVersion: 4, calculationId: 'calc:' + 'a'.repeat(64), snapshotId: 'portfolio:' + 'b'.repeat(64) });
const snapshot = { navUsd: null, verifiedSubtotalUsd: 1200, allocationBlocked: true,
  assets: [{ scope: 'main', status: 'fresh', valueUsd: 800 }, { scope: 'vault', status: 'fresh', valueUsd: 400 }], liabilities: [],
  scopes: { main: { verifiedSubtotalUsd: 800 }, vault: { verifiedSubtotalUsd: 400 } },
  lpSummary: { open: 2, netUsd: -10, unclaimedUsd: 3 } };
let result = output('getPortfolioSnapshot', snapshot, 'partial', ['raw_amounts_unavailable', 'valuation_block_unavailable',
  'missing_coverage', 'retained_or_unavailable_observations', 'LP event-ledger cursors are distinct from valuation blocks.']);
const before = JSON.stringify(result);
let reply = renderAgentToolResult(result);
for (const text of ['$1,200.00', '$800.00', '$400.00', '2 open LP positions', '-$10.00', '$3.00 still to claim']) check(reply.includes(text), true, 'Verified money facts remain readable: ' + text);
for (const text of ['calc:', 'portfolio:', 'policy v', 'Limitation:', 'raw_amounts_unavailable', 'valuation_block_unavailable']) check(reply.includes(text), false, 'Internal metadata stays out of the reply: ' + text);
check((reply.match(/partial total/g) || []).length, 1, 'Incomplete coverage becomes one clear note');
check(JSON.stringify(result), before, 'Formatting does not alter calculations or private provenance');
reply = renderAgentToolResult(output('getPortfolioSnapshot', { ...snapshot, navUsd: 1200, allocationBlocked: false }));
check(reply.includes('worth $1,200.00'), true, 'A complete value can be described as a total');
check(reply.includes('partial total'), false, 'Complete data does not acquire a generic warning');
reply = renderAgentToolResult(output('getPortfolioSnapshot', { ...snapshot, verifiedSubtotalUsd: 0, assets: [] }, 'partial'));
check(reply.includes('$0.00'), false, 'No verified values are not presented as a zero portfolio');
reply = renderAgentToolResult(output('getPortfolioSnapshot', { ...snapshot, assets: snapshot.assets.filter(row => row.scope === 'main'),
  scopes: { main: { verifiedSubtotalUsd: 800 }, vault: { verifiedSubtotalUsd: 0 } } }, 'partial'));
check(reply.includes('Tiger Vault: not available in this reading'), true, 'A missing wallet reading is not described as a zero balance');
check(reply.includes('$0.00'), false, 'A missing scope cannot become a verified zero');
reply = renderAgentToolResult(output('getPortfolioSnapshot', { ...snapshot, navUsd: 0, assets: [],
  scopes: { main: { verifiedSubtotalUsd: 0 }, vault: { verifiedSubtotalUsd: 0 } } }));
check(reply.includes('worth $0.00'), true, 'A verified complete zero remains distinguishable from missing readings');
reply = renderAgentToolResult(output('calculateTargetHealth', { market: 'Fixture loan', target_health: 2, current_health: 1.1,
  status: 'repay', repay_raw: '1', loan_decimals: 18, loan_token: 'KAT', policyCheck: { status: 'within_market_limits' } }));
check(reply.includes('repay at least 0.000000000000000001 KAT'), true, 'A required one-unit repayment retains exact precision');
reply = renderAgentToolResult(output('calculateTargetHealth', { repay_raw: '999000000', loan_decimals: 6, loan_token: 'USDC' }, 'blocked', ['A fresh complete market reading is required.']));
check(reply.includes('999'), false, 'Blocked calculations never display a stale repayment amount');
check(reply.includes('fresh, complete reading'), true, 'Missing fresh data has one practical next step');
reply = renderAgentToolResult(output('getLendingRisk', { markets: [{ market: 'Fixture loan', status: 'ready', health: 1,
  ltv: .77, debtRaw: '1000000', loanDecimals: 6, loanToken: 'USDC', liquidatable: true }] }));
check(reply.includes('below its liquidation boundary'), true, 'A critical exact result is not hidden by rounded health');
check(reply.includes('exact on-chain calculation'), true, 'A rounded boundary does not create a false healthy message');
reply = renderAgentToolResult(output('getLendingRisk', { markets: [{ market: 'KAT / USDC', status: 'ready', health: 2,
  ltv: .3, debtRaw: '1000000', loanDecimals: 6, loanToken: 'USDC', sensitivity: { conditionalKatUsdBoundary: .0034567, katPriceBasis: 'pool' } }] }));
check(reply.includes('$0.0034567'), true, 'A small token liquidation price is not displayed as zero dollars');
check(reply.includes('pool price as a proxy') && reply.includes('oracle controls'), true, 'A proxy price retains its material caveat');
reply = renderAgentToolResult(output('getLendingRisk', { markets: [{ market: 'avKAT / KAT', status: 'ready', health: 1.1,
  ltv: .7, debtRaw: '1000000', loanDecimals: 6, loanToken: 'KAT', sensitivity: { kind: 'kat-ratio', oracleLiquidationPrice: 1.23456789 } }] }));
check(reply.includes('oracle ratio of 1.234568'), true, 'The useful liquidation ratio remains in the plain explanation');
check(reply.includes('balances unchanged') && reply.includes('not a KAT dollar-price forecast'), true, 'Ratio sensitivity retains its assumptions and units');
check(agentNumber(1e-18), '0.000000000000000001', 'Tiny verified token quantities do not become zero');
check(agentPrice(.0034), '$0.0034', 'Unit prices preserve useful sub-cent precision');

const fixture = createAgentSQLiteFixture(), store = createAgentStore({ AGENT_DB: fixture.db });
const contract = 'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }\n'
  + 'struct Position { uint256 supplyShares; uint128 borrowShares; uint128 collateral; }\n'
  + 'function position(Id id, address user) external view returns (Position memory);\n';
const doc = '# Morpho Blue\nMorpho Blue is a non-custodial lending protocol implemented for the Ethereum Virtual Machine.\n';
const calls = [];
const fetcher = async url => { calls.push(String(url)); return new Response(String(url).endsWith('/IMorpho.sol') ? contract : doc,
  { headers: { 'content-type': 'text/plain' } }); };
try {
  const query = 'Explain Morpho Blue isolated lending markets';
  const research = await researchProtocol({ store, protocol: 'morpho', query, fetcher });
  const report = createResearchReport({ research, query, context: {}, policy: { version: 4 } });
  check(calls.length, 2, 'A market question reads only its two configured official sources');
  check(report.status, 'ready', 'The detailed source supports the asked explanation');
  check(report.assessment.includes('separate lending pool') && report.assessment.includes('does not automatically protect'), true, 'The answer explains market separation in plain language');
  check(report.explanationEvidenceIds.length, 1, 'The explanation identifies its actual supporting evidence');
  check(validateEvidenceReferences(report.sourceIds, research.evidence).length, 2, 'Full immutable citations still validate');
  check(report.policyVersion, 4, 'The policy version remains in structured report data');
  reply = renderResearchReport(report);
  check(reply.includes('struct MarketParams'), false, 'The conversational reply does not dump source code');
  check(reply.includes('/IMorpho.sol'), true, 'Telegram keeps a direct source citation');
  check(reply.includes(report.reportId), false, 'A report ID is not treated as useful conversation');
  check(reply.includes('Limitation'), false, 'Boilerplate limitation lists are removed');
  const withoutDetail = { ...report, facts: report.facts.filter(row => row.sourceId !== 'morpho-blue-markets') };
  check(researchExplanation(withoutDetail).complete, false, 'An introductory source cannot establish the detailed market answer');
  check(researchExplanation(withoutDetail).text.includes('need the detailed market source'), true, 'Missing supporting detail is explained honestly');
  const changed = { ...report, facts: report.facts.map(row => ({ ...row, url: 'https://unapproved.fixture.test' })) };
  check(researchExplanation(changed).complete, false, 'A lookalike source cannot activate a reviewed explanation');
  const news = researchExplanation({ ...report, objective: 'Latest Morpho governance proposals' });
  check(news.complete, false, 'Background sources cannot be presented as live news');
  check(news.text.includes('could not verify the latest'), true, 'Unavailable news gets one understandable explanation');
  check(await store.get('policy:current'), null, 'Source retrieval and explanation never create policy');
  console.log('Readable agent answers: ' + count + ' assertions passed.');
} finally { fixture.close(); }
