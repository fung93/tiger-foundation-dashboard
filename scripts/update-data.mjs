/**
 * Auto-update dashboard data from Katana + Solana chains.
 * Runs in GitHub Actions (Node 20+, no dependencies).
 * Writes data.json (full snapshot incl. meteora_refs for the browser's live mode)
 * and history.json (one entry per UTC date).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CFG = {
  rpcs: ['https://rpc.katanarpc.com', 'https://katana.drpc.org', 'https://747474.rpc.thirdweb.com'],
  wallet: '0xb378207ab46aa2105eb1cb94ae8a5bab57316de1',
  solWallet: 'GSMtKVYnxLbhfGQUBkdYW5npnu1LWP58ruBxVya5VM4B',
  multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
  npm: '0x2659C6085D26144117D904C46B48B6d180393d27',
  vkatNft: '0x106F7D67Ea25Cb9eFf5064CF604ebf6259Ff296d',      // vKAT lock NFT (ERC-721)
  votingEscrow: '0x4d6fC15Ca6258b168225D283262743C623c13Ead', // locked(tokenId) lives here
  factory: '0x203e8740894c8955cB8950759876d7E7E45E04c1',
  morpho: '0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc',
  marketId: '0x80e60fe453223b0f84a567724f88190bef708420d24397157067d424429783e9',
  tokens: {
    KAT:   { a: '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d', d: 18 },
    WETH:  { a: '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62', d: 18 },
    USDC:  { a: '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36', d: 6 },
    USDT:  { a: '0x2DCa96907fde857dd3D816880A0df407eeB2D2F2', d: 6 },
    avKAT: { a: '0x7231dbaCdFc968E07656D12389AB20De82FbfCeB', d: 18 },
  },
  poolKatUsdc: '0x10045367E619Caae6f60CC80046c43c6cD55f629',
  poolWethUsdc: '0x2A2C512beAA8eB15495726C235472D82EFFB7A6B',
  solRpcs: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
  dlmmProgram: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  solMint: 'So11111111111111111111111111111111111111112',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  merklApi: 'https://api.merkl.xyz/v4',
  startValue: 502.29,
  startDate: '2026-05-02',
  katClaimed: 84937,
  target: 10000,
};

/* ---------- evm helpers ---------- */
async function rpc(method, params) {
  let lastErr;
  for (const url of CFG.rpcs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
const w = (hex, i) => hex.substr(2 + i * 64, 64);
const toBig = (word) => BigInt('0x' + word);
const toSigned = (word) => { const v = toBig(word); return v > (1n << 255n) ? v - (1n << 256n) : v; };
const toAddr = (word) => '0x' + word.slice(24);

function encodeAgg3(calls) {
  let head = '0x82ad56cb' + pad('20') + pad(calls.length.toString(16));
  let offsets = '', tails = '';
  const base = calls.length * 32;
  for (const c of calls) {
    offsets += pad((base + tails.length / 2).toString(16));
    const data = c.data.replace(/^0x/, '');
    const padded = data + '0'.repeat((64 - (data.length % 64)) % 64);
    tails += pad(c.to) + pad('01') + pad('60') + pad((data.length / 2).toString(16)) + padded;
  }
  return head + offsets + tails;
}
function decodeAgg3(hex) {
  const h = hex.replace(/^0x/, '');
  const W = (i) => h.substr(i * 64, 64);
  const n = parseInt(W(1), 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    const elOff = parseInt(W(2 + i), 16) / 32 + 2;
    const ok = parseInt(W(elOff), 16) === 1;
    const dOff = parseInt(W(elOff + 1), 16) / 32 + elOff;
    const dLen = parseInt(W(dOff), 16);
    out.push({ ok, data: '0x' + h.substr((dOff + 1) * 64, dLen * 2) });
  }
  return out;
}
const multicall = async (calls) => decodeAgg3(await ethCall(CFG.multicall, encodeAgg3(calls)));

function v3Amounts(L, tickLo, tickHi, sqrtPX96) {
  const sp = Number(sqrtPX96) / 2 ** 96;
  const sa = Math.pow(1.0001, tickLo / 2), sb = Math.pow(1.0001, tickHi / 2);
  const Lf = Number(L);
  if (sp <= sa) return [Lf * (1 / sa - 1 / sb), 0];
  if (sp >= sb) return [0, Lf * (sb - sa)];
  return [Lf * (1 / sp - 1 / sb), Lf * (sp - sa)];
}
const poolPrice = (sqrtPX96, dec0, dec1) => {
  const sp = Number(sqrtPX96) / 2 ** 96;
  return sp * sp * Math.pow(10, dec0 - dec1);
};

/* ---------- solana helpers ---------- */
async function solRpc(method, params) {
  let lastErr;
  for (const url of CFG.solRpcs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const b64bytes = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));
function b58enc(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const dv = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength);
const dvU64 = (d, off) => d.getBigUint64(off, true);
const dvU128 = (d, off) => dvU64(d, off) + (dvU64(d, off + 8) << 64n);

/* ---------- katana ---------- */
async function getKatana() {
  const W = CFG.wallet.replace(/^0x/, '');
  const T = CFG.tokens;
  const calls = [
    { to: T.KAT.a, data: '0x70a08231' + pad(W) },
    { to: T.WETH.a, data: '0x70a08231' + pad(W) },
    { to: T.USDC.a, data: '0x70a08231' + pad(W) },
    { to: T.USDT.a, data: '0x70a08231' + pad(W) },
    { to: T.avKAT.a, data: '0x70a08231' + pad(W) },
    { to: T.avKAT.a, data: '0x07a2d13a' + pad('de0b6b3a7640000') }, // convertToAssets(1e18)
    { to: CFG.poolKatUsdc, data: '0x3850c7bd' },  // slot0
    { to: CFG.poolWethUsdc, data: '0x3850c7bd' }, // slot0
    { to: CFG.morpho, data: '0x93c52062' + CFG.marketId.slice(2) + pad(W) }, // position
    { to: CFG.morpho, data: '0x5c60e39a' + CFG.marketId.slice(2) },          // market
    { to: CFG.npm, data: '0x70a08231' + pad(W) }, // NFT count
    { to: CFG.vkatNft, data: '0x70a08231' + pad(W) }, // vKAT lock count
  ];
  const [ethHex, r] = await Promise.all([rpc('eth_getBalance', [CFG.wallet, 'latest']), multicall(calls)]);
  const ethBal = Number(BigInt(ethHex)) / 1e18;
  const bal = {
    KAT: Number(toBig(w(r[0].data, 0))) / 1e18,
    WETH: Number(toBig(w(r[1].data, 0))) / 1e18,
    USDC: Number(toBig(w(r[2].data, 0))) / 1e6,
    USDT: Number(toBig(w(r[3].data, 0))) / 1e6,
    avKAT: Number(toBig(w(r[4].data, 0))) / 1e18,
  };
  const avkatRate = Number(toBig(w(r[5].data, 0))) / 1e18;
  const katPrice = 1 / poolPrice(toBig(w(r[6].data, 0)), 6, 18);
  const ethPrice = 1 / poolPrice(toBig(w(r[7].data, 0)), 6, 18);
  const borrowShares = toBig(w(r[8].data, 1));
  const collateral = Number(toBig(w(r[8].data, 2))) / 1e18;
  const totBA = toBig(w(r[9].data, 2)), totBS = toBig(w(r[9].data, 3));
  const debt = totBS > 0n ? Number(borrowShares * totBA / totBS) / 1e18 : 0;
  let nftCount = Number(toBig(w(r[10].data, 0)));
  if (nftCount > 200) nftCount = 200;

  // vKAT staking locks: enumerate lock NFTs, read locked() amounts from the escrow
  let vkat = { totalKat: 0, ids: [] };
  let lockCount = Number(toBig(w(r[11].data, 0)));
  if (lockCount > 20) lockCount = 20;
  if (lockCount > 0) {
    try {
      const lidCalls = [];
      for (let li = 0; li < lockCount; li++)
        lidCalls.push({ to: CFG.vkatNft, data: '0x2f745c59' + pad(W) + pad(li.toString(16)) });
      const lids = (await multicall(lidCalls)).filter((x) => x.ok).map((x) => toBig(w(x.data, 0)));
      if (lids.length) {
        const la = await multicall(lids.map((id) => ({ to: CFG.votingEscrow, data: '0xb45a3c0e' + pad(id.toString(16)) })));
        let tot = 0;
        for (const res of la) if (res.ok) tot += Number(toBig(w(res.data, 0))) / 1e18;
        vkat = { totalKat: tot, ids: lids.map((x) => Number(x)) };
      }
    } catch { /* leave vkat empty on RPC failure */ }
  }

  // enumerate position NFTs, keep active ones
  const idCalls = [];
  for (let i = 0; i < nftCount; i++)
    idCalls.push({ to: CFG.npm, data: '0x2f745c59' + pad(W) + pad(i.toString(16)) });
  const idRes = nftCount ? await multicall(idCalls) : [];
  const ids = idRes.filter((x) => x.ok).map((x) => toBig(w(x.data, 0)));
  const posRes = ids.length ? await multicall(ids.map((id) => ({ to: CFG.npm, data: '0x99fbab88' + pad(id.toString(16)) }))) : [];
  const active = [];
  posRes.forEach((res, i) => {
    if (!res.ok) return;
    const d = res.data;
    const liq = toBig(w(d, 7)), owed0 = toBig(w(d, 10)), owed1 = toBig(w(d, 11));
    if (liq === 0n && owed0 === 0n && owed1 === 0n) return;
    active.push({
      tokenId: ids[i], token0: toAddr(w(d, 2)), token1: toAddr(w(d, 3)),
      fee: Number(toBig(w(d, 4))), tickLo: Number(toSigned(w(d, 5))), tickHi: Number(toSigned(w(d, 6))),
      liq, owed0, owed1,
    });
  });
  const poolRes = active.length ? await multicall(active.map((p) => ({
    to: CFG.factory, data: '0x1698ee82' + pad(p.token0) + pad(p.token1) + pad(p.fee.toString(16)),
  }))) : [];
  const slotRes = poolRes.length ? await multicall(poolRes.map((x) => ({ to: toAddr(w(x.data, 0)), data: '0x3850c7bd' }))) : [];

  const lc = (s) => s.toLowerCase();
  const priceOf = { [lc(T.USDC.a)]: 1, [lc(T.USDT.a)]: 1, [lc(T.KAT.a)]: katPrice, [lc(T.WETH.a)]: ethPrice, [lc(T.avKAT.a)]: katPrice * avkatRate };
  const decOf = { [lc(T.USDC.a)]: 6, [lc(T.USDT.a)]: 6, [lc(T.KAT.a)]: 18, [lc(T.WETH.a)]: 18, [lc(T.avKAT.a)]: 18 };
  const symOf = { [lc(T.USDC.a)]: 'vbUSDC', [lc(T.USDT.a)]: 'vbUSDT', [lc(T.KAT.a)]: 'KAT', [lc(T.WETH.a)]: 'vbETH', [lc(T.avKAT.a)]: 'avKAT' };

  const lps = [];
  active.forEach((p, i) => {
    if (!slotRes[i]?.ok) return;
    const sqrtP = toBig(w(slotRes[i].data, 0));
    const [a0, a1] = v3Amounts(p.liq, p.tickLo, p.tickHi, sqrtP);
    const t0 = lc(p.token0), t1 = lc(p.token1);
    if (decOf[t0] === undefined || decOf[t1] === undefined) return;
    const h0 = a0 / 10 ** decOf[t0] + Number(p.owed0) / 10 ** decOf[t0];
    const h1 = a1 / 10 ** decOf[t1] + Number(p.owed1) / 10 ** decOf[t1];
    const val = h0 * (priceOf[t0] || 0) + h1 * (priceOf[t1] || 0);
    if (val < 0.5) return;
    lps.push({
      type: 'LP', protocol: 'SushiSwap V3',
      pair: `${symOf[t0]} / ${symOf[t1]}`, pool_fee: `${p.fee / 10000}%`,
      value_usd: round2(val), apr: null,
      note: `NFT #${p.tokenId} — ${h0.toFixed(2)} ${symOf[t0]} + ${Math.round(h1).toLocaleString('en-US')} ${symOf[t1]} (auto-detected on-chain)`,
    });
  });

  return { ethBal, bal, avkatRate, katPrice, ethPrice, morpho: { collateral, debt }, lps, vkat };
}

/* ---------- solana ---------- */
async function getSolana() {
  const [balRes, usdcRes, posAccounts] = await Promise.all([
    solRpc('getBalance', [CFG.solWallet]),
    solRpc('getTokenAccountsByOwner', [CFG.solWallet, { mint: CFG.usdcMint }, { encoding: 'jsonParsed' }]),
    solRpc('getProgramAccounts', [CFG.dlmmProgram, {
      encoding: 'base64', dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: 40, bytes: CFG.solWallet } }],
    }]),
  ]);
  const sol = balRes.value / 1e9;
  const usdc = usdcRes.value.length ? Number(usdcRes.value[0].account.data.parsed.info.tokenAmount.uiAmount) : 0;

  const lps = [], refs = [];
  let poolSolPrice = null;
  for (const acc of posAccounts) {
    const posInfo = await solRpc('getAccountInfo', [acc.pubkey, { encoding: 'base64' }]);
    if (!posInfo.value) continue;
    const pos = b64bytes(posInfo.value.data[0]);
    const pdv = dv(pos);
    const lbPair = b58enc(pos.slice(8, 40));
    const lower = pdv.getInt32(7912, true), upper = pdv.getInt32(7916, true);
    const pairInfo = await solRpc('getAccountInfo', [lbPair, { encoding: 'base64' }]);
    const pair = b64bytes(pairInfo.value.data[0]);
    const padv = dv(pair);
    const binStep = padv.getUint16(80, true);
    const activeId = padv.getInt32(76, true);
    const mintX = b58enc(pair.slice(88, 120)), mintY = b58enc(pair.slice(120, 152));
    if (mintX !== CFG.solMint || mintY !== CFG.usdcMint) continue; // only SOL/USDC supported
    const base = 1 + binStep / 10000;
    poolSolPrice = Math.pow(base, activeId) * 1000;

    const idxs = [];
    for (let b = Math.floor(lower / 70); b <= Math.floor(upper / 70); b++) idxs.push(b);
    const binArrays = [];
    let totX = 0n, totY = 0n;
    for (const idx of idxs) {
      const le = new Uint8Array(8);
      let v = BigInt.asUintN(64, BigInt(idx));
      for (let i = 0; i < 8; i++) { le[i] = Number(v & 255n); v >>= 8n; }
      const gpa = await solRpc('getProgramAccounts', [CFG.dlmmProgram, {
        encoding: 'base64',
        filters: [{ memcmp: { offset: 8, bytes: b58enc(le) } }, { memcmp: { offset: 24, bytes: lbPair } }],
      }]);
      if (!gpa.length) continue;
      binArrays.push(gpa[0].pubkey);
      const arr = b64bytes(gpa[0].account.data[0]);
      const adv = dv(arr);
      const arrLower = idx * 70;
      for (let binId = lower; binId <= upper; binId++) {
        const j = binId - arrLower;
        if (j < 0 || j >= 70) continue;
        const share = dvU128(pdv, 72 + (binId - lower) * 16);
        if (share === 0n) continue;
        const off = 56 + j * 144;
        const supply = dvU128(adv, off + 32);
        if (supply === 0n) continue;
        totX += dvU64(adv, off) * share / supply;
        totY += dvU64(adv, off + 8) * share / supply;
      }
    }
    let feeX = 0n, feeY = 0n;
    for (let i = 0; i <= upper - lower; i++) {
      feeX += dvU64(pdv, 4552 + i * 48 + 32);
      feeY += dvU64(pdv, 4552 + i * 48 + 40);
    }
    refs.push({ position: acc.pubkey, lbPair, binArrays });
    lps.push({
      _sol: Number(totX + feeX) / 1e9, _usdc: Number(totY + feeY) / 1e6,
      _rangeLow: Math.pow(base, lower) * 1000, _rangeHigh: Math.pow(base, upper) * 1000,
      _pubkey: acc.pubkey,
    });
  }

  // SOL price: CoinGecko with on-chain pool price as fallback
  let solPrice = poolSolPrice;
  try {
    const j = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')).json();
    if (j?.solana?.usd) solPrice = j.solana.usd;
  } catch { /* keep pool price */ }
  if (!solPrice) solPrice = 0;

  const lpPositions = lps.map((p) => ({
    type: 'LP', protocol: 'Meteora DLMM', pair: 'SOL / USDC', pool_fee: 'DLMM',
    value_usd: round2(p._sol * solPrice + p._usdc), apr: null,
    note: `#${p._pubkey.slice(0, 6)} — range $${p._rangeLow.toFixed(1)}-$${p._rangeHigh.toFixed(1)}, ${p._sol.toFixed(3)} SOL + ${p._usdc.toFixed(2)} USDC (auto-detected on-chain)`,
  }));
  return { sol, usdc, solPrice, lps: lpPositions, refs };
}

