"""Pin the officially released .56 source and account for its exact delta."""
from pathlib import Path
import subprocess
import unittest

from test_upstream_7218_inventory import assert_active_upstream_file

ROOT = Path(__file__).resolve().parents[2]
BASE = "c53a289753ea0e5ab161bc67ee213eed2e145965"
TARGET = "5d79fb91a907b13929e41523348b761a748e6c81"


class Upstream756InventoryTests(unittest.TestCase):
    def test_official_upstream_release_is_retained_in_ancestry(self):
        subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)

    def test_complete_additional_delta_is_documented(self):
        paths = subprocess.check_output(["git", "diff", "--name-only", BASE, TARGET], cwd=ROOT, text=True).splitlines()
        self.assertEqual(len(paths), 9)
        review = (ROOT / "docs/audits/hermes-7.12.56-delta-review.md").read_text(encoding="utf-8")
        self.assertIn(TARGET, review)
        for path in paths:
            with self.subTest(path=path):
                self.assertIn("`" + path + "`", review)

    def test_accepted_upstream_runtime_fixes_match_exactly(self):
        files = ("lib/episodes.js", "tests/episodes-skip-episoded.test.js",
                 "lib/llm-router.js", "tests/llm-router.test.js")
        for path in files:
            with self.subTest(path=path):
                assert_active_upstream_file(path)
