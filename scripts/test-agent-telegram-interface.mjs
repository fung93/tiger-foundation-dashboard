/* Execute real setup controls against a minimal DOM. No browser dependency,
   provider, bot token or private financial data is needed. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../agent.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../agent.html', import.meta.url), 'utf8');
let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
class Node {
  constructor(text = '') { this.children = []; this._text = text; this.hidden = false; this.disabled = false; this.checked = false; this.dataset = {}; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
}
const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Node()]));
const $ = id => { assert.ok(nodes.has(id), 'Element exists: ' + id); return nodes.get(id); };
const setup = { draftId: 'a'.repeat(48), botUsername: 'fixture_bot', targetWebhookUrl: 'https://worker.fixture.test/api/agent-telegram',
  webhookStatus: 'missing', requiresReplacement: false, registered: false, pendingUpdates: 1,
  checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
let reply = { setup }, failure, delay, requestCount = 0;
const calls = [];
const context = vm.createContext({ $, Date, Number, String, Error,
  state: { authenticated: true, readiness: { telegram: false }, telegram: { connected: false } },
  privateViewVersion: 0, telegramSetup: null, telegramSetupBusy: false,
  date: value => String(value), element: (_tag, _class, text) => new Node(text),
  request: async (action, body) => {
    requestCount++; calls.push(JSON.parse(JSON.stringify({ action, body })));
    if (delay) await delay;
    if (failure) throw failure;
    return reply;
  },
});
vm.runInContext(source.match(/^const samePrivateView=.*$/m)[0] + '\n'
  + source.slice(source.indexOf('function renderTelegram()'), source.indexOf('function renderAlerts()'))
  + '\nglobalThis.helpers={renderTelegram,renderTelegramSetup,runTelegramSetup,clearTelegramSetup};', context);
const h = context.helpers;
h.renderTelegram();
check($('agentPair').disabled, true, 'Missing server configuration disables code generation');
check($('agentTelegramCheck').disabled, true, 'Missing server configuration also disables provider checks');
check($('agentTelegramState').textContent, 'Setup required', 'Missing configuration is explicit');
check(requestCount, 0, 'Rendering and polling never configure or contact Telegram');
context.state.readiness.telegram = true; h.renderTelegram();
check($('agentTelegramCheck').disabled, false, 'Configured owners can inspect setup');
for (const id of ['agentPair', 'agentUnlink']) {
  $(id).setAttribute('aria-busy', 'true'); h.renderTelegram();
  check($('agentTelegramCheck').disabled, true, 'Setup waits for an active linking change: ' + id);
  await h.runTelegramSetup(false);
  check(requestCount, 0, 'Setup cannot race an invitation or unlink request: ' + id);
  $(id).setAttribute('aria-busy', 'false'); h.renderTelegram();
}
let release; delay = new Promise(resolve => { release = resolve; });
const pending = h.runTelegramSetup(false);
check($('agentTelegramCheck').getAttribute('aria-busy'), 'true', 'An active check has an accessible busy state');
check($('agentPair').disabled, true, 'Pairing waits while a setup check is in progress');
h.renderTelegram();
check($('agentTelegramCheck').disabled, true, 'Status polling cannot re-enable the active setup control');
await h.runTelegramSetup(false);
check(requestCount, 1, 'Repeated clicks do not duplicate provider checks');
delay = null; release(); await pending;
check($('agentTelegramSetup').hidden, false, 'A check displays its reviewable preview');
check($('agentTelegramPreview').textContent.includes('@fixture_bot'), true, 'Verified bot identity is visible');
check($('agentTelegramPreview').textContent.includes('no webhook'), true, 'Missing webhook is explained in the card');
check($('agentTelegramConnect').hidden, false, 'The connection action appears after the preview');
check($('agentTelegramConnect').disabled, false, 'A missing webhook can be explicitly connected');
check($('agentTelegramCheck').getAttribute('aria-busy'), 'false', 'Successful checks clear their busy state');
check(calls[0], { action: 'telegramCheck', body: {} }, 'Check sends no token or destination from the browser');
check($('agentTelegramFeedback').textContent.includes('Review'), true, 'Check asks for review before the configuration write');

reply = { setup: { ...setup, webhookStatus: 'different', requiresReplacement: true, deliveryError: 'unauthorized', updatesStatus: 'missing_messages' } };
await h.runTelegramSetup(false);
check($('agentTelegramConnect').disabled, true, 'Another service cannot be silently replaced');
check($('agentTelegramReplaceLabel').hidden, false, 'Replacement needs an explicit owner checkbox');
check($('agentTelegramPreview').textContent.includes('verification secret'), true, 'A delivery authentication failure has clear next steps');
const beforeConsent = requestCount; await h.runTelegramSetup(true);
check(requestCount, beforeConsent, 'Connecting is blocked until replacement consent');
$('agentTelegramReplace').checked = true; h.renderTelegramSetup();
check($('agentTelegramConnect').disabled, false, 'Replacement consent enables the explicit Connect action');
$('agentPairCode').textContent = '/start PRIVATE_OLD_CODE'; $('agentPairing').hidden = false;
reply = { setup: { ...setup, webhookStatus: 'matches', registered: true, registeredAt: new Date().toISOString() } };
await h.runTelegramSetup(true);
check(calls.at(-1), { action: 'telegramConnect', body: { draftId: setup.draftId, replaceExisting: true } }, 'Connect confirms only the server-owned preview');
check($('agentPairCode').textContent, '', 'Registration clears the revoked invitation');
check($('agentPairing').hidden, true, 'Registration hides the old pairing panel');
check($('agentTelegramConnect').hidden, true, 'Confirmed registration cannot be repeatedly triggered');
check($('agentTelegramFeedback').textContent.includes('Link Telegram'), true, 'The owner is guided to a fresh invitation');
check($('agentTelegramState').textContent, 'Not linked', 'Registration is never confused with a linked human');
context.state.telegram.connected = true; h.renderTelegram();
check($('agentTelegramState').textContent, 'Linked', 'Only actual server binding changes the linked state');
check($('agentTelegramPreview').textContent.includes('linked bot'), true, 'An existing owner can test without unlinking');

failure = new Error('Telegram setup timed out. Check setup again before connecting.');
await h.runTelegramSetup(false);
check($('agentTelegramFeedback').dataset.error, 'true', 'A provider failure is visible inside the Telegram card');
check($('agentTelegramSetup').hidden, true, 'A failed check leaves no stale confirmation');
check($('agentTelegramCheck').disabled, false, 'A failed check can be retried deliberately');
failure = null; reply = { setup }; await h.runTelegramSetup(false);
failure = new Error('Telegram did not confirm registration. Check Telegram setup again.');
await h.runTelegramSetup(true);
check($('agentTelegramSetup').hidden, true, 'An uncertain configuration write needs a new preview');
check($('agentTelegramConnect').getAttribute('aria-busy'), 'false', 'Failed connection attempts clear their busy state');

failure = null; delay = new Promise(resolve => { release = resolve; });
const late = h.runTelegramSetup(false);
context.privateViewVersion++; context.state.authenticated = false; h.clearTelegramSetup();
delay = null; release(); await late;
check($('agentTelegramSetup').hidden, true, 'A late reply cannot restore a preview after logout');
check($('agentTelegramPreview').textContent, '', 'Logout removes private bot metadata');
check($('agentTelegramFeedback').textContent, '', 'Logout removes private setup results');
check(context.telegramSetup, null, 'Logout removes the pending draft reference');
check(context.telegramSetupBusy, false, 'Logout resets transient setup state');
check($('agentTelegramReplace').checked, false, 'Logout removes any replacement consent');
console.log('Telegram setup interface: ' + checks + ' assertions passed.');
