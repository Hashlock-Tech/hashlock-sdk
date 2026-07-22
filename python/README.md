# hashlock-sdk (Python)

Python SDK for the [Hashlock Markets](https://github.com/Hashlock-Tech/hashlock-sdk) developer API —
non-custodial cross-chain atomic swaps (BTC ↔ EVM/TRON). Python 3.9+, built on `httpx`.

```bash
pip install hashlock-sdk          # add [ws] for the maker WebSocket feed: hashlock-sdk[ws]
```

```python
from hashlock import HashlockClient, new_secret, verify_webhook

client = HashlockClient(api_key=os.environ["HASHLOCK_API_KEY"])
client.me()

# cursor pagination — page or auto-iterate
page = client.list_swaps(limit=20)
for swap in client.swaps():
    ...

# initiator: secret stays private; submit only the hashlock
secret, hashlock = new_secret()
client.accept_terms(thread_id, hashlock=hashlock)

# webhooks: verify a delivery against the raw body
ok = verify_webhook(secret, raw_body, request.headers.get("x-hashlock-signature"), request.headers.get("x-hashlock-timestamp"))
```

Settlement is custody-agnostic: `build_fund` / `build_claim` / `build_refund` return unsigned transactions —
sign with your wallet or HSM (see [`../examples/fireblocks`](../examples/fireblocks)) and `broadcast(...)`.
See the [root README](../README.md) for the full swap lifecycle.

MIT
