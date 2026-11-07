import { createHash, randomUUID } from 'node:crypto';
import { httpError, getAgentOrigin, agentErrorCategory } from './_agent-http.mjs';
import { loadAgentContext, summarizeAgent } from './_agent-context.mjs';
import { respondAgent } from './_agent-brain.mjs';
import { createAgentBudget } from './_agent-budget.mjs';
import { getAgentModelProfile, AGENT_MODEL_SCHEMA_VERSION } from './_agent-models.mjs';
import { getAgentPolicy } from './_agent-policy.mjs';
import { agentAction, researchQuestion } from './_agent-actions.mjs';
import { beginAgentJob, jobWrite, agentJobPhase } from './_agent-jobs.mjs';
import { safeAgentOutputDiagnostic } from './_agent-output-diagnostics.mjs';

const FALLBACK_ERRORS = new Set(['configuration_missing', 'model_unavailable', 'quota_exhausted', 'timeout', 'invalid_model_output']);
const ANSWER_SCHEMA = 'agent-answer-v4', CURRENT_TTL = 90000;
const historical = source => source?.name === 'history' || source?.kind === 'historical';
const sourceExpiry = (source, at) => {
  const time = Date.parse(source?.ts);
  return Number.isFinite(time) && time <= at + 30000 ? time + CURRENT_TTL : at;
};
function liveInputExpiry(context, at) {
  const sources = (context?.sources || []).filter(source => source?.status === 'fresh' && !historical(source));
  const marketSources = (context?.lending?.markets || []).filter(row => row?.status === 'fresh');
  return Math.min(at + CURRENT_TTL, ...[...sources, ...marketSources].map(source => sourceExpiry(source, at)));
}
function datedContext(context, at) {
  const stale = source => source?.status === 'fresh' && sourceExpiry(source, at) <= at;
  const result = { ...context, sources: (context?.sources || []).map(source => !historical(source) && stale(source) ? { ...source, status: 'stale' } : source) };
  for (const key of ['lending', 'lp', 'portfolio', 'strategy', 'kat', 'vkat']) {
    const source = context?.[key];
    if (!source || typeof source !== 'object') continue;
    result[key] = stale(source) ? { ...source, status: 'stale' } : { ...source };
    if (key === 'lending') result[key].markets = (source.markets || []).map(row => stale(row) ? { ...row, status: 'stale' } : row);
  }
  return result;
}
export function factualAgentAnswer(context, category) {
  const current = datedContext(context, Date.now());
  return { reply: 'I could not finish the full request this time. Here are the readings I can check:\n\n'
    + summarizeAgent(current), action: null, sources: current.sources, status: 'partial', mode: 'facts_only', errorCategory: category };
}

