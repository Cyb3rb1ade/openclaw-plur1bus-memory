"""Native setup packaging and user-scope boundaries (no privileged postinstall)."""
import importlib.util
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location("macos_pkg", Path(__file__).resolve().parents[1] / "macos_pkg.py")
packaging = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packaging)


class MacSetupTests(unittest.TestCase):
    def test_pkg_has_real_app_and_explicit_second_step_without_root_profile_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "bundle"
            bundle.mkdir()
            (bundle / "distribution.json").write_text('{"fixture":true}')
            with patch.object(packaging.subprocess, "run") as run:
                app = packaging.build_pkg(bundle, root, root / "candidate.pkg", "7.12.7-hermes.3")
            info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
            self.assertEqual(info["CFBundleExecutable"], "PLUR1BUSSetup")
            self.assertTrue((app / "Contents/Resources/distribution/distribution.json").is_file())
            xml = ET.parse(root / "Distribution.xml").getroot()
            self.assertEqual(xml.find("options").attrib["hostArchitectures"], "arm64")
            self.assertEqual(xml.find("options").attrib["require-scripts"], "false")
            self.assertIn("profiles are not set up yet", (root / "pkg-resources/conclusion.html").read_text())
            self.assertIn("Profile noch nicht", (root / "pkg-resources/de.lproj/conclusion.html").read_text())
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual([cmd[0] for cmd in commands], ["xcrun", "codesign", "pkgbuild", "productbuild"])
            self.assertNotIn("--scripts", commands[2])
            self.assertNotIn("--activate", str(commands))
            components = plistlib.loads((root / "components.plist").read_bytes())
            self.assertFalse(components[0]["BundleIsRelocatable"])

    def test_signed_build_seals_app_before_signing_product(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "bundle"
            bundle.mkdir()
            with patch.object(packaging.subprocess, "run") as run:
                app = packaging.build_pkg(bundle, root, root / "signed.pkg", "7.12.7-hermes.4", "Developer ID Application: QA", "Developer ID Installer: QA")
            commands = [call.args[0] for call in run.call_args_list]
            self.assertIn("runtime", commands[1])
            self.assertIn("--timestamp", commands[1])
            self.assertIn("Developer ID Application: QA", commands[1])
            self.assertIn("Developer ID Installer: QA", commands[-1])
            self.assertIn("--timestamp", commands[-1])
            info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
            self.assertEqual(info["CFBundleVersion"], "7.12.7")
            self.assertEqual(info["PLUR1BUSReleaseVersion"], "7.12.7-hermes.4")

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("xcrun"), "requires native macOS Swift")
    def test_fresh_pm_home_selects_its_trusted_venv_without_legacy_python(self):
        source = Path(packaging.__file__).parent / "macos/HermesPython.swift"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            test = root / "probe.swift"
            test.write_text("""
import Foundation
@main struct Probe {
    static func main() {
        do { print(try discoverHermesPython(home: CommandLine.arguments[1]) ?? "missing") }
        catch { print("refused"); exit(4) }
    }
}
""")
            probe = root / "probe"
            subprocess.run(["xcrun", "swiftc", str(source), str(source.with_name("Localization.swift")), str(test), "-o", str(probe)], check=True, capture_output=True)
            home = root / "Hermes Home"
            project = home / "hermes-agent"
            project.mkdir(parents=True)
            key = hashlib.sha256(str(project).encode()).hexdigest()[:16]
            state = home / "installs" / key
            generation = state / "environments" / "fresh-generation" / "venv"
            python = generation / "bin/python"
            python.parent.mkdir(parents=True)
            (generation / "pyvenv.cfg").write_text("version = 3.14.9\n")
            facts = state / "facts.json"
            facts.write_text(json.dumps({"packages": {"venv": {"environment": str(generation)}}}))
            trusted = home / "tools" / "managed-python"
            trusted.parent.mkdir()
            trusted.write_text("#!/bin/sh\n")
            trusted.chmod(0o755)
            python.symlink_to(trusted)
            result = subprocess.run([str(probe), str(home)], check=True, capture_output=True, text=True)
            self.assertEqual(result.stdout.strip(), str(python))

            python.unlink()
            python.symlink_to("/bin/sh")
            result = subprocess.run([str(probe), str(home)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 4)
            self.assertEqual(result.stdout.strip(), "refused")

            facts.unlink()
            legacy = project / "venv/bin/python"
            legacy.parent.mkdir(parents=True)
            legacy.symlink_to("/bin/sh")
            result = subprocess.run([str(probe), str(home)], check=True, capture_output=True, text=True)
            self.assertEqual(result.stdout.strip(), str(legacy))

    def test_partial_signing_configuration_is_rejected_before_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "both Developer ID"):
                packaging.build_pkg(root, root, root / "pkg", "7.12.7-hermes.4", "app only")
            self.assertEqual(list(root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
