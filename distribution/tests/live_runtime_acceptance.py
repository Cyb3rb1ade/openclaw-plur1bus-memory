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


def supervisor_fixture(home, config):
    """Exercise stock owner-death handling through a disposable local plugin."""
    plugin = home / 'plugins/native-supervisor-fixture'
    plugin.mkdir(parents=True)
    (plugin / 'plugin.yaml').write_text('name: native-supervisor-fixture\nversion: "1.0.0"\ndescription: "Isolated lifecycle fixture"\n')
    (plugin / '__init__.py').write_text('''import json, os, subprocess
from pathlib import Path
from hermes_cli import process_identity
child = None
def register(ctx):
    global child
    if child is None:
        child = subprocess.Popen(['/bin/sleep', '300'], start_new_session=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        process_identity.own_process_groups([child.pid])
        (Path(__file__).parent / 'supervisor-witness.json').write_text(json.dumps({
            'ownerPid': os.getpid(), 'childPid': child.pid,
            'helper': process_identity.__file__,
            'supervisorPid': process_identity._supervisor.pid if process_identity._supervisor else None}))
''')
    config['plugins'] = {'enabled': ['native-supervisor-fixture']}


def verify_orphan_refusal(lifecycle, python, script, env):
    """An exact stock script with no live gateway owner must still block writes."""
    reader, writer = os.pipe()
    launch = '''import subprocess, sys
p = subprocess.Popen(['/bin/sh', sys.argv[2], sys.argv[3]], stdin=int(sys.argv[1]),
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
print(p.pid)
'''
    try:
        orphan = int(subprocess.check_output([python, '-I', '-B', '-c', launch,
                     str(reader), str(script), str(os.getpgid(0))], pass_fds=(reader,), env=env, text=True))
        os.close(reader)
        reader = None
        try:
            lifecycle.worker('inventory')
        except ValueError as error:
            if 'unclassified custom holder' not in str(error):
                raise
        else:
            raise AssertionError('orphan supervisor was accepted without its canonical owner')
    finally:
        if reader is not None:
            os.close(reader)
        os.close(writer)  # EOF only; the fixture never signals the safety net.
    wait = '''import psutil, sys, time
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    try:
        if psutil.Process(int(sys.argv[1])).status() == psutil.STATUS_ZOMBIE: break
    except psutil.NoSuchProcess: break
    time.sleep(.05)
else: raise SystemExit('fixture orphan failed to exit on EOF')
'''
    subprocess.run([python, '-I', '-B', '-c', wait, str(orphan)], env=env, check=True)


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
    if os.name == 'posix':
        supervisor_fixture(home, config)
    hashes = {}
    for target in [home, home / "profiles/alpha"]:
        target.mkdir(parents=True, exist_ok=True)
        path = target / "config.yaml"
        path.write_text(json.dumps(config))
        hashes[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    env = {k: os.environ[k] for k in ("PATH", "LANG", "TZ", "SYSTEMROOT", "WINDIR", "UV_CACHE_DIR") if k in os.environ}
    env.update(HOME=str(user), USERPROFILE=str(user), HERMES_HOME=str(home), HERMES_RUNTIME_DIR=str(sandbox / "runtime"),
               PYTHONDONTWRITEBYTECODE="1", PYTHONUNBUFFERED="1", OPENAI_API_KEY="loopback-fixture", OPENAI_BASE_URL="http://127.0.0.1:9/v1")
    # The controller and every resumed child inherit only this isolated context.
    os.environ.clear()
    os.environ.update(env)
    if os.name == 'posix':
        # A PM interpreter borrowed from --source imports that source's immutable
        # workspace before main.py can select this copy. Admit the actual fixture
        # checkout so its supervisor is genuinely owned by this installation.
        with (sandbox / 'gateway.log').open('ab') as log:
            subprocess.run([args.python, '-B', '-m', 'pm.cli', 'install', 'python', 'venv'],
                           cwd=project, env=env, stdout=log, stderr=log, check=True)
        key = hashlib.sha256(str(project).encode()).hexdigest()[:16]
        facts = json.loads((home / 'installs' / key / 'facts.json').read_text())
        selected = Path(facts['packages']['venv']['environment']).resolve(strict=True)
        if not selected.is_relative_to(home / 'installs' / key / 'environments'):
            raise RuntimeError('fixture PM selection belongs to another installation')
        args.python = str(selected / 'bin/python')
    receipt = sandbox / "runtime-receipt.json"
    lifecycle = RuntimeLifecycle(home, lambda: args.python,
        lambda state: receipt.write_text(json.dumps(state, indent=2)), lambda event: print(json.dumps(event), flush=True))
    with (sandbox / "gateway.log").open("ab") as log:
        proc = subprocess.Popen([args.python, "-B", str(project / "hermes_cli/main.py"), "gateway", "run", "--quiet"], cwd=project,
                                env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    original = []
    last_refusal = None
    try:
        deadline = time.monotonic() + 90
        while proc.poll() is None and time.monotonic() < deadline:
            try:
                original = lifecycle.worker("inventory")
                if len(original) == 1 and set(original[0]["served_profiles"]) == {"default", "alpha"}:
                    break
            except ValueError as error:
                last_refusal = str(error)  # Credential-free worker errors, retained if startup fails.
            time.sleep(.5)
        if not original or set(original[0]["served_profiles"]) != {"default", "alpha"}:
            raise RuntimeError("sandbox gateway did not become ready; last inventory refusal: " +
                               (last_refusal or "none") + "; see " + str(sandbox))
        if os.name == 'posix':
            assert original[0].get('ownerDeathSupervisors'), 'real gateway did not start its stock supervisor'
            fixture = json.loads((home / 'plugins/native-supervisor-fixture/supervisor-witness.json').read_text())
            assert fixture['ownerPid'] == original[0]['pid']
            assert fixture['supervisorPid'] in {row['pid'] for row in original[0]['ownerDeathSupervisors']}
            verify_orphan_refusal(lifecycle, args.python, Path(fixture['helper']).with_name('process_supervisor.sh'), env)
        lifecycle.pause()
        lifecycle.restore()
        restored = lifecycle.worker("inventory")
        assert len(restored) == 1 and restored[0]["pid"] != original[0]["pid"]
        assert set(restored[0]["served_profiles"]) == {"default", "alpha"}
        if os.name == 'posix':
            assert restored[0].get('ownerDeathSupervisors'), 'restored gateway did not own a new supervisor'
            assert {row['pid'] for row in original[0]['ownerDeathSupervisors']}.isdisjoint(
                row['pid'] for row in restored[0]['ownerDeathSupervisors'])
        assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == value for path, value in hashes.items())
        print(json.dumps({"status": "passed", "sandbox": str(sandbox), "originalPid": original[0]["pid"], "restoredPid": restored[0]["pid"], "configHashesUnchanged": True,
                          "fixturePmAdmission": os.name == 'posix',
                          "ownerDeathSupervisor": "stock-spawn-eof-reap-orphan-refusal-and-restore" if os.name == 'posix' else "not-applicable"}))
    except BaseException:
        # Only this script's still-running child tree; never argv/env/secrets or
        # host-wide discovery. Preserve native redirector/worker image evidence.
        witness = {"python": args.python, "project": str(project), "lastInventoryRefusal": last_refusal, "processes": []}
        try:
            import psutil
        except ImportError as error:
            witness["inspectionError"] = type(error).__name__
        else:
            try:
                if proc.poll() is None:
                    parent = psutil.Process(proc.pid)
                    for child in [parent, *parent.children(recursive=True)]:
                        witness["processes"].append({"pid": child.pid, "ppid": child.ppid(), "exe": child.exe(), "cwd": child.cwd()})
            except psutil.Error as error:
                witness["inspectionError"] = type(error).__name__
        (sandbox / "startup-witness.json").write_text(json.dumps(witness, indent=2))
        raise
    finally:
        # Every candidate was launched by this script inside this new home.
        # Never use a host-wide gateway stop or productive runtime directory.
        failed = sys.exc_info()[0] is not None
        try:
            for entry in lifecycle.worker("inventory"):
                lifecycle.worker("stop", entry)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            print("Fixture cleanup refused: " + str(error), file=sys.stderr, flush=True)
            if not failed:
                raise
        finally:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=30)
        print("Evidence retained: " + str(sandbox))


if __name__ == "__main__":
    main()
