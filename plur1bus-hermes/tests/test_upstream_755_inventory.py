"""Immutable coverage boundary for the complete recent upstream delta."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
BASE = "8a148c991123be31bc4f99376c8198447d9bb717"
TARGET = "c53a289753ea0e5ab161bc67ee213eed2e145965"


class Upstream755InventoryTests(unittest.TestCase):
    def test_current_upstream_is_retained_in_candidate_ancestry(self):
        subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)

    def test_all_recent_production_paths_are_documented(self):
        paths = subprocess.check_output(["git", "diff", "--name-only", BASE, TARGET], cwd=ROOT, text=True).splitlines()
        self.assertEqual(len(paths), 259)
        production = [path for path in paths if not path.startswith(("tests/", "test/"))]
        self.assertEqual(len(production), 21)
        review = (ROOT / "docs/audits/hermes-7.12.55-delta-review.md").read_text(encoding="utf-8")
        for path in production:
            with self.subTest(path=path):
                self.assertIn("`" + path + "`", review)
        self.assertIn(TARGET, review)
        count = subprocess.check_output(["git", "rev-list", "--count", BASE + ".." + TARGET], cwd=ROOT, text=True)
        self.assertEqual(int(count), 12)
