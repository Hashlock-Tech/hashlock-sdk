# @hashlock/sdk

TypeScript SDK for [HashLock](https://hashlock.tech) — institutional OTC trading with HTLC atomic settlement on Ethereum and Bitcoin.

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
