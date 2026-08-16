#!/usr/bin/env node
/**
 * probe-chain.mjs — ask an EVM RPC the questions you must answer before designing a ledger.
 *
 * Two chain properties decide what a portfolio dashboard can honestly claim, and both vary by
 * chain AND by provider, so they have to be measured rather than assumed:
 *
 *   1. Does it serve ARCHIVE state?  If yes you can price a historical event exactly at the
 *      block it happened. If no, every historical figure is an approximation and should say so.
 *   2. Does eth_getLogs return blockTimestamp INLINE?  If yes you have saved one
 *      eth_getBlockByNumber per log, which is most of the cost of building a ledger.
 *
 * It also confirms Multicall3 is deployed, measures latency so you can set timeouts from data
 * rather than from a guess, and — given a contract — groups a window of logs by topics[0] so you
 * can discover event signatures empirically instead of copying a hash from documentation.
 * A wrong topic hash matches nothing and raises no error, which is the worst failure mode
 * available: it looks exactly like "no activity".
 *
 * Node 18+. No dependencies.
 *
 *   node probe-chain.mjs --rpc https://rpc.example.org
 *   node probe-chain.mjs --rpc <url> --contract 0xNFTManager --window 5000
 *   node probe-chain.mjs --rpc <url> --wallet 0xYou --contract 0xToken --json
 */

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO = '0x0000000000000000000000000000000000000000';

/* Known signatures, so a discovered hash can be named rather than left as an opaque 32 bytes.
   Anything not in here is reported as unknown with its hash — that is a finding, not a failure. */
const KNOWN_TOPICS = {
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef': 'Transfer(address,address,uint256)',
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925': 'Approval(address,address,uint256)',
  '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f': 'IncreaseLiquidity(uint256,uint128,uint256,uint256)',
  '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4': 'DecreaseLiquidity(uint256,uint128,uint256,uint256)',
  '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01': 'Collect(uint256,address,uint256,uint256)',
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67': 'Swap (UniswapV3Pool)',
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde': 'Deposit / Mint (varies)'
};

