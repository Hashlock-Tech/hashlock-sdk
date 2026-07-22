"""Reference: sign an EVM settlement build with Fireblocks (CONTRACT_CALL).

Fireblocks signs AND broadcasts via its own nodes, so you do NOT call client.broadcast for this path.

    pip install hashlock-sdk fireblocks-sdk

Not live-tested — set your vault account id + asset id and validate on a testnet vault first.
"""
import os
import time

from fireblocks_sdk import FireblocksSDK, TransferPeerPath, DestinationTransferPeerPath, PeerType

from hashlock import HashlockClient

client = HashlockClient(api_key=os.environ["HASHLOCK_API_KEY"])
fireblocks = FireblocksSDK(os.environ["FIREBLOCKS_API_SECRET"], os.environ["FIREBLOCKS_API_KEY"])

VAULT_ACCOUNT_ID = os.environ["FIREBLOCKS_VAULT_ID"]
ASSET_ID = "ETH_TEST5"  # Fireblocks asset id for the target chain (Sepolia here)


def sign_via_fireblocks(tx: dict) -> str:
    """Submit one unsigned EVM tx as a Fireblocks contract call; return the on-chain hash."""
    resp = fireblocks.create_transaction(
        operation="CONTRACT_CALL",
        asset_id=ASSET_ID,
        source=TransferPeerPath(PeerType.VAULT_ACCOUNT, VAULT_ACCOUNT_ID),
        destination=DestinationTransferPeerPath(PeerType.ONE_TIME_ADDRESS, one_time_address={"address": tx["to"]}),
        amount=str(int(tx.get("value") or "0")),  # wei; "0" for approve / createSwap
        extra_parameters={"contractCallData": tx["data"]},
        note="Hashlock HTLC settlement",
    )
    tx_id = resp["id"]
    while True:
        t = fireblocks.get_transaction_by_id(tx_id)
        if t.get("txHash"):
            return t["txHash"]
        if t["status"] in ("FAILED", "BLOCKED", "CANCELLED", "REJECTED"):
            raise RuntimeError(f"Fireblocks tx {tx_id} {t['status']}: {t.get('subStatus')}")
        time.sleep(3)


def fund_evm_leg(swap_id: str, leg: str) -> None:
    build = client.build_fund(swap_id, leg)  # {'sign': 'evm-tx', 'txs': [approve, createSwap], ...}
    for tx in build["txs"]:
        print("fireblocks broadcast", sign_via_fireblocks(tx))
