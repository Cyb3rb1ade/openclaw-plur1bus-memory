"""Safety-contract tests for the Windows ARM64 Hermes PM acceptance helper."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("verify-hermes-pm-install.py")
spec = importlib.util.spec_from_file_location("verify_hermes_pm_install", SCRIPT)
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class QaLayoutTests(unittest.TestCase):
    def make_layout(self):
        temporary = tempfile.TemporaryDirectory(prefix=qa.QA_PREFIX)
        root = Path(temporary.name).resolve()
        source = root / "home" / "hermes-agent"
        source.mkdir(parents=True)
        (source / ".git").write_text("gitdir: fixture\n", encoding="utf-8")
        bundle = root.parent / (root.name + "-bundle")
        bundle.mkdir()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(lambda: bundle.rmdir())
        return temporary, root, source, bundle

    def test_accepts_only_fresh_temp_source_and_external_bundle(self):
        _, root, source, bundle = self.make_layout()
        actual_root, actual_source, home = qa.validate_qa_layout(root, source, bundle)
        self.assertEqual(actual_root, root)
        self.assertEqual(actual_source, source)
        self.assertEqual(home, root / "home")

    def test_accepts_exact_temp_descendant_even_when_windows_temp_is_under_user_home(self):
        temporary = tempfile.TemporaryDirectory(prefix="layout-test-")
        base = Path(temporary.name).resolve()
        user_home = base / "runner-profile"
        system_temp = user_home / "AppData" / "Local" / "Temp"
        root = system_temp / (qa.QA_PREFIX + "windows")
        source = root / "home" / "hermes-agent"
        source.mkdir(parents=True)
        (source / ".git").write_text("gitdir: fixture\n", encoding="utf-8")
        bundle = base / "external-bundle"
        bundle.mkdir()
        self.addCleanup(temporary.cleanup)
        with mock.patch.object(qa.tempfile, "gettempdir", return_value=str(system_temp)), \
             mock.patch.object(Path, "home", return_value=user_home):
            actual = qa.validate_qa_layout(root, source, bundle)
        self.assertEqual(actual[0], root)
        self.assertNotEqual(actual[0], user_home)

    def test_failure_tail_scrubs_url_queries_and_credential_values(self):
        detail = qa._sanitized_tail(
            "download failed https://example.invalid/archive?token=private\n"
            "api_key=also-private uv sync failed", max_lines=4)
        self.assertIn("https://example.invalid/archive?<redacted>", detail)
        self.assertNotIn("private", detail)
        self.assertNotIn("also-private", detail)

    def test_git_status_tail_preserves_bounded_path_evidence(self):
        detail = qa._sanitized_tail(" M pm/config.py\n?? generated/file.tmp\n", max_lines=2)
        self.assertEqual(detail, "M pm/config.py | ?? generated/file.tmp")

    def test_git_checkout_diagnostics_compare_config_and_attributes_without_file_bodies(self):
        if not qa.shutil.which("git"):
            self.skipTest("git is not installed")
        with tempfile.TemporaryDirectory(prefix="git-diagnostics-") as temporary:
            repo = Path(temporary)
            subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "QA"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "qa@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "core.autocrlf", "false"], check=True)
            note = repo / "note.md"
            note.write_text("one\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "note.md"], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "--quiet", "-m", "fixture"], check=True)
            note.write_text("one\ntwo\n", encoding="utf-8")
            diagnostics = qa.git_checkout_diagnostics(
                repo, " M note.md\n", qa.isolated_environment(repo, repo))
        self.assertIn("ambient gitconfig=[", diagnostics)
        self.assertIn("isolated gitconfig=[", diagnostics)
        self.assertIn("config:core.autocrlf false", diagnostics)
        self.assertIn("attributes=[note.md: text: unspecified", diagnostics)
        self.assertIn("numstat=[1\t0\tnote.md]", diagnostics)
        self.assertIn("paths=[note.md:len=", diagnostics)
        self.assertNotIn("two", diagnostics)

    def test_checked_process_failure_includes_both_sanitized_output_channels(self):
        failed = subprocess.CompletedProcess(
            ["python", "-m", "pm.cli", "install"], 1,
            stdout="PowerShell bootstrap failed: unable to create venv\nerror: native link failed\nlinker context\nurl https://example.invalid/x?token=private\n",
            stderr="Traceback follows\nCaused by: Rust build returned nonzero\napi_key=also-private\n",
        )
        with mock.patch.object(qa.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(RuntimeError, "failed with exit code 1") as caught:
                qa.run_checked(["python"], cwd=Path.cwd(), env={}, label="PM bootstrap")
        message = str(caught.exception)
        self.assertIn("stdout: PowerShell bootstrap failed", message)
        self.assertIn("stderr: Traceback follows", message)
        self.assertIn("error-focused excerpt:", message)
        self.assertIn("error: native link failed", message)
        self.assertIn("Caused by: Rust build returned nonzero", message)
        self.assertNotIn("private", message)
        self.assertNotIn("also-private", message)

    def test_preflight_diagnostic_reports_only_exception_and_module_metadata(self):
        failed = subprocess.CompletedProcess(
            ["python"], 1,
            stdout='{"exception":"ModuleNotFoundError","module":"yaml"}\n',
            stderr="private home path and API_KEY=private-value",
        )
        with mock.patch.object(qa.subprocess, "run", return_value=failed):
            result = qa.installer_python_preflight_diagnostic(Path("python"), cwd=Path.cwd(), env={})
        self.assertIn("exception=ModuleNotFoundError", result)
        self.assertIn("module=yaml", result)
        self.assertNotIn("private", result)

    def test_preflight_diagnostic_does_not_expose_spawn_error_path(self):
        with mock.patch.object(qa.subprocess, "run", side_effect=OSError("C:/private/user/path")):
            result = qa.installer_python_preflight_diagnostic(Path("missing-python"),
                                                               cwd=Path.cwd(), env={})
        self.assertEqual(result, "python preflight diagnostic could not start: OSError")

    def test_plan_callsite_diagnostic_reports_safe_probe_callsite(self):
        class Loader:
            def create_module(self, spec):
                return None

            def exec_module(self, module):
                def fail_probe(*args):
                    raise ValueError("raw private path")
                module.run_python = fail_probe
                module.plan_install = lambda *args: module.run_python("private", "private")

        class Spec:
            name = "fixture_installer"
            loader = Loader()

        with mock.patch("importlib.util.spec_from_file_location", return_value=Spec()), \
             mock.patch("importlib.util.module_from_spec", return_value=types.ModuleType("fixture_installer")):
            result = qa.installer_plan_callsite_diagnostic(Path("bundle"), Path("home"))
        self.assertIn("plan diagnostic failed at <lambda>", result)
        self.assertIn("ValueError", result)
        self.assertNotIn("private", result)

    def test_rejects_source_outside_the_exact_qa_checkout_path(self):
        _, root, source, bundle = self.make_layout()
        wrong = root / "other-checkout"
        wrong.mkdir()
        with self.assertRaisesRegex(ValueError, "fresh checkout"):
            qa.validate_qa_layout(root, wrong, bundle)

    def test_rejects_reused_home_state_before_any_mutation(self):
        _, root, source, bundle = self.make_layout()
        (root / "home" / "config.yaml").write_text("memory: {}\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "not fresh"):
            qa.validate_qa_layout(root, source, bundle)

    def test_rejects_bundle_inside_mutable_qa_root(self):
        _, root, source, _ = self.make_layout()
        bundle = root / "bundle"
        bundle.mkdir()
        with self.assertRaisesRegex(ValueError, "separate"):
            qa.validate_qa_layout(root, source, bundle)

    def test_environment_does_not_forward_credentials_or_profile_overrides(self):
        _, root, _, _ = self.make_layout()
        home = root / "home"
        machine_paths = {
            "PROGRAMFILES": r"C:\Program Files",
            "PROGRAMFILES(X86)": r"C:\Program Files (x86)",
            "PROGRAMW6432": r"C:\Program Files",
            "COMMONPROGRAMFILES": r"C:\Program Files\Common Files",
            "COMMONPROGRAMFILES(X86)": r"C:\Program Files (x86)\Common Files",
            "PROGRAMDATA": r"C:\ProgramData",
            "SYSTEMDRIVE": "C:",
        }
        with mock.patch.dict(qa.os.environ, machine_paths):
            environment = qa.isolated_environment(home, root)
        # Windows exposes environment keys case-insensitively and Python may
        # normalize their spelling to uppercase. Verify the whitelist by key,
        # not by the host's presentation casing.
        environment_upper = {key.upper(): value for key, value in environment.items()}
        self.assertEqual(environment["HERMES_HOME"], str(home))
        self.assertEqual(environment["UV_CACHE_DIR"], str(root / "uv-cache"))
        self.assertEqual(environment["CARGO_TARGET_DIR"], str(root / "cargo-target"))
        profile = root / "runner-profile"
        self.assertEqual(environment["USERPROFILE"], str(profile))
        self.assertEqual(environment["HOMEDRIVE"], profile.drive)
        self.assertEqual(environment["HOMEPATH"], str(profile)[len(profile.drive):])
        self.assertEqual(environment["APPDATA"], str(profile / "AppData" / "Roaming"))
        self.assertEqual(environment["LOCALAPPDATA"], str(profile / "AppData" / "Local"))
        self.assertEqual(environment["CI"], "true")
        self.assertEqual(environment["GITHUB_ACTIONS"], "true")
        self.assertEqual(environment_upper["PROGRAMFILES(X86)"], r"C:\Program Files (x86)")
        self.assertEqual(environment_upper["SYSTEMDRIVE"], "C:")
        for name in ("USERPROFILE", "APPDATA", "LOCALAPPDATA", "UV_CACHE_DIR", "CARGO_TARGET_DIR"):
            self.assertTrue(qa._inside(Path(environment[name]), root))
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertNotIn("ANTHROPIC_API_KEY", environment)
        self.assertNotIn("PYTHONPATH", environment)


if __name__ == "__main__":
    unittest.main()
