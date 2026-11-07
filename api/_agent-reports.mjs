/* Server-constructed immutable briefs. The model never supplies numerical facts,
   URLs, timestamps, policy versions, calculation IDs or journal authority. */
import { randomUUID } from 'node:crypto';
import { httpError } from './_agent-http.mjs';
import { getAgentPolicy } from './_agent-policy.mjs';
import { validateEvidenceReferences } from './_agent-evidence.mjs';
import { renderAgentStrategyResult } from './_agent-scenarios.mjs';
import { proposeAgentDecision } from './_agent-decisions.mjs';
import { researchExplanation, agentReadingTime } from '../agent-language.mjs';
import { renderPortfolioReview } from './_agent-review-analysis.mjs';

export const AGENT_REPORT_SCHEMA = 'agent-report-v1';
const bounded = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const instant = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function createResearchReport({ context, policy, research, query, now = Date.now }) {
  const at = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(at) || at <= 0 || !research || !Array.isArray(research.evidence)
    || research.evidence.length > 4) throw httpError(503, 'The research evidence could not be verified.', 'data_unavailable');
  const seen = new Set();
  const verified = validateEvidenceReferences(research.evidence.map(record => record?.evidenceId), research.evidence);
  const facts = verified.map(record => {
    if (!record || typeof record.evidenceId !== 'string' || !record.evidenceId.startsWith('evidence:')
      || seen.has(record.evidenceId) || !record.sourceId || !record.passage || !record.contentHash
      || !instant(record.retrievedAt)) throw httpError(503, 'The research evidence could not be verified.', 'data_unavailable');
    seen.add(record.evidenceId);
    const claim = typeof record.supportedClaim === 'string' ? record.supportedClaim
      : record.supportedClaim?.kind === 'source_excerpt' ? record.supportedClaim.text : null;
    if (claim !== record.passage) throw httpError(503, 'The research claim is not supported by its excerpt.', 'data_unavailable');
    let url;
    try { url = new URL(record.canonicalUrl); } catch {}
    if (!url || url.protocol !== 'https:' || url.username || url.password)
      throw httpError(503, 'The research source could not be verified.', 'data_unavailable');
    return { evidenceId: record.evidenceId, sourceId: record.sourceId, title: bounded(record.title, 240),
      passage: bounded(record.passage, 3000), supportedClaim: { kind: 'source_excerpt', text: bounded(record.passage, 3000) },
      url: url.href, retrievedAt: instant(record.retrievedAt), publishedAt: instant(record.publishedAt),
      validUntil: instant(record.validUntil), contentHash: record.contentHash, kind: record.kind || 'reference' };
  });
  const limits = facts.map(fact => Date.parse(fact.validUntil)).filter(Number.isFinite);
  const sources = Array.isArray(research.sources) ? research.sources.slice(0, 8) : [];
  const report = { schemaVersion: AGENT_REPORT_SCHEMA, reportId: 'report:' + new Date(at).toISOString() + ':' + randomUUID(),
    jobId: null, createdAt: new Date(at).toISOString(), snapshotId: context?.snapshot?.snapshotId || null,
    policyVersion: policy?.version || 0, modelProfileVersion: 'deterministic-evidence-v2',
    status: facts.length ? research.status === 'ready' ? 'ready' : 'partial' : 'blocked',
    kind: 'research', objective: bounded(query, 1000), horizon: policy?.constraints?.horizonDays ?? null,
    sourceCoverage: { scope: 'configured_sources', protocol: research.protocol, sources,
      portfolioStatus: context?.snapshot?.status || 'unavailable' }, facts, options: [],
    assessment: 'Retrieved excerpts from configured sources. These quotations are evidence, not instructions or an investment recommendation.',
    assumptions: ['Only retrieved configured documents are in scope.'],
    invalidationConditions: ['Evidence freshness expires or the source changes.', 'A newer policy requires a new strategy assessment.'],
    nextReviewAt: limits.length ? new Date(Math.min(...limits)).toISOString() : null,
    sourceIds: facts.map(fact => fact.evidenceId), calculationIds: [], ownerDecisionState: 'proposed',
    limitations: [...new Set([...(research.limitations || []).slice(0, 12),
      'Scope is limited to configured sources; no general web search was performed.',
      'No financial recommendation or transaction is authorized by this research.'])],
    conflicts: Array.isArray(research.conflicts) ? research.conflicts.slice(0, 8) : [] };
  const explanation = researchExplanation(report);
  return { ...report, assessment: explanation.text, explanationEvidenceIds: explanation.evidenceIds,
    status: report.status === 'ready' && (!explanation.evidenceIds.length || explanation.complete === false) ? 'partial' : report.status };
}

