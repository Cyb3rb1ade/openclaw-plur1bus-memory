"""Concurrent embedding requests share only an identical live computation."""

from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

from plur1bus_hermes.cache import EmbeddingCache


class EmbeddingCoalescingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.cache = EmbeddingCache({"dimensions": 2, "cacheMaxEntries": 32}, Path(self.temporary.name))

    def tearDown(self) -> None:
        self.cache.close()
        self.temporary.cleanup()

    def _concurrent(self, compute, *, text="same text", purpose="passage", count=6):
        results, errors = [], []
        threads = [threading.Thread(target=lambda: self._call(results, errors, text, compute, purpose)) for _ in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive(), "coalesced waiter was not released")
        return results, errors

    def _call(self, results, errors, text, compute, purpose):
        try:
            results.append(self.cache.get_or_compute(text, compute, purpose))
        except Exception as error:  # assertions examine the shared failure
            errors.append(error)

    def test_identical_normalized_requests_share_one_compute_and_return_copies(self):
        calls = 0
        started = threading.Event()
        release = threading.Event()
        def compute():
            nonlocal calls
            calls += 1
            started.set()
            release.wait(2)
            return [1.0, 2.0]
        owner = threading.Thread(target=lambda: self.cache.get_or_compute(" same   text ", compute))
        owner.start()
        self.assertTrue(started.wait(1))
        results, errors = [], []
        waiters = [threading.Thread(target=lambda: self._call(results, errors, "same text", compute, "passage")) for _ in range(6)]
        for waiter in waiters:
            waiter.start()
        release.set()
        owner.join(timeout=3)
        self.assertFalse(owner.is_alive())
        for waiter in waiters:
            waiter.join(timeout=3)
            self.assertFalse(waiter.is_alive(), "coalesced waiter was not released")
        self.assertEqual(calls, 1)
        self.assertEqual(errors, [])
        self.assertEqual(results, [[1.0, 2.0]] * 6)
        results[0][0] = 999.0
        self.assertEqual(self.cache.get("same text"), [1.0, 2.0])
        self.assertGreaterEqual(self.cache.metrics["coalesced"], 1)

    def test_purpose_scope_and_config_do_not_coalesce(self):
        calls = 0
        def compute():
            nonlocal calls
            calls += 1
            return [1.0, 2.0]
        self.cache.get_or_compute("text", compute, "passage")
        self.cache.get_or_compute("text", compute, "query")
        other_scope = EmbeddingCache({"dimensions": 2, "cacheMaxEntries": 32, "_scopeId": "other"}, Path(self.temporary.name))
        try:
            other_scope.get_or_compute("text", compute, "passage")
        finally:
            other_scope.close()
        self.assertEqual(calls, 3)

    def test_errors_and_invalid_vectors_release_waiters_and_are_not_cached(self):
        calls = 0
        started = threading.Event()
        release = threading.Event()
        def broken():
            nonlocal calls
            calls += 1
            started.set()
            release.wait(2)
            raise RuntimeError("backend down")
        owner_errors = []
        owner = threading.Thread(target=lambda: self._call([], owner_errors, "broken", broken, "passage"))
        owner.start()
        self.assertTrue(started.wait(1))
        results, errors = [], []
        waiters = [threading.Thread(target=lambda: self._call(results, errors, "broken", broken, "passage")) for _ in range(6)]
        for waiter in waiters:
            waiter.start()
        release.set()
        owner.join(timeout=3)
        for waiter in waiters:
            waiter.join(timeout=3)
            self.assertFalse(waiter.is_alive(), "failed waiter was not released")
        self.assertEqual(results, [])
        self.assertEqual(calls, 1)
        self.assertEqual(len(errors) + len(owner_errors), 7)
        self.assertTrue(all(isinstance(error, RuntimeError) for error in errors + owner_errors))
        with self.assertRaises(ValueError):
            self.cache.get_or_compute("invalid", lambda: [float("nan"), 2.0])
        self.assertEqual(self.cache.get_or_compute("invalid", lambda: [3.0, 4.0]), [3.0, 4.0])

    def test_cache_read_failure_is_fail_open(self):
        original = self.cache._get_by_key
        self.cache._get_by_key = lambda _key: (_ for _ in ()).throw(RuntimeError("sqlite unavailable"))
        try:
            self.assertEqual(self.cache.get_or_compute("text", lambda: [1.0, 2.0]), [1.0, 2.0])
        finally:
            self.cache._get_by_key = original


if __name__ == "__main__":
    unittest.main()