function parseArgs(argv) {
  const a = { window: 2000, timeout: 15000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if (k === '--topics') a.topics = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  if (a.window) a.window = Number(a.window);
  if (a.timeout) a.timeout = Number(a.timeout);
  return a;
}

let RPC, TIMEOUT;
let callCount = 0;

async function rpc(method, params) {
  callCount++;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: callCount, method, params }),
      signal: ctrl.signal
    });
    const ms = Date.now() - started;
    if (!res.ok) return { error: `HTTP ${res.status}`, ms };
    const j = await res.json();
    if (j.error) return { error: j.error.message || JSON.stringify(j.error), ms };
    return { result: j.result, ms };
  } catch (e) {
    return { error: e.name === 'AbortError' ? `timeout after ${TIMEOUT}ms` : e.message,
             ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const hex = n => '0x' + Number(n).toString(16);

async function main() {
  const args = parseArgs(process.argv);
  if (!args.rpc) {
    console.error('usage: node probe-chain.mjs --rpc <url> [--wallet 0x..] [--contract 0x..] [--window 2000] [--json]');
    process.exit(1);
  }
  RPC = args.rpc;
  TIMEOUT = args.timeout;

  const out = { rpc: RPC, checks: {}, latency: {}, topics: null, notes: [] };

  /* ---- reachable, and how fast? ------------------------------------------------ */
  const t0 = Date.now();
  const chainId = await rpc('eth_chainId', []);
  if (chainId.error) {
    console.error(`RPC unreachable: ${chainId.error}`);
    process.exit(2);
  }
  out.chainId = parseInt(chainId.result, 16);
  out.latency.eth_chainId = chainId.ms;

  const bn = await rpc('eth_blockNumber', []);
  const latest = parseInt(bn.result, 16);
  out.latestBlock = latest;
  out.latency.eth_blockNumber = bn.ms;

  /* Timeouts should come from measured latency, not a guess: a 10s default on a 400ms call is
     25 seconds of dead air when it fails. */
  const best = Math.min(chainId.ms, bn.ms);
  out.latency.suggestedTimeoutMs = Math.max(1500, Math.ceil(best * 5 / 100) * 100);

  /* ---- archive state ----------------------------------------------------------- */
  const back = Math.min(200000, latest - 1);
  const oldBlock = Math.max(1, latest - back);
  const stateProbe = await rpc('eth_getBalance', [args.wallet || ZERO, hex(oldBlock)]);
  out.checks.archiveState = {
    blocksBack: back,
    stateAccess: !stateProbe.error,
    detail: stateProbe.error || `balance readable at block ${oldBlock}`
  };

  /* eth_call at a historical block is the property pricing actually needs — state access alone
     can be served from an index without full historical execution. */
  if (args.contract) {
    const callProbe = await rpc('eth_call',
      [{ to: args.contract, data: '0x18160ddd' /* totalSupply() */ }, hex(oldBlock)]);
    out.checks.archiveState.historicalCall = !callProbe.error;
    out.checks.archiveState.callDetail = callProbe.error || 'eth_call succeeded at historical block';
  } else {
    out.notes.push('Pass --contract to also test eth_call at a historical block — that is the property historical pricing needs.');
  }

  /* ---- multicall3 -------------------------------------------------------------- */
  const code = await rpc('eth_getCode', [MULTICALL3, 'latest']);
  out.checks.multicall3 = {
    address: MULTICALL3,
    deployed: !code.error && typeof code.result === 'string' && code.result.length > 2,
    detail: code.error || `${code.result ? (code.result.length - 2) / 2 : 0} bytes of code`
  };

  /* ---- inline blockTimestamp on logs ------------------------------------------- */
  const from = Math.max(1, latest - Math.min(args.window, 500));
  const logFilter = { fromBlock: hex(from), toBlock: hex(latest) };
  if (args.contract) logFilter.address = args.contract;
  const logs = await rpc('eth_getLogs', [logFilter]);
  if (logs.error) {
    out.checks.inlineBlockTimestamp = { supported: null, detail: `eth_getLogs failed: ${logs.error}` };
  } else if (!logs.result.length) {
    out.checks.inlineBlockTimestamp = { supported: null, detail: 'no logs in window — widen --window or pass --contract' };
  } else {
    const has = Object.prototype.hasOwnProperty.call(logs.result[0], 'blockTimestamp');
    out.checks.inlineBlockTimestamp = {
      supported: has,
      sampleLogs: logs.result.length,
      detail: has
        ? 'blockTimestamp present — no extra eth_getBlockByNumber needed per log'
        : 'absent — you will need one eth_getBlockByNumber per distinct block'
    };
  }
  out.latency.eth_getLogs = logs.ms;

  /* ---- topic discovery --------------------------------------------------------- */
  if (args.contract) {
    const wFrom = Math.max(1, latest - args.window);
    const all = await rpc('eth_getLogs', [{ fromBlock: hex(wFrom), toBlock: hex(latest), address: args.contract }]);
    if (all.error) {
      out.topics = { error: all.error, hint: 'many public RPCs cap the block range — try a smaller --window' };
    } else {
      const groups = new Map();
      for (const l of all.result) {
        const t = (l.topics && l.topics[0]) || '(anonymous)';
        if (!groups.has(t)) groups.set(t, { topic0: t, count: 0, indexedArgs: (l.topics || []).length - 1, firstBlock: parseInt(l.blockNumber, 16) });
        groups.get(t).count++;
      }
      out.topics = {
        contract: args.contract,
        windowBlocks: args.window,
        totalLogs: all.result.length,
        distinct: [...groups.values()]
          .sort((a, b) => b.count - a.count)
          .map(g => ({ ...g, signature: KNOWN_TOPICS[g.topic0] || '(unknown — match it against activity you know happened)' }))
      };
    }
  }

  out.totalProbeMs = Date.now() - t0;

  if (args.json) { console.log(JSON.stringify(out, null, 2)); return; }
  report(out, args);
}

function report(o, args) {
  const yes = v => v === true ? 'YES' : v === false ? 'NO ' : '?  ';
  const line = s => console.log(s);

  line('');
  line(`  chain ${o.chainId}   latest block ${o.latestBlock}   ${o.rpc}`);
  line('  ' + '-'.repeat(72));

  const a = o.checks.archiveState;
  line(`  [${yes(a.stateAccess)}] archive state — ${a.blocksBack} blocks back`);
  line(`        ${a.detail}`);
  if (a.historicalCall !== undefined) {
    line(`  [${yes(a.historicalCall)}] eth_call at a historical block`);
    line(`        ${a.callDetail}`);
  }
  line(a.stateAccess
    ? '        → you can price historical events exactly. Read slot0() at the event block.'
    : '        → historical figures will be approximations. Say so in the UI rather than shipping them quietly.');

  const m = o.checks.multicall3;
  line(`  [${yes(m.deployed)}] Multicall3 at the canonical address`);
  line(`        ${m.detail}`);
  if (!m.deployed) line('        → find the chain\'s own deployment, or batch with individual calls.');

  const t = o.checks.inlineBlockTimestamp;
  line(`  [${yes(t.supported)}] inline blockTimestamp on logs`);
  line(`        ${t.detail}`);

  line('  ' + '-'.repeat(72));
  line('  latency');
  for (const [k, v] of Object.entries(o.latency)) {
    if (k === 'suggestedTimeoutMs') continue;
    line(`        ${k.padEnd(20)} ${v}ms`);
  }
  line(`        → set fetch timeouts around ${o.latency.suggestedTimeoutMs}ms (~5x the best observed call)`);

  if (o.topics) {
    line('  ' + '-'.repeat(72));
    if (o.topics.error) {
      line(`  topic discovery failed: ${o.topics.error}`);
      line(`        ${o.topics.hint}`);
    } else {
      line(`  topics emitted by ${o.topics.contract}`);
      line(`  ${o.topics.totalLogs} logs over ${o.topics.windowBlocks} blocks`);
      line('');
      for (const g of o.topics.distinct) {
        line(`        ${g.topic0}`);
        line(`          x${String(g.count).padEnd(5)} ${g.indexedArgs} indexed   ${g.signature}`);
      }
      line('');
      line('        → match the unknown ones against activity you know happened. Never copy a');
      line('          topic hash from documentation: a wrong hash matches nothing and raises no');
      line('          error, so the ledger comes back empty and looks like "no activity".');
    }
  } else {
    line('  ' + '-'.repeat(72));
    line('  pass --contract <address> to discover which events it emits');
  }

  line('');
  for (const n of o.notes) line(`  note: ${n}`);
  line('');
}

main().catch(e => { console.error(e); process.exit(1); });
