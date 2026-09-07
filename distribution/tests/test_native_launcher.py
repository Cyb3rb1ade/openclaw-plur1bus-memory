import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "native_launcher", Path(__file__).resolve().parents[1] / "native_launcher.py"
)
native_launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(native_launcher)


def write_pe(path, machine=0xAA64):
    """Create only the fixed PE fields inspected by the launcher preflight."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = bytearray(128)
    data[:2] = b"MZ"
    data[0x3C:0x40] = (64).to_bytes(4, "little")
    data[64:68] = b"PE\0\0"
    data[68:70] = machine.to_bytes(2, "little")
    path.write_bytes(data)


class NativeLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "Hermes Grüße"
        self.home.mkdir()
        (self.home / "config.yaml").write_text("memory: {}\n", encoding="utf-8")
        self.root = self.base / "hermes agent"
        (self.root / "hermes_cli").mkdir(parents=True)
        (self.root / "hermes_cli/main.py").write_text("# fixture\n", encoding="utf-8")
        self.python = self.root / "venv-arm64/Scripts/python.exe"
        self.desktop = self.root / "apps/desktop/release/win-arm64-unpacked/Hermes.exe"
        write_pe(self.python)
        write_pe(self.desktop)
        self.state = {"version": [3, 13], "venv": True, "platform": "win32", "machine": "ARM64",
                      "implementation": "cpython", "freeThreaded": False}

    def plan(self):
        with patch.object(native_launcher, "python_state", return_value=self.state):
            return native_launcher.plan(self.home, self.root, self.python, self.desktop, system="win32")

    def apply(self, value, confirmation=None):
        with patch.object(native_launcher, "python_state", return_value=self.state):
            return native_launcher.apply(value, value["confirmation"] if confirmation is None else confirmation, system="win32")

    def test_plan_and_confirmed_apply_are_home_bound_and_unicode_safe(self):
        value = self.plan()
        launcher = self.home / "bin/plur1bus-native-arm-desktop.cmd"
        self.assertEqual(value["launcher"], str(launcher.resolve()))
        self.assertFalse(launcher.exists())
        created = self.apply(value)
        self.assertEqual(created, launcher.resolve())
        content = launcher.read_bytes()
        self.assertFalse(content.startswith(b"\xff\xfe"))
        text = content.decode("utf-8")
        self.assertTrue(text.startswith("@echo off\r\nsetlocal DisableDelayedExpansion\r\n"))
        self.assertIn("for /f \"tokens=2 delims=:\" %%A in ('chcp')", text)
        self.assertIn("chcp %ORIGINAL_CODEPAGE% >nul", text)
        self.assertIn("endlocal & exit /b %START_ERRORLEVEL%", text)
        self.assertIn('HERMES_HOME=' + str(self.home.resolve()), text)
        self.assertIn('HERMES_DESKTOP_HERMES_ROOT=' + str(self.root.resolve()), text)
        self.assertIn('HERMES_DESKTOP_PYTHON=' + str(self.python.resolve()), text)
        self.assertIn('DESKTOP_EXE=' + str(self.desktop.resolve()), text)
        self.assertNotIn("PATH=", text)
        self.assertTrue((self.home / "plur1bus-native-arm-launcher.json").is_file())

    def test_wrong_architecture_and_non_windows_are_refused_before_writes(self):
        write_pe(self.desktop, machine=0x8664)
        with patch.object(native_launcher, "python_state", return_value=self.state), self.assertRaises(ValueError):
            native_launcher.plan(self.home, self.root, self.python, self.desktop, system="win32")
        write_pe(self.desktop)
        with patch.object(native_launcher, "python_state", return_value=self.state), self.assertRaises(ValueError):
            native_launcher.plan(self.home, self.root, self.python, self.desktop, system="linux")
        self.assertFalse((self.home / "bin").exists())

    def test_wrong_confirmation_and_stale_plan_do_not_write(self):
        value = self.plan()
        with self.assertRaises(ValueError):
            self.apply(value, "not-the-reviewed-confirmation")
        self.assertFalse((self.home / "bin").exists())
        marker = self.root / "hermes_cli/main.py"
        marker.write_text("# changed after review\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.apply(value)
        self.assertFalse((self.home / "bin").exists())

    def test_redirected_paths_and_unowned_conflicts_fail_closed(self):
        with patch.object(Path, "is_symlink", return_value=False), patch.object(
                Path, "lstat", return_value=SimpleNamespace(st_file_attributes=0x400)):
            self.assertTrue(native_launcher.redirected(self.home))
        with patch.object(native_launcher, "redirected", side_effect=lambda path: Path(path).name == "hermes agent"):
            with self.assertRaises(ValueError):
                self.plan()
        (self.home / "bin").mkdir()
        (self.home / "bin/plur1bus-native-arm-desktop.cmd").write_text("foreign", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.plan()

    def test_managed_update_retains_a_recoverable_backup(self):
        first = self.plan()
        self.apply(first)
        second = self.plan()
        self.assertEqual(second["previous"]["launcherSha256"], native_launcher.digest_file(
            self.home / "bin/plur1bus-native-arm-desktop.cmd"))
        self.apply(second)
        backups = list((self.home / "plur1bus-native-arm-launcher-backups").glob("*/launcher-before.cmd"))
        self.assertEqual(len(backups), 1)
        receipt = json.loads((self.home / "plur1bus-native-arm-launcher.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["backup"], str(backups[0].parent.resolve()))

    def test_concurrent_managed_receipt_change_and_partial_write_are_recovered(self):
        self.apply(self.plan())
        value = self.plan()
        launcher = self.home / "bin/plur1bus-native-arm-desktop.cmd"
        receipt = self.home / "plur1bus-native-arm-launcher.json"
        original_launcher, original_receipt = launcher.read_bytes(), receipt.read_bytes()
        record = json.loads(original_receipt)
        record["concurrentNote"] = "changed after plan"
        receipt.write_text(json.dumps(record), encoding="utf-8")
        with self.assertRaises(ValueError):
            self.apply(value)
        self.assertEqual(launcher.read_bytes(), original_launcher)

        value = self.plan()
        real_atomic = native_launcher._atomic
        failed = False

        def fail_receipt_once(path, data):
            nonlocal failed
            if Path(path).name == "plur1bus-native-arm-launcher.json" and not failed:
                failed = True
                raise OSError("simulated receipt disk failure")
            return real_atomic(path, data)

        with patch.object(native_launcher, "_atomic", side_effect=fail_receipt_once), self.assertRaises(OSError):
            self.apply(value)
        self.assertEqual(launcher.read_bytes(), original_launcher)
        self.assertEqual(receipt.read_text(encoding="utf-8"), json.dumps(record))

    def test_first_install_receipt_write_failure_leaves_no_orphan(self):
        value = self.plan()
        real_atomic = native_launcher._atomic

        def fail_receipt(path, data):
            if Path(path).name == "plur1bus-native-arm-launcher.json":
                raise OSError("simulated fresh receipt disk failure")
            return real_atomic(path, data)

        with patch.object(native_launcher, "_atomic", side_effect=fail_receipt), self.assertRaises(OSError):
            self.apply(value)
        self.assertFalse((self.home / "bin/plur1bus-native-arm-desktop.cmd").exists())
        self.assertFalse((self.home / "plur1bus-native-arm-launcher.json").exists())

    def test_python_preflight_has_a_timeout_and_build_copies_its_module(self):
        with patch.object(native_launcher.subprocess, "run", side_effect=subprocess.TimeoutExpired("python", 15)):
            with self.assertRaisesRegex(ValueError, "timed out"):
                native_launcher.python_state(self.python)
        build_source = (Path(__file__).resolve().parents[1] / "build.py").read_text(encoding="utf-8")
        self.assertIn('"native_launcher.py"', build_source)
