import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Run with: node scripts/test-lp-refresh.mjs
// Execute the production pollers, replacing only the browser, clock and network.
const root = path.resolve(import.meta.dirname, '..');
const cardsSource = fs.readFileSync(path.join(root, 'lpcards.js'), 'utf8');
const bookSource = fs.readFileSync(path.join(root, 'lpbook.js'), 'utf8');
const widgetHTML = fs.readFileSync(path.join(root, 'widget.html'), 'utf8');
const widgetSource = [...widgetHTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(m => !/\bsrc\s*=/i.test(m[1])).map(m => m[2]).join('\n');
const START = 1792800000000;
let checks = 0;
const ok = (condition, message) => { checks++; assert.ok(condition, message); };
const eq = (actual, expected, message) => { checks++; assert.equal(actual, expected, message); };

function reading(marker, partial = false, elapsed = 0) {
  return { marker, generated: new Date(START + elapsed).toISOString(), live: [{ id: '491037', pair: marker, in_range: true, position_pct: 50,
    status: 'In range', price: '$100', lower: '$90', upper: '$110', edges: '10% from edge',
    nearest_edge: '10', yield_label: 'Fees earned', yield_value: '$12', pnl_up: true,
    pnl: '+$3', net_up: true, net: '+$15', since: 'since 19 Oct', cost: '$1,000' }],
    health: { errors: partial ? { Robinhood: 'forced incomplete reading' } : {},
      behind: {}, unread: [], unpriced: [] } };
}

class Element {
  constructor() { this.innerHTML = ''; this.textContent = ''; this.className = ''; this.attrs = {}; this.children = {}; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  querySelector(selector) {
    if (selector === '.ck' && this.innerHTML.includes('class="ck"')) return this.children[selector] ||= new Element();
    return null;
  }
}

async function browser(kind, initial, seed = null) {
  let time = START;
  let timerId = 0;
  const elements = new Map(), intervals = [], timers = new Map(), listeners = {}, queue = [initial], writes = [], renders = [], requests = [];
  const storage = new Map(seed ? [['tf_lpbook', JSON.stringify(seed)]] : []);
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const document = { getElementById: get, addEventListener(name, fn) { listeners[name] = fn; }, hidden: false };
  const context = vm.createContext({ Date: FakeDate, URLSearchParams, AbortController, location: { search: '' }, console,
    document,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { writes.push({ key, value: JSON.parse(value) }); storage.set(key, value); }
    },
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      const response = queue.shift();
      requests.push({ url, options });
      if (response instanceof Error) return Promise.reject(response);
      if (response === undefined) throw new Error('Test unexpectedly exhausted the response queue');
      if (response === 'HANG_FETCH') return new Promise(() => {});
      if (response === 'HANG_BODY') return Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) });
      if (response?.testHttpStatus) return Promise.resolve({ ok: false, status: response.testHttpStatus,
        json: () => { throw new Error('A failed HTTP response body must not be adopted'); } });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(response) });
    }
  });
  context.window = context;
  vm.runInContext(cardsSource, context, { filename: 'lpcards.js' });
  if (kind === 'LP Book') {
    vm.runInContext(bookSource, context, { filename: 'lpbook.js' });
    context.LPBook.poll(v => { renders.push(v.marker); get('cards').innerHTML = v.marker; }, v => !!v.live);
  } else vm.runInContext(widgetSource, context, { filename: 'widget.html (inline script)' });
  async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
  async function advanceTo(elapsed) {
    const target = START + elapsed;
    for (;;) {
      const next = [...timers.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn(); await settle();
    }
    time = target; await settle();
  }
  await settle();
  return {
    get, writes, renders, requests,
    marker: () => kind === 'LP Book' ? renders.at(-1) : get('cards').innerHTML.match(/class="pair">([^<]*)/)?.[1],
    warning: () => get('health').innerHTML,
    warningOn: () => /(?:^|\s)on(?:\s|$)/.test(get('health').className),
    state: () => get('stamp').getAttribute('data-state'),
    async pollAt(elapsed, response) {
      await advanceTo(elapsed); if (arguments.length > 1) queue.push(response);
      const poll = intervals.find(t => t.ms === 15000);
      assert.ok(poll, 'production fifteen-second poll is installed');
      poll.fn(); await settle();
    },
    async tickAt(elapsed) {
      await advanceTo(elapsed);
      const clock = intervals.find(t => t.ms === 1000);
      assert.ok(clock, 'production one-second stamp timer is installed');
      clock.fn(); await settle();
    },
    advanceTo,
    pendingTimeouts: () => timers.size,
    async hidden(value) { document.hidden = value; if (!value && listeners.visibilitychange) listeners.visibilitychange(); await settle(); }
  };
}

