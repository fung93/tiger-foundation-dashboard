/* Optional platform regression: run the actual Worker in local workerd through
   Miniflare, with D1 and a closed fake outbound service. No real bot/provider.
   Pass a validation directory's node_modules containing Wrangler 4, Miniflare
   and esbuild. Production and the normal network-free checks need no packages. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = process.argv[2];
if (!runtimeRoot) throw Error('Pass the validation node_modules directory as the only argument.');
const requireRuntime = createRequire(join(resolve(runtimeRoot), '__tiger_validation__.cjs'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = requireRuntime('miniflare');
const { build } = requireRuntime('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'cloudflare/wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const buildResult = await build({ stdin: { contents: `
  import worker from './cloudflare/worker.mjs';
  import { loadAgentSupplementalContext } from './api/_agent-context.mjs';
  export default { async fetch(request, env, context) {
    if (new URL(request.url).pathname === '/fixture/optional') return Response.json(await loadAgentSupplementalContext({
      origin: env.AGENT_ORIGIN, needs: ['strategy', 'kat', 'vkat'] }));
    return worker.fetch(request, env, context);
  }};`, resolveDir: root, sourcefile: 'telegram-runtime-fixture.mjs' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'] });
let checks = 0, webhook = '', providerMode = 'success';
const calls = [], redirected = [];
const env = { AGENT_ORIGIN: 'https://dashboard.fixture.test', AGENT_ACCESS_KEY: 'fixture-owner-key-for-runtime-at-least-24',
  AGENT_GATEWAY_SECRET: 'fixture-gateway-key-for-runtime-at-least-24', TELEGRAM_BOT_TOKEN: '12345:fixture_bot_token',
  TELEGRAM_WEBHOOK_SECRET: 'fixture_webhook_secret_for_runtime' };
const expected = 'https://worker.fixture.test/api/agent-telegram';
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const options = { modules: true, script: buildResult.outputFiles[0].text,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  bindings: env, d1Databases: ['AGENT_DB'], log: new Log(LogLevel.ERROR),
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === 'redirected.fixture.test') { redirected.push(url.pathname); return new Response('Unexpected redirect'); }
    if (url.origin === env.AGENT_ORIGIN && ['/api/strategy', '/api/kat-trades', '/api/vkat'].includes(url.pathname)) {
      calls.push({ method: url.pathname });
      return new Response(null, { status: 302, headers: { location: 'https://redirected.fixture.test/optional' } });
    }
    check(url.origin, 'https://api.telegram.org', 'Worker requests stay on the approved bot provider');
    const method = url.pathname.split('/').at(-1); calls.push({ method, body: JSON.parse(await request.text()) });
    if (providerMode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://redirected.fixture.test/bot' } });
    if (providerMode === 'unauthorized') return Response.json({ ok: false, error_code: 401, description: 'PRIVATE provider text' }, { status: 401 });
    const result = method === 'getMe' ? { id: 12345, is_bot: true, username: 'runtime_fixture_bot' }
      : method === 'getWebhookInfo' ? { url: webhook, pending_update_count: 0, allowed_updates: ['message', 'callback_query'] }
      : method === 'setWebhook' ? (webhook = calls.at(-1).body.url, true) : null;
    assert.notEqual(result, null, 'Unknown outbound method is forbidden');
    return Response.json({ ok: true, result });
  } };
const mf = new Miniflare(convertV4MiniflareOptions
  ? { ...convertV4MiniflareOptions(options), telemetry: { enabled: false } } : options);
let cookie = '';
async function request(body, authenticated = true) {
  const response = await mf.dispatchFetch('https://worker.fixture.test/api/agent', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: env.AGENT_ORIGIN,
      'x-agent-gateway-secret': env.AGENT_GATEWAY_SECRET, ...(authenticated && cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, value: await response.json() };
}
try {
  const db = await mf.getD1Database('AGENT_DB');
  for (const name of ['0001_agent.sql', '0003_agent_storage.sql']) {
    // D1 exec accepts one statement per line; prepare/run handles whole trigger
    // definitions. Use the migration statement boundaries, including BEGIN/END.
    const sql = readFileSync(join(root, 'cloudflare/migrations', name), 'utf8').replace(/^\s*--.*$/gm, '');
    const statements = sql.match(/\s*(?:CREATE TRIGGER[\s\S]*?END\s*;|[^;]+;)/gi) || [];
    for (const statement of statements) await db.prepare(statement).run();
  }
  let response = await request({ action: 'telegramCheck' }, false);
  check(response.status, 401, 'Real Worker setup requires an owner session');
  check(calls.length, 0, 'Unauthenticated setup makes no outbound request');
  response = await request({ action: 'login', accessKey: env.AGENT_ACCESS_KEY });
  check(response.status, 200, 'Owner login works in native workerd with local D1');
  cookie = response.headers.get('set-cookie').split(';')[0];
  response = await request({ action: 'telegramCheck' });
  check(response.status, 200, 'Native Workers fetch can check Telegram identity and webhook metadata');
  check(calls.map(row => row.method), ['getMe', 'getWebhookInfo'], 'The check reaches the fake provider exactly twice');
  check(response.value.setup.targetWebhookUrl, expected, 'The native adapter preserves the actual Worker target');
  response = await request({ action: 'telegramConnect', draftId: response.value.setup.draftId });
  check(response.status, 200, 'Native Worker can explicitly register and verify the webhook');
  check(response.value.setup.registered, true, 'The connection is verified in the platform runtime');
  check(response.value.setup.deliveryVerified, false, 'Fixture registration is not evidence of real delivery');
  check(calls.find(row => row.method === 'setWebhook').body, { url: expected, secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'], drop_pending_updates: false }, 'Only the fixed destination receives the saved verification secret');
  response = await request({ action: 'pair' });
  check(response.value.url.startsWith('https://t.me/runtime_fixture_bot?start='), true, 'The fresh invitation opens the verified bot');
  providerMode = 'redirect'; response = await request({ action: 'telegramCheck' });
  check(response.status, 503, 'Native Worker refuses provider redirects');
  check(redirected.length, 0, 'A redirect receives no request, bot token or verification secret');
  providerMode = 'unauthorized'; response = await request({ action: 'telegramCheck' });
  check(response.status, 409, 'Real provider rejection is distinguished from platform incompatibility');
  check(JSON.stringify(response.value).includes('PRIVATE'), false, 'Provider error text is discarded in the native runtime');
  const beforeOptional = calls.length;
  const optional = await (await mf.dispatchFetch('https://worker.fixture.test/fixture/optional')).json();
  check(calls.slice(beforeOptional).map(row => row.method).sort(), ['/api/kat-trades', '/api/strategy', '/api/vkat'], 'Optional data reads reach the configured APIs with native Workers fetch');
  check(optional.sources.every(row => row.status === 'unavailable'), true, 'Redirected optional data remains unavailable');
  check(redirected.length, 0, 'Optional API redirects also receive no request');
  console.log('Native Telegram Worker runtime: ' + checks + ' assertions passed. No real provider was contacted.');
} finally { await mf.dispose(); }
