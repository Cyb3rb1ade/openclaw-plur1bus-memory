"""Protocol and native-owner dispatch contracts without live services."""
import sys
from types import ModuleType
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
from distribution import runtime_worker as worker


class RuntimeWorkerTests(unittest.TestCase):
    def setUp(self):
        self.entry = dict(pid=42, born=1.5, home="/tmp/owned", kind="manual", served_profiles=["default", "alpha"], shutdownBudget=2000.0)
        self.control = ModuleType("gateway.control_socket")
        self.control.pause_gateway_for_update = Mock(return_value={"pid": 42, "pausing": True, "drain_timeout": 30})
        self.posix = ModuleType("hermes_cli.update_cmd_posix_pause")
        self.posix._stop_unit, self.posix._stop_job = Mock(), Mock()
        self.windows = ModuleType("hermes_cli.update_cmd_windows")
        self.windows._stop_windows_gateway_service = Mock()
        self.windows._win_service = Mock(return_value=(None, Mock(status=Mock(return_value="running"))))
        self.modules = patch.dict(sys.modules, {"gateway.control_socket": self.control,
            "hermes_cli.update_cmd_posix_pause": self.posix, "hermes_cli.update_cmd_windows": self.windows})
        self.modules.start()
        budget = patch.object(worker, "restart_budget", return_value=2000.0)
        budget.start()
        self.addCleanup(budget.stop)
        self.addCleanup(self.modules.stop)

    def test_pid_reuse_never_sends_pause(self):
        with patch.object(worker, "same_process", return_value=False), self.assertRaisesRegex(ValueError, "replaced"):
            worker.stop(self.entry)
        self.control.pause_gateway_for_update.assert_not_called()

    def test_normal_pause_waits_for_active_work_without_signal(self):
        with patch.object(worker, "verify_entry"), patch.object(worker, "same_process", side_effect=[True, True, False, False]), patch.object(worker.time, "sleep") as sleep:
            worker.stop(self.entry)
        self.assertEqual(sleep.call_count, 2)
        self.control.pause_gateway_for_update.assert_called_once_with(Path(self.entry["home"]))

    def test_wrong_pause_ack_is_refused(self):
        self.control.pause_gateway_for_update.return_value["pid"] = 99
        with patch.object(worker, "verify_entry"), self.assertRaisesRegex(ValueError, "acknowledge"):
            worker.stop(self.entry)

    def test_all_native_services_are_stopped_through_their_owner(self):
        for kind in ("launchd", "systemd", "windows-service"):
            with self.subTest(kind=kind):
                entry = dict(self.entry, kind=kind, owner={"name": "hermes", "service_pid": 7, "service_born": 1.0}, ownerFingerprint="same")
                with patch.object(worker, "verify_entry"), patch.object(worker, "same_process", return_value=False), patch.object(worker, "service_fingerprint", return_value="same"):
                    worker.stop(entry)
        self.posix._stop_job.assert_called_once_with(entry["owner"], drained=True)
        self.posix._stop_unit.assert_called_once_with(entry["owner"])
        self.windows._stop_windows_gateway_service.assert_called_once_with("hermes", expected_service_identity=(7, 1.0))

    def test_changed_service_definition_is_not_stopped(self):
        entry = dict(self.entry, kind="launchd", owner={"label": "hermes"}, ownerFingerprint="original")
        with patch.object(worker, "verify_entry"), patch.object(worker, "same_process", return_value=False), patch.object(worker, "service_fingerprint", return_value="changed"), self.assertRaises(ValueError):
            worker.stop(entry)
        self.posix._stop_job.assert_not_called()

    def test_readiness_requires_same_profiles_and_not_draining(self):
        identity = dict(pid=43, state="ready", hermes_home=self.entry["home"], served_profiles=["alpha", "default"])
        self.assertTrue(worker.ready(self.entry, identity))
        self.assertFalse(worker.ready(self.entry, dict(identity, served_profiles=["default"])))
        self.assertFalse(worker.ready(self.entry, dict(identity, state="draining")))

    def test_custom_command_arguments_never_enter_receipts(self):
        with self.assertRaises(ValueError):
            worker.manual_options(["python", "/tmp/project/hermes_cli/main.py", "gateway", "run", "--token", "secret"], Path("/tmp/project"))

    def test_current_authority_records_preserve_the_served_set(self):
        identity = {"hermes_home": "/tmp/owned", "served_profiles": [{"home": "/tmp/owned", "profile_id": "/tmp/owned"}, {"home": "/tmp/owned/profiles/alpha", "profile_id": "/tmp/owned/profiles/alpha"}]}
        self.assertEqual(worker.served_profiles(identity), ["alpha", "default"])
        identity["served_profiles"].append({"home": "/foreign"})
        with self.assertRaises(ValueError):
            worker.served_profiles(identity)

    def test_already_stopped_windows_wrapper_is_not_stopped_again(self):
        self.windows._win_service.return_value[1].status.return_value = "stopped"
        entry = dict(self.entry, kind="windows-service", owner={"name": "hermes", "service_pid": 7, "service_born": 1.0}, ownerFingerprint="same")
        with patch.object(worker, "verify_entry"), patch.object(worker, "same_process", return_value=False), patch.object(worker, "service_fingerprint", return_value="same"):
            worker.stop(entry)
        self.windows._stop_windows_gateway_service.assert_not_called()

    def test_secondary_profile_uses_verified_gateway_owner_socket(self):
        self.control.identify_gateway = Mock(side_effect=[None, {"pid": 42}])
        status = ModuleType("gateway.status")
        status.live_gateway_pid_for_home = Mock(return_value=42)
        scope = ModuleType("hermes_cli.update_fleet_scope")
        scope.gateway_pid_home = Mock(return_value="/tmp/owned")
        with patch.dict(sys.modules, {"gateway.status": status, "hermes_cli.update_fleet_scope": scope}):
            self.assertEqual(worker.identify(Path("/tmp/owned/profiles/alpha")), {"pid": 42})
        self.control.identify_gateway.assert_called_with(Path("/tmp/owned"))

    def test_complete_budget_is_known_before_pause_and_long_turn_finishes(self):
        for budget in (1885.0, 7285.0):
            with self.subTest(budget=budget):
                now = [0.0]
                def advance(_seconds):
                    now[0] += 600
                self.control.pause_gateway_for_update.side_effect = lambda _home: (self.assertEqual(now[0], 0) or {"pid": 42, "pausing": True, "drain_timeout": 0})
                with patch.object(worker, "verify_entry"), patch.object(worker, "restart_budget", return_value=budget, create=True), patch.object(worker, "same_process", side_effect=lambda _entry: now[0] < budget - 300), patch.object(worker.time, "monotonic", side_effect=lambda: now[0]), patch.object(worker.time, "sleep", side_effect=advance):
                    worker.stop(dict(self.entry, shutdownBudget=budget))
                self.assertGreater(now[0], 900)

    def test_unsupported_budget_refuses_before_pause(self):
        with patch.object(worker, "verify_entry"), patch.object(worker, "restart_budget", side_effect=ValueError("unbounded shutdown"), create=True), self.assertRaises(ValueError):
            worker.stop(dict(self.entry, shutdownBudget=2000))
        self.control.pause_gateway_for_update.assert_not_called()

    def test_changed_budget_refuses_before_pause(self):
        with patch.object(worker, "verify_entry"), patch.object(worker, "restart_budget", return_value=8000, create=True), self.assertRaises(ValueError):
            worker.stop(dict(self.entry, shutdownBudget=2000))
        self.control.pause_gateway_for_update.assert_not_called()

    def test_documented_manual_switches_are_preserved_without_takeover(self):
        project = Path("/tmp/project").resolve()
        argv = ["python", str(project / "hermes_cli/main.py"), "gateway", "run", "-q", "-vv", "--replace", "--force", "--no-supervise", "--idle-exit"]
        self.assertEqual(worker.manual_options(argv, project), ["--quiet", "--verbose", "--verbose", "--no-supervise", "--idle-exit"])

    def test_inventory_rejects_native_same_home_foreign_checkout(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            project = root / "hermes-agent"
            owner = dict(kind="launchd", pid=42, home=str(root), label="ai.hermes.gateway", domain="gui/501", plist=str(root / "gateway.plist"))
            self.control.launch_supervisor = Mock(return_value="launchd")
            scope = ModuleType("hermes_cli.update_fleet_scope")
            scope.gateway_pid_home = Mock(return_value=str(root))
            proc = Mock(cmdline=Mock(return_value=["python", "/foreign/hermes_cli/main.py", "gateway", "run"]), cwd=Mock(return_value=str(root)))
            with patch.dict(sys.modules, {"hermes_cli.update_fleet_scope": scope}), patch.object(worker, "service_owners", return_value=[owner]), patch.object(worker, "identify", return_value={"pid": 42, "hermes_home": str(root), "served_profiles": ["default"]}), patch.object(worker, "process", return_value=proc), patch.object(worker, "birth", return_value=1.5), patch.object(worker, "same_process", return_value=True), patch.object(worker, "service_fingerprint", return_value="fingerprint"), patch.object(worker, "inspect_clients"), self.assertRaisesRegex(ValueError, "source|checkout|installation"):
                worker.inventory(root, project)

    def test_restore_waits_complete_inflight_pause_budget(self):
        now = [0.0]
        def advance(_seconds):
            now[0] += 600
        self.windows._start_windows_gateway_service = Mock()
        entry = dict(self.entry, shutdownBudget=1885, kind="windows-service", owner={"name": "hermes"}, ownerFingerprint="same")
        identity = dict(pid=42, state="draining", hermes_home=entry["home"], served_profiles=entry["served_profiles"])
        with patch.object(worker, "identify", side_effect=[identity, dict(identity, pid=43, state="ready")]), patch.object(worker, "same_process", side_effect=lambda _entry: now[0] < 1800), patch.object(worker.time, "monotonic", side_effect=lambda: now[0]), patch.object(worker.time, "sleep", side_effect=advance), patch.object(worker, "service_fingerprint", return_value="same"):
            self.assertEqual(worker.resume(entry, Path("/tmp/owned/hermes-agent")), {"pid": 43})
        self.assertEqual(now[0], 1800)


class OwningBudgetTests(unittest.TestCase):
    def test_budget_uses_owner_profile_and_timeout_environment_only(self):
        import os
        gateway = ModuleType("hermes_cli.gateway")
        constants = ModuleType("hermes_constants")
        constants.set_hermes_home_override = Mock(return_value="token")
        constants.reset_hermes_home_override = Mock()
        def budget():
            self.assertEqual(os.environ["HERMES_RESTART_AFTER_TURN_TIMEOUT"], "7200")
            self.assertNotIn("HERMES_RESTART_DRAIN_TIMEOUT", os.environ)
            self.assertEqual(os.environ["HERMES_CRON_DRAIN_TIMEOUT"], "30")
            constants.set_hermes_home_override.assert_called_once_with("/owned/profiles/alpha")
            return 7285.0
        gateway._get_restart_exit_wait_budget = budget
        owner = Mock(environ=Mock(return_value={"HERMES_RESTART_AFTER_TURN_TIMEOUT": "7200", "HERMES_CRON_DRAIN_TIMEOUT": "30", "SECRET": "not-copied"}))
        with patch.dict(sys.modules, {"hermes_cli.gateway": gateway, "hermes_constants": constants}), patch.object(worker, "process", return_value=owner), patch.dict(os.environ, {"HERMES_RESTART_DRAIN_TIMEOUT": "999", "HERMES_RESTART_AFTER_TURN_TIMEOUT": "1"}):
            self.assertEqual(worker.restart_budget({"pid": 42, "home": "/owned/profiles/alpha"}), 7285)
            self.assertEqual(os.environ["HERMES_RESTART_DRAIN_TIMEOUT"], "999")
            self.assertEqual(os.environ["HERMES_RESTART_AFTER_TURN_TIMEOUT"], "1")
            self.assertNotEqual(os.environ.get("SECRET"), "not-copied")
        constants.reset_hermes_home_override.assert_called_once_with("token")

    def test_nonfinite_complete_budget_is_unsupported(self):
        gateway = ModuleType("hermes_cli.gateway")
        gateway._get_restart_exit_wait_budget = Mock(return_value=float("inf"))
        constants = ModuleType("hermes_constants")
        constants.set_hermes_home_override = Mock(return_value="token")
        constants.reset_hermes_home_override = Mock()
        with patch.dict(sys.modules, {"hermes_cli.gateway": gateway, "hermes_constants": constants}), patch.object(worker, "process", return_value=Mock(environ=Mock(return_value={}))), self.assertRaisesRegex(ValueError, "unbounded"):
            worker.restart_budget({"pid": 42, "home": "/owned"})
