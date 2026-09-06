"""Scope isolation and ownership regressions for durable capture retries."""

from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.validation import ValidationError


def _config(agent_id: str) -> dict[str, object]:
    return {
        "dataDir": "plur1bus",
        "agentId": agent_id,
        "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
        "reranker": {"provider": "disabled"},
    }


class CaptureRetryScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.runtimes: list[Plur1busRuntime] = []

    def tearDown(self) -> None:
        for runtime in self.runtimes:
            runtime.shutdown()
        self.temporary.cleanup()

    def _runtime(self, agent: str, workspace: str) -> Plur1busRuntime:
        runtime = Plur1busRuntime(
            self.root, _config(agent), agent,
            {"scopeType": "workspace", "workspace": workspace},
        )
        self.runtimes.append(runtime)
        return runtime

    @staticmethod
    def _payload(user: str = "retry user") -> dict[str, object]:
        return {"user": user, "assistant": "retry assistant", "sessionId": "session-1"}

    @staticmethod
    def _wait_for(predicate) -> bool:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return False

    def test_agent_and_scope_queues_are_physically_isolated(self) -> None:
        alpha = self._runtime("alpha", "workspace-a")
        beta = self._runtime("beta", "workspace-a")
        alpha_other_scope = self._runtime("alpha", "workspace-b")

        class FailingEmbedding:
            def embed(self, _text: str, *, purpose: str = "passage") -> list[float]:
                raise RuntimeError("isolated retry failure")

            def close(self) -> None:
                return None

        alpha._embedding = FailingEmbedding()
        alpha.capture_async("retry user", "retry assistant", "session-1")
        alpha.flush()
        self.assertTrue(self._wait_for(lambda: len(alpha._read_capture_retries()) == 1))

        self.assertTrue(alpha._capture_retry_path().is_file())
        self.assertNotEqual(alpha._capture_retry_path(), beta._capture_retry_path())
        self.assertNotEqual(alpha._capture_retry_path(), alpha_other_scope._capture_retry_path())
        self.assertEqual(beta._read_capture_retries(), [])
        self.assertEqual(alpha_other_scope._read_capture_retries(), [])

        submitted: list[dict[str, object]] = []
        beta._submit_capture = lambda payload, attempts, *, from_retry=False: submitted.append(payload)  # type: ignore[method-assign]
        beta._resubmit_capture_retries()
        self.assertEqual(submitted, [])
        self.assertEqual(len(alpha._read_capture_retries()), 1)

    def test_scope_drift_is_retained_but_never_resubmitted(self) -> None:
        runtime = self._runtime("alpha", "workspace-a")
        runtime._record_capture_retry(self._payload(), 1)
        entries = runtime._read_capture_retries()
        entries[0]["aclBinding"] = "forged-binding"
        runtime._write_capture_retries(entries)
        submitted: list[dict[str, object]] = []
        runtime._submit_capture = lambda payload, attempts, *, from_retry=False: submitted.append(payload)  # type: ignore[method-assign]

        with self.assertLogs("plur1bus_hermes.runtime", level="WARNING") as captured:
            runtime._resubmit_capture_retries()

        self.assertEqual(submitted, [])
        self.assertEqual(runtime._read_capture_retries()[0]["aclBinding"], "forged-binding")
        self.assertTrue(any("mismatched agent or scope" in line for line in captured.output))

    def test_legacy_root_queue_is_not_claimed_or_modified(self) -> None:
        legacy = self.root / "state" / "capture-retry.jsonl"
        legacy.parent.mkdir(parents=True)
        original = json.dumps({"user": "legacy", "attempts": 1}).encode() + b"\n"
        legacy.write_bytes(original)
        runtime = self._runtime("alpha", "workspace-a")

        with self.assertLogs("plur1bus_hermes.runtime", level="WARNING") as captured:
            runtime._resubmit_capture_retries()
        runtime._record_capture_retry(self._payload("new scoped retry"), 1)

        self.assertEqual(legacy.read_bytes(), original)
        self.assertEqual(runtime._read_capture_retries()[0]["user"], "new scoped retry")
        self.assertTrue(any("legacy unowned capture retry queue" in line for line in captured.output))

    def test_record_and_remove_preserve_malformed_or_nonobject_queue_evidence(self) -> None:
        runtime = self._runtime("alpha", "workspace-a")
        path = runtime._capture_retry_path()
        path.parent.mkdir(parents=True)
        opaque = b'{"broken":\n["not", "an", "object"]\n'
        path.write_bytes(opaque)

        runtime._record_capture_retry(self._payload(), 1)
        recorded = runtime._read_capture_retries()
        self.assertEqual(len(recorded), 1)
        self.assertIn(opaque, path.read_bytes())

        runtime._remove_capture_retry(recorded[0])
        self.assertEqual(runtime._read_capture_retries(), [])
        self.assertIn(opaque, path.read_bytes())

    def test_mixed_line_endings_in_opaque_retry_evidence_are_byte_preserved(self) -> None:
        runtime = self._runtime("alpha", "workspace-a")
        path = runtime._capture_retry_path()
        path.parent.mkdir(parents=True)
        opaque = b'{"broken":\r\n["nonobject"]\n["also"]\r\n'
        path.write_bytes(opaque)
        runtime._record_capture_retry(self._payload(), 1)
        self.assertTrue(path.read_bytes().startswith(opaque))
        runtime._remove_capture_retry(runtime._read_capture_retries()[0])
        self.assertEqual(path.read_bytes(), opaque)

    def test_symlinked_scoped_state_component_is_rejected(self) -> None:
        runtime = self._runtime("alpha", "workspace-a")
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "state" / "alpha").symlink_to(outside, target_is_directory=True)

        with self.assertRaises(ValidationError):
            runtime._record_capture_retry(self._payload(), 1)


if __name__ == "__main__":
    unittest.main()