export const DEFAULT_SETTINGS = Object.freeze({ healthThreshold: 1.2, ltvThreshold: 70, alertsEnabled: true, dailyEnabled: false, dailyTime: '09:00', pausedUntil: null });
export function normalizeSettings(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Choose valid alert settings.');
  const out = partial ? {} : { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw httpError(400, 'An alert setting was not recognised.');
    if (key === 'healthThreshold' && (!Number.isFinite(value) || value < 1 || value > 100)) throw httpError(400, 'The health alert must be between 1 and 100.');
    if (key === 'ltvThreshold' && (!Number.isFinite(value) || value <= 0 || value > 100)) throw httpError(400, 'The LTV alert must be above 0 and no higher than 100%.');
    if (['alertsEnabled', 'dailyEnabled'].includes(key) && typeof value !== 'boolean') throw httpError(400, 'Choose whether this alert is enabled.');
    if (key === 'dailyTime' && (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) throw httpError(400, 'Choose a valid daily report time in MYT.');
    if (key === 'pausedUntil' && value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw httpError(400, 'Choose a valid time to resume alerts.');
    out[key] = value;
  }
  return out;
}
export async function getSettings(store) { return normalizeSettings(await store.get('settings') || {}); }

export async function processAgentMessage({ store, message, source = 'dashboard', requestId, env = process.env, context,
  loadContext = loadAgentContext, respond = respondAgent, budgetFactory = createAgentBudget }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw httpError(400, 'Ask a question using 1 to 4,000 characters.');
  if (!['dashboard', 'telegram'].includes(source)) throw httpError(400, 'Unknown conversation source.');
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 160 || !requestId)) throw httpError(400, 'The message reference is invalid.');
  const cacheKey = requestId && 'request:' + createHash('sha256').update(requestId).digest('hex');
  const inputHash = createHash('sha256').update(source + '\n' + message.trim()).digest('hex');
  const policy = await getAgentPolicy(store);
  let profile;
  try { profile = getAgentModelProfile(env); } catch {}
  const configurationHash = createHash('sha256').update(JSON.stringify({
    model: profile?.id || (typeof env.AGENT_MODEL === 'string' ? env.AGENT_MODEL : null),
    profileVersion: profile?.version || null, modelSchema: AGENT_MODEL_SCHEMA_VERSION, answerSchema: ANSWER_SCHEMA,
    inferenceEnabled: env.AGENT_INFERENCE_ENABLED !== 'false', bindingConfigured: typeof env.AI?.run === 'function',
    policyVersion: policy.version,
  })).digest('hex');
  const cachedAnswer = async () => {
    if (!cacheKey) return null;
    const cached = await store.get(cacheKey);
    if (!cached) return null;
    if (cached.inputHash !== inputHash) throw httpError(409, 'Send this as a new question with a new message reference.');
    if (cached.configurationHash !== configurationHash)
      throw httpError(409, 'The agent configuration has changed. Send a new question for a current answer.', 'data_stale');
    if (!Number.isFinite(cached.validUntil) || Date.now() >= cached.validUntil)
      throw httpError(409, 'This answer has expired. Send a new question for a fresh reading.', 'data_stale');
    return cached.answer;
  };
  const initial = await cachedAnswer(); if (initial) return initial;
  const jobId = source + ':' + (requestId ? createHash('sha256').update(requestId).digest('hex') : randomUUID());
  const lock = await store.lock('chat:' + jobId, 90);
  if (!lock) throw httpError(409, 'This question is still being prepared. Try the same reference shortly.');
  let handle, owner, policyLease;
  try {
    const cached = await cachedAnswer(); if (cached) return cached;
    const day = new Date().toISOString().slice(0, 10);
    const dailyLimit = Math.min(100, Math.max(1, Number(env.AGENT_DAILY_MESSAGE_LIMIT) || 40));
    if (await store.increment('usage:minute', 60) > 5 || await store.increment('usage:day:' + day, 86400 * 2) > dailyLimit)
      throw httpError(429, 'The agent has reached its message limit. Please try again later.', 'rate_limited');
    let settings = await getSettings(store);
    const messages = await store.get('messages') || [];
    handle = await beginAgentJob(store, lock, { id: jobId, kind: 'chat', inputHash, policyVersion: policy.version });
    const reading = { ...(context || await loadContext({ origin: getAgentOrigin(env) })), policy };
    let result, inferenceSucceeded = false, modelOutput = null;
    let inputExpiresAt = liveInputExpiry(reading, Date.now());
    const research = researchQuestion(message);
    await agentJobPhase(lock, handle, research ? 'retrieving' : 'inference');
    if (research) {
      const prepared = await agentAction({ action: 'research', ...research, requestId: jobId },
        { env, store, loadContext: async () => reading });
      result = { reply: prepared.reply, report: prepared.report, status: prepared.report.status,
        action: null, mode: 'research', sources: reading.sources || [] };
    } else {
    try {
      if (env.AGENT_INFERENCE_ENABLED === 'false') throw httpError(503, 'AI explanations are disabled.', 'configuration_missing');
      if (typeof env.AI?.run !== 'function') throw httpError(503, 'The free AI connection is not ready yet.', 'configuration_missing');
      // Construct lazily so a facts-only request needs no inference migration.
      // Every actual model invocation still reserves its durable budget first.
      let budget, usedInference = false;
      const ledger = () => budget ||= budgetFactory(env, { jobId });
      const inference = { reserve: async args => { const attempt = await ledger().reserve(args); usedInference = true; return attempt; },
        settle: (attempt, outcome) => ledger().settle(attempt, outcome),
        observe: value => { modelOutput = safeAgentOutputDiagnostic(value); } };
      result = await respond({ message: message.trim(), messages: messages.slice(-12), settings, context: reading, policy, env, inference });
      inferenceSucceeded = usedInference && !result?.errorCategory;
    } catch (error) {
      const category = agentErrorCategory(error);
      if (!FALLBACK_ERRORS.has(category)) throw error;
      result = factualAgentAnswer(reading, category);
    }
    }
    if (Array.isArray(result?.toolResults) && result.toolResults.length) {
      const expiries = result.toolResults.filter(tool => tool.status !== 'blocked').map(tool => Date.parse(tool.validUntil));
      // A verified market is independent of unrelated stale markets or LP data.
      inputExpiresAt = expiries.length ? Math.min(...expiries.map(value => Number.isFinite(value) ? value : 0)) : Date.now() + CURRENT_TTL;
    }
    // A successful inference does not extend the lifetime of its source data.
    // Discard generated amounts and actions if any current input expired while
    // the provider was working. Keep only visibly dated deterministic facts.
    if ((!result?.mode || result.mode === 'ai') && Date.now() >= inputExpiresAt)
      result = factualAgentAnswer(datedContext(reading, Date.now()), 'data_stale');
    await agentJobPhase(lock, handle, 'validating');
    // Only private reads and a short fenced transaction happen under these locks.
    policyLease = await store.lock('policy', 15);
    if (!policyLease) throw httpError(409, 'Policy confirmation is in progress. Request a new review.');
    owner = await store.lock('owner', 15);
    if (!owner) throw httpError(409, 'A private update is finishing. Request a new review.');
    settings = await getSettings(store);
    const latestMessages = await store.get('messages') || [];
    if ((await getAgentPolicy(store)).version !== policy.version) {
      result = { status: 'superseded', action: null, mode: 'facts_only', errorCategory: 'data_stale',
        sources: datedContext(reading, Date.now()).sources,
        reply: 'The strategy policy changed while this answer was being prepared. Request a new review. No recommendation or settings change was applied.' };
    }
    if (!result || typeof result.reply !== 'string' || !result.reply.trim() || result.reply.length > 12000) throw httpError(503, 'The AI reply could not be verified.');
    if (result.action) {
      if (result.action.type !== 'settings') throw httpError(503, 'The agent requested an unsupported action.');
      settings = normalizeSettings({ ...settings, ...normalizeSettings(result.action.settings, { partial: true }) });
    }
    const ts = new Date().toISOString();
    const next = [...latestMessages, { role: 'user', content: message.trim(), ts, source }, { role: 'assistant', content: result.reply, ts, source }].slice(-24);
    const answer = { reply: result.reply, messages: next, settings,
      sources: datedContext({ sources: result.sources || reading.sources || [] }, Date.now()).sources,
      status: result.status || 'ready', mode: result.mode || 'ai', errorCategory: result.errorCategory || null, jobId,
      schemaVersion: ANSWER_SCHEMA, createdAt: ts };
    answer.policyVersion = policy.version;
    answer.snapshotId = result.snapshotId || reading.snapshot?.snapshotId || null;
    if (result.result || result.toolResults?.[0]) answer.result = result.result || result.toolResults[0];
    if (Array.isArray(result.toolResults)) answer.toolResults = result.toolResults;
    if (Array.isArray(result.calculationIds)) answer.calculationIds = result.calculationIds;
    if (result.report) answer.report = result.report;
    const writes = [{ key: 'messages', value: next }, { key: 'settings', value: settings }, { key: 'sources', value: answer.sources }];
    writes.push({ key: 'diagnostics:lastRequest', value: { ts, mode: answer.mode, errorCategory: answer.errorCategory, modelOutput } });
    if (inferenceSucceeded && profile) writes.push({ key: 'diagnostics:lastInference', value: { ts, status: 'succeeded',
      modelId: profile.id, profileVersion: profile.version } });
    const completedAt = Date.now();
    if (cacheKey) writes.push({ key: cacheKey, value: { inputHash, configurationHash,
      validUntil: answer.mode === 'facts_only' ? liveInputExpiry(datedContext(reading, completedAt), completedAt) : inputExpiresAt, answer }, ttlSeconds: 86400 });
    writes.push(jobWrite(handle, answer.status === 'superseded' ? 'superseded' : 'completed', { reportId: answer.report?.reportId || null }));
    await lock.commit(writes, { alsoOwned: [owner, policyLease] });
    return answer;
  } catch (error) {
    if (handle) { try { await lock.commit([jobWrite(handle, 'failed', { errorCategory: agentErrorCategory(error) })]); } catch {} }
    throw error;
  } finally {
    if (owner) await owner.release();
    if (policyLease) await policyLease.release();
    await lock.release();
  }
}
