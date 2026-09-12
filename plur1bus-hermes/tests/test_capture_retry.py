"""Regression coverage for the capture retry queue (upstream 7.2.2 parity)."""

from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Callable

from plur1bus_hermes.runtime import MAX_CAPTURE_RETRIES, Plur1busRuntime
from plur1bus_hermes.capture_journal import receipt_path
import plur1bus_hermes.domain as domain_module


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
        # Polling must cooperate with the same queue lock as production readers.
        # A raw Windows CRT read handle denies delete-sharing and can itself
        # make the callback's otherwise valid atomic replacement fail.
        return self.runtime._read_capture_retries()

    def test_retry_inspection_waits_for_queue_publication_lock(self) -> None:
        started = threading.Event()
        finished = threading.Event()
        results = []

        def inspect():
            started.set()
            try:
                results.append(self._retry_entries())
            finally:
                finished.set()

        thread = threading.Thread(target=inspect)
        try:
            with self.runtime._locked_capture_retry_queue():
                thread.start()
                self.assertTrue(started.wait(1))
                self.assertFalse(finished.wait(0.05), "test reader bypassed the publication lock")
            self.assertTrue(finished.wait(2))
        finally:
            thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results, [[]])

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
        self.assertEqual(entry["agentId"], "main")
        self.assertEqual(entry["scopeKey"], self.runtime.scope_key)
        self.assertEqual(entry["aclBinding"], self.runtime.scope_binding.acl_binding)
        self.assertEqual(str(uuid.UUID(entry["captureId"])), entry["captureId"])
        self.assertIn("+00:00", entry["capturedAt"])
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

    def test_retry_keeps_original_journal_identity(self) -> None:
        self.runtime.capture_async("stable user", "stable assistant", "session-id")
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: len(self._retry_entries()) == 1))
        before = self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "turn-journal.jsonl")
        self.embedding.fail = False
        self.runtime._resubmit_capture_retries()
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: not self._retry_entries()))
        after = self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "turn-journal.jsonl")
        self.assertEqual(len(before), 2)
        self.assertEqual(after, before)

    def test_retry_with_missing_receipt_fails_closed_without_journal_duplicate(self) -> None:
        self.runtime.capture_async("receipt user", "receipt assistant", "receipt-session")
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: len(self._retry_entries()) == 1))
        entry = self._retry_entries()[0]
        before = self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "turn-journal.jsonl")
        receipt_path(self.runtime.data_dir, self.runtime.agent_id, entry["captureId"]).unlink()
        self.embedding.fail = False
        self.runtime._resubmit_capture_retries()
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: self._retry_attempts("receipt user") == 2))
        after = self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "turn-journal.jsonl")
        self.assertEqual(after, before)

    def test_late_receipt_loss_keeps_sticky_retry_requirement(self) -> None:
        original_remember = self.runtime._remember

        def delete_receipt_then_fail(*_args, **_kwargs):
            # The entry is not durable until the callback, so derive the
            # native admission identity from the just-written journal row.
            journal = self.runtime._domain._read_jsonl(
                self.runtime._domain.neo_dir / "turn-journal.jsonl")
            receipt_path(self.runtime.data_dir, self.runtime.agent_id, journal[0]["captureId"]).unlink()
            raise RuntimeError("embedding failed after receipt loss")

        self.runtime._remember = delete_receipt_then_fail
        self.runtime.capture_async("sticky user", "sticky assistant", "sticky-session")
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: len(self._retry_entries()) == 1))
        entry = self._retry_entries()[0]
        self.assertTrue(entry["receiptRequired"])
        before = self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "turn-journal.jsonl")
        self.runtime._remember = original_remember
        self.embedding.fail = False
        self.runtime._resubmit_capture_retries()
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: self._retry_attempts("sticky user") == 2))
        self.assertEqual(self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "turn-journal.jsonl"), before)

    def test_post_journal_side_effect_failure_keeps_sticky_receipt_requirement(self) -> None:
        original_append = self.runtime._domain._append_jsonl

        def remove_receipt_then_fail(path, value):
            if path.name == "emotional-state.jsonl":
                journal = self.runtime._domain._read_jsonl(
                    self.runtime._domain.neo_dir / "turn-journal.jsonl")
                receipt_path(self.runtime.data_dir, self.runtime.agent_id, journal[0]["captureId"]).unlink()
                raise RuntimeError("emotional side effect failed after receipt")
            return original_append(path, value)

        self.runtime._domain._append_jsonl = remove_receipt_then_fail
        self.runtime.capture_async("side user", "side assistant", "side-session")
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: len(self._retry_entries()) == 1))
        entry = self._retry_entries()[0]
        self.assertTrue(entry["receiptRequired"])
        journal = self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "turn-journal.jsonl")
        episodes = self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "episodes.jsonl")
        self.assertEqual((len(journal), len(episodes)), (2, 1))
        self.runtime._domain._append_jsonl = original_append
        self.embedding.fail = False
        self.runtime._resubmit_capture_retries()
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: self._retry_attempts("side user") == 2))
        self.assertEqual(self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "turn-journal.jsonl"), journal)
        self.assertEqual(self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "episodes.jsonl"), episodes)

    def test_first_prepare_failure_remains_first_materialization(self) -> None:
        original_write = domain_module.write_receipt

        def fail_prepare(*_args, **_kwargs):
            raise RuntimeError("injected receipt prepare failure")

        domain_module.write_receipt = fail_prepare
        self.runtime.capture_async("prepare user", "prepare assistant", "prepare-session")
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: len(self._retry_entries()) == 1))
        entry = self._retry_entries()[0]
        self.assertFalse(entry["receiptRequired"])
        self.assertEqual(self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "turn-journal.jsonl"), [])
        domain_module.write_receipt = original_write
        self.embedding.fail = False
        self.runtime._resubmit_capture_retries()
        self.runtime.flush()
        self.assertTrue(self._wait_until(lambda: not self._retry_entries()))
        self.assertEqual(len(self.runtime._domain._read_jsonl(
            self.runtime._domain.neo_dir / "turn-journal.jsonl")), 2)

    def test_legacy_owned_retry_receives_identity_before_restart_replay(self) -> None:
        payload = {
            "user": "legacy user", "assistant": "legacy assistant", "sessionId": "legacy-session",
            "attempts": 1, "agentId": "main", "scopeKey": self.runtime.scope_key,
            "aclBinding": self.runtime.scope_binding.acl_binding,
        }
        self.runtime._write_capture_retries([payload])
        self.runtime._resubmit_capture_retries()
        entries = self._retry_entries()
        self.assertEqual(len(entries), 1)
        self.assertIn("captureId", entries[0])
        self.assertIn("capturedAt", entries[0])

        self.runtime.shutdown()
        config = {
            "dataDir": "plur1bus", "agentId": "main",
            "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
            "reranker": {"provider": "disabled"},
        }
        restarted = Plur1busRuntime(self.root, config, "main")
        embedding = StubEmbedding()
        embedding.fail = False
        restarted._embedding = embedding
        try:
            restarted._resubmit_capture_retries()
            restarted.flush()
            self.assertTrue(self._wait_until(lambda: not restarted._read_capture_retries()))
            journal = restarted._domain._read_jsonl(restarted._domain.neo_dir / "turn-journal.jsonl")
            self.assertEqual({row["captureId"] for row in journal}, {entries[0]["captureId"]})
        finally:
            restarted.shutdown()
        # The restarted runtime owns shutdown now; keep tearDown idempotent.
        self.runtime = restarted

    def test_foreign_retry_entry_is_preserved_without_identity_assignment(self) -> None:
        foreign = {
            "user": "foreign", "assistant": "secret", "sessionId": "foreign-session", "attempts": 1,
            "agentId": "other", "scopeKey": self.runtime.scope_key,
            "aclBinding": self.runtime.scope_binding.acl_binding,
        }
        self.runtime._write_capture_retries([foreign])
        self.runtime._resubmit_capture_retries()
        entries = self._retry_entries()
        self.assertEqual(entries, [foreign])
        self.assertNotIn("captureId", entries[0])

    def test_dead_letter_does_not_remove_numeric_foreign_retry_key_twin(self) -> None:
        config = {
            "dataDir": "numeric", "agentId": "1",
            "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
            "reranker": {"provider": "disabled"},
        }
        runtime = Plur1busRuntime(self.root, config, "1")
        try:
            shared = {
                "user": "same", "assistant": "same", "sessionId": "same", "captureId": str(uuid.uuid4()),
                "capturedAt": "2026-09-11T12:00:00+00:00", "scopeKey": runtime.scope_key,
                "aclBinding": runtime.scope_binding.acl_binding,
            }
            runtime._write_capture_retries([
                {**shared, "agentId": "1", "attempts": MAX_CAPTURE_RETRIES},
                {**shared, "agentId": 1, "attempts": 1},
            ])
            runtime._resubmit_capture_retries()
            entries = runtime._read_capture_retries()
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["agentId"], 1)
        finally:
            runtime.shutdown()

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
        state_dir = self.runtime._capture_retry_path().parent
        state_dir.mkdir(parents=True, exist_ok=True)
        valid = {
            "user": "salvage user",
            "assistant": "salvage assistant",
            "sessionId": "session-d",
            "attempts": 1,
            "agentId": "main",
            "scopeKey": self.runtime.scope_key,
            "aclBinding": self.runtime.scope_binding.acl_binding,
        }
        self.runtime._capture_retry_path().write_text(
            "not json at all\n" + '{"broken": \n' + json.dumps(valid) + "\n",
            encoding="utf-8",
        )
        self.embedding.fail = False

        self.runtime.capture_async("fresh user", "fresh assistant", "session-d")
        self.runtime.flush()

        self.assertTrue(self._wait_until(lambda: "salvage user" in self.embedding.calls))
        self.assertTrue(self._wait_until(lambda: not self.runtime._read_capture_retries()))
        self.assertEqual(self.runtime._capture_retry_path().read_text(), "not json at all\n" + '{"broken": \n')

    def test_retry_stays_durable_while_inflight_and_is_not_submitted_twice(self) -> None:
        payload = {
            "user": "blocked", "assistant": "blocked reply", "sessionId": "session-e", "attempts": 1,
            "agentId": "main", "scopeKey": self.runtime.scope_key,
            "aclBinding": self.runtime.scope_binding.acl_binding,
        }
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
