/* First-party bridge to the free-plan Worker. Never choose a backend from user
   input, follow redirects, cache conversations or expose the gateway secret. */
import { readJson, json, httpError } from './_agent-http.mjs';

export function agentWorkerOrigin(env = process.env) {
  try {
    const url = new URL(env.AGENT_WORKER_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error();
    return url.origin;
  } catch { throw httpError(503, 'The free agent server has not been connected.'); }
}

export async function forwardAgentRequest(req, res, { env = process.env, fetcher = fetch, timeoutMs = 55000 } = {}) {
  if (!env.AGENT_WORKER_URL || env.AGENT_DB?.prepare) return false;
  const allowed = new Set(['/api/agent', '/api/agent-telegram', '/api/agent-monitor']);
  const requested = new URL(req.url || '/api/agent', 'https://agent.invalid');
  if (!allowed.has(requested.pathname)) return false;
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); json(res, 405, { error: 'Use GET or POST.' }); return true; }
  const origin = agentWorkerOrigin(env);
  if ((env.AGENT_GATEWAY_SECRET || '').length < 24) throw httpError(503, 'The private agent connection has not been configured.');
  const headers = { 'x-agent-gateway-secret': env.AGENT_GATEWAY_SECRET };
  for (const name of ['origin', 'sec-fetch-site', 'authorization', 'x-telegram-bot-api-secret-token', 'x-forwarded-for']) {
    const value = req.headers?.[name];
    if (typeof value === 'string' && value.length <= 4096) headers[name] = value;
  }
  const session = String(req.headers?.cookie || '').split(';').map(part => part.trim()).find(part => /^tiger_agent_session=[a-f0-9]{64}$/.test(part));
  if (session) headers.cookie = session;
  const body = req.method === 'POST' ? JSON.stringify(await readJson(req)) : undefined;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController(); let timer;
  const deadline = Math.min(55000, Math.max(1, timeoutMs));
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(httpError(503, 'The free agent server did not respond. Please try again later.')); }, deadline); });
  try {
    await Promise.race([(async () => {
      const response = await fetcher(origin + requested.pathname + requested.search, { method: req.method,
        headers, body, signal: controller.signal, redirect: 'error', cache: 'no-store' });
      const size = Number(response.headers?.get?.('content-length'));
      if (size > 200000) throw httpError(503, 'The agent response was too large.');
      let value;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), parts = []; let bytes = 0;
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > 200000) { await reader.cancel(); throw httpError(503, 'The agent response was too large.'); }
            parts.push(next.value);
          }
          const bodyBytes = new Uint8Array(bytes); let offset = 0;
          for (const part of parts) { bodyBytes.set(part, offset); offset += part.byteLength; }
          value = JSON.parse(new TextDecoder().decode(bodyBytes));
        } finally { reader.releaseLock(); }
      } else value = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 200000) throw httpError(503, 'The free agent response could not be read.');
      const cookie = response.headers?.get?.('set-cookie');
      if (cookie && cookie.length < 2048 && /^tiger_agent_session=/.test(cookie) && /;\s*HttpOnly(?:;|$)/i.test(cookie)
        && /;\s*SameSite=Strict(?:;|$)/i.test(cookie) && /;\s*Secure(?:;|$)/i.test(cookie) && /;\s*Path=\/api(?:;|$)/i.test(cookie)
        && !/;\s*Domain=/i.test(cookie)) res.setHeader('set-cookie', cookie);
      json(res, response.status, value);
    })(), expired]);
  } catch (error) {
    if (error.expose) throw error;
    throw httpError(503, 'The free agent is temporarily unavailable. It will not switch to a paid service.');
  } finally { clearTimeout(timer); controller.abort(); }
  return true;
}
