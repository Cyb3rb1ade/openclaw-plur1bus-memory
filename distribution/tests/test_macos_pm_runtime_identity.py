"""Run Swift and Python discovery against the same real temporary PM files."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from distribution.tests import test_pm_runtime_identity as fixtures


@unittest.skipUnless(sys.platform == 'darwin' and shutil.which('xcrun'), 'requires native macOS Swift')
class NativeDiscoveryParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temporary.cleanup)
        root = Path(temporary.name)
        source = root / 'Probe.swift'
        source.write_text('''import Foundation
@main struct Probe {
    static func main() {
        do { print(try discoverHermesPython(home: CommandLine.arguments[1]) ?? "missing") }
        catch { print("refused"); exit(4) }
    }
}
''')
        cls.binary = root / 'probe'
        macos = Path(__file__).resolve().parents[1] / 'macos'
        subprocess.run(['xcrun', 'swiftc', str(macos / 'HermesPython.swift'), str(macos / 'Localization.swift'),
                        str(source), '-o', str(cls.binary)], capture_output=True, check=True)

    def setUp(self):
        self.fixture = fixtures.RuntimeStoreIdentityTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.selected = self.fixture.publish('selected', self.fixture.runtime)

    def assert_discovery(self, expected):
        if expected is None:
            with self.assertRaises(ValueError):
                fixtures.installer.interpreter(self.fixture.home)
        else:
            self.assertEqual(fixtures.installer.interpreter(self.fixture.home), expected)
        result = subprocess.run([str(self.binary), str(self.fixture.home)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 4 if expected is None else 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'refused' if expected is None else str(expected))

    def test_custom_store_versioned_binary_retains_lexical_venv_in_both_resolvers(self):
        versioned = self.fixture.runtime.with_name('python3.14')
        self.fixture.runtime.rename(versioned)
        self.fixture.runtime.symlink_to(versioned.name)
        self.assert_discovery(self.selected)

    def test_unrecorded_and_redirected_targets_are_refused_by_both_resolvers(self):
        self.selected.unlink()
        sibling = self.fixture.make_runtime(self.fixture.store / 'unrecorded-python')
        self.selected.symlink_to(sibling)
        self.assert_discovery(None)
        self.selected.unlink()
        self.selected.symlink_to(self.fixture.runtime)
        for entry in ('../outside', str(self.fixture.runtime.parent.parent), 'unrecorded-python'):
            with self.subTest(entry=entry):
                self.fixture.facts['packages']['python']['entry'] = entry
                self.fixture.write_runtime_facts()
                self.assert_discovery(None)
        self.fixture.facts['packages']['python']['entry'] = 'python-fixture'
        self.fixture.write_runtime_facts()
        self.fixture.runtime.unlink()
        self.fixture.runtime.symlink_to(sibling)
        self.assert_discovery(None)

    def test_invalid_facts_and_redirected_or_relative_store_are_refused_by_both_resolvers(self):
        facts = self.fixture.store / 'facts.json'
        original = facts.read_bytes()
        for contents in ('{}', '{"schema":1,"packages":{"python":{"entry":42}}}', 'invalid-json'):
            with self.subTest(contents=contents):
                facts.write_text(contents)
                self.assert_discovery(None)
        facts.write_bytes(original)
        redirected = self.fixture.root / 'store-link'
        redirected.symlink_to(self.fixture.store, target_is_directory=True)
        for override in (str(redirected), 'relative-store'):
            with self.subTest(override=override), patch.dict(os.environ, {'HERMES_RUNTIME_DIR': override}):
                self.assert_discovery(None)
        outside_facts = self.fixture.root / 'outside-facts.json'
        facts.rename(outside_facts)
        facts.symlink_to(outside_facts)
        self.assert_discovery(None)
