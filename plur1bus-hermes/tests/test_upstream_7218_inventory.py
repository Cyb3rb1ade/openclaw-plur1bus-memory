"""Verify the active OpenClaw sources retained by the Hermes release."""
from functools import lru_cache
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[2]
UPSTREAM_BASE = "5a427be86ecab36a9f725974f980f01fa85e3312"  # v7.20.2
UPSTREAM_HEAD = "b154a28e7f842e9df610cff2ad81f96daefc2ded"
SOURCE_PATHS = ("index.js", "adapter/openclaw", "lib", "scripts", "tests", "test", ".openclaw", "dist/control-ui")
# Hermes pack exclusions, version assertions and an upstream trailing blank.
REVIEWED_JS_BLOBS = {
    "scripts/lib/deploy-integrity.mjs": "2255414cd747dbb0f5b19925f265dae62f04364a",
    "tests/db-adapter-timeouts.test.js": "019aa6650d7b272a13d3acdcdde53e2a34532f7b",
    "tests/dev-openclaw-pin.test.js": "1d38a00442421576e4b013250db994977a8212e8",
    "tests/release-750-compat.test.js": "dd89060e68286d56fc56674b967a5f5ab6ceb7a2",
}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def historical_commits(base, head):
    """Use the eight-character commit IDs written in the historical audits."""
    commits = git("log", "--no-merges", "--format=%H", f"{base}..{head}").splitlines()
    return [commit[:8] for commit in commits]


@lru_cache(maxsize=1)
def upstream_delta():
    """Pin additions and deletions separately, including both ends of a move."""
    changed = git("diff", "--name-status", "--no-renames", "-z", UPSTREAM_BASE, UPSTREAM_HEAD,
                  "--", *SOURCE_PATHS).split("\0")
    assert changed.pop() == ""
    assert len(changed) % 2 == 0
    return {path: status for status, path in zip(changed[::2], changed[1::2])}


@lru_cache(maxsize=1)
def upstream_blobs():
    """Load canonical blob IDs once for use by all the retained inventories."""
    entries = git("ls-tree", "-r", "-z", UPSTREAM_HEAD, "--", *SOURCE_PATHS).split("\0")
    result = {}
    for entry in filter(None, entries):
        metadata, path = entry.split("\t", 1)
        _mode, kind, digest = metadata.split()
        assert kind == "blob", path
        result[path] = digest
    return result


def assert_active_upstream_file(path):
    """Check the exact current source blob or an explicitly upstream-deleted path."""
    if upstream_delta().get(path) == "D":
        candidate = ROOT / path
        assert not candidate.exists() and not candidate.is_symlink(), path
        return
    expected = REVIEWED_JS_BLOBS.get(path, upstream_blobs()[path])
    # Windows autocrlf is normalized by Git's clean conversion, not by
    # decoding the blob as text and ignoring whitespace or binary changes.
    assert git("hash-object", "--path=" + path, path).strip() == expected, path


def test_current_upstream_release_is_retained_at_exact_pin():
    assert git("rev-parse", "v7.21.8^{}").strip() == UPSTREAM_HEAD
    for target in (UPSTREAM_BASE, UPSTREAM_HEAD):
        subprocess.run(["git", "merge-base", "--is-ancestor", target, "HEAD"], cwd=ROOT, check=True)
    assert upstream_delta()
    assert all(re.fullmatch(r"[ADMT]", status) for status in upstream_delta().values())


def test_active_upstream_delta_includes_moves_and_deletions():
    for path, status in upstream_delta().items():
        if status == "D":
            assert_active_upstream_file(path)
    upstream_delta_paths = [path for path in upstream_delta() if path not in REVIEWED_JS_BLOBS]
    # One Git diff covers both file modes and canonical blob content, including
    # the new OpenClaw adapter after upstream moved the entry point out of index.js.
    diff = git("diff", "--name-only", "--no-renames", UPSTREAM_HEAD, "--", *upstream_delta_paths)
    assert not diff, diff


def test_package_adaptations_match_reviewed_blobs():
    assert REVIEWED_JS_BLOBS.keys() <= upstream_blobs().keys()
    for path in REVIEWED_JS_BLOBS:
        assert_active_upstream_file(path)
