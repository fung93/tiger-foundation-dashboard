/* The first-party agent relay is private, bounded and pinned to one free Worker. */
import assert from 'node:assert/strict';
import { forwardAgentRequest } from '../api/_agent-gateway.mjs';

let checks = 0;
const check = (a, b, note) => { assert.deepEqual(a, b, note); checks++; };
const rejects = async (fn, note) => { await assert.rejects(fn, note); checks++; };
const env = { AGENT_WORKER_URL: 'https://fixture.workers.dev', AGENT_GATEWAY_SECRET: 'fixture-private-gateway-secret' };
const token = 'a'.repeat(64), cookie = 'tiger_agent_session=' + token;
const req = { method: 'POST', url: '/api/agent', headers: { origin: 'https://dashboard.test', 'content-type': 'application/json',
  cookie: 'unrelated_private_cookie=keep-out; ' + cookie, 'sec-fetch-site': 'same-origin', 'x-untrusted-secret': 'do-not-forward' },
  body: { action: 'status' } };
function response() { return { headers: {}, statusCode: null, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, end(text) { this.body = JSON.parse(text); } }; }
const ok = (value, headers = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const old = globalThis.fetch;
globalThis.fetch = () => { throw Error('Gateway tests must never contact a real worker'); };
try {
  let called = 0;
  const fetcher = async (url, init) => {
    called++;
    check(url, env.AGENT_WORKER_URL + '/api/agent', 'Only the configured Worker origin receives traffic');
    check(init.redirect, 'error', 'A redirect cannot forward private headers to another host');
    check(init.cache, 'no-store', 'Proxy traffic opts out of caching');
    check(init.headers['x-agent-gateway-secret'], env.AGENT_GATEWAY_SECRET, 'The gateway secret stays server-side');
    check(init.headers.cookie, cookie, 'Only the agent session cookie reaches the Worker');
    check(init.headers['x-untrusted-secret'], undefined, 'Unrelated incoming headers are not forwarded');
    check(init.headers.origin, req.headers.origin, 'The real browser origin reaches the CSRF check unchanged');
    return ok({ configured: true, authenticated: true }, { 'set-cookie': cookie + '; HttpOnly; Secure; SameSite=Strict; Path=/api' });
  };
  let res = response();
  check(await forwardAgentRequest(req, res, { env, fetcher }), true, 'Configured requests use the free Worker');
  check(res.body.authenticated, true, 'Worker JSON reaches the dashboard');
  check(res.headers['set-cookie'].startsWith(cookie), true, 'A secure first-party session is preserved');
  check(res.headers['cache-control'].includes('no-store'), true, 'Private replies cannot be cached');
  check(JSON.stringify(res).includes(env.AGENT_GATEWAY_SECRET), false, 'The gateway secret is never returned');
  check(await forwardAgentRequest(req, response(), { env: {}, fetcher }), false, 'Missing Worker configuration uses the honest setup state');
  check(await forwardAgentRequest(req, response(), { env: { ...env, AGENT_DB: { prepare() {} } }, fetcher }), false, 'Native Worker execution cannot loop through its own relay');
  check(called, 1, 'Unconfigured/native-worker paths make no provider request');
  check(await forwardAgentRequest({ ...req, url: '/api/not-an-agent' }, response(), { env, fetcher }), false, 'The relay cannot fetch arbitrary API routes');
  for (const url of ['http://unsafe.test', 'https://user:secret@unsafe.test', 'https://fixture.workers.dev/path', 'https://fixture.workers.dev/?backend=other'])
    await rejects(() => forwardAgentRequest(req, response(), { env: { ...env, AGENT_WORKER_URL: url }, fetcher }), 'Unsafe backend URL forms are rejected');
  await rejects(() => forwardAgentRequest(req, response(), { env: { ...env, AGENT_GATEWAY_SECRET: 'short' }, fetcher }), 'Weak gateway secrets are rejected');
  let cancelled = false;
  const large = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(200001)); }, cancel() { cancelled = true; } });
  await rejects(() => forwardAgentRequest(req, response(), { env, fetcher: async () => new Response(large) }), 'Chunked responses are bounded before JSON parsing');
  check(cancelled, true, 'Oversized upstream response bodies are cancelled');
  for (const badCookie of ['another_session=secret; HttpOnly; Secure; SameSite=Strict; Path=/api', cookie + '; HttpOnly; SameSite=Strict; Path=/api',
    cookie + '; HttpOnly; Secure; SameSite=Strict; Path=/api; Domain=dashboard.test']) {
    res = response(); await forwardAgentRequest(req, res, { env, fetcher: async () => ok({}, { 'set-cookie': badCookie }) });
    check(res.headers['set-cookie'], undefined, 'Unsafe or unrelated upstream cookies are not exposed');
  }
  let signal;
  await rejects(() => forwardAgentRequest(req, response(), { env, timeoutMs: 5, fetcher: async (_url, init) => {
    signal = init.signal; return { status: 200, headers: new Headers(), json: () => new Promise(() => {}) };
  } }), 'A stalled body is covered by the whole relay deadline');
  check(signal.aborted, true, 'A timed-out relay aborts its upstream request');
  console.log('Free agent gateway: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = old; }
