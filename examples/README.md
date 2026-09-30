# Examples

- **`quickstart.ts` / `quickstart.py`** — a full BTC ↔ USDT swap through the developer API. Signing is
  yours; the settlement builders return unsigned transactions.
- **`fireblocks/`** — reference for signing those unsigned transactions with a custody provider
  (Fireblocks / Copper). Documented pattern, not a runnable integration test.

All examples target the production API (`https://api.hashlock.markets/v1`, not open yet) by default. Set
`HASHLOCK_API_KEY` (and `HASHLOCK_API_URL` to point at another environment).
