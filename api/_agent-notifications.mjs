/* Telegram is a transport for the same private dashboard agent. Messages are
   plain text; model/user content is never interpreted as Telegram HTML. */
export function telegramParts(text) {
  const characters = Array.from(String(text || '')).slice(0, 16000);
  const parts = [];
  while (characters.length) parts.push(characters.splice(0, 3500).join(''));
  return parts.length ? parts : ['There is no new reading to report.'];
}

export function telegramKeyboard(origin) {
  return { inline_keyboard: [
    [{ text: 'Summary', callback_data: 'summary' }, { text: 'Lending health', callback_data: 'lending' }],
    [{ text: 'LP performance', callback_data: 'lp' }, { text: 'Open dashboard', url: origin + '/agent.html' }],
  ] };
}

export async function telegramRequest(method, body, { env = process.env, fetcher = fetch, timeoutMs = 8000 } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram is not connected.');
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Telegram did not respond in time.')); }, timeoutMs);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetcher('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) throw new Error('Telegram delivery is temporarily unavailable.');
      const result = await response.json();
      if (!result?.ok) throw new Error('Telegram could not accept the message.');
      return result.result;
    })(), expired]);
  } finally { clearTimeout(timer); }
}

export async function sendTelegram(chatId, text, { env = process.env, fetcher = fetch, origin,
  startPart = 0, beforePart = async () => {}, onPart = async () => {} } = {}) {
  const parts = telegramParts(text);
  for (let part = startPart; part < parts.length; part++) {
    await beforePart();
    await telegramRequest('sendMessage', { chat_id: chatId, text: parts[part],
      disable_web_page_preview: true,
      ...(origin && part === parts.length - 1 ? { reply_markup: telegramKeyboard(origin) } : {}),
    }, { env, fetcher });
    // Persist each acknowledged part. A network failure after Telegram accepts a
    // message but before its response reaches us can still cause a retry duplicate.
    await onPart(part + 1);
  }
}

const myt = ts => new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur',
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' MYT';
const finite = value => Number.isFinite(value);
const watchSources = new Set(['lending', 'lp']);

/* Missing/old readings never clear an existing lending warning. An explicitly
   verified no-position reading can clear it. This function makes no RPCs. */
