/* Explicit Workers AI profiles; no family wildcards, paid gateway or auto fallback.
   Catalog/schema and neuron rates checked against Cloudflare's official docs
   repository on 2026-11-05. Account access still needs the live release gate. */
import { httpError } from './_agent-http.mjs';

export const DEFAULT_AGENT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const AGENT_MODEL_SCHEMA_VERSION = 'agent-model-v2';
const VERIFIED_AT = '2026-11-05';
const CATALOG = 'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models/';
const PRICING = 'https://developers.cloudflare.com/workers-ai/platform/pricing/';
const profile = (id, contextTokens, inputNeuronsPerMillion, outputNeuronsPerMillion) => Object.freeze({
  id, version: id.split('/').at(-1) + ':2026-11-05:v1', verifiedAt: VERIFIED_AT,
  verification: 'official_schema_and_pricing; live_account_unverified', freeCompatible: true,
  contextTokens, maxInputTokens: Math.min(30000, contextTokens - 800), maxOutputTokens: 800,
  requestFormat: 'workers-ai-messages', responseFormat: 'json_object',
  responseShapes: Object.freeze(['chat-completion', 'workers-json']), tools: Object.freeze(['calculateTargetHealth']),
  rates: Object.freeze({ inputNeuronsPerMillion, outputNeuronsPerMillion }),
  schemaSource: CATALOG + id.split('/').at(-1) + '.json', pricingSource: PRICING,
});
export const AGENT_MODEL_PROFILES = Object.freeze({
  [DEFAULT_AGENT_MODEL]: profile(DEFAULT_AGENT_MODEL, 32768, 4625, 30475),
  '@cf/zai-org/glm-4.7-flash': profile('@cf/zai-org/glm-4.7-flash', 131072, 5500, 36400),
});

export function agentModelError(category, message, status = 503) {
  return httpError(status, message, category);
}
export function getAgentModelProfile(env = {}) {
  const id = env.AGENT_MODEL || DEFAULT_AGENT_MODEL;
  if (id === '@cf/meta/llama-3.1-8b-instruct') throw agentModelError('model_unavailable',
    'The configured AI model has been retired. Select the supported Qwen model in Cloudflare.');
  if (typeof id !== 'string' || !Object.hasOwn(AGENT_MODEL_PROFILES, id)) throw agentModelError('configuration_missing',
    'Choose a supported Cloudflare Workers AI model.');
  return AGENT_MODEL_PROFILES[id];
}
function trustedProfile(value) {
  if (!value || AGENT_MODEL_PROFILES[value.id] !== value) throw agentModelError('configuration_missing', 'Choose a supported Cloudflare Workers AI model.');
  return value;
}
export function estimateAgentModelCost(value, inputTokens, outputTokens) {
  const p = trustedProfile(value);
  if (![inputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000))
    throw agentModelError('configuration_missing', 'The AI usage estimate could not be verified.');
  // Round up to a thousandth neuron; this is planning arithmetic, not billing.
  return Math.ceil((inputTokens * p.rates.inputNeuronsPerMillion + outputTokens * p.rates.outputNeuronsPerMillion) / 1000) / 1000;
}
const lendingTool = Object.freeze({ type: 'function', function: {
  name: 'calculateTargetHealth', description: 'Calculate verified repayment and borrowing room for one fresh lending market and target health.',
  parameters: { type: 'object', properties: { market: { type: 'string', description: 'Exact supplied market id, key or label.' },
    targetHealth: { type: 'number', description: 'Owner-selected minimum health, at least one.' } }, required: ['market', 'targetHealth'], additionalProperties: false },
} });
export function createAgentModelRequest(value, messages) {
  const p = trustedProfile(value);
  if (!Array.isArray(messages) || !messages.length || messages.length > 12 || messages.some(row => !row
    || !['system', 'user', 'assistant', 'tool'].includes(row.role) || typeof row.content !== 'string'))
    throw agentModelError('configuration_missing', 'The AI request could not be verified.');
  return { messages, max_tokens: p.maxOutputTokens, temperature: .1, stream: false,
    response_format: { type: p.responseFormat }, tools: [lendingTool] };
}
const invalid = () => agentModelError('invalid_model_output', 'The AI answer was incomplete. Please try again.');
export function readAgentModelUsage(response) {
  const u = response && typeof response === 'object' ? response.usage : null;
  if (!u || ![u.prompt_tokens, u.completion_tokens, u.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000)
    || u.total_tokens !== u.prompt_tokens + u.completion_tokens) return null;
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, totalTokens: u.total_tokens };
}
function toolCalls(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1) throw invalid();
  return value.map(call => {
    if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 180
      || !call.function || call.function.name !== 'calculateTargetHealth' || typeof call.function.arguments !== 'string'
      || call.function.arguments.length > 1000) throw invalid();
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { throw invalid(); }
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 2
      || Object.keys(args).some(key => !['market', 'targetHealth'].includes(key)) || typeof args.market !== 'string'
      || !args.market.trim() || args.market.length > 180 || !Number.isFinite(args.targetHealth) || args.targetHealth < 1 || args.targetHealth > 100)
      throw invalid();
    return { id: call.id, name: 'calculateTargetHealth', arguments: args };
  });
}
export function normalizeAgentModelResponse(value, response) {
  trustedProfile(value);
  let content, calls = [], finishReason = null;
  if (response && typeof response === 'object' && Object.hasOwn(response, 'choices')) {
    if (!Array.isArray(response.choices) || response.choices.length !== 1 || Object.hasOwn(response, 'response')) throw invalid();
    const choice = response.choices[0], message = choice?.message;
    if (!message || message.role !== 'assistant' || typeof choice.finish_reason !== 'string') throw invalid();
    finishReason = choice.finish_reason;
    if (!['stop', 'tool_calls'].includes(finishReason) || message.refusal) throw invalid();
    calls = toolCalls(message.tool_calls);
    if ((finishReason === 'tool_calls') !== !!calls.length) throw invalid();
    content = message.content;
    if (calls.length && content != null && content !== '') throw invalid();
    if (!calls.length && typeof content !== 'string') throw invalid();
    // reasoning_content, logprobs and provider annotations never become answers.
  } else {
    // The generic Workers AI JSON-mode binding response is documented separately
    // from its OpenAI-compatible completion envelope.
    content = typeof response === 'string' ? response : response?.response;
    if (response && typeof response === 'object' && response.tool_calls) throw invalid();
    if (response && typeof response === 'object' && Object.hasOwn(response, 'finish_reason')) {
      if (response.finish_reason !== 'stop') throw invalid();
      finishReason = 'stop';
    }
  }
  if (calls.length) return { content: null, toolCalls: calls, finishReason, usage: readAgentModelUsage(response) };
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    try { content = JSON.stringify(content); } catch { throw invalid(); }
  }
  if (typeof content !== 'string' || !content.trim() || content.length > 16000 || /<\/?(?:think|analysis)>/i.test(content)) throw invalid();
  return { content, toolCalls: [], finishReason, usage: readAgentModelUsage(response) };
}
