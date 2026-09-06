#!/usr/bin/env python3
"""Build portable/plugin-only distribution; native packages are local, unsigned candidates."""
import argparse
import hashlib
import json
import importlib.metadata
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile

REPO = Path(__file__).resolve().parents[1]


def tracked(prefix):
    output = subprocess.check_output(["git", "ls-files", "-z", "--", prefix], cwd=REPO)
    return [p.decode() for p in output.split(b"\0") if p]


def copy(source, target):
    if source.is_symlink() or not source.is_file():
        raise ValueError("only regular source files are distributable: " + str(source))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def build(output, mac_pkg=False, windows_exe=False):
    output = Path(output).absolute()
    if output.exists() and any(output.iterdir()):
        raise ValueError("use a new empty output directory; existing releases are never overwritten")
    output.mkdir(parents=True, exist_ok=True)
    version = json.loads((REPO / "package.json").read_text())["version"]
    name = "plur1bus-" + version
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
                "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO)), "files": files}
    (bundle / "distribution.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    # Deliberately no OpenClaw JS package/postinstall, provider credentials or models.
    shutil.make_archive(str(output / name), "zip", work, name)
    shutil.make_archive(str(output / name), "gztar", work, name)
    if mac_pkg:
        if sys.platform != "darwin":
            raise ValueError("macOS pkg must be built on macOS")
        subprocess.run(["pkgbuild", "--root", str(bundle), "--install-location", "/Applications/PLUR1BUS Installer",
                        "--identifier", "io.plur1bus.hermes.installer", "--version", version.replace("-hermes", ""),
                        str(output / (name + "-macos-unsigned.pkg"))], check=True)
    if windows_exe:
        if sys.platform != "win32":
            raise ValueError("Windows executable must be built and tested on Windows")
        subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
                        "--name", name + "-setup-unsigned", "--distpath", str(output), "--workpath", str(work / "pyinstaller"),
                        "--specpath", str(work), "--add-data", str(bundle) + ":.", str(bundle / "installer.py")], check=True)
    with zipfile.ZipFile(output / (name + ".zip")) as archive:
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
    args = parser.parse_args()
    build(args.output, args.mac_pkg, args.windows_exe)
