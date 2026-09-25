"""Complete upstream delta retained; native parity is separately documented."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
TARGET = "f23867a1de5cd5a8b94370b5172d497fad4f2427"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def test_upstream_7169_inventory_and_source():
    subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)
    paths = git("diff", "--name-only", "v7.15.4", TARGET).splitlines()
    commits = git("log", "--no-merges", "--format=%h", "v7.15.4.." + TARGET).splitlines()
    assert len(paths) == 36 and len(commits) == 15
    review = (ROOT / "docs/audits/hermes-7.16.9-delta-review.md").read_text()
    assert TARGET in review
    assert all(commit in review for commit in commits)
    for path in paths:
        assert "`" + path + "`" in review
        if path == "tests/release-750-compat.test.js":
            continue
        if path.startswith(("lib/", "tests/", "scripts/")) or path == "index.js":
            assert (ROOT / path).read_text() == git("show", TARGET + ":" + path), path
