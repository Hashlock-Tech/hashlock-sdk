# Signing with Fireblocks / Copper (reference)

The Hashlock developer API is **custody-agnostic**: `POST /v1/swaps/:id/legs/:leg/{fund,claim,refund}`
returns *unsigned* transactions, and you sign them with your own key material. This directory shows how to
sign them with an institutional custodian (Fireblocks; Copper follows the same shape).

> ⚠️ Reference only — documented pattern, not a live-tested integration. Fill in your vault / account IDs
> and asset IDs, and validate against a testnet vault before production.

## Two signing models

The settlement build tells you which one applies via its `sign` field:

| `sign`         | Chain     | What the build gives you                                  | How to sign                                        |
|----------------|-----------|-----------------------------------------------------------|----------------------------------------------------|
| `evm-tx`       | EVM       | `txs: [{ to, data, value? }]`, `chainId`                  | Fireblocks **CONTRACT_CALL** (it signs *and* broadcasts) — or raw-sign + `client.broadcast('evm', rawTx)` |
| `tron-txid`    | TRON      | `transactions: [{ transaction, txID }]`                   | **Raw-sign** each `txID` (secp256k1), attach the signature, `client.broadcast('tron', signedTx)` |
| `btc-payment`  | Bitcoin   | `payTo`, `amountSats`                                     | A normal transfer from your BTC vault to `payTo`   |
| `btc-witness`  | Bitcoin   | `p2wsh`, `redeemHex`, `preimageHex` / `timelockUnix`      | **Raw-sign** the BIP-143 sighash, assemble the witness, `client.broadcast('bitcoin', rawHex)` |

**Custody providers that broadcast for you** (Fireblocks CONTRACT_CALL, a Bitcoin transfer): you do *not*
call `client.broadcast` — the provider submits the transaction and returns the on-chain hash.

**Raw-signing (HSM / Fireblocks RAW):** you get back a signature, assemble the final transaction yourself,
and relay it with `client.broadcast(chain, signed)`.

## Ordering & timelocks

- **TRON** funding is `approve` **then** `fund`; the `fund` transaction's `transferFrom` needs the
  `approve` **confirmed first**. TRON transactions expire ~60s after they're built, so submit `approve`,
  wait for it to confirm, then **re-fetch** `buildFund` for a fresh `fund` transaction before signing it.
- Fund the **long** leg first, then the counterparty funds the short leg. The initiator claims the short
  leg (revealing the secret); the counterparty then claims the long leg. Refund is available per-leg after
  its timelock.

See `sign_evm.ts` for the Fireblocks CONTRACT_CALL flow (EVM `fund` = approve + createSwap).
