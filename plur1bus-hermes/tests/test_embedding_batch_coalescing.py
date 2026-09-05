"""Embedding batch coalescing is order-preserving and deadlock-free."""

from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

from plur1bus_hermes.cache import EmbeddingCache
from plur1bus_hermes.validation import ValidationError


class EmbeddingBatchCoalescingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.cache = EmbeddingCache({"dimensions": 2, "cacheMaxEntries": 32}, Path(self.temporary.name))

    def tearDown(self) -> None:
        self.cache.close()
        self.temporary.cleanup()

    @staticmethod
    def _thread(target, result, errors):
        def run():
            try:
                result.append(target())
            except Exception as error:
                errors.append(error)
        return threading.Thread(target=run)

    def test_batch_deduplicates_normalized_keys_and_preserves_input_order(self):
        calls = []
        def compute(texts):
            calls.append(list(texts))
            return [[float(index), float(index + 10)] for index, _text in enumerate(texts)]
        result = self.cache.get_or_compute_many([" alpha ", "alpha", "beta", "alpha"], compute)
        self.assertEqual(calls, [[" alpha ", "beta"]])
        self.assertEqual(result, [[0.0, 10.0], [0.0, 10.0], [1.0, 11.0], [0.0, 10.0]])
        result[0][0] = 99
        self.assertEqual(self.cache.get("alpha"), [0.0, 10.0])

    def test_overlapping_batches_and_single_publish_before_waiting(self):
        first_started, release_first, second_started = threading.Event(), threading.Event(), threading.Event()
        first_calls, second_calls, single_calls = [], [], []
        def first(texts):
            first_calls.append(list(texts))
            first_started.set()
            self.assertTrue(release_first.wait(2))
            return [[1.0, 1.0], [2.0, 2.0]]
        def second(texts):
            second_calls.append(list(texts))
            second_started.set()
            return [[3.0, 3.0]]
        batch_one, batch_two, single = [], [], []
        errors = []
        first_thread = self._thread(lambda: self.cache.get_or_compute_many(["a", "b"], first), batch_one, errors)
        first_thread.start()
        self.assertTrue(first_started.wait(1))
        second_thread = self._thread(lambda: self.cache.get_or_compute_many(["b", "c"], second), batch_two, errors)
        second_thread.start()
        self.assertTrue(second_started.wait(1), "second batch waited before computing its owned key")
        single_thread = self._thread(lambda: self.cache.get_or_compute("a", lambda: single_calls.append("called") or [9.0, 9.0]), single, errors)
        single_thread.start()
        release_first.set()
        for thread in (first_thread, second_thread, single_thread):
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive(), "overlapping request deadlocked")
        self.assertEqual(errors, [])
        self.assertEqual(first_calls, [["a", "b"]])
        self.assertEqual(second_calls, [["c"]])
        self.assertEqual(single_calls, [])
        self.assertEqual(batch_one, [[[1.0, 1.0], [2.0, 2.0]]])
        self.assertEqual(batch_two, [[[2.0, 2.0], [3.0, 3.0]]])
        self.assertEqual(single, [[1.0, 1.0]])

    def test_invalid_batch_releases_waiters_and_never_caches_any_owned_key(self):
        started, release = threading.Event(), threading.Event()
        def invalid(texts):
            started.set()
            self.assertTrue(release.wait(2))
            return [[1.0, 2.0], [float("nan"), 2.0]]
        owner_values, waiter_values, errors = [], [], []
        owner = self._thread(lambda: self.cache.get_or_compute_many(["a", "b"], invalid), owner_values, errors)
        owner.start()
        self.assertTrue(started.wait(1))
        waiter = self._thread(lambda: self.cache.get_or_compute("b", lambda: [9.0, 9.0]), waiter_values, errors)
        waiter.start()
        release.set()
        for thread in (owner, waiter):
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive(), "failed batch waiter was not released")
        self.assertEqual(owner_values + waiter_values, [])
        self.assertEqual(len(errors), 2)
        self.assertTrue(all(isinstance(error, ValidationError) for error in errors))
        self.assertIsNone(self.cache.get("a"))
        self.assertIsNone(self.cache.get("b"))
        self.assertEqual(self.cache.get_or_compute_many(["a", "b"], lambda texts: [[4.0, 4.0] for _ in texts]), [[4.0, 4.0], [4.0, 4.0]])

    def test_purpose_scope_config_and_cache_errors_are_isolated(self):
        self.assertNotEqual(self.cache.key("same", "query"), self.cache.key("same", "passage"))
        other = EmbeddingCache({"dimensions": 2, "cacheMaxEntries": 32, "_scopeId": "other", "model": "other"}, Path(self.temporary.name))
        try:
            self.assertNotEqual(self.cache.key("same"), other.key("same"))
        finally:
            other.close()
        original = self.cache._get_by_key
        self.cache._get_by_key = lambda _key: (_ for _ in ()).throw(RuntimeError("cache unavailable"))
        try:
            self.assertEqual(self.cache.get_or_compute_many(["x", "x"], lambda texts: [[5.0, 5.0] for _ in texts]), [[5.0, 5.0], [5.0, 5.0]])
        finally:
            self.cache._get_by_key = original


if __name__ == "__main__":
    unittest.main()
