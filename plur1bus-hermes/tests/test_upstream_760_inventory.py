"""Account for every upstream .56–.60 path, not only changelog headlines."""
from pathlib import Path
import subprocess
import unittest

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
        runtime = [path for path in paths if (path.startswith(("lib/", "tests/")) or path == "index.js") and path != whitespace_only]
        successor = "51c49a52ae001ed6ea5440e625bbf77ae2115af7"
        successor_paths = set(subprocess.check_output(
            ["git", "diff", "--name-only", TARGET, successor], cwd=ROOT, text=True).splitlines())
        for path in runtime:
            expected = successor if path in successor_paths else TARGET
            subprocess.run(["git", "diff", "--exit-code", expected, "--", path], cwd=ROOT, check=True)
        upstream = subprocess.check_output(["git", "show", TARGET + ":" + whitespace_only], cwd=ROOT, text=True)
        self.assertEqual((ROOT / whitespace_only).read_text().rstrip(), upstream.rstrip())
