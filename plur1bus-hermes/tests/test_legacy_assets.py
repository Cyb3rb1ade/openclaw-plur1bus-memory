"""Regression coverage for lossless OpenClaw legacy asset conversion."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import lancedb

from plur1bus_hermes.legacy_assets import (
    normalize_legacy_status,
    stage_card_metadata,
    stage_complete_assets,
)


class LegacyAssetsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_legacy_workflow_statuses_remain_recallable(self) -> None:
        self.assertEqual(normalize_legacy_status("review"), "active")
        self.assertEqual(normalize_legacy_status(""), "active")
        self.assertEqual(normalize_legacy_status("archived"), "archived")

    def test_card_metadata_preserves_all_non_vector_fields(self) -> None:
        agent_dir = self.root / "agent"
        agent_dir.mkdir()
        rows = [{
            "id": "legacy-id",
            "text": "Remember",
            "vector": [0.1, 0.2],
            "status": "review",
            "importance": 0.9,
            "emotionalDominant": "trust",
            "retrievalCount": 7,
        }]
        count = stage_card_metadata(agent_dir, "main", "main", rows, {"legacy-id": "portable-id"})

        self.assertEqual(count, 1)
        record = lancedb.connect(str(agent_dir)).open_table("metadata").to_arrow().to_pylist()[0]
        metadata = json.loads(record["metadataJson"])
        self.assertNotIn("vector", metadata)
        self.assertEqual(metadata["importance"], 0.9)
        self.assertEqual(metadata["emotionalDominant"], "trust")
        self.assertEqual(metadata["retrievalCount"], 7)
        self.assertEqual(record["legacyStatus"], "review")

    def test_neo_archive_and_workspace_are_agent_scoped_and_secret_filtered(self) -> None:
        openclaw = self.root / ".openclaw"
        snapshot = openclaw / "memory" / ".snapshots" / "snapshot"
        neo = snapshot / "lancedb-namespaced" / "_neo" / "workspaces" / "main"
        archive = snapshot / "_archive" / "main"
        workspace = openclaw / "workspace"
        neo.mkdir(parents=True)
        archive.mkdir(parents=True)
        workspace.mkdir(parents=True)
        (neo / "memory-graph.jsonl").write_text(
            json.dumps({"id": "edge", "agentId": "main", "workspaceKey": "workspace", "source": "old-id", "target": "hash"}) + "\n",
            encoding="utf-8",
        )
        (archive / "card.json").write_text("{}", encoding="utf-8")
        (workspace / "IDENTITY.md").write_text("Bernd", encoding="utf-8")
        (workspace / "USER.md").write_text("Christian", encoding="utf-8")
        (workspace / "SOUL.md").write_text("Original soul", encoding="utf-8")
        (workspace / "AGENTS.md").write_text("Agent\u200drules", encoding="utf-8")
        (workspace / ".env").write_text("SECRET=x", encoding="utf-8")
        staging = self.root / "staging"

        result = stage_complete_assets(
            snapshot,
            staging,
            {"main": "main"},
            {"main": {"old-id": "new-id"}},
        )

        graph = json.loads((staging / "neo" / "main" / "memory-graph.jsonl").read_text(encoding="utf-8"))
        self.assertEqual(graph["agentId"], "main")
        self.assertEqual(graph["workspaceKey"], "main")
        self.assertEqual(graph["source"], "new-id")
        self.assertTrue((staging / "archives" / "main" / "card.json").is_file())
        self.assertTrue((staging / "profiles" / "main" / "workspace" / "IDENTITY.md").is_file())
        self.assertFalse((staging / "profiles" / "main" / "workspace" / ".env").exists())
        staged_soul = (staging / "profiles" / "main" / "workspace" / "SOUL.md").read_text(encoding="utf-8")
        staged_agents = (staging / "profiles" / "main" / "workspace" / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("# Hermes Agent Identity", staged_soul)
        self.assertIn("Bernd", staged_soul)
        self.assertIn("Original soul", staged_soul)
        self.assertEqual(staged_agents, "Agentrules")
        self.assertTrue(result["identityCompatibility"]["main"]["identity"]["configured"])
        self.assertEqual(
            result["identityCompatibility"]["main"]["contextFiles"]["removedInvisibleCharacters"],
            {"AGENTS.md": 1},
        )
        self.assertEqual(result["profilesCreated"], 1)

    def test_legacy_json_with_unpaired_surrogate_is_preserved_as_escape(self) -> None:
        snapshot = self.root / "snapshot"
        neo = snapshot / "lancedb-namespaced" / "_neo" / "workspaces" / "main"
        neo.mkdir(parents=True)
        source = {"id": "edge", "agentId": "main", "note": "\ud83d"}
        (neo / "memory-graph.jsonl").write_text(
            json.dumps(source, ensure_ascii=True) + "\n",
            encoding="utf-8",
        )
        staging = self.root / "staging"

        stage_complete_assets(
            snapshot,
            staging,
            {"main": "main"},
            {"main": {}},
        )

        output = (staging / "neo" / "main" / "memory-graph.jsonl").read_text(encoding="utf-8")
        self.assertIn("\\ud83d", output)
        self.assertEqual(json.loads(output)["note"], "\ud83d")


if __name__ == "__main__":
    unittest.main()
