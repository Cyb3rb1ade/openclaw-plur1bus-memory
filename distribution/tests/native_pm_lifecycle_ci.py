#!/usr/bin/env python3
"""Real isolated Hermes PM bootstrap and gateway lifecycle CI evidence."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

REVISION = 'ea4d2379167af59b23c93b8ff383c9014bd71c08'
REPO = Path(__file__).resolve().parents[2]


def run(command, *, cwd, env, log):
    with log.open('ab') as output:
        subprocess.run(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, check=True)


def main():
    output = REPO / 'distribution-artifacts'
    output.mkdir(exist_ok=True)
    log = output / 'native-pm-lifecycle.log'
    root = Path(tempfile.mkdtemp(prefix='plur1bus-pm-lifecycle-')).resolve()
    home = root / 'home'
    source = home / 'hermes-agent'
    source.mkdir(parents=True)
    user = root / 'user'
    user.mkdir()
    allowed = {'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LANG', 'TZ', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env.update(HOME=str(user), USERPROFILE=str(user), APPDATA=str(user / 'AppData/Roaming'),
               LOCALAPPDATA=str(user / 'AppData/Local'), HERMES_HOME=str(home),
               HERMES_RUNTIME_DIR=str(root / 'runtime'), UV_CACHE_DIR=str(root / 'uv-cache'),
               PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1')
    if os.name == 'nt':
        env.update(HOMEDRIVE=user.drive, HOMEPATH=str(user)[len(user.drive):])
    for command in (["git", "init", "--quiet"], ["git", "config", "core.autocrlf", "false"],
                    ["git", "remote", "add", "origin", "https://github.com/NousResearch/hermes-agent.git"],
                    ["git", "fetch", "--quiet", "--depth", "1", "origin", REVISION],
                    ["git", "checkout", "--quiet", "--detach", REVISION]):
        run(command, cwd=source, env=env, log=log)
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, env=env, text=True).strip()
    if actual != REVISION or subprocess.check_output(['git', 'status', '--porcelain'], cwd=source, env=env).strip():
        raise RuntimeError('Hermes source pin or cleanliness mismatch')
    run([sys.executable, '-m', 'pm.cli', 'install', 'python', 'venv'], cwd=source, env=env, log=log)
    key = hashlib.sha256(str(source).encode('utf-8')).hexdigest()[:16]
    install = home / 'installs' / key
    facts = json.loads((install / 'facts.json').read_text(encoding='utf-8'))
    selected = Path(facts['packages']['venv']['environment']).resolve(strict=True)
    if not selected.is_relative_to((install / 'environments').resolve()) or not (selected / 'pyvenv.cfg').is_file():
        raise RuntimeError('PM interpreter is outside isolated QA generation')
    python = selected / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.is_file():
        raise RuntimeError('PM interpreter missing')
    result = subprocess.run([sys.executable, str(REPO / 'distribution/tests/live_runtime_acceptance.py'),
                             '--source', str(source), '--python', str(python)],
                            cwd=REPO, env=env, capture_output=True, text=True)
    with log.open('a', encoding='utf-8') as handle:
        handle.write(result.stdout + result.stderr)
    result.check_returncode()
    records = []
    for line in result.stdout.splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    passed = [item for item in records if isinstance(item, dict) and item.get('status') == 'passed']
    if len(passed) != 1 or passed[0].get('configHashesUnchanged') is not True:
        raise RuntimeError('gateway lifecycle evidence missing')
    sandbox = Path(passed[0]['sandbox'])
    for name in ('gateway.log', 'runtime-receipt.json'):
        candidate = sandbox / name
        if candidate.is_file():
            (output / ('native-pm-' + name)).write_bytes(candidate.read_bytes())
    evidence = {'schema': 1, 'status': 'passed', 'sourceCommit': actual,
                'packageSourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
                'profiles': ['default', 'alpha'], 'originalPid': passed[0]['originalPid'],
                'restoredPid': passed[0]['restoredPid'], 'configHashesUnchanged': True,
                'pmBootstrap': 'install python venv', 'log': 'native-pm-lifecycle.log'}
    (output / 'native-pm-lifecycle.json').write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
