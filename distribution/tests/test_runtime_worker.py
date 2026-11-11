"""Protocol and native-owner dispatch contracts without live services."""
import sys
from types import ModuleType
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
from distribution import runtime_worker as worker


class RuntimeWorkerTests(unittest.TestCase):
    def setUp(self):
        self.entry = dict(pid=42, born=1.5, home="/tmp/owned", kind="manual", served_profiles=["default", "alpha"])
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
