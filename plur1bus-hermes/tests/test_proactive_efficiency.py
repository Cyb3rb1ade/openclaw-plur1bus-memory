"""Performance contracts compare outputs, not flaky wall-clock thresholds."""
import builtins
import json
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plur1bus_hermes import proactive


class ProactiveEfficiencyTests(unittest.TestCase):
    def engine(self, root):
        return proactive.ProactiveEngine(root / 'state', root / 'neo', root / 'workspace')

    def test_tail_matches_last_valid_objects_before_user_filter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = self.engine(root)
            engine.neo_dir.mkdir()
            path = engine.neo_dir / 'turn-journal.jsonl'
            lines = [json.dumps({'id': str(i), 'role': 'assistant' if i % 3 else 'user',
                                'content': 'Grüße 🐙 ' + 'x' * (i % 17)}, ensure_ascii=False) for i in range(900)]
            lines[610:610] = ['broken', '[]', 'null', '', '42']
            for separator in ['\n', '\r\n', '\r', '\u2028']:
                for ending in ['', separator, separator + '{"partial":']:
                    with self.subTest(separator=repr(separator), ending=repr(ending)):
                        path.write_text(separator.join(lines) + ending, encoding='utf-8', newline='')
                        expected = engine._jsonl(path)[-500:]
                        self.assertEqual(engine._jsonl_tail(path, 500), expected)
            self.assertEqual(engine._jsonl_tail(path, 0), [])
            self.assertEqual(engine._jsonl_tail(engine.neo_dir / 'missing.jsonl', 10), [])

    def test_pattern_detection_never_reads_historical_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = self.engine(root)
            engine.neo_dir.mkdir()
            path = engine.neo_dir / 'turn-journal.jsonl'
            row = json.dumps({'role': 'user', 'content': 'Hermes memory migration', 'id': 'a'}) + '\n'
            path.write_text(row * 30000)
            with patch.object(Path, 'read_text', side_effect=AssertionError('unbounded text read')):
                result = engine.detect_patterns()
            self.assertEqual(result['clusters'][0]['size'], 500)

    def test_tail_handles_multibyte_and_long_record_crossing_read_chunks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = self.engine(root)
            engine.neo_dir.mkdir()
            path = engine.neo_dir / 'turn-journal.jsonl'
            records = [{'id': 'old'}, {'content': '🦉ä' * 30000}, {'id': 'new'}]
            path.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in records), encoding='utf-8')
            self.assertEqual(engine._jsonl_tail(path, 2), records[-2:])

    def test_tail_io_is_bounded_by_needed_suffix_and_does_not_swallow_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = self.engine(root)
            engine.neo_dir.mkdir()
            path = engine.neo_dir / 'turn-journal.jsonl'
            path.write_text('{"id":"old"}\n' * 100000 + '{"id":"new"}\n' * 500)
            import os
            real_fdopen = os.fdopen
            reads = []
            class MeasuredStream:
                def __init__(self, fd, mode):
                    self.inner = real_fdopen(fd, mode)
                def __enter__(self):
                    return self
                def __exit__(self, *args):
                    return self.inner.__exit__(*args)
                def fileno(self):
                    return self.inner.fileno()
                def seek(self, pos):
                    return self.inner.seek(pos)
                def read(self, count):
                    result = self.inner.read(count)
                    reads.append(len(result))
                    return result
            with patch('plur1bus_hermes.proactive.os.fdopen', side_effect=MeasuredStream):
                self.assertEqual(engine._jsonl_tail(path, 500), [{'id': 'new'}] * 500)
            self.assertEqual(sum(reads), 65536)
            with patch.object(MeasuredStream, 'read', return_value=b''), \
                 patch('plur1bus_hermes.proactive.os.fdopen', side_effect=MeasuredStream):
                with self.assertRaises(OSError):
                    engine._jsonl_tail(path, 500)

    def test_incremental_choice_matches_original_for_random_and_boundary_cases(self):
        rng = random.Random(6031)
        for threshold in [0, 0.55, 1, 0.55 + 1e-15]:
            clusters = []
            for index in range(250):
                vector = proactive._vector(' '.join(rng.choices(['hermes', 'memory', 'code', 'garden', 'plant', 'water'], k=7)))
                best = None
                score = 0.0
                for cluster in clusters:
                    exact = [sum(v[d] for v in cluster['_vectors']) / len(cluster['_vectors']) for d in range(len(vector))]
                    current = proactive._cosine(vector, exact)
                    if current > score:
                        best, score = cluster, current
                expected = best if best is not None and score >= threshold else None
                actual = proactive._nearest_pattern_cluster(vector, clusters, threshold)
                self.assertIs(actual, expected)
                if actual is None:
                    clusters.append({'_vectors': [vector], '_sum': list(vector), '_centroid': vector})
                else:
                    actual['_vectors'].append(vector)
                    actual['_sum'] = [a + b for a, b in zip(actual['_sum'], vector)]
                    actual['_centroid'] = [a / len(actual['_vectors']) for a in actual['_sum']]
            # Exact ties preserve the first cluster; approximate drift must not
            # select the second or cross the configured threshold.
        vector = [1.0, 0.0]
        first = {'_vectors': [[0.55, 0.0]], '_centroid': [0.55 - 1e-15, 0.0]}
        second = {'_vectors': [[0.55, 0.0]], '_centroid': [0.55 + 1e-15, 0.0]}
        self.assertIs(proactive._nearest_pattern_cluster(vector, [first, second], 0.55), first)
        self.assertIsNone(proactive._nearest_pattern_cluster(vector, [first, second], 0.55 + 1e-15))

    def test_common_cluster_does_not_recompute_all_member_sums(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = self.engine(root)
            engine.neo_dir.mkdir()
            rows = [{'id': str(i), 'role': 'user', 'content': 'Hermes memory migration'} for i in range(500)]
            (engine.neo_dir / 'turn-journal.jsonl').write_text('\n'.join(map(json.dumps, rows)))
            with patch.object(proactive, 'sum', wraps=builtins.sum, create=True) as sums:
                result = engine.detect_patterns()
            self.assertEqual(result['clusters'][0]['size'], 500)
            self.assertLess(sums.call_count, 2000, 'centroids must not rescan 128 columns on each append')
