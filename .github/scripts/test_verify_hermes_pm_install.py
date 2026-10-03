"""Safety-contract tests for the Windows ARM64 Hermes PM acceptance helper."""
import importlib.util
from pathlib import Path
import tempfile
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
        environment = qa.isolated_environment(home, root)
        self.assertEqual(environment["HERMES_HOME"], str(home))
        self.assertEqual(environment["UV_CACHE_DIR"], str(root / "uv-cache"))
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertNotIn("ANTHROPIC_API_KEY", environment)
        self.assertNotIn("PYTHONPATH", environment)


if __name__ == "__main__":
    unittest.main()
