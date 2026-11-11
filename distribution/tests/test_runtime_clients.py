"""Client ownership contracts with synthetic processes and a temporary install."""
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import Mock, patch
from distribution import runtime_worker as worker
from distribution import runtime_clients


class ClientInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.project = self.home / 'hermes-agent'
        self.project.mkdir()
        self.app = self.home / 'Hermes.app/Contents/MacOS/Hermes'
        self.app.parent.mkdir(parents=True)
        self.app.write_bytes(b'app')
        import plistlib
        (self.app.parent.parent / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'ai.hermes.desktop', 'CFBundleExecutable': 'Hermes'}))
        self.rows, self.procs = [], {}
        api = patch('distribution.runtime_service_identity._identity_api', return_value=Mock(_launch_module=Mock(return_value=None)))
        api.start()
        self.addCleanup(api.stop)
        identity = ModuleType('hermes_cli.process_identity')
        identity.LEDGER_FILENAME = 'spawn-ledger.json'
        identity.install_id = lambda path: 'selected' if Path(path) == self.project else 'foreign'
        identity._read_ledger = lambda path: self.rows
        identity.worker_birth = identity.process_birth = lambda proc: proc.create_time()
        identity._entry_boot = lambda row, key: None
        identity._pid_alive_matches = lambda pid, born, **kw: pid in self.procs and self.procs[pid].create_time() == born
        identity.boot_start = lambda proc: None
        identity._live_boot_id = lambda: None
        parser = ModuleType('hermes_cli.update_cmd_windows')
        parser._hermes_holder_subcommand = lambda text: next((x for x in ('serve', 'dashboard', 'chat', 'cron') if x in text.split()), None)
        posix = ModuleType('hermes_cli.update_cmd_posix_pause')
        posix._supervisor_markers = lambda pid: None
        self.modules = patch.dict(sys.modules, {'hermes_cli.process_identity': identity, 'hermes_cli.update_cmd_windows': parser, 'hermes_cli.update_cmd_posix_pause': posix})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        psutil = ModuleType('psutil')
        psutil.NoSuchProcess = type('NoSuchProcess', (Exception,), {})
        psutil.AccessDenied = type('AccessDenied', (Exception,), {})
        psutil.STATUS_ZOMBIE = 'zombie'
        psutil.process_iter = lambda *a, **k: []
        psutil.Process = lambda pid: None
        fake_psutil = patch.dict(sys.modules, {'psutil': psutil})
        fake_psutil.start()
        self.addCleanup(fake_psutil.stop)
        self.ps = patch.object(psutil, 'process_iter', side_effect=lambda *a, **k: list(self.procs.values()))
        self.ps.start()
        self.addCleanup(self.ps.stop)
        self.process_patch = patch.object(psutil, 'Process', side_effect=lambda pid: self.procs[pid] if pid in self.procs else self.missing(pid))
        self.process_patch.start()
        self.addCleanup(self.process_patch.stop)
        self.current = self.proc(999, [], exe=sys.executable, parent=None)
        self.pid = patch('os.getpid', return_value=999)
        self.pid.start()
        self.addCleanup(self.pid.stop)
        budget = patch.object(worker, 'restart_budget', return_value=1)
        budget.start()
        self.addCleanup(budget.stop)

    @staticmethod
    def missing(pid):
        import psutil
        raise psutil.NoSuchProcess(pid)

    def proc(self, pid, args, *, exe=None, parent=None, home=None, born=10):
        proc = Mock(pid=pid)
        proc.info = {'pid': pid, 'cmdline': args}
        proc.cmdline.return_value = args
        proc.exe.return_value = str(exe or self.project / 'venv/bin/python')
        proc.cwd.return_value = str(self.project)
        proc.environ.return_value = {'HERMES_HOME': str(home or self.home)}
        proc.create_time.return_value = born
        proc.status.return_value = 'running'
        proc.parents.side_effect = lambda: [self.procs[parent]] if parent else []
        proc.parent.side_effect = lambda: self.procs.get(parent)
        proc.children.side_effect = lambda **kw: [p for p in self.procs.values() if p.parent() is proc]
        self.procs[pid] = proc
        return proc

    def backend(self, pid=11, owner=10, home=None, install='selected'):
        proc = self.proc(pid, ['python', str(self.project / 'hermes_cli/main.py'), 'serve'], parent=owner, home=home)
        self.rows.append({'pid': pid, 'create_time': 10, 'purpose': 'serve', 'install': install, 'hermes_home': str(home or self.home), 'spawner_pid': owner, 'spawner_create': None, 'host': '127.0.0.1', 'port': 8765})
        return proc

    def test_one_desktop_groups_backend_and_renderer_and_ignores_other_home(self):
        self.proc(10, [str(self.app)], exe=self.app)
        self.backend()
        self.proc(12, [str(self.app), '--type=renderer'], exe=self.app, parent=10)
        self.proc(20, [str(self.app)], exe=self.app, home=self.home / 'foreign')
        self.backend(21, 20, self.home / 'foreign', 'foreign')
        entries = worker.inspect_clients(self.home, self.project, set())
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['kind'], 'desktop')
        self.assertEqual(entries[0]['pid'], 10)
        self.assertEqual({p['pid'] for p in entries[0]['members']}, {11, 12})
        self.assertNotIn('argv', json.dumps(entries))

    def test_cli_with_no_subcommand_is_a_saved_session_not_a_replay(self):
        self.proc(30, ['python', str(self.project / 'hermes_cli/main.py')])
        self.rows.append({'pid': 30, 'create_time': 10, 'purpose': 'cli', 'install': 'selected', 'hermes_home': str(self.home)})
        entries = worker.inspect_clients(self.home, self.project, set())
        self.assertEqual(entries[0]['kind'], 'cli')
        self.assertEqual(entries[0]['restorePolicy'], 'saved-session')

    def test_installer_ancestors_are_never_stopped(self):
        ancestor = self.proc(30, ['python', str(self.project / 'hermes_cli/main.py')])
        self.current.parents.return_value = [ancestor]
        self.current.parents.side_effect = None
        self.assertEqual(worker.inspect_clients(self.home, self.project, set()), [])

    def test_unknown_custom_holder_refuses_before_writes(self):
        self.proc(30, [str(self.project / 'venv/bin/python'), '-c', 'custom_job()'])
        with self.assertRaisesRegex(ValueError, 'custom|unclassified'):
            worker.inspect_clients(self.home, self.project, set())

    def test_reused_backend_pid_is_not_adopted(self):
        self.proc(10, [str(self.app)], exe=self.app)
        self.backend().create_time.return_value = 99
        with self.assertRaisesRegex(ValueError, 'identity|ledger'):
            worker.inspect_clients(self.home, self.project, set())

    def test_unrelated_python_from_another_install_is_ignored(self):
        self.proc(30, ['/foreign/venv/bin/python', '/foreign/job.py'], exe='/foreign/venv/bin/python', home=self.home / 'other')
        self.assertEqual(worker.inspect_clients(self.home, self.project, set()), [])

    def test_custom_holder_via_symlinked_selected_python_is_not_missed(self):
        python = self.project / 'venv/bin/python'
        python.parent.mkdir(parents=True)
        python.symlink_to(sys.executable)
        self.proc(30, [str(python), '-c', 'custom_job()'], exe=sys.executable)
        with self.assertRaisesRegex(ValueError, 'custom|unclassified'):
            worker.inspect_clients(self.home, self.project, set())

    def test_unreadable_unrelated_process_does_not_block_installation(self):
        import psutil
        proc = self.proc(30, [], exe='/system/protected')
        proc.cmdline.side_effect = psutil.AccessDenied(30)
        self.assertEqual(worker.inspect_clients(self.home, self.project, set()), [])

    def test_unreadable_recorded_client_does_block_installation(self):
        import psutil
        proc = self.proc(30, [])
        proc.cmdline.side_effect = psutil.AccessDenied(30)
        self.rows.append({'pid': 30, 'create_time': 10, 'purpose': 'cli', 'install': 'selected', 'hermes_home': str(self.home)})
        with self.assertRaisesRegex(ValueError, 'unreadable'):
            worker.inspect_clients(self.home, self.project, set())

    def test_packaged_app_inside_source_is_grouped_before_custom_holder_refusal(self):
        import shutil
        target = self.project / 'apps/desktop/release/Hermes.app'
        shutil.copytree(self.app.parent.parent.parent, target)
        exe = target / 'Contents/MacOS/Hermes'
        app = self.proc(10, [str(exe)], exe=exe)
        app.environ.return_value = {}
        self.backend()
        self.proc(12, [str(exe), '--type=renderer'], exe=exe, parent=10)
        entries = worker.inspect_clients(self.home, self.project, set())
        self.assertEqual([entry['pid'] for entry in entries], [10])
        self.assertEqual({member['pid'] for member in entries[0]['members']}, {11, 12})

    def test_desktop_python_launcher_between_app_and_backend_is_grouped(self):
        self.proc(10, [str(self.app)], exe=self.app)
        launcher = self.proc(13, [str(self.project / 'venv/bin/python'), '-c', 'launcher'], parent=10)
        backend = self.backend()
        backend.parent.return_value = launcher
        backend.parent.side_effect = None
        backend.parents.side_effect = lambda: [launcher, self.procs[10]]
        entries = worker.inspect_clients(self.home, self.project, set())
        self.assertEqual({m['pid'] for m in entries[0]['members']}, {11, 13})

