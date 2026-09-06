"""Native dependency selection never substitutes a foreign-architecture wheel."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import zipfile

import pytest

import test_installer as fixtures

installer = fixtures.installer

SPEC = importlib.util.spec_from_file_location("native_bundle_builder", Path(__file__).resolve().parents[1] / "build.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
FILENAME = "lancedb-0.34.0-cp39-abi3-macosx_10_15_x86_64.whl"
RELATIVE = "vendor/macos-x86_64/" + FILENAME


def wheel(tmp_path, tag="cp39-abi3-macosx_10_15_x86_64", version="0.34.0"):
    path = tmp_path / FILENAME
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("lancedb-0.34.0.dist-info/METADATA", f"Name: lancedb\nVersion: {version}\n")
        archive.writestr("lancedb-0.34.0.dist-info/WHEEL", f"Wheel-Version: 1.0\nTag: {tag}\n")
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


def test_explicit_hash_and_matching_wheel_metadata(tmp_path):
    path, sha = wheel(tmp_path)
    assert builder.validate_intel_wheel(path, sha) == path
    for wrong in (None, "", "f" * 64):
        with pytest.raises(ValueError):
            builder.validate_intel_wheel(path, wrong)


@pytest.mark.parametrize("tag,version", [("cp39-abi3-macosx_11_0_arm64", "0.34.0"),
                                        ("cp39-abi3-macosx_10_15_x86_64", "0.25.3")])
def test_wrong_architecture_or_version_refused(tmp_path, tag, version):
    path, sha = wheel(tmp_path, tag, version)
    with pytest.raises(ValueError, match="metadata/architecture"):
        builder.validate_intel_wheel(path, sha)


class NativeInstallerTests(fixtures.InstallerTests):
    # Re-run the existing installer invariants with optional native metadata.
    def setUp(self):
        super().setUp()
        self.files[RELATIVE] = b"native fixture; never executed"
        self.write_bundle()
        self.architecture = "x86_64"
        self.platform = sys.platform
        path = self.bundle / "distribution.json"
        manifest = json.loads(path.read_text())
        manifest["nativeDependencies"] = {"darwin/x86_64": RELATIVE}
        path.write_text(json.dumps(manifest))

    def fake_python(self, python, code, data=None):
        result = super().fake_python(python, code, data)
        if "sys.version_info" in code:
            info = json.loads(result)
            info.update(architecture=self.architecture, platform=self.platform)
            return json.dumps(info)
        return result

    def test_native_wheel_bound_to_target_and_install_mode(self):
        from unittest.mock import patch
        with patch.object(installer.sys, "platform", "darwin"):
            self.platform = "darwin"
            assert self.plan()["nativeWheels"] == [RELATIVE]
            assert self.plan(dependencies=False)["nativeWheels"] == []
            assert self.plan(desktop_only=True)["nativeWheels"] == []
            self.architecture = "arm64"
            assert self.plan()["nativeWheels"] == []

    def test_native_manifest_cannot_choose_an_unverified_path(self):
        path = self.bundle / "distribution.json"
        manifest = json.loads(path.read_text())
        manifest["nativeDependencies"] = {"darwin/x86_64": "../../outside.whl"}
        path.write_text(json.dumps(manifest))
        with pytest.raises(ValueError, match="native dependency"):
            self.plan()

    def test_approved_native_wheel_is_reinstalled_even_at_the_same_version(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        commands = []
        def run(command, **kwargs):
            if "pip" in command:
                commands.append(command)
                return SimpleNamespace(returncode=0, stdout="" if kwargs.get("text") else b"")
            return self.real_run(command, **kwargs)
        with patch.object(installer.sys, "platform", "darwin"):
            self.platform = "darwin"
            plan = self.plan()
            with patch.object(installer.subprocess, "run", side_effect=run), patch.object(installer, "run_python", side_effect=self.fake_python):
                installer.apply_install(plan, plan["confirmation"], True)
        forced = next(command for command in commands if "--force-reinstall" in command)
        assert "--no-deps" in forced and str(self.bundle / RELATIVE) in forced
