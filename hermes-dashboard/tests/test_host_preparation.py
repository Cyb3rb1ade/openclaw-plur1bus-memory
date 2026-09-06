"""Host preparation uses real Git patches, fake builds, and no productive paths."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("host_preparation", Path(__file__).resolve().parents[2] / "scripts/hermes-desktop-host.py")
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


class HostPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "hermes"
        self.source.mkdir()
        self.output = self.root / "builds"
        self.patches = self.root / "patches"
        self.patches.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        (self.source / "apps/desktop").mkdir(parents=True)
        (self.source / "apps/desktop/package.json").write_text(json.dumps({"scripts": {"pack": "npm run build && npm run builder -- --dir --publish never"}}))
        (self.source / "package-lock.json").write_text("{}")
        (self.source / "package.json").write_text(json.dumps({"engines": {"node": ">=0.0.0", "npm": ">=0.0.0"}}))
        for name in ("owner.txt", "sidebar.txt"):
            (self.source / name).write_text("old\n")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        for name, patch_name in zip(("owner.txt", "sidebar.txt"), host.PATCHES):
            (self.source / name).write_text("new\n")
            (self.patches / patch_name).write_text(self.git("diff", "--", name))
            (self.source / name).write_text("old\n")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.source, check=True, capture_output=True, text=True).stdout

    def review(self):
        return host.review(self.source, self.output, self.patches)

    def test_check_is_read_only_and_missing_confirmation_never_writes(self):
        plan = self.review()
        self.assertTrue(plan["supported"])
        self.assertEqual([p["state"] for p in plan["patches"]], ["applicable", "applicable"])
        with self.assertRaises(ValueError):
            host.build(plan, "", self.patches)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_dirty_changed_and_unsupported_sources_refused(self):
        plan = self.review()
        (self.source / "owner.txt").write_text("unrelated\n")
        self.assertFalse(self.review()["supported"])
        with self.assertRaises(ValueError):
            host.build(plan, plan["confirmation"], self.patches)
        self.git("add", ".")
        self.git("commit", "-qm", "incompatible update")
        self.assertFalse(self.review()["supported"])
        self.assertFalse(self.output.exists())

    def test_already_applied_is_detected_without_double_application(self):
        for name in host.PATCHES:
            self.git("apply", str(self.patches / name))
        self.git("add", ".")
        self.git("commit", "-qm", "patched")
        self.assertEqual([p["state"] for p in self.review()["patches"]], ["present", "present"])

    def test_confirmed_build_snapshots_and_only_patches_new_copy(self):
        plan = self.review()
        real_run = subprocess.run
        builds = []
        def fake_build(command, **kwargs):
            if command[0] != "npm":
                return real_run(command, **kwargs)
            target = kwargs["cwd"]
            self.assertEqual(kwargs["env"]["CSC_IDENTITY_AUTO_DISCOVERY"], "false")
            self.assertNotIn("GITHUB_TOKEN", kwargs["env"])
            self.assertNotEqual(target, self.source)
            self.assertEqual((target / "owner.txt").read_text(), "new\n")
            builds.append(command)
            release = target / "apps/desktop/release"
            release.mkdir(exist_ok=True)
            (release / "Hermes-test").write_text("fixture")
            return subprocess.CompletedProcess(command, 0)
        with patch.object(host.subprocess, "run", side_effect=fake_build):
            stage = host.build(plan, plan["confirmation"], self.patches)
        self.assertEqual(len(builds), 2)
        self.assertTrue((stage / "source-backup.tar").is_file())
        self.assertEqual(json.loads((stage / "result.json").read_text())["status"], "built-not-installed")
        self.assertEqual((self.source / "owner.txt").read_text(), "old\n")
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_failed_build_retains_backup_and_does_not_retry(self):
        plan = self.review()
        real_run = subprocess.run
        def fail(command, **kwargs):
            if command[0] == "npm":
                raise subprocess.CalledProcessError(1, command)
            return real_run(command, **kwargs)
        with patch.object(host.subprocess, "run", side_effect=fail):
            with self.assertRaises(subprocess.CalledProcessError):
                host.build(plan, plan["confirmation"], self.patches)
        stage = next(self.output.iterdir())
        self.assertTrue((stage / "source-backup.tar").is_file())
        self.assertEqual(json.loads((stage / "result.json").read_text())["status"], "failed")
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_symlinks_and_output_inside_source_refused(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            host.review(alias, self.output, self.patches)
        with self.assertRaises(ValueError):
            host.review(self.source, self.source / "builds", self.patches)
        (self.source / "owner.txt").unlink()
        (self.source / "owner.txt").symlink_to(self.root / "foreign")
        with self.assertRaises(ValueError):
            self.review()

    def test_changed_patch_invalidates_confirmation(self):
        plan = self.review()
        patch_file = self.patches / host.PATCHES[0]
        patch_file.write_text(patch_file.read_text() + "\n")
        with self.assertRaises(ValueError):
            host.build(plan, plan["confirmation"], self.patches)
        self.assertFalse(self.output.exists())

    def test_engine_ranges_exclude_broken_npm_before_writes(self):
        self.assertFalse(host.satisfies("11.12.1", "<11.10.0 || >=11.17.0"))
        self.assertTrue(host.satisfies("10.9.4", "<11.10.0 || >=11.17.0"))
        self.assertTrue(host.satisfies("v22.22.3", "^22.22.0 || ^24.11.0 || >=26.0.0"))
        self.assertFalse(host.satisfies("v22.21.0", "^22.22.0 || ^24.11.0 || >=26.0.0"))
        self.assertFalse(host.satisfies("v26.0.0", "unknown"))
        (self.source / "package.json").write_text(json.dumps({"engines": {"node": ">=999.0.0", "npm": ">=0.0.0"}}))
        self.git("add", ".")
        self.git("commit", "-qm", "unavailable toolchain")
        plan = self.review()
        self.assertFalse(plan["supported"])
        with self.assertRaises(ValueError):
            host.build(plan, plan["confirmation"], self.patches)
        self.assertFalse(self.output.exists())
