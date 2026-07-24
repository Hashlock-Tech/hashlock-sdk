# Signing with Fireblocks / Copper (reference)

The Hashlock developer API is **custody-agnostic**: `POST /v1/swaps/:id/legs/:leg/{fund,claim,refund}`
returns *unsigned* transactions, and you sign them with your own key material. This directory shows how to
sign them with an institutional custodian (Fireblocks; Copper follows the same shape).

> ✅ **EVM `CONTRACT_CALL` validated live** on Fireblocks Sandbox (Sepolia / `ETH_TEST5`): the unsigned
> `approve`/`createSwap` from `/v1` signs, broadcasts, and lands on-chain. TRON and Bitcoin paths remain
> documented references (Fireblocks Sandbox has Sepolia + BTC signet, but **not TRON Nile**). Fill in your
> own vault id + asset ids before running.

### Environment (sandbox)

```
FIREBLOCKS_API_KEY=<API key id (UUID)>
FIREBLOCKS_SECRET_KEY_PATH=<path to your RSA private key .key/.pem>
FIREBLOCKS_VAULT_ACCOUNT_ID=0            # numeric string (default sandbox vault is "0")
FIREBLOCKS_BASE_URL=https://sandbox-api.fireblocks.io   # prod: https://api.fireblocks.io
```

Fund the vault from **outside** Fireblocks: add the `ETH_TEST5` asset to the vault, copy its **receive
address**, and send testnet ETH (gas) + your ERC-20 to it from a faucet or another wallet. A `CONTRACT_CALL`
does **not** require the ERC-20 to be a Fireblocks-recognised asset — only the on-chain balance at the vault
address plus native `ETH_TEST5` for gas.

> **Python SDK gotcha:** `fireblocks-sdk` (Python) uses top-level string constants — `VAULT_ACCOUNT`,
> `ONE_TIME_ADDRESS`, `CONTRACT_CALL` — and `create_transaction(tx_type=…)` (not `operation=`). The
> **JavaScript** `fireblocks-sdk` uses the enums `PeerType`, `TransactionOperation`, `TransactionStatus`
> and `createTransaction({ operation, … })`. Both `sign_evm.py` / `sign_evm.ts` reflect their SDK's shape.

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
