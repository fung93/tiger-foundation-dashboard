/* Short, complete-only serverless reads. In-flight callers share one upstream pass;
   a failed refresh never borrows an expired answer or invents a new reading time. */
export function createLiveCache({ ttlMs = 8000, maxEntries = 8, complete = () => true } = {}) {
  const entries = new Map();
  return async function read(key, load) {
    let entry = entries.get(key);
    if (entry && entry.value !== undefined && entry.until > Date.now()) return entry.value;
    if (entry && entry.pending) return entry.pending;
    entry = { value: undefined, until: 0, pending: null };
    entries.set(key, entry);
    for (const [oldKey, old] of entries) {
      if (entries.size <= maxEntries) break;
      if (oldKey !== key && !old.pending) entries.delete(oldKey);
    }
    entry.pending = Promise.resolve().then(load).then((value) => {
      if (complete(value)) { entry.value = value; entry.until = Date.now() + ttlMs; }
      return value;
    }).finally(() => {
      entry.pending = null;
      if (entry.value === undefined && entries.get(key) === entry) entries.delete(key);
    });
    return entry.pending;
  };
}

/* Host is the platform-routed HTTP host, not a caller's forwarded-host override.
   Preview/custom domains keep separate caches and source snapshots. */
export function requestOrigin(req) {
  const host = req.headers && req.headers.host;
  if (typeof host !== 'string' || host.length > 300 || !/^[a-zA-Z0-9.:[\]-]+$/.test(host))
    throw new Error('A valid dashboard host is required.');
  const url = new URL('https://' + host);
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('A valid dashboard host is required.');
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && req.headers['x-forwarded-proto'] === 'http') url.protocol = 'http:';
  return url.origin;
}

/* The timeout covers response JSON as well as connection/header time. Racing the
   body also bounds implementations that fail to reject promptly after abort. */
export async function fetchJSON(url, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Saved dashboard reading timed out.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Saved dashboard reading HTTP ' + response.status);
      const value = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Saved dashboard reading is malformed.');
      return value;
    })(), expired]);
  } finally { clearTimeout(timer); }
}

export function lpViewComplete(view) {
  const health = view && view.health;
  return !!health && !view.error && !Object.keys(health.errors || {}).length
    && !(health.unread || []).length && !(health.unpriced || []).length
    && Object.values(health.behind || {}).every((blocks) => blocks === 0);
}

export function responseHeaders(res, complete = false) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', complete ? 's-maxage=10, stale-while-revalidate=5' : 'no-store');
}

export function savedBookValid(book, version) {
  const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  return record(book) && book.version === version && Array.isArray(book.wallets)
    && book.wallets.every((wallet) => typeof wallet === 'string' && /^0x[0-9a-f]{40}$/i.test(wallet))
    && record(book.positions) && record(book.tokens) && record(book.last_block)
    && Object.values(book.last_block).every((block) => Number.isSafeInteger(block) && block >= 0)
    && Array.isArray(book.events);
}

export function savedFables(data) {
  const state = data && data.fables;
  if (!state || !Array.isArray(state.ranges) || !Array.isArray(state.locks)
    || [...state.ranges, ...state.locks].some((item) => !item || typeof item.id !== 'string'
      || typeof item.wallet !== 'string' || !/^0x[0-9a-f]{40}$/i.test(item.wallet)))
    throw new Error('Saved Fables discovery is unavailable or malformed.');
  return state;
}
