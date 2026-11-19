/* Read-only UNI trade book. Keep the existing sender checkpoints; UNI Transfer
   intervals also discover resolver-filled maker orders. Current inventory and
   bounded historical backfill have independent, hash-verified checkpoints. */
import { CFG, encodeAgg3, decodeAgg3, pad } from './_core.mjs';
import { UNI_CHAINS, UNI_FEE_TIERS, UNI_MULTICALL } from './_uni-config.mjs';
import {scanUniFlows} from './_uni-flow-reader.mjs';
import { createUniRpc } from './_uni-reader.mjs';
import { UNI_TRADE_VERSION, SWAPS, receiptUniTrade, uniTransfers, replayUniTrades, validateUniTradeBook } from '../uni-trade-core.mjs';
import { createLiveCache, fetchJSON, requestOrigin, responseHeaders } from './_live-cache.mjs';
const WALLETS = CFG.wallets.map(w => w.address.toLowerCase()), hex = n => '0x' + n.toString(16);
const word = (value, n = 0) => { if (!/^0x[0-9a-f]+$/i.test(value || '') || value.length < 66 + n * 64) throw Error('Incomplete contract reading'); return BigInt('0x' + value.slice(2 + n * 64, 66 + n * 64)); };
const need = row => { if (!row?.ok) throw Error('Required UNI reading unavailable'); word(row.data); return row.data; };
const addr = value => '0x' + word(value).toString(16).padStart(40, '0');
const clone = value => JSON.parse(JSON.stringify(value));
const historyCovered=state=>!!state&&Number.isSafeInteger(state.transferStart)&&!!state.openingUni&&(state.transferCursor===state.head||state.recentCursor===state.head&&state.transferCursor>=state.recentStart-1);
async function multi(rpc, calls, at) {
  const result = [];
  for (let i = 0; i < calls.length; i += 60) {
    const batch = calls.slice(i, i + 60), value = await rpc('eth_call', [{ to: UNI_MULTICALL, data: encodeAgg3(batch) }, hex(at)]);
    result.push(...decodeAgg3(value, batch.length));
  }
  return result;
}
export const emptyUniTradeBook = () => ({ version: UNI_TRADE_VERSION, wallets: [...WALLETS], chains: {}, trades: [], runs: [] });
export const validUniTradeBook = file => validateUniTradeBook(file, UNI_CHAINS, WALLETS);

