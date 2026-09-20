"""Verify the exact .61 delta without weakening historical parity gates."""
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
BASE = "bcb80ccef6ce5ab9e4604cfe923901885cc59d9e"
TARGET = "039329d0c74525448190b0bd2ec3ef3551ed168f"
HERMES_BASE = "34dfd2102a079ec818818aca39dba81134b69d2a"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


class Upstream761InventoryTests(unittest.TestCase):
    def test_release_ancestry_and_complete_inventory(self):
        subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)
        paths = git("diff", "--name-only", BASE, TARGET).splitlines()
        self.assertEqual(len(paths), 17)
        review = (ROOT / "docs/audits/hermes-7.12.61-delta-review.md").read_text()
        self.assertIn(TARGET, review)
        for path in paths:
            with self.subTest(path=path):
                self.assertIn("`" + path + "`", review)
                if path.startswith(("lib/", "tests/")) and path != "tests/release-750-compat.test.js":
                    self.assertEqual((ROOT / path).read_text(), git("show", "v7.15.0:" + path))

    def test_dependency_graph_matches_official_release(self):
        upstream = json.loads(git("show", "v7.15.0:package-lock.json"))
        current = json.loads((ROOT / "package-lock.json").read_text())
        current["version"] = upstream["version"]
        current["packages"][""]["version"] = upstream["packages"][""]["version"]
        self.assertEqual(current, upstream)

    def test_native_runtime_installers_and_ui_are_preserved(self):
        paths = git("ls-tree", "-r", "--name-only", HERMES_BASE, "plur1bus-hermes/src",
                    "plur1bus-controls/src", "hermes-dashboard/plur1bus", "distribution").splitlines()
        metadata = {"__init__.py", "plugin.yaml", "manifest.json", "README.md", "INSTALLATION.de.md", "ACCEPTANCE.md"}
        # Explicitly reviewed .69 behavior ports, covered by test_encoding_769.
        changed_769 = {"plur1bus-hermes/src/plur1bus_hermes/" + name for name in
                       ("domain.py", "dynamics.py", "runtime.py", "jobs.py", "llm_backend.py")}
        changed_715 = {"plur1bus-hermes/src/plur1bus_hermes/" + name for name in
                       ("migrate.py", "workspace_migrate.py")}
        for path in paths:
            if Path(path).name in metadata or path in changed_769 or path in changed_715:
                continue
            with self.subTest(path=path):
                # Compare canonical Git blobs, applying this checkout's clean
                # filters. Windows autocrlf changes working-tree bytes without
                # changing source; binary files remain byte-exact.
                expected = git("rev-parse", HERMES_BASE + ":" + path).strip()
                self.assertEqual(git("hash-object", "--path=" + path, path).strip(), expected)
