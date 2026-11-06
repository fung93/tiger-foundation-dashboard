/* All provider data is a local fixture. No inference, storage or network calls. */
import assert from 'node:assert/strict';
import { AGENT_OUTPUT_DIAGNOSTIC_SCHEMA, summarizeAgentModelOutput, safeAgentOutputDiagnostic,
  safeAgentOutputReason } from '../api/_agent-output-diagnostics.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const PRIVATE = 'PRIVATE_PROMPT_PROSE_REASONING_SECRET_https://private.invalid';
const content = JSON.stringify({ explanationId: 'greeting', preferenceChanges: [] });
const completion = (text = content, finish_reason = 'stop') => ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason }] });
const diagnostic = (response, options) => {
  const before = structuredClone(response), result = summarizeAgentModelOutput(response, options);
  check(response, before, 'Summarizing provider metadata does not mutate its response');
  check(JSON.stringify(result).includes(PRIVATE), false, 'No private fixture text enters a diagnostic');
  return result;
};

const normal = diagnostic(completion(), { stage: 'accepted', reason: 'valid_selector' });
check(normal, { schemaVersion: AGENT_OUTPUT_DIAGNOSTIC_SCHEMA, stage: 'accepted', reason: 'valid_selector',
  envelope: 'chat_completion', finishReason: 'stop', choiceCount: 1, contentType: 'string', contentCharacters: content.length,
  jsonShape: 'object', hasReasoning: false, nativeToolCount: 0, usage: null }, 'A completed selector has a closed metadata contract');

const truncated = completion('', 'length');
truncated.choices[0].message.reasoning_content = PRIVATE;
truncated.usage = { prompt_tokens: 10, completion_tokens: 800, total_tokens: 810,
  completion_tokens_details: { reasoning_tokens: 799, [PRIVATE]: PRIVATE } };
let value = diagnostic(truncated, { stage: 'normalize', reason: 'truncated' });
check([value.finishReason, value.contentCharacters, value.jsonShape, value.hasReasoning], ['length', 0, 'not_present', true],
  'A length stop with reasoning and no answer remains distinguishable from invalid JSON');
check(value.usage, { inputTokens: 10, outputTokens: 800, totalTokens: 810 }, 'Only validated billed token counts survive');
check(diagnostic(completion('<think>' + PRIVATE + '</think>' + content), { stage: 'normalize', reason: 'reasoning_in_content' }).hasReasoning,
  true, 'Inline thinking is reported as a boolean without storing its text');

const native = { response: '', tool_calls: [{ name: PRIVATE, arguments: { [PRIVATE]: PRIVATE }, id: PRIVATE }], reasoning: PRIVATE };
value = diagnostic(native, { stage: 'normalize', reason: 'invalid_envelope' });
check([value.envelope, value.nativeToolCount, value.hasReasoning], ['workers_native_tools', 1, true], 'Workers native tools are distinct from JSON-mode content');
const openai = completion(null, 'tool_calls');
openai.choices[0].message.tool_calls = [{ id: PRIVATE, type: 'function', function: { name: PRIVATE, arguments: PRIVATE } }];
value = diagnostic(openai, { stage: 'normalize', reason: 'invalid_selector' });
check([value.envelope, value.nativeToolCount, value.finishReason, value.contentType], ['chat_completion', 1, 'tool_calls', 'null'],
  'OpenAI native envelopes remain identifiable without inspecting tool values');
check(diagnostic({ ...completion(), response: PRIVATE }).envelope, 'hybrid', 'Completion and legacy aliases are identifiable without recording their contents');
check(diagnostic({...completion(),tool_calls:[]}).envelope,'chat_completion','An empty root tool list is compatibility metadata rather than a second answer');
check(diagnostic({response:content,tool_calls:null}).nativeToolCount,0,'A null optional tool field contains no tool requests');
check(diagnostic({response:content,tool_calls:[]}).envelope,'workers_json','An empty optional tool list preserves JSON-mode envelope classification');
check(diagnostic({...completion(),tool_calls:[{name:PRIVATE}]}).envelope,'ambiguous','An additional real root tool request remains distinguishable from empty metadata');
check(safeAgentOutputReason('conflicting_envelope'),'conflicting_envelope','Conflicting aliases have an approved content-free reason');
check(diagnostic({ response: { [PRIVATE]: PRIVATE } }).jsonShape, 'object', 'Native JSON objects need no serialization or key copying');
check(diagnostic({ response: { [PRIVATE]: PRIVATE } }).contentCharacters, null, 'Object content is not stringified for a size estimate');
check(diagnostic({ response: '{"private":"' + PRIVATE }).jsonShape, 'invalid', 'Malformed JSON exposes its shape only');
check(diagnostic(content).envelope, 'text', 'Legacy response text is distinguishable from binding envelopes');

for (const [response, shape] of [[{ response: [] }, 'array'], [{ response: '[]' }, 'array'], [{ response: 'null' }, 'null'],
  [{ response: '"' + PRIVATE + '"' }, 'string'], [{ response: '42' }, 'number'], [{ response: 'false' }, 'boolean'],
  [{ response: '```json\n' + content + '\n```' }, 'object'], [null, 'not_present']])
  check(diagnostic(response).jsonShape, shape, 'JSON top-level shape uses fixed labels');
