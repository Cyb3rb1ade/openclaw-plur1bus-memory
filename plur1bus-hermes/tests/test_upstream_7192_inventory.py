"""Bind the Hermes port and exact upstream runtime files to the release tag."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
BASE = "0c07263da42e169a8e1245eb2882a6be2a2552a0"
TARGET = "3c42b39ba8d5a6522e9201c26c3cad267590636d"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def test_exact_7192_delta_is_retained():
    subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)
    paths = git("diff", "--name-only", BASE, TARGET).splitlines()
    commits = git("log", "--no-merges", "--format=%h", BASE + ".." + TARGET).splitlines()
    review = (ROOT / "docs/audits/hermes-7.19.2-delta-review.md").read_text(encoding="utf-8")
    assert len(paths) == 158 and len(commits) == 38 and TARGET in review
    assert all(f"`{entry}`" in review for entry in paths + commits)
    for path in paths:
        if path == "tests/release-750-compat.test.js":
            continue
        if path == "index.js" or path.startswith((".openclaw/", "dist/control-ui/", "lib/", "scripts/", "tests/")):
            assert (ROOT / path).read_text(encoding="utf-8") == git("show", TARGET + ":" + path), path
