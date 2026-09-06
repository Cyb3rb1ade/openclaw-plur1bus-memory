#!/usr/bin/env python3
"""Cross-platform candidate build gate, with no publishing or production install."""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

from build import build, REPO
from verify import verify


def main():
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(str(REPO / name / "src") for name in ("plur1bus-hermes", "plur1bus-controls"))
    subprocess.run([sys.executable, "-m", "pytest", "-q", "plur1bus-hermes/tests", "plur1bus-controls/tests",
                    "distribution/tests"], cwd=REPO, env=environment, check=True)
    output = REPO / "distribution-artifacts"
    bundle = build(output, mac_pkg=sys.platform == "darwin", windows_exe=sys.platform == "win32")
    executable = next(output.glob("*.exe")) if sys.platform == "win32" else None
    verify(bundle, executable)
    # Evidence is uploaded alongside, not folded into checksums of package files.
    (output / "verification.json").write_text(json.dumps({
        "platform": sys.platform, "architecture": platform.machine(), "python": sys.version,
        "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
        "gates": ["python-regressions", "bundle-checksums", "real-wheel-install", "real-lancedb-stub-embedding-smoke", "file-rollback"],
        "nativeExecutableSmoke": bool(executable), "published": False, "signed": False,
    }, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
