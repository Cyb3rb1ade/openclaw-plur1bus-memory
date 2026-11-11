"""Native source proof without service-manager calls or process enumeration."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from distribution import runtime_service_identity as identity


class ServiceIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / "hermes-agent"
        self.command = ["python", str(self.project / "hermes_cli/main.py"), "gateway", "run", "--external-supervisor"]

    def test_each_definition_must_name_selected_source_not_just_matching_home(self):
        for kind, reader in (("launchd", "_launchd_records"), ("systemd", "_systemd_records"), ("windows-service", "_windows_definition")):
            with self.subTest(kind=kind):
                command = ["python", "/foreign/hermes_cli/main.py", "gateway", "run"]
                result = (command, str(self.project), "definition", {"HERMES_HOME": str(self.root)}) if kind == "windows-service" else [(command, str(self.project))]
                with patch.object(identity, reader, return_value=result), self.assertRaisesRegex(ValueError, "source installation"):
                    identity.prove_service_source({"kind": kind}, self.project, self.root)

    def test_supported_native_definition_options_are_not_manual_whitelist(self):
        for kind, reader in (("launchd", "_launchd_records"), ("systemd", "_systemd_records"), ("windows-service", "_windows_definition")):
            with self.subTest(kind=kind):
                result = (self.command, str(self.project), "definition", {"HERMES_HOME": str(self.root)}) if kind == "windows-service" else [(self.command, str(self.project))]
                with patch.object(identity, reader, return_value=result):
                    identity.prove_service_source({"kind": kind}, self.project, self.root)

    def test_native_profile_selector_cannot_retarget_restart(self):
        command = ["python", str(self.project / "hermes_cli/main.py"), "--profile", "foreign", "gateway", "run"]
        with self.assertRaisesRegex(ValueError, "profile"):
            identity.gateway_options(command, self.project, self.project, manual=False, home=self.root)

    def test_stock_inline_and_timestamp_wrapper_use_exact_upstream_decoder(self):
        inner = ["python", "-I", "-c", "exact-vendor-bootstrap", "gateway", "run", "--external-supervisor"]
        outer = ["python", "-I", "-c", "exact-timestamp-bootstrap", "--error-log", "/logs/error", "--", *inner]
        def decode(argv):
            if argv == outer:
                return "hermes_cli.stderr_timestamp", argv[4:]
            if argv == inner:
                return "hermes_cli.main", argv[4:]
            return None
        api = SimpleNamespace(_launch_module=Mock(side_effect=decode))
        with patch.object(identity, "_identity_api", return_value=api):
            self.assertEqual(identity.gateway_options(outer, self.project, None, manual=False), ["--external-supervisor"])
            with self.assertRaisesRegex(ValueError, "source installation"):
                identity.gateway_options(["python", "-I", "-c", "foreign-bootstrap", "gateway", "run"], self.project, None, manual=False)
        self.assertEqual(api._launch_module.call_count, 3)

    def test_stock_store_launcher_is_exact_not_a_matching_basename(self):
        command = [str(self.project / ".hermes/bin/hermes"), "gateway", "run", "--quiet"]
        self.assertEqual(identity.gateway_options(command, self.project, None, manual=False), ["--quiet"])
        with patch.object(identity, "_identity_api", return_value=SimpleNamespace(_launch_module=Mock(return_value=None))), self.assertRaises(ValueError):
            identity.gateway_options(["/foreign/.hermes/bin/hermes", *command[1:]], self.project, None, manual=False)

    def test_legacy_module_requires_selected_working_directory(self):
        api = SimpleNamespace(_launch_module=Mock(return_value=("hermes_cli.main", ["gateway", "run"])))
        with patch.object(identity, "_identity_api", return_value=api):
            self.assertEqual(identity.gateway_options(["python", "-m", "hermes_cli.main", "gateway", "run"], self.project, self.project, manual=False), [])
            with self.assertRaisesRegex(ValueError, "checkout"):
                identity.gateway_options(["python", "-m", "hermes_cli.main", "gateway", "run"], self.project, Path("/foreign"), manual=False)

    def test_unknown_windows_wrapper_is_not_inferred_from_an_adjacent_xml_file(self):
        import sys
        psutil = SimpleNamespace(win_service_get=Mock(return_value=SimpleNamespace(binpath=lambda: str(self.root / "custom.exe"))))
        with patch.dict(sys.modules, {"psutil": psutil}), patch.object(identity, "_windows_split", return_value=[str(self.root / "custom.exe")]), patch.object(identity, "_windows_product", return_value="Custom Service"), self.assertRaisesRegex(ValueError, "custom Windows"):
            identity._windows_definition({"name": "hermes"})
