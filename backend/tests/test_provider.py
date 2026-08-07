import asyncio

import httpx
import pytest

from backend.app.provider import serialized_post


@pytest.mark.asyncio
async def test_provider_requests_are_globally_serialized() -> None:
    active = 0
    maximum_active = 0

    class FakeClient:
        async def post(self, endpoint: str, **kwargs: object) -> httpx.Response:
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0.01)
            active -= 1
            return httpx.Response(200, request=httpx.Request("POST", endpoint))

    client = FakeClient()
    await asyncio.gather(*(
        serialized_post(client, "https://example.test/chat/completions", json={"index": index})
        for index in range(4)
    ))

    assert maximum_active == 1
