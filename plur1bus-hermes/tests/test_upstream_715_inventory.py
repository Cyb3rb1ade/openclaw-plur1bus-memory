"""Source integration gate, deliberately not a native feature-completion claim."""
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]
TARGET = "8c29aeab9e03691d3a07e31756b3f23addf9bba1"
BASE = "784e900541fddb1d13a75104b6570e52051fd82c"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def test_complete_commit_and_file_inventory():
    subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)
    paths = git("diff", "--name-only", BASE, TARGET).splitlines()
    commits = git("log", "--no-merges", "--format=%h", BASE + ".." + TARGET).splitlines()
    assert len(paths) == 38 and len(commits) == 15
    review = (ROOT / "docs/audits/hermes-7.15.0-delta-review.md").read_text()
    assert all("`" + path + "`" in review for path in paths)
    assert all(commit in review for commit in commits)
    for path in paths:
        if path == "tests/release-750-compat.test.js":
            continue  # Hermes version is independently pinned in the .747 gate.
        if path.startswith(("lib/", "tests/", "scripts/")) or path == "index.js":
            expected = "v7.15.4"
            assert (ROOT / path).read_text() == git("show", expected + ":" + path), path
