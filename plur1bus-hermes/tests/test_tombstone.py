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
        self.assertTrue(tombstone_blocks_capture(base, {"agentId": "agent-a", "scope": "agent-private"}))
        self.assertFalse(tombstone_blocks_capture(base, {"agentId": "agent-b", "scope": "agent-private"}))
        # agent-private blockiert NUR agent-private.
        self.assertFalse(tombstone_blocks_capture(base, {"agentId": "agent-a", "scope": "workspace", "workspaceIdentity": "ws-1"}))
        self.assertFalse(tombstone_blocks_capture(base, {"agentId": "agent-a", "scope": "user", "ownerUserId": "user:v1:aaa"}))

        ws = build_tombstone(card={"id": UUID_A, "content": "x", "scope": "workspace", "workspaceKey": "ws-1"}, agent_id="agent-a")
        self.assertTrue(tombstone_blocks_capture(ws, {"agentId": "agent-a", "scope": "workspace", "workspaceIdentity": "ws-1"}))
        self.assertFalse(tombstone_blocks_capture(ws, {"agentId": "agent-a", "scope": "workspace", "workspaceIdentity": "ws-2"}))
        self.assertFalse(tombstone_blocks_capture(ws, {"agentId": "agent-a", "scope": "agent-private"}))

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


class _StubEmbedding:
    def embed(self, text, *, purpose="passage"):
        return [0.1, 0.2, 0.3, 0.4]

    def close(self):
        pass


class TombstoneRuntimeIntegrationTests(unittest.TestCase):
    """End-to-End: _remember() prüft die Tombstone-Registry VOR dem Insert."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        config = {
            "dataDir": "plur1bus",
            "agentId": "main",
            "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
            "reranker": {"provider": "disabled"},
        }
        from plur1bus_hermes.runtime import Plur1busRuntime

        self.runtime = Plur1busRuntime(self.root, config, "main")
        self.runtime._embedding = _StubEmbedding()

    def tearDown(self) -> None:
        self.runtime.shutdown()
        self.temporary.cleanup()

    def _rows(self, runtime=None):
        table, _ = (runtime or self.runtime)._table(create=False)
        if table is None:
            return []
        return table.to_arrow().to_pylist()

    def test_remember_blocks_identical_re_capture_after_forget(self) -> None:
        content = "Meine private Adresse ist Berlin"
        self.runtime._remember(content, "s1", "user")
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        memory_id = rows[0]["id"]
        self.assertTrue(self.runtime.forget(memory_id))

        self.runtime._remember(content, "s2", "user")
        rows = self._rows()
        active = [r for r in rows if r.get("status") == "active"]
        self.assertEqual(len(active), 0, "identische Neuerfassung muss blockiert werden")
        self.assertEqual(len(rows), 1, "kein neuer Insert bei blockierter Neuerfassung")

    def test_other_agent_is_not_blocked(self) -> None:
        from plur1bus_hermes.runtime import Plur1busRuntime

        content = "Fakt der gelöscht wurde"
        self.runtime._remember(content, "s1", "user")
        memory_id = self._rows()[0]["id"]
        self.runtime.forget(memory_id)

        other = Plur1busRuntime(self.root, {
            "dataDir": "plur1bus", "agentId": "other",
            "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
            "reranker": {"provider": "disabled"},
        }, "other")
        other._embedding = _StubEmbedding()
        try:
            other._remember(content, "s1", "user")
            other_rows = self._rows(other)
            self.assertEqual(len(other_rows), 1, "fremder Agent darf nicht blockiert werden")
        finally:
            other.shutdown()


class ScopeResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _append_committed(self, memory_id, text, scope, workspace_key="", owner_user="", agent="agent-a"):
        tombstone = build_tombstone(
            card={"id": memory_id, "content": text, "scope": scope, "workspaceKey": workspace_key, "ownerUserId": owner_user},
            agent_id=agent,
        )
        append_tombstone_to_registry(self.base, agent, {**tombstone, "status": "committed"})

    def test_multiple_same_fingerprint_workspaces_block_correct_scope(self) -> None:
        text = "Gelöschter Inhalt"
        self._append_committed("a4563cc9-7611-4528-992a-075f8889a018", text, "workspace", workspace_key="ws-1")
        self._append_committed("a4563cc9-7611-4528-992a-075f8889a019", text, "workspace", workspace_key="ws-2")

        from plur1bus_hermes.tombstone import find_blocking_tombstone_for_capture
        self.assertIsNotNone(find_blocking_tombstone_for_capture(self.base, {"agentId": "agent-a", "text": text, "scope": "workspace", "workspaceIdentity": "ws-1"}))
        self.assertIsNotNone(find_blocking_tombstone_for_capture(self.base, {"agentId": "agent-a", "text": text, "scope": "workspace", "workspaceIdentity": "ws-2"}))
        self.assertIsNone(find_blocking_tombstone_for_capture(self.base, {"agentId": "agent-a", "text": text, "scope": "workspace", "workspaceIdentity": "ws-3"}))


class RegistryFailSafeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_corrupt_line_blocks_conservatively(self) -> None:
        from plur1bus_hermes.tombstone import find_blocking_tombstone_for_capture, tombstone_registry_dir
        (tombstone_registry_dir(self.base)).mkdir(parents=True, exist_ok=True)
        (tombstone_registry_dir(self.base) / "agent-a.jsonl").write_text("NOT JSON\n", encoding="utf-8")
        blocking = find_blocking_tombstone_for_capture(self.base, {"agentId": "agent-a", "text": "x", "scope": "agent-private"})
        self.assertIsNotNone(blocking)
        self.assertEqual(blocking["_blockReason"], "registry_corrupt_lines")

    def test_read_error_blocks_conservatively(self) -> None:
        from plur1bus_hermes.tombstone import find_blocking_tombstone_for_capture, tombstone_registry_dir
        (tombstone_registry_dir(self.base) / "agent-a.jsonl").mkdir(parents=True, exist_ok=True)
        blocking = find_blocking_tombstone_for_capture(self.base, {"agentId": "agent-a", "text": "x", "scope": "agent-private"})
        self.assertIsNotNone(blocking)
        self.assertEqual(blocking["_blockReason"], "registry_read_error")


class BackfillTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_backfill_creates_committed_when_missing(self) -> None:
        from plur1bus_hermes.tombstone import backfill_committed_tombstone, find_tombstone_by_origin_id
        result = backfill_committed_tombstone(
            self.base, {"id": UUID_A, "content": "x", "scope": "agent-private"}, agent_id="agent-a",
        )
        self.assertFalse(result["alreadyCommitted"])
        found = find_tombstone_by_origin_id(self.base, "agent-a", UUID_A)
        self.assertIsNotNone(found)
        self.assertEqual(found["status"], "committed")

    def test_backfill_is_idempotent(self) -> None:
        from plur1bus_hermes.tombstone import backfill_committed_tombstone, read_tombstones_from_registry
        backfill_committed_tombstone(self.base, {"id": UUID_A, "content": "x", "scope": "agent-private"}, agent_id="agent-a")
        again = backfill_committed_tombstone(self.base, {"id": UUID_A, "content": "x", "scope": "agent-private"}, agent_id="agent-a")
        self.assertTrue(again["alreadyCommitted"])
        committed = [t for t in read_tombstones_from_registry(self.base, "agent-a") if t["status"] == "committed"]
        self.assertEqual(len(committed), 1)
