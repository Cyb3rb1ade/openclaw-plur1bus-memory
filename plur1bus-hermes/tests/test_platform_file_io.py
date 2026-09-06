import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from plur1bus_hermes import file_lock
from plur1bus_hermes.file_io import replace_file, sync_parent


class PlatformFileTests(unittest.TestCase):
    def test_replace_and_sync_regular_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "new", root / "current"
            source.write_bytes(b"new")
            target.write_bytes(b"old")
            replace_file(source, target)
            sync_parent(target)
            self.assertEqual(target.read_bytes(), b"new")
            self.assertFalse(source.exists())
            with self.assertRaises(OSError):
                replace_file(source, target)
            self.assertEqual(target.read_bytes(), b"new")

    def test_exclusive_process_lock_is_released_on_process_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lock"
            fd = file_lock.open_lock(path)
            code = """
import sys
from plur1bus_hermes import file_lock as lock
fd=lock.open_lock(sys.argv[1])
try:
    lock.flock(fd, lock.LOCK_EX | lock.LOCK_NB)
except BlockingIOError:
    sys.exit(42)
"""
            try:
                file_lock.flock(fd, file_lock.LOCK_EX)
                self.assertEqual(subprocess.run([sys.executable, "-c", code, str(path)], timeout=10).returncode, 42)
                file_lock.flock(fd, file_lock.LOCK_UN)
                self.assertEqual(subprocess.run([sys.executable, "-c", code, str(path)], timeout=10).returncode, 0)
                file_lock.flock(fd, file_lock.LOCK_EX | file_lock.LOCK_NB)
                file_lock.flock(fd, file_lock.LOCK_UN)
            finally:
                os.close(fd)
