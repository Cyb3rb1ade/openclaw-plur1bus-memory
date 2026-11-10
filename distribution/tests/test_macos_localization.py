"""Exercise Foundation's language selection against the packaged app resources."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("localized_macos_pkg", ROOT / "macos_pkg.py")
packaging = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packaging)


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("xcrun"), "requires native macOS Foundation")
class MacLocalizationTests(unittest.TestCase):
    def test_system_language_selection_and_english_fallback_in_packaged_app(self):
        with tempfile.TemporaryDirectory(prefix="plur1bus-language-") as temporary:
            root = Path(temporary)
            bundle = root / "payload"
            bundle.mkdir()
            with patch.object(packaging.subprocess, "run"):
                app = packaging.build_app(bundle, root, "7.19.3-hermes.1")
            probe = root / "main.swift"
            probe.write_text('''
import Foundation
let title = setupText("Set up PLUR1BUS for Hermes")
let progress = setupText("Hermes is setting up profile %@ (%ld of %ld) …", "coder", 2, 7)
let fallback = setupText("Untranslated English message")
let output = try JSONSerialization.data(withJSONObject: ["title": title, "progress": progress, "fallback": fallback])
print(String(data: output, encoding: .utf8)!)
''', encoding="utf-8")
            executable = app / "Contents/MacOS/PLUR1BUSSetup"
            subprocess.run(["xcrun", "swiftc", str(ROOT / "macos/Localization.swift"), str(probe),
                            "-o", str(executable)], check=True, capture_output=True)
            cases = [
                ("de", "PLUR1BUS für Hermes einrichten", "Hermes richtet Profil coder ein (2 von 7) …"),
                ("de-DE", "PLUR1BUS für Hermes einrichten", "Hermes richtet Profil coder ein (2 von 7) …"),
                ("en", "Set up PLUR1BUS for Hermes", "Hermes is setting up profile coder (2 of 7) …"),
                ("en-GB", "Set up PLUR1BUS for Hermes", "Hermes is setting up profile coder (2 of 7) …"),
                ("fr", "Set up PLUR1BUS for Hermes", "Hermes is setting up profile coder (2 of 7) …"),
            ]
            for language, title, progress in cases:
                with self.subTest(language=language):
                    result = subprocess.run([str(executable), "-AppleLanguages", f"({language})"],
                                            check=True, capture_output=True, text=True)
                    self.assertEqual(json.loads(result.stdout), {"title": title, "progress": progress,
                                                               "fallback": "Untranslated English message"})


if __name__ == "__main__":
    unittest.main()