/* ---------- merkl ---------- */
async function getMerkl(katPrice) {
  try {
    const arr = await (await fetch(`${CFG.merklApi}/users/${CFG.wallet}/rewards?chainId=747474`)).json();
    let totalUsd = 0;
    const rewards = [];
    for (const chain of arr || []) {
      for (const rw of chain.rewards || []) {
        const dec = rw.token?.decimals ?? 18;
        const unclaimed = BigInt(rw.amount || '0') - BigInt(rw.claimed || '0') + BigInt(rw.pending || '0');
        if (unclaimed <= 0n) continue;
        const amt = Number(unclaimed) / 10 ** dec;
        const sym = rw.token?.symbol || '?';
        const px = rw.token?.price || (sym === 'KAT' ? katPrice : 0);
        totalUsd += amt * px;
        rewards.push({ symbol: sym, amount: amt, usd: round2(amt * px) });
      }
    }
    return { total_usd: round2(totalUsd), rewards };
  } catch {
    return { total_usd: 0, rewards: [] };
  }
}
async function getAprs() {
  try {
    const arr = await (await fetch(`${CFG.merklApi}/opportunities?chainId=747474&action=POOL&items=50`)).json();
    const map = {};
    for (const o of Array.isArray(arr) ? arr : []) {
      const m = (o.name || '').match(/SushiSwap (\S+)-(\S+) ([\d.]+%)/);
      if (m) map[`${m[1]} / ${m[2]}|${m[3]}`] = o.apr;
    }
    return map;
  } catch { return {}; }
}

