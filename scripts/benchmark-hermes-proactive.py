#!/usr/bin/env python3
"""Compare native proactive outputs and timing in a disposable synthetic home."""
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
import time
import types

from plur1bus_hermes import proactive

BASE = '9797191a29adfbe9496b57ae246eeb140278b592'
ROOT = Path(__file__).resolve().parents[1]


def main():
    source = subprocess.check_output(['git', 'show', BASE + ':plur1bus-hermes/src/plur1bus_hermes/proactive.py'],
                                     cwd=ROOT, text=True)
    reference = types.ModuleType('plur1bus_proactive_reference')
    exec(compile(source, '<pinned proactive baseline>', 'exec'), reference.__dict__)
    reference._utcnow = proactive._utcnow = lambda: 'synthetic-benchmark'
    measurements = {}
    with tempfile.TemporaryDirectory(prefix='plur1bus-proactive-benchmark-') as directory:
        root = Path(directory)
        neo = root / 'neo'
        neo.mkdir()
        path = neo / 'turn-journal.jsonl'
        with path.open('w', encoding='utf-8', newline='\n') as stream:
            for index in range(100000):
                stream.write(json.dumps({'id': str(index), 'role': 'user', 'content': 'Hermes memory migration'}) + '\n')
        outputs = []
        for label, implementation in [('baseline', reference), ('optimized', proactive)]:
            engine = implementation.ProactiveEngine(root / label, neo, root / 'workspace')
            durations = []
            for _ in range(5):
                start = time.perf_counter()
                result = engine.detect_patterns()
                durations.append((time.perf_counter() - start) * 1000)
            measurements[label + 'MedianMs'] = round(statistics.median(durations), 3)
            outputs.append(result)
        assert outputs[0] == outputs[1], 'benchmark output drift'
        print(json.dumps({'baselineCommit': BASE, 'synthetic': True, 'recordsOnDisk': 100000,
                          'journalBytes': path.stat().st_size, 'selection': 500, 'outputsEqual': True,
                          'scope': 'whole detect_patterns including journal read, clustering and state write',
                          **measurements}, indent=2))


if __name__ == '__main__':
    main()
