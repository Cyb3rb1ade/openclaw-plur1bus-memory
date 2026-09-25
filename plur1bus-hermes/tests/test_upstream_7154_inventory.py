"""Exact .15.4 source gate, distinct from native GC-capacity feature parity."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
TARGET = "89148f9f604a27149094efbc7cd910a7d362a94a"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def test_complete_7154_delta_is_retained_and_documented():
    subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)
    paths = git("diff", "--name-only", "v7.15.3", TARGET).splitlines()
    commits = git("log", "--no-merges", "--format=%h", "v7.15.3.." + TARGET).splitlines()
    assert len(paths) == 15 and len(commits) == 4
    review = (ROOT / "docs/audits/hermes-7.15.4-delta-review.md").read_text()
    assert TARGET in review
    for path in paths:
        assert "`" + path + "`" in review
        if path == "tests/release-750-compat.test.js":
            continue
        if path.startswith(("lib/", "tests/")) or path == "index.js":
            assert (ROOT / path).read_text() == git("show", "v7.16.9:" + path), path
    assert all(commit in review for commit in commits)


def test_native_settings_do_not_claim_unsupported_gc_capacity():
    from types import SimpleNamespace
    import pytest
    from plur1bus_hermes.settings_admin import BOOLEANS, validate_change
    assert "gc.maxMemoryCount" not in BOOLEANS
    with pytest.raises(ValueError):
        validate_change(SimpleNamespace(config={}), "gc.maxMemoryCount", 1)
