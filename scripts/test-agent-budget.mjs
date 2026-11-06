/* Exercise production budget SQL against independent real SQLite connections.
   No provider, model, Telegram bot or public financial writer is contacted. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createAgentBudget, AGENT_USAGE_SCHEMA } from '../api/_agent-budget.mjs';

const PYTHON = String.raw`
import json, sqlite3, sys
data=json.load(sys.stdin)
db=sqlite3.connect(sys.argv[1],timeout=10)
db.row_factory=sqlite3.Row
try:
    db.executescript(data['schema'])
    c=db.execute(data['sql'],data.get('params',[]))
    rows=[dict(r) for r in c.fetchall()] if c.description else []
    db.commit()
    print(json.dumps({'rows':rows}))
except Exception as error:
    db.rollback()
    print(json.dumps({'error':str(error)}))
finally:
    db.close()
`;
const directory = mkdtempSync(join(tmpdir(), 'tiger-ai-budget-'));
const path = join(directory, 'usage.sqlite');
const schema = readFileSync(new URL('../cloudflare/migrations/0001_agent.sql', import.meta.url), 'utf8')
  + readFileSync(new URL('../cloudflare/migrations/0002_agent_usage.sql', import.meta.url), 'utf8');
function execute(sql, params = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-c', PYTHON, path], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
    child.once('error', reject); child.once('close', code => {
      if (code !== 0) return reject(Error(errors || 'SQLite budget fixture failed'));
      try { const value = JSON.parse(output); if (value.error) reject(Error(value.error)); else resolve(value.rows); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ schema, sql, params }));
  });
}
let unavailable = false;
const binding = { prepare(sql) { return { bind(...params) { return { first: async () => {
  if (unavailable) throw Error('PRIVATE storage failure with credential');
  return (await execute(sql, params))[0] ?? null;
} }; } }; } };
const profile = { id: '@cf/qwen/qwen3-30b-a3b-fp8', version: 'fixture-2026-11-05',
  rates: { inputNeuronsPerMillion: 4625, outputNeuronsPerMillion: 30475 }, maxOutputTokens: 800 };
const messages = [{ role: 'user', content: 'PRIVATE_PROMPT_你好🐯' }];
const payload = (round = 0, additions = {}) => ({ profile, messages, request: { messages, max_tokens: 800 }, maxOutputTokens: 800, round, ...additions });
let at = Date.parse('2030-01-01T23:59:59Z');
const make = (jobId, limit = 5000, extra = {}) => createAgentBudget({ AGENT_DB: binding, AGENT_DAILY_NEURON_LIMIT: String(limit) },
  { jobId, now: () => at, ...extra });
let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const rejects = async (action, category, note) => { await assert.rejects(action, e => e.category === category, note); checks++; };
const reset = async () => { await execute('DELETE FROM agent_usage'); };
const beforeFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Budget tests cannot contact a provider'); };
try {
  assert.throws(() => createAgentBudget({}), e => e.category === 'configuration_missing'); checks++;
  assert.throws(() => make('invalid-limit', 0), e => e.category === 'configuration_missing'); checks++;
  const initial = await make('first').status();
  check(initial.schemaVersion, AGENT_USAGE_SCHEMA, 'Diagnostics identify the installed usage schema');
  check(initial.dailyLimitNeurons, 5000, 'The application starts with the proposed 5,000-neuron cap');
  check(initial.chargedNeurons, 0, 'A migrated but unused account has no inference charges');
  await execute("INSERT INTO agent_state(key,value) VALUES('fixture-session','\"owner\"')");
  const first = make('first');
  const attempt = await first.reserve(payload());
  check(attempt.outcome, 'reserved', 'The attempt is durable before an AI call can start');
  check(attempt.estimatedInputTokens > Buffer.byteLength(JSON.stringify(messages), 'utf8'), true, 'Reservation includes complete prompt bytes and protocol framing');
  check(attempt.maxOutputTokens, 800, 'The full possible output is reserved');
  check((await first.status()).chargedNeurons, attempt.reservedNeurons, 'Outstanding reservations immediately consume the shared cap');
  check(JSON.stringify(await execute('SELECT * FROM agent_usage')).includes('PRIVATE_PROMPT'), false, 'Prompts never enter the usage ledger');
  check((await execute("SELECT value FROM agent_state WHERE key='fixture-session'"))[0].value, '"owner"', 'The new migration preserves existing private sessions');
  const settled = await first.settle(attempt, { outcome: 'succeeded', usage: { inputTokens: 100, outputTokens: 20 } });
  check(settled.chargedNeurons, 1.072, 'Known Qwen usage is settled with exact integer token-rate arithmetic');
  check((await first.status()).chargedNeurons, 1.072, 'Settling releases only the unused estimated headroom');
  check((await first.status()).reservedNeurons, 0, 'Settled attempts no longer appear outstanding');
  check((await first.status()).lastSuccessfulInference, new Date(at).toISOString(), 'Diagnostics show actual recorded inference success');
  await first.settle(attempt, { outcome: 'succeeded', usage: { inputTokens: 200, outputTokens: 100 } });
  check((await first.status()).chargedNeurons, 1.072, 'Repeated settlement cannot change or duplicate a completed charge');
  await rejects(() => make('first').reserve(payload()), 'rate_limited', 'A restarted job cannot authorize its already-recorded attempt again');
  check((await first.status()).attempts, 1, 'Idempotent rejection does not insert a second usage row');
  const second = await first.reserve(payload(1));
  check(second.attempt, 1, 'A bounded second pass receives its own reservation');
  await rejects(() => first.reserve(payload(2)), 'configuration_missing', 'A third pass cannot bypass the two-call limit');
  await first.settle(second, { outcome: 'failed', errorCategory: 'invalid_model_output' });
  check((await execute('SELECT error_category FROM agent_usage WHERE reservation_id=?', [second.reservationId]))[0].error_category,
    'invalid_model_output', 'Only a safe failure category is retained');
  check((await first.status()).chargedNeurons, 1.072 + second.reservedNeurons, 'Missing provider usage conservatively retains its full estimate');

  const unknownBudget = make('timed-out');
  const unknown = await unknownBudget.reserve(payload());
  const ambiguous = await unknownBudget.settle(unknown, { outcome: 'outcome_unknown', usage: { inputTokens: 1, outputTokens: 1 }, errorCategory: 'PRIVATE raw error' });
  check(ambiguous.chargedMicroneurons, unknown.reservedMicroneurons, 'A timeout never proves inference was cancelled or refunds its reservation');
  check(ambiguous.usage, null, 'Ambiguous timeout usage is not recorded as confirmed actual usage');
  check(ambiguous.errorCategory, 'timeout', 'Unknown outcomes save a safe category rather than private error text');
  check((await unknownBudget.status()).unknownAttempts, 1, 'The operational status exposes uncertain attempts');
  const oldDate = (await unknownBudget.status()).utcDate;
  at += 1000;
  check((await unknownBudget.status()).utcDate === oldDate, false, 'The shared budget resets at the UTC boundary, which is 08:00 MYT');
  check((await unknownBudget.status()).chargedNeurons, unknown.reservedNeurons, 'Uncertain prior-day inference still encumbers today while settled old charges do not');
  check((await unknownBudget.status()).carriedReservedNeurons, unknown.reservedNeurons, 'Diagnostics name the cross-midnight outstanding reservation');
  await rejects(() => make('timed-out').reserve(payload()), 'timeout', 'A midnight restart still cannot duplicate a timed-out attempt');
  await unknownBudget.settle(unknown, { outcome: 'succeeded', usage: { inputTokens: 100, outputTokens: 20 } });
  check((await execute('SELECT charged_microneurons FROM agent_usage WHERE reservation_id=?', [unknown.reservationId]))[0].charged_microneurons,
    1072000, 'A later verified reconciliation settles the original day instead of billing the new day');
  check((await unknownBudget.status()).chargedNeurons, 0, 'Settled prior-day attempts no longer encumber today');

  await reset();
  at = Date.parse('2030-02-01T23:59:59Z');
  const crossing = make('midnight-in-flight', 40);
  const crossingAttempt = await crossing.reserve(payload());
  at += 1000;
  await rejects(() => make('after-midnight', 40).reserve(payload()), 'quota_exhausted',
    'An in-flight call cannot reset its reservation at midnight and permit a second over-budget call');
  await crossing.settle(crossingAttempt, { outcome: 'succeeded', usage: { inputTokens: 100, outputTokens: 20 } });
  check((await make('after-midnight', 40).status()).remainingNeurons, 40, 'A settled prior-day charge releases only its cross-day encumbrance');
  check((await make('after-midnight', 40).reserve(payload())).outcome, 'reserved', 'New-day inference is available once prior uncertainty is resolved');

  await reset();
  const raceA = make('dashboard-race', 40), raceB = make('telegram-race', 40);
  const race = await Promise.allSettled([raceA.reserve(payload()), raceB.reserve(payload())]);
  check(race.filter(r => r.status === 'fulfilled').length, 1, 'Different Worker instances cannot both reserve more than the same daily headroom');
  check(race.find(r => r.status === 'rejected').reason.category, 'quota_exhausted', 'The losing concurrent request receives an honest budget failure');
  const raceStatus = await raceA.status();
  check(raceStatus.attempts, 1, 'A denied budget request inserts no charge');
  check(raceStatus.chargedNeurons <= 40, true, 'Atomic reservation holds the exact daily budget invariant');
  await reset();
  const duplicates = await Promise.allSettled([make('same-job').reserve(payload()), make('same-job').reserve(payload())]);
  check(duplicates.filter(r => r.status === 'fulfilled').length, 1, 'Concurrent retries can authorize one inference only');
  check((await make('same-job').status()).attempts, 1, 'A unique job-attempt constraint survives independent database connections');

  await reset();
  const base = await make('base-request').reserve(payload());
  const toolRequest = { messages, max_tokens: 800, tools: [{ type: 'function', function: { name: 'calculateTargetHealth', description: 'x'.repeat(1000) } }] };
  const withTools = await make('tool-request').reserve(payload(0, { request: toolRequest }));
  check(withTools.estimatedInputTokens > base.estimatedInputTokens + 1000, true, 'Tool definitions and request options count toward the full input estimate');
  await rejects(() => make('output-overrun').reserve(payload(0, { maxOutputTokens: 801 })), 'configuration_missing', 'A request cannot exceed its profile output cap');
  await rejects(() => make('input-overrun').reserve(payload(0, { profile: { ...profile, maxInputTokens: 100 } })),
    'configuration_missing', 'Full request inputs cannot exceed the model profile input bound');
  const zero = await make('known-zero').reserve(payload());
  const zeroCharge = await make('known-zero').settle(zero, { outcome: 'failed', usage: { inputTokens: 0, outputTokens: 0 } });
  check(zeroCharge.chargedMicroneurons, 0, 'Verified zero-token usage settles to zero without authorizing a duplicate call');
  await rejects(() => make('known-zero').reserve(payload()), 'rate_limited', 'A verified zero charge does not permit replaying a completed attempt');
  const misleading = await make('overrun').reserve(payload());
  await make('overrun').settle(misleading, { outcome: 'succeeded', usage: { inputTokens: 1000000, outputTokens: 1000000 } });
  check((await make('overrun').status()).remainingNeurons, 0, 'Unexpectedly larger reported usage is retained and blocks future inference');
  await rejects(() => make('after-overrun').reserve(payload()), 'quota_exhausted', 'Actual-usage overruns cannot create negative-budget inference headroom');

  unavailable = true;
  await rejects(() => make('outage').reserve(payload()), 'data_unavailable', 'A database outage stops inference before provider access');
  unavailable = false;
  const missingMigration = createAgentBudget({ AGENT_DB: { prepare() { return { bind() { return { first() { throw Error('no such table: agent_usage PRIVATE'); } }; } }; } } }, { jobId: 'missing' });
  await rejects(() => missingMigration.status(), 'configuration_missing', 'A missing migration is distinct from a model or quota outage');
  const stalled = createAgentBudget({ AGENT_DB: { prepare() { return { bind() { return { first: () => new Promise(() => {}) }; } }; } } }, { jobId: 'stalled', timeoutMs: 5 });
  await rejects(() => stalled.reserve(payload()), 'data_unavailable', 'A stalled budget store fails closed within its deadline');
  const indexes = await execute('PRAGMA index_list(agent_usage)');
  check(indexes.some(row => row.name === 'agent_usage_owner_date'), true, 'Daily aggregation uses an owner/date index');
  check(indexes.some(row => row.name === 'agent_usage_owner_outcome'), true, 'Last-success and unresolved-attempt lookups have an index');
  check(indexes.some(row => row.name === 'agent_usage_owner_open_day'), true, 'Cross-midnight outstanding reservations use an owner/state/day index');
  console.log('Atomic agent inference budget: ' + checks + ' assertions passed.');
} finally { globalThis.fetch = beforeFetch; rmSync(directory, { recursive: true, force: true }); }
