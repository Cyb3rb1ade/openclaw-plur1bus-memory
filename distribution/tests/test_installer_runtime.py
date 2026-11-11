"""Lifecycle integration with the real installer transaction and temporary files."""
import json
import io
from pathlib import Path
import sys
from contextlib import redirect_stdout, redirect_stderr
import unittest
from unittest.mock import patch
from distribution.tests import test_installer as fixtures
installer = fixtures.installer
from distribution.runtime_lifecycle import RuntimeLifecycle


class RuntimeInstallerTests(unittest.TestCase):
    def setUp(self):
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        for context in (redirect_stdout(self.stdout), redirect_stderr(self.stderr)):
            context.__enter__()
            self.addCleanup(context.__exit__, None, None, None)
        self.fixture = fixtures.InstallerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        # File-only PM staging permits a verified rollback without pretending
        # that a legacy pip installation can roll its dependency graph back.
        self.fixture.files['payload/plugins/plur1bus/plugin.yaml'] = b'{"name":"plur1bus","version":"7.12.0"}'
        self.fixture.write_bundle()
        for context in (patch.object(installer.subprocess, 'run', side_effect=self.fixture.fake_run),
                        patch.object(installer, 'run_python', side_effect=self.fixture.fake_python),
                        patch.object(installer, 'torch_version', return_value=None),
                        patch.object(installer, 'environment_state', return_value={'fingerprint': 'fixture-venv', 'pipAvailable': True, 'ensurepipAvailable': True}),
                        patch.object(installer, 'pm_selected_environment', return_value=Path(sys.prefix)),
                        patch.object(installer, 'run_pm_inspection', return_value='[]'),
                        patch.object(installer, 'probe_macos_pm_sync'),
                        patch.object(installer, 'interpreter', return_value=Path(sys.executable))):
            context.start()
            self.addCleanup(context.stop)
        self.plan = self.fixture.plan(dependencies=False)
        self.actions, self.events = [], []
        self.entry = dict(pid=42, born=2.0, home=str(self.fixture.home), kind="manual", served_profiles=["default"])
        self.running = True
        self.fail_resume = False
        def worker(action, entry=None):
            self.actions.append(action)
            if action == "inventory":
                return [self.entry] if self.running else []
            if action == "stop":
                self.running = False
            if action == "resume":
                if self.fail_resume:
                    raise ValueError("readiness failed")
                self.running = True
                return {"pid": 43}
            return {}
        def manager(home, python, persist, progress):
            return RuntimeLifecycle(home, python, persist, progress, worker=worker)
        self.patch = patch.object(installer, "RuntimeLifecycle", side_effect=manager)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def apply(self):
        return installer.apply_install(self.plan, self.plan["confirmation"], stop_runtimes=True, progress=self.events.append)

    def journal(self):
        files = list((self.fixture.home / "plur1bus-install-backups").glob("*/journal.json"))
        self.assertEqual(len(files), 1)
        return json.loads(files[0].read_text())

    def test_success_returns_receipt_and_restores_running_set(self):
        receipt = self.apply()
        self.assertTrue(receipt.is_dir())
        self.assertEqual(self.journal()["status"], "installed-restored")
        self.assertEqual(self.journal()["runtimes"]["restored"], [42])
        self.assertEqual(self.events[-1]["phase"], "installation-outcome")

    def test_confirmation_failure_never_inspects_or_stops(self):
        with self.assertRaises(ValueError):
            installer.apply_install(self.plan, "wrong", stop_runtimes=True)
        self.assertEqual(self.actions, [])

    def test_prewrite_failure_restores(self):
        original = installer.verify_bundle
        calls = 0
        def verified(bundle):
            nonlocal calls
            calls += 1
            if "stop" in self.actions:
                raise ValueError("prewrite")
            return original(bundle)
        with patch.object(installer, "verify_bundle", side_effect=verified), self.assertRaisesRegex(ValueError, "prewrite"):
            self.apply()
        self.assertTrue(self.running)
        self.assertEqual(self.journal()["status"], "refused-restored")
        self.assertIn("refused-restored", self.stderr.getvalue())

    def test_partial_install_failure_keeps_stopped_recovery_debt(self):
        original = installer.atomic_write
        def write(path, data):
            if str(path).startswith(str(self.fixture.home / "desktop-plugins")):
                raise OSError("disk failure")
            return original(path, data)
        with patch.object(installer, "atomic_write", side_effect=write), self.assertRaises(OSError):
            self.apply()
        self.assertNotIn("resume", self.actions)
        self.assertEqual(self.journal()["status"], "install-failed-recovery-required")
        self.assertIn("install-failed-recovery-required", self.stderr.getvalue())
        self.assertEqual(self.journal()["runtimes"]["stopped"], [42])

    def test_restart_failure_is_distinct_from_install_failure(self):
        self.fail_resume = True
        with self.assertRaises(ValueError):
            self.apply()
        self.assertEqual(self.journal()["status"], "installed-restart-failed")
        self.assertIn("installed-restart-failed", self.stderr.getvalue())
        self.assertEqual(self.events[-1]["status"], "installed-restart-failed")
