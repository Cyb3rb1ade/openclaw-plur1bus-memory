#!/usr/bin/env python3
"""Reapply the built frozen installer in the already admitted ARM PM fixture."""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(os.environ['PLUR1BUS_PM_QA_ROOT']).resolve(strict=True)
home = root / 'home'
output = Path(os.environ['PLUR1BUS_PM_ARTIFACT_ROOT'])
bundle = Path(os.environ['PLUR1BUS_PM_BUNDLE'])
manifest = json.loads((bundle / 'distribution.json').read_text(encoding='utf-8'))
exe = output / ('plur1bus-' + manifest['version'] + '-windows-arm64-setup-unsigned.exe')
allowed = {'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'}
env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
profile = root / 'runner-profile'
env.update(HOME=str(profile), USERPROFILE=str(profile), HOMEDRIVE=profile.drive, HOMEPATH=str(profile)[len(profile.drive):], HERMES_HOME=str(home), HERMES_RUNTIME_DIR=str(root / 'runtime'),
           APPDATA=str(root / 'AppData/Roaming'), LOCALAPPDATA=str(root / 'AppData/Local'), UV_CACHE_DIR=str(root / 'uv-cache'))
base = [str(exe), '--home', str(home), '--profile', 'default', '--profile', 'qa-second', '--activate']
plan = json.loads(subprocess.check_output(base, env=env, text=True))
result = subprocess.run([*base, '--apply', '--confirm', plan['confirmation'], '--stop-runtimes', '--progress'],
                        env=env, text=True, capture_output=True)
(output / 'native-frozen-reapply.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
result.check_returncode()
events = [json.loads(line.removeprefix('PLUR1BUS_PROGRESS ')) for line in result.stderr.splitlines()
          if line.startswith('PLUR1BUS_PROGRESS ')]
outcomes = [event for event in events if event.get('phase') == 'installation-outcome']
if len(outcomes) != 1 or outcomes[0].get('status') != 'installed-restored':
    raise RuntimeError('frozen executable did not finish managed installation and restoration')
receipt = Path(outcomes[0]['receipt']).resolve(strict=True)
if not receipt.is_relative_to(home.resolve()):
    raise RuntimeError('receipt escaped isolated QA home')
journal = json.loads((receipt / 'journal.json').read_text(encoding='utf-8'))
if journal.get('status') != 'installed-restored':
    raise RuntimeError('managed lifecycle receipt does not retain restored state')
(output / 'native-frozen-reapply.json').write_text(json.dumps({
    'schema': 1, 'status': 'passed', 'packageSourceCommit': manifest['sourceCommit'],
    'outcome': 'installed-restored', 'retainedReceipt': True, 'profiles': ['default', 'qa-second'],
    'executable': exe.name, 'log': 'native-frozen-reapply.log',
}, indent=2) + '\n', encoding='utf-8')
