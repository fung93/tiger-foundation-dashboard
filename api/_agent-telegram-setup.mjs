/* Owner-operated Telegram transport setup. This is never an AI tool or a cron
   action. Credentials stay in Worker bindings; only bounded metadata leaves here. */
import { createHash, randomBytes } from 'node:crypto';
import { getAgentOrigin, httpError } from './_agent-http.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const DRAFT = 'telegram:setup:draft', LAST = 'telegram:setup:last';
const TTL = 600, MAX_REPLY_BYTES = 16384;
const usernameOK = value => typeof value === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(value);

export function telegramConfigured(env) {
  return typeof env.TELEGRAM_BOT_TOKEN === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(env.TELEGRAM_BOT_TOKEN)
    && typeof env.TELEGRAM_WEBHOOK_SECRET === 'string' && /^[A-Za-z0-9_-]{24,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET);
}
function configuration(env, workerOrigin) {
  if (!telegramConfigured(env)) throw httpError(409, 'Check TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in Cloudflare. The webhook secret needs 24–256 letters, digits, underscores or hyphens.');
  let origin;
  try {
    // The Worker adapter supplies its actual request origin after gateway auth.
    // No request body, Origin/Host header or model can choose this destination.
    const url = new URL(workerOrigin || env.AGENT_WORKER_URL || getAgentOrigin(env));
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error();
    origin = url.origin;
  } catch { throw httpError(503, 'Telegram setup needs the deployed HTTPS Worker address.'); }
  const target = origin + '/api/agent-telegram';
  return { target, fingerprint: sha(JSON.stringify([env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, target])) };
}
async function readReply(response) {
  if (Number(response.headers.get('content-length')) > MAX_REPLY_BYTES || !response.body) throw Error();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_REPLY_BYTES) { void reader.cancel().catch(() => {}); throw Error(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function providerFailure(method, status, label = 'HTTP') {
  const code = Number.isInteger(status) && status >= 100 && status <= 599 ? ' (' + label + ' ' + status + ')' : '';
  if (status >= 300 && status < 400) return httpError(503, 'Telegram ' + method + ' returned a redirect' + code + '. The request was stopped to keep the bot token private.');
  if ([401, 404].includes(status)) return httpError(409, 'Telegram ' + method + ' rejected the bot credentials' + code + '. Check TELEGRAM_BOT_TOKEN in Cloudflare.');
  if (status === 429) return httpError(429, 'Telegram ' + method + ' is rate limited' + code + '. Wait a minute before checking setup again.');
  return httpError(503, 'Telegram ' + method + ' did not accept the setup request' + code + '. Try Check Telegram setup again.');
}
async function call(method, body, { env, fetcher, timeoutMs }) {
  if (!['getMe', 'getWebhookInfo', 'setWebhook'].includes(method)) throw Error('Unsupported Telegram setup method');
  const controller = new AbortController(); let timer, readingBody = false, timedOut = false;
  const timeout = () => httpError(503, 'Telegram ' + method + ' timed out. Check setup again before connecting.');
  try {
    return await Promise.race([(async () => {
      const response = await fetcher('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
        // Workers supports manual/follow, but rejects error before any request.
        // Manual plus the status check below prevents token-bearing redirects.
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) throw providerFailure(method, response.status);
      readingBody = true;
      const value = await readReply(response);
      if (value?.ok !== true) throw providerFailure(method, value?.error_code, 'API');
      return value.result;
    })(), new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(timeout()); }, timeoutMs);
    })]);
  } catch (error) {
    if (timedOut) throw timeout();
    if (error?.expose) throw error;
    // Telegram descriptions and thrown network errors can contain token-bearing
    // URLs or unrelated webhook addresses. Never return or persist them.
    throw httpError(503, readingBody ? 'Telegram ' + method + ' returned an unreadable response. Try Check Telegram setup again.'
      : 'Telegram ' + method + ' could not be reached from the Worker. Try Check Telegram setup again.');
  } finally { clearTimeout(timer); controller.abort(); }
}
function webhookInfo(value, target) {
  if (!value || typeof value.url !== 'string' || value.url.length > 2048
    || (value.allowed_updates !== undefined && (!Array.isArray(value.allowed_updates) || value.allowed_updates.length > 64
      || value.allowed_updates.some(item => typeof item !== 'string' || item.length > 100)))) throw httpError(503, 'Telegram returned unreadable webhook metadata. Check setup again.');
  const error = typeof value.last_error_message === 'string' ? value.last_error_message : '';
  const deliveryError = !error ? 'none' : /401|unauthoriz/i.test(error) ? 'unauthorized'
    : /404|not found/i.test(error) ? 'not_found' : /\b5\d\d\b/i.test(error) ? 'server_error'
    : /timed?\s*out|timeout/i.test(error) ? 'timeout' : /ssl|tls|dns|resolve/i.test(error) ? 'tls_or_dns' : 'reported';
  const updates = value.allowed_updates;
  return { currentHash: sha(value.url), webhookStatus: !value.url ? 'missing' : value.url === target ? 'matches' : 'different',
    updatesStatus: !updates || !updates.length ? 'default' : ['message', 'callback_query'].every(item => updates.includes(item)) ? 'compatible' : 'missing_messages',
    pendingUpdates: Number.isSafeInteger(value.pending_update_count) && value.pending_update_count >= 0 ? value.pending_update_count : null,
    deliveryError };
}
function publicSetup(draft) {
  return { draftId: draft.id, botUsername: draft.botUsername, targetWebhookUrl: draft.target,
    checkedAt: draft.checkedAt, expiresAt: draft.expiresAt, webhookStatus: draft.webhookStatus,
    updatesStatus: draft.updatesStatus, pendingUpdates: draft.pendingUpdates, deliveryError: draft.deliveryError,
    requiresReplacement: draft.webhookStatus === 'different', registered: draft.state === 'registered',
    registeredAt: draft.registeredAt || null, deliveryVerified: false };
}
export async function verifiedTelegramUsername({ env, store, workerOrigin }) {
  const fallback = (env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
  const last = await store.get(LAST);
  if (last && telegramConfigured(env) && last.fingerprint === configuration(env, workerOrigin).fingerprint && usernameOK(last.botUsername)) return last.botUsername;
  return usernameOK(fallback) ? fallback : null;
}

export async function telegramSetupAction(body, { env, store, workerOrigin, fetcher = fetch, now = Date.now, timeoutMs = 6000 }) {
  const checking = body.action === 'telegramCheck';
  const keys = checking ? ['action'] : ['action', 'draftId', 'replaceExisting'];
  if (!['telegramCheck', 'telegramConnect'].includes(body.action) || Object.keys(body).some(key => !keys.includes(key))
    || (!checking && (typeof body.draftId !== 'string' || !/^[a-f0-9]{48}$/.test(body.draftId)
      || (body.replaceExisting !== undefined && typeof body.replaceExisting !== 'boolean')))) throw httpError(400, 'Use the Telegram setup controls to check and connect this bot.');
  const config = configuration(env, workerOrigin);
  const lease = await store.lock('telegram:setup', 90);
  if (!lease) throw httpError(409, 'Another Telegram setup check is running. Please wait for it to finish.');
  const provider = (method, data = {}) => call(method, data, { env, fetcher, timeoutMs });
  try {
    if (checking) {
      if (await store.increment('telegram:setup:checks', 60) > 3) throw httpError(429, 'Please wait a minute before checking Telegram setup again.');
      const bot = await provider('getMe');
      if (bot?.is_bot !== true || !Number.isSafeInteger(bot.id) || bot.id <= 0 || !usernameOK(bot.username)) throw httpError(503, 'Telegram did not confirm a valid bot identity. Check TELEGRAM_BOT_TOKEN.');
      const info = webhookInfo(await provider('getWebhookInfo'), config.target), at = now();
      const draft = { ...config, ...info, id: randomBytes(24).toString('hex'), botId: bot.id, botUsername: bot.username,
        state: 'checked', checkedAt: new Date(at).toISOString(), expiresAt: new Date(at + TTL * 1000).toISOString() };
      await lease.commit([{ key: DRAFT, value: draft, ttlSeconds: TTL },
        { key: LAST, value: { botUsername: bot.username, fingerprint: config.fingerprint, checkedAt: draft.checkedAt } }]);
      return { setup: publicSetup(draft) };
    }
    let draft = await store.get(DRAFT);
    if (!draft || draft.id !== body.draftId || Date.parse(draft.expiresAt) <= now() || draft.fingerprint !== config.fingerprint || draft.target !== config.target)
      throw httpError(409, 'This Telegram setup preview expired or the settings changed. Check Telegram setup again.');
    if (draft.state === 'registered') return { setup: publicSetup(draft) };
    if (draft.state !== 'checked') throw httpError(409, 'The previous connection attempt needs a fresh check. Choose Check Telegram setup again.');
    if (draft.webhookStatus === 'different' && body.replaceExisting !== true) throw httpError(409, 'This bot already delivers messages elsewhere. Confirm replacing that connection before connecting it here.');
    if (await store.increment('telegram:setup:connects', 60) > 3) throw httpError(429, 'Please wait a minute before connecting Telegram again.');
    const current = webhookInfo(await provider('getWebhookInfo'), config.target);
    if (current.currentHash !== draft.currentHash) throw httpError(409, 'The bot webhook changed after this preview. Check Telegram setup again.');
    // Invalidate old invitations before enabling delivery of queued /start
    // messages. The existing linked human and conversation are never removed.
    const owner = await store.lock('owner', 15);
    if (!owner) throw httpError(409, 'The agent is saving another change. Try Connect webhook again shortly.');
    try {
      const active = await store.get('pair:active');
      draft = { ...draft, state: 'registration_started' };
      await owner.commit([{ key: 'pair:active', remove: true }, ...(active ? [{ key: 'pair:' + active, remove: true }] : []),
        { key: DRAFT, value: draft, ttlSeconds: TTL }], { alsoOwned: [lease] });
    } finally { await owner.release(); }
    // No owner lock spans Telegram network calls. Setup has its own fenced lease.
    await lease.assertOwned();
    if (await provider('setWebhook', { url: config.target, secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'], drop_pending_updates: false }) !== true) throw httpError(503, 'Telegram did not confirm registration. Check Telegram setup again.');
    const verified = webhookInfo(await provider('getWebhookInfo'), config.target);
    if (verified.webhookStatus !== 'matches' || verified.updatesStatus === 'missing_messages') throw httpError(503, 'Telegram did not confirm the expected connection. Check Telegram setup again.');
    draft = { ...draft, ...verified, state: 'registered', registeredAt: new Date(now()).toISOString() };
    await lease.commit([{ key: DRAFT, value: draft, ttlSeconds: TTL },
      { key: LAST, value: { botUsername: draft.botUsername, fingerprint: config.fingerprint, checkedAt: draft.checkedAt, registeredAt: draft.registeredAt } }]);
    return { setup: publicSetup(draft) };
  } finally { await lease.release(); }
}
