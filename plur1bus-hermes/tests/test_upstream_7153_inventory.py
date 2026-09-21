"""Pin all .15.1–.15.3 upstream runtime changes without calling native parity complete."""
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]
TARGET = "51c49a52ae001ed6ea5440e625bbf77ae2115af7"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def test_complete_upstream_delta_and_documentation():
    subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)
    paths = git("diff", "--name-only", "v7.15.0", TARGET).splitlines()
    commits = git("log", "--no-merges", "--format=%h", "v7.15.0.." + TARGET).splitlines()
    assert len(paths) == 21 and len(commits) == 9
    review = (ROOT / "docs/audits/hermes-7.15.3-delta-review.md").read_text()
    assert TARGET in review
    for path in paths:
        assert "`" + path + "`" in review
        if path == "tests/release-750-compat.test.js":
            continue
        if path.startswith(("lib/", "tests/")) or path == "index.js":
            assert (ROOT / path).read_text() == git("show", TARGET + ":" + path), path
    assert all(commit in review for commit in commits)
