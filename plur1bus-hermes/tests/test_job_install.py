import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.job_install import build_launchd_jobs, install_launchd_jobs


class JobInstallTests(unittest.TestCase):
    def test_builds_hourly_and_daily_agent_isolated_jobs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            jobs = build_launchd_jobs(
                root / "data",
                root / "config.json",
                ["main", "heisenberg"],
                python_executable="/python",
                launch_agents_dir=root / "LaunchAgents",
            )

            self.assertEqual(len(jobs), 4)
            self.assertEqual(
                jobs[0]["plist"]["StartCalendarInterval"],
                {"Minute": 0},
            )
            self.assertEqual(
                jobs[1]["plist"]["StartCalendarInterval"],
                {"Hour": 3, "Minute": 15},
            )
            self.assertIn("--agent", jobs[2]["plist"]["ProgramArguments"])
            self.assertIn("heisenberg", jobs[2]["plist"]["ProgramArguments"])
            self.assertEqual(
                jobs[2]["plist"]["StartCalendarInterval"],
                {"Minute": 17},
            )

    def test_install_writes_private_plists_without_loading_by_default(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            jobs = build_launchd_jobs(
                root / "data",
                root / "config.json",
                ["main"],
                python_executable="/python",
                launch_agents_dir=root / "LaunchAgents",
            )

            installed = install_launchd_jobs(jobs)

            self.assertEqual(len(installed), 2)
            self.assertTrue(all(Path(item["path"]).is_file() for item in installed))
            self.assertTrue(all(not item["loaded"] for item in installed))

    def test_no_label_or_schedule_collisions_across_many_agents(self):
        # 7.3.5 parity: agent jobs must never share a label, and same-mode
        # schedules stay staggered so isolated runs cannot pile onto one minute.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            agents = [f"agent-{index}" for index in range(12)]
            jobs = build_launchd_jobs(
                root / "data",
                root / "config.json",
                agents,
                python_executable="/python",
                launch_agents_dir=root / "LaunchAgents",
            )

            labels = [job["label"] for job in jobs]
            self.assertEqual(len(labels), len(set(labels)))
            self.assertEqual(len(jobs), 2 * len(agents))
            for mode in ("hourly", "daily"):
                schedules = [
                    tuple(sorted(job["plist"]["StartCalendarInterval"].items()))
                    for job in jobs
                    if job["mode"] == mode
                ]
                self.assertEqual(
                    len(schedules), len(set(schedules)),
                    f"{mode} schedules collide across agents",
                )


if __name__ == "__main__":
    unittest.main()
