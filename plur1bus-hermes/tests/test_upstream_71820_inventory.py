"""Keep the complete released upstream delta in the Hermes candidate."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
TARGET = "0c07263da42e169a8e1245eb2882a6be2a2552a0"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def test_all_71820_commits_and_runtime_paths_are_retained():
    subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)
    paths = git("diff", "--name-only", "v7.18.4", TARGET).splitlines()
    commits = git("log", "--no-merges", "--format=%h", "v7.18.4.." + TARGET).splitlines()
    assert len(paths) == 51 and len(commits) == 16
    review = (ROOT / "docs/audits/hermes-7.18.20-delta-review.md").read_text()
    assert TARGET in review
    assert all("`" + item + "`" in review for item in paths + commits)
    for path in paths:
        if path == "tests/release-750-compat.test.js":
            continue
        if path.startswith(("lib/", "tests/", "scripts/")) or path == "index.js":
            assert (ROOT / path).read_text() == git("show", TARGET + ":" + path), path
