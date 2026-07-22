"""Error type raised for non-2xx API responses."""
from __future__ import annotations

from typing import Any, Optional


class HashlockError(Exception):
    def __init__(self, status: int, message: str, body: Any = None, retry_after: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.retry_after = retry_after  # seconds until the rate-limit window resets (on 429)

    @property
    def is_rate_limited(self) -> bool:
        return self.status == 429

    @property
    def is_auth_error(self) -> bool:
        return self.status in (401, 403)
