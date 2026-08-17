"""Hermes parity for the 7.4.0 restore-safe epistemic cutoff."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.epistemic import (
    ensure_epistemic_cutoff,
    is_created_at_before_cutoff,
    is_created_at_on_or_after_cutoff,
    read_epistemic_cutoff,
)


class EpistemicCutoffTests(unittest.TestCase):
    def test_absent_cutoff_reads_closed_without_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = read_epistemic_cutoff(Path(directory))
        self.assertFalse(state["ok"])
        self.assertEqual(state["reason"], "cutoff_absent")
        self.assertFalse(state["enabled"])

    def test_first_ensure_creates_both_markers_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            state = ensure_epistemic_cutoff(base, now=1_700_000_000_000)
            self.assertTrue(state["ok"])
            self.assertEqual(state["reason"], "created")
            self.assertEqual(state["since"], 1_700_000_000_000)
            payload = json.loads(
                (base / "_epistemic" / "explicit-write-since.json").read_text(encoding="utf-8")
            )
            self.assertEqual(payload["since"], 1_700_000_000_000)
            self.assertEqual(
                (base / "_epistemic" / "EXPLICIT_WRITES_ENABLED").read_text(encoding="utf-8"), "1\n",
            )

    def test_earliest_since_wins_across_upgrades(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            first = ensure_epistemic_cutoff(base, now=1_700_000_000_000)
            later = ensure_epistemic_cutoff(base, now=1_800_000_000_000)
        self.assertEqual(later["since"], first["since"])

    def test_enabled_marker_without_cutoff_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            marker_dir = base / "_epistemic"
            marker_dir.mkdir(parents=True)
            (marker_dir / "EXPLICIT_WRITES_ENABLED").write_text("1\n", encoding="utf-8")
            state = ensure_epistemic_cutoff(base)
            self.assertFalse(state["ok"])
            self.assertEqual(state["reason"], "cutoff_missing_after_upgrade")
            self.assertFalse(state["legacyOpen"])
            # Fail-closed: the missing cutoff is never recreated silently.
            self.assertFalse((marker_dir / "explicit-write-since.json").exists())

    def test_corrupt_cutoff_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            marker_dir = base / "_epistemic"
            marker_dir.mkdir(parents=True)
            (marker_dir / "explicit-write-since.json").write_text("{not json", encoding="utf-8")
            state = read_epistemic_cutoff(base)
            self.assertFalse(state["ok"])
            self.assertEqual(state["reason"], "cutoff_read_error")
            ensured = ensure_epistemic_cutoff(base)
            self.assertFalse(ensured["ok"])
            self.assertFalse(ensured["legacyOpen"])

    def test_invalid_payload_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            marker_dir = base / "_epistemic"
            marker_dir.mkdir(parents=True)
            (marker_dir / "explicit-write-since.json").write_text(
                json.dumps({"since": 0}), encoding="utf-8",
            )
            state = read_epistemic_cutoff(base)
        self.assertFalse(state["ok"])
        self.assertEqual(state["reason"], "cutoff_read_error")

    def test_legacy_window_boundaries(self) -> None:
        since = 1_700_000_000_000
        self.assertTrue(is_created_at_before_cutoff(since - 1, since))
        self.assertFalse(is_created_at_before_cutoff(since, since))
        self.assertTrue(is_created_at_on_or_after_cutoff(since, since))
        self.assertFalse(is_created_at_on_or_after_cutoff(since - 1, since))
        # Unknown bounds never classify (0 = no known bound, like expiresAt).
        self.assertFalse(is_created_at_before_cutoff(0, since))
        self.assertFalse(is_created_at_before_cutoff(since - 1, 0))
        self.assertFalse(is_created_at_before_cutoff(None, since))


if __name__ == "__main__":
    unittest.main()
