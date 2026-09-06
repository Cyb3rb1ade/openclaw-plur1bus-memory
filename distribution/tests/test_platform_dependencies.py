"""Native ONNX targets must not resolve an unavailable torch/NumPy wheel."""
from pathlib import Path
import tomllib

from packaging.markers import default_environment
from packaging.requirements import Requirement
import pytest

PROJECT = tomllib.loads((Path(__file__).resolve().parents[2] / "plur1bus-hermes/pyproject.toml").read_text())["project"]


@pytest.mark.parametrize("platform,machine,numpy,torch", [
    ("win32", "ARM64", "2.3.0", False),
    ("win32", "AMD64", "2.2.0", True),
    ("darwin", "x86_64", "2.2.0", False),
    ("darwin", "arm64", "2.2.0", True),
    ("linux", "aarch64", "2.2.0", True),
    ("linux", "x86_64", "2.2.0", True),
])
def test_native_platform_requirements(platform, machine, numpy, torch):
    environment = {**default_environment(), "sys_platform": platform, "platform_machine": machine}
    requirements = [Requirement(item) for item in PROJECT["dependencies"]]
    selected = {item.name: item for item in requirements if item.marker is None or item.marker.evaluate(environment)}
    assert ("sentence-transformers" in selected) is torch
    assert str(selected["numpy"].specifier) == "==" + numpy
    assert str(selected["lancedb"].specifier) == "==0.34.0"


def test_explicit_provider_extras_remain_available():
    onnx = {Requirement(item).name for item in PROJECT["optional-dependencies"]["local-onnx"]}
    assert {"onnxruntime", "tokenizers"} <= onnx
    transformers = {Requirement(item).name for item in PROJECT["optional-dependencies"]["local-transformers"]}
    assert "sentence-transformers" in transformers