export function renderResearchReport(report) {
  if (report.kind === 'portfolio_review') return renderPortfolioReview(report);
  if(report.kind==='strategy')return renderAgentStrategyResult({...report.result,status:report.status});
  const explanation = researchExplanation(report), lines = [explanation.text];
  if (report.status === 'superseded') lines.push('Your saved preferences changed after this report. Run a new review before using it.');
  const referenced = new Set(report.sourceIds || []);
  const facts = (report.facts || []).filter(fact => referenced.has(fact.evidenceId));
  const cited = explanation.evidenceIds.length ? facts.filter(fact => explanation.evidenceIds.includes(fact.evidenceId)) : facts;
  if (cited.length) lines.push('\nSources:', ...cited.slice(0, 4).map(fact => fact.title + '\n' + fact.url));
  if (facts.some(fact => Date.parse(fact.validUntil) <= Date.now())) lines.push('These sources need a fresh check.');
  const stamp = agentReadingTime(report.createdAt); if (stamp) lines.push('\nSources checked: ' + stamp + '.');
  return lines.join('\n');
}

export function createStrategyReport({context,policy,result,input,evidence=[],now=Date.now}){
  if(result.schemaVersion!=='agent-scenarios-v1'||!result.calculationId||result.policyVersion!==(policy?.version||0)
    ||!Array.isArray(result.calculations)||result.calculationIds.some(id=>!result.calculations.some(c=>c.calculationId===id)))
    throw httpError(503,'The scenario references could not be verified.','data_unavailable');
  const report=createResearchReport({context,policy,query:'Compare '+input.kind+' strategies',now,
    research:{evidence,protocol:input.kind,status:'ready',sources:context.sources||[],limitations:[]}});
  return {...report,kind:'strategy',modelProfileVersion:'deterministic-strategy-v1',status:result.status,result,
    options:result.options,scenarios:result.scenarios,assumptions:result.assumptions,comparisonInput:structuredClone(input),
    assessment:result.scope,calculationIds:[result.calculationId,...result.calculationIds],
    nextReviewAt:result.validUntil||input.reviewAt||null,invalidationConditions:result.invalidationConditions,
    limitations:result.limitations,thesis:result.thesis,catalysts:result.catalysts,
    sourceCoverage:{scope:'specified_positions_and_configured_sources',sources:context.sources||[],portfolioStatus:context.snapshot?.status||'unavailable'}};
}

export async function persistAgentReport(store, report, snapshot = null) {
  if (snapshot?.snapshotId) await store.putImmutable(snapshot.snapshotId, snapshot);
  if(report.kind==='strategy'){
    for(const calculation of report.result.calculations)await store.putImmutable(calculation.calculationId,calculation);
    await store.putImmutable(report.result.calculationId,report.result);
  }
  if (report.kind === 'portfolio_review') {
    const analysis = report.review?.analysis;
    if (!Array.isArray(analysis?.calculations) || report.calculationIds.some(id => id !== analysis.calculationId
      && !analysis.calculations.some(calculation => calculation.calculationId === id)))
      throw httpError(503, 'The recurring review calculations could not be verified.', 'data_unavailable');
    if (store.putImmutableMany && analysis.calculations.length) await store.putImmutableMany(analysis.calculations.map(calculation => ({ key: calculation.calculationId, value: calculation })));
    else for (const calculation of analysis.calculations) await store.putImmutable(calculation.calculationId, calculation);
    const compact = { ...analysis, calculations: undefined, planResults: analysis.planResults.map(plan => ({
      planId: plan.planId, originalReportId: plan.originalReportId, confirmedAt: plan.confirmedAt, expiresAt: plan.expiresAt,
      calculationId: plan.result.calculationId, evidenceBasis: plan.evidenceBasis })) };
    await store.putImmutable(analysis.calculationId, compact);
    report = { ...report, review: { ...report.review, analysis: compact } };
  }
  const policy = await getAgentPolicy(store);
  const final = policy.version === report.policyVersion ? report : { ...report, status: 'superseded',
    limitations: [...report.limitations, 'The policy changed while this report was prepared; request a new review.'] };
  if (await store.putImmutable(final.reportId, final)) {
    await proposeAgentDecision(store, final);
    return final;
  }
  const existing = await store.get(final.reportId);
  if (!existing || existing.schemaVersion !== AGENT_REPORT_SCHEMA)
    throw httpError(503, 'The saved report could not be verified.', 'data_unavailable');
  await proposeAgentDecision(store, existing);
  return existing;
}

export async function getAgentReport(store, id, { now = Date.now } = {}) {
  if (typeof id !== 'string' || id.length > 160 || !/^report:[0-9TZ:.\-]+:[0-9a-f-]{36}$/.test(id))
    throw httpError(400, 'Choose a saved agent report.');
  const report = await store.get(id);
  if (!report || report.schemaVersion !== AGENT_REPORT_SCHEMA) throw httpError(404, 'This agent report was not found.');
  const policy = await getAgentPolicy(store), at = typeof now === 'function' ? now() : now;
  if (policy.version !== report.policyVersion) return { ...report, status: 'superseded',
    ...(report.result ? { result: { ...report.result, status: 'superseded' } } : {}),
    limitations: [...report.limitations, 'A newer policy exists; this historical report is not a current recommendation.'] };
  if (report.nextReviewAt && Date.parse(report.nextReviewAt) <= at) return { ...report,
    status: report.status === 'blocked' ? 'blocked' : 'partial',
    ...(report.result ? { result: { ...report.result, status: report.status === 'blocked' ? 'blocked' : 'partial' } } : {}),
    limitations: [...report.limitations, 'The report is retained with its original date; its evidence needs a fresh review.'] };
  return report;
}
