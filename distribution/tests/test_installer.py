import importlib.util
import builtins
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import ModuleType, SimpleNamespace
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
            "payload/plugins/plur1bus/desktop/plugin.js": b"new UI",
            "payload/plugins/plur1bus-controls/__init__.py": b"new controls",
            "payload/desktop-plugins/plur1bus/plugin.js": b"new UI",
            "wheels/plur1bus_hermes-1-py3-none-any.whl": b"fixture wheel",
            "wheels/plur1bus_controls-1-py3-none-any.whl": b"fixture wheel",
        }
        self.write_bundle()
        self.real_run = subprocess.run
        self.real_python = installer.run_python

    @staticmethod
    def pm_python_path(environment):
        """Use Hermes PM's platform-specific venv interpreter location."""
        return environment / ("Scripts/python.exe" if installer.os.name == "nt" else "bin/python")

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

    def fake_python(self, python, code, data=None, timeout=None):
        if code.startswith("import plur1bus_"):
            return ""
        if "sys.version_info" in code:
            return json.dumps({"version": [3, 12, 0], "venv": True, "prefix": str(self.root / "venv"), "platform": sys.platform})
        return self.real_python(python, code, data, timeout=timeout)

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
        self.assertIs(config["memory"]["memory_enabled"], True)
        for relative in ("plugins/plur1bus/desktop/plugin.js", "desktop-plugins/plur1bus/plugin.js"):
            self.assertEqual((self.home / "profiles/alpha" / relative).read_bytes(), b"new UI")
            self.assertFalse((self.home / relative).exists())
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

    def test_coder_style_partial_activation_is_reported_and_repaired(self):
        partial = {"memory": {"provider": "plur1bus"}, "plugins": {"enabled": ["plur1bus-controls"]}, "model": "keep"}
        path = self.home / "profiles/alpha/config.yaml"
        path.write_text(json.dumps(partial))
        preview = self.plan(profiles=["alpha"])
        self.assertTrue(preview["profileStatus"]["alpha"]["inconsistent"])
        self.assertIn("--activate", preview["warnings"][0])
        self.assertEqual(json.loads(path.read_text()), partial)
        original_default = (self.home / "config.yaml").read_bytes()
        plan = self.plan(profiles=["alpha"], activate=True)
        self.assertEqual(plan["warnings"], [])
        self.apply(plan)
        config = installer.read_config(sys.executable, path)
        self.assertTrue(installer.activation_status(config)["active"])
        self.assertEqual(config["model"], "keep")
        self.assertEqual((self.home / "config.yaml").read_bytes(), original_default)

    def test_all_activation_includes_every_existing_profile(self):
        plan = self.plan(profiles=["all"], activate=True)
        self.assertEqual(plan["profiles"], ["alpha", "default"])
        self.apply(plan)
        inventory = installer.inspect_profiles(self.home, sys.executable)
        self.assertTrue(all(row["active"] for row in inventory["profiles"]))
        (self.home / "profiles/later").mkdir()
        (self.home / "profiles/later/config.yaml").write_text(json.dumps(self.config))
        self.assertFalse((self.home / "profiles/later/plugins").exists())

    def test_disabled_memory_is_reported_and_only_repaired_with_activation(self):
        partial = {"memory": {"provider": "plur1bus", "memory_enabled": False, "user_profile_enabled": False},
                   "plugins": {"enabled": ["other", "plur1bus", "plur1bus-controls"]}}
        path = self.home / "profiles/alpha/config.yaml"
        path.write_text(json.dumps(partial))
        original = path.read_bytes()
        preview = self.plan(profiles=["alpha"])
        self.assertFalse(preview["profileStatus"]["alpha"]["active"])
        self.assertFalse(preview["profileStatus"]["alpha"]["memoryEnabled"])
        self.assertTrue(preview["profileStatus"]["alpha"]["inconsistent"])
        self.apply(preview)
        self.assertEqual(path.read_bytes(), original)
        transaction = self.apply(self.plan(profiles=["alpha"], activate=True))
        config = installer.read_config(sys.executable, path)
        self.assertIs(config["memory"]["memory_enabled"], True)
        self.assertIs(config["memory"]["user_profile_enabled"], False)
        review = installer.rollback(self.home, transaction.name)
        installer.rollback(self.home, transaction.name, review["confirmation"], True)
        self.assertEqual(path.read_bytes(), original)

    def test_profile_inventory_is_readonly_and_does_not_leak_config(self):
        config = dict(self.config, api_key="SECRET-DO-NOT-OUTPUT")
        (self.home / "config.yaml").write_text(json.dumps(config))
        before = sorted(str(p) for p in self.home.rglob("*"))
        inventory = installer.inspect_profiles(self.home, sys.executable)
        self.assertEqual([p["name"] for p in inventory["profiles"]], ["alpha", "default"])
        self.assertNotIn("SECRET", json.dumps(inventory))
        self.assertEqual(sorted(str(p) for p in self.home.rglob("*")), before)

    def test_explicit_disable_wins_in_activation_status(self):
        config = {"memory": {"provider": "plur1bus"}, "plugins": {
            "enabled": ["plur1bus", "plur1bus-controls"], "disabled": ["plur1bus"]}}
        status = installer.activation_status(config)
        self.assertFalse(status["active"])
        self.assertTrue(status["inconsistent"])
        self.assertEqual(status["missingPlugins"], ["plur1bus"])

    def test_gui_inventory_rejects_install_action(self):
        with patch.object(sys, "argv", ["installer.py", "--inspect-profiles", "--home", str(self.home), "--apply"]):
            self.assertEqual(installer.main(), 4)
        self.assertFalse((self.home / "plugins").exists())

    def test_guided_defaults_select_all_and_activation_but_do_not_apply_without_confirmation(self):
        result = {"profiles": ["alpha", "default"], "activate": True, "confirmation": "hash"}
        with patch.object(sys, "argv", ["installer.py", "--interactive"]), \
             patch.object(sys.stdin, "isatty", return_value=True), \
             patch("builtins.input", side_effect=[str(self.home), "", "", str(sys.executable), "install", "", ""]), \
             patch.object(installer, "plan_install", return_value=result) as plan, \
             patch.object(installer, "apply_install") as apply:
            self.assertEqual(installer.main(), 0)
            self.assertEqual(plan.call_args.args[2], ["all"])
            self.assertTrue(plan.call_args.args[4])
            apply.assert_not_called()

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
        self.assertFalse((self.home / "plugins/plur1bus/desktop/plugin.js").exists())
        self.assertTrue((transaction / "removed/plugins/plur1bus/desktop/plugin.js").exists())

    def test_unified_desktop_upgrade_and_rollback_preserve_local_state(self):
        target = self.home / "profiles/alpha/plugins/plur1bus/desktop/plugin.js"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"old UI")
        local = target.parent / "preferences.json"
        local.write_bytes(b"user preferences")
        transaction = self.apply(self.plan(profiles=["alpha"]))
        self.assertEqual(target.read_bytes(), b"new UI")
        self.assertEqual(local.read_bytes(), b"user preferences")
        review = installer.rollback(self.home, transaction.name)
        installer.rollback(self.home, transaction.name, review["confirmation"], True)
        self.assertEqual(target.read_bytes(), b"old UI")
        self.assertEqual(local.read_bytes(), b"user preferences")

    def test_unified_desktop_symlink_is_refused_before_writes(self):
        target = self.home / "profiles/alpha/plugins/plur1bus/desktop"
        target.parent.mkdir(parents=True)
        outside = self.root / "outside"
        outside.mkdir()
        try:
            target.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            self.skipTest(str(error))
        with self.assertRaisesRegex(ValueError, "symbolic links/junctions"):
            self.plan(profiles=["alpha"])
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse((self.home / "plur1bus-install-backups").exists())

    def test_named_profile_updates_shared_root_ui_and_receipt_with_rollback(self):
        ui_paths = ("plugins/plur1bus/desktop/plugin.js", "desktop-plugins/plur1bus/plugin.js")
        for relative in ui_paths:
            target = self.home / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"old UI")
        source_mtime = (self.home / ui_paths[0]).stat().st_mtime_ns
        backend = self.home / "plugins/plur1bus/__init__.py"
        backend.write_bytes(b"old default backend")
        marker = self.home / "desktop-plugins/plur1bus/.hermes-package.json"
        marker.write_text('{"source":"preserve existing host marker"}')
        receipt_path = self.home / installer.RECEIPT
        original_receipt = json.dumps({"version": "7.12.0-hermes.1", "files": {
            **{relative: installer.digest(b"old UI") for relative in ui_paths},
            "plugins/plur1bus/__init__.py": installer.digest(backend.read_bytes())}}).encode()
        receipt_path.write_bytes(original_receipt)
        config_before = (self.home / "config.yaml").read_bytes()
        plan = self.plan(profiles=["alpha"], activate=True)
        self.assertEqual(set(plan["sharedDesktop"]), {*ui_paths, installer.RECEIPT, installer.SHARED_DESKTOP_RECEIPT,
                                                     "desktop-plugins/plur1bus/.hermes-package.json"})
        self.assertIsNone(plan["sharedDesktop"]["desktop-plugins/plur1bus/.hermes-package.json"]["after"])
        transaction = self.apply(plan)
        for relative in ui_paths:
            self.assertEqual((self.home / relative).read_bytes(), b"new UI")
        receipt = json.loads(receipt_path.read_bytes())
        self.assertEqual(receipt["version"], "7.12.0-hermes.1")
        self.assertTrue(all(receipt["files"][relative] == installer.digest(b"new UI") for relative in ui_paths))
        self.assertEqual(backend.read_bytes(), b"old default backend")
        self.assertEqual((self.home / "config.yaml").read_bytes(), config_before)
        self.assertFalse(marker.exists())
        self.assertEqual((transaction / "retired/desktop-plugins/plur1bus/.hermes-package.json").read_text(),
                         '{"source":"preserve existing host marker"}')
        review = installer.rollback(self.home, transaction.name)
        installer.rollback(self.home, transaction.name, review["confirmation"], True)
        self.assertEqual(receipt_path.read_bytes(), original_receipt)
        for relative in ui_paths:
            self.assertEqual((self.home / relative).read_bytes(), b"old UI")
        self.assertEqual(marker.read_text(), '{"source":"preserve existing host marker"}')
        self.assertEqual((self.home / ui_paths[0]).stat().st_mtime_ns, source_mtime)

    def test_named_profile_refreshes_existing_unified_ui_without_creating_root_desktop(self):
        target = self.home / "plugins/plur1bus/desktop/plugin.js"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"old UI")
        plan = self.plan(profiles=["alpha"])
        self.assertEqual(set(plan["sharedDesktop"]), {"plugins/plur1bus/desktop/plugin.js", installer.SHARED_DESKTOP_RECEIPT})
        self.apply(plan)
        self.assertEqual(target.read_bytes(), b"new UI")
        self.assertFalse((self.home / "desktop-plugins").exists())
        self.assertFalse((self.home / "plugins/plur1bus/__init__.py").exists())

    def test_shared_root_ui_is_bound_to_plan_and_symlinks_fail_before_writes(self):
        target = self.home / "desktop-plugins/plur1bus/plugin.js"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"old UI")
        plan = self.plan(profiles=["alpha"])
        target.write_bytes(b"manual edit after review")
        with self.assertRaisesRegex(ValueError, "stale plan"):
            self.apply(plan)
        self.assertFalse((self.home / "profiles/alpha/plugins").exists())
        outside = self.root / "outside UI.js"
        outside.write_bytes(b"preserve")
        target.unlink()
        try:
            target.symlink_to(outside)
        except OSError as error:
            self.skipTest(str(error))
        with self.assertRaisesRegex(ValueError, "symbolic links/junctions"):
            self.plan(profiles=["alpha"])
        self.assertEqual(outside.read_bytes(), b"preserve")

    def test_shared_root_ui_cannot_downgrade_a_newer_installation(self):
        target = self.home / "desktop-plugins/plur1bus/plugin.js"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"newer UI")
        (self.home / installer.RECEIPT).write_text(json.dumps({"version": "7.99.0-hermes.0", "files": {
            "desktop-plugins/plur1bus/plugin.js": installer.digest(b"newer UI")}}))
        with self.assertRaisesRegex(ValueError, "shared desktop downgrade"):
            self.plan(profiles=["alpha"])
        self.assertEqual(target.read_bytes(), b"newer UI")

    def test_shared_ui_version_blocks_older_bundle_for_a_different_profile_and_rolls_back(self):
        target = self.home / "desktop-plugins/plur1bus/plugin.js"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"UI 47")
        receipt = self.home / installer.RECEIPT
        original_receipt = json.dumps({"version": "7.12.47-hermes.0", "files": {
            "desktop-plugins/plur1bus/plugin.js": installer.digest(b"UI 47")}}).encode()
        receipt.write_bytes(original_receipt)
        (self.home / "profiles/beta").mkdir()
        (self.home / "profiles/beta/config.yaml").write_text(json.dumps(self.config))
        self.write_bundle("7.12.55-hermes.0")
        transaction = self.apply(self.plan(profiles=["alpha"]))
        self.write_bundle("7.12.53-hermes.0")
        with self.assertRaisesRegex(ValueError, "shared desktop downgrade"):
            self.plan(profiles=["beta"])
        self.assertEqual(target.read_bytes(), b"new UI")
        self.assertEqual(json.loads(receipt.read_bytes())["version"], "7.12.47-hermes.0")
        self.assertFalse((self.home / "profiles/beta/plugins").exists())
        shared_receipt = self.home / installer.SHARED_DESKTOP_RECEIPT
        self.assertEqual(json.loads(shared_receipt.read_bytes())["version"], "7.12.55-hermes.0")
        review = installer.rollback(self.home, transaction.name)
        installer.rollback(self.home, transaction.name, review["confirmation"], True)
        self.assertEqual(target.read_bytes(), b"UI 47")
        self.assertEqual(receipt.read_bytes(), original_receipt)
        self.assertFalse(shared_receipt.exists())
        self.assertEqual(self.plan(profiles=["beta"])["version"], "7.12.53-hermes.0")

    def test_shared_ui_receipt_upgrade_rollback_restores_previous_metadata_bytes(self):
        self.write_bundle("7.12.53-hermes.0")
        self.apply(self.plan(profiles=["alpha"]))
        receipt = self.home / installer.SHARED_DESKTOP_RECEIPT
        original = receipt.read_bytes()
        self.write_bundle("7.12.55-hermes.0")
        transaction = self.apply(self.plan(profiles=["alpha"]))
        self.assertNotEqual(receipt.read_bytes(), original)
        review = installer.rollback(self.home, transaction.name)
        installer.rollback(self.home, transaction.name, review["confirmation"], True)
        self.assertEqual(receipt.read_bytes(), original)

    def test_legacy_named_ui_receipt_prevents_downgrade_without_shared_metadata(self):
        receipt = self.home / "profiles/alpha" / installer.RECEIPT
        receipt.write_text(json.dumps({"version": "7.12.55-hermes.0", "files": {
            "plugins/plur1bus/desktop/plugin.js": installer.digest(b"UI 55")}}))
        self.write_bundle("7.12.53-hermes.0")
        with self.assertRaisesRegex(ValueError, "shared desktop downgrade"):
            self.plan(profiles=["default"])
        self.assertFalse((self.home / "plugins").exists())

    def test_legacy_backend_only_receipt_does_not_invent_a_shared_ui_version(self):
        (self.home / "profiles/alpha" / installer.RECEIPT).write_text(json.dumps({
            "version": "7.99.0-hermes.0", "files": {"plugins/plur1bus/__init__.py": "legacy"}}))
        self.assertEqual(self.plan(profiles=["default"])["version"], "7.12.0-hermes.2")

    def test_shared_ui_metadata_is_bound_to_plan_and_symlinks_fail_closed(self):
        self.apply(self.plan())
        receipt = self.home / installer.SHARED_DESKTOP_RECEIPT
        plan = self.plan()
        previous = receipt.read_bytes()
        receipt.write_bytes(previous + b"\n")
        with self.assertRaisesRegex(ValueError, "stale plan"):
            self.apply(plan)
        outside = self.root / "outside-ui-receipt.json"
        outside.write_bytes(previous)
        receipt.unlink()
        try:
            receipt.symlink_to(outside)
        except OSError as error:
            self.skipTest(str(error))
        with self.assertRaisesRegex(ValueError, "symbolic links/junctions"):
            self.plan()
        self.assertEqual(outside.read_bytes(), previous)

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

    def test_default_interpreter_uses_committed_hermes_pm_generation(self):
        project = self.home / "hermes-agent"
        project.mkdir()
        key = installer.hashlib.sha256(str(project.resolve()).encode("utf-8")).hexdigest()[:16]
        selected = self.home / "installs" / key / "environments" / "generation-314"
        python = self.pm_python_path(selected)
        python.parent.mkdir(parents=True)
        (selected / "pyvenv.cfg").write_text("version = 3.14.0\n")
        python.write_text("#!/bin/sh\n")
        python.chmod(0o755)
        facts = self.home / "installs" / key / "facts.json"
        facts.parent.mkdir(parents=True, exist_ok=True)
        facts.write_text(json.dumps({"packages": {"venv": {"environment": str(selected)}}}))
        stale = self.pm_python_path(project / "venv")
        stale.parent.mkdir(parents=True)
        stale.write_text("#!/bin/sh\n")
        self.assertEqual(installer.interpreter(self.home), python)
        self.assertEqual(installer.pm_selected_environment(self.home), selected)

    def test_pm_interpreter_accepts_trusted_managed_runtime_symlink_without_resolving_invocation_path(self):
        project = self.home / "hermes-agent"
        project.mkdir()
        key = installer.hashlib.sha256(str(project.resolve()).encode("utf-8")).hexdigest()[:16]
        selected = self.home / "installs" / key / "environments" / "generation-314" / "venv"
        python = self.pm_python_path(selected)
        python.parent.mkdir(parents=True)
        (selected / "pyvenv.cfg").write_text("version = 3.14.0\n")
        runtime = self.home / "tools/python-3.14" / (
            "python.exe" if installer.os.name == "nt" else "bin/python3"
        )
        runtime.parent.mkdir(parents=True)
        runtime.write_text("#!/bin/sh\n")
        runtime.chmod(0o755)
        try:
            python.symlink_to(runtime)
        except OSError:
            self.skipTest("OS denied creating the PM venv executable symlink")
        facts = self.home / "installs" / key / "facts.json"
        facts.parent.mkdir(parents=True, exist_ok=True)
        facts.write_text(json.dumps({"packages": {"venv": {"environment": str(selected)}}}))

        self.assertTrue(python.is_symlink())
        self.assertEqual(installer.interpreter(self.home), python)
        self.assertNotEqual(installer.interpreter(self.home), python.resolve())

    def test_pm_interpreter_rejects_executable_symlink_outside_trusted_runtime_roots(self):
        project = self.home / "hermes-agent"
        project.mkdir()
        key = installer.hashlib.sha256(str(project.resolve()).encode("utf-8")).hexdigest()[:16]
        selected = self.home / "installs" / key / "environments" / "generation-314"
        python = self.pm_python_path(selected)
        python.parent.mkdir(parents=True)
        (selected / "pyvenv.cfg").write_text("version = 3.14.0\n")
        outside = self.root / "outside-python"
        outside.write_text("#!/bin/sh\n")
        outside.chmod(0o755)
        try:
            python.symlink_to(outside)
        except OSError:
            self.skipTest("OS denied creating the PM venv executable symlink")
        facts = self.home / "installs" / key / "facts.json"
        facts.parent.mkdir(parents=True, exist_ok=True)
        facts.write_text(json.dumps({"packages": {"venv": {"environment": str(selected)}}}))

        with self.assertRaisesRegex(ValueError, "trusted runtime roots"):
            installer.interpreter(self.home)

    def test_pm_import_guard_accepts_verified_generation_workspace_and_rejects_outside(self):
        selected = self.home / "installs/hash/environments/generation/venv"
        sources = selected.parent / "workspace/plugin-sources"
        hermes_source = sources / "plur1bus-unique"
        controls_source = sources / "plur1bus-controls-unique"
        hermes_source.mkdir(parents=True)
        controls_source.mkdir(parents=True)
        hermes_bytes = b"__version__ = '7.18.4.post0'\n"
        controls_bytes = b"__version__ = '7.18.4.post0'\n"
        (hermes_source / "__init__.py").write_bytes(hermes_bytes)
        (controls_source / "__init__.py").write_bytes(controls_bytes)
        expected = {
            "plur1bus": {"__init__.py": installer.digest(hermes_bytes)},
            "plur1bus-controls": {"__init__.py": installer.digest(controls_bytes)},
        }
        module_paths = {
            "plur1bus_hermes": str(hermes_source / "__init__.py"),
            "plur1bus_controls": str(controls_source / "__init__.py"),
        }
        installer.validate_pm_import_locations(self.home, selected, module_paths, expected)

        outside = self.root / "outside-plugin" / "__init__.py"
        outside.parent.mkdir()
        outside.write_bytes(hermes_bytes)
        module_paths["plur1bus_hermes"] = str(outside)
        with self.assertRaisesRegex(ValueError, "escaped its trusted runtime roots"):
            installer.validate_pm_import_locations(self.home, selected, module_paths, expected)

    def test_pm_selection_refuses_escape_or_missing_generation(self):
        project = self.home / "hermes-agent"
        project.mkdir()
        key = installer.hashlib.sha256(str(project.resolve()).encode("utf-8")).hexdigest()[:16]
        state = self.home / "installs" / key
        state.mkdir(parents=True)
        facts = state / "facts.json"
        facts.write_text(json.dumps({"packages": {"venv": {"environment": str(self.root / "outside")}}}))
        with self.assertRaisesRegex(ValueError, "outside its managed"):
            installer.pm_selected_environment(self.home)
        selected = state / "environments" / "missing"
        facts.write_text(json.dumps({"packages": {"venv": {"environment": str(selected)}}}))
        with self.assertRaisesRegex(ValueError, "selected environment is missing"):
            installer.pm_selected_environment(self.home)

    def test_pm_plan_uses_managed_generation_without_requiring_pip(self):
        project = self.home / "hermes-agent"
        project.mkdir()
        key = installer.hashlib.sha256(str(project.resolve()).encode("utf-8")).hexdigest()[:16]
        selected = self.home / "installs" / key / "environments" / "generation-314"
        python = self.pm_python_path(selected)
        python.parent.mkdir(parents=True)
        (selected / "pyvenv.cfg").write_text("version = 3.14.0\n")
        python.write_text("#!/bin/sh\n")
        python.chmod(0o755)
        facts = self.home / "installs" / key / "facts.json"
        facts.parent.mkdir(parents=True, exist_ok=True)
        facts.write_text(json.dumps({"packages": {"venv": {"environment": str(selected)}}}))
        self.files["payload/plugins/plur1bus/plugin.yaml"] = b"name: plur1bus\nversion: 7.18.4\n"
        self.write_bundle()

        def pm_python(_python, code, data=None, timeout=None):
            if "sys.version_info" in code:
                return json.dumps({"version": [3, 14, 0], "venv": True, "prefix": str(selected),
                                   "platform": sys.platform, "architecture": "AMD64",
                                   "implementation": "cpython", "freeThreaded": False})
            if "importlib.metadata.version('torch')" in code:
                return "null"
            if "packages = sorted" in code:
                return json.dumps({"fingerprint": "f" * 64, "pipAvailable": False,
                                   "ensurepipAvailable": False})
            if "yaml.safe_load" in code:
                text = data.decode() if isinstance(data, bytes) else data
                if text.lstrip().startswith("{"):
                    return json.dumps(json.loads(text))
                return json.dumps({"name": "plur1bus", "version": "7.18.4"})
            return self.real_python(_python, code, data, timeout=timeout)

        with patch.object(installer, "run_python", side_effect=pm_python), \
             patch.object(installer, "run_pm_inspection", return_value="[]"):
            plan = installer.plan_install(self.bundle, self.home)
        self.assertTrue(plan["pmManaged"])
        self.assertEqual(plan["python"], str(python))
        self.assertEqual(plan["torch"]["action"], "pm-managed")
        self.assertFalse(plan["bootstrapPip"])
        with patch.object(installer, "run_python", side_effect=pm_python), \
             patch.object(installer, "run_pm_inspection", return_value="[]"):
            with self.assertRaisesRegex(ValueError, "cannot override Hermes PM"):
                installer.plan_install(self.bundle, self.home, python=sys.executable)

    def test_yaml_helpers_fall_back_to_ruamel_when_only_pyyaml_is_missing(self):
        path = self.root / "ruamel-config.yaml"
        path.write_text("memory: {}\n", encoding="utf-8")
        observed = {"typ": None, "load": None, "dump": None, "sort": None}

        class SafeYaml:
            def __init__(self, typ):
                observed["typ"] = typ

            def load(self, text):
                observed["load"] = text
                return {"memory": {"provider": "builtin"}}

            def dump(self, data, stream):
                observed["dump"] = data
                observed["sort"] = self.sort_base_mapping_type_on_output
                stream.write('z:\n  nested:\n    flag: true\n    value: null\n  greeting: "Grüße 🌍"\na:\n- é\n')

        ruamel = ModuleType("ruamel")
        ruamel_yaml = ModuleType("ruamel.yaml")
        ruamel_yaml.YAML = SafeYaml
        ruamel.yaml = ruamel_yaml
        real_import = builtins.__import__

        def import_without_pyyaml(name, *args, **kwargs):
            if name == "yaml":
                raise ModuleNotFoundError("No module named yaml", name="yaml")
            return real_import(name, *args, **kwargs)

        def run_in_target(_python, code, data=None, timeout=None):
            namespace = {"__builtins__": dict(vars(builtins), __import__=import_without_pyyaml)}
            stdin = io.StringIO(data if isinstance(data, str) else "")
            stdout = io.StringIO()
            with patch.dict(sys.modules, {"ruamel": ruamel, "ruamel.yaml": ruamel_yaml}), \
                 patch("sys.stdin", stdin), patch("sys.stdout", stdout):
                exec(code, namespace)
            return stdout.getvalue()

        with patch.object(installer, "run_python", side_effect=run_in_target):
            config = installer.read_config("managed-python", path)
            ordered_config = {"z": {"nested": {"flag": True, "value": None}, "greeting": "Grüße 🌍"}, "a": ["é"]}
            serialized = installer.config_bytes("managed-python", ordered_config)
        self.assertEqual(config, {"memory": {"provider": "builtin"}})
        self.assertEqual(observed["typ"], "safe")
        self.assertEqual(observed["load"], "memory: {}\n")
        self.assertEqual(observed["dump"], ordered_config)
        self.assertIs(observed["sort"], False)
        self.assertEqual(serialized.decode(), 'z:\n  nested:\n    flag: true\n    value: null\n  greeting: "Grüße 🌍"\na:\n- é\n')

    def test_yaml_fallback_propagates_ruamel_parser_errors(self):
        path = self.root / "malformed-config.yaml"
        path.write_text("memory: [unterminated\n", encoding="utf-8")
        ruamel = ModuleType("ruamel")
        ruamel_yaml = ModuleType("ruamel.yaml")

        class SafeYaml:
            def __init__(self, typ):
                self.assert_safe = typ == "safe"

            def load(self, _text):
                raise ValueError("malformed yaml")

        ruamel_yaml.YAML = SafeYaml
        ruamel.yaml = ruamel_yaml
        real_import = builtins.__import__

        def import_without_pyyaml(name, *args, **kwargs):
            if name == "yaml":
                raise ModuleNotFoundError("No module named yaml", name="yaml")
            return real_import(name, *args, **kwargs)

        def run_in_target(_python, code, data=None, timeout=None):
            namespace = {"__builtins__": dict(vars(builtins), __import__=import_without_pyyaml)}
            with patch.dict(sys.modules, {"ruamel": ruamel, "ruamel.yaml": ruamel_yaml}), \
                 patch("sys.stdin", io.StringIO(data or "")), patch("sys.stdout", io.StringIO()):
                exec(code, namespace)
            return ""

        with patch.object(installer, "run_python", side_effect=run_in_target):
            with self.assertRaisesRegex(ValueError, "malformed yaml"):
                installer.read_config("managed-python", path)

    def test_yaml_fallback_does_not_mask_missing_yaml_dependency(self):
        path = self.root / "config.yaml"
        path.write_text("memory: {}\n", encoding="utf-8")
        real_import = builtins.__import__

        def import_with_broken_yaml(name, *args, **kwargs):
            if name == "yaml":
                raise ModuleNotFoundError("No module named optional_backend", name="optional_backend")
            return real_import(name, *args, **kwargs)

        def run_in_target(_python, code, data=None, timeout=None):
            namespace = {"__builtins__": dict(vars(builtins), __import__=import_with_broken_yaml)}
            with patch("sys.stdin", io.StringIO(data or "")), patch("sys.stdout", io.StringIO()):
                exec(code, namespace)
            return ""

        with patch.object(installer, "run_python", side_effect=run_in_target):
            with self.assertRaisesRegex(ModuleNotFoundError, "optional_backend"):
                installer.read_config("managed-python", path)

    def test_pm_managed_windows_arm64_is_refused_before_writes(self):
        project = self.home / "hermes-agent"
        project.mkdir()
        key = installer.hashlib.sha256(str(project.resolve()).encode("utf-8")).hexdigest()[:16]
        selected = self.home / "installs" / key / "environments" / "generation-313"
        python = self.pm_python_path(selected)
        python.parent.mkdir(parents=True)
        python.write_text("placeholder")
        python.chmod(0o755)
        (selected / "pyvenv.cfg").write_text("version = 3.13.0\n")
        facts = self.home / "installs" / key / "facts.json"
        facts.parent.mkdir(parents=True, exist_ok=True)
        facts.write_text(json.dumps({"packages": {"venv": {"environment": str(selected)}}}))
        original_config = (self.home / "config.yaml").read_bytes()

        def windows_arm_info(_python, code, data=None, timeout=None):
            if "sys.version_info" in code:
                return json.dumps({"version": [3, 13, 0], "venv": True, "prefix": str(selected),
                                   "platform": "win32", "architecture": "ARM64",
                                   "implementation": "cpython", "freeThreaded": False})
            return self.real_python(_python, code, data, timeout=timeout)

        with patch.object(installer.sys, "platform", "win32"), \
             patch.object(installer, "run_python", side_effect=windows_arm_info):
            with self.assertRaisesRegex(ValueError, "requires standard-ABI CPython 3.14"):
                installer.plan_install(self.bundle, self.home, activate=True)
        self.assertEqual((self.home / "config.yaml").read_bytes(), original_config)
        self.assertFalse((self.home / "plugins").exists())

    def test_pm_apply_admits_selection_without_direct_pip(self):
        project = self.home / "hermes-agent"
        project.mkdir()
        key = installer.hashlib.sha256(str(project.resolve()).encode("utf-8")).hexdigest()[:16]
        selected = self.home / "installs" / key / "environments" / "generation-314"
        python = self.pm_python_path(selected)
        python.parent.mkdir(parents=True)
        (selected / "pyvenv.cfg").write_text("version = 3.14.0\n")
        python.write_text("#!/bin/sh\n")
        python.chmod(0o755)
        facts = self.home / "installs" / key / "facts.json"
        facts.parent.mkdir(parents=True, exist_ok=True)
        facts.write_text(json.dumps({"packages": {"venv": {"environment": str(selected)}}}))
        old_plur1bus = self.home / "plugins/plur1bus"
        old_plur1bus.mkdir(parents=True)
        (old_plur1bus / "__init__.py").write_text("OLD_PROVIDER = True\n")
        (old_plur1bus / "plugin.yaml").write_text('{"name":"plur1bus","version":"7.12.0"}\n')
        (old_plur1bus / "pyproject.toml").write_text('[project]\nname="old-plur1bus-hermes"\nversion="7.12.0"\n')
        old_controls = self.home / "plugins/plur1bus-controls"
        old_controls.mkdir(parents=True)
        (old_controls / "__init__.py").write_text("OLD_CONTROLS = True\n")
        (old_controls / "plugin.yaml").write_text('{"name":"plur1bus-controls","version":"7.12.0"}\n')
        (old_controls / "pyproject.toml").write_text('[project]\nname="old-plur1bus-controls"\nversion="7.12.0"\n')
        self.files.update({
            "payload/plugins/plur1bus/plugin.yaml": b'{"name":"plur1bus","version":"7.18.4"}\n',
            "payload/plugins/plur1bus/pyproject.toml": b'[project]\nname="plur1bus-hermes"\nversion="7.18.4"\n',
            "payload/plugins/plur1bus-controls/plugin.yaml": b'{"name":"plur1bus-controls","version":"7.18.4"}\n',
            "payload/plugins/plur1bus-controls/pyproject.toml": b'[project]\nname="plur1bus-controls"\nversion="7.18.4"\n',
        })
        self.write_bundle("7.18.4-hermes.0")
        self._pm_native_bundle()

        def pm_python(_python, code, data=None, timeout=None):
            if "sys.version_info" in code:
                return json.dumps({"version": [3, 14, 0], "venv": True, "prefix": str(selected),
                                   "platform": "win32", "architecture": "ARM64",
                                   "implementation": "cpython", "freeThreaded": False})
            if "importlib.metadata.version('torch')" in code:
                return "null"
            if "packages = sorted" in code:
                return json.dumps({"fingerprint": "f" * 64, "pipAvailable": False,
                                   "ensurepipAvailable": False})
            if "'paths': {'plur1bus_hermes'" in code:
                sources = selected.parent / "workspace/plugin-sources"
                provider_identity = (self.home / "plugins/plur1bus").resolve()
                controls_identity = (self.home / "plugins/plur1bus-controls").resolve()
                provider_key = "plur1bus-" + installer.hashlib.sha256(str(provider_identity).encode()).hexdigest()[:16]
                controls_key = "plur1bus-controls-" + installer.hashlib.sha256(str(controls_identity).encode()).hexdigest()[:16]
                return json.dumps({
                    "version": ["7.12.0.post2", "7.12.0.post2"],
                    "paths": {
                        "plur1bus_hermes": str(sources / provider_key / "__init__.py"),
                        "plur1bus_controls": str(sources / controls_key / "__init__.py"),
                    },
                })
            if code.startswith("import plur1bus_"):
                return ""
            return self.real_python(_python, code, data, timeout=timeout)

        def read_json_or_yaml(_python, path):
            raw = path.read_text(encoding="utf-8")
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                if "name: plur1bus-controls" in raw:
                    return {"name": "plur1bus-controls", "version": "7.18.4"}
                return {"name": "plur1bus", "version": "7.18.4"}

        admissions = []
        fail_rollback_admission = False

        def admit(home, profile_home, enabled, disabled, expected_config):
            admissions.append((profile_home, enabled, disabled))
            if fail_rollback_admission and len(admissions) > 1:
                raise RuntimeError("private PM diagnostic must not enter journal")
            project_name = installer.tomllib.loads(
                (profile_home / "plugins/plur1bus/pyproject.toml").read_text()
            )["project"]["name"]
            if len(admissions) == 1:
                self.assertIn("-profile-", project_name)
            else:
                self.assertEqual(project_name, "old-plur1bus-hermes")
                self.assertIn("OLD_PROVIDER", (profile_home / "plugins/plur1bus/__init__.py").read_text())
            current = profile_home / "config.yaml"
            self.assertEqual(installer.digest(current.read_bytes()), expected_config)
            config = json.loads(current.read_text())
            config.setdefault("plugins", {})["enabled"] = enabled
            config["plugins"]["disabled"] = disabled
            current.write_text(json.dumps(config))
            sources = selected.parent / "workspace/plugin-sources"
            sources.mkdir(parents=True, exist_ok=True)
            for plugin_name in ("plur1bus", "plur1bus-controls"):
                identity = (profile_home / "plugins" / plugin_name).resolve()
                source_name = plugin_name + "-" + installer.hashlib.sha256(str(identity).encode()).hexdigest()[:16]
                if (sources / source_name).exists():
                    shutil.rmtree(sources / source_name)
                shutil.copytree(profile_home / "plugins" / plugin_name, sources / source_name)

        patches = (
            patch.object(installer, "run_python", side_effect=pm_python),
            patch.object(installer, "run_pm_inspection", return_value=json.dumps([
                {"plugins": str((self.home / "plugins").resolve()), "names": ["plur1bus"]}
            ])),
            patch.object(installer, "read_config", side_effect=read_json_or_yaml),
            patch.object(installer, "config_bytes", side_effect=lambda _python, config: json.dumps(config).encode()),
            patch.object(installer, "run_pm_selection", side_effect=admit),
            patch.object(installer.subprocess, "run", side_effect=self.fake_run),
        )
        with patch.object(installer.sys, "platform", "win32"), patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            plan = installer.plan_install(self.bundle, self.home, profiles=["default"], activate=True)
            transaction = installer.apply_install(plan, plan["confirmation"], True)
            cache_entries = plan["pmNativeCache"]
            receipt = json.loads((self.home / installer.RECEIPT).read_text())
            self.assertEqual(receipt["sharedFiles"], {entry["cache"]: entry["sha256"] for entry in cache_entries})
            journal = json.loads((transaction / "journal.json").read_text())
            for entry in cache_entries:
                self.assertEqual(journal["files"][entry["cache"]]["after"], entry["sha256"])
                self.assertEqual(installer.digest((self.home / entry["cache"]).read_bytes()), entry["sha256"])
            installed_project_name = installer.tomllib.loads(
                (self.home / "plugins/plur1bus/pyproject.toml").read_text()
            )["project"]["name"]
            config_after_install = json.loads((self.home / "config.yaml").read_text())
            self.assertEqual(config_after_install["memory"]["provider"], "plur1bus")
            self.assertTrue(installer.activation_status(config_after_install)["active"])
            self.assertFalse((transaction / "pip.log").exists())
            review = installer.rollback(self.home, transaction.name)
            rollback_result = installer.rollback(self.home, transaction.name, review["confirmation"], True)
            self.assertTrue(all((self.home / entry["cache"]).is_file() for entry in cache_entries))

        self.assertEqual(len(admissions), 2)
        self.assertEqual(admissions[0][0], self.home)
        self.assertIn("profile-", installed_project_name)
        self.assertTrue(rollback_result["restored"])
        self.assertIn("original-generation-identity-unverified", rollback_result["pmGenerationRecovery"])
        self.assertEqual(len(admissions), 2)
        self.assertEqual((self.home / "plugins/plur1bus/pyproject.toml").read_text(),
                         '[project]\nname="old-plur1bus-hermes"\nversion="7.12.0"\n')
        self.assertEqual((self.home / "config.yaml").read_text(), json.dumps(self.config))
        journal = json.loads((transaction / "journal.json").read_text())
        self.assertEqual(journal["status"], "files-restored-pm-selection-admitted")

        fail_rollback_admission = True
        admissions.clear()
        with patch.object(installer.sys, "platform", "win32"), patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            retry_plan = installer.plan_install(self.bundle, self.home, profiles=["default"], activate=True)
            retry_transaction = installer.apply_install(retry_plan, retry_plan["confirmation"], True)
            retry_review = installer.rollback(self.home, retry_transaction.name)
            failed_rollback = installer.rollback(self.home, retry_transaction.name,
                                                 retry_review["confirmation"], True)
        self.assertTrue(failed_rollback["repairRequired"])
        retry_journal = json.loads((retry_transaction / "journal.json").read_text())
        self.assertEqual(retry_journal["status"], "files-restored-pm-repair-required")
        self.assertNotIn("private PM diagnostic", json.dumps(retry_journal))

    def test_pm_project_names_are_profile_unique_and_keep_module_layout(self):
        template = (b'[project]\nname = "plur1bus-hermes"\nversion = "7.18.4"\n'
                    b'[tool.setuptools]\npackage-dir = {"plur1bus_hermes" = "."}\n')
        first = installer.pm_member_project_bytes(template, "plur1bus", self.home)
        second_home = self.home / "profiles/alpha"
        second_home.mkdir(parents=True, exist_ok=True)
        second = installer.pm_member_project_bytes(template, "plur1bus", second_home)
        first_project = installer.tomllib.loads(first.decode())["project"]
        second_project = installer.tomllib.loads(second.decode())["project"]
        self.assertNotEqual(first_project["name"], second_project["name"])
        self.assertEqual(first_project["version"], second_project["version"])
        self.assertIn(b'"plur1bus_hermes" = "."', first)

    def _pm_native_bundle(self):
        marker = "sys_platform == 'win32' and platform_machine == 'ARM64' and python_version >= '3.14' and python_version < '3.15'"
        lance = "payload/plugins/plur1bus/vendor/windows-arm64/lancedb-0.34.0-cp39-abi3-win_arm64.whl"
        arrow = "payload/plugins/plur1bus/vendor/windows-arm64/pyarrow-25.0.1-cp314-cp314-win_arm64.whl"
        project = ("[project]\nname = 'plur1bus-hermes'\nversion = '7.18.4'\ndependencies = ["
                   + json.dumps("pyarrow==25.0.1; " + marker) + "]\n\n[tool.uv.sources]\n"
                   + "lancedb = { path = 'vendor/windows-arm64/" + Path(lance).name + "', marker = \"" + marker + "\" }\n"
                   + "pyarrow = { path = 'vendor/windows-arm64/" + Path(arrow).name + "', marker = \"" + marker + "\" }\n")
        self.files.update({lance: b"approved lance wheel bytes", arrow: b"approved arrow wheel bytes",
                           "payload/plugins/plur1bus/pyproject.toml": project.encode(),
                           "payload/plugins/plur1bus/plugin.yaml": b'{"name":"plur1bus","version":"7.18.4"}\n',
                           "payload/plugins/plur1bus-controls/plugin.yaml": b'{"name":"plur1bus-controls","version":"7.18.4"}\n',
                           "payload/plugins/plur1bus-controls/pyproject.toml": b'[project]\nname="plur1bus-controls"\nversion="7.18.4"\n'})
        self.write_bundle("7.18.4-hermes.0")
        manifest_path = self.bundle / "distribution.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["pmNativeDependencies"] = {"win32/ARM64/cp314": [lance, arrow]}
        manifest_path.write_text(json.dumps(manifest))
        return lance, arrow, installer.verify_bundle(self.bundle)

    def test_pm_native_sources_share_content_addressed_urls_and_materialize_per_active_profile(self):
        _, _, manifest = self._pm_native_bundle()
        entries = installer.pm_native_cache_entries(self.home, self.bundle, manifest,
                                                     installer.pm_arm_native_wheels(self.bundle, manifest))
        for entry in entries:
            destination = installer.resolve_inside(self.home, entry["cache"])
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((self.bundle / entry["bundle"]).read_bytes())
        paths = installer.pm_native_source_paths(self.home, entries)
        self.assertTrue(all(Path(value).is_absolute() for value in paths.values()))
        rewritten = []
        for profile in (self.home, self.home / "profiles/alpha"):
            output = installer.pm_member_project_bytes(
                (self.bundle / "payload/plugins/plur1bus/pyproject.toml").read_bytes(),
                "plur1bus", profile, paths)
            project = installer.tomllib.loads(output.decode())
            rewritten.append(project)
        self.assertNotEqual(rewritten[0]["project"]["name"], rewritten[1]["project"]["name"])
        self.assertEqual(rewritten[0]["tool"]["uv"]["sources"], rewritten[1]["tool"]["uv"]["sources"])
        self.assertEqual({key: value["path"] for key, value in rewritten[0]["tool"]["uv"]["sources"].items()}, paths)
        # Hermes PM copies profile members into workspace/plugin-sources and preserves
        # absolute paths outside that generation; verify both materialized profiles.
        # Materialize the exact project bytes under PM's workspace/plugin-sources
        # layout, which preserves absolute source URLs outside the generation.
        workspace = self.home / "installs/fake/environments/workspace/plugin-sources"
        for profile, project_bytes in zip(("default", "alpha"), [
                installer.pm_member_project_bytes((self.bundle / "payload/plugins/plur1bus/pyproject.toml").read_bytes(),
                                                  "plur1bus", self.home, paths),
                installer.pm_member_project_bytes((self.bundle / "payload/plugins/plur1bus/pyproject.toml").read_bytes(),
                                                  "plur1bus", self.home / "profiles/alpha", paths)]):
            profile_home = self.home if profile == "default" else self.home / "profiles/alpha"
            identity = (profile_home / "plugins/plur1bus").resolve()
            member_key = "plur1bus-" + installer.hashlib.sha256(str(identity).encode()).hexdigest()[:16]
            folder = workspace / member_key
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "pyproject.toml").write_bytes(project_bytes)
        for profile in (self.home, self.home / "profiles/alpha"):
            config = {"plugins": {"enabled": ["plur1bus"], "disabled": []}}
            (profile / "config.yaml").write_text(json.dumps(config))
        environment = self.home / "installs/fake/environments/generation"
        environment.mkdir(parents=True, exist_ok=True)
        pm_members = [
            {"plugins": str((self.home / "plugins").resolve()), "names": ["plur1bus"]},
            {"plugins": str((self.home / "profiles/alpha/plugins").resolve()), "names": ["plur1bus"]},
        ]
        with patch.object(installer, "interpreter", return_value=sys.executable), \
             patch.object(installer, "run_pm_inspection", return_value=json.dumps(pm_members)):
            installer.verify_pm_native_cache(self.home, entries)
            installer.verify_pm_materialized_native_sources(self.home, environment, entries)

    def test_pm_native_cache_refuses_hash_mismatch_and_redirects(self):
        _, _, manifest = self._pm_native_bundle()
        relative = installer.pm_arm_native_wheels(self.bundle, manifest)
        entries = installer.pm_native_cache_entries(self.home, self.bundle, manifest, relative)
        target = installer.resolve_inside(self.home, entries[0]["cache"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"not approved")
        with self.assertRaisesRegex(ValueError, "cache collision"):
            installer.pm_native_cache_entries(self.home, self.bundle, manifest, relative)
        target.unlink()
        outside = self.root / "outside-wheel"
        outside.write_bytes((self.bundle / relative[0]).read_bytes())
        try:
            target.symlink_to(outside)
        except OSError:
            self.skipTest("OS denied creating the symlink fixture")
        with self.assertRaisesRegex(ValueError, "links/junctions"):
            installer.pm_native_cache_entries(self.home, self.bundle, manifest, relative)

    def test_content_addressed_cache_publication_never_replaces_existing_file(self):
        target = self.home / ".plur1bus-managed/native-wheels/new-cache.whl"
        target.parent.mkdir(parents=True)
        original = b"immutable existing bytes"
        target.write_bytes(original)
        self.assertFalse(installer.atomic_create_verified(target, original, installer.digest(original)))
        self.assertEqual(target.read_bytes(), original)
        with self.assertRaisesRegex(ValueError, "cache collision"):
            installer.atomic_create_verified(target, b"different bytes", installer.digest(b"different bytes"))
        self.assertEqual(target.read_bytes(), original)

    def test_pm_native_source_rewrite_is_exact_and_idempotent(self):
        _, _, manifest = self._pm_native_bundle()
        entries = installer.pm_native_cache_entries(self.home, self.bundle, manifest,
                                                     installer.pm_arm_native_wheels(self.bundle, manifest))
        paths = installer.pm_native_source_paths(self.home, entries)
        template = (self.bundle / "payload/plugins/plur1bus/pyproject.toml").read_bytes()
        first = installer.pm_member_project_bytes(template, "plur1bus", self.home, paths)
        second = installer.pm_member_project_bytes(first, "plur1bus", self.home, paths)
        self.assertEqual(first, second)
        apostrophe_home = self.root / "Hermes O'Neil 🐈"
        apostrophe_home.mkdir()
        quoted_paths = installer.pm_native_source_paths(apostrophe_home, entries)
        quoted = installer.pm_member_project_bytes(template, "plur1bus", apostrophe_home, quoted_paths)
        self.assertEqual(installer.tomllib.loads(quoted.decode())["tool"]["uv"]["sources"]["lancedb"]["path"],
                         quoted_paths["lancedb"])
        malformed = template + b"\n[tool.uv.sources.extra]\npath='unsafe.whl'\n"
        with self.assertRaisesRegex(ValueError, "source metadata"):
            installer.pm_member_project_bytes(malformed, "plur1bus", self.home, paths)
        with self.assertRaisesRegex(ValueError, "source metadata"):
            installer.pm_member_project_bytes(template.replace(b"pyarrow =", b"other ="), "plur1bus", self.home, paths)

    def test_default_only_guard_accepts_shared_sources_without_changing_unselected_profile(self):
        _, _, manifest = self._pm_native_bundle()
        entries = installer.pm_native_cache_entries(self.home, self.bundle, manifest,
                                                     installer.pm_arm_native_wheels(self.bundle, manifest))
        paths = installer.pm_native_source_paths(self.home, entries)
        profile = self.home / "profiles/alpha"
        config_bytes = json.dumps({"plugins": {"enabled": ["plur1bus"], "disabled": []}}).encode()
        (profile / "config.yaml").write_bytes(config_bytes)
        for relative, sha in manifest["files"].items():
            if relative.startswith("payload/"):
                short = relative[8:]
                if short.endswith(".py") or short in {
                        "plugins/plur1bus/plugin.yaml", "plugins/plur1bus-controls/plugin.yaml"}:
                    target = installer.resolve_inside(profile, short)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes((self.bundle / relative).read_bytes())
        project = self.bundle / "payload/plugins/plur1bus/pyproject.toml"
        (profile / "plugins/plur1bus/pyproject.toml").write_bytes(
            installer.pm_member_project_bytes(project.read_bytes(), "plur1bus", profile, paths))
        controls = self.bundle / "payload/plugins/plur1bus-controls/pyproject.toml"
        controls_target = profile / "plugins/plur1bus-controls/pyproject.toml"
        controls_target.parent.mkdir(parents=True, exist_ok=True)
        controls_target.write_bytes(installer.pm_member_project_bytes(controls.read_bytes(), "plur1bus-controls", profile))
        before = (profile / "config.yaml").read_bytes()
        pm_member = {"plugins": str((profile / "plugins").resolve()), "names": ["plur1bus"]}
        with patch.object(installer, "run_pm_inspection", return_value=json.dumps([pm_member])), \
             patch.object(installer, "read_config", side_effect=lambda _python, path: json.loads(path.read_text())):
            installer.check_unselected_pm_profiles(self.home, {"default"}, sys.executable,
                                                    self.bundle, manifest, "7.18.4", paths)
        self.assertEqual((profile / "config.yaml").read_bytes(), before)
        installed = (profile / "plugins/plur1bus/pyproject.toml").read_bytes()
        (profile / "plugins/plur1bus/pyproject.toml").write_bytes(
            installed.replace(paths["lancedb"].encode(), b"vendor/other.whl"))
        with patch.object(installer, "run_pm_inspection", return_value=json.dumps([pm_member])), \
             patch.object(installer, "read_config", side_effect=lambda _python, path: json.loads(path.read_text())):
            with self.assertRaisesRegex(ValueError, "noncanonical PM wheel sources"):
                installer.check_unselected_pm_profiles(self.home, {"default"}, sys.executable,
                                                        self.bundle, manifest, "7.18.4", paths)

    def test_pm_active_profiles_follow_provider_members_and_ignore_stale_directories(self):
        provider_home = self.home / "profiles/provider_only"
        stale = self.home / "profiles/.work.staging-123"
        tombstoned = self.home / "profiles/deleted"
        for path in (provider_home, stale, tombstoned):
            (path / "plugins").mkdir(parents=True)
            (path / "config.yaml").write_text(json.dumps({"memory": {"provider": "plur1bus"},
                                                           "plugins": {"enabled": [], "disabled": []}}))
        (stale / "plugins/plur1bus").mkdir()
        (tombstoned / "plugins/plur1bus").mkdir()
        # PM's dependency_homes()/enabled_plugins_ordered() filters staging and
        # tombstoned homes; provider-only selection still emits its PM member.
        rows = [{"plugins": str((provider_home / "plugins").resolve()), "names": ["plur1bus"]}]
        with patch.object(installer, "run_pm_inspection", return_value=json.dumps(rows)):
            self.assertEqual(installer.pm_active_member_profiles(self.home, sys.executable),
                             {"provider_only": provider_home.resolve()})

    def test_pm_inspection_binds_nondefault_home_despite_ambient_hermes_home(self):
        project = self.home / "hermes-agent"
        project.mkdir()
        expected = subprocess.CompletedProcess([], 0, stdout="[]", stderr="")
        with patch.dict(installer.os.environ, {"HERMES_HOME": str(self.root / "wrong-home")}), \
             patch.object(installer.subprocess, "run", return_value=expected) as run:
            result = installer.run_pm_inspection(self.home, sys.executable, "print('read only')")
        self.assertEqual(result, "[]")
        args, kwargs = run.call_args
        self.assertEqual(args[0][-1], str(project))
        self.assertIn("-I", args[0])
        self.assertIn("-B", args[0])
        self.assertEqual(kwargs["env"]["HERMES_HOME"], str(self.home))

    def test_rollback_retains_shared_pm_native_wheel_bytes(self):
        filename = "lancedb-0.34.0-cp39-abi3-win_arm64.whl"
        data = b"already referenced by a PM generation"
        relative = installer.pm_native_cache_path("7.18.4-hermes.0", installer.digest(data), filename)
        target = installer.resolve_inside(self.home, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        backup = self.home / "plur1bus-install-backups" / "wheel-retention"
        backup.mkdir(parents=True)
        config = self.home / "config.yaml"
        before_config = b'{"memory":{"provider":"builtin"},"plugins":{"enabled":[],"disabled":[]}}'
        after_config = b'{"memory":{"provider":"plur1bus"},"plugins":{"enabled":["plur1bus"],"disabled":[]}}'
        config.write_bytes(after_config)
        before_config_path = backup / "before/config.yaml"
        before_config_path.parent.mkdir(parents=True)
        before_config_path.write_bytes(before_config)
        (backup / "journal.json").write_text(json.dumps({
            "schema": 1, "home": str(self.home), "status": "failed-review-required",
            "files": {
                relative: {"before": None, "after": installer.digest(data)},
                "config.yaml": {"before": installer.digest(before_config), "after": installer.digest(after_config)},
            },
            "pmSelections": [{"profile": "default", "beforeEnabled": [], "beforeDisabled": [], "applied": True}],
        }))
        review = installer.rollback(self.home, backup.name)
        with patch.object(installer, "run_pm_selection", side_effect=RuntimeError("simulated partial PM rollback")):
            result = installer.rollback(self.home, backup.name, review["confirmation"], stopped=True)
        self.assertTrue(result["repairRequired"])
        self.assertEqual(target.read_bytes(), data)
        nested = "profiles/alpha/" + relative
        journal = json.loads((backup / "journal.json").read_text())
        journal["files"][nested] = {"before": None, "after": installer.digest(data)}
        (backup / "journal.json").write_text(json.dumps(journal))
        with self.assertRaisesRegex(ValueError, "rooted directly"):
            installer.rollback(self.home, backup.name)

    def test_symlink_destination_is_refused(self):
        outside = self.root / "outside"
        outside.mkdir()
        try:
            (self.home / "plugins").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("OS denied creating the symlink fixture")
        with self.assertRaises(ValueError):
            self.plan()

    def test_managed_plugin_bridge_path_is_allowed_but_external_path_is_not(self):
        managed = self.home / "plugins/plur1bus"
        managed.mkdir(parents=True)
        (managed / "__init__.py").write_text("", encoding="utf-8")
        self.assertTrue(installer.module_path_allowed(managed / "__init__.py", self.root / "venv", managed))
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "__init__.py").write_text("", encoding="utf-8")
        self.assertFalse(installer.module_path_allowed(outside / "__init__.py", self.root / "venv", managed))

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

    def test_retrieval_bridge_uses_selected_venv_profile_and_explicit_approval(self):
        target = self.root / "target.json"
        target.write_text('{"provider":"disabled"}')
        args = SimpleNamespace(home=str(self.home), bundle=str(self.bundle), profile=["alpha"], python=sys.executable,
                               desktop_only=False, rollback=None, activate=False, no_deps=False, apply=False,
                               retrieval_target=str(target), retrieval_kind="reranker", retrieval_action="plan",
                               confirm=None, runtimes_stopped=False)
        requests = []
        def bridge(python, code, data=None):
            self.assertEqual(str(python), sys.executable)
            if data is None:
                return json.dumps({"venv": True, "platform": sys.platform})
            self.assertIn("setup_retrieval", code)
            requests.append(json.loads(data))
            return '{"planned":true}'
        with patch.object(installer, "run_python", side_effect=bridge):
            self.assertTrue(installer.retrieval_command(args)["planned"])
            self.assertEqual(requests[0]["profile"], "alpha")
            args.retrieval_action = "activate"
            with self.assertRaises(ValueError):
                installer.retrieval_command(args)
            self.assertEqual(len(requests), 1)
            args.profile = ["all"]
            with self.assertRaises(ValueError):
                installer.retrieval_command(args)
