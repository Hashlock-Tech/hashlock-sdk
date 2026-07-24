"""Reference: sign an EVM settlement build with Fireblocks (CONTRACT_CALL).

Fireblocks signs AND broadcasts via its own nodes, so you do NOT call client.broadcast for this path.

    pip install hashlock-sdk fireblocks-sdk

Validated live on Fireblocks Sandbox (Sepolia / ETH_TEST5) — the CONTRACT_CALL signs, broadcasts, and the
approve/createSwap lands on-chain. NOTE the Python SDK's shape: peer-type/operation are top-level string
constants (VAULT_ACCOUNT / ONE_TIME_ADDRESS / CONTRACT_CALL), and create_transaction takes `tx_type=`
(not `operation=`). The base URL for sandbox is https://sandbox-api.fireblocks.io (prod: api.fireblocks.io);
the vault account id is a small integer string (e.g. "0").
"""
import os
import time

from fireblocks_sdk import CONTRACT_CALL, ONE_TIME_ADDRESS, VAULT_ACCOUNT, DestinationTransferPeerPath, FireblocksSDK, TransferPeerPath

from hashlock import HashlockClient

client = HashlockClient(api_key=os.environ["HASHLOCK_API_KEY"])
fireblocks = FireblocksSDK(
    private_key=open(os.environ["FIREBLOCKS_SECRET_KEY_PATH"]).read(),
    api_key=os.environ["FIREBLOCKS_API_KEY"],
    api_base_url=os.environ.get("FIREBLOCKS_BASE_URL", "https://sandbox-api.fireblocks.io"),
)

VAULT_ACCOUNT_ID = os.environ["FIREBLOCKS_VAULT_ACCOUNT_ID"]  # numeric string, e.g. "0"
ASSET_ID = "ETH_TEST5"  # Fireblocks asset id for the target chain (Sepolia here)


def sign_via_fireblocks(tx: dict) -> str:
    """Submit one unsigned EVM tx as a Fireblocks contract call; return the on-chain hash."""
    resp = fireblocks.create_transaction(
        tx_type=CONTRACT_CALL,
        asset_id=ASSET_ID,
        source=TransferPeerPath(VAULT_ACCOUNT, VAULT_ACCOUNT_ID),
        destination=DestinationTransferPeerPath(ONE_TIME_ADDRESS, one_time_address={"address": tx["to"]}),
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
