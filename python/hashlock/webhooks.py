"""Verify webhook deliveries.

The server signs each POST with::

    X-Hashlock-Signature: sha256=HMAC-SHA256(secret, f"{timestamp}.{raw_body}")

where ``timestamp`` is the ``X-Hashlock-Timestamp`` header. Verify against the RAW request body.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Optional


def verify_webhook(
    secret: str,
    raw_body: str,
    signature: Optional[str],
    timestamp: Optional[str],
    tolerance_seconds: int = 300,
    now_unix: Optional[int] = None,
) -> bool:
    """Return True iff the signature matches and the timestamp is within tolerance (0 disables the check)."""
    if not signature or not timestamp:
        return False
    if tolerance_seconds > 0:
        try:
            ts = int(timestamp)
        except ValueError:
            return False
        if abs((now_unix if now_unix is not None else int(time.time())) - ts) > tolerance_seconds:
            return False
    expected = "sha256=" + hmac.new(secret.encode(), f"{timestamp}.{raw_body}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
