"""Package verification follows supported native provider dependencies."""
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from verify import dependency_modules


@pytest.mark.parametrize("system,architecture,transformers", [
    ("win32", "ARM64", False), ("darwin", "x86_64", False),
    ("win32", "AMD64", True), ("darwin", "arm64", True),
    ("linux", "x86_64", True), ("linux", "aarch64", True),
])
def test_provider_imports_match_platform(system, architecture, transformers):
    modules = dependency_modules(system, architecture)
    assert ("sentence_transformers" in modules) is transformers
    assert {"lancedb", "numpy", "onnxruntime", "tokenizers", "certifi"} <= set(modules)
