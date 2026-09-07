"""Exercise the packaged CLI without source-tree imports masking missing files."""
import importlib.util
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

import pytest


DISTRIBUTION = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("artifact_verification", DISTRIBUTION / "verify.py")
verification = importlib.util.module_from_spec(SPEC)
with patch.object(sys, "path", [str(DISTRIBUTION), *sys.path]):
    SPEC.loader.exec_module(verification)


def test_missing_packaged_sibling_is_not_filled_from_pythonpath(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    source = tmp_path / "source"
    source.mkdir()
    (source / "only_source_helper.py").write_text("VALUE = 1\n", encoding="utf-8")
    monkeypatch.setenv("PYTHONPATH", str(source))
    (bundle / "installer.py").write_text("import only_source_helper\n", encoding="utf-8")
    with pytest.raises(subprocess.CalledProcessError):
        verification.verify_entrypoint(bundle)


def test_packaged_sibling_is_loaded_explicitly_from_bundle(tmp_path):
    (tmp_path / "installer.py").write_text(
        "import sys\nfrom pathlib import Path\n"
        "sys.path.insert(0, str(Path(__file__).resolve().parent))\n"
        "import bundled_helper\nassert bundled_helper.VALUE == 42\n"
        "assert sys.argv[1:] == ['--help']\n", encoding="utf-8")
    (tmp_path / "bundled_helper.py").write_text("VALUE = 42\n", encoding="utf-8")
    verification.verify_entrypoint(tmp_path)


def test_entrypoint_smoke_is_bounded_and_isolated(tmp_path):
    with patch.object(verification.subprocess, "run") as run:
        verification.verify_entrypoint(tmp_path)
    command = run.call_args.args[0]
    assert command == [sys.executable, "-I", str(tmp_path / "installer.py"), "--help"]
    assert run.call_args.kwargs["timeout"] == 30
    assert run.call_args.kwargs["check"] is True
