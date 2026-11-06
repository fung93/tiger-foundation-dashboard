import { createHash, randomBytes } from 'node:crypto';
import { createAgentStore } from './_agent-store.mjs';
import { json, httpError, readJson, requireSameOrigin, safeEqual, getAgentOrigin, publicError, agentErrorCategory } from './_agent-http.mjs';
import { getSettings, normalizeSettings, processAgentMessage } from './_agent-service.mjs';
import { forwardAgentRequest } from './_agent-gateway.mjs';
import { agentDiagnostics } from './_agent-diagnostics.mjs';
import { agentAction } from './_agent-actions.mjs';
import { getAgentPolicy } from './_agent-policy.mjs';
import { telegramConfigured, telegramSetupAction, verifiedTelegramUsername } from './_agent-telegram-setup.mjs';

const COOKIE = 'tiger_agent_session', SESSION_TTL = 7 * 86400;
const hash = value => createHash('sha256').update(value).digest('hex');
function readiness(env) {
  let origin = false, storage = false;
  try { getAgentOrigin(env); origin = true; } catch {}
  try { createAgentStore(env); storage = true; } catch {}
  const owner = typeof env.AGENT_ACCESS_KEY === 'string' && env.AGENT_ACCESS_KEY.length >= 24;
  return { origin, storage, owner, ai: typeof env.AI?.run === 'function' && env.AGENT_INFERENCE_ENABLED !== 'false',
    telegram: telegramConfigured(env),
    monitor: (env.CRON_SECRET || '').length >= 24 };
}
function cookie(req) {
  const raw = (req.headers?.cookie || '').split(';').find(p => p.trim().startsWith(COOKIE + '='))?.trim().slice(COOKIE.length + 1);
  return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}
function setCookie(res, token, env, expire = false) {
  const secure = getAgentOrigin(env).startsWith('https:') ? '; Secure' : '';
  res.setHeader('set-cookie', COOKIE + '=' + token + '; HttpOnly; SameSite=Strict; Path=/api; Max-Age=' + (expire ? 0 : SESSION_TTL) + secure);
}
async function privateStatus(req, store, available, env) {
  const token = cookie(req);
  if (!token || !await store.get('session:' + hash(token))) return { configured: true, authenticated: false, readiness: available };
  const [settings, messages, alerts, binding, sources, lastCheck, policy] = await Promise.all([
    getSettings(store), store.get('messages'), store.get('alerts'), store.get('telegram'), store.get('sources'), store.get('lastCheck'), getAgentPolicy(store),
  ]);
  return { configured: true, authenticated: true, readiness: available,
    settings, policy, messages: messages || [], alerts: alerts || [], sources: sources || [], last_check: lastCheck,
    telegram: { connected: !!binding, username: env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '') || null } };
}

