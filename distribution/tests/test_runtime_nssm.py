"""NSSM stock definition proof at the registry boundary, without SCM calls."""
from contextlib import nullcontext
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from distribution import runtime_service_identity as identity
from distribution import runtime_worker as worker


class NssmIdentityTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name).resolve()
        self.project = self.home / 'hermes-agent'
        self.owner = {'kind': 'windows-service', 'name': 'hermes', 'pid': 42}
        self.arguments = [str(self.project / 'hermes_cli/main.py'), 'gateway', 'run']
        self.values = {'Application': 'python', 'AppParameters': subprocess.list2cmdline(self.arguments),
                       'AppDirectory': str(self.project), 'AppEnvironmentExtra': ['HERMES_HOME=' + str(self.home)]}
        self.events = None
        self.registry = SimpleNamespace(HKEY_LOCAL_MACHINE='HKLM', OpenKey=Mock(side_effect=self.open_key),
                                        QueryValueEx=Mock(side_effect=self.read_value),
                                        QueryInfoKey=Mock(side_effect=lambda key: (len(self.events['keys']), len(self.events['values']), 0)))
        wrapper = str(self.home / 'nssm.exe')
        service = SimpleNamespace(binpath=lambda: subprocess.list2cmdline([wrapper]), username=lambda: 'fixture')
        def split(command):
            if command == service.binpath():
                return [wrapper]
            self.assertEqual(command, 'placeholder ' + self.values['AppParameters'])
            return ['placeholder', *self.arguments]
        for context in (
            patch.dict(sys.modules, {'winreg': self.registry, 'psutil': SimpleNamespace(win_service_get=lambda name: service)}),
            patch.object(identity, '_windows_split', side_effect=split),
            patch.object(identity, '_windows_product', return_value='NSSM 64-bit'),
        ):
            context.start()
            self.addCleanup(context.stop)

    def open_key(self, parent, name):
        if name.endswith('\\Parameters'):
            return nullcontext('parameters')
        self.assertEqual((parent, name), ('parameters', 'AppEvents'))
        if isinstance(self.events, Exception):
            raise self.events
        if self.events is None:
            raise FileNotFoundError('no hooks')
        return nullcontext('events')

    def read_value(self, key, name):
        self.assertEqual(key, 'parameters')
        if name not in self.values:
            raise FileNotFoundError(name)
        return self.values[name], 1

    def test_stock_nssm_accepts_no_hooks_and_fingerprints_empty_hook_state(self):
        identity.prove_service_source(self.owner, self.project, self.home)
        original = identity.windows_definition_fingerprint(self.owner)
        self.events = {'keys': {}, 'values': {}}
        identity.prove_service_source(self.owner, self.project, self.home)
        self.assertNotEqual(original, identity.windows_definition_fingerprint(self.owner))
        self.assertTrue(any(call.args == ('parameters', 'AppEvents') for call in self.registry.OpenKey.call_args_list))

    def test_configured_unknown_and_unreadable_hooks_are_refused(self):
        for events in (
            {'keys': {'Start': {'Pre': 'custom.exe'}}, 'values': {}},
            {'keys': {'Stop': {'Pre': 'custom.exe'}}, 'values': {}},
            {'keys': {'Exit': {'Post': 'custom.exe'}}, 'values': {}},
            {'keys': {'Unknown': {}}, 'values': {}},
            {'keys': {}, 'values': {'unknown': 'custom.exe'}},
            PermissionError('registry unavailable'),
        ):
            with self.subTest(events=events):
                self.events = events
                with self.assertRaisesRegex(ValueError, 'NSSM.*hook'):
                    identity.prove_service_source(self.owner, self.project, self.home)
        self.events = {'keys': {}, 'values': {}}
        self.registry.QueryInfoKey.side_effect = PermissionError('cannot inspect hooks')
        with self.assertRaisesRegex(ValueError, 'NSSM.*hook'):
            identity.prove_service_source(self.owner, self.project, self.home)

    def test_hooks_added_after_inventory_refuse_before_gateway_pause(self):
        entry = {'pid': 42, 'home': str(self.home), 'kind': 'windows-service', 'owner': self.owner,
                 'ownerProcess': {'pid': 42, 'born': 1}, 'ownerChain': [],
                 'ownerFingerprint': identity.windows_definition_fingerprint(self.owner)}
        proc = Mock(pid=42, cmdline=lambda: ['python', *self.arguments], cwd=lambda: str(self.project))
        self.events = {'keys': {'Stop': {'Pre': 'custom.exe'}}, 'values': {}}
        control = SimpleNamespace(pause_gateway_for_update=Mock())
        with patch.dict(sys.modules, {'gateway.control_socket': control}), \
             patch.object(worker, 'same_process', return_value=True), \
             patch.object(worker, 'identify', return_value={'pid': 42, 'hermes_home': str(self.home)}), \
             patch.object(worker, 'process', return_value=proc), \
             patch.object(worker, 'service_owners', return_value=[self.owner]), \
             patch.object(worker, 'owner_for_gateway', return_value=(self.owner, entry['ownerProcess'])), \
             self.assertRaisesRegex(ValueError, 'NSSM.*hook'):
            worker.stop(entry)
        control.pause_gateway_for_update.assert_not_called()

    def test_hooks_added_while_stopped_refuse_before_service_restart(self):
        entry = {'pid': 42, 'home': str(self.home), 'kind': 'windows-service', 'owner': self.owner,
                 'ownerFingerprint': identity.windows_definition_fingerprint(self.owner)}
        self.events = {'keys': {'Start': {'Pre': 'custom.exe'}}, 'values': {}}
        windows = SimpleNamespace(_start_windows_gateway_service=Mock())
        with patch.dict(sys.modules, {'hermes_cli.update_cmd_windows': windows}), \
             self.assertRaisesRegex(ValueError, 'NSSM.*hook'):
            worker.resume(entry, self.project)
        windows._start_windows_gateway_service.assert_not_called()
