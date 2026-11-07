import { httpError, getAgentOrigin } from './_agent-http.mjs';
import { getAgentPolicy, draftAgentPolicy, confirmAgentPolicy } from './_agent-policy.mjs';
import { runAgentTool, renderAgentToolResult, validateAgentToolInput } from './_agent-tools.mjs';
import { loadAgentContext } from './_agent-context.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { configuredResearchSources, researchProtocol, validateEvidenceReferences } from './_agent-evidence.mjs';
import { createResearchReport, createStrategyReport, persistAgentReport, renderResearchReport, getAgentReport } from './_agent-reports.mjs';
import { compareAgentStrategies, validateAgentComparison } from './_agent-scenarios.mjs';
import { listAgentDecisions, getAgentDecision, recordAgentDecision, observeAgentDecision } from './_agent-decisions.mjs';
import { beginAgentJob, jobWrite, agentJobPhase } from './_agent-jobs.mjs';
import { reviewAction } from './_agent-review-actions.mjs';

export function researchQuestion(message) {
  if (typeof message !== 'string' || message.length > 1000) return null;
  const direct = message.replace(/```[\s\S]*?```|`[^`]*`|"[^"\r\n]*"|“[^”]*”/g, ' ');
  if (!/\bresearch\b|announcements?|governance|protocol news|研究|公告|治理|\bkaji(?:an)?\b|\bberita\b/i.test(direct)) return null;
  const protocols = configuredResearchSources().filter(source => new RegExp('\\b' + source.protocol + '\\b', 'i').test(direct));
  return protocols.length === 1 ? { protocol: protocols[0].protocol, query: message.slice(0, 1000) } : null;
}

// This dispatcher is called only after the existing owner session and origin
// checks. Model tool calls have no route to policy confirmation or private writes.
export async function agentAction(body, { env, store, loadContext = loadAgentContext } = {}) {
  const review = await reviewAction(body, { env, store, loadContext });
  if (review !== null) return review;
  if (body.action === 'decisions') return listAgentDecisions(store, { cursor: body.cursor ?? null, limit: body.limit ?? 10 });
  if (body.action === 'decision') return getAgentDecision(store, body.decisionId, { cursor: body.cursor ?? null });
  if (body.action === 'decisionRecord') return recordAgentDecision(store, body.input, { source: 'owner' });
  if (body.action === 'decisionObserve') {
    // Verify ownership/reference before any outbound data request.
    const saved = await getAgentDecision(store, body.decisionId, { limit: 1 });
    if (await store.increment('journal:observe:minute', 60) > 3) throw httpError(429, 'Please wait before recording another observation.');
    const context = await loadContext({ origin: getAgentOrigin(env), needs: saved.decision.kind === 'portfolio_review'
      || saved.decision.calculationIds?.some(id => id.startsWith('scenario:')) ? ['strategy'] : [] });
    return observeAgentDecision(store, body.decisionId, context);
  }
  if(body.action==='compare'){
    if(env.AGENT_STRATEGY_ENABLED==='false')throw httpError(503,'Strategy comparisons are disabled.','configuration_missing');
    const input=validateAgentComparison(body.input);
    if(body.requestId!=null&&(typeof body.requestId!=='string'||!body.requestId||body.requestId.length>160))throw httpError(400,'Choose a valid comparison reference.');
    const id='compare:request:'+createHash('sha256').update(body.requestId||randomUUID()).digest('hex'),inputHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const read=async()=>{const saved=await store.get(id);if(!saved)return null;if(saved.inputHash!==inputHash)throw httpError(409,'Send a new comparison request.');
      const report=await getAgentReport(store,saved.reportId);return {report,result:report.result,reply:renderResearchReport(report)};};
    const previous=await read();if(previous)return previous;
    const lease=await store.lock(id,90);if(!lease)throw httpError(409,'This comparison is still being prepared.');
    let job;
    try{
      const previous=await read();if(previous)return previous;
      if(await store.increment('compare:minute',60)>5)throw httpError(429,'Please wait before starting another comparison.','rate_limited');
      const policy=await getAgentPolicy(store);
      job=await beginAgentJob(store,lease,{id,kind:'comparison',inputHash,policyVersion:policy.version});
      const context=await loadContext({origin:getAgentOrigin(env),timeoutMs:6000,
        needs:input.kind==='lp'?['strategy']:input.kind==='kat'?['kat','vkat']:[]});
      const ids=input.evidenceIds||[],evidence=validateEvidenceReferences(ids,await Promise.all(ids.map(id=>store.get(id))));
      await agentJobPhase(lease,job,'calculating');
      const result=await compareAgentStrategies({context,policy,input});
      await lease.assertOwned();
      const report=await persistAgentReport(store,{...createStrategyReport({context,policy,result,input,evidence}),jobId:id},context.snapshot);
      await lease.commit([{key:id,value:{inputHash,reportId:report.reportId},ttlSeconds:86400},jobWrite(job,'completed',{reportId:report.reportId})]);
      return {report,result:{...result,status:report.status},reply:renderResearchReport(report)};
    }catch(error){if(job){try{await lease.commit([jobWrite(job,'failed')]);}catch{}}throw error;}finally{await lease.release();}
  }
  if (body.action === 'researchSources') return { sources: configuredResearchSources().map(source => ({ ...source,
    available: source.available && env.AGENT_RESEARCH_ENABLED !== 'false' })) };
  if (body.action === 'getReport') {
    const report = await getAgentReport(store, body.reportId);
    return { report, reply: renderResearchReport(report) };
  }
  if (body.action === 'research') {
    if (env.AGENT_RESEARCH_ENABLED === 'false') throw httpError(503, 'Configured-source research is disabled.', 'configuration_missing');
    if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 1000
      || !configuredResearchSources().some(source => source.protocol === body.protocol))
      throw httpError(400, 'Choose a configured protocol and a focused research question.');
    if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 160))
      throw httpError(400, 'The research request reference is invalid.');
    const query = body.query.trim(), inputHash = createHash('sha256').update(JSON.stringify([body.protocol, query])).digest('hex');
    const requestKey = 'research:request:' + createHash('sha256').update(body.requestId || randomUUID()).digest('hex');
    const reuse = async () => {
      const previous = await store.get(requestKey);
      if (!previous) return null;
      if (previous.inputHash !== inputHash) throw httpError(409, 'Send this as a new research request.');
      const report = await getAgentReport(store, previous.reportId);
      return { report, reply: renderResearchReport(report) };
    };
    const cached = await reuse(); if (cached) return cached;
    const lease = await store.lock('research:' + requestKey.slice(-64), 90);
    if (!lease) throw httpError(409, 'This research request is still being prepared. Try its same reference shortly.');
    let job;
    try {
      const repeated = await reuse(); if (repeated) return repeated;
      if (await store.increment('research:minute', 60) > 3)
        throw httpError(429, 'Please wait before starting another research request.', 'rate_limited');
      const policy = await getAgentPolicy(store);
      job = await beginAgentJob(store, lease, { id: requestKey, kind: 'research', inputHash, policyVersion: policy.version });
      // Keep context and document-fetch phases separate: each is bounded below
      // the Worker's six simultaneous outgoing connections.
      const context = await loadContext({ origin: getAgentOrigin(env) });
      await agentJobPhase(lease,job,'retrieving');
      const research = await researchProtocol({ store, protocol: body.protocol, query });
      await lease.assertOwned();
      const report = await persistAgentReport(store, { ...createResearchReport({ context, policy, research, query }), jobId: requestKey }, context.snapshot);
      await lease.commit([{ key: requestKey, value: { inputHash, reportId: report.reportId }, ttlSeconds: 86400 },jobWrite(job,'completed',{reportId:report.reportId})]);
      return { report, reply: renderResearchReport(report) };
    } catch(error) { if(job){try{await lease.commit([jobWrite(job,'failed')]);}catch{}} throw error; } finally { await lease.release(); }
  }
  if (body.action === 'policy') return getAgentPolicy(store);
  if (body.action === 'policyDraft') return draftAgentPolicy(store, body.patch,
    { expectedVersion: body.expectedVersion, source: 'owner' });
  if (body.action === 'policyConfirm') return confirmAgentPolicy(store, body.draftId, { source: 'owner' });
  if (body.action !== 'tool') return null;
  if (body.tool === 'analyzeLPRange' && env.AGENT_STRATEGY_ENABLED === 'false') throw httpError(503, 'LP range analysis is currently switched off.');
  const args = validateAgentToolInput(body.tool, body.args || {});
  if (await store.increment('tools:minute', 60) > 10)
    throw httpError(429, 'Please wait before requesting another financial reading.', 'rate_limited');
  const [context, policy] = await Promise.all([loadContext({ origin: getAgentOrigin(env), needs: body.tool === 'analyzeLPRange' ? ['strategy'] : [] }), getAgentPolicy(store)]);
  const result = await runAgentTool(body.tool, args, { context, policy });
  return { result, reply: renderAgentToolResult(result), policyVersion: policy.version,
    createdAt: new Date().toISOString(), sources: context.sources || [] };
}
