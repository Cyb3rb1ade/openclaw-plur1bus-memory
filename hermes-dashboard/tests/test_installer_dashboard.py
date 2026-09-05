"""Exercise installer discovery layout/enablement in a temporary Hermes home."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class DashboardInstallerTests(unittest.TestCase):
    def test_opt_in_dashboard_copies_assets_and_enables_backend(self):
        repo = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            sandbox = Path(directory)
            home = sandbox / "hermes"
            home.mkdir()
            (home / "profiles").mkdir()
            (home / "config.yaml").write_text("model: {}\n", encoding="utf-8")
            binary = sandbox / "bin"
            binary.mkdir()
            (binary / "hermes").symlink_to(repo / "mtplx-embed/tests/fixtures/hermes")
            record = sandbox / "record"
            record.touch()
            env = {**os.environ, "HERMES_PYTHON": sys.executable,
                   "MTPLX_TEST_RECORD": str(record), "HOME": str(sandbox),
                   "PATH": str(binary) + os.pathsep + os.environ.get("PATH", ""),
                   "PYTHONPATH": str(repo / "plur1bus-hermes/src") + os.pathsep + str(repo / "plur1bus-controls/src")}
            result = subprocess.run([
                "bash", str(repo / "scripts/install-hermes-plugins.sh"),
                "--hermes-home", str(home), "--non-interactive", "--dashboard", "--no-deps", "--no-retrieval",
            ], env=env, text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            dashboard = home / "plugins/plur1bus/dashboard"
            self.assertTrue((dashboard / "manifest.json").is_file())
            self.assertTrue((dashboard / "dist/index.js").is_file())
            self.assertIn("hermes:plugins enable plur1bus\n", record.read_text())
            self.assertFalse((home / "dashboard-plugins").exists())
