#!/usr/bin/env python3
"""Opt-in real Hermes multiplex lifecycle in a NEW isolated temporary home.

Usage: python live_runtime_acceptance.py --source /path/to/hermes-agent --python /path/to/hermes/python
Copies tracked Hermes source (read-only), uses loopback-only model configuration,
and never adopts an existing home. No productive process is inspected or stopped.
The temporary directory is retained for acceptance evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_lifecycle import RuntimeLifecycle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--sandbox-parent", help="existing isolated parent for the newly created fixture")
    args = parser.parse_args()
    source = Path(args.source).resolve()
    sandbox = Path(tempfile.mkdtemp(prefix="plur1bus-runtime-acceptance-", dir=args.sandbox_parent)).resolve()
    home = sandbox / "state"
    project = home / "hermes-agent"
    project.mkdir(parents=True)
    user = sandbox / "user"
    user.mkdir()
    files = subprocess.check_output(["git", "ls-files", "-z"], cwd=source).decode().split("\0")
    for name in filter(None, files):
        original = source / name
        if not original.is_file() or original.is_symlink():
            continue
        dest = project / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, dest)
    config = {"gateway": {"multiplex_profiles": True}, "model": {"provider": "custom", "default": "loopback-only", "base_url": "http://127.0.0.1:9/v1"}, "auxiliary": {"title_generation": {"enabled": False}}}
    hashes = {}
    for target in [home, home / "profiles/alpha"]:
        target.mkdir(parents=True, exist_ok=True)
        path = target / "config.yaml"
        path.write_text(json.dumps(config))
        hashes[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    env = {k: os.environ[k] for k in ("PATH", "LANG", "TZ", "SYSTEMROOT", "WINDIR") if k in os.environ}
    env.update(HOME=str(user), USERPROFILE=str(user), HERMES_HOME=str(home), HERMES_RUNTIME_DIR=str(sandbox / "runtime"),
               PYTHONDONTWRITEBYTECODE="1", PYTHONUNBUFFERED="1", OPENAI_API_KEY="loopback-fixture", OPENAI_BASE_URL="http://127.0.0.1:9/v1")
    # The controller and every resumed child inherit only this isolated context.
    os.environ.clear()
    os.environ.update(env)
    receipt = sandbox / "runtime-receipt.json"
    lifecycle = RuntimeLifecycle(home, lambda: args.python,
        lambda state: receipt.write_text(json.dumps(state, indent=2)), lambda event: print(json.dumps(event), flush=True))
    with (sandbox / "gateway.log").open("ab") as log:
        proc = subprocess.Popen([args.python, "-B", str(project / "hermes_cli/main.py"), "gateway", "run", "--quiet"], cwd=project,
                                env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    original = []
    try:
        deadline = time.monotonic() + 90
        while proc.poll() is None and time.monotonic() < deadline:
            try:
                original = lifecycle.worker("inventory")
                if len(original) == 1 and set(original[0]["served_profiles"]) == {"default", "alpha"}:
                    break
            except ValueError:
                pass  # startup is not yet ready; bounded below, log retained
            time.sleep(.5)
        if not original or set(original[0]["served_profiles"]) != {"default", "alpha"}:
            raise RuntimeError("sandbox gateway did not become ready; see " + str(sandbox))
        lifecycle.pause()
        lifecycle.restore()
        restored = lifecycle.worker("inventory")
        assert len(restored) == 1 and restored[0]["pid"] != original[0]["pid"]
        assert set(restored[0]["served_profiles"]) == {"default", "alpha"}
        assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == value for path, value in hashes.items())
        print(json.dumps({"status": "passed", "sandbox": str(sandbox), "originalPid": original[0]["pid"], "restoredPid": restored[0]["pid"], "configHashesUnchanged": True}))
    finally:
        # Every candidate was launched by this script inside this new home.
        # Never use a host-wide gateway stop or productive runtime directory.
        try:
            for entry in lifecycle.worker("inventory"):
                lifecycle.worker("stop", entry)
        finally:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=30)
        print("Evidence retained: " + str(sandbox))


if __name__ == "__main__":
    main()