export function monitorConditions(context, settings, { policy, previous = {}, decisions = [], now = Date.now() } = {}) {
  const conditions = {};
  for (const source of context.sources || []) {
    if (!watchSources.has(source.name)) continue;
    const active = source.status !== 'fresh';
    conditions['data:' + source.name] = { active, type: 'data', severity: 'warning',
      title: source.name === 'lp' ? 'LP data needs attention' : 'Lending data needs attention',
      message: source.name === 'lp' ? 'The LP reading is ' + source.status + '. Earnings and changes for affected positions cannot be verified.'
        : 'The lending reading is ' + source.status + '. Health and borrowing capacity for affected markets cannot be verified.',
      sourceTs: source.ts || null,
    };
  }
  for (const market of context.lending?.markets || []) {
    const fresh = market.status === 'fresh'
      || (market.status === undefined && context.lending.status === 'fresh');
    if (!fresh || !market.id || market.error) continue;
    const key = 'lending:' + market.id, label = market.label || market.key || 'Lending market';
    const sourceTs = market.ts || context.lending.ts || null;
    if (market.no_position === true || market.debt_amount === 0) {
      conditions[key] = { active: false, type: 'lending', title: label,
        message: label + ' has no outstanding debt in the verified reading.', sourceTs,
        marketId: market.id };
      continue;
    }
    if (!finite(market.debt_amount) || market.debt_amount < 0 || !finite(market.health) || market.health < 0
      || !finite(market.ltv) || market.ltv < 0) continue;
    const limits = policy?.constraints?.marketLimits?.[market.key] || {};
    const healthLimit = limits.targetHealth ?? settings.healthThreshold;
    const ltvLimit = Math.min(limits.maxLtvPct ?? settings.ltvThreshold, Number.isFinite(market.lltv) ? market.lltv * 100 : 100);
    const wasActive = previous[key]?.active === true;
    const healthLow = market.health < healthLimit + (wasActive ? 0.01 : 0);
    const ltvHigh = market.ltv * 100 > ltvLimit - (wasActive ? 0.5 : 0);
    const critical = market.health < 1;
    const health = market.health.toFixed(4), ltv = (market.ltv * 100).toFixed(2) + '%';
    conditions[key] = { active: critical || healthLow || ltvHigh, type: 'lending',
      severity: critical ? 'critical' : 'warning', title: label + (critical ? ' below liquidation boundary' : ' lending alert'),
      message: label + ': health ' + health + ', LTV ' + ltv + '. '
        + (critical ? 'Health is below the liquidation boundary of 1.' : 'Your alert limits are health '
          + healthLimit + ' and LTV ' + ltvLimit + '%.')
        + (sourceTs ? ' Reading: ' + myt(sourceTs) + '.' : ''),
      sourceTs, marketId: market.id,
    };
  }
  if (context.snapshot?.reconciliation?.lp?.status) {
    const mismatch = context.snapshot.reconciliation.lp.status === 'mismatch';
    conditions.reconciliation = { active: mismatch, type: 'data', severity: 'warning', persistence: 2,
      title: 'Portfolio reconciliation', message: mismatch ? 'LP subtotal does not reconcile. Allocation sizing is blocked.' : 'LP subtotal is reconciled.',
      sourceTs: context.asOf || null };
  }
  const triggers = policy?.constraints?.lpReviewTriggers || {};
  if (context.lp?.status === 'fresh') for (const row of (context.lp.positions || []).slice(0,100)) {
    const p = row.canonical;
    if (!p || p.status !== 'observed' || typeof p.inRange !== 'boolean' || !p.block) continue;
    const key = 'lp:range:' + [p.chain,p.owner,p.id].join(':'), firstSeen = previous[key]?.firstSeen || now;
    const elapsedHours = (now - firstSeen) / 3600000;
    if (triggers.outOfRange === true || triggers.maxOutOfRangeHours != null) conditions[key] = {
      active: !p.inRange && (triggers.maxOutOfRangeHours == null || elapsedHours >= triggers.maxOutOfRangeHours),
      firstSeen: !p.inRange ? firstSeen : null, persistence: 2, type: 'lp', severity: 'warning', title: 'LP #' + p.id + ' range review',
      message: p.inRange ? 'Verified LP position is back in range.' : 'Verified LP position is out of range; review the recorded strategy. No transaction was made.',
      sourceTs: p.observedAt };
  }
  if (triggers.rewardChangePct != null || triggers.priceMovePct != null) for (const pool of [...(context.strategy?.pools || []),...(context.strategy?.fee_pools || [])].slice(0,100)) {
    if (!['fresh','partial'].includes(pool.status) || !pool.pool || !Number.isFinite(Date.parse(pool.ts)) || now-Date.parse(pool.ts)<-30000 || now-Date.parse(pool.ts)>=90000) continue;
    if (triggers.rewardChangePct != null && Number.isFinite(pool.campaign?.start) && Number.isFinite(pool.campaign?.end) && pool.campaign.end > pool.campaign.start) {
      const key = 'lp:campaign:' + pool.pool, signature = pool.campaign.start + ':' + pool.campaign.end, anchor = previous[key]?.anchor ?? signature;
      const ended = pool.campaign.end * 1000 <= now;
      conditions[key] = { active: ended || signature !== anchor, persistence:2, anchor, type:'lp', severity:'warning',
        title:'LP campaign schedule review', message:ended ? 'The verified campaign reward period has ended. New earnings must be reviewed.' : 'The campaign schedule changed from its saved monitoring baseline.', sourceTs:pool.ts };
    }
    if (pool.status !== 'fresh') continue;
    if (triggers.rewardChangePct != null && Number.isFinite(pool.katPerDay)) {
      const key = 'lp:reward:' + pool.pool, anchor = previous[key]?.anchor ?? pool.katPerDay;
      const change = anchor > 0 ? Math.abs(pool.katPerDay / anchor - 1) * 100 : pool.katPerDay > 0 ? 100 : 0;
      conditions[key] = { active: change >= triggers.rewardChangePct, persistence: 2, anchor, type: 'lp', severity: 'warning',
        title: 'LP campaign reward review', message: 'Observed KAT campaign rate changed by ' + change.toFixed(2) + '% from the saved monitoring baseline. Future earnings need review.', sourceTs: pool.ts };
    }
    if (triggers.priceMovePct != null && Number.isFinite(pool.price) && pool.price > 0) {
      const key = 'lp:price:' + pool.pool, anchor = previous[key]?.anchor ?? pool.price;
      const change = Math.abs(pool.price / anchor - 1) * 100;
      conditions[key] = { active: change >= triggers.priceMovePct, persistence: 2, anchor, type: 'lp', severity: 'warning',
        title: 'LP token price review', message: 'Pool token ratio changed by ' + change.toFixed(2) + '% from the saved monitoring baseline.', sourceTs: pool.ts };
    }
  }
  for (const decision of decisions) {
    // Recurring reviews have their own follow-up schedule. Old daily briefs do
    // not generate an ever-growing set of review-due alerts or retrigger AI.
    if (decision.kind === 'portfolio_review') continue;
    if (['rejected','invalidated','superseded'].includes(decision.state) || !decision.reviewAt) continue;
    const key = 'review:' + decision.decisionId;
    conditions[key] = { active: Date.parse(decision.reviewAt) <= now, type: 'review', severity: 'info',
      title: 'Strategy review due', message: (decision.thesis || 'Saved strategy').slice(0,160) + '\nOpen your Decision journal to review it.', sourceTs: decision.updatedAt };
  }
  return conditions;
}

export function mytDayAndTime(timestamp) {
  // Malaysia is UTC+8 and has no daylight-saving changes.
  const shifted = new Date(timestamp + 8 * 3600000).toISOString();
  return { day: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}