/* ---------- compose ---------- */
const round2 = (v) => Math.round(v * 100) / 100;

const [kat, sol] = await Promise.all([getKatana(), getSolana()]);
const [merkl, aprMap] = await Promise.all([getMerkl(kat.katPrice), getAprs()]);

for (const lp of kat.lps) {
  const key = `${lp.pair}|${lp.pool_fee}`;
  if (aprMap[key] !== undefined) lp.apr = round2(aprMap[key]);
}

const katWalletUsd = round2(
  kat.ethBal * kat.ethPrice + kat.bal.KAT * kat.katPrice + kat.bal.WETH * kat.ethPrice +
  kat.bal.USDC + kat.bal.USDT + kat.bal.avKAT * kat.katPrice * kat.avkatRate);
const katLpUsd = round2(kat.lps.reduce((s, l) => s + l.value_usd, 0));
const colKat = kat.morpho.collateral * kat.avkatRate;
const morphoNet = round2(Math.max(0, (colKat - kat.morpho.debt) * kat.katPrice));
const vkatKat = kat.vkat.totalKat;
const vkatUsd = round2(vkatKat * kat.katPrice);
const katTotal = round2(katWalletUsd + katLpUsd + morphoNet + vkatUsd + merkl.total_usd);
const solWalletUsd = round2(sol.sol * sol.solPrice + sol.usdc);
const solLpUsd = round2(sol.lps.reduce((s, l) => s + l.value_usd, 0));
const solTotal = round2(solWalletUsd + solLpUsd);
const grand = round2(katTotal + solTotal);
const onchainUsd = round2(katWalletUsd + solWalletUsd);
const lpUsd = round2(katLpUsd + solLpUsd);
const now = new Date();
const days = Math.floor((now - new Date(CFG.startDate + 'T00:00:00Z')) / 86400000);
const current = round2(grand - katLpUsd);
const gain = round2(current - CFG.startValue);