const cases = [
  ['full → incomplete → five-minute expiry → next incomplete → recovery', async kind => {
    const b = await browser(kind, reading('FULL-1'));
    eq(b.marker(), 'FULL-1', 'initial full reading displays');
    eq(b.state(), 'live', 'initial full reading is LIVE');
    eq(b.writes.length, 1, 'full reading saves once');
    await b.pollAt(15000, reading('PARTIAL-1', true, 15000));
    eq(b.marker(), 'FULL-1', '15s incomplete response holds full reading');
    ok(b.warningOn(), 'held incomplete response has visible warning');
    ok(b.warning().includes('Robinhood'), 'warning identifies unread chain');
    ok(/last full reading/i.test(b.warning()), 'held full reading described accurately');
    ok(b.state() !== 'live', 'incomplete response is not LIVE');
    await b.tickAt(16000);
    ok(b.state() !== 'live', 'one-second timer preserves incomplete stamp');
    await b.pollAt(285000, reading('PARTIAL-BEFORE-EXPIRY', true, 285000));
    eq(b.marker(), 'FULL-1', 'full reading remains held at 285s');
    await b.pollAt(300000, reading('PARTIAL-AT-EXPIRY', true, 300000));
    eq(b.marker(), 'PARTIAL-AT-EXPIRY', 'at 300s incomplete response displays');
    ok(!/last full reading/i.test(b.warning()), 'displayed partial is not called last full reading');
    ok(b.warningOn(), 'partial display keeps warning visible');
    await b.pollAt(315000, reading('PARTIAL-NEXT', true, 315000));
    eq(b.marker(), 'PARTIAL-NEXT', '15s later new partial replaces old partial without hold');
    eq(b.writes.length, 1, 'no incomplete response saves over full cache');
    await b.tickAt(316000);
    ok(b.state() !== 'live', 'partial display remains non-LIVE after clock tick');
    await b.pollAt(330000, new Error('forced network failure'));
    eq(b.marker(), 'PARTIAL-NEXT', 'total fetch failure retains displayed partial');
    ok(!/last full reading/i.test(b.warning()), 'fetch failure does not falsely call partial full');
    await b.tickAt(331000);
    ok(b.state() !== 'live', 'fetch failure remains non-LIVE after clock tick');
    await b.pollAt(345000, reading('FULL-RECOVERY', false, 345000));
    eq(b.marker(), 'FULL-RECOVERY', 'good recovery displays latest full reading');
    eq(b.state(), 'live', 'good recovery restores LIVE');
    ok(!b.warningOn(), 'good recovery clears warning');
    eq(b.writes.length, 2, 'good recovery saves full cache');
    eq(b.writes.at(-1).value.v.marker, 'FULL-RECOVERY', 'saved cache is recovery full reading');
  }],
  ['cold incomplete reading is never held or cached', async kind => {
    const b = await browser(kind, reading('COLD-PARTIAL-1', true));
    eq(b.marker(), 'COLD-PARTIAL-1', 'cold incomplete reading displays');
    ok(b.warningOn(), 'cold incomplete reading shows warning');
    ok(!/last full reading/i.test(b.warning()), 'cold partial not called last full reading');
    ok(b.state() !== 'live', 'cold partial is not LIVE');
    await b.pollAt(15000, reading('COLD-PARTIAL-2', true, 15000));
    eq(b.marker(), 'COLD-PARTIAL-2', 'next cold partial replaces displayed partial');
    eq(b.writes.length, 0, 'cold partial responses never save');
    await b.pollAt(30000, new Error('forced network failure'));
    ok(!/last full reading/i.test(b.warning()), 'fetch failure after cold partial does not claim full');
    await b.tickAt(31000);
    ok(b.state() !== 'live', 'failed cold-partial refresh remains non-LIVE after clock tick');
  }],
  ['incomplete cached reading is not eligible for full-reading hold', async kind => {
    const b = await browser(kind, reading('NEXT-PARTIAL', true), { t: START - 15000, v: reading('CACHED-PARTIAL', true, -15000) });
    eq(b.marker(), 'NEXT-PARTIAL', 'partial response replaces cached partial immediately');
    ok(b.warningOn(), 'replacement partial has visible warning');
    ok(!/last full reading/i.test(b.warning()), 'cached partial not described as full');
    eq(b.writes.length, 0, 'cached partial and next partial do not save');
    await b.tickAt(1000);
    ok(b.state() !== 'live', 'cached-partial path remains non-LIVE');
  }],
  ['full cached reading is eligible for five-minute hold', async kind => {
    const b = await browser(kind, reading('NEXT-PARTIAL', true), { t: START - 15000, v: reading('CACHED-FULL', false, -15000) });
    eq(b.marker(), 'CACHED-FULL', 'full cached reading remains displayed');
    ok(b.warningOn(), 'held cached full reading has warning');
    ok(/last full reading/i.test(b.warning()), 'held cached full described accurately');
    eq(b.writes.length, 0, 'incomplete response does not save');
    await b.tickAt(1000);
    ok(b.state() !== 'live', 'full-cache hold remains non-LIVE after clock tick');
  }],
  ['source timestamp expires at ninety seconds without being renewed by a cache hit', async kind => {
    const source = reading('SAVED-FULL');
    const b = await browser(kind, source);
    await b.tickAt(90000);
    eq(b.state(), 'live', 'exactly ninety seconds is inside the live boundary');
    await b.tickAt(90001);
    ok(b.state() !== 'live', 'a full reading becomes STALE after ninety seconds');
    await b.pollAt(105000, source);
    eq(b.marker(), 'SAVED-FULL', 'an old complete response can remain visible');
    ok(b.state() !== 'live', 'a cached response cannot revive the LIVE clock');
    ok(b.warningOn(), 'an old cached response explains its stale state');
    eq(b.writes.length, 1, 'an expired cache response is not saved as a new full reading');
    eq(b.writes[0].value.t, START, 'stored reading time stays at the actual API source time');
    await b.pollAt(120000, reading('NEW-FULL', false, 120000));
    eq(b.state(), 'live', 'a new complete source reading restores LIVE');
    ok(!b.warningOn(), 'the fresh source clears the old-cache warning');
  }],
  ['old API response never replaces a newer displayed reading', async kind => {
    const b = await browser(kind, reading('OLD-FULL', false, -3600000));
    ok(b.state() !== 'live', 'an hour-old API source is stale at the first display');
    eq(b.writes.length, 0, 'an hour-old source is not cached with a new timestamp');
    await b.pollAt(15000, reading('NEWER-FULL', false, 15000));
    eq(b.marker(), 'NEWER-FULL', 'a new source replaces the old cached values');
    await b.pollAt(30000, reading('REPLAYED-OLD-FULL', false, -3600000));
    eq(b.marker(), 'NEWER-FULL', 'a cached old response cannot overwrite newer values');
    ok(b.state() !== 'live', 'an old replay is not treated as a successful fresh refresh');
    ok(/older.*reading/i.test(b.warning()), 'the response ordering problem is explained');
    eq(b.writes.length, 1, 'replayed older values never replace the saved full reading');
    eq(b.writes[0].value.t, START + 15000, 'the newer cached timestamp is retained');
  }],
  ['missing, invalid and future API timestamps cannot claim freshness', async kind => {
    const b = await browser(kind, reading('FULL'));
    for (const [i, generated] of [undefined, 'not-a-date', new Date(START + 3600000).toISOString()].entries()) {
      const bad = reading('BAD-TIME-' + i);
      if (generated === undefined) delete bad.generated; else bad.generated = generated;
      await b.pollAt(15000 * (i + 1), bad);
      eq(b.marker(), 'FULL', 'an unverifiable response keeps the existing displayed reading');
      ok(b.state() !== 'live', 'an unverifiable source time is not LIVE');
      ok(/reading time is unavailable/i.test(b.warning()), 'the unavailable source time is explained');
    }
    eq(b.writes.length, 1, 'invalid time responses do not replace the full cache');
    await b.pollAt(60000, reading('TIME-RECOVERY', false, 60000));
    eq(b.marker(), 'TIME-RECOVERY', 'valid source timestamps recover normally');
    eq(b.state(), 'live', 'valid source timestamps restore LIVE');
    ok(!b.warningOn(), 'valid source timestamps clear the warning');
    const missing = reading('COLD-TIMELESS'); delete missing.generated;
    const cold = await browser(kind, missing);
    eq(cold.marker(), 'COLD-TIMELESS', 'a cold legacy payload can be displayed with an honest status');
    ok(cold.state() !== 'live', 'a cold timestamp-free payload cannot claim LIVE');
    eq(cold.writes.length, 0, 'a timestamp-free API payload cannot become the last good cache');
  }],
  ['legacy cache uses its original time and generated metadata takes precedence', async kind => {
    const legacy = reading('LEGACY-CACHE'); delete legacy.generated;
    const b = await browser(kind, new Error('offline'), { t: START - 15000, v: legacy });
    eq(b.marker(), 'LEGACY-CACHE', 'legacy saved data remains usable');
    ok(b.state() !== 'live', 'offline legacy data is marked STALE');
    eq(b.writes.length, 0, 'displaying legacy cache does not rewrite it');
    const old = reading('EXPIRED-GENERATED-CACHE', false, -3600000);
    const expired = await browser(kind, reading('FRESH-PARTIAL', true), { t: START, v: old });
    eq(expired.marker(), 'FRESH-PARTIAL', 'a newly saved cache wrapper cannot renew the expired API reading hold');
    ok(!/last full reading/i.test(expired.warning()), 'expired source cache is not called a held recent full reading');
    eq(expired.writes.length, 0, 'expired generated metadata never makes a partial response cacheable');
  }],
  ['health backlog, unvalued positions and missing prices all count as incomplete', async kind => {
    for (const issue of [
      { behind: { robinhood: 1 }, match: /robinhood/i },
      { unread: ['robinhood:1458357'], match: /1458357/ },
      { unpriced: ['WETH@robinhood'], match: /WETH/ }
    ]) {
      const b = await browser(kind, reading('FULL'));
      const partial = reading('INCOMPLETE', false, 15000);
      Object.assign(partial.health, issue); delete partial.health.match;
      await b.pollAt(15000, partial);
      eq(b.marker(), 'FULL', 'a non-error incomplete health field holds the recent full reading');
      ok(b.state() !== 'live', 'an incomplete health field makes the stamp STALE');
      ok(issue.match.test(b.warning()), 'the missing data is identified in the warning');
      eq(b.writes.length, 1, 'a non-error incomplete reading never replaces the full cache');
      const expired = structuredClone(partial); expired.generated = new Date(START + 300000).toISOString();
      await b.pollAt(300000, expired);
      eq(b.marker(), 'INCOMPLETE', 'an incomplete reading is displayed when the original hold expires');
      ok(!/last full reading/i.test(b.warning()), 'the displayed incomplete reading is not called full');
      await b.pollAt(315000, reading('RECOVERY', false, 315000));
      eq(b.state(), 'live', 'complete health recovery restores LIVE');
      ok(!b.warningOn(), 'complete health recovery clears the previous issue');
    }
    const zero = reading('ZERO-BACKLOG'); zero.health.behind = { robinhood: 0 };
    const b = await browser(kind, zero);
    eq(b.state(), 'live', 'a measured zero backlog is complete, not a missing reading');
    ok(!b.warningOn(), 'zero backlog does not produce an unnecessary warning');
  }],
  ['failed HTTP responses keep values and recover without parsing their body', async kind => {
    const b = await browser(kind, reading('FULL'));
    await b.pollAt(15000, { testHttpStatus: 503 });
    eq(b.marker(), 'FULL', 'an HTTP outage keeps the existing values');
    ok(b.state() !== 'live', 'an HTTP outage makes the retained reading STALE');
    ok(/could not be refreshed/i.test(b.warning()), 'a whole-request outage has a visible explanation');
    eq(b.writes.length, 1, 'an HTTP outage cannot replace the cache');
    await b.pollAt(30000, reading('HTTP-RECOVERY', false, 30000));
    eq(b.marker(), 'HTTP-RECOVERY', 'the next successful reading is adopted after an HTTP outage');
    eq(b.state(), 'live', 'HTTP recovery restores LIVE');
    ok(!b.warningOn(), 'HTTP recovery clears the outage warning');
    eq(b.pendingTimeouts(), 0, 'completed requests leave no pending deadline');
  }],
  ['hung fetch and JSON bodies have a bounded deadline and allow the next refresh', async kind => {
    for (const hang of ['HANG_FETCH', 'HANG_BODY']) {
      const b = await browser(kind, hang, { t: START - 15000, v: reading('FULL-CACHE', false, -15000) });
      eq(b.requests.length, 1, 'the hung operation has one request in flight');
      await b.pollAt(15000, reading('HANG-RECOVERY', false, 15000));
      eq(b.requests.length, 1, 'timer ticks do not stack requests while the operation is pending');
      await b.advanceTo(25000);
      eq(b.marker(), 'FULL-CACHE', 'timeout keeps the previous full reading');
      ok(b.state() !== 'live', 'timeout marks the retained source STALE');
      ok(/could not be refreshed/i.test(b.warning()), 'timeout has a visible explanation');
      eq(b.requests[0].options.signal.aborted, true, 'deadline aborts the pending connection');
      eq(b.pendingTimeouts(), 0, 'the deadline is cleared after timeout');
      await b.pollAt(30000);
      eq(b.requests.length, 2, 'the next timer can read again after a timeout');
      eq(b.marker(), 'HANG-RECOVERY', 'the queued successful reading is adopted after timeout');
      eq(b.state(), 'live', 'timeout recovery restores LIVE');
      ok(!b.warningOn(), 'timeout recovery clears the warning');
    }
  }],
  ['hidden tabs do not send refreshes and resume promptly on visibility', async kind => {
    const b = await browser(kind, reading('FULL'));
    await b.hidden(true);
    await b.pollAt(15000, reading('VISIBLE-RECOVERY', false, 15000));
    eq(b.requests.length, 1, 'a hidden timer creates no extra API request');
    eq(b.marker(), 'FULL', 'a hidden timer retains the displayed reading');
    await b.hidden(false);
    eq(b.requests.length, 2, 'returning to visibility reads promptly');
    eq(b.marker(), 'VISIBLE-RECOVERY', 'returning to visibility adopts the current source');
    eq(b.state(), 'live', 'visibility recovery uses the current complete reading');
    ok(b.requests.every(r => r.url === '/api/lpbook'), 'all requests retain one stable edge-cache URL');
  }],
  ['verified empty positions replace old cards rather than being held as a failure', async kind => {
    const b = await browser(kind, reading('OPEN'));
    const empty = reading('EMPTY', false, 15000); empty.live = [];
    await b.pollAt(15000, empty);
    eq(b.state(), 'live', 'a verified complete empty answer is LIVE');
    ok(!b.warningOn(), 'confirmed empty positions do not claim a read failure');
    eq(b.writes.at(-1).value.v.live.length, 0, 'the complete empty result is saved');
    if (kind === 'Widget') ok(/Nothing open/i.test(b.get('cards').innerHTML), 'the widget replaces the closed position cards with its empty state');
    else eq(b.marker(), 'EMPTY', 'the LP page renders the complete empty response');
  }]
];

let failures = 0;
for (const kind of ['LP Book', 'Widget']) {
  for (const [name, run] of cases) {
    const before = checks;
    try { await run(kind); console.log(`PASS ${kind}: ${name} (${checks - before} assertions)`); }
    catch (error) { failures++; console.error(`FAIL ${kind}: ${name}\n  ${error.message}`); }
  }
}
console.log(`${cases.length * 2 - failures}/${cases.length * 2} scenarios passed; ${checks} assertions checked.`);
process.exitCode = failures ? 1 : 0;
