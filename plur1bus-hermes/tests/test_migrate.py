"""Regression coverage for the non-destructive PLUR1BUS migration preflight."""

from __future__ import annotations

import argparse
import json
import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.migrate import (
    _copy_snapshot_assets,
    _stage_reminder_import,
    _stage_security_and_index_state,
    run_dry_run,
    run_migrate,
)


def _args(source: Path, target: Path, **overrides):
    values = {
        "source": str(source),
        "target": str(target),
        "snapshot": "",
        "agent_map": {},
        "auto_map": False,
        "dry_run": True,
        "apply": False,
        "require_snapshot": False,
        "report": "",
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class MigrationPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.source = self.root / "source"
        self.target = self.root / "target"
        (self.source / "lancedb-namespaced" / "default").mkdir(parents=True)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.root)

    def test_single_agent_auto_mapping_is_ready(self) -> None:
        report = run_dry_run(_args(self.source, self.target, auto_map=True))

        self.assertEqual(report["status"], "ready")
        self.assertEqual(report["agentMap"], {"default": "default"})
        self.assertTrue(report["manifestSha256"])

    def test_multiple_agents_require_explicit_mapping(self) -> None:
        (self.source / "lancedb-namespaced" / "second").mkdir()
        report = run_dry_run(_args(self.source, self.target, auto_map=True))

        self.assertEqual(report["status"], "blocked")
        self.assertIn("explicit --agent-map is required", " ".join(report["errors"]))

    def test_apply_without_snapshot_never_creates_target(self) -> None:
        report = run_migrate(_args(self.source, self.target, auto_map=True, dry_run=False, apply=True))

        self.assertEqual(report["status"], "blocked")
        self.assertFalse(self.target.exists())

    def test_assets_and_reminders_are_staged_without_scheduler_writes(self) -> None:
        snapshot = self.root / "snapshot"
        staging = self.root / "staging"
        (snapshot / "archives").mkdir(parents=True)
        (snapshot / "obsidian").mkdir()
        (snapshot / "reminders").mkdir()
        (snapshot / "state").mkdir()
        (snapshot / "archives" / "card.json").write_text("{}", encoding="utf-8")
        (snapshot / "obsidian" / "note.md").write_text('<section id="graph-links">x</section>', encoding="utf-8")
        (snapshot / "reminders" / "items.json").write_text(json.dumps({"reminders": [{"schedule": "0 9 * * *", "message": "Review", "agentId": "default"}]}), encoding="utf-8")
        (snapshot / "state" / "confirmations.json").write_text("{}", encoding="utf-8")

        assets = _copy_snapshot_assets(snapshot, staging)
        reminders = _stage_reminder_import(snapshot, staging, {"default": "default"})
        state = _stage_security_and_index_state(snapshot, staging)

        self.assertEqual(assets["archivesCopied"], 1)
        self.assertEqual(len(assets["managedBlocks"]), 1)
        self.assertEqual(reminders["proposals"], 1)
        self.assertEqual(state["invalidatedNonceSources"], 1)
        self.assertFalse((self.target / "cron" / "jobs.json").exists())


if __name__ == "__main__":
    unittest.main()
