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
export function monitorConditions(context, settings) {
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
    const healthLow = market.health < settings.healthThreshold;
    const ltvHigh = market.ltv * 100 > settings.ltvThreshold;
    const critical = market.health < 1;
    const health = market.health.toFixed(4), ltv = (market.ltv * 100).toFixed(2) + '%';
    conditions[key] = { active: critical || healthLow || ltvHigh, type: 'lending',
      severity: critical ? 'critical' : 'warning', title: label + (critical ? ' below liquidation boundary' : ' lending alert'),
      message: label + ': health ' + health + ', LTV ' + ltv + '. '
        + (critical ? 'Health is below the liquidation boundary of 1.' : 'Your alert limits are health '
          + settings.healthThreshold + ' and LTV ' + settings.ltvThreshold + '%.')
        + (sourceTs ? ' Reading: ' + myt(sourceTs) + '.' : ''),
      sourceTs, marketId: market.id,
    };
  }
  return conditions;
}

export function mytDayAndTime(timestamp) {
  // Malaysia is UTC+8 and has no daylight-saving changes.
  const shifted = new Date(timestamp + 8 * 3600000).toISOString();
  return { day: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}
