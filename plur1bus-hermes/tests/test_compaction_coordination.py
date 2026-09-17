"""Real lock contention, prompt start and row preservation for maintenance."""
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from plur1bus_hermes.namespaces import binding_from_scope, resolve_namespace_routes
from plur1bus_hermes.operator_status import optimize_runtime_table
from plur1bus_hermes.writer_lock import writer_lock


class CompactionCoordinationTests(unittest.TestCase):
    def runtime(self, root):
        config = {'embedding': {'dimensions': 2}}
        route, _ = resolve_namespace_routes(root, 'main', config)
        route.path.mkdir(parents=True)
        return SimpleNamespace(agent_id='main', data_dir=root, config=config, _writer_route=route,
                               scope_binding=binding_from_scope('main'))

    def test_cross_process_wait_is_bounded_and_lock_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = '''from pathlib import Path
import sys
from plur1bus_hermes.writer_lock import writer_lock
try:
    with writer_lock(Path(sys.argv[1]), timeout=0.05):
        print("acquired")
except TimeoutError:
    print("busy")
'''
            with writer_lock(root):
                result = subprocess.run([sys.executable, '-c', code, str(root)], capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), 'busy')
            with writer_lock(root, timeout=0):
                with writer_lock(root, timeout=0):
                    pass

    def test_compaction_waits_for_writer_then_runs_without_idle_delay(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = self.runtime(root)
            entered = threading.Event()
            requested = threading.Event()
            class Table:
                def optimize(self):
                    entered.set()
                    return {}
            connect = lambda _: SimpleNamespace(open_table=lambda _: Table())
            def compact():
                requested.set()
                return optimize_runtime_table(runtime, authorized=True, connect=connect)
            with ThreadPoolExecutor(max_workers=1) as executor:
                with writer_lock(root):
                    future = executor.submit(compact)
                    self.assertTrue(requested.wait(5))
                    self.assertFalse(entered.wait(0.1), 'maintenance overlaps an active writer')
                result = future.result(timeout=5)
            self.assertTrue(result['ok'])
            self.assertEqual(result['attempts'], 1)
            self.assertGreaterEqual(result['writerWaitMs'], 50)

    def test_real_lance_compaction_preserves_rows_and_releases_writers(self):
        import lancedb
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = self.runtime(root)
            table = lancedb.connect(str(runtime._writer_route.path)).create_table('memories', data=[
                {'id': str(i), 'content': 'retained', 'vector': [0.1, 0.2]} for i in range(20)])
            result = optimize_runtime_table(runtime, authorized=True)
            self.assertTrue(result['ok'], result)
            with writer_lock(root, timeout=0):
                table.add([{'id': 'after', 'content': 'new', 'vector': [0.1, 0.2]}])
            self.assertEqual(table.count_rows(), 21)

    def test_busy_writer_is_reported_without_starting_or_dropping_a_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = self.runtime(root)
            with ThreadPoolExecutor(max_workers=1) as executor:
                with writer_lock(root):
                    future = executor.submit(optimize_runtime_table, runtime, authorized=True,
                                             connect=lambda _: self.fail('must not open before acquiring'),
                                             retry_budget_seconds=0.05)
                    result = future.result(timeout=5)
            self.assertEqual(result['code'], 'writer_busy')
            self.assertEqual(result['attempts'], 0)
            with writer_lock(root, timeout=0):
                pass

    def test_waiting_write_resumes_after_compaction_and_lease_is_free_during_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = self.runtime(root)
            optimizing, finish, requested, stored = (threading.Event() for _ in range(4))
            class Table:
                def optimize(self):
                    optimizing.set()
                    if not finish.wait(5):
                        raise RuntimeError('test timed out')
                    return {}
            def writer():
                requested.set()
                with writer_lock(root):
                    stored.set()
            with ThreadPoolExecutor(max_workers=2) as executor:
                compact = executor.submit(optimize_runtime_table, runtime, authorized=True,
                                          connect=lambda _: SimpleNamespace(open_table=lambda _: Table()))
                self.assertTrue(optimizing.wait(5))
                write = executor.submit(writer)
                try:
                    self.assertTrue(requested.wait(5))
                    self.assertFalse(stored.wait(0.1))
                finally:
                    finish.set()
                self.assertTrue(compact.result(timeout=5)['ok'])
                write.result(timeout=5)
                self.assertTrue(stored.is_set())

            def acquire_in_other_thread(_delay):
                def acquire():
                    with writer_lock(root, timeout=0):
                        return True
                with ThreadPoolExecutor(max_workers=1) as pool:
                    self.assertTrue(pool.submit(acquire).result(timeout=5))
            table = Table()
            with patch.object(table, 'optimize', side_effect=[RuntimeError('retryable commit conflict'), {}]), \
                 patch('plur1bus_hermes.operator_status.time.sleep', side_effect=acquire_in_other_thread):
                result = optimize_runtime_table(runtime, authorized=True,
                                                connect=lambda _: SimpleNamespace(open_table=lambda _: table))
            self.assertTrue(result['ok'])
            self.assertEqual(result['attempts'], 2)
