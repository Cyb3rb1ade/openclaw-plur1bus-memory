"""Regression coverage for the PLUR1BUS Hermes domain feature runtime."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import lancedb

from plur1bus_hermes.domain import Plur1busDomain


class DomainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.agent_dir = self.root / "lancedb" / "main"
        self.agent_dir.mkdir(parents=True)
        self.record = {
            "id": "619c3d51-1d9d-4736-8bf9-91b38aff8246",
            "agentId": "main",
            "scopeKey": "scope",
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


if __name__ == "__main__":
    unittest.main()
