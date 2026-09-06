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
ARM_LANCE = "vendor/windows-arm64/lancedb-0.34.0-cp39-abi3-win_arm64.whl"
ARM_ARROW = "vendor/windows-arm64/pyarrow-25.0.1-cp313-cp313-win_arm64.whl"


def test_arm_wheel_requires_approved_hash_metadata_and_native_pe(tmp_path):
    import struct
    path = tmp_path / Path(ARM_LANCE).name
    binary = bytearray(128)
    binary[:2] = b"MZ"
    struct.pack_into("<I", binary, 0x3c, 64)
    binary[64:68] = b"PE\0\0"
    struct.pack_into("<H", binary, 68, 0xaa64)

    def write(machine):
        struct.pack_into("<H", binary, 68, machine)
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("lancedb-0.34.0.dist-info/METADATA", "Name: lancedb\nVersion: 0.34.0\n")
            archive.writestr("lancedb-0.34.0.dist-info/WHEEL", "Wheel-Version: 1.0\nTag: cp39-abi3-win_arm64\n")
            archive.writestr("lancedb/_lancedb.pyd", binary)
        return hashlib.sha256(path.read_bytes()).hexdigest()

    sha = write(0xaa64)
    assert builder.validate_windows_arm_wheel(path, sha, "lancedb") == path
    with pytest.raises(ValueError):
        builder.validate_windows_arm_wheel(path, "0" * 64, "lancedb")
    sha = write(0x8664)
    with pytest.raises(ValueError, match="ARM64"):
        builder.validate_windows_arm_wheel(path, sha, "lancedb")
    with pytest.raises(ValueError):
        builder.validate_windows_arm_wheel(path, sha, "pyarrow")


def test_partial_arm_bundle_refused_before_output_creation(tmp_path):
    output = tmp_path / "new-bundle"
    with pytest.raises(ValueError, match="both ARM"):
        builder.build(output, arm_lancedb_wheel=tmp_path / "missing.whl")
    assert not output.exists()


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


class ArmNativeInstallerTests(fixtures.InstallerTests):
    def setUp(self):
        super().setUp()
        self.architecture = "ARM64"
        self.python_version = [3, 13, 15]
        self.implementation = "cpython"
        self.free_threaded = False
        self.files.update({ARM_LANCE: b"lance fixture", ARM_ARROW: b"arrow fixture"})
        self.write_bundle()
        self.set_native([ARM_LANCE, ARM_ARROW])

    def set_native(self, values):
        path = self.bundle / "distribution.json"
        manifest = json.loads(path.read_text())
        manifest["nativeDependencies"] = {"win32/ARM64": values}
        path.write_text(json.dumps(manifest))

    def fake_python(self, python, code, data=None):
        result = super().fake_python(python, code, data)
        if "sys.version_info" in code:
            info = json.loads(result)
            info.update(architecture=self.architecture, version=self.python_version,
                        implementation=self.implementation, freeThreaded=self.free_threaded)
            return json.dumps(info)
        return result

    def test_arm_pair_selected_only_for_matching_interpreter(self):
        from unittest.mock import patch
        with patch.object(installer.sys, "platform", "win32"):
            assert self.plan()["nativeWheels"] == [ARM_LANCE, ARM_ARROW]
            assert self.plan(dependencies=False)["nativeWheels"] == []
            assert self.plan(desktop_only=True)["nativeWheels"] == []
            self.architecture = "AMD64"
            assert self.plan()["nativeWheels"] == []

    def test_arm_python_abi_mismatch_refused_before_writes(self):
        from unittest.mock import patch
        with patch.object(installer.sys, "platform", "win32"):
            for version, implementation, free_threaded in (([3, 12, 10], "cpython", False),
                                                          ([3, 13, 15], "pypy", False),
                                                          ([3, 13, 15], "cpython", True)):
                self.python_version, self.implementation, self.free_threaded = version, implementation, free_threaded
                with pytest.raises(ValueError, match="Python 3.13"):
                    self.plan()
        assert not (self.home / "plur1bus-install-backups").exists()

    def test_incomplete_duplicate_foreign_or_unlisted_pair_refused(self):
        for values in ([ARM_LANCE], [ARM_ARROW, ARM_ARROW], [ARM_LANCE, RELATIVE],
                       [ARM_LANCE, "../../pyarrow.whl"], ARM_LANCE):
            self.set_native(values)
            with pytest.raises(ValueError, match="native dependency"):
                self.plan()