export function createAgentHandler({ env = process.env, storeFactory = createAgentStore, processMessage = processAgentMessage,
  loadContext, workerOrigin, telegramFetcher } = {}) {
  return async function handler(req, res) {
    try {
      if (await forwardAgentRequest(req, res, { env })) return;
      if (!['GET', 'POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); return json(res, 405, { error: 'Use GET or POST.' }); }
      const available = readiness(env), configured = available.owner && available.origin && available.storage;
      if (req.method === 'GET') {
        const action = req.query?.action || new URL(req.url || '/', 'http://agent.invalid').searchParams.get('action') || 'status';
        if (action !== 'status') return json(res, 400, { error: 'Unknown agent request.' });
        if (!configured) return json(res, 200, { configured: false, authenticated: false, readiness: available, message: 'The private agent needs server setup before it can answer or send alerts.' });
        // Even older deployed service workers cache GET APIs. Private history is
        // available only through same-origin POST and can never enter that cache.
        return json(res, 200, { configured: true, authenticated: false, readiness: available });
      }
      const body = await readJson(req);
      if (!configured) return body.action === 'status'
        ? json(res, 200, { configured: false, authenticated: false, readiness: available, message: 'The private agent needs server setup before it can answer or send alerts.' })
        : json(res, 503, { error: 'The private agent needs server setup before it can answer or send alerts.' });
      requireSameOrigin(req, env);
      const store = storeFactory(env);
      if (body.action === 'status') return json(res, 200, await privateStatus(req, store, available, env));
      if (body.action === 'login') {
        const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 100);
        if (await store.increment('login:' + hash(ip), 900) > 8) throw httpError(429, 'Too many sign-in attempts. Please wait 15 minutes.');
        if (!safeEqual(body.accessKey, env.AGENT_ACCESS_KEY)) throw httpError(401, 'The access key is incorrect.');
        const token = randomBytes(32).toString('hex');
        await store.set('session:' + hash(token), { issuedAt: new Date().toISOString() }, { ttlSeconds: SESSION_TTL });
        setCookie(res, token, env);
        return json(res, 200, { authenticated: true });
      }
      const token = cookie(req);
      if (!token || !await store.get('session:' + hash(token))) throw httpError(401, 'Sign in to your private agent first.');
      if (body.action === 'diagnostics') return json(res, 200, await agentDiagnostics({ env, store }));
      if (['telegramCheck', 'telegramConnect'].includes(body.action)) return json(res, 200,
        await telegramSetupAction(body, { env, store, workerOrigin, ...(telegramFetcher ? { fetcher: telegramFetcher } : {}) }));
      const action = await agentAction(body, { env, store, ...(loadContext ? { loadContext } : {}) });
      if (action !== null) return json(res, 200, action);
      if (body.action === 'logout') {
        await store.del('session:' + hash(token)); setCookie(res, '', env, true);
        return json(res, 200, { authenticated: false });
      }
      if (body.action === 'chat') return json(res, 200, await processMessage({ store, message: body.message, source: 'dashboard', requestId: body.requestId, env }));
      if (!['settings', 'pair', 'unlink'].includes(body.action)) throw httpError(400, 'Unknown agent request.');
      const lock = await store.lock('owner', 90);
      if (!lock) throw httpError(409, 'The agent is finishing another request. Try again shortly.');
      try {
        if (body.action === 'settings') {
          const settings = normalizeSettings({ ...await getSettings(store), ...normalizeSettings(body.settings, { partial: true }) });
          await lock.commit([{ key: 'settings', value: settings }]);
          return json(res, 200, { settings });
        }
        const previous = await store.get('pair:active');
        const revoke = [{ key: 'pair:active', remove: true }, ...(previous ? [{ key: 'pair:' + previous, remove: true }] : [])];
        if (body.action === 'unlink') {
          await lock.commit([...revoke, { key: 'telegram', remove: true }]);
          return json(res, 200, { telegram: { connected: false } });
        }
        if (!available.telegram) throw httpError(409, 'Telegram has not been connected on the server yet.');
        if (await store.get('telegram')) throw httpError(409, 'Telegram is already linked. Unlink it before pairing another account.');
        const code = randomBytes(12).toString('hex').toUpperCase(), digest = hash(code), issuedAt = new Date().toISOString();
        await lock.commit([...revoke, { key: 'pair:' + digest, value: { issuedAt }, ttlSeconds: 600 }, { key: 'pair:active', value: digest, ttlSeconds: 600 }]);
        const username = await verifiedTelegramUsername({ env, store, workerOrigin });
        return json(res, 200, { code, expiresAt: new Date(Date.now() + 600000).toISOString(),
          url: /^[a-zA-Z0-9_]{5,32}$/.test(username) ? 'https://t.me/' + username + '?start=' + code : null });
      } finally { await lock.release(); }
    } catch (error) { const safe = publicError(error); return json(res, safe.status, { error: safe.message, errorCategory: agentErrorCategory(error) }); }
  };
}
export default createAgentHandler();
