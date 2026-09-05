"""Regression coverage for the capture retry queue (upstream 7.2.2 parity)."""

from __future__ import annotations

import json
import tempfile
import time
import unittest
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Callable

from plur1bus_hermes.runtime import MAX_CAPTURE_RETRIES, Plur1busRuntime


class StubEmbedding:
    """Embedding backend stub; failures simulate a dead LLM/embedding route."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.fail = True

    def embed(self, text: str, *, purpose: str = "passage") -> list[float]:
        self.calls.append(text)
        if self.fail:
            raise RuntimeError("oMLX request failed")
        return [0.0, 0.0, 0.0, 0.0]

    def close(self) -> None:
        pass


class CaptureRetryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        config = {
            "dataDir": "plur1bus",
            "agentId": "main",
            "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
            "reranker": {"provider": "disabled"},
        }
        self.runtime = Plur1busRuntime(self.root, config, "main")
        self.embedding = StubEmbedding()
        self.runtime._embedding = self.embedding

    def tearDown(self) -> None:
        self.runtime.shutdown()
        self.temporary.cleanup()

    @staticmethod
    def _wait_until(predicate: Callable[[], bool], timeout: float = 5.0) -> bool:
        """Poll a predicate so done-callback side effects can settle after flush."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if predicate():
                    return True
            except Exception:
                pass
            time.sleep(0.02)
        return False

    def _retry_entries(self) -> list[dict[str, Any]]:
        path = self.root / "state" / "capture-retry.jsonl"
        if not path.is_file():
            return []
        entries = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                entries.append(json.loads(line))
        return entries

    def _retry_attempts(self, user: str) -> int | None:
        for entry in self._retry_entries():
            if entry.get("user") == user:
                return int(entry.get("attempts", 0))
        return None

    def test_failed_capture_lands_in_retry_file_with_attempts_1(self) -> None:
        self.runtime.capture_async("retry me user", "retry me assistant", "session-a")
        self.runtime.flush()

        self.assertTrue(self._wait_until(lambda: self._retry_attempts("retry me user") == 1))
        entry = self._retry_entries()[0]
        self.assertEqual(entry["assistant"], "retry me assistant")
        self.assertEqual(entry["sessionId"], "session-a")
        errors = (self.root / "state" / "capture-errors.jsonl").read_text(encoding="utf-8")
        self.assertIn("oMLX request failed", errors)

    def test_pending_retry_is_resubmitted_and_cleared_on_success(self) -> None:
        self.runtime.capture_async("lost user", "lost assistant", "session-b")
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: self._retry_attempts("lost user") == 1))

        self.embedding.fail = False
        self.runtime.capture_async("fresh user", "fresh assistant", "session-b")
        self.runtime.flush()

        self.assertTrue(
            self._wait_until(lambda: self.embedding.calls.count("lost user") >= 2),
            "next capture_async must resubmit the pending retry",
        )
        self.assertTrue(self._wait_until(lambda: not self._retry_entries()))
        self.assertEqual(self._retry_entries(), [])

    def test_gives_up_after_max_capture_retries(self) -> None:
        self.assertEqual(MAX_CAPTURE_RETRIES, 5)
        doomed_calls = lambda: self.embedding.calls.count("doomed user")

        self.runtime.capture_async("doomed user", "doomed assistant", "session-c")
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: self._retry_attempts("doomed user") == 1))

        for expected in range(2, MAX_CAPTURE_RETRIES):
            self.runtime.capture_async(f"probe {expected}", "probe", "session-c")
            self.runtime.flush()
            self.assertTrue(
                self._wait_until(lambda attempts=expected: self._retry_attempts("doomed user") == attempts),
                f"attempts should increment to {expected}",
            )

        with self.assertLogs("plur1bus_hermes.runtime", level="WARNING") as captured:
            self.runtime.capture_async("probe final", "probe", "session-c")
            self.runtime.flush()
            self.assertTrue(self._wait_until(lambda: self._retry_attempts("doomed user") is None))
        self.assertTrue(any("giving up" in message for message in captured.output))

        self.assertEqual(doomed_calls(), MAX_CAPTURE_RETRIES)
        self.runtime.capture_async("probe extra", "probe", "session-c")
        self.runtime.flush()
        self.assertEqual(doomed_calls(), MAX_CAPTURE_RETRIES, "no sixth attempt allowed")

    def test_corrupt_retry_lines_do_not_crash_capture(self) -> None:
        state_dir = self.root / "state"
        state_dir.mkdir(parents=True, exist_ok=True)
        valid = {
            "user": "salvage user",
            "assistant": "salvage assistant",
            "sessionId": "session-d",
            "attempts": 1,
        }
        (state_dir / "capture-retry.jsonl").write_text(
            "not json at all\n" + '{"broken": \n' + json.dumps(valid) + "\n",
            encoding="utf-8",
        )
        self.embedding.fail = False

        self.runtime.capture_async("fresh user", "fresh assistant", "session-d")
        self.runtime.flush()

        self.assertTrue(self._wait_until(lambda: "salvage user" in self.embedding.calls))
        self.assertTrue(self._wait_until(lambda: not self._retry_entries()))

    def test_retry_stays_durable_while_inflight_and_is_not_submitted_twice(self) -> None:
        payload = {"user": "blocked", "assistant": "blocked reply", "sessionId": "session-e", "attempts": 1}
        self.runtime._write_capture_retries([payload])
        submitted: list[Future[None]] = []

        class BlockingExecutor:
            def submit(self, *_args, **_kwargs):
                future: Future[None] = Future()
                submitted.append(future)
                return future

            def shutdown(self, **_kwargs):
                return None

        self.runtime._executor = BlockingExecutor()  # type: ignore[assignment]
        self.runtime._resubmit_capture_retries()
        self.assertEqual(len(submitted), 1)
        self.assertEqual(self._retry_entries()[0]["user"], "blocked")
        self.runtime._resubmit_capture_retries()
        self.assertEqual(len(submitted), 1, "in-flight retry must not be duplicated")
        submitted[0].set_result(None)
        self.assertTrue(self._wait_until(lambda: not self._retry_entries()))


if __name__ == "__main__":
    unittest.main()
