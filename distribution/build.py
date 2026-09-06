#!/usr/bin/env python3
"""Build portable/plugin-only distribution; native packages are local, unsigned candidates."""
import argparse
import hashlib
import json
import importlib.metadata
from email.parser import BytesParser
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import tomllib
import zipfile

REPO = Path(__file__).resolve().parents[1]


def native_artifact_target(system=None, machine=None):
    """Return the release-asset target label for a supported native builder."""
    system = sys.platform if system is None else system
    machine = platform.machine() if machine is None else machine
    normalized = machine.lower()
    targets = {
        ("win32", "arm64"): "windows-arm64",
        ("win32", "amd64"): "windows-x64",
        ("win32", "x86_64"): "windows-x64",
        ("darwin", "arm64"): "macos-arm64",
        ("darwin", "aarch64"): "macos-arm64",
        ("darwin", "x86_64"): "macos-x86_64",
    }
    try:
        return targets[(system, normalized)]
    except KeyError as exc:
        raise ValueError(f"unsupported native build architecture: {system}/{machine}") from exc


def artifact_stem(name, native_target=None):
    """Keep portable artifact names stable while qualifying native candidates."""
    return name if native_target is None else f"{name}-{native_target}"


def tracked(prefix):
    output = subprocess.check_output(["git", "ls-files", "-z", "--", prefix], cwd=REPO)
    return [p.decode() for p in output.split(b"\0") if p]


def copy(source, target):
    if source.is_symlink() or not source.is_file():
        raise ValueError("only regular source files are distributable: " + str(source))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def validate_intel_wheel(path, expected_sha256):
    """Accept only an explicitly hash-approved LanceDB Intel ABI3 wheel."""
    path = Path(path)
    if (path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024 * 1024
        or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256 or "")
        or not re.fullmatch(r"lancedb-0\.34\.0-cp3\d+-abi3-macosx_\d+_\d+_x86_64\.whl", path.name)):
        raise ValueError("expected a hash-approved native LanceDB 0.34.0 Intel ABI3 wheel")
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected_sha256:
        raise ValueError("native wheel checksum differs from approved build")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("duplicate wheel members")
        metadata = "lancedb-0.34.0.dist-info/METADATA"
        tags_file = "lancedb-0.34.0.dist-info/WHEEL"
        for name in (metadata, tags_file):
            if archive.getinfo(name).file_size > 100_000:
                raise ValueError("oversized wheel metadata")
        info = BytesParser().parsebytes(archive.read(metadata))
        tags = BytesParser().parsebytes(archive.read(tags_file)).get_all("Tag")
        expected_tag = path.name.removeprefix("lancedb-0.34.0-").removesuffix(".whl")
        if info.get("Name") != "lancedb" or info.get("Version") != "0.34.0" or tags != [expected_tag]:
            raise ValueError("native wheel metadata/architecture mismatch")
    return path


def validate_windows_arm_wheel(path, expected_sha256, package):
    """Validate approved pinned ARM wheel identity and every bundled PE binary."""
    identities = {"lancedb": ("0.34.0", "cp39-abi3-win_arm64"),
                  "pyarrow": ("25.0.1", "cp313-cp313-win_arm64")}
    if package not in identities:
        raise ValueError("unsupported ARM native dependency")
    version, tag = identities[package]
    path = Path(path)
    if (path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024 * 1024
        or path.name != f"{package}-{version}-{tag}.whl"
        or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256 or "")):
        raise ValueError("expected a hash-approved pinned Windows ARM64 wheel")
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected_sha256:
        raise ValueError("native wheel checksum differs from approved build")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("duplicate wheel members")
        prefix = f"{package}-{version}.dist-info/"
        for name in (prefix + "METADATA", prefix + "WHEEL"):
            if archive.getinfo(name).file_size > 100_000:
                raise ValueError("oversized wheel metadata")
        info = BytesParser().parsebytes(archive.read(prefix + "METADATA"))
        tags = BytesParser().parsebytes(archive.read(prefix + "WHEEL")).get_all("Tag")
        if info.get("Name") != package or info.get("Version") != version or tags != [tag]:
            raise ValueError("native wheel metadata/architecture mismatch")
        binaries = [name for name in names if name.lower().endswith((".pyd", ".dll", ".exe"))]
        if not any(name.lower().endswith(".pyd") for name in binaries):
            raise ValueError("native ARM64 extension missing")
        for name in binaries:
            with archive.open(name) as stream:
                header = stream.read(64)
                if len(header) != 64 or header[:2] != b"MZ":
                    raise ValueError("invalid ARM64 PE header")
                offset = struct.unpack_from("<I", header, 0x3c)[0]
                if offset < 64 or offset > min(1024 * 1024, archive.getinfo(name).file_size - 6):
                    raise ValueError("invalid ARM64 PE offset")
                stream.seek(offset)
                pe = stream.read(6)
                if len(pe) != 6 or pe[:4] != b"PE\0\0" or struct.unpack_from("<H", pe, 4)[0] != 0xaa64:
                    raise ValueError("native binary is not Windows ARM64")
    return path


