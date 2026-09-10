"""Regression coverage for durable capture and journal identities."""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain
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
        self.domain.on_turn("user", "assistant", "session", capture_id=self.capture_id,
                            captured_at=self.captured_at)
        journal_path = self.domain.neo_dir / "turn-journal.jsonl"
        rows = self._journal()
        journal_path.write_text(json.dumps(rows[0]) + "\n", encoding="utf-8")
        (self.domain.neo_dir / "episodes.jsonl").unlink()

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

    def test_partial_pair_rejects_changed_missing_role_content(self) -> None:
        self.domain.on_turn("user", "assistant-one", "session", capture_id=self.capture_id,
                            captured_at=self.captured_at)
        rows = self._journal()
        (self.domain.neo_dir / "turn-journal.jsonl").write_text(
            json.dumps(rows[0]) + "\n", encoding="utf-8")
        (self.domain.neo_dir / "episodes.jsonl").unlink()

        with self.assertRaisesRegex(ValueError, "capture identity"):
            self.domain.on_turn("user", "assistant-two", "session", capture_id=self.capture_id,
                                captured_at=self.captured_at)

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


if __name__ == "__main__":
    unittest.main()
