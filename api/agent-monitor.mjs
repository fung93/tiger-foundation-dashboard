import { randomUUID } from 'node:crypto';
import { createAgentStore, readAgentState } from './_agent-store.mjs';
import { safeEqual, json, getAgentOrigin } from './_agent-http.mjs';
import { getSettings } from './_agent-settings.mjs';
import { loadAgentContext } from './_agent-context.mjs';
import { summarizeAgent } from './_agent-brain.mjs';
import { monitorConditions, mytDayAndTime, sendTelegram } from './_agent-notifications.mjs';
import { forwardAgentRequest } from './_agent-gateway.mjs';
import { getAgentPolicy } from './_agent-policy.mjs';
import { yieldReviewOutbox } from './_agent-review-delivery.mjs';
import { automationEnabled, AUTO_SCHEMA } from './_agent-auto-state.mjs';

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
    let monitor, store, commit;
    try {
      const deliveryDeadline = Date.now() + 45000;
      let sentChunks = 0, processedItems = 0;
      const origin = getAgentOrigin(env), timestamp = now(), iso = new Date(timestamp).toISOString();
      store = storeFactory(env);
      monitor = await store.lock('monitor', 90);
      if (!monitor) return json(res, 200, { ok: true, skipped: 'busy' });
      commit = async entries => {
        const owner = await store.lock('owner', 15);
        if (!owner) throw Error('A short private update is in progress.');
        try {
          // Merge shared conversation state only while the owner lease is held.
          const shared = entries.find(entry => entry.key === 'messages');
          if (shared) {
            const latest = await store.get('messages') || [], added = shared.value.at(-1);
            shared.value = latest.some(message => added.id && message.id === added.id) ? latest : [...latest,added].slice(-24);
          }
          await monitor.commit(entries, { alsoOwned: [owner] });
        } finally { await owner.release(); }
      };
      const preferences = async () => {
        const saved = await readAgentState(store, ['settings', 'policy:current', 'telegram', 'automation:schedule', 'automation:controls']);
        const view = { get: async name => saved[name] };
        const schedule=saved['automation:schedule'],controls=saved['automation:controls'];
        // Reuse this batched read: never add a D1 call to the bounded risk Cron.
        // A stale/paused automatic runner yields the daily summary back here.
        const automaticDaily=automationEnabled(env)&&typeof env.PORTFOLIO_REVIEWS?.create==='function'
          &&(!controls||controls.schemaVersion===AUTO_SCHEMA&&controls.enabled===true)
          &&schedule&&now()-Date.parse(schedule.lastSuccess)>=-30000
          &&now()-Date.parse(schedule.lastSuccess)<Math.max(600000,(schedule.intervalMinutes||5)*120000);
        return { settings: await getSettings(view), policy: await getAgentPolicy(view), binding: saved.telegram,
          automaticDaily,automaticDailyDate:schedule?.telegramDailyDate||null };
      };
      let { settings, policy, binding, automaticDaily, automaticDailyDate } = await preferences();
      if (paused(settings, timestamp)) {
        await commit([{ key: 'lastCheck', value: { ts: iso, status: 'paused', sources: [] } }]);
        return json(res, 200, { ok: true, skipped: 'paused' });
      }
      const linked = binding && env.TELEGRAM_BOT_TOKEN;
      const triggers = policy.constraints?.lpReviewTriggers || {};
      const needs = triggers.rewardChangePct != null || triggers.priceMovePct != null ? ['strategy'] : [];
      const context = await loadContext({ origin, fetcher, now, needs });
      ({ settings, policy, automaticDaily, automaticDailyDate } = await preferences());
      if (paused(settings, timestamp)) {
        await commit([{key:'lastCheck',value:{ts:iso,status:'paused',sources:[]}}]);
        return json(res,200,{ok:true,skipped:'paused'});
      }
      let state = await store.get('monitor:state') || { conditions: {}, dailyDate: null };
      const previousConditions = Object.fromEntries(Object.entries(state.conditions).filter(([key])=>!key.startsWith('review:')
        &&(state.policyVersion===policy.version||!key.startsWith('lp:'))));
      const conditions = monitorConditions(context, settings, { policy, previous: previousConditions, now: timestamp }), day = mytDayAndTime(timestamp);
      const limitations = [];
      if (needs.length && context.strategy?.status !== 'fresh') limitations.push('Current campaign/price coverage is incomplete.');
      if ((triggers.outOfRange || triggers.maxOutOfRangeHours != null) && (context.lp?.positions || []).some(row => !row.canonical?.block)) limitations.push('Some LP range readings have no pinned block.');
      if (store.storageUsage) {
        try { const usage = await store.storageUsage(); conditions.storage = { active: usage.status === 'review_required', type:'data', severity:'warning',
          title:'Private storage budget',message:'Private payload storage is approaching its local budget; review Cloudflare usage. Durable decisions were retained.',sourceTs:iso }; }
        catch { limitations.push('Private storage accounting requires the storage migration.'); }
      }
      // Risk checks take priority over an unfinished strategy notice. Preserve
      // its acknowledged-part checkpoint, then use the same outbox for alerts.
      await yieldReviewOutbox(store, monitor);
      let pending = await store.get('monitor:pending');
      const deliver = async () => {
        if (!pending) return;
        // A disconnected/replaced recipient never inherits pending messages.
        if (!linked || pending.chatId !== binding.chatId) {
          await commit([{ key: 'monitor:pending', remove: true }]); pending = null; return;
        }
        while (pending.itemIndex < pending.items.length) {
          // Bounded delivery leaves room for the verified risk pass and the
          // cheap Workflow dispatch in this Free-plan invocation.
          if (processedItems >= 2) return;
          const item = pending.items[pending.itemIndex];
          // Preferences may have changed after a failed delivery, including a
          // mixed batch containing risk alerts and the daily summary.
          const condition = conditions[item.key];
          const verified = item.type === 'daily' ? item.day === day.day : condition
            && (item.status === 'active' ? condition.active : !condition.active);
          const enabled = item.type!=='review'&&(item.type === 'daily' ? settings.dailyEnabled : settings.alertsEnabled) && verified;
          let deliveredMessage = item.text;
          if (enabled) {
            // An old queued warning is rechecked against today's verified state.
            // If its severity/value changed, send the current reading instead.
            if (item.type !== 'daily' && item.status === 'active') deliveredMessage = condition.title + '\n' + condition.message;
            if (deliveredMessage !== item.text) { pending.sentParts = 0; item.text = deliveredMessage; }
            await sendTelegram(binding.chatId, deliveredMessage, { env, fetcher, origin, startPart: pending.sentParts || 0,
              beforePart: async () => {
                await monitor.assertOwned();
                const { settings: currentSettings, policy: currentPolicy, binding: currentBinding } = await preferences();
                if (paused(currentSettings, now()) || currentBinding?.chatId !== binding.chatId
                  || !(item.type === 'daily' ? currentSettings.dailyEnabled : currentSettings.alertsEnabled)
                  || currentPolicy.version !== policy.version) throw Error('Delivery requires fresh preferences and policy.');
                if (sentChunks >= 3 || Date.now() >= deliveryDeadline) throw Error('Continue pending delivery on the next check.');
              },
              onPart: async sentParts => { sentChunks++; pending.sentParts = sentParts;
                await commit([{ key: 'monitor:pending', value: pending }]); } });
          }
          const alerts = await store.get('alerts') || [];
          for (const alert of alerts) if (item.alertId === alert.id) {
            if (enabled) { alert.telegramSent = true; alert.deliveredMessage = deliveredMessage; }
            else alert.deliveryCancelled = true;
          }
          if (!enabled && item.type !== 'daily' && state.conditions?.[item.key]?.active)
            state.conditions[item.key].notifiedAt = 0;
          pending.itemIndex++;
          processedItems++;
          pending.sentParts = pending.items[pending.itemIndex]?.sentParts || 0;
          await commit([{ key: 'alerts', value: alerts }, { key: 'monitor:pending', value: pending },
            { key: 'monitor:state', value: state }]);
        }
        await commit([{ key: 'monitor:pending', remove: true }]); pending = null;
      };
      let deliveryFailed = false;
      try { await deliver(); } catch { deliveryFailed = true; }
      const events = [], next = { ...state, policyVersion: policy.version, conditions: { ...previousConditions },
        telegramChatId: linked ? binding.chatId : null };
      const newChannel = !!linked && state.telegramChatId !== binding.chatId;
      if (settings.alertsEnabled) for (const [key, condition] of Object.entries(conditions)) {
        const before = previousConditions?.[key];
        const observedActive = condition.active;
        const consecutive = observedActive ? (before?.consecutive || 0) + 1 : 0;
        if (condition.persistence && consecutive < condition.persistence && condition.severity !== 'critical') condition.active = false;
        const repeated = before?.active && timestamp - (before.notifiedAt || 0) >= COOLDOWN;
        const escalated = condition.active && before?.active && condition.severity === 'critical' && before.severity !== 'critical';
        if (condition.active && (!before?.active || repeated || escalated || newChannel)) {
          events.push({ id: randomUUID(), key, type: condition.type, severity: condition.severity,
            title: condition.title, message: condition.message, ts: iso, sourceTs: condition.sourceTs,
            ...(condition.marketId ? { marketId: condition.marketId } : {}), status: 'active', telegramSent: false });
          next.conditions[key] = { active: true, severity: condition.severity, notifiedAt: timestamp };
        } else if (!condition.active && before?.active) {
          events.push({ id: randomUUID(), key, type: condition.type, severity: 'info', title: 'Reading recovered',
            message: condition.type === 'data' ? condition.title.replace(' needs attention', '') + ' is fresh again.'
              : condition.type === 'lending' ? condition.title + ' is within your alert limits or has no outstanding debt.' : condition.message,
            ts: iso, sourceTs: condition.sourceTs, status: 'recovered', telegramSent: false });
          next.conditions[key] = { active: false, notifiedAt: timestamp };
        } else next.conditions[key] = before ? { ...before, active: condition.active, severity: condition.severity }
          : { active: false, notifiedAt: 0 };
        Object.assign(next.conditions[key], { consecutive, firstSeen: condition.firstSeen ?? null, anchor: condition.anchor ?? null });
      }
      const dailyDue = !!(!automaticDaily && automaticDailyDate !== day.day && settings.dailyEnabled && day.time >= settings.dailyTime && state.dailyDate !== day.day);
      if (dailyDue) {
        const text = summarize(context);
        events.push({ id: randomUUID(), key: 'daily:' + day.day, type: 'daily', severity: 'info',
          title: 'Daily summary', message: text, ts: iso, sourceTs: context.asOf || iso, status: 'daily', telegramSent: false });
        next.dailyDate = day.day;
      }
      const alerts = [...(await store.get('alerts') || []), ...events].slice(-30);
      const entries = [{ key: 'monitor:state', value: next }, { key: 'alerts', value: alerts },
        { key: 'lastCheck', value: { ts: iso, status: 'checked', nextIntendedCheck: new Date(timestamp + 300000).toISOString(),
          degraded: deliveryFailed || limitations.length > 0 || (context.sources || []).some(source => ['lending','lp'].includes(source.name) && source.status !== 'fresh'),
          ...(deliveryFailed ? { delivery: 'queued' } : {}), limitations, sources: context.sources || [] } },
        { key: 'monitor:lastSuccess', value: { ts: iso } }];
      if (dailyDue) {
        const messages = await store.get('messages') || [];
        const brief = events.find(e => e.type === 'daily');
        entries.push({ key: 'messages', value: [...messages, { role: 'assistant', content: brief.message, ts: iso,
          source: 'monitor', id: brief.key }].slice(-24) });
      }
      if (events.length && linked) {
        const remaining = pending ? pending.items.slice(pending.itemIndex).map((item, index) => ({ ...item,
          sentParts: index === 0 ? pending.sentParts || 0 : item.sentParts || 0 })) : [];
        const added = events.map(e => ({ alertId: e.id, type: e.type, key: e.key, severity: e.severity,
          status: e.status, ...(e.type === 'daily' ? { day: day.day } : {}),
          text: e.title + '\n' + e.message }));
        const items = [...remaining, ...added].sort((a,b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
        pending = { chatId: binding.chatId, items, itemIndex: 0, sentParts: items[0]?.sentParts || 0, ts: iso };
        entries.push({ key: 'monitor:pending', value: pending });
      }
      await commit(entries);
      state = next;
      if (!deliveryFailed) try { await deliver(); } catch {
        deliveryFailed = true;
        await commit([{ key: 'lastCheck', value: { ...entries.find(entry => entry.key === 'lastCheck').value, degraded: true, delivery: 'queued' } }]);
      }
      // A bot outage must never suppress newly observed critical dashboard
      // conditions. Keep the verified risk pass and durable outbox, but report
      // delivery failure so Cron prioritizes recovery over new strategy AI.
      return json(res, deliveryFailed ? 503 : 200, { ok: !deliveryFailed, alerts: events.length, daily: dailyDue, telegram: !!linked, checkedAt: iso,
        ...(deliveryFailed ? { error: 'Telegram delivery is queued. The next scheduled check can retry.' } : {}) });
    } catch {
      if (commit) { try { await commit([{key:'lastCheck',value:{ts:new Date(now()).toISOString(),status:'failed',degraded:true,errorCategory:'monitor_unavailable'}}]); } catch {} }
      return json(res, 503, { error: 'The monitoring check did not finish. The next scheduled check can retry.' });
    } finally { if (monitor) { try { await monitor.release(); } catch {} } }
  };
}

export default createMonitorHandler();
