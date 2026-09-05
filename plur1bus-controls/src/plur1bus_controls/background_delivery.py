"""Bounded in-process delivery timers for previously authorized gateway routes.

Registration requires a trusted host route; this module never invents a chat
target or persists message contents. Timers run without another inbound event,
but a restarted host must register its authorized route again.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable

LOGGER = logging.getLogger(__name__)


class BackgroundDelivery:
    """Maintain one non-overlapping timer per explicitly registered route."""

    def __init__(self, *, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 clock: Callable[[], float] = time.monotonic, max_routes: int = 32) -> None:
        self._sleep = sleep
        self._clock = clock
        self._max_routes = max_routes
        self._routes: dict[str, dict] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def register(self, key: str, tick: Callable[[], Awaitable[None]], *,
                 interval_seconds: float = 60, max_age_seconds: float = 86_400) -> bool:
        """Refresh a trusted callback; the caller must reauthorize every tick."""
        loop = asyncio.get_running_loop()
        if key not in self._routes and len(self._routes) >= self._max_routes:
            LOGGER.warning("Background delivery route limit reached")
            return False
        self._routes[key] = {
            "tick": tick, "interval": max(10, min(3600, float(interval_seconds))),
            "expires": self._clock() + max(10, min(86_400, float(max_age_seconds))),
        }
        if key not in self._tasks:
            task = loop.create_task(self._run(key), name="plur1bus-background-delivery")
            self._tasks[key] = task
        return True

    async def _run(self, key: str) -> None:
        try:
            while key in self._routes:
                await self._sleep(self._routes[key]["interval"])
                route = self._routes.get(key)
                if route is None or self._clock() >= route["expires"]:
                    break
                try:
                    await route["tick"]()
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    LOGGER.warning("Background memory delivery failed: %s", type(error).__name__)
        finally:
            if self._tasks.get(key) is asyncio.current_task():
                self._routes.pop(key, None)
                self._tasks.pop(key, None)

    def unregister(self, key: str) -> None:
        """Revoke one route without affecting other conversations."""
        self._routes.pop(key, None)
        task = self._tasks.pop(key, None)
        if task is not None:
            task.cancel()

    async def close(self) -> None:
        """Cancel and drain every timer during plugin shutdown or tests."""
        tasks = list(self._tasks.values())
        self._routes.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
