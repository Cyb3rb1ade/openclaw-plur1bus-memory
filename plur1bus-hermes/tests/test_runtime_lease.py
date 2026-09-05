import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from plur1bus_hermes.runtime_lease import acquire_runtime_lease, exclusive_generation_lease


class RuntimeLeaseTests(unittest.TestCase):
    def test_constructor_failure_releases_lease_without_garbage_collection(self):
        from unittest.mock import patch
        from plur1bus_hermes.runtime import Plur1busRuntime
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            retained_error = None
            with patch("plur1bus_hermes.generation.effective_generation_config", side_effect=ValueError("bad pointer")):
                try:
                    Plur1busRuntime(root, {}, "main")
                except ValueError as error:
                    retained_error = error  # traceback deliberately retains the failed instance
            self.assertIsNotNone(retained_error)
            with exclusive_generation_lease(root):
                pass

    def test_each_runtime_must_release_and_closed_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b = acquire_runtime_lease(root), acquire_runtime_lease(root)
            try:
                with self.assertRaises(RuntimeError), exclusive_generation_lease(root):
                    self.fail("active runtimes allowed activation")
                a.close(); a.close()
                with self.assertRaises(RuntimeError), exclusive_generation_lease(root):
                    self.fail("second runtime ignored")
            finally:
                a.close(); b.close()
            with exclusive_generation_lease(root):
                with self.assertRaises(RuntimeError):
                    acquire_runtime_lease(root)

    def test_process_boundary_and_process_exit_release(self):
        with tempfile.TemporaryDirectory() as directory:
            code = (
                "import sys; from pathlib import Path; "
                "from plur1bus_hermes.runtime_lease import acquire_runtime_lease; "
                "lease=acquire_runtime_lease(Path(sys.argv[1])); "
                "print('held', flush=True); sys.stdin.readline(); lease.close()"
            )
            process = subprocess.Popen([sys.executable, "-c", code, directory],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(process.stdout.readline().strip(), "held")
                with self.assertRaises(RuntimeError), exclusive_generation_lease(Path(directory)):
                    self.fail("foreign process lease ignored")
                process.communicate("release\n", timeout=5)
                with exclusive_generation_lease(Path(directory)):
                    pass
            finally:
                if process.poll() is None:
                    process.terminate(); process.communicate(timeout=5)

    def test_dangling_lock_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "state").mkdir()
            (root / "state" / "runtime-generation.lock").symlink_to(root / "missing")
            with self.assertRaises(RuntimeError):
                acquire_runtime_lease(root)
            self.assertFalse((root / "missing").exists())

    def test_runtime_shutdown_keeps_lease_until_worker_drains(self):
        from plur1bus_hermes.runtime import Plur1busRuntime
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = Plur1busRuntime(root, {}, "main")
            started, release = threading.Event(), threading.Event()
            def operation():
                started.set()
                release.wait(5)
            future = runtime._executor.submit(operation)
            try:
                self.assertTrue(started.wait(2))
                runtime.shutdown(timeout_seconds=0)
                with self.assertRaises(RuntimeError), exclusive_generation_lease(root):
                    self.fail("shutdown released a running worker's lease")
                release.set()
                future.result(timeout=2)
                self.assertTrue(runtime._shutdown_complete.wait(2))
                with exclusive_generation_lease(root):
                    pass
                with self.assertRaises(RuntimeError):
                    runtime._table(False)
            finally:
                release.set(); runtime.shutdown()
