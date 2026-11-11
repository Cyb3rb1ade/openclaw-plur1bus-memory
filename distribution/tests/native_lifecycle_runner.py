#!/usr/bin/env python3
"""Run the live lifecycle fixture and retain its bounded diagnostics even on failure."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def run_lifecycle(command, *, output, cwd, env):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output / 'native-pm-lifecycle.json').unlink(missing_ok=True)
    log = output / 'native-pm-lifecycle.log'
    with tempfile.TemporaryDirectory(prefix='plur1bus-lifecycle-evidence-') as parent:
        result = subprocess.run([*command, '--sandbox-parent', parent], cwd=cwd, env=env,
                                capture_output=True, text=True)
        with log.open('a', encoding='utf-8') as handle:
            handle.write(result.stdout + result.stderr)
        # Only read the single newly-created, non-symlink fixture beneath our private parent.
        fixtures = [path for path in Path(parent).iterdir()
                    if path.name.startswith('plur1bus-runtime-acceptance-') and not path.is_symlink() and path.is_dir()]
        if len(fixtures) == 1:
            for name in ('gateway.log', 'runtime-receipt.json', 'startup-witness.json'):
                candidate = fixtures[0] / name
                if not candidate.is_symlink() and candidate.is_file():
                    (output / ('native-pm-' + name)).write_bytes(candidate.read_bytes())
        result.check_returncode()
        if len(fixtures) != 1:
            raise RuntimeError('expected exactly one isolated lifecycle fixture')
        records = []
        for line in result.stdout.splitlines():
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        passed = [item for item in records if isinstance(item, dict) and item.get('status') == 'passed']
        if len(passed) != 1 or passed[0].get('configHashesUnchanged') is not True:
            raise RuntimeError('gateway lifecycle evidence missing')
        if Path(passed[0]['sandbox']).resolve() != fixtures[0].resolve():
            raise RuntimeError('lifecycle evidence does not identify its isolated fixture')
        return passed[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--python', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--package-source-commit', required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    output = Path(args.output)
    passed = run_lifecycle([sys.executable, str(repo / 'distribution/tests/live_runtime_acceptance.py'),
                            '--source', args.source, '--python', args.python],
                           output=output, cwd=repo, env=os.environ.copy())
    evidence = {'schema': 1, 'status': 'passed', 'sourceCommit': args.source_commit,
                'packageSourceCommit': args.package_source_commit, 'profiles': ['default', 'alpha'],
                'originalPid': passed['originalPid'], 'restoredPid': passed['restoredPid'],
                'configHashesUnchanged': True, 'pmBootstrap': 'approved-harness', 'log': 'native-pm-lifecycle.log'}
    evidence['ownerDeathSupervisor'] = passed['ownerDeathSupervisor']
    evidence['fixturePmAdmission'] = passed['fixturePmAdmission']
    (output / 'native-pm-lifecycle.json').write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error, file=sys.stderr)
        raise SystemExit(error.returncode) from error
