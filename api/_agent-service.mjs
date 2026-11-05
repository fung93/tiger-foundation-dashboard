import { createHash } from 'node:crypto';
import { httpError, getAgentOrigin } from './_agent-http.mjs';
import { loadAgentContext } from './_agent-context.mjs';
import { respondAgent } from './_agent-brain.mjs';

export const DEFAULT_SETTINGS = Object.freeze({ healthThreshold: 1.2, ltvThreshold: 70, alertsEnabled: true, dailyEnabled: false, dailyTime: '09:00', pausedUntil: null });
export function normalizeSettings(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Choose valid alert settings.');
  const out = partial ? {} : { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw httpError(400, 'An alert setting was not recognised.');
    if (key === 'healthThreshold' && (!Number.isFinite(value) || value < 1 || value > 100)) throw httpError(400, 'The health alert must be between 1 and 100.');
    if (key === 'ltvThreshold' && (!Number.isFinite(value) || value <= 0 || value > 100)) throw httpError(400, 'The LTV alert must be above 0 and no higher than 100%.');
    if (['alertsEnabled', 'dailyEnabled'].includes(key) && typeof value !== 'boolean') throw httpError(400, 'Choose whether this alert is enabled.');
    if (key === 'dailyTime' && (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) throw httpError(400, 'Choose a valid daily report time in MYT.');
    if (key === 'pausedUntil' && value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw httpError(400, 'Choose a valid time to resume alerts.');
    out[key] = value;
  }
  return out;
}
export async function getSettings(store) { return normalizeSettings(await store.get('settings') || {}); }

export async function processAgentMessage({ store, message, source = 'dashboard', requestId, env = process.env, context,
  loadContext = loadAgentContext, respond = respondAgent }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw httpError(400, 'Ask a question using 1 to 4,000 characters.');
  if (!['dashboard', 'telegram'].includes(source)) throw httpError(400, 'Unknown conversation source.');
  if (typeof env.AI?.run !== 'function') throw httpError(503, 'The free AI connection is not ready yet.');
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 160 || !requestId)) throw httpError(400, 'The message reference is invalid.');
  const cacheKey = requestId && 'request:' + createHash('sha256').update(requestId).digest('hex');
  if (cacheKey) { const cached = await store.get(cacheKey); if (cached) return cached; }
  const lock = await store.lock('owner', 90);
  if (!lock) throw httpError(409, 'The agent is answering another message. Try again shortly.');
  try {
    if (cacheKey) { const cached = await store.get(cacheKey); if (cached) return cached; }
    const day = new Date().toISOString().slice(0, 10);
    const dailyLimit = Math.min(100, Math.max(1, Number(env.AGENT_DAILY_MESSAGE_LIMIT) || 40));
    if (await store.increment('usage:minute', 60) > 5 || await store.increment('usage:day:' + day, 86400 * 2) > dailyLimit)
      throw httpError(429, 'The agent has reached its message limit. Please try again later.');
    let settings = await getSettings(store);
    const messages = await store.get('messages') || [];
    const reading = context || await loadContext({ origin: getAgentOrigin(env) });
    const result = await respond({ message: message.trim(), messages: messages.slice(-12), settings, context: reading, env });
    if (!result || typeof result.reply !== 'string' || !result.reply.trim() || result.reply.length > 12000) throw httpError(503, 'The AI reply could not be verified.');
    if (result.action) {
      if (result.action.type !== 'settings') throw httpError(503, 'The agent requested an unsupported action.');
      settings = normalizeSettings({ ...settings, ...normalizeSettings(result.action.settings, { partial: true }) });
    }
    const ts = new Date().toISOString();
    const next = [...messages, { role: 'user', content: message.trim(), ts, source }, { role: 'assistant', content: result.reply, ts, source }].slice(-24);
    const answer = { reply: result.reply, messages: next, settings, sources: result.sources || reading.sources || [] };
    const writes = [{ key: 'messages', value: next }, { key: 'settings', value: settings }, { key: 'sources', value: answer.sources }];
    if (cacheKey) writes.push({ key: cacheKey, value: answer, ttlSeconds: 86400 });
    await lock.commit(writes);
    return answer;
  } finally { await lock.release(); }
}
