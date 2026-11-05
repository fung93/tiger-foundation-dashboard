import { createHash } from 'node:crypto';
import { createAgentStore } from './_agent-store.mjs';
import { safeEqual, readJson, json, getAgentOrigin } from './_agent-http.mjs';
import { processAgentMessage } from './_agent-service.mjs';
import { sendTelegram, telegramRequest } from './_agent-notifications.mjs';
import { forwardAgentRequest } from './_agent-gateway.mjs';

const approved = (binding, chat, sender) => binding && String(binding.chatId) === String(chat.id)
  && String(binding.userId) === String(sender.id);
const privateUser = (chat, sender) => chat?.type === 'private' && Number.isSafeInteger(chat.id)
  && Number.isSafeInteger(sender?.id) && chat.id > 0 && chat.id === sender.id && !sender.is_bot;
const prompts = { summary: 'Give me today’s portfolio summary.', lending: 'Check my lending health and risks.',
  lp: 'Explain my current LP performance, fees and KAT rewards.' };

export function createTelegramHandler({ env = process.env, storeFactory = createAgentStore,
  processMessage = processAgentMessage, fetcher = fetch, now = Date.now } = {}) {
  return async function handler(req, res) {
    try { if (await forwardAgentRequest(req, res, { env })) return; }
    catch { return json(res, 503, { error: 'The free agent server is temporarily unavailable.' }); }
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return json(res, 405, { error: 'Use POST.' }); }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET.length < 24)
      return json(res, 503, { error: 'Telegram is not configured.' });
    if (!safeEqual(req.headers?.['x-telegram-bot-api-secret-token'] || '', env.TELEGRAM_WEBHOOK_SECRET))
      return json(res, 401, { error: 'Telegram request could not be verified.' });
    let updateLock;
    try {
      const deliveryDeadline = Date.now() + 45000;
      const body = await readJson(req, 16384);
      if (!Number.isSafeInteger(body.update_id) || body.update_id < 0) return json(res, 400, { error: 'Invalid Telegram update.' });
      const callback = body.callback_query, incoming = callback?.message || body.message;
      const sender = callback?.from || incoming?.from, chat = incoming?.chat;
      if (!privateUser(chat, sender)) return json(res, 200, { ok: true, ignored: true });
      const store = storeFactory(env);
      const updateKey = 'telegram:update:' + body.update_id;
      if (await store.get(updateKey + ':done')) return json(res, 200, { ok: true, duplicate: true });
      updateLock = await store.lock(updateKey, 120);
      if (!updateLock) return json(res, 503, { error: 'This update is already being processed. Retry shortly.' });
      if (await store.get(updateKey + ':done')) return json(res, 200, { ok: true, duplicate: true });
      let binding = await store.get('telegram');
      let pending = await store.get(updateKey + ':pending');
      if (!pending) {
        const text = String(incoming?.text || '').trim();
        const pair = !callback && text.match(/^\/start(?:@[a-zA-Z0-9_]+)?\s+([A-Z0-9-]{10,80})$/i);
        if (pair && !binding) {
          const owner = await store.lock('owner', 90);
          if (!owner) return json(res, 503, { error: 'The agent is busy. Retry shortly.' });
          try {
            binding = await store.get('telegram');
            if (binding) return json(res, 200, { ok: true, ignored: true });
            const code = pair[1].toUpperCase();
            const digest = createHash('sha256').update(code).digest('hex');
            if (await store.get('pair:active') !== digest) return json(res, 200, { ok: true, ignored: true });
            await owner.assertOwned();
            const invitation = await store.take('pair:' + digest);
            if (!invitation) return json(res, 200, { ok: true, ignored: true });
            binding = { chatId: String(chat.id), userId: String(sender.id),
              ...(typeof sender.username === 'string' ? { username: sender.username.slice(0, 64) } : {}),
              connectedAt: new Date(now()).toISOString() };
            pending = { chatId: binding.chatId, userId: binding.userId, sentParts: 0,
              reply: 'Telegram is connected to your Tiger Foundation agent. Ask in your own words about your LPs, lending and rewards. Your dashboard and Telegram share the same conversation and alert settings.' };
            await owner.commit([{ key: 'telegram', value: binding },
              { key: updateKey + ':pending', value: pending, ttlSeconds: 7 * 86400 }, { key: 'pair:active', remove: true }]);
          } finally { await owner.release(); }
        } else {
          if (!approved(binding, chat, sender)) return json(res, 200, { ok: true, ignored: true });
          let message;
          if (callback) {
            message = prompts[callback.data];
            if (!message || typeof callback.id !== 'string') return json(res, 200, { ok: true, ignored: true });
            await telegramRequest('answerCallbackQuery', { callback_query_id: callback.id }, { env, fetcher });
          } else if (/^\/start(?:@[a-zA-Z0-9_]+)?(?:\s|$)/i.test(text)) {
            pending = { chatId: binding.chatId, userId: binding.userId, sentParts: 0,
              reply: 'You are already connected. Ask me a question, or choose Summary, Lending health or LP performance below.' };
          } else {
            message = prompts[text.replace(/^\//, '').toLowerCase()] || text;
            if (!message) return json(res, 200, { ok: true, ignored: true });
            if (message.length > 4000) {
              pending = { chatId: binding.chatId, userId: binding.userId, sentParts: 0,
                reply: 'Please shorten your question to 4,000 characters or fewer.' };
            }
          }
          if (!pending) {
            try {
              const result = await processMessage({ store, message, source: 'telegram', env,
                requestId: 'telegram:' + body.update_id });
              pending = { chatId: binding.chatId, userId: binding.userId, reply: result.reply, sentParts: 0 };
            } catch (error) {
              if (error?.status !== 429) throw error;
              pending = { chatId: binding.chatId, userId: binding.userId, sentParts: 0,
                reply: error.expose ? error.message : 'The agent has reached its message limit. Please try again later.' };
            }
          }
          await updateLock.commit([{ key: updateKey + ':pending', value: pending, ttlSeconds: 7 * 86400 }]);
        }
      }
      binding = await store.get('telegram');
      // Unlinking the account immediately prevents a delayed update from sending.
      if (!approved(binding, chat, sender) || pending.chatId !== binding.chatId || pending.userId !== binding.userId)
        return json(res, 200, { ok: true, ignored: true });
      await sendTelegram(binding.chatId, pending.reply, { env, fetcher, origin: getAgentOrigin(env), startPart: pending.sentParts,
        beforePart: async () => { await updateLock.assertOwned(); if (Date.now() >= deliveryDeadline) throw Error('Continue delivery on retry.'); },
        onPart: async sentParts => {
          pending.sentParts = sentParts;
          await updateLock.commit([{ key: updateKey + ':pending', value: pending, ttlSeconds: 7 * 86400 }]);
        } });
      await updateLock.commit([{ key: updateKey + ':done', value: true, ttlSeconds: 7 * 86400 },
        { key: updateKey + ':pending', remove: true }]);
      return json(res, 200, { ok: true });
    } catch (error) {
      const status = [400, 413, 415].includes(error?.status) ? error.status : 503;
      return json(res, status, { error: status === 413 ? 'Telegram update is too large.'
        : [400, 415].includes(status) ? 'Invalid Telegram update.' : 'The agent could not finish this update. Telegram can retry shortly.' });
    } finally { if (updateLock) { try { await updateLock.release(); } catch {} } }
  };
}

export default createTelegramHandler();
