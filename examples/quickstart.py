"""Quickstart: a full BTC <-> USDT(EVM) swap driven through the developer API.

    pip install hashlock-sdk
    HASHLOCK_API_KEY=hk_test_... python examples/quickstart.py

Signing is YOURS — the settlement builders return UNSIGNED transactions; sign with your wallet or HSM
(see examples/fireblocks) and either broadcast via client.broadcast(...) or let your custody provider
broadcast. The server never holds your keys.
"""
import os
import time

from hashlock import HashlockClient, new_secret


def sign_and_broadcast(build: dict) -> str:
    """Sign an unsigned settlement build with your own key/HSM and return a txid. See examples/fireblocks."""
    raise NotImplementedError("plug in your signer (wallet / Fireblocks / Copper)")


def main() -> None:
    client = HashlockClient(
        api_key=os.environ["HASHLOCK_API_KEY"],
        base_url=os.environ.get("HASHLOCK_API_URL", "https://api-dev.hashlock.markets/v1"),
    )
    me = client.me()
    print("authenticated:", me["userId"], me["scopes"])

    assets = client.assets()
    btc = next(a for a in assets if a["chain"] == "bitcoin" and a["symbol"] == "BTC")
    usdt = next(a for a in assets if a["chain"] == "ethereum" and a["symbol"] == "USDT")

    # 1) taker: sell BTC for USDT (the taker funds the long BTC leg -> is the initiator).
    rfq = client.create_rfq(
        direction="sell_base",
        base_asset_id=btc["id"],
        base_amount="10000",  # sats
        quote_asset_id=usdt["id"],
        ttl_seconds=3600,
    )
    print("rfq", rfq["id"])

    # 2) maker (a different account) quotes it -> opens a thread:
    #    thread = maker_client.quote_rfq(rfq["id"], "650000")["thread"]
    thread_id = "<thread id from the maker quote>"

    # 3) accept. The initiator supplies hashlock = sha256(secret).
    secret, hashlock = new_secret()  # keep `secret` private until you claim your leg
    client.accept_terms(thread_id, hashlock=hashlock)
    swap = client.accept_terms(thread_id)["swap"]  # created once BOTH sides have accepted

    # 4) set receive/refund addresses (Bitcoin uses the compressed pubkey hex).
    client.set_swap_address(swap["id"], "ethereum", "0xYourUsdtPayoutAddress")
    client.set_swap_address(swap["id"], "bitcoin", "<your btc compressed pubkey>")

    # 5) fund the long (BTC) leg.
    sign_and_broadcast(client.build_fund(swap["id"], "b"))

    # 6) after the counterparty funds the USDT leg, claim it with the secret (reveals it on-chain).
    sign_and_broadcast(client.build_claim(swap["id"], "a", secret))

    last = ""
    while True:
        s = client.get_swap(swap["id"])
        if s["status"] != last:
            last = s["status"]
            print("status:", last)
        if last in ("counterparty_claimed", "refunded"):
            break
        time.sleep(4)


if __name__ == "__main__":
    main()
