/* Owner-requested remote MCP, server side only. The model never receives an
   arbitrary remote tool, URL, credentials or authority to execute transactions. */
import { createHash } from 'node:crypto';
import { inspectKatanaMCPResult } from './_agent-katana-mcp-format.mjs';

export const KATANA_MCP_URL = 'https://mcp.katana.network/mcp';
export const KATANA_MCP_SCHEMA = 'katana-mcp-v3';
// This exact read tool was already used and documented in AGENTS.md (1 Nov).
// A discovered tool's description/readOnlyHint does not authorize new tools.
export const KATANA_MCP_READ_TOOLS = Object.freeze(['get_kat_gauges']);
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BYTES = 131072;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = category => { throw Object.assign(new Error('Katana MCP reading unavailable.'), { category }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const clean = (value, max = 100) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null;
export const katanaMCPEnabled = env => env?.AGENT_KATANA_MCP_ENABLED === 'true';

async function boundedBody(response, signal, requestId) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) fail('response_too_large');
  if (response.body === null) return '';
  if (!response.body?.getReader) fail('invalid_response');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '',chunks=0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      if(++chunks>256)fail('response_too_large');
      bytes += next.value.byteLength;
      if (bytes > MAX_BYTES) fail('response_too_large');
      text += decoder.decode(next.value, { stream: true });
      // A streamable-HTTP POST can finish its JSON-RPC result while the SSE
      // connection remains open. Stop after a complete result, not after EOF.
      if(requestId!==undefined&&/^text\/event-stream\b/i.test(response.headers.get('content-type')||'')){
        const normalized=text.replaceAll('\r\n','\n'),end=normalized.lastIndexOf('\n\n');
        if(end>=0){const complete=normalized.slice(0,end+2),events=complete.split(/\n\n+/).filter(part=>/^data:/m.test(part));
          if(events.length>20)fail('invalid_response');
          for(const event of events){
            let row;try{row=JSON.parse(event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n'));}catch{fail('invalid_response');}
            if(object(row)&&Object.hasOwn(row,'id')){rpcResult(complete,'text/event-stream',requestId);return complete;}
          }
        }
      }
    }
    return text + decoder.decode();
  } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function rpcResult(text, contentType, id) {
  let messages;
  try {
    if (/^text\/event-stream\b/i.test(contentType)) {
      messages = text.replaceAll('\r\n', '\n').split(/\n\n+/).filter(part => /^data:/m.test(part)).map(part => {
        const data = part.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        return JSON.parse(data);
      });
    } else if (/^application\/json\b/i.test(contentType)) messages = [JSON.parse(text)];
    else fail('unsupported_transport');
  } catch (error) { if (error.category) throw error; fail('invalid_response'); }
  if (!messages.length || messages.length > 20 || messages.some(row => !object(row) || row.jsonrpc !== '2.0'
    || row.method && Object.hasOwn(row, 'id'))) fail('invalid_response');
  const replies = messages.filter(row => Object.hasOwn(row, 'id'));
  if (replies.length !== 1 || replies[0].id !== id || replies[0].error || !object(replies[0].result)) fail('rpc_error');
  return replies[0].result;
}

export async function readKatanaMCP({ env = {}, fetcher = fetch, now = Date.now, timeoutMs = 4500 } = {}) {
  const clock = () => typeof now === 'function' ? now() : now;
  const base = { schemaVersion: KATANA_MCP_SCHEMA, endpoint: KATANA_MCP_URL,
    checkedAt: new Date(clock()).toISOString(), status: 'disabled', calls: 0,
    availableToolCount: 0, readOnlyTools: [], gauges: [], evidence: null, responseFormat:null,errorCategory: null,
    authority: 'Supplemental indexed reference; existing chain and Merkl observations take priority.' };
  if (!katanaMCPEnabled(env)) return base;
  const controller = new AbortController(); let timer, session, version, id = 0;
  const run = async () => {
    const request = async (method, params, notification = false) => {
      if (controller.signal.aborted) fail('timeout');
      const requestId = notification ? undefined : ++id;
      base.calls++;
      if (base.calls > 4) fail('request_budget');
      const response = await fetcher(KATANA_MCP_URL, { method: 'POST', redirect: 'manual', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(session ? { 'mcp-session-id': session } : {}), ...(version ? { 'mcp-protocol-version': version } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, ...(params ? { params } : {}) }) });
      if (controller.signal.aborted) fail('timeout');
      if (response.redirected || response.url && response.url !== KATANA_MCP_URL) fail('redirect_rejected');
      if (!response.ok) fail(response.status === 429 ? 'rate_limited' : response.status >= 300 && response.status < 400 ? 'redirect_rejected' : 'http_' + response.status);
      if (method === 'initialize') {
        const value = response.headers.get('mcp-session-id');
        if (value && (value.length > 200 || /[^\x21-\x7e]/.test(value))) fail('invalid_session');
        session = value || null;
      }
      const text = await boundedBody(response, controller.signal,requestId);
      if (notification) { if (text.trim() && response.status !== 202 && response.status !== 204) fail('invalid_notification_response'); return; }
      return rpcResult(text, response.headers.get('content-type') || '', requestId);
    };
    const init = await request('initialize', { protocolVersion: VERSIONS[0], capabilities: {},
      clientInfo: { name: 'tiger-foundation-readonly', version: '1.0.0' } });
    if (!VERSIONS.includes(init.protocolVersion) || !object(init.capabilities?.tools)) fail('unsupported_protocol');
    version = init.protocolVersion;
    await request('notifications/initialized', null, true);
    const catalog = await request('tools/list');
    if (!Array.isArray(catalog.tools) || catalog.tools.length > 128) fail('invalid_catalog');
    base.status = 'connected'; base.availableToolCount = catalog.tools.length;
    base.server = { name: clean(init.serverInfo?.name), version: clean(init.serverInfo?.version) };
    const tool = catalog.tools.find(row => KATANA_MCP_READ_TOOLS.includes(row?.name));
    if (!tool || catalog.tools.filter(row => row?.name === tool.name).length !== 1
      || tool.annotations?.destructiveHint === true || !object(tool.inputSchema) || tool.inputSchema.type !== 'object'
      || tool.inputSchema.required != null && (!Array.isArray(tool.inputSchema.required) || tool.inputSchema.required.length)) return base;
    base.readOnlyTools = [tool.name];
    const result = await request('tools/call', { name: tool.name, arguments: {} });
    if (result.isError === true) fail('tool_error');
    const raw = JSON.stringify(result);
    base.status = 'ready'; base.checkedAt = new Date(clock()).toISOString();
    const parsed=inspectKatanaMCPResult(result);
    base.gauges=parsed.gauges;base.responseFormat=parsed.format;
    if(parsed.format.reason==='tool_reported_error')return {...base,status:'unavailable',errorCategory:'tool_data_error'};
    base.evidence = { id: 'mcp:' + hash(raw), tool: tool.name, retrievedAt: base.checkedAt,
      sourceObservedAtVerified: false, source: KATANA_MCP_URL,
      contentHash: hash(raw), untrustedReference: true, parsedGaugeCount: base.gauges.length };
    return base;
  };
  try {
    return await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(), { category: 'timeout' })); }, Math.min(8000, Math.max(100, timeoutMs)));
    })]);
  } catch (error) {
    // Raw error text/URLs, session IDs, descriptions and server instructions are
    // never retained or sent to the model. Do not fail the first-party readers.
    return { ...base, status: 'unavailable', gauges: [], evidence: null,
      errorCategory: error.category || (controller.signal.aborted ? 'timeout' : 'transport') };
  } finally { clearTimeout(timer); controller.abort(); }
}

export function katanaMCPDiagnostic(reading, env = {}) {
  return { enabled: katanaMCPEnabled(env), endpoint: KATANA_MCP_URL,
    status: reading?.status || (katanaMCPEnabled(env) ? 'unverified' : 'disabled'),
    checkedAt: reading?.checkedAt || null, availableToolCount: reading?.availableToolCount || 0,
    readOnlyTools: (reading?.readOnlyTools || []).filter(name => KATANA_MCP_READ_TOOLS.includes(name)),
    parsedGaugeCount:reading?.evidence?.parsedGaugeCount??reading?.parsedGaugeCount??0,
    responseFormat:reading?.responseFormat||null,
    evidenceId: reading?.evidence?.id || reading?.evidenceId || null, errorCategory: reading?.errorCategory || null };
}
