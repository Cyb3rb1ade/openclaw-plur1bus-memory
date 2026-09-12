import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
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
