import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plur1bus_hermes.jobs import run_jobs, _bind_profile_home
from plur1bus_hermes import file_lock


class JobProfileBindingTests(unittest.TestCase):
    def test_canonical_provider_config_binds_its_own_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve() / "profiles" / "alpha"
            config = {"skillWorkshop": {"enabled": True, "autoApply": "on"}}
            result = _bind_profile_home(config, home / "plugins/plur1bus/config.json")
            self.assertEqual(result["hermesHome"], str(home))
            self.assertNotIn("hermesHome", config)
            with self.assertRaises(ValueError):
                _bind_profile_home(config, home / "plugins/plur1bus/config.json", home.parent / "beta")

    def test_nonstandard_config_does_not_guess_profile_home(self):
        self.assertNotIn("hermesHome", _bind_profile_home({}, Path("/custom/provider.json")))
        expected = str(Path("/custom/profile").resolve())
        self.assertEqual(_bind_profile_home({}, Path("/custom/provider.json"), Path(expected))["hermesHome"], expected)


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
    def test_nightly_mining_runs_after_consolidation_and_tolerates_late_previous_slot(self):
        events = []
        class OrderedDomain(_Domain):
            def run_consolidation(self, table):
                events.append("consolidation")
                return {"reviewed": 3}
        class OrderedRuntime(_Runtime):
            def __init__(self, *args):
                super().__init__(*args)
                self._domain = OrderedDomain()
        config = {"skillWorkshop": {"enabled": True}, "hermesHome": "/bound/profile"}
        with tempfile.TemporaryDirectory() as temporary, patch(
            "plur1bus_hermes.skill_workshop.SkillWorkshop"
        ) as workshop, patch("plur1bus_hermes.rate_gate.time.time", return_value=100_000) as clock:
            workshop.return_value.mine.side_effect = lambda **kw: events.append("mine") or {"created": 0}
            first = run_jobs(Path(temporary), config, "main", "daily", runtime_factory=OrderedRuntime)
            self.assertEqual(events, ["consolidation", "mine"])
            workshop.return_value.mine.assert_called_once_with(hermes_home=Path("/bound/profile"))
            duplicate = run_jobs(Path(temporary), config, "main", "daily", runtime_factory=OrderedRuntime)
            self.assertEqual(duplicate["results"]["skillMiner"]["reason"], "rate-limited")
            clock.return_value = 100_000 + 86_350
            later = run_jobs(Path(temporary), config, "main", "daily", runtime_factory=OrderedRuntime)
            self.assertEqual(later["results"]["skillMiner"], {"created": 0})
            self.assertEqual(events, ["consolidation", "mine", "consolidation", "mine"])

    def test_disabled_workshop_never_constructs_miner(self):
        with tempfile.TemporaryDirectory() as temporary, patch(
            "plur1bus_hermes.skill_workshop.SkillWorkshop"
        ) as workshop:
            run_jobs(Path(temporary), {"skillWorkshop": {"enabled": False}}, "main", "daily", runtime_factory=_Runtime)
            workshop.assert_not_called()

    def test_daily_runs_shared_dynamics_gate_and_all_runs_it_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            daily = run_jobs(Path(temporary), {}, "main", "daily", runtime_factory=_Runtime)
        self.assertIn("dynamics", daily["results"])

        with tempfile.TemporaryDirectory() as temporary:
            all_mode = run_jobs(Path(temporary), {}, "main", "all", runtime_factory=_Runtime)
        self.assertEqual(list(all_mode["results"]).count("dynamics"), 1)

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
