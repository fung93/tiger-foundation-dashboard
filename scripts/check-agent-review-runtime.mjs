/* Optional native workerd/Workflows/local D1 check. External providers are closed
   fixtures. Pass the validation node_modules containing Miniflare and esbuild. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewPolicy, reviewFixtureFetcher } from './fixtures/agent-review.mjs';

if (!process.argv[2]) throw Error('Pass the validation node_modules directory.');
const requireRuntime = createRequire(join(resolve(process.argv[2]), '__tiger_review_validation__.cjs'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = requireRuntime('miniflare');
const { build } = requireRuntime('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'cloudflare/wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const built = await build({ stdin: { resolveDir: root, sourcefile: 'native-review-fixture.mjs', contents: `
  import worker, { PortfolioReviewWorkflow as RealWorkflow } from './cloudflare/runtime.mjs';
  export class PortfolioReviewWorkflow extends RealWorkflow {
    async run(event, realStep) {
      const original = this.env.AGENT_DB, statements = new WeakMap(); let queries = 0;
      const wrap = stmt => { const proxy = new Proxy(stmt, { get(target, key) {
        if (key === 'bind') return (...args) => wrap(target.bind(...args));
        if (['first', 'all', 'run'].includes(key)) return (...args) => { queries++; return target[key](...args); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }}); statements.set(proxy, stmt); return proxy; };
      this.env.AGENT_DB = { prepare: sql => wrap(original.prepare(sql)),
        batch: args => { queries++; return original.batch(args.map(stmt => statements.get(stmt) || stmt)); } };
      this.env.AI = { run: async (_model, request) => {
        const value = JSON.parse(request.messages.at(-1).content), groups = new Set();
        const candidates = value.candidates.filter(row => { if(groups.has(row.group))return false; groups.add(row.group); return true; }).slice(0,3);
        return { response: { thesis: 'review_choices', choices: candidates.map(row => ({ candidateId: row.id,
          reasonIds: Object.keys(row.reasons).slice(0,1), watchIds: Object.keys(row.conditions).slice(0,1), lessonIds: row.lessonIds.slice(0,1) })) },
          usage: { prompt_tokens: 1000, completion_tokens: 80 } };
      }};
      const step = { do: (name, options, operation) => realStep.do(name, options, async () => {
        queries = 0; const result = await operation();
        if (queries > 50) throw Error('Fixture Free D1 ceiling exceeded');
        await original.prepare('INSERT INTO fixture_steps(name,queries) VALUES (?,?)').bind(name, queries).run();
        return result;
      }) };
      return super.run(event, step);
    }
  }
  export default { ...worker, async fetch(request, env, context) {
    if(new URL(request.url).pathname === '/fixture/workflow-status') {
      const id = new URL(request.url).searchParams.get('id');
      return Response.json(await (await env.PORTFOLIO_REVIEWS.get(id)).status());
    }
    return worker.fetch(request, env, context);
  }};
` }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
const env = { AGENT_ORIGIN: 'https://review.fixture.test', AGENT_ACCESS_KEY: 'fixture-native-review-owner-at-least-24',
  AGENT_GATEWAY_SECRET: 'fixture-native-review-gateway-at-least-24', TELEGRAM_BOT_TOKEN: '123:fixture_native_bot' };
let assertions = 0; const calls = [], sent = [], check = (a,b,n) => { assert.deepEqual(a,b,n); assertions++; };
const options = { modules: true, script: built.outputFiles[0].text,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  bindings: env, d1Databases: ['AGENT_DB'], workflows: convertV4MiniflareOptions
    ? { PORTFOLIO_REVIEWS: { name: 'tiger-portfolio-review', className: 'PortfolioReviewWorkflow' } }
    : [{ name: 'tiger-portfolio-review', className: 'PortfolioReviewWorkflow', bindingName: 'PORTFOLIO_REVIEWS' }],
  log: new Log(LogLevel.ERROR), outboundService: async request => {
    const url = new URL(request.url);
    if (url.origin === 'https://api.telegram.org') {
      check(url.pathname.endsWith('/sendMessage'), true, 'Native background delivery uses only the fixed send operation');
      sent.push(JSON.parse(await request.text())); return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    return reviewFixtureFetcher(Date.now(), calls)(request.url);
  } };
const mf = new Miniflare(convertV4MiniflareOptions ? { ...convertV4MiniflareOptions(options), telemetry: { enabled: false } } : options);
let cookie = '';
const request = async body => {
  const response = await mf.dispatchFetch('https://worker.fixture.test/api/agent', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: env.AGENT_ORIGIN, 'x-agent-gateway-secret': env.AGENT_GATEWAY_SECRET,
      ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, value: await response.json() };
};
try {
  const db = await mf.getD1Database('AGENT_DB');
  for (const name of ['0001_agent.sql', '0002_agent_usage.sql', '0003_agent_storage.sql']) {
    const sql = readFileSync(join(root, 'cloudflare/migrations', name), 'utf8').replace(/^\s*--.*$/gm, '');
    for (const statement of sql.match(/\s*(?:CREATE TRIGGER[\s\S]*?END\s*;|[^;]+;)/gi) || []) await db.prepare(statement).run();
  }
  await db.prepare('CREATE TABLE fixture_steps(name TEXT,queries INTEGER)').run();
  for (const [key, value] of [['policy:current', reviewPolicy()], ['telegram', { chatId: '123456', userId: '123456' }]])
    await db.prepare('INSERT INTO agent_state(key,value,expires_at) VALUES (?,?,NULL)').bind('tiger:agent:v1:' + key, JSON.stringify(value)).run();
  let response = await request({ action: 'reviewRun', requestId: 'native-review' });
  check(response.status, 401, 'Actual Worker requires owner authentication before queuing reviews');
  check(calls.length + sent.length, 0, 'Unauthenticated requests contact no financial API or bot');
  response = await request({ action: 'login', accessKey: env.AGENT_ACCESS_KEY });
  check(response.status, 200, 'Owner can log into native workerd/local D1');
  cookie = response.headers.get('set-cookie').split(';')[0];
  response = await request({ action: 'reviewRun', requestId: 'native-review' });
  check(response.status, 200, 'Native request queues the configured real Workflow');
  check(response.value.status, 'queued', 'The request acknowledges background work');
  const id = response.value.workflowId;
  let status;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const result = await mf.dispatchFetch('https://worker.fixture.test/fixture/workflow-status?id=' + id);
    status = await result.json();
    if (['complete', 'errored', 'terminated'].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status.status, 'complete', 'The native fixture Workflow failed: ' + JSON.stringify(status)); assertions++;
  const phases = (await db.prepare('SELECT name,queries FROM fixture_steps').all()).results;
  check(phases.length, 8, 'Native Workflows executes six analysis stages, follow-up and delivery');
  check(phases.every(row => row.queries <= 50), true, 'Every native stage stays within the Free D1 invocation limit');
  const usage = (await db.prepare('SELECT outcome FROM agent_usage').all()).results;
  check(usage.map(row => row.outcome), ['succeeded'], 'The real local D1 ledger records one simulated inference');
  check(sent.length > 0, true, 'The actual Workflow delivers its result through the closed bot fixture');
  check(sent.every(message => message.chat_id === '123456'), true, 'Native delivery respects the original recipient');
  response = await request({ action: 'reviewStatus' });
  check(response.value.latestReport.kind, 'portfolio_review', 'The completed result is visible through the authenticated API');
  check(response.value.workflowConfigured, true, 'The API reports the actual Workflow binding');
  const reportId = response.value.latestReport.reportId;
  response = await request({ action: 'reviewRun', requestId: 'native-review' });
  check(response.value.report.reportId, reportId, 'A repeated native request reuses the same saved report');
  check((await db.prepare('SELECT COUNT(*) AS count FROM agent_usage').first()).count, 1, 'Native retries spend no extra inference');
  check((await db.prepare("SELECT COUNT(*) AS count FROM agent_state WHERE key LIKE 'tiger:agent:v1:journal:decision:%'").first()).count, 1,
    'The native review writes one proposed decision');
  console.log('Native recurring review Workflows/local D1: ' + assertions + ' assertions passed (max ' + Math.max(...phases.map(row => row.queries)) + ' D1 calls/step).');
} finally { await mf.dispose(); }
