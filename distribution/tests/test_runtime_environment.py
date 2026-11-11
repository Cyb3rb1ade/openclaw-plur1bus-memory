"""Fake-key contracts for profile-owned runtime child environments."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import Mock, patch
from distribution import runtime_clients as clients
from distribution import runtime_worker as worker
from distribution.runtime_lifecycle import RuntimeLifecycle


class ProfileEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.target = self.root / 'profiles/other'
        self.target.mkdir(parents=True)
        self.project = self.root / 'hermes-agent'
        self.project.mkdir()
        self.profile_secrets = {'OWN_PROFILE_KEY': 'fake-own-profile-value', 'SHARED_API_KEY': 'fake-own-shared-value'}
        self.resolved = []
        # Boundary substitute for the selected Hermes resolver: defaulting the
        # base to os.environ reproduces its supported same-home behavior.
        scope = ModuleType('agent.secret_scope')
        def build(home):
            self.resolved.append(Path(home))
            return dict(self.profile_secrets)
        scope.build_profile_secret_scope = build
        local = ModuleType('tools.environments.local')
        def served(base=None, *, target_home=None, inherit_credentials=False):
            env = dict(os.environ if base is None else base)
            env['HERMES_HOME'] = str(target_home)
            if inherit_credentials:
                env.update(scope.build_profile_secret_scope(Path(target_home)))
            return env
        local.served_profile_child_env = served
        self.modules = patch.dict(sys.modules, {'tools.environments.local': local, 'agent.secret_scope': scope})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.environment = patch.dict(os.environ, {
            'HOME': str(self.root), 'USERPROFILE': str(self.root), 'HERMES_HOME': str(self.root), 'TYPESAFE_API_KEY': 'fake-unrelated-launch-key',
            'SHARED_API_KEY': 'fake-launch-shared-key', 'CUSTOM_PLUGIN_SECRET': 'fake-launch-plugin-secret',
            'PATH': '/fixture/bin', 'DISPLAY': ':42', 'HERMES_DESKTOP_USER_DATA_DIR': str(self.root / 'desktop-data'),
            'HERMES_DESKTOP_HERMES_ROOT': '/foreign/source', 'HERMES_PARENT_PID': '900', 'PYTHONPATH': '/foreign/python',
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def assert_owned_environment(self, environment):
        self.assertNotIn('TYPESAFE_API_KEY', environment)
        self.assertNotIn('CUSTOM_PLUGIN_SECRET', environment)
        self.assertEqual(environment['OWN_PROFILE_KEY'], 'fake-own-profile-value')
        self.assertEqual(environment['SHARED_API_KEY'], 'fake-own-shared-value')
        self.assertEqual(environment['HERMES_HOME'], str(self.target))
        self.assertEqual(environment['PATH'], '/fixture/bin')
        self.assertEqual(environment['DISPLAY'], ':42')
        self.assertNotIn('PYTHONPATH', environment)
        self.assertNotIn('HERMES_PARENT_PID', environment)
        self.assertEqual(self.resolved, [self.target])

    def test_desktop_spawn_uses_target_secrets_without_launch_profile_keys(self):
        executable = self.root / 'hermes'
        executable.write_bytes(b'app')
        resources = self.root / 'resources/app.asar'
        resources.parent.mkdir()
        resources.write_bytes(b'resources')
        proc = Mock(exe=Mock(return_value=str(executable)), environ=Mock(return_value={}))
        entry = {'pid': 10, 'born': 1, 'exe': str(executable), 'home': str(self.target), 'kind': 'desktop',
                 'target': clients.desktop_target(proc), 'members': [], 'backends': []}
        with patch.object(worker, 'inventory', return_value=[]), patch.object(clients, 'matches', return_value=False), patch.object(clients, '_desktop_ready', return_value=False), patch.object(clients.subprocess, 'Popen', side_effect=ValueError('fixture spawn boundary')) as spawn, self.assertRaisesRegex(ValueError, 'fixture spawn boundary'):
            clients.resume(entry, self.project)
        env = spawn.call_args.kwargs['env']
        self.assert_owned_environment(env)
        self.assertEqual(env['HERMES_DESKTOP_USER_DATA_DIR'], str(self.root / 'desktop-data'))
        self.assertEqual(env['HERMES_DESKTOP_HERMES_ROOT'], str(self.project))

    def test_manual_gateway_spawn_uses_target_secrets_without_launch_profile_keys(self):
        entry = {'pid': 10, 'born': 1, 'home': str(self.target), 'kind': 'manual', 'served_profiles': ['other'], 'options': []}
        with patch.object(worker, 'identify', return_value=None), patch.object(worker, 'same_process', return_value=False), patch.object(worker.subprocess, 'Popen', side_effect=ValueError('fixture spawn boundary')) as spawn, self.assertRaisesRegex(ValueError, 'fixture spawn boundary'):
            worker.resume(entry, self.project)
        self.assert_owned_environment(spawn.call_args.kwargs['env'])

    def test_isolated_helper_does_not_receive_installer_provider_or_plugin_keys(self):
        proc = Mock()
        proc.__enter__ = Mock(return_value=proc)
        proc.__exit__ = Mock(return_value=False)
        proc.communicate.return_value = ('[]', '')
        proc.returncode = 0
        manager = RuntimeLifecycle(self.root, lambda: 'python', lambda state: None)
        with patch.object(worker.subprocess, 'Popen', return_value=proc) as spawn:
            self.assertEqual(manager._worker('inventory'), [])
        env = spawn.call_args.kwargs['env']
        self.assertNotIn('TYPESAFE_API_KEY', env)
        self.assertNotIn('CUSTOM_PLUGIN_SECRET', env)
        self.assertNotIn('SHARED_API_KEY', env)
        self.assertEqual(env['HERMES_HOME'], str(self.root))
        self.assertEqual(env['HERMES_DESKTOP_USER_DATA_DIR'], str(self.root / 'desktop-data'))

    def test_worker_binds_target_context_without_relabeling_inherited_secret_scope(self):
        constants = ModuleType('hermes_constants')
        bound = []
        constants.set_hermes_home_override = lambda home: (bound.append(str(home)) or 'token')
        constants.reset_hermes_home_override = Mock()
        entry = {'pid': 10, 'home': str(self.target), 'kind': 'manual'}
        def resume(record, project):
            self.assertEqual(os.environ['HERMES_HOME'], str(self.root))
            self.assertNotIn('TYPESAFE_API_KEY', os.environ)
            self.assertNotIn('CUSTOM_PLUGIN_SECRET', os.environ)
            self.assertEqual(bound, [str(self.target)])
            return {'pid': 11}
        with patch.dict(sys.modules, {'hermes_constants': constants}), patch.object(sys, 'argv', ['runtime_worker.py', str(self.root), 'resume']), patch.object(sys, 'stdin', io.StringIO(json.dumps(entry))), patch.object(sys, 'stdout', io.StringIO()), patch.object(worker, 'resume', side_effect=resume), patch.object(sys, 'path', list(sys.path)):
            worker.main()
        constants.reset_hermes_home_override.assert_called_once_with('token')
