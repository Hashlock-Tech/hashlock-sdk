# @hashlock-tech/sdk

TypeScript SDK for the [Hashlock Markets](https://github.com/Hashlock-Tech/hashlock-sdk) developer API —
non-custodial cross-chain atomic swaps (BTC ↔ EVM/TRON). Runs on Node 18+, browsers, and edge runtimes
(native `fetch` / `WebSocket`, zero runtime dependencies).

```bash
npm i @hashlock-tech/sdk
```

```ts
import { HashlockClient, newSecret, verifyWebhook, MakerFeed } from '@hashlock-tech/sdk';

const client = new HashlockClient({ apiKey: process.env.HASHLOCK_API_KEY! });
await client.me();

// cursor pagination — page or auto-iterate
const page = await client.listSwaps({ limit: 20 });
for await (const swap of client.swaps()) { /* … */ }

// webhooks: verify a delivery against the raw body
const ok = await verifyWebhook({ secret, rawBody, signature: req.headers['x-hashlock-signature'], timestamp: req.headers['x-hashlock-timestamp'] });

// maker feed: stream RFQs and quote over a socket
const feed = new MakerFeed({ apiKey, onRfq: (rfq) => feed.quote(rfq.id, '650000') });
await feed.connect();
```

Settlement is custody-agnostic: `buildFund` / `buildClaim` / `buildRefund` return unsigned transactions —
sign with your wallet or HSM (see [`../examples/fireblocks`](../examples/fireblocks)) and `broadcast(...)`
(or let your custody provider broadcast). See the [root README](../README.md) for the full swap lifecycle.

## Build

```bash
npm install && npm run build   # tsup → dist (esm + d.ts)
npm run typecheck
```

MIT
