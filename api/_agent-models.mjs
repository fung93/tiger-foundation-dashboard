/* Explicit Workers AI profiles; no family wildcards, paid gateway or auto fallback.
   Catalog/schema and neuron rates checked against Cloudflare's official docs
   repository on 2026-11-07. Account access still needs the live release gate. */
import { httpError } from './_agent-http.mjs';
import { AGENT_OUTPUT_SCHEMA, AGENT_OUTPUT_SCHEMA_VERSION } from './_agent-output-schema.mjs';
import { AGENT_REVIEW_OUTPUT_SCHEMA } from './_agent-review-schema.mjs';

export const DEFAULT_AGENT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const AGENT_MODEL_SCHEMA_VERSION = 'agent-model-v5';
const VERIFIED_AT = '2026-11-07';
const CATALOG = 'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models/';
const PRICING = 'https://developers.cloudflare.com/workers-ai/platform/pricing/';
const profile = (id, contextTokens, inputNeuronsPerMillion, outputNeuronsPerMillion) => Object.freeze({
  id, version: id.split('/').at(-1) + (id === DEFAULT_AGENT_MODEL ? ':2026-11-06:v3' : ':2026-11-07:v4'), verifiedAt: VERIFIED_AT,
  verification: 'official_schema_and_pricing; live_account_unverified', freeCompatible: true,
  contextTokens, maxInputTokens: Math.min(30000, contextTokens - 800), maxOutputTokens: 800,
  requestFormat: 'workers-ai-messages', responseFormat: 'json_schema', outputSchemaVersion: AGENT_OUTPUT_SCHEMA_VERSION,
  responseShapes: Object.freeze(['chat-completion', 'workers-json']), tools: Object.freeze([]),
  thinkingHint: id === DEFAULT_AGENT_MODEL ? '/no_think' : null,
  jsonSchemaFormat: id === DEFAULT_AGENT_MODEL ? 'direct' : 'named',
  outputTokenParameter: id === DEFAULT_AGENT_MODEL ? 'max_tokens' : 'max_completion_tokens',
  plannedDeprecationDate: id === DEFAULT_AGENT_MODEL ? '2026-11-20' : null,
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
export function createAgentModelRequest(value, messages, { purpose = 'chat' } = {}) {
  const p = trustedProfile(value);
  if (!Array.isArray(messages) || !messages.length || messages.length > 12 || messages.some(row => !row
    || !['system', 'user', 'assistant', 'tool'].includes(row.role) || typeof row.content !== 'string'))
    throw agentModelError('configuration_missing', 'The AI request could not be verified.');
  if (!['chat', 'portfolio_review'].includes(purpose)) throw agentModelError('configuration_missing', 'The AI request purpose could not be verified.');
  const schema = purpose === 'portfolio_review' ? AGENT_REVIEW_OUTPUT_SCHEMA : AGENT_OUTPUT_SCHEMA;
  // These bindings use different documented JSON-schema envelopes. GLM also
  // exposes an explicit thinking switch; Qwen has only its prompt hint here.
  return { messages, [p.outputTokenParameter]: p.maxOutputTokens, temperature: .1, stream: false,
    ...(p.jsonSchemaFormat === 'named' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    response_format: { type: p.responseFormat, json_schema: p.jsonSchemaFormat === 'named'
      ? { name: purpose === 'portfolio_review' ? 'tiger_portfolio_review' : 'tiger_agent_selection', schema, strict: true } : schema } };
}
const invalid = (reason = 'invalid_envelope') => Object.assign(agentModelError('invalid_model_output', 'The AI answer was incomplete. Please try again.'), { modelOutputReason: reason });
export function readAgentModelUsage(response) {
  const u = response && typeof response === 'object' ? response.usage : null;
  if (!u || ![u.prompt_tokens, u.completion_tokens, u.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000)
    || u.total_tokens !== u.prompt_tokens + u.completion_tokens) return null;
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, totalTokens: u.total_tokens };
}
function toolCalls(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 1) throw invalid('invalid_tool_metadata');
  return value.map(call => {
    if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 180
      || !call.function || call.function.name !== 'calculateTargetHealth' || typeof call.function.arguments !== 'string'
      || call.function.arguments.length > 1000) throw invalid('invalid_tool_metadata');
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { throw invalid('invalid_tool_metadata'); }
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 2
      || Object.keys(args).some(key => !['market', 'targetHealth'].includes(key)) || typeof args.market !== 'string'
      || !args.market.trim() || args.market.length > 180 || !Number.isFinite(args.targetHealth) || args.targetHealth < 1 || args.targetHealth > 100)
      throw invalid('invalid_tool_metadata');
    return { id: call.id, name: 'calculateTargetHealth', arguments: args };
  });
}
const emptyAlias = value => value === undefined || value === null || typeof value === 'string' && !value.trim();
function emptyNativeTools(value) {
  return value === undefined || value === null || Array.isArray(value) && value.length === 0;
}
function finalText(value) {
  let text = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    try { text = JSON.stringify(value); } catch { throw invalid('unserializable_content'); }
  }
  if (typeof text !== 'string') throw invalid('invalid_content_type');
  if (!text.trim()) throw invalid('missing_final_content');
  if (text.length > 16000) throw invalid('content_too_large');
  return text;
}
function canonical(value, depth = 0) {
  if (depth > 16 || typeof value === 'number' && !Number.isFinite(value)) throw invalid();
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  return JSON.stringify(value);
}
function sameFinalContent(left, right) {
  try {
    const a = finalText(left).trim(), b = finalText(right).trim();
    if (a === b) return true;
    return canonical(JSON.parse(a)) === canonical(JSON.parse(b));
  } catch { return false; }
}
export function normalizeAgentModelResponse(value, response) {
  trustedProfile(value);
  let content, calls = [], finishReason = null;
  if (response && typeof response === 'object' && Object.hasOwn(response, 'choices')) {
    if (!Array.isArray(response.choices) || response.choices.length !== 1) throw invalid('invalid_choice_count');
    const choice = response.choices[0], message = choice?.message;
    if (!message || message.role !== 'assistant') throw invalid('invalid_message_role');
    if (typeof choice.finish_reason !== 'string') throw invalid('invalid_finish_reason');
    finishReason = choice.finish_reason;
    if (finishReason === 'length') throw invalid('truncated');
    if (!['stop', 'tool_calls'].includes(finishReason)) throw invalid('invalid_finish_reason');
    if (message.refusal) throw invalid('model_refusal');
    calls = toolCalls(message.tool_calls);
    if ((finishReason === 'tool_calls') !== !!calls.length) throw invalid('tool_finish_mismatch');
    content = message.content;
    // Workers AI can include its legacy response alias alongside the modern
    // completion. A duplicate is one answer; disagreeing aliases remain invalid.
    if (!emptyNativeTools(response.tool_calls)) throw invalid('conflicting_envelope');
    if (!emptyAlias(response.response) && (calls.length || !sameFinalContent(content, response.response)))
      throw invalid('conflicting_envelope');
    if (calls.length && content != null && content !== '') throw invalid('mixed_tool_content');
    if (!calls.length && typeof content !== 'string' && (!content || typeof content !== 'object' || Array.isArray(content))) throw invalid('invalid_content_type');
    // reasoning_content, logprobs and provider annotations never become answers.
  } else {
    // The generic Workers AI JSON-mode binding response is documented separately
    // from its OpenAI-compatible completion envelope.
    content = typeof response === 'string' ? response : response?.response;
    if (response && typeof response === 'object' && !emptyNativeTools(response.tool_calls)) throw invalid('conflicting_envelope');
    if (response && typeof response === 'object' && Object.hasOwn(response, 'finish_reason')) {
      if (response.finish_reason === 'length') throw invalid('truncated');
      if (response.finish_reason !== 'stop') throw invalid('invalid_finish_reason');
      finishReason = 'stop';
    }
  }
  if (calls.length) return { content: null, toolCalls: calls, finishReason, usage: readAgentModelUsage(response) };
  content = finalText(content);
  if (/<\/?(?:think|analysis)>/i.test(content)) throw invalid('reasoning_in_content');
  return { content, toolCalls: [], finishReason, usage: readAgentModelUsage(response) };
}
