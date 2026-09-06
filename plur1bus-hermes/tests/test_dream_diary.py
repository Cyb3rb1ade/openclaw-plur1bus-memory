"""Regression tests for private-only DREAMS.md integration."""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from plur1bus_hermes.dream_diary import END_MARKER, START_MARKER, append_dream_diary_entry


class DreamDiaryTests(unittest.TestCase):
    def test_private_dream_is_appended_once_in_a_managed_block(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary).resolve()
            first = append_dream_diary_entry(
                workspace_dir=workspace, agent_id="main", narrative="A calm recurring pattern.",
                now=datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc),
            )
            second = append_dream_diary_entry(
                workspace_dir=workspace, agent_id="main", narrative="A calm recurring pattern.",
                now=datetime(2026, 9, 5, 12, 1, tzinfo=timezone.utc),
            )
            text = (workspace / "DREAMS.md").read_text(encoding="utf-8")
        self.assertEqual(first, {"written": True, "code": "written", "file": "DREAMS.md"})
        self.assertEqual(second["code"], "already_present")
        self.assertEqual(text.count(START_MARKER), 1)
        self.assertEqual(text.count(END_MARKER), 1)
        self.assertEqual(text.count("A calm recurring pattern."), 1)
        self.assertIn("September 5, 2026 at 12:00 PM UTC", text)

    def test_shared_scope_cannot_write_a_diary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary).resolve()
            result = append_dream_diary_entry(
                workspace_dir=workspace, agent_id="main", narrative="Should not escape shared memory.",
                scope={"scopeType": "workspace", "workspace": "team"},
            )
            self.assertFalse((workspace / "DREAMS.md").exists())
        self.assertEqual(result, {"written": False, "code": "not_private_scope"})

    def test_symlink_diary_is_refused_without_following_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            outside = root / "outside.md"
            outside.write_text("untouched", encoding="utf-8")
            (root / "DREAMS.md").symlink_to(outside)
            result = append_dream_diary_entry(workspace_dir=root, agent_id="main", narrative="No follow.")
            self.assertEqual(outside.read_text(encoding="utf-8"), "untouched")
        self.assertEqual(result, {"written": False, "code": "write_failed"})

    def test_untrusted_markers_and_duplicate_managed_blocks_are_not_written(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary).resolve()
            injected = append_dream_diary_entry(
                workspace_dir=workspace, agent_id="main",
                narrative=f"Untrusted {START_MARKER} content {END_MARKER}",
            )
            text = (workspace / "DREAMS.md").read_text(encoding="utf-8")
            self.assertEqual(text.count(START_MARKER), 1)
            self.assertEqual(text.count(END_MARKER), 1)
            self.assertIn("plur1bus:untrusted-diary-marker", text)
            self.assertTrue(injected["written"])

            (workspace / "DREAMS.md").write_text(
                f"{START_MARKER}\n{END_MARKER}\n{START_MARKER}\n{END_MARKER}\n", encoding="utf-8"
            )
            rejected = append_dream_diary_entry(workspace_dir=workspace, agent_id="main", narrative="Second")
        self.assertEqual(rejected["code"], "invalid_managed_block")

    def test_workspace_root_rejects_a_symlinked_ancestor(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            outside = root / "outside"
            outside.mkdir()
            (root / "profiles").symlink_to(outside, target_is_directory=True)
            result = append_dream_diary_entry(
                workspace_dir=root / "profiles" / "main" / "workspace",
                workspace_root=root,
                agent_id="main",
                narrative="Do not traverse.",
            )
            self.assertFalse((outside / "main" / "workspace" / "DREAMS.md").exists())
        self.assertEqual(result, {"written": False, "code": "write_failed"})
