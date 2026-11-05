import { randomUUID } from 'node:crypto';
import { createAgentStore } from './_agent-store.mjs';
import { safeEqual, json, getAgentOrigin } from './_agent-http.mjs';
import { getSettings } from './_agent-service.mjs';
import { loadAgentContext } from './_agent-context.mjs';
import { summarizeAgent } from './_agent-brain.mjs';
import { monitorConditions, mytDayAndTime, sendTelegram } from './_agent-notifications.mjs';
import { forwardAgentRequest } from './_agent-gateway.mjs';

const COOLDOWN = 6 * 3600000;
const paused = (settings, timestamp) => settings.pausedUntil && Date.parse(settings.pausedUntil) > timestamp;

export function createMonitorHandler({ env = process.env, storeFactory = createAgentStore,
  loadContext = loadAgentContext, summarize = summarizeAgent, fetcher = fetch, now = Date.now } = {}) {
  return async function handler(req, res) {
    try { if (await forwardAgentRequest(req, res, { env })) return; }
    catch { return json(res, 503, { error: 'The free agent server is temporarily unavailable.' }); }
    if (!['POST', 'GET'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); return json(res, 405, { error: 'Use GET or POST.' }); }
    if (!env.CRON_SECRET || env.CRON_SECRET.length < 24) return json(res, 503, { error: 'Monitoring is not configured.' });
    if (!safeEqual(req.headers?.authorization || '', 'Bearer ' + env.CRON_SECRET)) return json(res, 401, { error: 'Monitoring request could not be verified.' });
    let owner;
    try {
      const deliveryDeadline = Date.now() + 45000;
      let sentChunks = 0;
      const origin = getAgentOrigin(env), store = storeFactory(env), timestamp = now(), iso = new Date(timestamp).toISOString();
      owner = await store.lock('owner', 90);
      if (!owner) return json(res, 200, { ok: true, skipped: 'busy' });
      const settings = await getSettings(store);
      if (paused(settings, timestamp)) {
        await owner.commit([{ key: 'lastCheck', value: { ts: iso, status: 'paused', sources: [] } }]);
        return json(res, 200, { ok: true, skipped: 'paused' });
      }
      const binding = await store.get('telegram'), linked = binding && env.TELEGRAM_BOT_TOKEN;
      const context = await loadContext({ origin, fetcher, now });
      let state = await store.get('monitor:state') || { conditions: {}, dailyDate: null };
      const conditions = monitorConditions(context, settings), day = mytDayAndTime(timestamp);
      let pending = await store.get('monitor:pending');
      const deliver = async () => {
        if (!pending) return;
        // A disconnected/replaced recipient never inherits pending messages.
        if (!linked || pending.chatId !== binding.chatId) {
          await owner.commit([{ key: 'monitor:pending', remove: true }]); pending = null; return;
        }
        while (pending.itemIndex < pending.items.length) {
          const item = pending.items[pending.itemIndex];
          // Preferences may have changed after a failed delivery, including a
          // mixed batch containing risk alerts and the daily summary.
          const condition = conditions[item.key];
          const verified = item.type === 'daily' ? item.day === day.day : condition
            && (item.status === 'active' ? condition.active : !condition.active);
          const enabled = (item.type === 'daily' ? settings.dailyEnabled : settings.alertsEnabled) && verified;
          let deliveredMessage = item.text;
          if (enabled) {
            // An old queued warning is rechecked against today's verified state.
            // If its severity/value changed, send the current reading instead.
            if (item.type !== 'daily' && item.status === 'active') deliveredMessage = condition.title + '\n' + condition.message;
            if (deliveredMessage !== item.text) { pending.sentParts = 0; item.text = deliveredMessage; }
            await sendTelegram(binding.chatId, deliveredMessage, { env, fetcher, origin, startPart: pending.sentParts || 0,
              beforePart: async () => {
                await owner.assertOwned();
                if (sentChunks >= 4 || Date.now() >= deliveryDeadline) throw Error('Continue pending delivery on the next check.');
              },
              onPart: async sentParts => { sentChunks++; pending.sentParts = sentParts;
                await owner.commit([{ key: 'monitor:pending', value: pending }]); } });
          }
          const alerts = await store.get('alerts') || [];
          for (const alert of alerts) if (item.alertId === alert.id) {
            if (enabled) { alert.telegramSent = true; alert.deliveredMessage = deliveredMessage; }
            else alert.deliveryCancelled = true;
          }
          if (!enabled && item.type !== 'daily' && state.conditions?.[item.key]?.active)
            state.conditions[item.key].notifiedAt = 0;
          pending.itemIndex++;
          pending.sentParts = 0;
          await owner.commit([{ key: 'alerts', value: alerts }, { key: 'monitor:pending', value: pending },
            { key: 'monitor:state', value: state }]);
        }
        await owner.commit([{ key: 'monitor:pending', remove: true }]); pending = null;
      };
      await deliver();
      const events = [], next = { ...state, conditions: { ...state.conditions },
        telegramChatId: linked ? binding.chatId : null };
      const newChannel = !!linked && state.telegramChatId !== binding.chatId;
      if (settings.alertsEnabled) for (const [key, condition] of Object.entries(conditions)) {
        const before = state.conditions?.[key], repeated = before?.active && timestamp - (before.notifiedAt || 0) >= COOLDOWN;
        const escalated = condition.active && before?.active && condition.severity === 'critical' && before.severity !== 'critical';
        if (condition.active && (!before?.active || repeated || escalated || newChannel)) {
          events.push({ id: randomUUID(), key, type: condition.type, severity: condition.severity,
            title: condition.title, message: condition.message, ts: iso, sourceTs: condition.sourceTs,
            ...(condition.marketId ? { marketId: condition.marketId } : {}), status: 'active', telegramSent: false });
          next.conditions[key] = { active: true, severity: condition.severity, notifiedAt: timestamp };
        } else if (!condition.active && before?.active) {
          events.push({ id: randomUUID(), key, type: condition.type, severity: 'info', title: 'Reading recovered',
            message: condition.type === 'data' ? condition.title.replace(' needs attention', '') + ' is fresh again.'
              : condition.title + ' is within your alert limits or has no outstanding debt.',
            ts: iso, sourceTs: condition.sourceTs, status: 'recovered', telegramSent: false });
          next.conditions[key] = { active: false, notifiedAt: timestamp };
        } else next.conditions[key] = before ? { ...before, active: condition.active, severity: condition.severity }
          : { active: false, notifiedAt: 0 };
      }
      const dailyDue = !!(settings.dailyEnabled && day.time >= settings.dailyTime && state.dailyDate !== day.day);
      if (dailyDue) {
        const text = summarize(context);
        events.push({ id: randomUUID(), key: 'daily:' + day.day, type: 'daily', severity: 'info',
          title: 'Daily summary', message: text, ts: iso, sourceTs: context.asOf || iso, status: 'daily', telegramSent: false });
        next.dailyDate = day.day;
      }
      const alerts = [...(await store.get('alerts') || []), ...events].slice(-30);
      const entries = [{ key: 'monitor:state', value: next }, { key: 'alerts', value: alerts },
        { key: 'lastCheck', value: { ts: iso, status: 'checked', sources: context.sources || [] } }];
      if (dailyDue) {
        const messages = await store.get('messages') || [];
        const brief = events.find(e => e.type === 'daily');
        entries.push({ key: 'messages', value: [...messages, { role: 'assistant', content: brief.message, ts: iso,
          source: 'monitor', id: brief.key }].slice(-24) });
      }
      if (events.length && linked) {
        pending = { chatId: binding.chatId, items: events.map(e => ({ alertId: e.id, type: e.type, key: e.key,
          status: e.status, ...(e.type === 'daily' ? { day: day.day } : {}),
          text: e.title + '\n' + e.message })), itemIndex: 0, sentParts: 0, ts: iso };
        entries.push({ key: 'monitor:pending', value: pending });
      }
      await owner.commit(entries);
      state = next;
      await deliver();
      return json(res, 200, { ok: true, alerts: events.length, daily: dailyDue, telegram: !!linked, checkedAt: iso });
    } catch {
      return json(res, 503, { error: 'The monitoring check did not finish. The next scheduled check can retry.' });
    } finally { if (owner) { try { await owner.release(); } catch {} } }
  };
}

export default createMonitorHandler();
