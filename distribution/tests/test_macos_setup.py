"""Native setup packaging and user-scope boundaries (no privileged postinstall)."""
import importlib.util
from pathlib import Path
import plistlib
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
            self.assertIn("Profile noch nicht", (root / "pkg-resources/conclusion.html").read_text())
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual([cmd[0] for cmd in commands], ["xcrun", "codesign", "pkgbuild", "productbuild"])
            self.assertNotIn("--scripts", commands[2])
            self.assertNotIn("--activate", str(commands))
            components = plistlib.loads((root / "components.plist").read_bytes())
            self.assertFalse(components[0]["BundleIsRelocatable"])

    def test_ui_uses_same_confirmed_backend_and_no_shell(self):
        source = (Path(packaging.__file__).parent / "macos/Setup.swift").read_text()
        for required in ("--inspect-profiles", "--confirm", "--runtimes-stopped", "--activate", "Alle vorhandenen Profile", "Nur Standardprofil", "guard let plan = plan, stopped, !busy"):
            self.assertIn(required, source)
        self.assertIn("process.arguments = arguments", source)
        self.assertIn('["-I", "-B", payload.appendingPathComponent', source)
        self.assertNotIn("/bin/sh", source)
        self.assertNotIn("sudo", source)

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

    def test_partial_signing_configuration_is_rejected_before_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "both Developer ID"):
                packaging.build_pkg(root, root, root / "pkg", "7.12.7-hermes.4", "app only")
            self.assertEqual(list(root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
