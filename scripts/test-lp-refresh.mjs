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

function reading(marker, partial = false) {
  return { marker, live: [{ id: '491037', pair: marker, in_range: true, position_pct: 50,
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
  const elements = new Map(), intervals = [], queue = [initial], writes = [], renders = [];
  const storage = new Map(seed ? [['tf_lpbook', JSON.stringify(seed)]] : []);
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const context = vm.createContext({ Date: FakeDate, URLSearchParams, location: { search: '' }, console,
    document: { getElementById: get, addEventListener() {}, hidden: false },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { writes.push({ key, value: JSON.parse(value) }); storage.set(key, value); }
    },
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    fetch() {
      const response = queue.shift();
      if (response instanceof Error) return Promise.reject(response);
      if (response === undefined) throw new Error('Test unexpectedly exhausted the response queue');
      return Promise.resolve({ json: () => Promise.resolve(response) });
    }
  });
  context.window = context;
  vm.runInContext(cardsSource, context, { filename: 'lpcards.js' });
  if (kind === 'LP Book') {
    vm.runInContext(bookSource, context, { filename: 'lpbook.js' });
    context.LPBook.poll(v => { renders.push(v.marker); get('cards').innerHTML = v.marker; }, v => !!v.live);
  } else vm.runInContext(widgetSource, context, { filename: 'widget.html (inline script)' });
  async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  await settle();
  return {
    get, writes, renders,
    marker: () => kind === 'LP Book' ? renders.at(-1) : get('cards').innerHTML.match(/class="pair">([^<]*)/)?.[1],
    warning: () => get('health').innerHTML,
    warningOn: () => /(?:^|\s)on(?:\s|$)/.test(get('health').className),
    state: () => get('stamp').getAttribute('data-state'),
    async pollAt(elapsed, response) {
      time = START + elapsed; queue.push(response);
      const poll = intervals.find(t => t.ms === 15000);
      assert.ok(poll, 'production fifteen-second poll is installed');
      poll.fn(); await settle();
    },
    async tickAt(elapsed) {
      time = START + elapsed;
      const clock = intervals.find(t => t.ms === 1000);
      assert.ok(clock, 'production one-second stamp timer is installed');
      clock.fn(); await settle();
    }
  };
}

const cases = [
  ['full → incomplete → five-minute expiry → next incomplete → recovery', async kind => {
    const b = await browser(kind, reading('FULL-1'));
    eq(b.marker(), 'FULL-1', 'initial full reading displays');
    eq(b.state(), 'live', 'initial full reading is LIVE');
    eq(b.writes.length, 1, 'full reading saves once');
    await b.pollAt(15000, reading('PARTIAL-1', true));
    eq(b.marker(), 'FULL-1', '15s incomplete response holds full reading');
    ok(b.warningOn(), 'held incomplete response has visible warning');
    ok(b.warning().includes('Robinhood'), 'warning identifies unread chain');
    ok(/last full reading/i.test(b.warning()), 'held full reading described accurately');
    ok(b.state() !== 'live', 'incomplete response is not LIVE');
    await b.tickAt(16000);
    ok(b.state() !== 'live', 'one-second timer preserves incomplete stamp');
    await b.pollAt(285000, reading('PARTIAL-BEFORE-EXPIRY', true));
    eq(b.marker(), 'FULL-1', 'full reading remains held at 285s');
    await b.pollAt(300000, reading('PARTIAL-AT-EXPIRY', true));
    eq(b.marker(), 'PARTIAL-AT-EXPIRY', 'at 300s incomplete response displays');
    ok(!/last full reading/i.test(b.warning()), 'displayed partial is not called last full reading');
    ok(b.warningOn(), 'partial display keeps warning visible');
    await b.pollAt(315000, reading('PARTIAL-NEXT', true));
    eq(b.marker(), 'PARTIAL-NEXT', '15s later new partial replaces old partial without hold');
    eq(b.writes.length, 1, 'no incomplete response saves over full cache');
    await b.tickAt(316000);
    ok(b.state() !== 'live', 'partial display remains non-LIVE after clock tick');
    await b.pollAt(330000, new Error('forced network failure'));
    eq(b.marker(), 'PARTIAL-NEXT', 'total fetch failure retains displayed partial');
    ok(!/last full reading/i.test(b.warning()), 'fetch failure does not falsely call partial full');
    await b.tickAt(331000);
    ok(b.state() !== 'live', 'fetch failure remains non-LIVE after clock tick');
    await b.pollAt(345000, reading('FULL-RECOVERY'));
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
    await b.pollAt(15000, reading('COLD-PARTIAL-2', true));
    eq(b.marker(), 'COLD-PARTIAL-2', 'next cold partial replaces displayed partial');
    eq(b.writes.length, 0, 'cold partial responses never save');
    await b.pollAt(30000, new Error('forced network failure'));
    ok(!/last full reading/i.test(b.warning()), 'fetch failure after cold partial does not claim full');
    await b.tickAt(31000);
    ok(b.state() !== 'live', 'failed cold-partial refresh remains non-LIVE after clock tick');
  }],
  ['incomplete cached reading is not eligible for full-reading hold', async kind => {
    const b = await browser(kind, reading('NEXT-PARTIAL', true), { t: START - 15000, v: reading('CACHED-PARTIAL', true) });
    eq(b.marker(), 'NEXT-PARTIAL', 'partial response replaces cached partial immediately');
    ok(b.warningOn(), 'replacement partial has visible warning');
    ok(!/last full reading/i.test(b.warning()), 'cached partial not described as full');
    eq(b.writes.length, 0, 'cached partial and next partial do not save');
    await b.tickAt(1000);
    ok(b.state() !== 'live', 'cached-partial path remains non-LIVE');
  }],
  ['full cached reading is eligible for five-minute hold', async kind => {
    const b = await browser(kind, reading('NEXT-PARTIAL', true), { t: START - 15000, v: reading('CACHED-FULL') });
    eq(b.marker(), 'CACHED-FULL', 'full cached reading remains displayed');
    ok(b.warningOn(), 'held cached full reading has warning');
    ok(/last full reading/i.test(b.warning()), 'held cached full described accurately');
    eq(b.writes.length, 0, 'incomplete response does not save');
    await b.tickAt(1000);
    ok(b.state() !== 'live', 'full-cache hold remains non-LIVE after clock tick');
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
console.log(`${8 - failures}/8 scenarios passed; ${checks} assertions checked.`);
process.exitCode = failures ? 1 : 0;
