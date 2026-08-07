from __future__ import annotations

import asyncio

import httpx


_request_lock = asyncio.Lock()


async def serialized_post(
    client: httpx.AsyncClient,
    endpoint: str,
    **kwargs: object,
) -> httpx.Response:
    async with _request_lock:
        return await client.post(endpoint, **kwargs)