value = diagnostic({ response: PRIVATE.repeat(1000) });
check([value.contentCharacters, value.jsonShape], [16001, 'too_large'], 'Oversized strings have bounded metadata and are not parsed');
value = diagnostic({ choices: Array.from({ length: 20 }, () => ({ message: { content, tool_calls: Array(20).fill(PRIVATE) }, finish_reason: PRIVATE })) });
check([value.choiceCount, value.nativeToolCount, value.finishReason], [2, 2, 'other'], 'Counts saturate at two and unknown finish strings are never copied');
value = diagnostic({ choices: PRIVATE });
check(value.choiceCount, null, 'Malformed choices do not become a misleading array count');
check(diagnostic({ response: content, tool_calls: PRIVATE }).nativeToolCount, null, 'Malformed native tools are distinct from absent tools');
for (const invalidUsage of [
  { prompt_tokens: 1, completion_tokens: 2, total_tokens: 4 },
  { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
  { prompt_tokens: 1, completion_tokens: Infinity, total_tokens: Infinity },
  { prompt_tokens: PRIVATE, completion_tokens: 2, total_tokens: 3 },
  { prompt_tokens: 1000001, completion_tokens: 0, total_tokens: 1000001 },
]) check(diagnostic({ response: content, usage: invalidUsage }).usage, null, 'Invalid usage is discarded rather than copied or inferred');

const poisoned = Object.fromEntries(Object.keys(normal).map(key => [key, PRIVATE]));
poisoned.schemaVersion = AGENT_OUTPUT_DIAGNOSTIC_SCHEMA;
poisoned[PRIVATE] = PRIVATE;
poisoned.error = { message: PRIVATE, stack: PRIVATE };
poisoned.usage = { inputTokens: PRIVATE, outputTokens: 1, totalTokens: 2, [PRIVATE]: PRIVATE };
value = safeAgentOutputDiagnostic(poisoned);
check(JSON.stringify(value).includes(PRIVATE), false, 'Every persisted field is sanitized, including fields already bearing the schema version');
check(Object.keys(value), Object.keys(normal), 'Extra keys and provider errors are never exposed');
check(safeAgentOutputDiagnostic({ schemaVersion: PRIVATE }), null, 'An unrecognized record is not exposed');
check(safeAgentOutputDiagnostic(PRIVATE), null, 'Arbitrary stored strings are not diagnostics');
check(safeAgentOutputReason(PRIVATE), 'unknown', 'Only fixed safe reason labels are accepted');
check(safeAgentOutputDiagnostic(normal), normal, 'Sanitizing valid metadata preserves the contract');
check(safeAgentOutputDiagnostic({ ...normal, choiceCount: 3, nativeToolCount: -1, contentCharacters: 16002,
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 4 } }),
  { ...normal, choiceCount: null, nativeToolCount: null, contentCharacters: null, usage: null }, 'Stored numeric bounds are checked again on exposure');

let accessorCalls = 0;
const accessor = { get response() { accessorCalls++; throw Error(PRIVATE); }, get usage() { accessorCalls++; throw Error(PRIVATE); },
  get reasoning_content() { accessorCalls++; throw Error(PRIVATE); }, toJSON() { accessorCalls++; throw Error(PRIVATE); } };
value = summarizeAgentModelOutput(accessor, { get stage() { accessorCalls++; return PRIVATE; }, get reason() { accessorCalls++; return PRIVATE; } });
check(accessorCalls, 0, 'Provider and option accessors and object serializers are not executed');
check([value.contentType, value.reason, value.stage], ['missing', 'unknown', 'unknown'], 'Unreadable properties stay content free');
const inherited = Object.create({ response: PRIVATE, usage: truncated.usage, reasoning_content: PRIVATE });
check(summarizeAgentModelOutput(inherited).envelope, 'unknown', 'Inherited provider properties do not become trusted metadata');
const frozen = Object.freeze({ response: Object.freeze({ explanationId: 'greeting', preferenceChanges: Object.freeze([]) }) });
check(summarizeAgentModelOutput(frozen).jsonShape, 'object', 'Frozen response objects can be inspected without writes');
const reads = new Map();
const changing = new Proxy(normal, { getOwnPropertyDescriptor(target, key) {
  const read = (reads.get(key) || 0) + 1; reads.set(key, read);
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && read > 1 ? { ...descriptor, value: PRIVATE } : descriptor;
} });
check(safeAgentOutputDiagnostic(changing), normal, 'Every persisted field is read once before it is validated and returned');
let coercions = 0;
const unusualChoices = new Proxy([], { getOwnPropertyDescriptor(target, key) {
  if (key === 'length') return { ...Object.getOwnPropertyDescriptor(target, key), value: { valueOf() { coercions++; throw Error(PRIVATE); } } };
  return Object.getOwnPropertyDescriptor(target, key);
} });
check(summarizeAgentModelOutput({ choices: unusualChoices }).choiceCount, null, 'Untrusted array lengths are validated before arithmetic');
check(coercions, 0, 'Malformed counts cannot invoke provider coercion methods');
console.log('Agent output diagnostics: ' + checks + ' assertions passed.');
