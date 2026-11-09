"""Bounded synchronous-worker admission for native memory operations.

Python cannot safely terminate a running storage thread. Deadlines here prevent
expired queued work from starting; they do not claim hard cancellation of I/O.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable


class AdmissionRejected(RuntimeError):
    """The operation was not submitted and may safely be durably retried."""


class BoundedExecutor:
    """Reserve capacity before submitting and release it on every terminal path."""

    def __init__(self, *, max_workers: int = 1, max_queue: int = 10,
                 queue_timeout_ms: int = 60_000, thread_name_prefix: str = "plur1bus",
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._workers = max(1, min(8, int(max_workers)))
        self._slots = threading.BoundedSemaphore(self._workers + max(0, min(1000, int(max_queue))))
        self._executor = ThreadPoolExecutor(max_workers=self._workers, thread_name_prefix=thread_name_prefix)
        self._timeout = max(1, int(queue_timeout_ms)) / 1000
        self._clock = clock
        self._lock = threading.Lock()
        self._closed = False
        self.metrics = {"submitted": 0, "rejected": 0, "expired": 0, "pending": 0}

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future:
        """Submit without blocking the host; reject full or closed admission."""
        with self._lock:
            if self._closed or not self._slots.acquire(blocking=False):
                self.metrics["rejected"] += 1
                raise AdmissionRejected("memory operation queue is closed or full")
            self.metrics["pending"] += 1
        deadline = self._clock() + self._timeout

        def execute() -> Any:
            if self._clock() >= deadline:
                with self._lock:
                    self.metrics["expired"] += 1
                raise AdmissionRejected("memory operation expired before execution")
            return fn(*args, **kwargs)

        def release(_future: Future | None = None) -> None:
            self._slots.release()
            with self._lock:
                self.metrics["pending"] -= 1

        try:
            future = self._executor.submit(execute)
        except BaseException:
            release()
            raise
        with self._lock:
            self.metrics["submitted"] += 1
        future.add_done_callback(release)
        return future

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        """Stop admission and optionally cancel only work that has not started."""
        with self._lock:
            self._closed = True
        self._executor.shutdown(wait=wait, cancel_futures=cancel_futures)
