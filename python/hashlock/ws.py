"""Maker feed over WebSocket (/v1/ws), using the ``websockets`` library (async).

Authenticate with an API key that has the ``maker`` scope, receive a snapshot of the public order book,
then a live stream of quotable RFQs; submit quotes on the same socket.
"""
from __future__ import annotations

import json
from typing import Any, AsyncIterator

try:
    import websockets  # type: ignore
except ImportError:  # pragma: no cover
    websockets = None  # the maker feed is optional; install `hashlock-sdk[ws]`

DEFAULT_WS = "wss://api.hashlock.markets/v1/ws"


async def maker_feed(
    api_key: str, url: str | None = None, base_url: str | None = None
) -> AsyncIterator[dict[str, Any]]:
    """Async-iterate feed messages: {'type': 'snapshot'|'ready'|'rfq'|'quoted'|'error', ...}.

    ``url`` wins; else ``base_url`` (the REST base your client uses, e.g. https://host/v1) + ``/ws`` in
    ws(s) form, so a client pointed at another deployment never sends its key to production; else
    the production feed.

    Example::

        async for msg in maker_feed(api_key):
            if msg["type"] == "rfq":
                ...  # decide whether to quote
    """
    if websockets is None:
        raise RuntimeError("install `hashlock-sdk[ws]` (the `websockets` package) to use the maker feed")
    if url is None:
        url = base_url.rstrip("/").replace("http", "ws", 1) + "/ws" if base_url else DEFAULT_WS
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"apiKey": api_key}))
        async for raw in ws:
            try:
                yield json.loads(raw)
            except json.JSONDecodeError:
                continue


async def submit_quote(ws: Any, rfq_id: str, quote_amount: str) -> None:
    """Submit a quote on an open maker-feed socket."""
    await ws.send(json.dumps({"quote": {"rfqId": rfq_id, "quoteAmount": quote_amount}}))
