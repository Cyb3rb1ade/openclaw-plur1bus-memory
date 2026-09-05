"""Regression tests for safe workspace migration preflight."""

from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plur1bus_hermes.workspace_migrate import _pending_resume_rows, run_dry_run


def _args(source: Path, target: Path, snapshot: Path, **overrides):
    values = {
        "source": str(source),
        "target": str(target),
        "snapshot": str(snapshot),
        "config": {"embedding": {"provider": "omlx", "model": "Qwen3-Embedding-8B-4bit-DWQ", "dimensions": 4096}},
        "agent_map": {},
        "auto_map": True,
        "replace_target": False,
        "apply": False,
        "report": "",
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class WorkspaceMigrationPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.source = self.root / "source"
        self.snapshot = self.root / "snapshot"
        self.target = self.root / "target"
        for root in (self.source, self.snapshot):
            (root / "lancedb-namespaced" / "default").mkdir(parents=True)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.root)

    @patch("plur1bus_hermes.workspace_migrate._migratable_agents")
    def test_single_agent_workspace_is_ready_for_reembedding(self, migratable_agents) -> None:
        migratable_agents.return_value = ([{"agentId": "default", "path": str(self.source / "lancedb-namespaced" / "default"), "hasData": True}], [])
        report = run_dry_run(_args(self.source, self.target, self.snapshot))

        self.assertEqual(report["status"], "ready")
        self.assertTrue(report["embeddingMigration"]["required"])
        self.assertFalse(report["embeddingMigration"]["rerankingMigrationRequired"])

    @patch("plur1bus_hermes.workspace_migrate._migratable_agents")
    def test_existing_target_data_blocks_workspace_migration(self, migratable_agents) -> None:
        migratable_agents.return_value = ([{"agentId": "default", "path": str(self.source / "lancedb-namespaced" / "default"), "hasData": True}], [])
        self.target.mkdir(parents=True)
        (self.target / "existing.txt").write_text("existing", encoding="utf-8")

        report = run_dry_run(_args(self.source, self.target, self.snapshot))

        self.assertEqual(report["status"], "blocked")
        self.assertIn("target already contains data", report["errors"][0])

    def test_resume_tracks_duplicate_multiplicity_and_content(self) -> None:
        rows = [
            {"id": "same", "text": "alpha"},
            {"id": "same", "text": "alpha"},
            {"id": "same", "text": "beta"},
        ]
        portable_id = "4095c112-89e4-5f3d-89f4-72fe24a2a908"
        with patch(
            "plur1bus_hermes.workspace_migrate._portable_memory_id",
            return_value=portable_id,
        ):
            pending, contents = _pending_resume_rows(
                rows,
                [{"id": portable_id, "content": "alpha"}],
                "main",
            )

        self.assertEqual(pending, rows[1:])
        self.assertEqual(contents, ["alpha", "beta"])


if __name__ == "__main__":
    unittest.main()
