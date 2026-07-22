# Hashlock Markets SDK

Official TypeScript and Python SDKs for the **Hashlock Markets** developer API — non-custodial
cross-chain atomic swaps (**BTC ↔ EVM / TRON**) over sealed RFQ + HTLC.

- **Non-custodial.** Settlement endpoints return *unsigned* transactions. You sign with your own key or
  HSM; the server never holds your keys.
- **Native, no bridge.** Real BTC ↔ real EVM/TRON assets, settled directly via HTLC — no wrapped tokens,
  no bridge, no custody of principal.
- **One API, two roles.** Takers post RFQs; makers quote them; both settle their legs with the same
  builders. Plus webhooks and a maker WebSocket feed.

| Package | Language | Install |
|---|---|---|
| [`typescript/`](./typescript) | TypeScript / JS (Node 18+, browsers, edge) | `npm i @hashlock-tech/sdk` |
| [`python/`](./python) | Python 3.9+ | `pip install hashlock-sdk` |
| [`examples/`](./examples) | Quickstarts + Fireblocks/Copper signing reference | — |

## Quick start (TypeScript)

```ts
import { HashlockClient, newSecret } from '@hashlock-tech/sdk';

const client = new HashlockClient({ apiKey: process.env.HASHLOCK_API_KEY! }); // hk_test_… / hk_live_…

const assets = await client.assets();
const btc = assets.find((a) => a.symbol === 'BTC')!;
const usdt = assets.find((a) => a.chain === 'ethereum' && a.symbol === 'USDT')!;

// Taker: sell BTC for USDT (funds the long leg → is the initiator).
const rfq = await client.createRfq({
  direction: 'sell_base',
  baseAssetId: btc.id,
  baseAmount: '10000', // sats
  quoteAssetId: usdt.id,
  ttlSeconds: 3600,
});

// …a maker quotes it, both accept (the initiator passes hashlock = sha256(secret)),
// then each side funds/claims its leg with the unsigned-tx builders.
const { hashlock } = await newSecret();
```

See [`examples/quickstart.ts`](./examples/quickstart.ts) for the full lifecycle, and
[`examples/fireblocks`](./examples/fireblocks) for signing the unsigned transactions with a custody
provider.

## How a swap works

1. **RFQ → quote → accept.** A taker posts an RFQ; a maker quotes it (opening a negotiation thread); both
   accept the terms. The **initiator** (whoever funds the long-timelock leg) generates a secret locally and
   submits only `hashlock = sha256(secret)`. When both accept, the swap is created.
2. **Addresses.** Each side sets its receive (payout) / refund address per leg (`setSwapAddress`). Bitcoin
   uses the compressed pubkey — the server derives the P2WSH.
3. **Fund.** The initiator funds the long leg; the counterparty funds the short leg. Each `buildFund` call
   returns an *unsigned* transaction (EVM txs / a Bitcoin payment / TRON txs) — you sign and broadcast.
4. **Claim.** The initiator claims the short leg with the secret — revealing it on-chain. The counterparty
   reads the secret and claims the long leg. **Atomic:** both legs settle, or both refund after their
   timelocks.

The same `sha256(secret)` hashlock binds every leg; asymmetric timelocks (long leg ≫ short leg) remove the
free-option/griefing risk.

## Core surface

- **Auth:** API key (`Authorization: Bearer hk_…` or `X-Api-Key`), scopes `read | taker | maker`.
- **Market:** `assets()`, `listRfqs()` / `rfqs()` (cursor-paginated), `getRfq()`, `createRfq()`, `quoteRfq()`.
- **Negotiation:** `getThread()`, `proposeTerms()`, `acceptProposal()`, `acceptTerms()`.
- **Swaps:** `listSwaps()` / `swaps()`, `getSwap()`, `setSwapAddress()`.
- **Settlement (unsigned):** `buildFund()`, `buildClaim()`, `buildRefund()`, `broadcast()`.
- **Webhooks:** `createWebhook()`, `listWebhooks()`, `deleteWebhook()`, `pingWebhook()` + `verifyWebhook()`.
- **Maker feed:** `MakerFeed` — stream quotable RFQs and submit quotes over a WebSocket.

Interactive API reference: `https://api-dev.hashlock.markets/v1/docs` (OpenAPI at `/v1/openapi.json`).

## License

MIT — see [LICENSE](./LICENSE).
