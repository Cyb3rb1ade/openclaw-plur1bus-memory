"""Supplemental regression gate for the exact 7.12.47 upstream target."""

from __future__ import annotations

import ast
import json
import subprocess
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
UPSTREAM_BASE = "c59366f637db5b636c2d822351018b88476f37fb"
UPSTREAM_HEAD = "8a148c991123be31bc4f99376c8198447d9bb717"
JS_VERSION = "7.12.55-hermes.0"
PYTHON_VERSION = "7.12.55"
CURRENT_UPSTREAM_HEAD = "c53a289753ea0e5ab161bc67ee213eed2e145965"
EXPECTED_CHANGED_FILES = {
    "CHANGELOG.md",
    "index.js",
    "lib/db-adapter.js",
    "lib/jobs/daily-consolidation.js",
    "lib/jobs/memory-dynamics-maintenance.js",
    "lib/lancedb-optimize.js",
    "openclaw.plugin.json",
    "package-lock.json",
    "package.json",
    "tests/daily-consolidation-decay-cursor.test.js",
    "tests/db-adapter-timeouts.test.js",
    "tests/decay-batch.test.js",
    "tests/lancedb-optimize.test.js",
    "tests/release-750-compat.test.js",
}


def git_output(*arguments: str) -> str:
    """Return text output from Git at the repository root."""
    return subprocess.check_output(["git", *arguments], cwd=ROOT, text=True)


def json_data(relative_path: str) -> dict[str, object]:
    """Load a repository JSON manifest."""
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


def project_version(relative_path: str) -> str:
    """Load the PEP 621 version from a Python project manifest."""
    with (ROOT / relative_path).open("rb") as handle:
        return str(tomllib.load(handle)["project"]["version"])


def plugin_version(relative_path: str) -> str:
    """Read the top-level version from the small Hermes plugin manifest."""
    for line in (ROOT / relative_path).read_text(encoding="utf-8").splitlines():
        if line.startswith("version:"):
            return line.partition(":")[2].strip()
    raise AssertionError(f"missing version in {relative_path}")


def module_version(relative_path: str) -> str:
    """Read a literal module ``__version__`` without importing runtime code."""
    tree = ast.parse((ROOT / relative_path).read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets):
            return str(ast.literal_eval(node.value))
    raise AssertionError(f"missing __version__ in {relative_path}")


class Upstream747InventoryTests(unittest.TestCase):
    def test_exact_upstream_pin_is_ancestor(self) -> None:
        """Require the immutable upstream target in the candidate ancestry."""
        result = subprocess.run(
            ["git", "merge-base", "--is-ancestor", UPSTREAM_HEAD, "HEAD"],
            cwd=ROOT,
            check=False,
        )
        self.assertEqual(result.returncode, 0)

    def test_incremental_inventory_has_exactly_fourteen_paths(self) -> None:
        """Keep the supplemental delta derived from the two upstream pins."""
        changed = set(
            git_output("diff", "--name-only", UPSTREAM_BASE, UPSTREAM_HEAD).splitlines()
        )
        self.assertEqual(changed, EXPECTED_CHANGED_FILES)
        self.assertEqual(len(changed), 14)

    def test_active_javascript_and_dashboard_versions_match_candidate(self) -> None:
        """Keep package, lockfile, plugin, and dashboard metadata coherent."""
        package = json_data("package.json")
        package_lock = json_data("package-lock.json")
        self.assertEqual(package["version"], JS_VERSION)
        self.assertEqual(package_lock["version"], JS_VERSION)
        self.assertEqual(package_lock["packages"][""]["version"], JS_VERSION)
        self.assertEqual(json_data("openclaw.plugin.json")["version"], JS_VERSION)
        self.assertEqual(
            json_data("hermes-dashboard/plur1bus/dashboard/manifest.json")["version"],
            JS_VERSION,
        )
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn(f"**PLUR1BUS {JS_VERSION}", readme)
        self.assertIn(f"`{CURRENT_UPSTREAM_HEAD}` while retaining the native Hermes", readme)

    def test_active_python_versions_match_candidate(self) -> None:
        """Keep both Python distributions and plugin manifests coherent."""
        self.assertEqual(project_version("plur1bus-hermes/pyproject.toml"), PYTHON_VERSION)
        self.assertEqual(project_version("plur1bus-controls/pyproject.toml"), PYTHON_VERSION)
        self.assertEqual(
            plugin_version("plur1bus-hermes/src/plur1bus_hermes/plugin.yaml"),
            PYTHON_VERSION,
        )
        self.assertEqual(
            plugin_version("plur1bus-controls/src/plur1bus_controls/plugin.yaml"),
            PYTHON_VERSION,
        )
        self.assertEqual(
            module_version("plur1bus-hermes/src/plur1bus_hermes/__init__.py"),
            PYTHON_VERSION,
        )
        self.assertEqual(
            module_version("plur1bus-controls/src/plur1bus_controls/__init__.py"),
            PYTHON_VERSION,
        )
        cli_source = (ROOT / "plur1bus-hermes/src/plur1bus_hermes/cli.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('"version": __version__', cli_source)


if __name__ == "__main__":
    unittest.main()
