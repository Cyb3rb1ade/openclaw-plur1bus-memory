"""Windows venv redirectors require kernel child and selected-interpreter proof."""
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from distribution import runtime_clients as clients
from distribution import runtime_worker as worker


class GatewayRedirectorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()
        self.project = self.home / 'hermes-agent'
        self.python = self.home / 'selected/venv/Scripts/python.exe'
        self.base = self.home / 'runtime/python.exe'
        self.python.parent.mkdir(parents=True)
        self.python.write_bytes(b'fixture redirector')
        (self.python.parent.parent / 'pyvenv.cfg').write_text('version = 3.14.0')
        self.args = ['-B', str(self.project / 'hermes_cli/main.py'), 'gateway', 'run', '--quiet']
        self.child = Mock(pid=42, exe=lambda: str(self.base), cmdline=lambda: [str(self.base), *self.args],
                          cwd=lambda: str(self.project), environ=lambda: {'HERMES_HOME': str(self.home)})
        self.parent = Mock(pid=10, exe=lambda: str(self.python), cmdline=lambda: [str(self.python), *self.args],
                           cwd=lambda: str(self.project), environ=lambda: {'HERMES_HOME': str(self.home)},
                           children=Mock(return_value=[self.child]))
        current = Mock(exe=lambda: str(self.base))
        for context in (
            patch.object(sys, 'executable', str(self.python)),
            patch.dict(sys.modules, {'psutil': SimpleNamespace(Process=lambda pid: current)}),
            patch.object(worker, 'identify', return_value={'pid': 42, 'hermes_home': str(self.home)}),
            patch.object(clients, 'identity', side_effect=lambda proc: {'pid': proc.pid}),
            patch.object(clients, 'matches', return_value=True),
        ):
            context.start()
            self.addCleanup(context.stop)

    def test_selected_venv_redirector_of_authoritative_gateway_is_recognized(self):
        self.assertTrue(clients.gateway_venv_redirector(self.parent, self.project, {42}))

    def test_foreign_child_other_argv_or_interpreter_and_orphan_are_not_excluded(self):
        self.assertFalse(clients.gateway_venv_redirector(self.parent, self.project, {99}))
        for changed in (
            {'exe': lambda: str(self.home / 'other/python.exe')},
            {'cmdline': lambda: [str(self.base), '-B', str(self.project / 'hermes_cli/main.py'), 'chat']},
            {'environ': lambda: {'HERMES_HOME': str(self.home / 'foreign')}},
        ):
            with self.subTest(changed=next(iter(changed))):
                with patch.multiple(self.child, **changed):
                    self.assertFalse(clients.gateway_venv_redirector(self.parent, self.project, {42}))
        with patch.object(worker, 'identify', return_value={'pid': 99}):
            self.assertFalse(clients.gateway_venv_redirector(self.parent, self.project, {42}))
        with patch.object(clients, 'matches', return_value=False):
            self.assertFalse(clients.gateway_venv_redirector(self.parent, self.project, {42}))
        self.parent.children.return_value = []
        self.assertFalse(clients.gateway_venv_redirector(self.parent, self.project, {42}))
        self.parent.children.return_value = [self.child, Mock(pid=99)]
        self.assertFalse(clients.gateway_venv_redirector(self.parent, self.project, {42}))
