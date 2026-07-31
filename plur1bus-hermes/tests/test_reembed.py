"""Regression coverage for PLUR1BUS re-embedding preflight behavior."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plur1bus_hermes.reembed import build_report, reembed


class ReembedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.agent_dir = self.root / "lancedb" / "default"
        self.agent_dir.mkdir(parents=True)
        self.config = {"embedding": {"provider": "omlx", "model": "Qwen3-Embedding-8B-4bit-DWQ", "dimensions": 4096}}

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.root)

    @patch("plur1bus_hermes.reembed._source_rows")
    def test_dry_run_reports_dimension_change_without_embedding(self, source_rows) -> None:
        source_rows.return_value = [{"id": "a", "content": "remember this", "vector": [0.1, 0.2]}]

        report = reembed(self.root, "default", self.config, apply=False)

        self.assertEqual(report["status"], "ready")
        self.assertEqual(report["sourceVectorDimensions"], {2: 1})
        self.assertEqual(report["targetEmbedding"]["dimensions"], 4096)

    @patch("plur1bus_hermes.reembed._source_rows")
    def test_inventory_rejects_missing_embedding_section(self, source_rows) -> None:
        source_rows.return_value = []

        with self.assertRaisesRegex(Exception, "embedding section"):
            build_report(self.root, "default", {})


if __name__ == "__main__":
    unittest.main()
