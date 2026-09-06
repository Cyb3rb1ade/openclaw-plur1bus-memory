import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("portable_installer", Path(__file__).resolve().parents[1] / "installer.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.bundle = self.root / "bundle with spaces"
        self.bundle.mkdir()
        self.home = self.root / "Hermes Home"
        self.home.mkdir()
        self.config = {"memory": {"provider": "builtin"}, "model": {"name": "unchanged"}, "plugins": {"enabled": ["other"], "disabled": ["plur1bus"]}}
        (self.home / "config.yaml").write_text(json.dumps(self.config))
        (self.home / "profiles/alpha").mkdir(parents=True)
        (self.home / "profiles/alpha/config.yaml").write_text(json.dumps(self.config))
        self.files = {
            "payload/plugins/plur1bus/__init__.py": b"new provider",
            "payload/plugins/plur1bus-controls/__init__.py": b"new controls",
            "payload/desktop-plugins/plur1bus/plugin.js": b"new UI",
            "wheels/plur1bus_hermes-1-py3-none-any.whl": b"fixture wheel",
            "wheels/plur1bus_controls-1-py3-none-any.whl": b"fixture wheel",
        }
        self.write_bundle()
        self.real_run = subprocess.run
        self.real_python = installer.run_python

    def write_bundle(self, version="7.12.0-hermes.2"):
        for name, data in self.files.items():
            path = self.bundle / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (self.bundle / "distribution.json").write_text(json.dumps({"schema": 1, "version": version, "pythonVersion": "7.12.0.post2",
            "files": {k: installer.digest(v) for k, v in self.files.items()}}))

    def fake_run(self, command, **kwargs):
        if "pip" in command:
            return subprocess.CompletedProcess(command, 0, "" if kwargs.get("text") else b"", "")
        return self.real_run(command, **kwargs)

    def fake_python(self, python, code, data=None):
        if code.startswith("import plur1bus_"):
            return ""
        if "sys.version_info" in code:
            return json.dumps({"version": [3, 12, 0], "venv": True, "prefix": str(self.root / "venv"), "platform": sys.platform})
        return self.real_python(python, code, data)

    def plan(self, **kwargs):
        with patch.object(installer.subprocess, "run", side_effect=self.fake_run), patch.object(installer, "run_python", side_effect=self.fake_python):
            return installer.plan_install(self.bundle, self.home, python=sys.executable, **kwargs)

    def apply(self, plan):
        with patch.object(installer.subprocess, "run", side_effect=self.fake_run), patch.object(installer, "run_python", side_effect=self.fake_python):
            return installer.apply_install(plan, plan["confirmation"], True)

    def test_readonly_plan_and_explicit_confirmation(self):
        plan = self.plan()
        self.assertFalse((self.home / "plugins").exists())
        with self.assertRaises(ValueError):
            installer.apply_install(plan, plan["confirmation"], False)
        with patch.object(installer.subprocess, "run", side_effect=self.fake_run), patch.object(installer, "run_python", side_effect=self.fake_python):
            with self.assertRaises(ValueError):
                installer.apply_install(plan, "wrong", True)
        self.assertFalse((self.home / "plur1bus-install-backups").exists())

    def test_install_activation_is_scoped_and_preserves_config(self):
        original_default = (self.home / "config.yaml").read_bytes()
        plan = self.plan(profiles=["alpha"], activate=True)
        transaction = self.apply(plan)
        config = installer.read_config(sys.executable, self.home / "profiles/alpha/config.yaml")
        self.assertEqual(config["memory"]["provider"], "plur1bus")
        self.assertEqual(config["model"], self.config["model"])
        self.assertIn("other", config["plugins"]["enabled"])
        self.assertNotIn("plur1bus", config["plugins"]["disabled"])
        self.assertEqual((self.home / "config.yaml").read_bytes(), original_default)
        self.assertFalse((self.home / "plugins").exists())
        receipt = json.loads((transaction / "journal.json").read_text())
        self.assertEqual(receipt["status"], "installed-restart-required")

    def test_no_activation_and_unknown_files_preserved(self):
        unknown = self.home / "plugins/plur1bus/config.json"
        unknown.parent.mkdir(parents=True)
        unknown.write_text('{"embedding":{"dimensions":1024}}')
        original = (self.home / "config.yaml").read_bytes()
        self.apply(self.plan(profiles=["all"]))
        self.assertEqual((self.home / "config.yaml").read_bytes(), original)
        self.assertIn("1024", unknown.read_text())
        self.assertTrue((self.home / "profiles/alpha/plugins/plur1bus/__init__.py").exists())

    def test_stale_config_or_payload_refused(self):
        plan = self.plan()
        (self.home / "config.yaml").write_text("memory: {}")
        with self.assertRaises(ValueError):
            self.apply(plan)
        (self.bundle / next(iter(self.files))).write_bytes(b"tampered")
        with self.assertRaises(ValueError):
            self.plan()
        self.assertFalse((self.home / "plugins").exists())

    def test_rollback_restores_files_and_retains_removed_files(self):
        target = self.home / "plugins/plur1bus/__init__.py"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"old")
        transaction = self.apply(self.plan())
        review = installer.rollback(self.home, transaction.name)
        result = installer.rollback(self.home, transaction.name, review["confirmation"], True)
        self.assertTrue(result["restored"])
        self.assertFalse(result["pipRollback"])
        self.assertEqual(target.read_bytes(), b"old")
        self.assertFalse((self.home / "desktop-plugins/plur1bus/plugin.js").exists())
        self.assertTrue((transaction / "removed/desktop-plugins/plur1bus/plugin.js").exists())

    def test_rollback_refuses_new_user_edits(self):
        transaction = self.apply(self.plan())
        (self.home / "plugins/plur1bus/__init__.py").write_bytes(b"user edit")
        with self.assertRaises(ValueError):
            installer.rollback(self.home, transaction.name)

    def test_obsolete_owned_files_are_retired_not_unknown_files(self):
        old = self.home / "plugins/plur1bus/obsolete.py"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"obsolete")
        (self.home / installer.RECEIPT).write_text(json.dumps({"version": "7.12.0-hermes.1", "files": {"plugins/plur1bus/obsolete.py": installer.digest(b"obsolete")}}))
        transaction = self.apply(self.plan())
        self.assertFalse(old.exists())
        self.assertEqual((transaction / "retired/plugins/plur1bus/obsolete.py").read_bytes(), b"obsolete")

    def test_desktop_only_does_not_need_python_or_touch_backend(self):
        original = (self.home / "config.yaml").read_bytes()
        plan = installer.plan_install(self.bundle, self.home, desktop_only=True)
        with patch.object(installer, "run_python", side_effect=AssertionError("no Python backend")):
            installer.apply_install(plan, plan["confirmation"], True)
        self.assertTrue((self.home / "desktop-plugins/plur1bus/plugin.js").exists())
        self.assertFalse((self.home / "plugins").exists())
        self.assertEqual((self.home / "config.yaml").read_bytes(), original)

    def test_paths_and_downgrades_are_refused(self):
        for value in ("../foreign", "/absolute", "C:/escape", "profiles\\escape"):
            with self.assertRaises(ValueError):
                installer.resolve_inside(self.home, value)
        (self.home / installer.RECEIPT).write_text(json.dumps({"version": "7.99.0", "files": {}}))
        with self.assertRaises(ValueError):
            self.plan()

    def test_duplicate_install_lock_refuses_without_removing_lock(self):
        plan = self.plan()
        lock = self.home / ".plur1bus-install-lock"
        lock.mkdir()
        with self.assertRaises(FileExistsError):
            self.apply(plan)
        self.assertTrue(lock.is_dir())

    def test_frozen_bundle_relocation_keeps_confirmation(self):
        first = self.plan()
        second = self.root / "other extraction"
        shutil.copytree(self.bundle, second)
        self.bundle = second
        self.assertEqual(first["confirmation"], self.plan()["confirmation"])

    def test_global_interpreter_is_refused(self):
        with patch.object(installer, "run_python", return_value=json.dumps({"version": [3, 12, 0], "venv": False, "platform": sys.platform})):
            with self.assertRaises(ValueError):
                installer.plan_install(self.bundle, self.home, python=sys.executable)

    def test_symlink_destination_is_refused(self):
        outside = self.root / "outside"
        outside.mkdir()
        try:
            (self.home / "plugins").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("OS denied creating the symlink fixture")
        with self.assertRaises(ValueError):
            self.plan()

    def test_new_pip_conflict_prevents_activation_and_keeps_journal(self):
        plan = self.plan(activate=True)
        original = (self.home / "config.yaml").read_bytes()
        checks = 0
        def conflict(command, **kwargs):
            nonlocal checks
            if "pip" in command and "check" in command:
                checks += 1
                if checks == 2:
                    return subprocess.CompletedProcess(command, 1, "new incompatible dependency\n", "")
            return self.fake_run(command, **kwargs)
        with patch.object(installer.subprocess, "run", side_effect=conflict), patch.object(installer, "run_python", side_effect=self.fake_python):
            with self.assertRaisesRegex(ValueError, "new dependency conflicts"):
                installer.apply_install(plan, plan["confirmation"], True)
        self.assertEqual((self.home / "config.yaml").read_bytes(), original)
        self.assertFalse((self.home / "plugins").exists())
        journal = next((self.home / "plur1bus-install-backups").glob("*/journal.json"))
        self.assertEqual(json.loads(journal.read_text())["status"], "failed-review-required")
        self.assertFalse((self.home / ".plur1bus-install-lock").exists())

    def test_invalid_manifest_fails_before_any_writes(self):
        (self.bundle / "distribution.json").write_text("[]")
        with self.assertRaises(ValueError):
            self.plan()
        self.assertFalse((self.home / "plugins").exists())
