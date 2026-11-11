"""Exercise the real Swift setup model with a fake child and real PM discovery."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

@unittest.skipUnless(sys.platform == "darwin" and shutil.which("xcrun"), "requires native macOS Swift")
class SetupModelTests(unittest.TestCase):
    def test_consent_outcomes_and_retry_with_retired_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            home = root / "home"
            project = home / "hermes-agent"
            project.mkdir(parents=True)
            state = home / "installs" / hashlib.sha256(str(project).encode()).hexdigest()[:16]
            trusted = home / "tools" / "python"
            trusted.parent.mkdir(parents=True)
            trusted.write_text("#!/bin/sh\n")
            trusted.chmod(0o755)
            pythons = []
            for generation in ("old", "new"):
                venv = state / "environments" / generation / "venv"
                python = venv / "bin/python"
                python.parent.mkdir(parents=True)
                (venv / "pyvenv.cfg").write_text("version = 3.14\n")
                python.symlink_to(trusted)
                pythons.append(python)
            facts = state / "facts.json"
            facts.write_text(json.dumps({"packages": {"venv": {"environment": str(pythons[0].parent.parent)}}}))
            binary = root / "probe"
            sources = [ROOT / "macos" / (name + ".swift") for name in ("Setup", "HermesPython", "Localization", "InstallerRunner")]
            sources.append(ROOT / "tests/swift/SetupModelProbe.swift")
            subprocess.run(["xcrun", "swiftc", "-D", "SETUP_TESTING", *map(str, sources), "-o", str(binary)], check=True, capture_output=True)
            result = subprocess.run([str(binary), str(home), str(facts), *map(str, pythons)], capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("model lifecycle contracts passed", result.stdout)