const tok = (balance, priceUSD, valueUSD) => ({ balance, priceUSD, valueUSD: round2(valueUSD) });
const defiPositions = [{
  type: 'Lending', protocol: 'Morpho Blue', market: 'KAT / avKAT',
  collateral: { amount: kat.morpho.collateral, token: 'avKAT' },
  debt: { amount: kat.morpho.debt, token: 'KAT' },
  lltv: '77%', avkat_rate: kat.avkatRate,
  note: `Net ${Math.round(colKat - kat.morpho.debt).toLocaleString('en-US')} KAT = $${morphoNet} · avKAT rate ${kat.avkatRate.toFixed(4)}`,
}];
if (vkatKat > 0) defiPositions.push({
  type: 'Staking', protocol: 'Katana vKAT',
  market: 'KAT voting escrow' + (kat.vkat.ids.length ? ' · veNFT #' + kat.vkat.ids.join(', #') : ''),
  locked: { amount: vkatKat, token: 'KAT' },
  value_usd: vkatUsd,
  note: `${Math.round(vkatKat).toLocaleString('en-US')} KAT staked = $${vkatUsd} · 60d cooldown to exit (auto-detected on-chain)`,
});

const data = {
  last_updated: now.toISOString(),
  wealth_target_usdc: CFG.target,
  tracking: {
    start_date: CFG.startDate,
    start_value_usd: CFG.startValue,
    current_value_usd: current,
    value_gain_usd: gain,
    kat_price: kat.katPrice,
    kat_tokens_claimed: CFG.katClaimed,
    monthly_roi_pct: round2(gain / CFG.startValue * 100),
    days_elapsed: days,
  },
  chains: {
    katana: {
      name: 'Katana', chain_id: 747474, explorer: 'https://explorer.katana.network',
      wallet: { balances: { tokens: {
        ETH: tok(kat.ethBal, kat.ethPrice, kat.ethBal * kat.ethPrice),
        KAT: tok(kat.bal.KAT, kat.katPrice, kat.bal.KAT * kat.katPrice),
        WETH: tok(kat.bal.WETH, kat.ethPrice, kat.bal.WETH * kat.ethPrice),
        USDC: tok(kat.bal.USDC, 1, kat.bal.USDC),
        USDT: tok(kat.bal.USDT, 1, kat.bal.USDT),
        avKAT: tok(kat.bal.avKAT, kat.katPrice * kat.avkatRate, kat.bal.avKAT * kat.katPrice * kat.avkatRate),
      }, total_usd: katWalletUsd } },
      onchain_usd: katWalletUsd,
      merkl_rewards: merkl,
      lp_positions: kat.lps,
      defi_positions: defiPositions,
      lp_total_usd: katLpUsd,
      total_usd: katTotal,
      native_token: 'KAT', color: '#f59e0b',
    },
    solana: {
      name: 'Solana', chain_id: 'solana-mainnet', explorer: 'https://solscan.io',
      wallet_address: CFG.solWallet,
      balances: {
        SOL: { balance: sol.sol, priceUSD: sol.solPrice, valueUSD: round2(sol.sol * sol.solPrice) },
        USDC: { balance: sol.usdc, priceUSD: 1, valueUSD: round2(sol.usdc) },
      },
      wallet_total_usd: solWalletUsd,
      onchain_usd: solWalletUsd,
      lp_positions: sol.lps,
      defi_positions: [],
      lp_total_usd: solLpUsd,
      total_usd: solTotal,
      native_token: 'SOL', color: '#9945ff',
    },
  },
  summary: {
    grand_total_usd: grand, katana_usd: katTotal, solana_usd: solTotal,
    onchain_usd: onchainUsd, lp_usd: lpUsd, merkl_usd: merkl.total_usd,
    total_defi_positions: defiPositions.length, chains_count: 2,
  },
  merkl_rewards: merkl,
  lp_positions: [...kat.lps, ...sol.lps],
  defi_positions: defiPositions,
  meteora_refs: sol.refs,
  onchain_usd: onchainUsd,
  total_usd: grand,
};

