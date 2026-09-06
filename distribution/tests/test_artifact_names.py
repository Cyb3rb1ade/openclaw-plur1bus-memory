"""Native distribution assets are unique across release platforms."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

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
