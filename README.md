# @hashlock/sdk

TypeScript SDK for [HashLock](https://hashlock.tech) — institutional OTC trading with HTLC atomic settlement on Ethereum and Bitcoin.

> 📐 **Architecture:** how this SDK is layered and how it connects to the Hashlock Markets
> backend — [`docs/architecture/ARCHITECTURE.md`](./docs/architecture/ARCHITECTURE.md)
> ([Русский](./docs/architecture/ARCHITECTURE.ru.md)).

## Install

```bash
npm install @hashlock/sdk
# or
pnpm add @hashlock/sdk
```

## Quick Start

```ts
import { HashLock } from '@hashlock/sdk';

const hl = new HashLock({
  endpoint: 'http://142.93.106.129/graphql',
  accessToken: 'your-jwt-token',
});

// Create an RFQ to sell 1 ETH for USDT
const rfq = await hl.createRFQ({
  baseToken: 'ETH',
  quoteToken: 'USDT',
  side: 'SELL',
  amount: '1.0',
});

console.log(`RFQ created: ${rfq.id}`);
```

## Authentication

Get a JWT token by logging into the HashLock platform, then pass it to the SDK:

```ts
const hl = new HashLock({
  endpoint: 'http://142.93.106.129/graphql',
  accessToken: 'eyJhbGciOiJIUzI1NiIs...',
});

// Or update the token later
hl.setAccessToken('new-token');
```

## RFQ Trading

### Create an RFQ (Request for Quote)

```ts
const rfq = await hl.createRFQ({
  baseToken: 'BTC',
  quoteToken: 'USDT',
  side: 'BUY',
  amount: '0.5',
  expiresIn: 300, // 5 minutes
});
```

### Respond with a Quote

```ts
const quote = await hl.submitQuote({
  rfqId: rfq.id,
  price: '68500.00',
  amount: '0.5',
});
```

### Accept a Quote (creates a Trade)

```ts
const accepted = await hl.acceptQuote(quote.id);
// accepted.trade.id -> trade ready for settlement
```

### List & Query

```ts
const { rfqs, total } = await hl.listRFQs({ status: 'ACTIVE', page: 1 });
const rfq = await hl.getRFQ('rfq-uuid');
const quotes = await hl.getQuotes('rfq-uuid');
```

## Instant Settlement (Lane A)

Solvers (market makers running the instant-settlement flow) can commit to
**fronting the taker's asset immediately** when their quote is accepted, and
get reimbursed when the underlying trade settles. The whole surface is
**feature-flagged on the backend** — when the flag is off, the SDK degrades
gracefully (see *Flag-off behaviour* below).

> **Money fields:** `InstantFill.amountWei` is the committed amount in the
> asset's smallest on-chain unit (wei / sats / MIST) as a **decimal string**
> covering the full uint256 range. **Never convert it to a JS `number`**
> (precision is lost above 2^53) — use `BigInt(fill.amountWei)`.

### Taker flow

The canonical instant path is: `requestInstantFill` **succeeds first**, then
`acceptQuote`. The `requestInstantFillAndAccept` helper enforces this order
inside the SDK and maps every failure mode to a typed result:

```ts
import { policyPresets } from '@hashlock-tech/sdk';

const res = await hl.requestInstantFillAndAccept(rfq.id, quote.id, {
  policy: policyPresets.instant, // optional preference (see Policy semantics)
});

switch (res.kind) {
  case 'instant':
    // Fill committed AND quote accepted — solver fronting is on its way.
    console.log('instant fill', res.fill.id, BigInt(res.fill.amountWei));
    break;
  case 'standard':
    // Instant path refused with a typed reason — the SDK already fell
    // back to a normal acceptQuote, the trade proceeds on the standard path.
    // res.reason: 'disabled' | 'lane_conflict' | 'already_requested'
    // res.lane is set for lane_conflict.
    console.log('standard path:', res.reason);
    break;
  case 'fill_orphaned':
    // requestInstantFill succeeded but acceptQuote failed — the fill is
    // committed server-side. Retry the ACCEPT ONLY (never re-request the
    // fill: instant fills are exactly-once per quote and would 409):
    const retry = await hl.retryAcceptAfterInstantFill(res.fill);
    break;
}
```

Decision table implemented by the helper:

| `requestInstantFill` | `acceptQuote` | Result |
|---|---|---|
| OK | OK | `{ kind: 'instant', fill, quote }` |
| `INSTANT_FILL_DISABLED` | OK (fallback) | `{ kind: 'standard', reason: 'disabled', quote }` |
| 409 + `metadata.lane` | OK (fallback) | `{ kind: 'standard', reason: 'lane_conflict', lane, quote }` |
| 409 (already requested) | OK (fallback) | `{ kind: 'standard', reason: 'already_requested', quote }` |
| any other error | — (not attempted) | **thrown** (auth/network/unknown errors are never swallowed) |
| OK | FAIL | `{ kind: 'fill_orphaned', fill, error: InstantFillOrphanedError }` |

Takers can watch for the fronting payment:

```ts
const handle = hl.onInstantFillFronted((fill) => {
  console.log('fronted!', fill.frontTxHash);
});
// later: handle.unsubscribe();
```

### Solver flow

Submit an instant-fill quote, then serve incoming fill requests:

```ts
// 1. Commit on the quote (solverVaultAddr is required with instantFill)
const quote = await hl.submitQuote({
  rfqId: rfq.id,
  price: '3450.00',
  amount: '10.0',
  instantFill: true,
  solverVaultAddr: '0xYourVault...',
});

// 2. Watch for accepted instant fills and front them.
//    serveInstantFills = subscribe(instantFillRequested) + auto markInstantFillFronted
const handle = hl.serveInstantFills(async (fill) => {
  const txHash = await vault.front(fill.quoteId, BigInt(fill.amountWei));
  return txHash; // SDK calls markInstantFillFronted(fill.id, txHash) for you
}, {
  onFronted: (fill) => console.log('fronted', fill.id),
  onError: (err, fill) => console.error('fronting failed', fill?.id, err),
});

// Or drive the two halves manually:
hl.onInstantFillRequested(async (fill) => {
  const txHash = await vault.front(fill.quoteId, BigInt(fill.amountWei));
  await hl.markInstantFillFronted(fill.id, txHash);
});
```

Subscriptions use the `graphql-transport-ws` protocol. Browsers and
Node >= 22 work out of the box (global `WebSocket`); on Node 18/20 pass an
implementation: `new HashLock({ ..., webSocket: (await import('ws')).default })`.
Streams are scoped server-side by the authenticated user
(`instantFillRequested` → the quote's maker, `instantFillFronted` → the taker).

### Policy semantics — a preference, not a commitment

`acceptQuote(quoteId, policy)` takes an optional `AgentPolicy`
(`{ maxLatencyMs?, maxFeeBps?, minTrust? }`). A policy is **routing advice**:
it never causes the accept to fail. The SDK sanitizes it before sending —
invalid fields are dropped, and if nothing valid remains the accept silently
proceeds on the standard path with no policy at all.

Presets mirror the human speed slider 1:1 (single engine, two adapters):

| Preset | Policy | Under the hood |
|---|---|---|
| `policyPresets.instant` | `{ maxLatencyMs: 3000 }` | Lane A/B fronting, 0–1 confs, wide spread |
| `policyPresets.balanced` | `{ minTrust: 'med' }` | Lane A, 2–3 confs (add your own `maxFeeBps`) |
| `policyPresets.trustless` | `{ minTrust: 'max' }` | Lane Z pure HTLC, full confs, tight spread |

```ts
await hl.acceptQuote(quote.id, { ...policyPresets.balanced, maxFeeBps: 30 });
```

### Flag-off behaviour

The instant-settlement feature is gated by a backend flag. When it is off:

- `requestInstantFill` fails with `INSTANT_FILL_DISABLED` →
  `requestInstantFillAndAccept` returns `{ kind: 'standard', reason: 'disabled' }`
  and the trade completes on the standard path. Nothing throws.
- `submitQuote` with `instantFill: true` is rejected by the backend; plain
  quotes are unaffected.
- `policy` on `acceptQuote` remains a no-op preference — accepted and ignored.

## HTLC Settlement — ETH / ERC-20

After a trade is accepted, both parties lock assets in HTLC contracts.

### Record an HTLC Lock (after on-chain tx)

```ts
// 1. Send ETH lock tx on-chain via ethers.js / viem
// 2. Record it in HashLock:
const result = await hl.fundHTLC({
  tradeId: 'trade-uuid',
  txHash: '0xabc123...',
  role: 'INITIATOR',
  timelock: Math.floor(Date.now() / 1000) + 3600,
  hashlock: '0xdef456...',
  chainType: 'evm',
});
```

### Claim an HTLC (reveal preimage)

```ts
const claimed = await hl.claimHTLC({
  tradeId: 'trade-uuid',
  txHash: '0xclaim...',
  preimage: '0xsecret...',
  chainType: 'evm',
});
```

### Refund (after timelock expiry)

```ts
const refunded = await hl.refundHTLC({
  tradeId: 'trade-uuid',
  txHash: '0xrefund...',
});
```

### Check HTLC Status

```ts
const status = await hl.getHTLCStatus('trade-uuid');
console.log(status?.initiatorHTLC?.status);    // 'ACTIVE'
console.log(status?.counterpartyHTLC?.status);  // 'PENDING'
```

## HTLC Settlement — Bitcoin

Bitcoin HTLCs use P2WSH scripts (no smart contract deployment needed).

### Prepare a Bitcoin HTLC

```ts
const btcHtlc = await hl.prepareBitcoinHTLC({
  tradeId: 'trade-uuid',
  role: 'INITIATOR',
  senderPubKey: '02abc...',    // 33-byte compressed pubkey
  receiverPubKey: '03def...',
  timelock: Math.floor(Date.now() / 1000) + 7200,
  amountSats: '100000',        // 0.001 BTC
});

console.log(`Send BTC to: ${btcHtlc.htlcAddress}`);
// Fund this P2WSH address with your Bitcoin wallet
```

### Claim a Bitcoin HTLC

```ts
// Build unsigned PSBT
const psbt = await hl.buildBitcoinClaimPSBT({
  tradeId: 'trade-uuid',
  htlcId: btcHtlc.htlcId,
  preimage: '0xsecret...',
  destinationPubKey: '02abc...',
  feeRate: 10, // sat/vB
});

// Sign with wallet (Xverse, Leather, UniSat, etc.)
const signedTx = await wallet.signPsbt(psbt.psbtBase64);

// Broadcast
const broadcast = await hl.broadcastBitcoinTx({
  tradeId: 'trade-uuid',
  txHex: signedTx,
});
console.log(`BTC claimed: ${broadcast.txid}`);
```

## Cross-Chain Atomic Swap (ETH ↔ BTC)

```ts
// Alice (ETH side) locks USDT on Ethereum
await hl.fundHTLC({
  tradeId, txHash: evmTxHash, role: 'INITIATOR',
  hashlock, timelock: now + 7200, chainType: 'evm',
});

// Bob (BTC side) locks BTC on Bitcoin
const btc = await hl.prepareBitcoinHTLC({
  tradeId, role: 'COUNTERPARTY',
  senderPubKey: bobPub, receiverPubKey: alicePub,
  timelock: now + 3600, amountSats: '100000',
});
// Bob funds the P2WSH address, then:
await hl.fundHTLC({
  tradeId, txHash: btcFundingTxid, role: 'COUNTERPARTY',
  chainType: 'bitcoin', redeemScript: btc.redeemScript,
});

// Alice claims BTC (reveals preimage)
// Bob sees preimage on-chain → claims USDT on Ethereum
// Trade complete!
```

## Error Handling

```ts
import { HashLockError, GraphQLError, AuthError, NetworkError } from '@hashlock/sdk';

try {
  await hl.getTrade('bad-id');
} catch (err) {
  if (err instanceof AuthError) {
    // Token expired — refresh and retry
  } else if (err instanceof GraphQLError) {
    console.error('API error:', err.errors);
  } else if (err instanceof NetworkError) {
    console.error('Network issue:', err.message);
  }
}
```

## Configuration

```ts
const hl = new HashLock({
  endpoint: 'http://142.93.106.129/graphql', // mainnet
  accessToken: 'jwt-token',
  timeout: 30000,    // 30s (default)
  retries: 3,        // retry count (default)
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | `string` | — | GraphQL API URL (required) |
| `accessToken` | `string` | — | JWT bearer token |
| `timeout` | `number` | `30000` | Request timeout (ms) |
| `retries` | `number` | `3` | Retry attempts for transient failures |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch implementation |

## Mainnet Contracts (Ethereum)

| Contract | Address |
|----------|---------|
| HashedTimelockEther | [`0x0CEDC56b17d714dA044954EE26F38e90eC10434A`](https://etherscan.io/address/0x0cedc56b17d714da044954ee26f38e90ec10434a) |
| HashedTimelockEtherFee | [`0xfBAEA1423b5FBeCE89998da6820902fD8f159014`](https://etherscan.io/address/0xfbaea1423b5fbece89998da6820902fd8f159014) |
| HashedTimelockERC20Fee | [`0x4B65490D140Bab3DB828C2386e21646Ed8c4D072`](https://etherscan.io/address/0x4b65490d140bab3db828c2386e21646ed8c4d072) |

## License

MIT


## About Hashlock Markets

Hashlock Markets (`hashlock.markets`) is operated by Hashlock Corp., a Delaware C-Corporation. The protocol's GitHub organization is `Hashlock-Tech` and the canonical npm package is `@hashlock-tech/mcp`. Hashlock Markets is **not affiliated with Hashlock Pty Ltd** (`hashlock.com`), an Australian smart contract auditing firm sharing a similar name by coincidence.

For more on the protocol: [hashlock.markets](https://hashlock.markets) · [Documentation](https://hashlock.markets/docs) · [llms.txt](https://hashlock.markets/llms.txt) · [MCP Registry](https://registry.modelcontextprotocol.io) · [All Hashlock-Tech repos](https://github.com/Hashlock-Tech)
