# Hashlock Markets SDK

Official TypeScript and Python SDKs for the **Hashlock Markets** developer API — non-custodial
cross-chain atomic swaps (**BTC ↔ EVM / TRON / Solana**) over sealed RFQ + HTLC.

📖 **Documentation:** [docs.hashlock.markets](https://docs.hashlock.markets) — concepts, quickstart, guides and the API reference. For agents: [`llms.txt`](https://docs.hashlock.markets/llms.txt) (index), [`llms-full.txt`](https://docs.hashlock.markets/llms-full.txt) (everything in one file), any page as Markdown by adding `.md`, and a docs-search MCP server at `https://docs.hashlock.markets/mcp`.

> **Stable (1.x).** The SDK defaults to the production API (`api.hashlock.markets`); pass `baseUrl` to
> target another deployment. Breaking changes come only with a new major version.

- **Non-custodial.** Settlement endpoints return *unsigned* transactions. You sign with your own key or
  HSM; the server never holds your keys.
- **Native, no bridge.** Real BTC ↔ real EVM/TRON/Solana assets, settled directly via HTLC — no wrapped tokens,
  no bridge, no custody of principal.
- **One API, two roles.** Takers post RFQs; makers quote them; both settle their legs with the same
  builders. Plus webhooks and a maker WebSocket feed.

| Package | Language | Install |
|---|---|---|
| [`typescript/`](./typescript) | TypeScript / JS (Node 18+, browsers, edge) | `npm i @hashlock-tech/sdk` |
| [`python/`](./python) | Python 3.9+ | `pip install hashlock-sdk` |
| [`examples/`](./examples) | Quickstarts + Fireblocks/Copper signing reference | — |


## A price keeps at most 8 decimals

- A new price (a private order's `askAmount`, the amount in `quoteRfq` / `quote_rfq` and in `proposeTerms` /
  `propose_terms`) has at most 8 decimals of its asset, fewer when the asset has fewer: in base units, a multiple of
  10^(decimals − min(decimals, 8)). The API refuses more with "a price has at most N decimals" (N is 8, or the asset's own count when it has fewer), so round a computed price down.
  Accepting a price already on the table is not affected. No SDK change is needed.

## New in 1.0.0 (since 0.7.0)

- **Bitcoin pre-signed claim and refund.** `buildPresign(swapId, leg, { kind?, to? })` / `build_presign(...)` returns
  the leg's claim (its receiver) or the initiator's refund at up to three fee levels; sign every sighash and send them
  back with `storePresign` / `store_presign`. The keeper broadcasts the claim once the secret is revealed, so an
  offline receiver is still paid, and the refund once the deal cannot complete.
- **Where a Bitcoin claim pays.** The leg's receiver may send a Bitcoin address (not a pubkey) to `setSwapAddress` while
  no leg is funded: it becomes the swap's `aClaimTo` / `bClaimTo`, and a claim paying anywhere else is refused (409).
  `buildClaim` / `buildRefund` take an optional Bitcoin `to`; `buildRefund` also takes `escrow`, to refund an escrow
  the leg moved off after a pubkey correction.
- **Claim windows.** On every chain but Bitcoin a claim closes at the leg's timelock; the initiator's claim build is
  refused from 10 minutes before it, unless the secret is already out — then it is still built.
- **No agreeing to terms you cannot fund.** `proposeTerms`, `acceptProposal` and `acceptTerms` are refused ("Not enough X
  to fund this: … Top up first.") when your wallet cannot fund your own leg at that price: the amount, the protocol fee
  if you are the taker, and the chain's coin reserve when the leg is that coin.
- **Receive address fixed while it is being funded.** `setSwapAddress` refuses a payout change (409) while the other
  side's funding of the leg that pays you is on its way.
- **Solana funding checked before signing.** `buildFund` on a Solana leg is refused (400) with the reason when the
  wallet cannot cover it.
- New response fields: `Me.handle` / `handlePublic` (and `Me.wallets` is now typed), `Thread.counterpartyName`,
  `Asset.logoAt` / `logoAnimated` (the logo is at `https://hashlock.markets/api/assets/{id}/logo?v=<logoAt as epoch ms>`,
  the web host — not the API host), `Swap.aClaimTo` / `bClaimTo` and `Swap.aFundOutpoints` / `bFundOutpoints` (the
  Bitcoin outputs a claim or refund spends); `getThread` returns `swap` (null until both sides accept).

## Upgrading to 0.7.0

- **Taking a counter agrees the deal in one call.** `acceptProposal(threadId, quoteAmount, { accept: true, hashlock? })`
  (Python: `accept_proposal(..., accept=True, hashlock=None)`) takes the other side's price and records your
  acceptance in one server call; the initiator passes its hashlock. A hashlock without `accept` is refused
  before any request is sent.
- **Proposing is agreeing.** `proposeTerms(threadId, quoteAmount, { hashlock })` / `propose_terms(..., hashlock=None)`:
  the initiator passes its hashlock with every counter. `quoteRfq` / `quote_rfq` returns the thread, so a maker
  sees `makerAccepted` straight away.

## Upgrading to 0.6.0

- **The default base URL is production**, `https://api.hashlock.markets/v1`. Pass `baseUrl` (TypeScript) or
  `base_url` (Python) to talk to another deployment.
- **Accepting a price names the price.** `acceptProposal(threadId, quoteAmount, { accept?, hashlock? })` and
  `acceptTerms(threadId, { quoteAmount, hashlock? })` (Python: `accept_proposal(thread_id, quote_amount,
  accept=False, hashlock=None)`, `accept_terms(thread_id, quote_amount, hashlock=None)`). The API refuses an
  accept whose amount is no longer the one on the table, so a counter that lands first is never accepted by
  mistake. **Accept only the other side's price:** a quote or a counter is its author's acceptance, so taking
  a maker's quote with `acceptTerms`, or a counter with `acceptProposal(..., { accept: true })`, agrees the
  deal in that one call — once the other side's accepted flag (`makerAccepted` / `takerAccepted`) is set;
  check it rather than assume. The initiator agrees only with its hashlock: it passes it on its accept, on its
  counters (`proposeTerms(threadId, quoteAmount, { hashlock })`), and — as a maker whose `quoteRfq` returns
  `makerAccepted: false` — on an `acceptTerms` right after its quote. Use one secret per thread.
- `setSwapAddress(swapId, chain, address, leg?)` / `set_swap_address(..., leg=None)` takes the leg
  (`'a'` or `'b'`) — required when both legs are on the same chain.
- The maker WebSocket feed (`MakerFeed` / `maker_feed`) also connects to production by default. It takes
  `baseUrl` / `base_url` and derives the feed URL from it — pass the same value you give the client.

## Upgrading to 0.5.0

Solana is a settlement rail here now, and two older shapes were wrong:

- `BtcWitnessBuild` is **gone**. Bitcoin claims and refunds answer with `BtcSighashBuild` — a PSBT and
  one sighash per swept input — which is what the API has returned since 13 August. Sign each sighash and
  pass `{ psbtBase64, signaturesHex, preimageHex? }` back to `broadcast('bitcoin', …)`.
- `TronBuild.family` is `'tvm'`, not `'tron'`. A `family === 'tron'` branch never ran. The chain name
  in `broadcast('tron', …)` is unchanged — that route has its own vocabulary.

New: `SolanaBuild` (`sign: 'solana-tx'`), `broadcast('solana', signedBase64)`, and `feePayTo` /
`feeAmountSats` on a Bitcoin funding build — pay both or the leg does not count as funded.

## Quick start (TypeScript)

```ts
import { HashlockClient, newSecret } from '@hashlock-tech/sdk';

const client = new HashlockClient({ apiKey: process.env.HASHLOCK_API_KEY! }); // hk_live_…

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

// …a maker quotes it (its acceptance), the taker accepts (the initiator passes hashlock = sha256(secret)),
// then each side funds/claims its leg with the unsigned-tx builders.
const { hashlock } = await newSecret();
```

See [`examples/quickstart.ts`](./examples/quickstart.ts) for the full lifecycle, and
[`examples/fireblocks`](./examples/fireblocks) for signing the unsigned transactions with a custody
provider.

## How a swap works

1. **RFQ → quote → accept.** A taker posts an RFQ; a maker quotes it (opening a negotiation thread) — the
   quote is the maker's acceptance, so the taker's accept creates the swap. The **initiator** (whoever funds
   the long-timelock leg) generates a secret locally and submits only `hashlock = sha256(secret)`.
2. **Addresses.** Each side sets its receive (payout) / refund address per leg (`setSwapAddress`; pass the leg, `'a'` or `'b'`, when both legs are on one chain). Bitcoin
   uses the compressed pubkey — the server derives the P2WSH; the receiver may also send a Bitcoin address, which is where
   its claim then pays.
3. **Fund.** The initiator funds the long leg; the counterparty funds the short leg. Each `buildFund` call
   returns an *unsigned* transaction — you sign and broadcast. Funding is EVM txs, a Bitcoin payment,
   a Solana transaction or TRON txs; claiming and refunding hand Bitcoin back as PSBT sighashes.
4. **Claim.** The initiator claims the short leg with the secret — revealing it on-chain. The counterparty
   reads the secret and claims the long leg. **Atomic:** both legs settle, or both refund after their
   timelocks. On every chain but Bitcoin a claim closes at its leg's timelock (the initiator's 10 minutes earlier,
   unless the secret is already out — then it is still built).

The same `sha256(secret)` hashlock binds every leg; asymmetric timelocks (long leg ≫ short leg) remove the
free-option/griefing risk.

## Core surface

- **Auth:** API key (`Authorization: Bearer hk_…` or `X-Api-Key`), scopes `read | taker | maker`. Keys
  expire after 90 days. Create one at /developers, or with no browser by a wallet signature:
  `GET /v1/keys/nonce`, then `POST /v1/keys` (see `/v1/docs`). A wallet-only account holds one key
  (a new signed mint replaces it); an account signed up with email, Google or Telegram holds up to 10.
- **Payout addresses:** an address that receives money must be a wallet the account signed in with, or
  proved from a signed-in web session. A proof made with the API key (`POST /v1/wallets/<chain>`) widens
  what you can trade but does not count — a leaked key cannot redirect your money.
- **Account:** `me()`; `setProfile()` / `set_profile()` — the username and whether the accounts you trade with see
  it and your record. An account is anonymous until it goes public
  ([Account visibility](https://docs.hashlock.markets/concepts/account-visibility)).
- **Market:** `assets()`, `listRfqs()` / `rfqs()` (cursor-paginated), `getRfq()`, `createRfq()`, `quoteRfq()`.
- **Negotiation:** `getThread()`, `proposeTerms()`, `acceptProposal()`, `acceptTerms()`.
- **Swaps:** `listSwaps()` / `swaps()`, `getSwap()`, `setSwapAddress()`.
- **Settlement (unsigned):** `buildFund()`, `buildClaim()`, `buildRefund()`, `broadcast()`; Bitcoin pre-signing:
  `buildPresign()`, `storePresign()`.
- **Webhooks:** `createWebhook()`, `listWebhooks()`, `deleteWebhook()`, `pingWebhook()` + `verifyWebhook()`.
- **Maker feed:** `MakerFeed` — stream quotable RFQs and submit quotes over a WebSocket.

Interactive API reference: `https://api.hashlock.markets/v1/docs` (OpenAPI at `/v1/openapi.json`).

## License

MIT — see [LICENSE](./LICENSE).
