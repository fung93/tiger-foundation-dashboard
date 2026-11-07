/* Strategy notices share the existing monitor outbox and Telegram checkpoints.
   Only the monitor lease may deliver; no second concurrent sender is introduced. */
import { loadReviewInputs, reviewFeatureEnabled, reviewPaused } from './_agent-review-state.mjs';
import { readAgentState } from './_agent-store.mjs';
import { renderPortfolioReview } from './_agent-review-analysis.mjs';
import { sendTelegram } from './_agent-notifications.mjs';
import { getAgentOrigin } from './_agent-http.mjs';

export function reviewDeliveryAllowed(controls, settings, kind) {
  return controls.delivery === 'telegram' || controls.delivery === 'inherit'
    && (kind === 'daily' ? settings.dailyEnabled : settings.alertsEnabled);
}
export async function yieldReviewOutbox(store, lease) {
  if ((await store.get('monitor:pending'))?.kind !== 'strategy_reviews') return;
  const owner = await store.lock('owner', 15);
  if (!owner) throw Error('Private update in progress');
  try {
    const pending = await store.get('monitor:pending');
    if (pending?.kind !== 'strategy_reviews') return;
    const queue = await store.get('review:pending') || [];
    const remaining = pending.items.slice(pending.itemIndex).map((item, index) => ({ ...item,
      sentParts: index === 0 ? pending.sentParts || 0 : item.sentParts || 0 }));
    const merged = new Map(queue.map(item => [item.reportId, item]));
    for (const item of remaining) merged.set(item.reportId, item);
    await lease.commit([{ key: 'monitor:pending', remove: true },
      { key: 'review:pending', value: [...merged.values()].slice(-10), ttlSeconds: 7 * 86400 }], { alsoOwned: [owner] });
  } finally { await owner.release(); }
}
export async function deliverReviewNotices({ store, env, fetcher = fetch, now = Date.now, lease: suppliedLease } = {}) {
  const lease = suppliedLease || await store.lock('monitor', 90);
  if (!lease) return { status: 'queued' };
  const deadline = Date.now() + 12000; let chunks = 0;
  const commit = async (entries, { consumed = [], delivery } = {}) => {
    const owner = await store.lock('owner', 15);
    if (!owner) throw Error('Private update in progress');
    try {
      if (consumed.length) {
        const latest = await store.get('review:pending') || [];
        const remaining = latest.filter(item => !consumed.includes(item.reportId));
        entries.push(remaining.length ? { key: 'review:pending', value: remaining, ttlSeconds: 7 * 86400 } : { key: 'review:pending', remove: true });
      }
      if (delivery) {
        const saved = await readAgentState(store, ['review:state', 'alerts']), state = saved['review:state'] || {};
        entries.push({ key: 'review:state', value: { ...state, lastDelivery: { ...delivery, ts: new Date(now()).toISOString() } } });
        const alerts = saved.alerts || [];
        for (const alert of alerts) if (alert.reportId === delivery.reportId) {
          if (delivery.status === 'sent') alert.telegramSent = true;
          else if (delivery.status === 'cancelled') alert.deliveryCancelled = true;
        }
        entries.push({ key: 'alerts', value: alerts });
      }
      await lease.commit(entries, { alsoOwned: [owner] });
    } finally { await owner.release(); }
  };
  const ready = async item => {
    const { controls, settings, policy, raw } = await loadReviewInputs(store, ['telegram', item.reportId]);
    const binding = raw.telegram, report = raw[item.reportId];
    if (!reviewFeatureEnabled(env) || item.trigger !== 'manual' && !controls.enabled || reviewPaused(settings, now())
      || controls.revision !== item.controlsRevision || policy.version !== item.policyVersion
      || !reviewDeliveryAllowed(controls, settings, item.trigger) || !env.TELEGRAM_BOT_TOKEN || !binding
      || String(binding.chatId) !== String(item.chatId) || String(binding.userId) !== String(item.userId)
      || report?.kind !== 'portfolio_review' || report.schemaVersion !== 'agent-report-v1' || report.policyVersion !== policy.version) return null;
    const expired = !report.validUntil || Date.parse(report.validUntil) <= now();
    const text = renderPortfolioReview(report, { now: now(), forDelivery: true });
    return { text, expired, binding, origin: getAgentOrigin(env) };
  };
  try {
    let pending = await store.get('monitor:pending');
    if (pending && pending.kind !== 'strategy_reviews') return { status: 'queued' };
    if (!pending) {
      const queue = (await store.get('review:pending') || []).slice(0, 1), accepted = [], consumed = [];
      for (const item of queue) {
        consumed.push(item.reportId);
        if (await ready(item)) accepted.push({ ...item, type: 'review' });
      }
      if (!consumed.length) return { status: 'idle' };
      if (!accepted.length) {
        await commit([], { consumed, delivery: { status: 'cancelled', reportId: consumed.at(-1) } });
        return { status: 'cancelled' };
      }
      pending = { kind: 'strategy_reviews', chatId: accepted[0].chatId, userId: accepted[0].userId,
        items: accepted, itemIndex: 0, sentParts: accepted[0].sentParts || 0, ts: new Date(now()).toISOString() };
      await commit([{ key: 'monitor:pending', value: pending }], { consumed });
    }
    // One notice, at most three acknowledged chunks per invocation keeps D1
    // work below the Free limit; the next delivery Workflow resumes the cursor.
    if (pending.itemIndex < pending.items.length) {
      const item = pending.items[pending.itemIndex], delivery = await ready(item);
      if (!delivery) {
        pending.itemIndex++; pending.sentParts = 0;
        await commit([{ key: 'monitor:pending', value: pending }], { delivery: { status: 'cancelled', reportId: item.reportId } });
        return { status: 'queued' };
      }
      if (item.text !== delivery.text) { item.text = delivery.text; pending.sentParts = 0; await commit([{ key: 'monitor:pending', value: pending }]); }
      await sendTelegram(delivery.binding.chatId, delivery.text, { env, fetcher, origin: delivery.origin, startPart: pending.sentParts || 0,
        beforePart: async () => {
          await lease.assertOwned();
          if (chunks >= 3 || Date.now() >= deadline) throw Error('Delivery continues on the next check');
          const latest = await ready(item);
          if (!latest || latest.text !== delivery.text) throw Error('Delivery needs current preferences and freshness');
        },
        onPart: async count => { chunks++; pending.sentParts = count; await commit([{ key: 'monitor:pending', value: pending }]); } });
      pending.itemIndex++; pending.sentParts = pending.items[pending.itemIndex]?.sentParts || 0;
      await commit([{ key: 'monitor:pending', value: pending }], { delivery: { status: 'sent', reportId: item.reportId,
        content: delivery.expired ? 'dated_notice' : 'review' } });
    }
    if (pending.itemIndex < pending.items.length) return { status: 'queued' };
    await commit([{ key: 'monitor:pending', remove: true }]);
    return { status: 'sent' };
  } catch {
    // Provider prose and credentials are never copied into logs or status.
    return { status: 'queued' };
  } finally { if (!suppliedLease) await lease.release(); }
}
