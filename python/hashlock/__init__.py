"""Hashlock Markets developer SDK — non-custodial cross-chain atomic swaps (BTC ↔ EVM/TRON/Solana)."""
from .client import HashlockClient
from .errors import HashlockError
from .secret import new_secret, sha256_hex
from .webhooks import verify_webhook

__all__ = ["HashlockClient", "HashlockError", "new_secret", "sha256_hex", "verify_webhook"]
__version__ = "0.5.0"
