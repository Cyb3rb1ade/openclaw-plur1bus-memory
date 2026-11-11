"""Offline lifecycle contracts; no productive runtime is inspected or stopped."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from distribution.runtime_lifecycle import RuntimeLifecycle


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.entry = dict(pid=42, born=1.5, home=str(self.home), kind="manual", served_profiles=["default", "alpha"])
        self.events, self.saved, self.calls = [], [], []
        self.inventory = [self.entry, dict(self.entry)]
        self.fail_stop = False
        self.fail_resume = False
        self.python = "old-python"
        self.manager = RuntimeLifecycle(self.home, lambda: self.python, self.persist, self.events.append, worker=self.worker)

    def persist(self, state):
        self.saved.append(json.loads(json.dumps(state)))

    def worker(self, action, entry=None):
        self.calls.append((action, entry, self.python))
        if action == "inventory":
            return self.inventory
        if action == "stop":
            self.assertEqual(self.saved[-1]["original"][0]["state"], "stop-requested")
            if self.fail_stop:
                raise ValueError("pause was refused")
            self.inventory = []
        if action == "resume":
            if self.fail_resume:
                raise ValueError("not ready")
            return {"pid": 43, "served_profiles": ["default", "alpha"]}
        return {}

    def test_shared_gateway_is_stopped_and_restored_once_with_durable_debt(self):
        self.manager.pause()
        self.manager.restore()
        self.assertEqual([c[0] for c in self.calls].count("stop"), 1)
        self.assertEqual([c[0] for c in self.calls].count("resume"), 1)
        self.assertEqual(self.manager.state["stopped"], [42])
        self.assertEqual(self.manager.state["restored"], [42])

    def test_empty_inventory_does_not_start_anything(self):
        self.inventory = []
        self.manager.pause()
        self.manager.restore()
        self.assertFalse(any(c[0] == "resume" for c in self.calls))

    def test_foreign_home_is_refused_before_stop(self):
        self.inventory = [dict(self.entry, home="/foreign")]
        with self.assertRaises(ValueError):
            self.manager.pause()
        self.assertFalse(any(c[0] == "stop" for c in self.calls))

    def test_conflicting_shared_pid_identity_refused(self):
        self.inventory.append(dict(self.entry, born=99))
        with self.assertRaises(ValueError):
            self.manager.pause()
        self.assertFalse(any(c[0] == "stop" for c in self.calls))

    def test_failed_stop_retains_debt_and_can_restore(self):
        self.fail_stop = True
        with self.assertRaises(ValueError):
            self.manager.pause()
        self.manager.restore()
        self.assertEqual(self.manager.state["restored"], [42])

    def test_resume_refreshes_selected_generation(self):
        self.manager.pause()
        self.python = "new-python"
        self.manager.restore()
        self.assertEqual(self.calls[-1][2], "new-python")

    def test_readiness_failure_is_durable(self):
        self.manager.pause()
        self.fail_resume = True
        with self.assertRaises(ValueError):
            self.manager.restore()
        self.assertEqual(self.saved[-1]["original"][0]["state"], "restart-failed")
        self.assertFalse(self.saved[-1]["restored"])

    def test_respawn_prevents_writes(self):
        def worker(action, entry=None):
            if action == "inventory":
                return [self.entry]
            return {}
        self.manager.worker = worker
        with self.assertRaisesRegex(ValueError, "still running"):
            self.manager.pause()

    def test_helper_deadline_covers_long_stop_and_restore_debt(self):
        from distribution import runtime_lifecycle as module
        import subprocess
        for action in ("stop", "resume"):
            with self.subTest(action=action):
                proc = Mock()
                proc.__enter__ = Mock(return_value=proc)
                proc.__exit__ = Mock(return_value=False)
                proc.communicate.side_effect = [subprocess.TimeoutExpired("helper", 10), ('{"pid": 43}', '')]
                proc.returncode = 0
                with patch.object(module.subprocess, "Popen", return_value=proc), patch.object(module.time, "monotonic", side_effect=[0, 2000]):
                    self.manager._worker(action, dict(self.entry, shutdownBudget=7335))
                proc.kill.assert_not_called()

class ClientLifecycleTests(unittest.TestCase):
    def test_clients_stop_first_gateways_restore_first_and_cli_is_not_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            records = [dict(pid=1, kind='manual', home=str(home)), dict(pid=2, kind='desktop', home=str(home)), dict(pid=3, kind='cli', home=str(home))]
            running = records.copy()
            calls = []
            def worker(action, entry=None):
                if action == 'inventory':
                    return list(running)
                calls.append((action, entry['pid']))
                if action == 'stop':
                    running[:] = [r for r in running if r['pid'] != entry['pid']]
                    return {}
                if entry['kind'] == 'cli':
                    return {'pid': None, 'disposition': 'closed-session-saved'}
                return {'pid': entry['pid'] + 100}
            manager = RuntimeLifecycle(home, lambda: 'python', lambda state: None, worker=worker)
            manager.pause()
            manager.restore()
            manager.restore()
            self.assertEqual(calls, [('stop', 2), ('stop', 3), ('stop', 1), ('resume', 1), ('resume', 2), ('resume', 3)])
            self.assertEqual(manager.state['original'][1]['state'], 'closed-session-saved')
            self.assertNotIn(3, manager.state['restored'])
