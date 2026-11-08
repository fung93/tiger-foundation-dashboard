/* Free-plan agent runtime. The dashboard uses a first-party authenticated relay;
   Telegram and Cron call the same private service and D1 state here. */
import { createAgentHandler } from '../api/agent.mjs';
import { createTelegramHandler } from '../api/agent-telegram.mjs';
import { createMonitorHandler } from '../api/agent-monitor.mjs';
import { safeEqual } from '../api/_agent-http.mjs';
import { dispatchPortfolioReview } from '../api/_agent-review-dispatch.mjs';
import { dispatchAutomaticObservation } from '../api/_agent-auto-state.mjs';

const MAX_BODY_BYTES = 16384;
function reply(status, message) {
  return new Response(JSON.stringify({ error: message }), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store, max-age=0',
    'x-content-type-options': 'nosniff',
  } });
}

async function bodyOf(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw Object.assign(Error(), { status: 413 });
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks = [];
  let size = 0, timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(Object.assign(Error(), { status: 408 })); }, 10000);
  });
  try {
    return await Promise.race([expired, (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) { await reader.cancel(); throw Object.assign(Error(), { status: 413 }); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(bytes);
    })()]);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export async function invokeAgentHandler(handler, request) {
  const url = new URL(request.url), headers = Object.fromEntries(request.headers);
  const body = await bodyOf(request);
  let ended = false, content = '', statusCode = 200;
  const responseHeaders = new Headers();
  const req = { method: request.method, url: url.pathname + url.search, headers,
    query: Object.fromEntries(url.searchParams), body,
    socket: { remoteAddress: headers['cf-connecting-ip'] || 'worker' } };
  const res = {
    get statusCode() { return statusCode; },
    set statusCode(value) { statusCode = value; },
    setHeader(name, value) {
      responseHeaders.delete(name);
      if (Array.isArray(value)) for (const part of value) responseHeaders.append(name, String(part));
      else responseHeaders.set(name, String(value));
    },
    status(value) { statusCode = value; return this; },
    end(value = '') { if (ended) throw Error('Agent response already ended'); ended = true; content = value; },
    json(value) { this.setHeader('content-type', 'application/json; charset=utf-8'); this.end(JSON.stringify(value)); return this; },
  };
  await handler(req, res);
  if (!ended) throw Error('Agent response was not completed');
  responseHeaders.set('cache-control', 'private, no-store, max-age=0');
  responseHeaders.set('x-content-type-options', 'nosniff');
  return new Response(request.method === 'HEAD' || statusCode === 204 ? null : content,
    { status: statusCode, headers: responseHeaders });
}

export function createAgentWorker({ agentFactory = createAgentHandler, telegramFactory = createTelegramHandler,
  monitorFactory = createMonitorHandler, reviewRunner = dispatchPortfolioReview, observationRunner = dispatchAutomaticObservation, report = message => console.error(message) } = {}) {
  return {
    async fetch(request, env) {
      try {
        const path = new URL(request.url).pathname;
        let factory, workerOrigin;
        if (path === '/api/agent') {
          if (typeof env.AGENT_GATEWAY_SECRET !== 'string' || env.AGENT_GATEWAY_SECRET.length < 24)
            return reply(503, 'The private agent gateway is not configured.');
          if (!safeEqual(request.headers.get('x-agent-gateway-secret') || '', env.AGENT_GATEWAY_SECRET))
            return reply(401, 'The agent gateway request could not be verified.');
          factory = agentFactory;
          workerOrigin = new URL(request.url).origin;
        } else if (path === '/api/agent-telegram') {
          if (!env.TELEGRAM_BOT_TOKEN || typeof env.TELEGRAM_WEBHOOK_SECRET !== 'string' || env.TELEGRAM_WEBHOOK_SECRET.length < 24)
            return reply(503, 'Telegram is not configured.');
          if (!safeEqual(request.headers.get('x-telegram-bot-api-secret-token') || '', env.TELEGRAM_WEBHOOK_SECRET))
            return reply(401, 'Telegram request could not be verified.');
          factory = telegramFactory;
        } else if (path === '/api/agent-monitor') {
          if (typeof env.CRON_SECRET !== 'string' || env.CRON_SECRET.length < 24) return reply(503, 'Monitoring is not configured.');
          if (!safeEqual(request.headers.get('authorization') || '', 'Bearer ' + env.CRON_SECRET))
            return reply(401, 'Monitoring request could not be verified.');
          factory = monitorFactory;
        }
        else return reply(404, 'Agent route not found.');
        return await invokeAgentHandler(factory({ env, ...(workerOrigin ? { workerOrigin } : {}) }), request);
      } catch (error) {
        return reply(error?.status === 413 ? 413 : error?.status === 408 ? 408 : 503,
          error?.status === 413 ? 'The agent request is too large.' : error?.status === 408
            ? 'The agent request body timed out.' : 'The agent is temporarily unavailable. Please try again later.');
      }
    },
    scheduled(_event, env, context) {
      const run = (async () => {
        if (typeof env.CRON_SECRET !== 'string' || env.CRON_SECRET.length < 24) {
          report('Agent monitoring is not configured.');
          return;
        }
        // Internal invocation uses the same authenticated monitor, without an
        // external self-fetch or a separate paid scheduler/runner.
        const request = new Request('https://agent.internal/api/agent-monitor', { method: 'POST',
          headers: { authorization: 'Bearer ' + env.CRON_SECRET, 'content-type': 'application/json' }, body: '{}' });
        let response;
        try { response = await invokeAgentHandler(monitorFactory({ env }), request); }
        catch { /* Dispatch independent observations even if the monitor throws. */ }
        // Pure dispatch uses no D1 query in this invocation. A bot delivery
        // outage must not stop independently collected portfolio observations.
        try { await observationRunner({env}); }
        catch { report('Automatic observation dispatch needs recovery on the next tick.'); }
        if (!response?.ok) throw Error('Agent monitoring did not complete.');
        // Only queue here. Full analysis runs in separate bounded Workflow
        // invocations, keeping both CPU and D1 calls out of the risk tick.
        try { await reviewRunner({ env, monitoringSucceeded: true }); }
        catch { report('The strategy review did not complete; its durable checkpoint will be checked on the next tick.'); }
      })().catch(() => {
        report('Agent monitoring did not complete; the next scheduled check can retry.');
        throw Error('Agent monitoring did not complete.');
      });
      if (context?.waitUntil) context.waitUntil(run);
      return run;
    },
  };
}

export default createAgentWorker();
