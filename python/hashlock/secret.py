"""The swap secret + its hashlock.

The INITIATOR (funds the long leg) generates the secret locally, keeps it private, and passes only
``hashlock = sha256(secret)`` to ``accept_terms``. The secret is revealed on-chain when the initiator
claims the counter-leg; keep it until then.
"""
from __future__ import annotations

import hashlib
import secrets


def new_secret() -> tuple[str, str]:
    """Return ``(secret_hex, hashlock_hex)`` — a fresh 32-byte secret and its sha256 hashlock (no 0x)."""
    secret = secrets.token_bytes(32)
    return secret.hex(), hashlib.sha256(secret).hexdigest()


def sha256_hex(hex_str: str) -> str:
    """sha256(preimage) as hex — verify a preimage against a swap's hashlock."""
    return hashlib.sha256(bytes.fromhex(hex_str[2:] if hex_str.startswith("0x") else hex_str)).hexdigest()