writeFileSync(join(ROOT, 'data.json'), JSON.stringify(data, null, 2) + '\n');

/* history: one entry per UTC date (replace same-date entry) */
const histPath = join(ROOT, 'history.json');
const hist = JSON.parse(readFileSync(histPath, 'utf8'));
const today = now.toISOString().slice(0, 10);
const entry = {
  date: today,
  timestamp: now.toISOString(),
  onchain_usd: onchainUsd,
  pending_usd: merkl.total_usd,
  lp_usd: lpUsd,
  solana_usd: solTotal,
  total_usd: grand,
};
const i = hist.data.findIndex((e) => e.date === today);
if (i >= 0) hist.data[i] = entry; else hist.data.push(entry);
writeFileSync(histPath, JSON.stringify(hist, null, 2) + '\n');

console.log(`Updated: total $${grand} | Katana $${katTotal} (wallet $${katWalletUsd}, LP $${katLpUsd}, Morpho $${morphoNet}, Merkl $${merkl.total_usd}) | Solana $${solTotal}`);
console.log(`KAT $${kat.katPrice.toFixed(6)} | ETH $${kat.ethPrice.toFixed(2)} | SOL $${sol.solPrice} | avKAT rate ${kat.avkatRate.toFixed(4)}`);
console.log(`Sushi LPs: ${kat.lps.length} | Meteora positions: ${sol.lps.length}`);
