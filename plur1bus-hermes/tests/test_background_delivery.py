import asyncio
import unittest

from plur1bus_controls.background_delivery import BackgroundDelivery


class BackgroundDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_revoke_then_reregister_does_not_lose_new_route(self):
        release = asyncio.Queue()
        delivered = asyncio.Event()
        async def sleep(_seconds):
            await release.get()
        async def tick():
            delivered.set()
        timers = BackgroundDelivery(sleep=sleep)
        try:
            timers.register("route", tick)
            await asyncio.sleep(0)
            timers.unregister("route")
            timers.register("route", tick)
            await asyncio.sleep(0)
            await release.put(None)
            await asyncio.wait_for(delivered.wait(), 1)
            self.assertIn("route", timers._routes)
        finally:
            await timers.close()

    async def test_delivers_after_registration_without_further_inbound_event(self):
        release = asyncio.Queue()
        delivered = asyncio.Event()
        count = 0
        async def sleep(_seconds):
            await release.get()
        async def tick():
            nonlocal count
            count += 1
            delivered.set()
        timers = BackgroundDelivery(sleep=sleep)
        try:
            timers.register("trusted-route", tick)
            timers.register("trusted-route", tick)
            await release.put(None)
            await asyncio.wait_for(delivered.wait(), 1)
            self.assertEqual(count, 1)
            self.assertEqual(len(timers._tasks), 1)
        finally:
            await timers.close()

    async def test_expired_route_and_route_limit_fail_closed(self):
        release = asyncio.Queue()
        now = [0]
        async def sleep(_seconds):
            await release.get()
        async def forbidden():
            self.fail("expired route delivered")
        timers = BackgroundDelivery(sleep=sleep, clock=lambda: now[0], max_routes=1)
        try:
            self.assertTrue(timers.register("one", forbidden, max_age_seconds=10))
            self.assertFalse(timers.register("two", forbidden))
            task = timers._tasks["one"]
            now[0] = 11
            await release.put(None)
            await asyncio.wait_for(task, 1)
            self.assertEqual(timers._routes, {})
        finally:
            await timers.close()
