"""Thin, typed client for the Hashlock Markets developer API (/v1).

Custody-agnostic: the settlement endpoints return UNSIGNED transactions you sign with your own key/HSM
(see ``examples/``), then hand back to :meth:`HashlockClient.broadcast`. The server never holds your keys.
"""
from __future__ import annotations

from typing import Any, Iterator, Optional

import httpx

from .errors import HashlockError

DEFAULT_BASE = "https://api-dev.hashlock.markets/v1"


class HashlockClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE, timeout: float = 30.0) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self._base = base_url.rstrip("/")
        self._http = httpx.Client(timeout=timeout, headers={"authorization": f"Bearer {api_key}"})

    # ── context manager ────────────────────────────────────────────────────────
    def __enter__(self) -> "HashlockClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    # ── core ───────────────────────────────────────────────────────────────────
    def me(self) -> dict[str, Any]:
        """Verify the key and see its scopes."""
        return self._request("GET", "/me")

    def assets(self) -> list[dict[str, Any]]:
        """The asset registry (chain, token|native, decimals, symbol)."""
        return self._request("GET", "/assets")["assets"]

    # ── RFQs ─────────────────────────────────────────────────────────────────────
    def list_rfqs(self, **params: Any) -> dict[str, Any]:
        """One page of the order book: ``{"items": [...], "next_cursor": str | None}``.

        Query params: base_asset_id, quote_asset_id, direction, limit, cursor.
        """
        r = self._request("GET", "/rfqs", params=_camel(params))
        return {"items": r.get("rfqs", []), "next_cursor": r.get("nextCursor")}

    def rfqs(self, **params: Any) -> Iterator[dict[str, Any]]:
        """Iterate the whole order book, following the cursor automatically."""
        yield from self._paginate(self.list_rfqs, params)

    def get_rfq(self, rfq_id: str) -> dict[str, Any]:
        return self._request("GET", f"/rfqs/{rfq_id}")["rfq"]

    def create_rfq(
        self,
        direction: str,
        base_asset_id: str,
        base_amount: str,
        quote_asset_id: str,
        ttl_seconds: int,
        ask_amount: Optional[str] = None,
        visibility: Optional[str] = None,
        target_address: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        """Create an RFQ (requires the ``taker`` scope)."""
        body = {
            "direction": direction,
            "baseAssetId": base_asset_id,
            "baseAmount": base_amount,
            "quoteAssetId": quote_asset_id,
            "ttlSeconds": ttl_seconds,
            "askAmount": ask_amount,
            "visibility": visibility,
            "targetAddress": target_address,
        }
        return self._request("POST", "/rfqs", json={k: v for k, v in body.items() if v is not None}, idempotency_key=idempotency_key)["rfq"]

    def quote_rfq(self, rfq_id: str, quote_amount: str, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Quote an RFQ (requires the ``maker`` scope) — opens a settlement thread."""
        return self._request("POST", f"/rfqs/{rfq_id}/quotes", json={"quoteAmount": quote_amount}, idempotency_key=idempotency_key)

    # ── negotiation thread ───────────────────────────────────────────────────────
    def get_thread(self, thread_id: str) -> dict[str, Any]:
        return self._request("GET", f"/threads/{thread_id}")

    def propose_terms(self, thread_id: str, quote_amount: str) -> dict[str, Any]:
        return self._request("POST", f"/threads/{thread_id}/propose", json={"quoteAmount": quote_amount})

    def accept_proposal(self, thread_id: str) -> dict[str, Any]:
        return self._request("POST", f"/threads/{thread_id}/accept-proposal")

    def accept_terms(self, thread_id: str, hashlock: Optional[str] = None) -> dict[str, Any]:
        """Accept the current terms. When BOTH sides accept, the swap is created. The initiator (funds the
        long leg) MUST pass ``hashlock`` = sha256(secret) — see :func:`hashlock.secret.new_secret`."""
        return self._request("POST", f"/threads/{thread_id}/accept", json={"hashlock": hashlock} if hashlock else {})

    # ── swaps ─────────────────────────────────────────────────────────────────────
    def list_swaps(self, **params: Any) -> dict[str, Any]:
        r = self._request("GET", "/swaps", params=_camel(params))
        return {"items": r.get("swaps", []), "next_cursor": r.get("nextCursor")}

    def swaps(self, **params: Any) -> Iterator[dict[str, Any]]:
        yield from self._paginate(self.list_swaps, params)

    def get_swap(self, swap_id: str) -> dict[str, Any]:
        return self._request("GET", f"/swaps/{swap_id}")["swap"]

    def set_swap_address(self, swap_id: str, chain: str, address: str) -> dict[str, Any]:
        """Set your receive (payout) / refund address for a leg. Bitcoin: the compressed pubkey (hex)."""
        return self._request("POST", f"/swaps/{swap_id}/address", json={"chain": chain, "address": address})["swap"]

    # ── settlement builders (UNSIGNED — sign with your own key/HSM, then broadcast) ─
    def build_fund(self, swap_id: str, leg: str) -> dict[str, Any]:
        return self._request("POST", f"/swaps/{swap_id}/legs/{leg}/fund")

    def build_claim(self, swap_id: str, leg: str, secret: str) -> dict[str, Any]:
        return self._request("POST", f"/swaps/{swap_id}/legs/{leg}/claim", json={"secret": secret})

    def build_refund(self, swap_id: str, leg: str) -> dict[str, Any]:
        return self._request("POST", f"/swaps/{swap_id}/legs/{leg}/refund")

    def broadcast(self, chain: str, signed: Any, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Relay a client-signed tx. ``chain``: 'evm' (0x raw) | 'tron' (signed obj) | 'bitcoin' (raw hex)."""
        return self._request("POST", "/tx/broadcast", json={"chain": chain, "signed": signed}, idempotency_key=idempotency_key)

    # ── webhooks ─────────────────────────────────────────────────────────────────
    def list_webhooks(self) -> list[dict[str, Any]]:
        return self._request("GET", "/webhooks")["webhooks"]

    def create_webhook(self, url: str, events: Optional[list[str]] = None) -> dict[str, Any]:
        """Register a webhook. The returned ``secret`` is shown ONCE — store it to verify deliveries."""
        body: dict[str, Any] = {"url": url}
        if events:
            body["events"] = events
        return self._request("POST", "/webhooks", json=body)

    def delete_webhook(self, webhook_id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/webhooks/{webhook_id}")

    def ping_webhook(self, webhook_id: str) -> dict[str, Any]:
        return self._request("POST", f"/webhooks/{webhook_id}/ping")

    # ── internals ────────────────────────────────────────────────────────────────
    def _paginate(self, page_fn: Any, params: dict[str, Any]) -> Iterator[dict[str, Any]]:
        cursor: Optional[str] = None
        while True:
            page = page_fn(**{**params, **({"cursor": cursor} if cursor else {})})
            yield from page["items"]
            cursor = page["next_cursor"]
            if not cursor:
                break

    def _request(self, method: str, path: str, *, params: Any = None, json: Any = None, idempotency_key: Optional[str] = None) -> Any:
        headers = {}
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        resp = self._http.request(method, self._base + path, params=params, json=json, headers=headers or None)
        try:
            data = resp.json()
        except Exception:
            data = None
        if resp.status_code >= 400:
            msg = (data or {}).get("error") if isinstance(data, dict) else None
            retry_after = resp.headers.get("retry-after")
            raise HashlockError(resp.status_code, msg or f"HTTP {resp.status_code}", data, int(retry_after) if retry_after else None)
        return data


def _camel(params: dict[str, Any]) -> dict[str, Any]:
    """snake_case query params → the API's camelCase; drop Nones."""
    out: dict[str, Any] = {}
    for k, v in params.items():
        if v is None:
            continue
        parts = k.split("_")
        out[parts[0] + "".join(p.title() for p in parts[1:])] = v
    return out
