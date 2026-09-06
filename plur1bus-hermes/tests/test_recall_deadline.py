"""Bounded caller wait, no growing queue, and generation lease lifetime."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.runtime_lease import exclusive_generation_lease


def test_slow_additive_read_cannot_block_primary_or_release_lease_early(tmp_path):
    runtime = Plur1busRuntime(tmp_path, {}, "main")
    entered, finish = threading.Event(), threading.Event()
    primary = [{"id": "base", "content": "unchanged"}]
    calls = []
    def slow(rows, *_args, **_kwargs):
        calls.append(True)
        rows[0]["content"] = "worker must not mutate primary"
        entered.set()
        assert finish.wait(5)
        return rows + [{"id": "late", "content": "must not arrive later"}]
    runtime._domain.boost_recall = slow
    try:
        started = time.monotonic()
        result = runtime._boost_recall_with_deadline(primary, object(), 4, {})
        elapsed = time.monotonic() - started
        assert entered.is_set()
        assert result == primary == [{"id": "base", "content": "unchanged"}]
        assert elapsed < 0.3  # Scheduling tolerance; implementation waits 50 ms.
        for _ in range(10):
            assert runtime._boost_recall_with_deadline(primary, object(), 4, {}) == primary
        assert len(calls) == 1
        assert runtime._booster_executor.metrics["pending"] == 1
        runtime.shutdown(timeout_seconds=0)
        with pytest.raises(RuntimeError, match="runtime lease"):
            with exclusive_generation_lease(tmp_path):
                pass
        finish.set()
        assert runtime._shutdown_complete.wait(2)
        with exclusive_generation_lease(tmp_path):
            pass
        assert primary[0]["content"] == "unchanged"
    finally:
        finish.set()
        runtime.shutdown()


def test_fast_additive_results_are_returned_and_bad_results_fail_open(tmp_path):
    runtime = Plur1busRuntime(tmp_path, {}, "main")
    primary = [{"id": "base"}]
    try:
        runtime._domain.boost_recall = lambda rows, *_args, **_kwargs: rows + [{"id": "extra"}]
        assert [row["id"] for row in runtime._boost_recall_with_deadline(primary, object(), 4, {})] == ["base", "extra"]
        runtime._domain.boost_recall = lambda *_args, **_kwargs: None
        assert runtime._boost_recall_with_deadline(primary, object(), 4, {}) == []
    finally:
        runtime.shutdown()


def test_late_primary_prefetch_pins_generation_even_after_runtime_shutdown(tmp_path):
    runtime = Plur1busRuntime(tmp_path, {}, "main")
    entered, finish = threading.Event(), threading.Event()
    def slow_primary(*_args, **_kwargs):
        entered.set()
        assert finish.wait(5)
        return "read completed"
    runtime._recall = slow_primary
    try:
        with ThreadPoolExecutor(1) as worker:
            pending = worker.submit(runtime.recall, "a query")
            assert entered.wait(1)
            runtime.shutdown(timeout_seconds=0)
            with pytest.raises(RuntimeError, match="runtime lease"):
                with exclusive_generation_lease(tmp_path):
                    pass
            finish.set()
            assert pending.result(2) == "read completed"
            with exclusive_generation_lease(tmp_path):
                pass
    finally:
        finish.set()
        runtime.shutdown()
