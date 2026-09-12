"""Native distribution assets are unique across release platforms."""
from __future__ import annotations

import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("distribution_build", ROOT / "distribution" / "build.py")
build = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = build
SPEC.loader.exec_module(build)


@pytest.mark.parametrize(("system", "machine", "target"), [
    ("win32", "ARM64", "windows-arm64"),
    ("win32", "AMD64", "windows-x64"),
    ("darwin", "arm64", "macos-arm64"),
    ("darwin", "x86_64", "macos-x86_64"),
])
def test_native_artifact_names_are_platform_qualified(system, machine, target):
    assert build.native_artifact_target(system, machine) == target
    stem = build.artifact_stem("plur1bus-7.12.0-hermes.2", target)
    assert stem == f"plur1bus-7.12.0-hermes.2-{target}"
    assert stem + ".zip" != "plur1bus-7.12.0-hermes.2.zip"
    assert stem + ".tar.gz" != "plur1bus-7.12.0-hermes.2.tar.gz"
    assert stem + "-setup-unsigned.exe" == f"plur1bus-7.12.0-hermes.2-{target}-setup-unsigned.exe"
    assert stem + "-unsigned.pkg" == f"plur1bus-7.12.0-hermes.2-{target}-unsigned.pkg"


def test_portable_artifact_name_remains_unqualified():
    stem = build.artifact_stem("plur1bus-7.12.0-hermes.2")
    assert stem == "plur1bus-7.12.0-hermes.2"
    assert stem + ".zip" == "plur1bus-7.12.0-hermes.2.zip"
    assert stem + ".tar.gz" == "plur1bus-7.12.0-hermes.2.tar.gz"


@pytest.mark.parametrize(("system", "machine"), [
    ("win32", "x86"),
    ("darwin", "ppc64"),
    ("linux", "x86_64"),
])
def test_unsupported_native_builder_architecture_fails_closed(system, machine):
    with pytest.raises(ValueError, match="unsupported native build architecture"):
        build.native_artifact_target(system, machine)


def test_portable_bundle_ships_identical_unified_and_materialized_desktop(tmp_path, monkeypatch):
    """Build the real archive/manifest with only the wheel compiler stubbed."""
    repo = tmp_path / "repo"
    files = {
        "package.json": '{"version":"7.12.53-hermes.0"}',
        "plur1bus-hermes/pyproject.toml": '[project]\nversion = "7.12.53.post0"\n',
        "plur1bus-hermes/src/plur1bus_hermes/__init__.py": "# provider\n",
        "plur1bus-controls/pyproject.toml": '[project]\nversion = "7.12.53.post0"\n',
        "plur1bus-controls/src/plur1bus_controls/__init__.py": "# controls\n",
        "hermes-dashboard/plur1bus/dashboard/plugin_api.py": "# backend\n",
        "hermes-dashboard/plur1bus/desktop/plugin.js": "export default {id: 'plur1bus'};\n",
        "hermes-dashboard/plur1bus/desktop/test-harness.mjs": "must not ship",
        "hermes-dashboard/plur1bus/desktop/__pycache__/junk.pyc": "must not ship",
        "scripts/hermes-desktop-host.py": "# helper\n",
        "LICENSE": "fixture license\n",
    }
    for name in ("installer.py", "native_launcher.py", "install.sh", "install.ps1",
                 "Install PLUR1BUS.command", "README.md", "INSTALLATION.de.md"):
        files["distribution/" + name] = "# fixture\n"
    for name in ("hermes-snapshot-restore.md", "hermes-bge-onnx.md", "audits/hermes-completion-followup-2026-09-06.md"):
        files["docs/" + name] = "fixture documentation\n"
    for name, data in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data, encoding="utf-8")
    monkeypatch.setattr(build, "REPO", repo)
    monkeypatch.setattr(build, "tracked", lambda prefix: [name for name in files if name.startswith(prefix)])
    monkeypatch.setattr(build.subprocess, "check_output",
                        lambda args, **kwargs: "fixture-commit" if "rev-parse" in args else b"")

    def wheel(args, **kwargs):
        assert "wheel" in args
        output = Path(args[args.index("--wheel-dir") + 1])
        output.mkdir(exist_ok=True)
        (output / (Path(args[-1]).name.replace("-", "_") + "-7.12.53.post0-py3-none-any.whl")).write_bytes(b"fixture wheel")
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(build.subprocess, "run", wheel)
    output = tmp_path / "output"
    build.build(output)
    with zipfile.ZipFile(next(output.glob("*.zip"))) as archive:
        prefix = "plur1bus-7.12.53-hermes.0/"
        manifest = json.loads(archive.read(prefix + "distribution.json"))
        unified = "payload/plugins/plur1bus/desktop/plugin.js"
        materialized = "payload/desktop-plugins/plur1bus/plugin.js"
        assert archive.read(prefix + unified) == archive.read(prefix + materialized)
        assert manifest["files"][unified] == manifest["files"][materialized]
        assert manifest["files"][unified] == hashlib.sha256(archive.read(prefix + unified)).hexdigest()
        assert not any("__pycache__" in name or "test-harness" in name for name in archive.namelist())
