"""Canonical gateway dependents are observed, never independently controlled."""
import os
from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import patch

from distribution import runtime_clients as clients
from distribution import runtime_worker as worker
from distribution.tests import test_runtime_clients as fixtures


@unittest.skipIf(sys.platform == 'win32', 'POSIX owner-death supervisor contract')
class OwnerDeathSupervisorTests(unittest.TestCase):
    proc = fixtures.ClientInventoryTests.proc
    missing = staticmethod(fixtures.ClientInventoryTests.missing)

    def setUp(self):
        fixtures.ClientInventoryTests.setUp(self)
        self.api = sys.modules['hermes_cli.process_identity']
        self.api.__file__ = str(self.project / 'hermes_cli/process_identity.py')
        self.script = self.project / 'hermes_cli/process_supervisor.sh'
        self.api.is_owner_death_supervisor = lambda argv: argv[1:2] == [str(self.script)]
        self.shell = '/bin/sh'
        self.owner = self.proc(42, ['python', str(self.project / 'hermes_cli/main.py'), 'gateway', 'run'])
        self.child = self.proc(43, [self.shell, str(self.script), '42'], exe=Path(self.shell).resolve(), parent=42, born=11)
        self.groups = {42: 42, 43: 43}
        self.sessions = {42: 42, 43: 43}
        control = ModuleType('gateway.control_socket')
        control.launch_supervisor = lambda identity: 'manual'
        control.pause_gateway_for_update = lambda home: {'pid': 42, 'pausing': True}
        scope = ModuleType('hermes_cli.update_fleet_scope')
        scope.gateway_pid_home = lambda pid: str(self.home)
        package = ModuleType('hermes_cli')
        package.process_identity = self.api
        self.control = {'pid': 42, 'hermes_home': str(self.home), 'served_profiles': ['default'], 'state': 'ready'}
        for context in (
            patch.dict(sys.modules, {'hermes_cli': package, 'gateway.control_socket': control, 'hermes_cli.update_fleet_scope': scope}),
            patch.object(worker, 'identify', side_effect=lambda home: self.control),
            patch.object(worker, 'service_owners', return_value=[]),
            patch.object(os, 'getpgid', side_effect=lambda pid: self.groups[pid]),
            patch.object(os, 'getsid', side_effect=lambda pid: self.sessions[pid]),
        ):
            context.start()
            self.addCleanup(context.stop)

    def test_gateway_records_passive_supervisor_and_waits_for_eof_exit(self):
        entries = worker.inventory(self.home, self.project)
        self.assertEqual([entry['pid'] for entry in entries], [42])
        witness = entries[0]['ownerDeathSupervisors']
        self.assertEqual(witness, [dict(clients.identity(self.child), ownerPid=42, ownerBorn=10)])
        now = [0.0]
        def wait(seconds):
            now[0] += seconds
            if now[0] >= 1:
                self.procs.pop(43, None)
        self.procs.pop(42)
        with patch.object(worker, 'verify_entry'), patch.object(clients.time, 'monotonic', side_effect=lambda: now[0]), patch.object(clients.time, 'sleep', side_effect=wait):
            self.assertEqual(worker.stop(entries[0]), {'stopped': 42})
        self.assertGreaterEqual(now[0], 1)
        self.child.terminate.assert_not_called()
        self.child.kill.assert_not_called()

    def test_custom_sibling_or_orphan_never_inherits_gateway_exclusion(self):
        changes = [
            ('extra argument', patch.object(self.child, 'cmdline', return_value=[self.shell, str(self.script), '42', 'extra'])),
            ('wrong group', patch.dict(self.groups, {42: 99})),
            ('shared session', patch.dict(self.sessions, {43: 42})),
            ('shared group', patch.dict(self.groups, {43: 42})),
            ('orphan', patch.object(self.child, 'parent', side_effect=lambda: None)),
            ('foreign source', patch.object(self.api, '__file__', str(self.home / 'other/hermes_cli/process_identity.py'))),
            ('wrong image', patch.object(self.child, 'exe', return_value=str(self.home / 'custom/sh'))),
            ('foreign script', patch.object(self.child, 'cmdline', return_value=[self.shell, str(self.project / 'custom.sh'), '42'])),
            ('wrong parent identity', patch.object(worker, 'identify', return_value=dict(self.control, pid=99))),
            ('older than parent', patch.object(self.child, 'create_time', return_value=9)),
            ('reused parent identity', patch.object(clients, 'matches', return_value=False)),
            ('different owner home', patch.object(self.owner, 'environ', return_value={'HERMES_HOME': str(self.home / 'other')})),
        ]
        for name, context in changes:
            with self.subTest(name=name), context, self.assertRaisesRegex(ValueError, 'unclassified|identity'):
                worker.inspect_clients(self.home, self.project, {42})
        self.proc(44, [self.shell, str(self.project / 'custom.sh')], exe=self.shell, parent=42)
        with self.assertRaisesRegex(ValueError, 'unclassified'):
            worker.inventory(self.home, self.project)

    def test_survivor_blocks_both_gateway_and_desktop_without_signals(self):
        gateway = worker.inventory(self.home, self.project)[0]
        app = self.proc(10, [str(self.app)], exe=self.app)
        desktop = dict(clients.identity(app), kind='desktop', members=[clients.identity(self.owner)],
                       backends=[], gateways=[gateway], shutdownBudget=1)
        for entry in (gateway, desktop):
            now = [0.0]
            def wait(seconds):
                now[0] += seconds
            def live(witness):
                return witness['pid'] == 43 or (witness['pid'] in {10, 42} and now[0] == 0)
            with self.subTest(kind=entry['kind']), patch.object(worker, 'verify_entry'), patch.object(worker, 'same_process', return_value=False), patch.object(clients, 'matches', side_effect=live), patch.object(clients, 'native_close', side_effect=lambda entry: now.__setitem__(0, .1)), patch.object(clients.time, 'monotonic', side_effect=lambda: now[0]), patch.object(clients.time, 'sleep', side_effect=wait):
                # The backend birth is checked before the Desktop quit request.
                with patch.object(worker, 'client_shutdown_budget', return_value=1):
                    with self.assertRaisesRegex(ValueError, 'supervisor.*exit'):
                        worker.stop(entry)
            self.child.terminate.assert_not_called()
            self.child.kill.assert_not_called()

    def test_supervisor_workspace_requires_this_install_selection_and_owner_generation(self):
        selected = self.home / 'installs/selected/environments/current/venv'
        workspace = selected.parent / 'workspace'
        pm = ModuleType('pm.environments')
        pm.committed_venv = lambda project: selected
        self.child.cmdline.return_value = [self.shell, str(workspace / 'hermes_cli/process_supervisor.sh'), '42']
        self.child.info['cmdline'] = self.child.cmdline.return_value
        with patch.dict(sys.modules, {'pm.environments': pm}), patch.object(clients, 'generation_bound', return_value=True):
            self.assertEqual(worker.inventory(self.home, self.project)[0]['ownerDeathSupervisors'][0]['pid'], 43)
            with patch.object(clients, 'generation_bound', return_value=False), self.assertRaisesRegex(ValueError, 'unclassified'):
                worker.inventory(self.home, self.project)
            with patch.object(pm, 'committed_venv', return_value=None), self.assertRaisesRegex(ValueError, 'unclassified'):
                worker.inventory(self.home, self.project)


class PluginHostOwnerTests(unittest.TestCase):
    setUp = fixtures.ClientInventoryTests.setUp
    proc = fixtures.ClientInventoryTests.proc
    missing = staticmethod(fixtures.ClientInventoryTests.missing)

    def test_secondary_plugin_host_uses_owner_endpoint_and_explicit_served_membership(self):
        owner = self.proc(42, ['python', str(self.project / 'hermes_cli/main.py'), 'gateway', 'run'])
        secondary = self.home / 'profiles/alpha'
        host = self.proc(44, [owner.exe(), '-m', 'hermes_cli.plugin_host_child'], parent=42, home=secondary)
        host.cwd.return_value = str(secondary)
        host.environ.return_value.update(PYTHONPATH=str(self.project), HERMES_PLUGIN_HOST_PROCESS='1')
        control = {'pid': 42, 'hermes_home': str(self.home), 'served_profiles': ['default', 'alpha']}
        with patch.object(worker, 'identify', side_effect=lambda home: control if home == self.home else None):
            self.assertEqual(worker.inspect_clients(self.home, self.project, {42}), [])
            control['served_profiles'] = ['default']
            with self.assertRaisesRegex(ValueError, 'unclassified'):
                worker.inspect_clients(self.home, self.project, {42})
