/* Private state on the Cloudflare D1 free-plan binding. No paid provider or
   process-memory fallback: cold starts must agree on sessions, pairing and alerts. */
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { httpError } from './_agent-http.mjs';

const PREFIX = 'tiger:agent:v1:';
const TABLE = 'agent_state';
// The database clock prevents a queued request from extending an expired lease.
// The bound clock also makes expiry deterministic in local fixtures.
const CLOCK = "MAX(?, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))";
const STORAGE_ERROR = 'Private agent storage is unavailable. Check the free-plan allowance and try again later.';

export function createAgentStore(env = process.env, { now = Date.now, timeoutMs = 8000 } = {}) {
  const db = env.AGENT_DB;
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function')
    throw httpError(503, 'Private agent storage has not been connected to the free worker yet.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('Invalid private state timeout');
  async function bounded(operation) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(httpError(503, 'Private agent storage did not respond.')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  const clock = () => {
    const value = typeof now === 'function' ? now() : now;
    if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid private state clock');
    return value;
  };
  const key = value => {
    if (typeof value !== 'string' || !value || value.length > 300) throw Error('Invalid private state key');
    return PREFIX + value;
  };
  const encode = value => {
    let text;
    try { text = JSON.stringify(value); } catch { throw Error('Invalid private state value'); }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 524288) throw Error('Invalid private state value');
    return text;
  };
  const decode = value => {
    if (value == null) return null;
    try { return JSON.parse(value); } catch { throw httpError(503, 'Private agent state could not be read.'); }
  };
  const expiry = (seconds, at) => {
    if (seconds === undefined) return null;
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 366 * 86400) throw Error('Invalid private state expiry');
    const value = at + seconds * 1000;
    if (!Number.isSafeInteger(value)) throw Error('Invalid private state expiry');
    return value;
  };
  const prepared = (sql, args) => db.prepare(sql).bind(...args);
  async function first(sql, args) {
    try { return await bounded(() => prepared(sql, args).first()); }
    catch { throw httpError(503, STORAGE_ERROR); }
  }
  async function run(sql, args) {
    try {
      const result = await bounded(() => prepared(sql, args).run());
      if (result?.success === false || !Number.isSafeInteger(result?.meta?.changes)) throw Error();
      return result.meta.changes;
    } catch { throw httpError(503, STORAGE_ERROR); }
  }
  const validateEntries = entries => {
    if (!Array.isArray(entries) || !entries.length || entries.length > 12) throw Error('Invalid private state update');
    const at = clock();
    return entries.map(entry => {
      if (!entry || typeof entry !== 'object') throw Error('Invalid private state update');
      return { key: key(entry.key), remove: entry.remove === true,
        value: entry.remove ? null : encode(entry.value ?? null),
        expiresAt: expiry(entry.ttlSeconds, at) };
    });
  };
  const ownsSQL = `SELECT 1 FROM ${TABLE} WHERE key=? AND value=? AND expires_at>${CLOCK}`;
  function writeStatements(entries, fence) {
    return entries.map(entry => {
      if (entry.remove) {
        return prepared(`DELETE FROM ${TABLE} WHERE key=?${fence ? ` AND EXISTS (${ownsSQL})` : ''}`,
          [entry.key, ...(fence ? [fence.key, fence.token, fence.at] : [])]);
      }
      return prepared(`INSERT INTO ${TABLE} (key,value,expires_at) SELECT ?,?,?${fence ? ` WHERE EXISTS (${ownsSQL})` : ' WHERE 1'}
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`,
      [entry.key, entry.value, entry.expiresAt, ...(fence ? [fence.key, fence.token, fence.at] : [])]);
    });
  }
  async function batch(statements) {
    try {
      const result = await bounded(() => db.batch(statements));
      if (!Array.isArray(result) || result.length !== statements.length || result.some(r => r?.success === false)) throw Error();
      return result;
    } catch { throw httpError(503, STORAGE_ERROR); }
  }
  const store = {
    get: async name => {
      const row = await first(`SELECT value FROM ${TABLE} WHERE key=? AND (expires_at IS NULL OR expires_at>${CLOCK})`, [key(name), clock()]);
      return decode(row?.value);
    },
    set: async (name, value, options = {}) => {
      const at = clock(), expiresAt = expiry(options.ttlSeconds, at);
      const row = await first(`INSERT INTO ${TABLE} (key,value,expires_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at
        ${options.nx ? `WHERE ${TABLE}.expires_at IS NOT NULL AND ${TABLE}.expires_at<=${CLOCK}` : ''}
        RETURNING key`, [key(name), encode(value), expiresAt, ...(options.nx ? [at] : [])]);
      return !!row;
    },
    del: async name => run(`DELETE FROM ${TABLE} WHERE key=?`, [key(name)]),
    take: async name => {
      const row = await first(`DELETE FROM ${TABLE} WHERE key=? AND (expires_at IS NULL OR expires_at>${CLOCK}) RETURNING value`, [key(name), clock()]);
      return decode(row?.value);
    },
    increment: async (name, seconds) => {
      const at = clock(), expiresAt = expiry(seconds, at);
      if (expiresAt === null) throw Error('A counter needs an expiry');
      const expired = `${TABLE}.expires_at IS NOT NULL AND ${TABLE}.expires_at<=${CLOCK}`;
      const results = await batch([
        prepared(`INSERT INTO ${TABLE} (key,value,expires_at) VALUES (?,'1',?)
          ON CONFLICT(key) DO UPDATE SET
            value=CASE WHEN ${expired} THEN '1'
              WHEN json_type(${TABLE}.value)<>'integer' OR CAST(${TABLE}.value AS INTEGER)<0 THEN json('invalid counter')
              ELSE CAST(CAST(${TABLE}.value AS INTEGER)+1 AS TEXT) END,
            expires_at=CASE WHEN ${expired} THEN excluded.expires_at ELSE ${TABLE}.expires_at END
          RETURNING value`, [key(name), expiresAt, at, at]),
        // Bounded cleanup prevents expired request/session records accumulating.
        prepared(`DELETE FROM ${TABLE} WHERE key IN (SELECT key FROM ${TABLE}
          WHERE expires_at IS NOT NULL AND expires_at<=${CLOCK} ORDER BY expires_at LIMIT 32)`, [at]),
      ]);
      const value = Number(results[0].results?.[0]?.value);
      if (!Number.isSafeInteger(value) || value < 1) throw httpError(503, 'Private agent counters could not be read.');
      return value;
    },
    setMany: async entries => { await batch(writeStatements(validateEntries(entries))); return 1; },
    lock: async (name, seconds) => {
      if (seconds === undefined) throw Error('A lock needs an expiry');
      const nameKey = 'lock:' + name, lockKey = key(nameKey), token = randomBytes(24).toString('hex');
      if (!await store.set(nameKey, token, { nx: true, ttlSeconds: seconds })) return null;
      const encoded = encode(token);
      const owns = async () => !!await first(ownsSQL, [lockKey, encoded, clock()]);
      return {
        assertOwned: async () => { if (!await owns()) throw httpError(409, 'This agent request expired. Please try again.'); },
        commit: async entries => {
          const changes = validateEntries(entries), at = clock();
          if (changes.some(e => e.key === lockKey)) throw Error('A fenced update cannot change its own lock');
          // Both guards must succeed. A failed guard aborts the D1 transaction,
          // including writes made before a lease expired during the batch.
          const guard = () => prepared(`SELECT CASE WHEN EXISTS (${ownsSQL}) THEN 1 ELSE json('agent lock expired') END AS owned`, [lockKey, encoded, at]);
          try { await batch([guard(), ...writeStatements(changes, { key: lockKey, token: encoded, at }), guard()]); }
          catch (error) { if (!await owns()) throw httpError(409, 'This agent request expired. Please try again.'); throw error; }
          return 1;
        },
        release: () => run(`DELETE FROM ${TABLE} WHERE key=? AND value=?`, [lockKey, encoded]),
      };
    },
  };
  return store;
}
