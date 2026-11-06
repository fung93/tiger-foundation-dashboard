/* Content-free model metadata only. Rebuild this record before storing or exposing
   it; provider strings, object keys, arguments and errors are never copied. */
export const AGENT_OUTPUT_DIAGNOSTIC_SCHEMA = 'agent-output-diagnostics-v1';
const stages = new Set(['normalize', 'parse', 'validate', 'render', 'accepted', 'unknown']);
const reasons = new Set(['truncated', 'invalid_envelope', 'reasoning_in_content', 'invalid_json',
  'invalid_selector', 'unapproved_reply', 'valid_selector', 'unknown']);
const envelopes = new Set(['chat_completion', 'workers_json', 'workers_native_tools', 'text', 'ambiguous', 'unknown']);
const finishes = new Set(['stop', 'tool_calls', 'length', 'max_tokens', 'content_filter', 'other']);
const types = new Set(['missing', 'null', 'string', 'object', 'array', 'number', 'boolean', 'other']);
const shapes = new Set(['object', 'array', 'string', 'number', 'boolean', 'null', 'invalid', 'not_present', 'too_large', 'unknown']);
const MAX_CONTENT_CHARACTERS = 16001, MAX_COUNT = 2, MAX_TOKENS = 1000000;

// Read only own data properties. A malformed binding object must not cause this
// diagnostic helper to execute accessors or stringify an arbitrary object.
function own(value, key) {
  try { return value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; }
  catch { return undefined; }
}
function has(value, key) {
  try { return !!value && typeof value === 'object' && Object.hasOwn(value, key); }
  catch { return false; }
}
function array(value) { try { return Array.isArray(value); } catch { return false; } }
function record(value) { return !!value && typeof value === 'object' && !array(value); }
function kind(value, present = true) {
  if (!present || value === undefined) return 'missing';
  if (value === null) return 'null';
  if (array(value)) return 'array';
  return types.has(typeof value) ? typeof value : 'other';
}
function integer(value, max) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function count(value) {
  if (value === undefined) return 0;
  const length = array(value) ? own(value, 'length') : null;
  return integer(length, Number.MAX_SAFE_INTEGER) ? Math.min(length, MAX_COUNT) : null;
}
function finish(value) { return value === undefined || value === null ? null : finishes.has(value) ? value : 'other'; }
function usage(value, provider = false) {
  const inputTokens = own(value, provider ? 'prompt_tokens' : 'inputTokens');
  const outputTokens = own(value, provider ? 'completion_tokens' : 'outputTokens');
  const totalTokens = own(value, provider ? 'total_tokens' : 'totalTokens');
  return [inputTokens, outputTokens, totalTokens].every(n => integer(n, MAX_TOKENS))
    && totalTokens === inputTokens + outputTokens ? { inputTokens, outputTokens, totalTokens } : null;
}
function jsonShape(value) {
  if (value === undefined) return 'not_present';
  if (typeof value !== 'string') return ['object', 'array', 'number', 'boolean', 'null'].includes(kind(value)) ? kind(value) : 'unknown';
  if (value.length >= MAX_CONTENT_CHARACTERS) return 'too_large';
  const text = value.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  if (!text) return 'not_present';
  try { return kind(JSON.parse(text)); } catch { return 'invalid'; }
}
const reasoning = value => value !== undefined && value !== null && value !== '' && value !== false;
export const safeAgentOutputReason = value => reasons.has(value) ? value : 'unknown';

export function summarizeAgentModelOutput(response, options = {}) {
  let envelope = 'unknown', message, content, present = false, choiceCount = 0, nativeToolCount = 0, finishReason = null;
  const choices = own(response, 'choices'), native = own(response, 'tool_calls');
  if (typeof response === 'string') { envelope = 'text'; content = response; present = true; }
  else if (has(response, 'choices')) {
    envelope = has(response, 'response') || has(response, 'tool_calls') ? 'ambiguous' : 'chat_completion';
    choiceCount = count(choices);
    message = own(own(choices, '0'), 'message');
    content = own(message, 'content'); present = has(message, 'content');
    finishReason = finish(own(own(choices, '0'), 'finish_reason'));
    nativeToolCount = count(own(message, 'tool_calls'));
  } else if (record(response)) {
    envelope = has(response, 'tool_calls') ? 'workers_native_tools' : has(response, 'response') ? 'workers_json' : 'unknown';
    content = own(response, 'response'); present = has(response, 'response');
    finishReason = finish(own(response, 'finish_reason'));
    nativeToolCount = count(native);
  }
  const stage = own(options, 'stage');
  const result = { schemaVersion: AGENT_OUTPUT_DIAGNOSTIC_SCHEMA,
    stage: stages.has(stage) ? stage : 'unknown',
    reason: safeAgentOutputReason(own(options, 'reason')), envelope, finishReason, choiceCount,
    contentType: kind(content, present), contentCharacters: typeof content === 'string' ? Math.min(content.length, MAX_CONTENT_CHARACTERS) : null,
    jsonShape: jsonShape(content),
    hasReasoning: reasoning(own(response, 'reasoning_content')) || reasoning(own(response, 'reasoning'))
      || reasoning(own(message, 'reasoning_content')) || reasoning(own(message, 'reasoning'))
      || typeof content === 'string' && /<\/?(?:think|analysis)>/i.test(content),
    nativeToolCount, usage: usage(own(response, 'usage'), true) };
  return safeAgentOutputDiagnostic(result);
}

// The private store is not a reason to trust extra fields or provider-controlled
// enum values. Return a fresh bounded record; callers add their own timestamp.
export function safeAgentOutputDiagnostic(value) {
  if (!record(value) || own(value, 'schemaVersion') !== AGENT_OUTPUT_DIAGNOSTIC_SCHEMA) return null;
  const field = (key, allowed, fallback) => { const item = own(value, key); return allowed.has(item) ? item : fallback; };
  const bounded = (key, max) => { const item = own(value, key); return integer(item, max) ? item : null; };
  const finishReason = own(value, 'finishReason');
  return { schemaVersion: AGENT_OUTPUT_DIAGNOSTIC_SCHEMA, stage: field('stage', stages, 'unknown'),
    reason: safeAgentOutputReason(own(value, 'reason')), envelope: field('envelope', envelopes, 'unknown'),
    finishReason: finishReason === null ? null : finishes.has(finishReason) ? finishReason : 'other',
    choiceCount: bounded('choiceCount', MAX_COUNT),
    contentType: field('contentType', types, 'other'),
    contentCharacters: bounded('contentCharacters', MAX_CONTENT_CHARACTERS),
    jsonShape: field('jsonShape', shapes, 'unknown'), hasReasoning: own(value, 'hasReasoning') === true,
    nativeToolCount: bounded('nativeToolCount', MAX_COUNT),
    usage: usage(own(value, 'usage')) };
}
