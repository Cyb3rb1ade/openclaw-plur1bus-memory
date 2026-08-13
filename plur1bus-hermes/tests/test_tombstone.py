"""Negative Evals für den kanonischen Tombstone-Vertrag im Hermes-Adapter."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.legacy_assets import normalize_legacy_status
from plur1bus_hermes.tombstone import (
    append_tombstone_to_registry,
    build_tombstone,
    content_fingerprint,
    find_blocking_tombstone_for_capture,
    find_tombstone_by_fingerprint,
    read_tombstones_from_registry,
    tombstone_blocks_capture,
)

UUID_A = "a4563cc9-7611-4528-992a-075f8889a018"


class TombstoneContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_build_tombstone_has_fields_and_no_plaintext(self) -> None:
        tombstone = build_tombstone(
            card={"id": UUID_A, "content": "Mein geheimer API-Key ist abc123", "scope": "agent-private"},
            agent_id="agent-a",
            actor="user",
            reason="forget",
        )
        self.assertEqual(tombstone["memoryId"], UUID_A)
        self.assertEqual(tombstone["agentId"], "agent-a")
        self.assertEqual(tombstone["status"], "committed")
        self.assertTrue(tombstone["contentFingerprint"])
        self.assertNotIn("abc123", str(tombstone))

    def test_scope_binding(self) -> None:
        base = build_tombstone(
            card={"id": UUID_A, "content": "x", "scope": "agent-private"},
            agent_id="agent-a",
        )
        self.assertTrue(tombstone_blocks_capture(base, {"agentId": "agent-a"}))
        self.assertFalse(tombstone_blocks_capture(base, {"agentId": "agent-b"}))

        ws = build_tombstone(card={"id": UUID_A, "content": "x", "scope": "workspace", "workspaceKey": "ws-1"}, agent_id="agent-a")
        self.assertTrue(tombstone_blocks_capture(ws, {"agentId": "agent-a", "workspaceIdentity": "ws-1"}))
        self.assertFalse(tombstone_blocks_capture(ws, {"agentId": "agent-a", "workspaceIdentity": "ws-2"}))

    def test_registry_roundtrip_and_fingerprint_block(self) -> None:
        tombstone = build_tombstone(
            card={"id": UUID_A, "content": "Gelöschter Fakt", "scope": "agent-private"},
            agent_id="agent-a",
        )
        append_tombstone_to_registry(self.base, "agent-a", {**tombstone, "status": "attempted"})
        self.assertIsNone(find_tombstone_by_fingerprint(self.base, "agent-a", tombstone["contentFingerprint"]))
        append_tombstone_to_registry(self.base, "agent-a", {**tombstone, "status": "committed"})
        found = find_tombstone_by_fingerprint(self.base, "agent-a", tombstone["contentFingerprint"])
        self.assertIsNotNone(found)
        self.assertEqual(read_tombstones_from_registry(self.base, "agent-a")[1]["status"], "committed")

        blocking = find_blocking_tombstone_for_capture(
            self.base, {"agentId": "agent-a", "text": "gelöschter fakt", "scope": "agent-private"}
        )
        self.assertIsNotNone(blocking)
        foreign = find_blocking_tombstone_for_capture(
            self.base, {"agentId": "agent-b", "text": "gelöschter fakt", "scope": "agent-private"}
        )
        self.assertIsNone(foreign)

    def test_fingerprint_normalizes(self) -> None:
        self.assertEqual(content_fingerprint("  Hallo   WELT "), content_fingerprint("hallo welt"))


class LegacyStatusTests(unittest.TestCase):
    def test_legacy_recallable_statuses_map_to_active(self) -> None:
        for status in ("review", "pending", "draft", "candidate", ""):
            self.assertEqual(normalize_legacy_status(status), "active", status)

    def test_safe_statuses_preserved(self) -> None:
        self.assertEqual(normalize_legacy_status("active"), "active")
        self.assertEqual(normalize_legacy_status("superseded"), "superseded")
        self.assertEqual(normalize_legacy_status("archived"), "archived")
        self.assertEqual(normalize_legacy_status("deleted"), "deleted")

    def test_tombstone_like_and_unknown_statuses_fail_closed(self) -> None:
        for status in ("tombstoned", "pruned", "invalidated", "archvied", "review-x", "garbage"):
            self.assertEqual(normalize_legacy_status(status), "archived", status)


if __name__ == "__main__":
    unittest.main()
