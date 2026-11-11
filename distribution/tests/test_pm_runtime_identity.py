"""A PM generation may select Python from an explicitly configured tool store."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from distribution.tests.test_installer import installer


class RuntimeStoreIdentityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / 'home'
        (self.home / 'hermes-agent').mkdir(parents=True)
        self.state = installer.pm_install_state_root(self.home)
        self.state.mkdir(parents=True)
        self.store = self.root / 'separate runtime store'
        self.store.mkdir()
        environment = patch.dict(os.environ, {'HERMES_RUNTIME_DIR': str(self.store)})
        environment.start()
        self.addCleanup(environment.stop)
        self.runtime = self.make_runtime(self.store / 'python-fixture')
        self.facts = {'schema': 1, 'packages': {'python': {'entry': 'python-fixture'}}}
        self.write_runtime_facts()

    def make_runtime(self, entry):
        binary = entry / ('python.exe' if os.name == 'nt' else 'bin/python3')
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b'fixture interpreter; never executed')
        binary.chmod(0o755)
        return binary

    def write_runtime_facts(self):
        (self.store / 'facts.json').write_text(json.dumps(self.facts))

    def publish(self, name, target):
        selected = self.state / 'environments' / name / 'venv'
        candidate = selected / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        candidate.parent.mkdir(parents=True)
        (selected / 'pyvenv.cfg').write_text('version = 3.14.9\n')
        try:
            candidate.symlink_to(target)
        except OSError:
            if os.name == 'nt':
                self.skipTest('Windows denied creating the POSIX-style venv symlink fixture')
            raise
        (self.state / 'facts.json').write_text(json.dumps({'packages': {'venv': {'environment': str(selected)}}}))
        return candidate

    def test_generation_switch_accepts_only_recorded_custom_store_python_and_keeps_venv_path(self):
        original = self.publish('before', self.make_runtime(self.home / 'tools/python-old'))
        self.assertEqual(installer.interpreter(self.home), original)
        replacement = self.publish('after', self.runtime)
        self.assertEqual(installer.interpreter(self.home), replacement)
        self.assertNotEqual(installer.interpreter(self.home), self.runtime.resolve())

    def test_custom_store_never_trusts_unrecorded_sibling_or_redirected_python(self):
        unrelated = self.make_runtime(self.store / 'unrecorded-python')
        self.publish('unrelated', unrelated)
        with self.assertRaisesRegex(ValueError, 'trusted runtime roots'):
            installer.interpreter(self.home)
        self.publish('recorded', self.runtime)
        for entry in ('../outside', str(self.runtime.parent.parent), 'unrecorded-python'):
            with self.subTest(entry=entry):
                self.facts['packages']['python']['entry'] = entry
                self.write_runtime_facts()
                with self.assertRaises(ValueError):
                    installer.interpreter(self.home)
        self.facts['packages']['python']['entry'] = 'python-fixture'
        self.write_runtime_facts()
        self.runtime.unlink()
        self.runtime.symlink_to(unrelated)
        with self.assertRaises(ValueError):
            installer.interpreter(self.home)

    def test_missing_or_invalid_store_facts_do_not_extend_trust(self):
        self.publish('generation', self.runtime)
        for contents in (None, '{}', '{"schema":1,"packages":{"python":{"entry":42}}}', 'invalid-json'):
            with self.subTest(contents=contents):
                path = self.store / 'facts.json'
                if contents is None:
                    path.unlink()
                else:
                    path.write_text(contents)
                with self.assertRaises(ValueError):
                    installer.interpreter(self.home)