export async function firstWalletActivity(rpc, owner, head) {
  const count = async block => Number(BigInt(await rpc('eth_getTransactionCount', [owner, hex(block)])));
  if (await count(head) === 0) return head + 1;
  let span = 10000, lo = Math.max(0, head - span), hi = head;
  while (await count(lo) > 0) { if (lo === 0) throw Error('Wallet activity boundary unavailable'); span *= 2; lo = Math.max(0, head - span); }
  while (hi - lo > 1) { const mid = Math.floor((hi + lo) / 2); if (await count(mid) > 0) hi = mid; else lo = mid; }
  return hi;
}
export async function readUniSpot(chain, rpc, tip) {
  const candidates = chain.stables.flatMap(stable => UNI_FEE_TIERS.map(fee => ({ stable, fee })));
  const raw = await multi(rpc, candidates.map(c => ({ to: chain.factory, data: '0x1698ee82' + pad(chain.uni.address) + pad(c.stable.address) + pad(c.fee.toString(16)) })), tip.number);
  const found = candidates.map((c, i) => ({ ...c, pool: addr(need(raw[i])) })).filter(c => c.pool !== '0x' + '0'.repeat(40));
  const pools = [];
  for (const c of found) {
    const values = await multi(rpc, [{ to: c.pool, data: '0x3850c7bd' }, { to: c.pool, data: '0x0dfe1681' }, { to: c.pool, data: '0xd21220a7' },
      { to: chain.uni.address, data: '0x70a08231' + pad(c.pool) }, { to: c.stable.address, data: '0x70a08231' + pad(c.pool) }], tip.number);
    const t0 = addr(need(values[1])), t1 = addr(need(values[2]));
    if (![t0, t1].includes(chain.uni.address) || ![t0, t1].includes(c.stable.address)) throw Error('UNI quote identity mismatch');
    const ratio = (Number(word(need(values[0]))) / 2 ** 96) ** 2 * 10 ** (t0 === chain.uni.address ? 18 - c.stable.decimals : c.stable.decimals - 18),
      priceUsd = t0 === chain.uni.address ? ratio : 1 / ratio;
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) throw Error('UNI price unavailable');
    pools.push({ priceUsd, pool: c.pool, block: tip.number, ts: tip.ts,
      tvl: Number(word(need(values[3]))) / 1e18 * priceUsd + Number(word(need(values[4]))) / 10 ** c.stable.decimals });
  }
  pools.sort((a, b) => b.tvl - a.tvl);
  if (!pools.length) throw Error('No verified UNI quote');
  const held = await multi(rpc, WALLETS.map(owner => ({ to: chain.uni.address, data: '0x70a08231' + pad(owner) })).concat({ to: chain.uni.address, data: '0x313ce567' }), tip.number);
  if (word(need(held.at(-1))) !== 18n) throw Error('UNI token decimals changed');
  return { quote: pools[0], wallets: WALLETS.map((owner, i) => ({ owner, chain: chain.key, raw: word(need(held[i])).toString(), uni: Number(word(need(held[i]))) / 1e18,
    valueUsd: Number(word(need(held[i]))) / 1e18 * pools[0].priceUsd, ts: tip.ts, block: tip.number })) };
}
export async function readUniReturnPrice(chain,rpc,block,quote){
 if(!quote?.pool)return null;
 try{const r=await multi(rpc,[{to:quote.pool,data:'0x0dfe1681'},{to:quote.pool,data:'0xd21220a7'},{to:quote.pool,data:'0x3850c7bd'}],block),a0=addr(need(r[0])),a1=addr(need(r[1])),stable=chain.stables.find(t=>[a0,a1].includes(t.address));
  if(!stable||![a0,a1].includes(chain.uni.address))return null;
  const ratio=(Number(word(need(r[2])))/2**96)**2*10**(a0===chain.uni.address?18-stable.decimals:stable.decimals-18),price=a0===chain.uni.address?ratio:1/ratio;
  return price>0&&Number.isFinite(price)?price:null;
 }catch{return null;}
}
async function poolProof(chain, rpc, receipt) {
  const transfers = uniTransfers(receipt), emitters = [...new Set(receipt.logs.filter(l => SWAPS.has(l.topics?.[0]) && transfers.some(t => t.token === chain.uni.address
    && [t.from, t.to].includes(l.address.toLowerCase()))).map(l => l.address.toLowerCase()))], verified = [];
  for (const pool of emitters) {
    const r = await multi(rpc, ['0xc45a0155','0x0dfe1681','0xd21220a7','0xddca3f43'].map(data => ({ to: pool, data })), Number(BigInt(receipt.blockNumber)));
    if (r.some(v => !v.ok)) continue;
    const factory = addr(need(r[0])), a0 = addr(need(r[1])), a1 = addr(need(r[2])), fee = word(need(r[3]));
    if (factory !== chain.factory || ![a0, a1].includes(chain.uni.address)) continue;
    const found = await multi(rpc, [{ to: factory, data: '0x1698ee82' + pad(a0) + pad(a1) + pad(fee.toString(16)) }], Number(BigInt(receipt.blockNumber)));
    if (addr(need(found[0])) === pool) verified.push(pool);
  }
  return verified;
}
export async function advanceUniTrades(input, { maxWindows = 2, rpcFactory, now = Date.now, job = false, readTransferBatch, maxTransferWindows = job ? 4000 : 0, maxRecentWindows = 32 } = {}) {
  validUniTradeBook(input); const book = clone(input), quotes = {}, wallets = [], errors = {}, historyErrors = {}, at = Math.floor((typeof now === 'function' ? now() : now) / 1000);
  for (const chain of Object.values(UNI_CHAINS)) {
    const chainDeadline=Date.now()+(job?200000:22000);
    const rpc = rpcFactory ? rpcFactory(chain) : createUniRpc(chain, { timeoutMs: job ? 200000 : 22000, maxRequests: job ? 6000 : 150, minIntervalMs: chain.key === 'bnb' ? 250 : 120, rateRetries: 2 });
    try {
      const head = Number(BigInt(await rpc('eth_blockNumber', []))), block = await rpc('eth_getBlockByNumber', [hex(head), false]),
        tip = { number: head, ts: Number(BigInt(block.timestamp)), hash: block.hash };
      if (Math.abs(Math.floor((typeof now === 'function' ? now() : now) / 1000) - tip.ts) > 180) throw Error('UNI chain head is stale');
      try { const spot = await readUniSpot(chain, rpc, tip); quotes[chain.key] = spot.quote; wallets.push(...spot.wallets); } catch { errors[chain.key + '_quote'] = 'Current UNI price or wallet balance unavailable'; }
      let state = book.chains[chain.key];
      if (!state) {
        for (const owner of WALLETS) if ((await rpc('eth_getCode', [owner, hex(head)])) !== '0x') throw Error('Contract-wallet history needs a dedicated adapter');
        const first = Math.min(...await Promise.all(WALLETS.map(owner => firstWalletActivity(rpc, owner, head))));
        state = { chainId: chain.id, uni: chain.uni.address, startBlock: first, cursor: first - 1, cursorHash: first === head + 1 ? tip.hash : null, head, ts: tip.ts };
        book.chains[chain.key] = state;
      }
      if (head < state.cursor) throw Error('UNI source head is behind the saved checkpoint');
      if (state.cursorHash) {
        const checkpoint = await rpc('eth_getBlockByNumber', [hex(state.cursor), false]);
        if (checkpoint.hash !== state.cursorHash) throw Error('UNI history checkpoint changed; saved trades retained');
      }
      state.head = head; state.ts = tip.ts;
      const counts = async blockNumber => Promise.all(WALLETS.map(owner => rpc('eth_getTransactionCount', [owner, hex(blockNumber)]).then(value => {
        if (!/^0x[0-9a-f]+$/i.test(value || '') || BigInt(value) > 1000000n) throw Error('Invalid UNI wallet nonce');
        return Number(BigInt(value));
      })));
      const endCounts = await counts(head);
      let current = await counts(state.cursor);
      if (state.nonces && WALLETS.some((owner, i) => state.nonces[owner] !== current[i])) throw Error('UNI wallet checkpoint changed');
      for (let n = 0; state.cursor < head && n < maxWindows; n++) {
        if (endCounts.some((value, i) => value < current[i])) throw Error('UNI wallet nonce decreased');
        if (endCounts.every((value, i) => value === current[i])) {
          state.cursor = head; state.cursorHash = tip.hash; state.readAt = tip.ts;
          state.nonces = Object.fromEntries(WALLETS.map((owner, i) => [owner, current[i]]));
          break;
        }
        // A nonce change locates every wallet-initiated transaction, including
        // swaps on an unknown DEX. Avoid huge, often rate-limited log scans.
        const next = await Promise.all(WALLETS.map(async (owner, i) => {
          if (endCounts[i] === current[i]) return head + 1;
          let lo = state.cursor, hi = head;
          while (hi - lo > 1) {
            const mid = Math.floor((hi + lo) / 2), value = BigInt(await rpc('eth_getTransactionCount', [owner, hex(mid)]));
            if (value > BigInt(current[i])) hi = mid; else lo = mid;
          }
          return hi;
        }));
        const number = Math.min(...next), source = await rpc('eth_getBlockByNumber', [hex(number), true]);
        if (Number(BigInt(source.number)) !== number || !Array.isArray(source.transactions)) throw Error('Complete UNI transaction block unavailable');
        const expected = await counts(number), transactions = source.transactions.filter(t => WALLETS.includes(t?.from?.toLowerCase())), fresh = [];
        for (let i = 0; i < WALLETS.length; i++) {
          const nonces = transactions.filter(t => t.from.toLowerCase() === WALLETS[i]).map(t => Number(BigInt(t.nonce))).sort((a,b)=>a-b);
          if (nonces.length !== expected[i] - current[i] || nonces.some((value, k) => value !== current[i] + k)) throw Error('Incomplete UNI transaction block');
        }
        for (const transaction of transactions) {
          if (transaction.blockHash !== source.hash || Number(BigInt(transaction.blockNumber)) !== number) throw Error('UNI transaction block changed');
          const receipt = await rpc('eth_getTransactionReceipt', [transaction.hash]);
          if (!receipt || receipt.transactionHash !== transaction.hash || receipt.blockHash !== source.hash || Number(BigInt(receipt.blockNumber)) !== number || !['0x0','0x1'].includes(receipt.status)) throw Error('UNI receipt unavailable');
          if (receipt.status !== '0x1' || !uniTransfers(receipt).some(t => t.token === chain.uni.address)) continue;
          const verifiedPools = await poolProof(chain, rpc, receipt), found = receiptUniTrade({ chain, wallets: WALLETS, receipt, transaction, ts: Number(BigInt(source.timestamp)), verifiedPools });
          if (found.trade && !book.trades.some(t => t.id === found.trade.id)) fresh.push(found.trade);
        }
        const confirm = await rpc('eth_getBlockByNumber', [hex(number), false]);
        if (confirm.hash !== source.hash) throw Error('UNI transaction block changed during reading');
        book.trades.push(...fresh); state.cursor = number; state.cursorHash = source.hash; state.readAt = Number(BigInt(source.timestamp));
        current = expected; state.nonces = Object.fromEntries(WALLETS.map((owner, i) => [owner, current[i]]));
      }
      if (current.every((value,i)=>value===endCounts[i])) {
        state.cursor = head; state.cursorHash = tip.hash; state.readAt = tip.ts;
        state.nonces = Object.fromEntries(WALLETS.map((owner,i)=>[owner,current[i]]));
      }
      if ((await rpc('eth_getBlockByNumber', [hex(head), false])).hash !== tip.hash) throw Error('UNI source head changed during reading');
      state.head = head; state.ts = tip.ts;
      const flowOptions={deadlineMs:chainDeadline,provePool:poolProof,readReturnPrice:readUniReturnPrice,quote:quotes[chain.key]||book.quotes?.[chain.key],
        readBatch:readTransferBatch?filters=>readTransferBatch(chain,filters):rpcFactory?filters=>Promise.all(filters.map(f=>rpc('eth_getLogs',[f]))):undefined};
      // Current fills have their own checkpoint and budget. An archive backfill
      // must not hold live reads behind months of old empty BNB blocks.
      await scanUniFlows(book,chain,rpc,tip,{...flowOptions,recent:true,maxWindows:maxRecentWindows});
      if(maxTransferWindows>0)try{await scanUniFlows(book,chain,rpc,tip,{...flowOptions,maxWindows:historyCovered(state)?0:maxTransferWindows});}catch(error){historyErrors[chain.key]=String(error.message).slice(0,160);}
      if(historyCovered(state))delete historyErrors[chain.key];
      else if(!historyErrors[chain.key])historyErrors[chain.key]='Earlier transfer history is still syncing';

    } catch (error) { errors[chain.key] = String(error.message).slice(0, 160); }
  }
  validUniTradeBook(book);
  const complete=Object.values(UNI_CHAINS).every(c=>!!book.chains[c.key]&&(book.chains[c.key].recentCursor===book.chains[c.key].head||book.chains[c.key].transferCursor===book.chains[c.key].head)&&!errors[c.key]),
    historyComplete=Object.values(UNI_CHAINS).every(c=>historyCovered(book.chains[c.key])&&!historyErrors[c.key]&&!errors[c.key]);
  const inventoryCoverage=Object.fromEntries(Object.entries(book.chains).map(([chain,state])=>{const full=historyCovered(state);return [chain,{complete:(full||state.recentCursor===state.head&&state.recentOpeningUni!==null)&&!errors[chain],fromBlock:full?state.transferStart:state.recentStart,throughBlock:full?state.head:state.recentCursor,openingUni:full?state.openingUni:state.recentOpeningUni}];}));
  return {book,quotes,wallets,errors,historyErrors,historyComplete,inventoryCoverage,complete,at};
}
const cache = createLiveCache({ complete: v => v.complete === true && !Object.keys(v.errors).length }), checkpoints = new Map();
export async function readUniTradeView(origin) {
  const saved = validUniTradeBook(await fetchJSON(origin + '/uni-trades.json'));
  const identity = JSON.stringify(saved), prior = checkpoints.get(origin), input = prior?.identity === identity ? prior.book : saved;
  const next = await advanceUniTrades(input), quotes = {}, balances = new Map();
  for (const source of [saved.quotes || {}, prior?.quotes || {}, next.quotes]) for (const [key, quote] of Object.entries(source))
    if (!quotes[key] || quote.ts >= quotes[key].ts) quotes[key] = quote;
  for (const row of [...(saved.walletReadings || []), ...(prior?.wallets || []), ...next.wallets]) {
    const key = row.chain + ':' + row.owner;
    if (!balances.has(key) || row.ts >= balances.get(key).ts) balances.set(key, row);
  }
  const walletReadings = [...balances.values()];
  checkpoints.set(origin, { identity, book: next.book, quotes, wallets: walletReadings });
  if (checkpoints.size > 8) checkpoints.delete(checkpoints.keys().next().value);
  return { schemaVersion: 'uni-trade-view-v1', accountingVersion:2, ...next, quotes, wallets: walletReadings, trades: next.book.trades, flows:next.book.flows||[], summary: replayUniTrades(next.book.trades, quotes) };
}
export async function handleUniTrades(req, res) {
  const query = req.query || Object.fromEntries(new URL(req.url || '/', 'https://local.invalid').searchParams);
  if (query.view !== 'trades') return false;
  responseHeaders(res);
  try { const origin = requestOrigin(req), view = await cache(origin, () => readUniTradeView(origin)); responseHeaders(res, view.complete && !Object.keys(view.errors).length); res.status(200).end(JSON.stringify(view)); }
  catch { res.status(502).end(JSON.stringify({ error: 'UNI trades could not be refreshed.' })); }
  return true;
}
