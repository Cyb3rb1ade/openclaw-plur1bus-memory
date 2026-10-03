"""Require the complete current upstream delta, not only release headlines."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
TARGET = "9cc5f833b188d8299000faeb94bd0b2015e6217b"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def test_complete_upstream_7184_delta():
    subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)
    paths = git("diff", "--name-only", "v7.16.9", TARGET).splitlines()
    commits = git("log", "--no-merges", "--format=%h", "v7.16.9.." + TARGET).splitlines()
    assert len(paths) == 46 and len(commits) == 18
    review = (ROOT / "docs/audits/hermes-7.18.4-delta-review.md").read_text()
    assert TARGET in review
    assert all("`" + commit + "`" in review for commit in commits)
    for path in paths:
        assert "`" + path + "`" in review
        if path == "tests/release-750-compat.test.js":
            continue
        if path.startswith(("lib/", "tests/", "scripts/")) or path in {"index.js", "test/memory-edit.test.js"}:
            assert (ROOT / path).read_text() == git("show", TARGET + ":" + path), path
