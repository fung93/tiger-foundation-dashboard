# Chain engine

Reading an EVM chain without a library. The whole layer is four primitives — pad a value to 32
bytes, slice a word out of a return blob, encode an `aggregate3` batch, decode it — and
everything else composes those.

## Contents

- [Why no library](#why-no-library)
- [The four primitives](#the-four-primitives)
- [Batching through Multicall3](#batching-through-multicall3)
- [Selectors worth knowing](#selectors-worth-knowing)
- [Reading event logs](#reading-event-logs)
- [Discovering topic hashes](#discovering-topic-hashes)
- [Discovery beats configuration](#discovery-beats-configuration)
- [Endpoint hygiene](#endpoint-hygiene)

## Why no library

ethers/viem cost 100kB+ and a bundler. Hand-encoding the six calls you actually use is ~80
lines and lets the whole dashboard stay a single HTML file with no build step. The same code
runs unchanged in the browser and in a Node script with zero dependencies — which is what makes
the scheduled job trivial to operate.

This is a real trade. If you need to encode arbitrary ABIs, dynamic tuples, or write
transactions, use a library. For reading a fixed set of view functions, hand-encoding wins.

## The four primitives

```js
function pad(hex){ return hex.replace(/^0x/,'').padStart(64,'0'); }
function padAddr(a){ return pad(a.toLowerCase()); }
function w(data,i){ return '0x'+data.slice(2+i*64,2+(i+1)*64); }   // word i of a return blob
function toBig(hex){ return BigInt(hex); }
function toSigned(hex){                                            // int24/int256 from a word
  var v=BigInt(hex), max=1n<<255n;
  return v>=max ? v-(1n<<256n) : v;
}
function toAddr(word){ return '0x'+word.slice(-40); }
```

`toSigned` matters more than it looks — tick values are signed, and reading a negative tick as
unsigned produces an astronomically large number that silently poisons every downstream
calculation rather than throwing.

## Batching through Multicall3

Multicall3 is deployed at the same address on essentially every EVM chain:
`0xcA11bde05977b3631167028862bE2a173976CA11`. One `eth_call` replaces a dozen round trips.

```js
function encodeAgg3(calls){
  var head='0x82ad56cb'+pad('20')+pad(calls.length.toString(16));
  var offs='', body='', base=calls.length*32;
  calls.forEach(function(c){
    var data=c.data.replace(/^0x/,'');
    var blob=padAddr(c.to)+pad('1')+pad('60')          // target, allowFailure=true, bytes offset
            +pad((data.length/2).toString(16))
            +data+'0'.repeat((32-(data.length/2)%32)%32*2);
    offs+=pad((base+body.length/2).toString(16));
    body+=blob;
  });
  return head+offs+body;
}
```

**Set `allowFailure` to true on every call.** One reverting position must not void the whole
batch — and positions revert for ordinary reasons, like being closed between the discovery call
and the read.

Decoding returns an array of `{success, data}`. Check `success` per entry; a failed entry is
normal, not exceptional.

## Selectors worth knowing

| Selector | Signature | Reads |
|---|---|---|
| `0x70a08231` | `balanceOf(address)` | Any ERC-20 balance, or an NFT count |
| `0x2f745c59` | `tokenOfOwnerByIndex(address,uint256)` | Enumerate held NFTs |
| `0x6352211e` | `ownerOf(uint256)` | Confirm a staked NFT is still yours |
| `0x99fbab88` | `positions(uint256)` | V3 LP position: ticks, liquidity, owed fees |
| `0x3850c7bd` | `slot0()` | Pool price as `sqrtPriceX96`, plus current tick |
| `0x1698ee82` | `getPool(address,address,uint24)` | Resolve a pool from its token pair |
| `0x07a2d13a` | `convertToAssets(uint256)` | ERC-4626 vault share → underlying |
| `0x82ad56cb` | `aggregate3((address,bool,bytes)[])` | The batch itself |

Derive any others with `keccak256("name(type,type)")` truncated to 4 bytes — don't guess.

## Reading event logs

Ledgers are rebuilt from logs. Two properties decide how expensive that is, and both vary by
chain and provider — run `scripts/probe-chain.mjs` rather than assuming.

**Archive state.** If the RPC answers `eth_call` at a historical block tag, you can price an
event exactly at the block it happened. If it doesn't, say the number is approximate rather than
quietly shipping it. Public RPCs on newer chains often do serve archive state — test before
concluding you need a paid provider.

**Inline `blockTimestamp`.** Some clients return it on each log. If yours does, you have saved
one `eth_getBlockByNumber` per log, which is the difference between a snappy ledger and a slow
one. Write the fallback only if the probe says you need it.

**Window the scan and resume.** Store `last_block` in the ledger file and scan forward from it.
A fixed lookback window (a few days of blocks) is enough for the browser's live pass, since the
scheduled job owns everything older.

## Discovering topic hashes

Never copy a topic hash from documentation or a blog post — the same event name has different
signatures across protocol versions, and a wrong hash produces an **empty ledger rather than an
error**, which is the worst possible failure mode because it looks like "no activity".

Pull an unfiltered window for the contract, group by `topics[0]`, and match the groups against
activity you know happened:

```bash
node scripts/probe-chain.mjs --rpc <url> --contract 0x... --topics
```

Five minutes of this is the difference between a correct ledger and a confidently empty one.

## Discovery beats configuration

Position IDs, pool addresses and token accounts change as you trade. Anything the scheduled job
can rediscover each run, it should: enumerate NFTs by index, resolve pools from token pairs,
find token accounts by owner. Then **publish what it found back into the snapshot**, so the
browser starts from current truth rather than a constant someone has to remember to update.

The pattern: config holds the wallet and the protocol contracts; everything else is discovered.

## Endpoint hygiene

- **Keep a list per chain and fall through it.** Public endpoints fail in bursts.
- **Measure one good call's latency, then set the timeout at ~5× that.** Do not guess — a 10s
  default on a 400ms call is 25 seconds of dead air when it fails.
- **Memoise dead endpoints for the session.** Retrying a hung host on every pass is how a
  4-second refresh becomes a 21-second one.
- **Watch for methods that hang rather than error.** These are worse than failures because no
  `catch` fires. If a method stalls, look for a narrower one: reading a known account directly
  often replaces an enumeration call that never returns.
