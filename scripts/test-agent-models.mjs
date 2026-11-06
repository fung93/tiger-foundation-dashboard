/* Verified provider envelopes and profile boundaries, without real inference. */
import assert from 'node:assert/strict';
import { AGENT_OUTPUT_SCHEMA } from '../api/_agent-output-schema.mjs';
import { DEFAULT_AGENT_MODEL, AGENT_MODEL_PROFILES, getAgentModelProfile, createAgentModelRequest,
  normalizeAgentModelResponse, readAgentModelUsage, estimateAgentModelCost } from '../api/_agent-models.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const rejects = (fn, category, note) => { assert.throws(fn, error => error.category === category, note); checks++; };
const content = JSON.stringify({ reply: 'Verified facts only.', preferenceChanges: [] });
const usage = { prompt_tokens: 4000, completion_tokens: 1000, total_tokens: 5000 };
const completion = (message = { role: 'assistant', content }, reason = 'stop') => ({ choices: [{ index: 0, message, finish_reason: reason }], usage });
check(getAgentModelProfile().id, '@cf/qwen/qwen3-30b-a3b-fp8', 'Evaluate Qwen first, rather than a retired fallback');
check(estimateAgentModelCost(getAgentModelProfile(), 4000, 1000), 48.975, 'Neuron planning matches the documented Qwen example');
for (const profile of Object.values(AGENT_MODEL_PROFILES)) {
  check(getAgentModelProfile({ AGENT_MODEL: profile.id }), profile, 'Only registered exact model identifiers select a profile');
  check(profile.verifiedAt, '2026-11-05', 'Profile schema and rates have an explicit verification date');
  check(profile.verification.includes('live_account_unverified'), true, 'A fixture benchmark never claims real account access');
  check(profile.maxOutputTokens, 800, 'Every profile keeps the existing output cap');
  const request = createAgentModelRequest(profile, [{ role: 'user', content: 'Hello' }]);
  check(request.response_format, { type: 'json_schema', json_schema: AGENT_OUTPUT_SCHEMA }, 'The binding receives the direct Cloudflare planning schema');
  check(request.stream, false, 'Streaming and unbounded partial output are disabled');
  check(Object.hasOwn(request,'tools'), false, 'Native tools do not compete with the closed JSON planning schema');
  const normalized = normalizeAgentModelResponse(profile, completion());
  check(normalized, { content, toolCalls: [], finishReason: 'stop', usage: { inputTokens: 4000, outputTokens: 1000, totalTokens: 5000 } },
    'Documented completion envelopes preserve final content, finish reason and usage');
  const withReasoning = completion({ role: 'assistant', content, reasoning_content: 'PRIVATE REASONING' });
  check(JSON.stringify(normalizeAgentModelResponse(profile, withReasoning)).includes('PRIVATE REASONING'), false, 'Reasoning traces never reach normalized answers');
  for (const response of [content, { response: content }, { response: JSON.parse(content) }]) {
    check(normalizeAgentModelResponse(profile, response).content, content, 'Documented Workers JSON mode and legacy binding text share strict downstream validation');
  }
  for (const alias of [undefined,null,'','  ',content,JSON.parse(content),JSON.stringify({preferenceChanges:[],reply:'Verified facts only.'})]) {
    const dual={...completion(),response:alias,tool_calls:[]};
    check(normalizeAgentModelResponse(profile,dual).content,content,'Matching or empty legacy aliases do not invalidate one completed choice');
  }
  check(normalizeAgentModelResponse(profile,completion({role:'assistant',content:JSON.parse(content),tool_calls:null})).content,content,
    'Structured JSON completion content and nullable tool metadata use the same final selector');
  check(normalizeAgentModelResponse(profile,{response:content,tool_calls:[]}).content,content,'An empty Workers tool list contains no competing request');
  const selector=JSON.stringify({tool:{name:'getLendingRisk',args:{}}});
  const hybrid={choices:[{message:{role:'assistant',content:selector,reasoning_content:'PRIVATE_THOUGHTS',tool_calls:[]},finish_reason:'stop'}],
    response:JSON.parse(selector),tool_calls:[],usage:{prompt_tokens:6097,completion_tokens:83,total_tokens:6180}};
  const final=normalizeAgentModelResponse(profile,hybrid);
  check(final.content,selector,'A hybrid wrapper with the owner-observed metadata admits its single final JSON action');
  check(JSON.stringify(final).includes('PRIVATE_THOUGHTS'),false,'Accepting compatibility aliases does not expose separate reasoning');
  check(final.usage.outputTokens,83,'Hybrid normalization preserves usage for the shared inference ledger');
  for(const [response,reason] of [
    [{...hybrid,response:{tool:{name:'getPortfolioSnapshot',args:{}}}},'conflicting_envelope'],
    [{choices:[]},'invalid_choice_count'],
    [completion({content}),'invalid_message_role'],
    [completion({role:'assistant',content,refusal:'PRIVATE_PROVIDER_REFUSAL'}),'model_refusal'],
    [completion({role:'assistant',content,tool_calls:{}}),'invalid_tool_metadata'],
  ]) {
    assert.throws(()=>normalizeAgentModelResponse(profile,response),error=>error.category==='invalid_model_output'&&error.modelOutputReason===reason);checks++;
  }
  const tool = { id: 'call_fixture', type: 'function', function: { name: 'calculateTargetHealth', arguments: JSON.stringify({ market: 'avkat-kat', targetHealth: 1.5 }) } };
  const called = normalizeAgentModelResponse(profile, completion({ role: 'assistant', content: null, tool_calls: [tool] }, 'tool_calls'));
  check(called.toolCalls, [{ id: 'call_fixture', name: 'calculateTargetHealth', arguments: { market: 'avkat-kat', targetHealth: 1.5 } }], 'Only verified argument units and keys can invoke the lending tool');
  check(called.content, null, 'Tool requests do not masquerade as financial answers');
  for (const response of [
    completion(undefined, 'length'), completion(undefined, 'content_filter'),
    { choices: [] }, { choices: [completion().choices[0], completion().choices[0]] },
    completion({ role: 'assistant', content: [{ type: 'text', text: content }] }),
    completion({ role: 'assistant', content: '<think>PRIVATE</think>' + content }),
    completion({ role: 'assistant', content, refusal: 'Refused' }),
    completion({ role: 'assistant', content: null, tool_calls: [{ ...tool, function: { name: 'sendTransaction', arguments: '{}' } }] }, 'tool_calls'),
    completion({ role: 'assistant', content: null, tool_calls: [{ ...tool, function: { name: 'calculateTargetHealth', arguments: '{' } }] }, 'tool_calls'),
    completion({ role: 'assistant', content: null, tool_calls: [{ ...tool, function: { name: 'calculateTargetHealth', arguments: '{"market":"avkat-kat","targetHealth":0.5}' } }] }, 'tool_calls'),
    completion({ role: 'assistant', content: null, tool_calls: [{ ...tool, function: { name: 'calculateTargetHealth', arguments: '{"market":"avkat-kat","targetHealth":1.5,"formula":"eval"}' } }] }, 'tool_calls'),
    completion({ role: 'assistant', content, tool_calls: [tool] }, 'tool_calls'),
    completion({ role: 'assistant', content: null, tool_calls: [tool, tool] }, 'tool_calls'),
    completion({ role: 'assistant', content, tool_calls: [tool] }, 'stop'),
    { ...completion(), response: JSON.stringify({reply:'Different answer',preferenceChanges:[]}) },
    { ...completion(), response: JSON.parse(content), tool_calls:[tool] },
    { ...completion(), response: JSON.parse(content), tool_calls:{} },
    { response:content,tool_calls:[tool] },{response:content,tool_calls:false},
    { ...hybrid, response:{tool:{name:'getPortfolioSnapshot',args:{}}} },
    { ...hybrid, choices:[{...hybrid.choices[0],finish_reason:'length'}] },
    { response: [] }, { response: 'x'.repeat(16001) }, { response: content, finish_reason: 'length' },
  ]) rejects(() => normalizeAgentModelResponse(profile, response), 'invalid_model_output', 'Truncated, unsupported, ambiguous and unauthorized output fails closed');
}
for (const id of ['@cf/meta/llama-3.1-8b-instruct', '@cf/deepseek-ai/deepseek-v4-pro-0813', '@cf/qwen/unknown', 'https://provider.test', '__proto__'])
  rejects(() => getAgentModelProfile({ AGENT_MODEL: id }), id.includes('llama-3.1') ? 'model_unavailable' : 'configuration_missing', 'No wildcard or automatic paid fallback can enable an unverified model');
check(readAgentModelUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 4 } }), null, 'Inconsistent provider usage cannot lower the conservative reservation');
check(readAgentModelUsage({ usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 } }), null, 'Invalid provider usage is ignored');
check(readAgentModelUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 } } }),
  { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, 'Reasoning tokens are already included in billed completion usage');
rejects(() => createAgentModelRequest({ ...getAgentModelProfile() }, [{ role: 'user', content: 'Hello' }]), 'configuration_missing', 'A forged profile cannot replace pricing or provider permissions');
rejects(() => estimateAgentModelCost(getAgentModelProfile(), Infinity, 1), 'configuration_missing', 'Invalid token estimates cannot reach usage accounting');
console.log('Agent model profiles and normalization: ' + checks + ' assertions passed.');
