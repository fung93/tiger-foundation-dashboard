/* Execute the actual D1 SQL against local SQLite, including atomic batch rollback.
   Python's standard-library SQLite keeps the fixture compatible with Node 20.
   No Cloudflare account, network service, model or bot is contacted. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createAgentStore } from '../api/_agent-store.mjs';

const PYTHON = String.raw`
import json, sqlite3, sys
data=json.load(sys.stdin)
db=sqlite3.connect(sys.argv[1], timeout=10)
db.row_factory=sqlite3.Row
try:
    db.executescript(data['schema'])
    if data.get('batch'): db.execute('BEGIN IMMEDIATE')
    out=[]
    for i,q in enumerate(data['queries']):
        fault=data.get('fault')
        if fault and fault['index']==i: db.execute(fault['sql'],fault.get('params',[]))
        before=db.total_changes
        cursor=db.execute(q['sql'],q.get('params',[]))
        rows=[dict(row) for row in cursor.fetchall()] if cursor.description else []
        out.append({'success':True,'results':rows,'meta':{'changes':db.total_changes-before}})
    db.commit()
    print(json.dumps({'result':out}))
except Exception as error:
    db.rollback()
    print(json.dumps({'error':str(error)}))
finally:
    db.close()
`;
const directory = mkdtempSync(join(tmpdir(), 'tiger-d1-store-'));
const schema = readFileSync(new URL('../cloudflare/migrations/0001_agent.sql', import.meta.url), 'utf8');
const fixturePath = join(directory, 'private-state.sqlite');
let python = process.platform === 'win32' ? 'python' : 'python3';
function execute(queries, { batch = false, fault } = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(python, ['-c', PYTHON, fixturePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    process.stdout.on('data', chunk => { output += chunk; }); process.stderr.on('data', chunk => { errors += chunk; });
    process.once('error', reject);
    process.once('close', code => {
      if (code !== 0) return reject(Error(errors || 'SQLite fixture failed'));
      try { const value = JSON.parse(output); if (value.error) reject(Error(value.error)); else resolve(value.result); }
      catch (error) { reject(error); }
    });
    process.stdin.end(JSON.stringify({ schema, queries, batch, fault }));
  });
}
const binding = {
  fail: false, fault: null,
  prepare(sql) {
    return { bind(...params) {
      return { sql, params,
        first: async () => { if (binding.fail) throw Error('Private provider failure'); return (await execute([{ sql, params }]))[0].results[0] ?? null; },
        run: async () => { if (binding.fail) throw Error('Private provider failure'); return (await execute([{ sql, params }]))[0]; },
        all: async () => { if (binding.fail) throw Error('Private provider failure'); return (await execute([{ sql, params }]))[0]; },
      };
    } };
  },
  async batch(statements) {
    if (binding.fail) throw Error('Private provider failure');
    const fault = binding.fault; binding.fault = null;
    return execute(statements.map(({ sql, params }) => ({ sql, params })), { batch: true, fault });
  },
};
let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const rejects = async (action, status, note) => { await assert.rejects(action, error => error.status === status, note); checks++; };
let at = Date.now() + 86400000;
const store = createAgentStore({ AGENT_DB: binding }, { now: () => at });
const other = createAgentStore({ AGENT_DB: binding }, { now: () => at });
const raw = async (sql, params = []) => (await execute([{ sql, params }]))[0].results;
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('The D1 binding must never fall back to a paid network provider'); };
try {
  assert.throws(() => createAgentStore({}), error => error.status === 503); checks++;
  check(await store.get('missing'), null, 'Missing private state stays absent');
  check(await store.set('settings', { health: 1.2, text: '虎 🐯', empty: null }), true, 'Private JSON persists through the actual SQL');
  check(await other.get('settings'), { health: 1.2, text: '虎 🐯', empty: null }, 'Independent serverless instances see the same durable state');
  check(await store.set('settings', { health: 2 }, { nx: true }), false, 'NX cannot overwrite a persistent key');
  check(await store.set('session', 'owner', { ttlSeconds: 2 }), true, 'Expiring sessions can be saved');
  check(await store.set('session', 'intruder', { nx: true, ttlSeconds: 2 }), false, 'NX cannot overwrite a live session');
  at += 1999; check(await store.get('session'), 'owner', 'A session is readable just before expiry');
  at += 1; check(await store.get('session'), null, 'Exact TTL boundary is expired');
  check(await store.set('session', 'replacement', { nx: true, ttlSeconds: 2 }), true, 'NX may atomically replace an expired row');
  check(await store.get('session'), 'replacement', 'A replacement keeps its own value');
  await store.set('pair:one-time', { issuedAt: at }, { ttlSeconds: 60 });
  const invitations = await Promise.all([store.take('pair:one-time'), other.take('pair:one-time')]);
  check(invitations.filter(Boolean).length, 1, 'Concurrent claims consume one invitation exactly once');
  check(invitations.find(Boolean), { issuedAt: at }, 'The claimed invitation retains its JSON content');
  check(await store.take('pair:one-time'), null, 'A consumed invitation cannot be claimed again');
  await store.set('expired:pair', 'invalid', { ttlSeconds: 1 }); at += 1000;
  check(await store.take('expired:pair'), null, 'An expired invitation never becomes a valid take');
  check(await store.increment('usage', 2), 1, 'Counters begin at one');
  check(await other.increment('usage', 2), 2, 'Counters are shared across instances');
  const counted = await Promise.all([store.increment('usage', 2), other.increment('usage', 2)]);
  check(counted.sort((a,b) => a-b), [3,4], 'Concurrent increments do not lose updates');
  at += 1000; check(await store.increment('usage', 2), 5, 'Incrementing does not slide the counter expiry');
  at += 1000; check(await store.increment('usage', 2), 1, 'An expired rate window resets atomically');
  await store.set('invalid-counter', { fake: 1 });
  await rejects(() => store.increment('invalid-counter', 60), 503, 'Corrupt counters fail closed rather than bypassing usage limits');
  check(await store.get('invalid-counter'), { fake: 1 }, 'A failed counter transaction retains prior state');
  await store.setMany([{ key: 'messages', value: ['one'] }, { key: 'settings', value: { health: 1.5 } }]);
  check(await store.get('messages'), ['one'], 'Batch saves include the shared conversation');
  check(await store.get('settings'), { health: 1.5 }, 'Batch saves include the matching preferences');
  await store.setMany([{ key: 'pair:active', value: 'old' }, { key: 'pair:active', remove: true }, { key: 'pair:active', value: 'new' }]);
  check(await store.get('pair:active'), 'new', 'A batch preserves duplicate-key order used by pairing rotation');

  const historyPrefix = 'record:decision:';
  for (const id of ['001', '002', '003', '004', '005']) await store.putImmutable(historyPrefix + id, { id });
  await store.set(historyPrefix + '000-expired', { invalid: true }, { ttlSeconds: 1 });
  at += 1000;
  let page = await store.list(historyPrefix, { limit: 2 });
  check(page.items.map(item => item.value.id), ['001', '002'], 'Forward history starts at the first unexpired record');
  check(page.cursor, historyPrefix + '002', 'The history cursor is the last returned key, without offset scanning');
  const second = await other.list(historyPrefix, { cursor: page.cursor, limit: 2 });
  check(second.items.map(item => item.value.id), ['003', '004'], 'A second instance resumes the same indexed history page');
  const last = await store.list(historyPrefix, { cursor: second.cursor, limit: 2 });
  check(last.items.map(item => item.value.id), ['005'], 'The final history page has no duplicates or expired entries');
  check(last.cursor, null, 'A final partial page has no continuation cursor');
  const beyond = await store.list(historyPrefix, { cursor: historyPrefix + '999', limit: 2 });
  check(beyond, { items: [], cursor: null }, 'A cursor beyond the final record returns an empty bounded page');
  page = await store.list(historyPrefix, { reverse: true, limit: 2 });
  check(page.items.map(item => item.value.id), ['005', '004'], 'Newest-first history returns descending keys');
  const older = await store.list(historyPrefix, { reverse: true, cursor: page.cursor, limit: 3 });
  check(older.items.map(item => item.value.id), ['003', '002', '001'], 'Newest-first continuation does not repeat the boundary record');
  check(older.cursor, null, 'An exact terminal page does not create a false continuation');
  for (const prefix of ['literal%:', 'literal_:', '虎🐯:', '終🐯']) {
    await store.putImmutable(prefix + '001', { prefix });
    await store.putImmutable(prefix.replace(/[%_]|🐯/gu, 'X') + 'other', { unrelated: true });
    const literalPage = await store.list(prefix, { limit: 10 });
    check(literalPage.items.map(item => item.key), [prefix + '001'],
      'History prefix ' + prefix + ' is a literal key range, never a LIKE wildcard');
  }
  for (const options of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { reverse: 'true' }, { cursor: 'another:namespace' }]) {
    await rejects(() => store.list(historyPrefix, options), 400, 'Invalid page bounds or cross-namespace cursors are rejected');
  }
  await rejects(() => store.list('x'.repeat(241)), 400, 'History prefix size is bounded');
  await rejects(() => store.list(''), 400, 'An empty history prefix cannot expose the entire private namespace');
  const plan = await raw('EXPLAIN QUERY PLAN SELECT key,value FROM agent_state WHERE key>=? AND key<? ORDER BY key LIMIT ?',
    ['tiger:agent:v1:' + historyPrefix, 'tiger:agent:v1:record:decision;', 21]);
  check(plan.some(row => /SEARCH agent_state USING INDEX/i.test(row.detail)), true, 'History key ranges use the existing primary-key index');

  const immutable = 'record:evidence:immutable';
  check(await store.putImmutable(immutable, { original: true }), true, 'An immutable record is inserted once');
  check(await other.putImmutable(immutable, { replacement: true }), false, 'Immutable insertion cannot overwrite an existing record');
  check(await store.get(immutable), { original: true }, 'A rejected immutable insert leaves its original evidence intact');
  const winners = await Promise.all([store.putImmutable('record:evidence:race', { writer: 'a' }),
    other.putImmutable('record:evidence:race', { writer: 'b' })]);
  check(winners.filter(Boolean).length, 1, 'Concurrent immutable inserts authorize exactly one durable record');
  check(['a', 'b'].includes((await store.get('record:evidence:race')).writer), true, 'The winning immutable record persists across instances');

  const competitors = await Promise.all([store.lock('owner', 2), other.lock('owner', 2)]);
  check(competitors.filter(Boolean).length, 1, 'Only one concurrent owner lock is granted');
  const owner = competitors.find(Boolean);
  await owner.assertOwned(); checks++;
  await owner.commit([{ key: 'messages', value: ['verified'] }, { key: 'settings', value: { health: 1.8 } }]);
  check(await store.get('messages'), ['verified'], 'A live owner can commit shared history');
  check(await store.get('settings'), { health: 1.8 }, 'A live fenced commit saves matching preferences');
  await owner.commit([{ key: 'record:policy:001', value: { version: 1 }, immutable: true }]);
  check(await store.get('record:policy:001'), { version: 1 }, 'A live fenced commit can append immutable policy history');
  await rejects(() => owner.commit([{ key: 'messages', value: ['must roll back'] },
    { key: 'record:policy:001', value: { version: 999 }, immutable: true }]), 503,
    'An immutable collision fails the entire fenced transaction');
  check(await store.get('messages'), ['verified'], 'An immutable collision rolls back preceding mutable writes');
  check(await store.get('record:policy:001'), { version: 1 }, 'An immutable collision cannot rewrite the original policy');
  at += 2000;
  await rejects(() => owner.assertOwned(), 409, 'Expired owners cannot claim ownership');
  await rejects(() => owner.commit([{ key: 'messages', value: ['expired overwrite'] }]), 409, 'An expired owner cannot commit');
  await rejects(() => owner.commit([{ key: 'record:policy:expired', value: { version: 2 }, immutable: true }]), 409,
    'An expired owner cannot append an immutable record');
  check(await store.get('record:policy:expired'), null, 'An expired append creates no policy history');
  check(await store.get('messages'), ['verified'], 'Expired commits leave existing history intact');
  const successor = await other.lock('owner', 2);
  check(!!successor, true, 'A new owner can take an expired lease');
  await successor.commit([{ key: 'messages', value: ['new owner'] }]);
  await rejects(() => owner.commit([{ key: 'messages', value: ['stale owner'] }]), 409, 'A stale token cannot overwrite its successor');
  check(await owner.release(), 0, 'A stale release cannot delete the newer owner token');
  await successor.assertOwned(); checks++;
  check(await store.get('messages'), ['new owner'], 'Successor data survives old-owner operations');

  binding.fault = { index: 2, sql: 'UPDATE agent_state SET expires_at=0 WHERE key=?', params: ['tiger:agent:v1:lock:owner'] };
  await assert.rejects(() => successor.commit([{ key: 'messages', value: ['partial overwrite'] }, { key: 'settings', value: { health: 9 } }])); checks++;
  check(await store.get('messages'), ['new owner'], 'A guard failure during the batch rolls back earlier writes');
  check(await store.get('settings'), { health: 1.8 }, 'A guard failure cannot partially change preferences');
  await successor.assertOwned(); checks++;
  check(await successor.release(), 1, 'The valid owner releases its own lease');
  check(!!await store.lock('owner', 1), true, 'A released owner lock can be acquired again');
  await store.set("unsafe'; DROP TABLE agent_state;--", { safe: true });
  check(await store.get("unsafe'; DROP TABLE agent_state;--"), { safe: true }, 'Private state names are SQL parameters, never executable SQL');
  await store.set('broken-json', 'placeholder');
  await raw('UPDATE agent_state SET value=? WHERE key=?', ['not json', 'tiger:agent:v1:broken-json']);
  await rejects(() => store.get('broken-json'), 503, 'Malformed saved JSON cannot silently become empty state');
  await assert.rejects(() => store.set('huge', 'x'.repeat(524288))); checks++;
  await assert.rejects(() => store.set('invalid-expiry', true, { ttlSeconds: 0 })); checks++;
  await assert.rejects(() => store.lock('invalid-permanent-lock')); checks++;
  await assert.rejects(() => store.setMany([])); checks++;
  await assert.rejects(() => store.setMany([{ key: immutable, remove: true, immutable: true }]), /cannot delete/); checks++;
  binding.fail = true;
  await rejects(() => store.get('settings'), 503, 'A free storage outage fails clearly without a paid fallback');
  await rejects(() => store.list(historyPrefix), 503, 'A history read outage cannot masquerade as an empty journal');
  await rejects(() => store.putImmutable('record:evidence:unwritten', { facts: true }), 503,
    'Immutable record creation also fails closed during a storage outage');
  binding.fail = false;
  const stalled = createAgentStore({ AGENT_DB: { prepare: () => ({ bind: () => ({ first: () => new Promise(() => {}) }) }), batch() {} } }, { timeoutMs: 5 });
  await rejects(() => stalled.get('settings'), 503, 'A stalled binding cannot leave a private request waiting indefinitely');
  const stalledHistory = createAgentStore({ AGENT_DB: { prepare: () => ({ bind: () => ({ all: () => new Promise(() => {}) }) }), batch() {} } }, { timeoutMs: 5 });
  await rejects(() => stalledHistory.list(historyPrefix), 503, 'A stalled journal page has the same bounded storage deadline');
  at += 100000;
  const expiredBefore = (await raw('SELECT key FROM agent_state WHERE expires_at IS NOT NULL AND expires_at<=?', [at])).length;
  await store.increment('cleanup-trigger', 60);
  const expiredAfter = (await raw('SELECT key FROM agent_state WHERE expires_at IS NOT NULL AND expires_at<=?', [at])).length;
  check(expiredAfter < expiredBefore, true, 'Normal use cleans expired private state with a bounded indexed query');
  check(await store.get('messages'), ['new owner'], 'Cleanup never removes permanent shared history');
  check((await raw('PRAGMA index_list(agent_state)')).some(row => row.name === 'agent_state_expiry'), true, 'The migration provides an expiry index for bounded cleanup');
  console.log('Free D1 private agent store: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = realFetch; rmSync(directory, { recursive: true, force: true }); }