class ClientShutdownTests(ClientInventoryTests):
    def test_replaced_pid_never_receives_native_quit(self):
        from distribution import runtime_clients as clients
        entry = {'pid': 10, 'born': 10, 'exe': str(self.app), 'kind': 'desktop', 'home': str(self.home), 'members': [], 'shutdownBudget': 1}
        self.proc(10, [str(self.app)], exe=self.app, born=99)
        with patch.object(clients, 'native_close', create=True) as close, self.assertRaisesRegex(ValueError, 'identity'):
            worker.stop(entry)
        close.assert_not_called()

    def test_cli_restore_reports_saved_session_without_spawning(self):
        entry = {'pid': 30, 'born': 10, 'exe': str(self.project / 'venv/bin/python'), 'kind': 'cli', 'home': str(self.home), 'members': [], 'shutdownBudget': 1, 'restorePolicy': 'saved-session'}
        with patch.object(worker.subprocess, 'Popen') as spawn:
            result = worker.resume(entry, self.project)
        self.assertEqual(result['disposition'], 'closed-session-saved')
        spawn.assert_not_called()

    def test_desktop_close_waits_for_backend_and_scopes_escalation(self):
        from distribution import runtime_clients as clients
        app = self.proc(10, [str(self.app)], exe=self.app)
        backend = self.backend()
        entries = worker.inspect_clients(self.home, self.project, set())
        entry = dict(entries[0], shutdownBudget=1)
        now = [0]
        def wait(seconds):
            now[0] += seconds
        def quit_app(_entry):
            self.procs.pop(10)
        backend.kill.side_effect = lambda: self.procs.pop(11)
        with patch.object(clients, 'native_close', side_effect=quit_app, create=True), patch.object(clients.time, 'monotonic', side_effect=lambda: now[0]), patch.object(clients.time, 'sleep', side_effect=wait):
            result = worker.stop(entry)
        self.assertEqual(result['stopped'], 10)
        backend.kill.assert_called_once()
        app.kill.assert_not_called()

class ReadinessTests(unittest.TestCase):
    def test_all_backends_must_be_ready_on_selected_generation(self):
        from distribution import runtime_clients as clients
        original = {'target': {'path': '/app'}, 'backends': [{'home': '/home', 'role': 'serve'}, {'home': '/home/profiles/a', 'role': 'serve'}]}
        current = {'target': original['target'], 'backends': [{'home': '/home', 'role': 'serve', 'pid': 11, 'port': 80}, {'home': '/home/profiles/a', 'role': 'serve', 'pid': 12, 'port': 81}], 'members': []}
        with patch.object(clients, 'backend_ready', side_effect=[True, False], create=True):
            self.assertFalse(clients._desktop_ready(original, current, Path('/home/hermes-agent')))
        with patch.object(clients, 'backend_ready', return_value=True, create=True):
            self.assertTrue(clients._desktop_ready(original, current, Path('/home/hermes-agent')))
