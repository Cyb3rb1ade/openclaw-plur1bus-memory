import os
import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.jobs import run_jobs
from plur1bus_hermes import file_lock


class _Domain:
    def proactive_check(self):
        return {"skipped": True}

    def run_afterthought(self):
        return {"skipped": True}

    def run_meta_reflection(self):
        return {"feedbackCount": 0}

    def auto_accept_stale_criticals(self):
        return {"accepted": [], "count": 0}

    def run_dynamics(self):
        return {"updated": 2}

    def due_reminders(self):
        return [{"id": "reminder-1"}]

    def run_consolidation(self, _table):
        return {"reviewed": 3}

    def run_dreaming(self, _table):
        return {"dreamed": 4}

    def rebuild_indexes(self, _table):
        return {"annIndex": "created"}

    def maintain_obsidian(self):
        return {"managedOnly": True}

    def rebuild_code_index(self):
        return {"fileCount": 0}


class _Runtime:
    instances = []

    def __init__(self, *_args):
        self._domain = _Domain()
        self.closed = False
        self.instances.append(self)

    def _table(self, create=False):
        return object(), None

    def shutdown(self, timeout_seconds=5):
        self.closed = True


class JobsTests(unittest.TestCase):
    def test_all_mode_runs_maintenance_and_writes_pending_reminders(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            report = run_jobs(root, {}, "main", "all", runtime_factory=_Runtime)

            self.assertEqual(report["status"], "completed")
            self.assertEqual(report["results"]["reminders"]["due"], 1)
            self.assertEqual(report["results"]["indexes"]["annIndex"], "created")
            self.assertTrue((root / "state/main/pending-reminders.json").is_file())
            self.assertTrue((root / "state/main/maintenance.lock").exists())
            self.assertTrue(_Runtime.instances[-1].closed)

    def test_live_lock_skips_overlapping_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = root / "state/main/maintenance.lock"
            lock.parent.mkdir(parents=True)
            fd = file_lock.open_lock(lock)
            try:
                file_lock.flock(fd, file_lock.LOCK_EX | file_lock.LOCK_NB)
                report = run_jobs(root, {}, "main", "hourly", runtime_factory=_Runtime)
            finally:
                os.close(fd)

            self.assertEqual(report["status"], "skipped")
            self.assertEqual(report["reason"], "job-already-running")

    def test_legacy_pid_lock_is_not_stolen_or_signalled(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = root / "state/main/maintenance.lock"
            lock.parent.mkdir(parents=True)
            lock.write_text("99999999\n", encoding="ascii")

            report = run_jobs(root, {}, "main", "hourly", runtime_factory=_Runtime)

            self.assertEqual(report["status"], "partial")
            self.assertEqual(report["reason"], "legacy-maintenance-lock-needs-review")
            self.assertEqual(lock.read_text(), "99999999\n")
            self.assertTrue(lock.exists())

    def test_shutdown_failure_does_not_leave_lock_held(self):
        class BrokenRuntime(_Runtime):
            def shutdown(self, timeout_seconds=5):
                raise RuntimeError("shutdown failed")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(RuntimeError, "shutdown failed"):
                run_jobs(root, {}, "main", "hourly", runtime_factory=BrokenRuntime)
            self.assertEqual(run_jobs(root, {}, "main", "hourly", runtime_factory=_Runtime)["status"], "completed")


if __name__ == "__main__":
    unittest.main()
