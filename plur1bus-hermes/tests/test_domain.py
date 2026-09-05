"""Regression coverage for the PLUR1BUS Hermes domain feature runtime."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import lancedb

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.dream_diary import END_MARKER, START_MARKER
from plur1bus_hermes.namespaces import binding_from_scope


class DomainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.agent_dir = self.root / "lancedb" / "main"
        self.agent_dir.mkdir(parents=True)
        binding = binding_from_scope("main")
        self.record = {
            "id": "619c3d51-1d9d-4736-8bf9-91b38aff8246",
            "agentId": "main",
            "scopeKey": binding.scope_key,
            "scopeType": binding.scope_type,
            "aclBindings": binding.as_dict(),
            "sessionId": "session",
            "content": "Bitte merke diese wichtige Information.",
            "status": "active",
            "type": "observation",
            "sourceRole": "user",
            "createdAt": "2026-07-26T00:00:00+00:00",
            "vector": [1.0, 0.0, 0.0, 0.0],
        }
        self.table = lancedb.connect(str(self.agent_dir)).create_table("memories", data=[self.record])
        self.domain = Plur1busDomain(self.root, "main")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_capture_materializes_metadata_obsidian_turns_and_episodes(self) -> None:
        self.domain.on_turn("Hallo", "Hi", "session")
        self.domain.on_memory(self.record, self.table)

        database = lancedb.connect(str(self.agent_dir))
        self.assertEqual(database.open_table("metadata").count_rows(), 1)
        self.assertTrue((self.root / "profiles" / "main" / "workspace" / "plur1bus" / "memories" / f"{self.record['id']}.md").is_file())
        self.assertEqual(self.domain.status()["episodes"], 1)

    def test_dreaming_and_consolidation_are_non_destructive(self) -> None:
        dream = self.domain.run_dreaming(self.table)
        report = self.domain.run_consolidation(self.table)

        self.assertEqual(dream["agentId"], "main")
        self.assertEqual(self.domain.status()["dreams"], 1)
        self.assertFalse(report["destructiveChanges"])
        self.assertEqual(self.table.count_rows(), 1)

    def test_private_dream_uses_managed_diary_without_erasing_manual_content(self) -> None:
        diary = self.root / "profiles" / "main" / "workspace" / "DREAMS.md"
        diary.parent.mkdir(parents=True)
        diary.write_text("# My manual dream notes\n", encoding="utf-8")
        self.domain.run_dreaming(self.table)
        self.domain.run_dreaming(self.table)
        text = diary.read_text(encoding="utf-8")

        self.assertIn("# My manual dream notes", text)
        self.assertEqual(text.count(START_MARKER), 1)
        self.assertEqual(text.count(END_MARKER), 1)
        self.assertEqual(text.count("REM synthesis connected"), 1)

    def test_diary_disabled_and_shared_dreams_never_create_dreams_md(self) -> None:
        disabled = Plur1busDomain(self.root / "disabled", "main", {"dreaming": {"narrative": {"diary": False}}})
        disabled.run_dreaming(self.table)
        self.assertFalse((disabled.workspace_dir / "DREAMS.md").exists())

        shared = Plur1busDomain(self.root / "shared", "main")
        shared.run_dreaming(
            self.table,
            acl_bindings={"agentId": "main", "scopeType": "workspace", "workspaceIdentity": "team"},
        )
        self.assertFalse((shared.workspace_dir / "DREAMS.md").exists())


if __name__ == "__main__":
    unittest.main()