def build(output, mac_pkg=False, windows_exe=False, intel_wheel=None, intel_sha256=None,
          arm_lancedb_wheel=None, arm_lancedb_sha256=None, arm_pyarrow_wheel=None, arm_pyarrow_sha256=None):
    if mac_pkg and sys.platform != "darwin":
        raise ValueError("macOS pkg must be built and tested on macOS")
    if windows_exe and sys.platform != "win32":
        raise ValueError("Windows executable must be built and tested on Windows")
    native_target = native_artifact_target() if mac_pkg or windows_exe else None
    if bool(intel_wheel) != bool(intel_sha256):
        raise ValueError("native wheel path and approved SHA-256 must be supplied together")
    vendor = validate_intel_wheel(intel_wheel, intel_sha256) if intel_wheel else None
    arm_inputs = [arm_lancedb_wheel, arm_lancedb_sha256, arm_pyarrow_wheel, arm_pyarrow_sha256]
    if any(arm_inputs) and not all(arm_inputs):
        raise ValueError("both ARM native wheel paths and approved SHA-256 values are required")
    arm_vendors = []
    if all(arm_inputs):
        arm_vendors = [(validate_windows_arm_wheel(arm_lancedb_wheel, arm_lancedb_sha256, "lancedb"), arm_lancedb_sha256),
                       (validate_windows_arm_wheel(arm_pyarrow_wheel, arm_pyarrow_sha256, "pyarrow"), arm_pyarrow_sha256)]
    output = Path(output).absolute()
    if output.exists() and any(output.iterdir()):
        raise ValueError("use a new empty output directory; existing releases are never overwritten")
    output.mkdir(parents=True, exist_ok=True)
    version = json.loads((REPO / "package.json").read_text())["version"]
    name = "plur1bus-" + version
    release_stem = artifact_stem(name, native_target)
    work = Path(tempfile.mkdtemp(prefix="plur1bus-distribution-"))
    bundle = work / name
    bundle.mkdir()
    for filename in ("installer.py", "install.sh", "install.ps1", "Install PLUR1BUS.command", "README.md"):
        copy(REPO / "distribution" / filename, bundle / filename)
    (bundle / "install.sh").chmod(0o755)
    (bundle / "Install PLUR1BUS.command").chmod(0o755)
    for package, module, destination in (
        ("plur1bus-hermes", "plur1bus_hermes", "plugins/plur1bus"),
        ("plur1bus-controls", "plur1bus_controls", "plugins/plur1bus-controls"),
    ):
        source_root = package + "/src/" + module + "/"
        for relative in tracked(source_root):
            copy(REPO / relative, bundle / "payload" / destination / relative[len(source_root):])
        wheel_source = work / package
        for relative in tracked(package + "/"):
            if "/tests/" not in relative:
                copy(REPO / relative, wheel_source / relative[len(package) + 1:])
        subprocess.run([sys.executable, "-m", "pip", "wheel", "--no-deps", "--no-build-isolation",
                        "--wheel-dir", str(bundle / "wheels"), str(wheel_source)], check=True)
    for relative in tracked("hermes-dashboard/plur1bus/dashboard/"):
        copy(REPO / relative, bundle / "payload/plugins/plur1bus/dashboard" / relative.split("/dashboard/", 1)[1])
    copy(REPO / "hermes-dashboard/plur1bus/desktop/plugin.js", bundle / "payload/desktop-plugins/plur1bus/plugin.js")
    copy(REPO / "scripts/hermes-desktop-host.py", bundle / "helpers/plur1bus-desktop-host.py")
    for relative in tracked("hermes-dashboard/patches/"):
        copy(REPO / relative, bundle / "helpers/plur1bus-host-patches" / Path(relative).name)
    copy(REPO / "LICENSE", bundle / "LICENSE")
    for filename in ("hermes-snapshot-restore.md", "hermes-bge-onnx.md", "audits/hermes-completion-followup-2026-09-06.md"):
        copy(REPO / "docs" / filename, bundle / "docs" / filename)
    native_dependencies = {}
    if vendor:
        relative = "vendor/macos-x86_64/" + vendor.name
        copy(vendor, bundle / relative)
        # Detect a source-wheel replacement during the copy, before manifesting it.
        if hashlib.sha256((bundle / relative).read_bytes()).hexdigest() != intel_sha256:
            raise ValueError("native wheel changed while packaging")
        native_dependencies["darwin/x86_64"] = relative
    if arm_vendors:
        native_dependencies["win32/ARM64"] = []
        for arm_vendor, approved_hash in arm_vendors:
            relative = "vendor/windows-arm64/" + arm_vendor.name
            copy(arm_vendor, bundle / relative)
            if hashlib.sha256((bundle / relative).read_bytes()).hexdigest() != approved_hash:
                raise ValueError("native wheel changed while packaging")
            native_dependencies["win32/ARM64"].append(relative)
    if windows_exe:
        if sys.platform != "win32":
            raise ValueError("Windows executable must be built and tested on Windows")
        # The portable bundle needs no embedded Python; the .exe does. Include
        # the interpreter/bootloader redistribution notices in its embedded data.
        python_license = Path(sys.base_prefix) / "LICENSE.txt"
        copy(python_license, bundle / "licenses/Python-LICENSE.txt")
        package_metadata = importlib.metadata.distribution("pyinstaller")
        notices = [p for p in package_metadata.files or [] if Path(str(p)).name in {"COPYING.txt", "LICENSE", "LICENSE.txt"}]
        if not notices:
            raise ValueError("PyInstaller redistribution license missing")
        for number, notice in enumerate(notices):
            copy(Path(package_metadata.locate_file(notice)), bundle / "licenses" / ("PyInstaller-" + str(number) + "-" + Path(str(notice)).name))
    files = {p.relative_to(bundle).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(bundle.rglob("*")) if p.is_file()}
    manifest = {"schema": 1, "version": version,
                "pythonVersion": tomllib.loads((REPO / "plur1bus-hermes/pyproject.toml").read_text())["project"]["version"],
                "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
                "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO)), "files": files,
                "nativeDependencies": native_dependencies}
    (bundle / "distribution.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    # Deliberately no OpenClaw JS package/postinstall, provider credentials or models.
    shutil.make_archive(str(output / release_stem), "zip", work, name)
    shutil.make_archive(str(output / release_stem), "gztar", work, name)
    if mac_pkg:
        subprocess.run(["pkgbuild", "--root", str(bundle), "--install-location", "/Applications/PLUR1BUS Installer",
                        "--identifier", "io.plur1bus.hermes.installer", "--version", version.replace("-hermes", ""),
                        str(output / (release_stem + "-unsigned.pkg"))], check=True)
    if windows_exe:
        subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
                        "--name", release_stem + "-setup-unsigned", "--distpath", str(output), "--workpath", str(work / "pyinstaller"),
                        "--specpath", str(work), "--add-data", str(bundle) + ":.", str(bundle / "installer.py")], check=True)
    with zipfile.ZipFile(output / (release_stem + ".zip")) as archive:
        if not any(p.endswith("/distribution.json") for p in archive.namelist()):
            raise ValueError("bundle validation failed")
    sums = [hashlib.sha256(p.read_bytes()).hexdigest() + "  " + p.name for p in sorted(output.iterdir()) if p.is_file()]
    (output / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    print("Candidate artifacts: " + str(output))
    print("Expanded QA bundle retained: " + str(bundle))
    return bundle


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mac-pkg", action="store_true")
    parser.add_argument("--windows-exe", action="store_true")
    parser.add_argument("--intel-lancedb-wheel", help="native-tested LanceDB 0.34.0 Intel wheel from the reviewed build")
    parser.add_argument("--intel-lancedb-sha256", help="approved wheel SHA-256 from native CI provenance")
    parser.add_argument("--arm-lancedb-wheel", help="native-tested LanceDB 0.34.0 Windows ARM64 wheel")
    parser.add_argument("--arm-lancedb-sha256", help="approved LanceDB wheel SHA-256")
    parser.add_argument("--arm-pyarrow-wheel", help="native-tested PyArrow 25.0.1 CPython 3.13 Windows ARM64 wheel")
    parser.add_argument("--arm-pyarrow-sha256", help="approved PyArrow wheel SHA-256")
    args = parser.parse_args()
    build(args.output, args.mac_pkg, args.windows_exe, args.intel_lancedb_wheel, args.intel_lancedb_sha256,
          args.arm_lancedb_wheel, args.arm_lancedb_sha256, args.arm_pyarrow_wheel, args.arm_pyarrow_sha256)
