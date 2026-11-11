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
        import sys
        from types import ModuleType
        launcher = ModuleType('hermes_cli._launchers')
        launcher._launcher_script = lambda *args: 'stock-published-launcher'
        modules = patch.dict(sys.modules, {'hermes_cli._launchers': launcher})
        modules.start()
        self.addCleanup(modules.stop)
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

    @staticmethod
    def module_decoder(argv):
        if argv[1:3] == ["-m", "hermes_cli.main"]:
            return "hermes_cli.main", argv[3:]
        return None

    def test_python_module_flags_are_normalized_before_vendor_dispatch(self):
        api = SimpleNamespace(_launch_module=Mock(side_effect=self.module_decoder))
        with patch.object(identity, "_identity_api", return_value=api):
            for flags in (["-B"], ["-I"], ["-u"], ["-B", "-I", "-u"], ["-u", "-B", "-I"]):
                with self.subTest(flags=flags):
                    command = ["python", *flags, "-m", "hermes_cli.main", "gateway", "run", "-q"]
                    self.assertEqual(identity.gateway_options(command, self.project, self.project, manual=True), ["--quiet"])
                    api._launch_module.assert_called_with(["python", "-m", "hermes_cli.main", "gateway", "run", "-q"])

    def test_normalized_module_flags_do_not_relax_source_or_unknown_flags(self):
        api = SimpleNamespace(_launch_module=Mock(side_effect=self.module_decoder))
        with patch.object(identity, "_identity_api", return_value=api):
            for flags in (["-B"], ["-I"], ["-u"], ["-B", "-I", "-u"]):
                with self.subTest(flags=flags), self.assertRaises(ValueError):
                    identity.gateway_options(["python", *flags, "-m", "hermes_cli.main", "gateway", "run"], self.project, Path("/foreign"), manual=True)
            for flags in (["-B", "-S"], ["-I", "-X", "custom"], ["-u", "--unknown"]):
                with self.subTest(flags=flags), self.assertRaises(ValueError):
                    identity.gateway_options(["python", *flags, "-m", "hermes_cli.main", "gateway", "run"], self.project, self.project, manual=True)
            with self.assertRaises(ValueError):
                identity.gateway_options(["python", "-B", "-I", "-u", "-m", "foreign.module", "gateway", "run"], self.project, self.project, manual=True)
            with self.assertRaises(ValueError):
                identity.gateway_options(["python", "-B", "-I", "-u", "-c", "arbitrary code", "gateway", "run"], self.project, self.project, manual=True)

    def prove_winsw_xml(self, extra=""):
        import shlex
        import sys
        from xml.sax.saxutils import escape
        command = shlex.join([str(self.project / "hermes_cli/main.py"), "gateway", "run"])
        document = ("<service><id>hermes</id><name>Hermes</name><description>Gateway</description>"
                    "<executable>python</executable><arguments>" + escape(command) + "</arguments>"
                    "<workingdirectory>" + escape(str(self.project)) + "</workingdirectory>"
                    '<env name="HERMES_HOME" value="' + escape(str(self.root)) + '"/>' + extra + "</service>").encode()
        psutil = SimpleNamespace(win_service_get=Mock(return_value=SimpleNamespace(binpath=lambda: str(self.root / "hermes-service.exe"))))
        api = SimpleNamespace(read_definition=Mock(return_value=document))
        with patch.dict(sys.modules, {"psutil": psutil, "hermes_cli.gateway_runtime_service_identity": api}), patch.object(identity, "_windows_split", side_effect=shlex.split), patch.object(identity, "_windows_product", return_value="Windows Service Wrapper"):
            identity.prove_service_source({"kind": "windows-service", "name": "hermes"}, self.project, self.root)

    def test_winsw_stock_configuration_remains_supported(self):
        self.prove_winsw_xml('<log mode="roll"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log><onfailure action="restart" delay="10 sec"/><stoptimeout>60 sec</stoptimeout>')

    def test_winsw_custom_start_stop_executables_are_refused(self):
        additions = [
            '<prestop><executable>/unrelated/admin-tool.exe</executable></prestop>',
            '<poststop><executable>/unrelated/admin-tool.exe</executable></poststop>',
            '<stopexecutable>/unrelated/admin-tool.exe</stopexecutable>',
            '<stoparguments>--custom-stop</stoparguments>',
            '<startarguments>/foreign/hermes_cli/main.py gateway run</startarguments>',
            '<prestart><executable>/unrelated/admin-tool.exe</executable></prestart>',
            '<poststart><executable>/unrelated/admin-tool.exe</executable></poststart>',
            '<extensions><extension id="custom"/></extensions>',
            '<download from="https://example.invalid/code.exe" to="tool.exe"/>',
            '<onfailure action="run" delay="0"/><failurecommand>/unrelated/admin-tool.exe</failurecommand>',
            '<onfailure action="reboot" delay="0"/>',
            '<future-execution-hook>/unrelated/admin-tool.exe</future-execution-hook>',
        ]
        for addition in additions:
            with self.subTest(xml=addition), self.assertRaisesRegex(ValueError, "WinSW"):
                self.prove_winsw_xml(addition)

class PublishedLauncherTests(unittest.TestCase):
    def test_executed_stock_pm_launcher_is_compared_byte_for_byte(self):
        import sys
        from types import ModuleType
        project = Path('/fixture/hermes-agent')
        launcher = ModuleType('hermes_cli._launchers')
        launcher._launcher_script = lambda name, root, dependencies: 'published launcher for ' + str(root)
        api = SimpleNamespace(_launch_module=lambda argv: None)
        command = ['python', '-I', '-c', launcher._launcher_script('hermes', project, None), 'gateway', 'run', '--external-supervisor']
        with patch.dict(sys.modules, {'hermes_cli._launchers': launcher}), patch.object(identity, '_identity_api', return_value=api):
            self.assertEqual(identity.gateway_options(command, project, project, manual=False), ['--external-supervisor'])
            for code in ('published launcher for /foreign', command[3] + '\ncustom()'):
                with self.assertRaises(ValueError):
                    identity.gateway_options([*command[:3], code, *command[4:]], project, project, manual=False)
