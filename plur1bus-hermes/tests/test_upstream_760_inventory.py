"""Account for every upstream .56–.60 path, not only changelog headlines."""
from pathlib import Path
import subprocess
import unittest

from test_upstream_7218_inventory import assert_active_upstream_file

ROOT = Path(__file__).resolve().parents[2]
BASE = "5d79fb91a907b13929e41523348b761a748e6c81"
TARGET = "bcb80ccef6ce5ab9e4604cfe923901885cc59d9e"


class Upstream760InventoryTests(unittest.TestCase):
    def test_official_source_is_an_ancestor(self):
        subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)

    def test_complete_delta_is_documented_and_runtime_retained(self):
        paths = subprocess.check_output(["git", "diff", "--name-only", BASE, TARGET], cwd=ROOT, text=True).splitlines()
        self.assertEqual(len(paths), 22)
        review = (ROOT / "docs/audits/hermes-7.12.60-delta-review.md").read_text(encoding="utf-8")
        self.assertIn(TARGET, review)
        for path in paths:
            with self.subTest(path=path):
                self.assertIn("`" + path + "`", review)
        whitespace_only = "tests/db-adapter-timeouts.test.js"
        historical = subprocess.check_output(["git", "show", TARGET + ":" + whitespace_only], cwd=ROOT, text=True)
        retained = subprocess.check_output(["git", "show", "v7.20.2:" + whitespace_only], cwd=ROOT, text=True)
        self.assertEqual(retained.rstrip(), historical.rstrip())
        for path in paths:
            if path.startswith(("lib/", "tests/")) or path == "index.js":
                with self.subTest(path=path):
                    assert_active_upstream_file(path)
