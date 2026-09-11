"""Regression coverage for durable capture and journal identities."""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.capture_journal import (
    MAX_RECEIPT_BYTES,
    read_receipt,
    receipt_path,
    write_receipt,
)
from plur1bus_hermes.turn_identity import turn_record_id


class TurnIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.domain = Plur1busDomain(self.root, "main")
        self.capture_id = str(uuid.uuid4())
        self.captured_at = "2026-09-11T12:00:00+00:00"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _journal(self) -> list[dict]:
        return self.domain._read_jsonl(self.domain.neo_dir / "turn-journal.jsonl")

    def test_turn_record_id_is_stable_and_role_bound(self) -> None:
        user = turn_record_id(self.capture_id, "main", "scope", "session", "user")
        self.assertEqual(user, turn_record_id(self.capture_id, "main", "scope", "session", "user"))
        self.assertNotEqual(user, turn_record_id(self.capture_id, "main", "scope", "session", "assistant"))
        with self.assertRaises(ValueError):
            turn_record_id("not-a-uuid", "main", "scope", "session", "user")
        with self.assertRaises(ValueError):
            turn_record_id(self.capture_id, "main", "scope", "session", "system")

    def test_replay_resumes_partial_pair_without_duplicate_episode(self) -> None:
        original_append = self.domain._append_capture_journal_record
        interrupted = {"done": False}

        def append_then_interrupt(path, record):
            result = original_append(path, record)
            if record.get("role") == "user" and not interrupted["done"]:
                interrupted["done"] = True
                raise RuntimeError("injected interruption after durable append")
            return result

        self.domain._append_capture_journal_record = append_then_interrupt
        with self.assertRaisesRegex(RuntimeError, "injected interruption"):
            self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                                captured_at=self.captured_at)
        self.domain._append_capture_journal_record = original_append
        self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                            captured_at=self.captured_at)

        journal = self._journal()
        episodes = self.domain._read_jsonl(self.domain.neo_dir / "episodes.jsonl")
        self.assertEqual([row["role"] for row in journal], ["user", "assistant"])
        self.assertEqual([row["createdAt"] for row in journal], [self.captured_at, self.captured_at])
        self.assertEqual(len(episodes), 1)
        self.assertEqual(episodes[0]["turnIds"], [row["id"] for row in journal])

    def test_same_capture_identity_with_changed_session_fails_closed(self) -> None:
        self.domain.on_turn("user", "assistant", "session-one", capture_id=self.capture_id,
                            captured_at=self.captured_at)

        with self.assertRaisesRegex(ValueError, "capture identity"):
            self.domain.on_turn("user", "assistant", "session-two", capture_id=self.capture_id,
                                captured_at=self.captured_at)

    def test_conflicting_replay_fails_before_mutating_durable_targets(self) -> None:
        self.domain.on_turn("user", "assistant-one", "session", capture_id=self.capture_id,
                            captured_at=self.captured_at)
        journal_path = self.domain.neo_dir / "turn-journal.jsonl"
        episode_path = self.domain.neo_dir / "episodes.jsonl"
        before_journal = journal_path.read_bytes()
        before_episodes = episode_path.read_bytes()
        with self.assertRaisesRegex(ValueError, "capture identity"):
            self.domain.on_turn("user", "assistant-two", "session", capture_id=self.capture_id,
                                captured_at=self.captured_at)
        self.assertEqual(journal_path.read_bytes(), before_journal)
        self.assertEqual(episode_path.read_bytes(), before_episodes)

    def test_same_capture_identity_with_changed_scope_fails_closed(self) -> None:
        self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                            captured_at=self.captured_at)

        with self.assertRaisesRegex(ValueError, "capture identity"):
            self.domain.on_turn(
                "user", "assistant", "session", capture_id=self.capture_id,
                captured_at=self.captured_at,
                acl_bindings={"agentId": "main", "scopeType": "workspace", "workspaceIdentity": "team"},
            )

    def test_same_text_admitted_twice_creates_distinct_turns(self) -> None:
        self.domain.on_turn("same", "same reply", "session")
        self.domain.on_turn("same", "same reply", "session")

        journal = self._journal()
        self.assertEqual(len(journal), 4)
        self.assertEqual(len({row["id"] for row in journal}), 4)

    def test_open_thread_side_effect_keeps_capture_timestamp(self) -> None:
        self.domain.on_turn("Das muss noch gemacht werden.", "assistant", "session",
                            capture_id=self.capture_id, captured_at=self.captured_at)

        rows = self.domain._read_jsonl(self.domain.neo_dir / "open-threads.jsonl")
        self.assertTrue(rows)
        self.assertEqual(rows[0]["createdAt"], self.captured_at)

    def test_capture_id_without_timestamp_reuses_receipt_timestamp(self) -> None:
        self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                            captured_at=self.captured_at)
        before = self._journal()
        self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id)
        self.assertEqual(self._journal(), before)

    def test_interrupted_receipt_fails_closed_after_another_capture_appends(self) -> None:
        original_append = self.domain._append_capture_journal_record
        interrupted = {"done": False}

        def append_then_interrupt(path, record):
            result = original_append(path, record)
            if record.get("role") == "user" and not interrupted["done"]:
                interrupted["done"] = True
                raise RuntimeError("injected interruption after durable append")
            return result

        self.domain._append_capture_journal_record = append_then_interrupt
        with self.assertRaisesRegex(RuntimeError, "injected interruption"):
            self.domain.on_turn("first", "first reply", "session", capture_id=self.capture_id,
                                captured_at=self.captured_at)
        self.domain._append_capture_journal_record = original_append
        self.domain.on_turn("second", "second reply", "session")
        before = (self.domain.neo_dir / "turn-journal.jsonl").read_bytes()

        with self.assertRaisesRegex(ValueError, "(prepared range|episode target) drifted"):
            self.domain.on_turn("first", "first reply", "session", capture_id=self.capture_id,
                                captured_at=self.captured_at)
        self.assertEqual((self.domain.neo_dir / "turn-journal.jsonl").read_bytes(), before)

    def test_episode_drift_is_rejected_before_journal_mutation(self) -> None:
        self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                            captured_at=self.captured_at)
        journal_path = self.domain.neo_dir / "turn-journal.jsonl"
        episode_path = self.domain.neo_dir / "episodes.jsonl"
        before_journal = journal_path.read_bytes()
        damaged = episode_path.read_bytes()
        episode_path.write_bytes(b"X" + damaged[1:])

        with self.assertRaisesRegex(ValueError, "episode target drifted"):
            self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                                captured_at=self.captured_at)
        self.assertEqual(journal_path.read_bytes(), before_journal)

    def test_bool_receipt_offset_is_rejected_before_arithmetic(self) -> None:
        self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                            captured_at=self.captured_at)
        journal_path = self.domain.neo_dir / "turn-journal.jsonl"
        before = journal_path.read_bytes()
        path = receipt_path(self.root, "main", self.capture_id)
        receipt = json.loads(path.read_text(encoding="utf-8"))
        receipt["episodePlan"]["offset"] = True
        path.write_text(json.dumps(receipt), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "episode offset"):
            self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                                captured_at=self.captured_at)
        self.assertEqual(journal_path.read_bytes(), before)

    def test_materialized_receipt_must_be_an_exact_plan_prefix(self) -> None:
        self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                            captured_at=self.captured_at)
        path = receipt_path(self.root, "main", self.capture_id)
        receipt = read_receipt(path)
        assert receipt is not None
        receipt["journal"] = [receipt["journalPlans"][1]]
        write_receipt(path, receipt)
        journal_path = self.domain.neo_dir / "turn-journal.jsonl"
        episode_path = self.domain.neo_dir / "episodes.jsonl"
        before_journal = journal_path.read_bytes()
        before_episode = episode_path.read_bytes()

        with self.assertRaisesRegex(ValueError, "journal prefix"):
            self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                                captured_at=self.captured_at)
        self.assertEqual(journal_path.read_bytes(), before_journal)
        self.assertEqual(episode_path.read_bytes(), before_episode)

    def test_missing_episode_plan_cannot_reprepare_completed_receipt(self) -> None:
        for state in ("prepared", "committed"):
            with self.subTest(state=state):
                root = self.root / state
                domain = Plur1busDomain(root, "main")
                capture_id = str(uuid.uuid4())
                domain.on_turn("user", "assistant", "session", capture_id=capture_id,
                               captured_at=self.captured_at)
                path = receipt_path(root, "main", capture_id)
                receipt = read_receipt(path)
                assert receipt is not None
                receipt["state"] = state
                receipt["episodePlan"] = None
                receipt["episode"] = None
                write_receipt(path, receipt)
                before = {
                    item.relative_to(root): item.read_bytes()
                    for item in root.rglob("*")
                    if item.is_file()
                }
                callbacks: list[bool] = []

                with self.assertRaisesRegex(ValueError, "receipt (state|completion)"):
                    domain.on_turn(
                        "user", "assistant", "session", capture_id=capture_id,
                        captured_at=self.captured_at,
                        receipt_materialized=lambda: callbacks.append(True),
                    )

                after = {
                    item.relative_to(root): item.read_bytes()
                    for item in root.rglob("*")
                    if item.is_file()
                }
                self.assertEqual(after, before)
                self.assertEqual(callbacks, [])

    def test_receipt_omits_episode_summary_and_rejects_oversize_read(self) -> None:
        self.domain.on_turn("user body", "assistant body", "session", capture_id=self.capture_id,
                            captured_at=self.captured_at)
        path = receipt_path(self.root, "main", self.capture_id)
        receipt = read_receipt(path)
        assert receipt is not None
        self.assertNotIn("summary", receipt["episodePlan"]["record"])
        path.write_bytes(b"x" * (MAX_RECEIPT_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "receipt"):
            read_receipt(path)


if __name__ == "__main__":
    unittest.main()
