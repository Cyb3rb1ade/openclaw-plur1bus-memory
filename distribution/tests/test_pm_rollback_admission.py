"""Package upgrades can change PM's generation while preserving config bytes."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from distribution.tests.test_installer import installer


class PmRollbackAdmissionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()
        self.backup = self.home / 'plur1bus-install-backups/upgrade'
        self.backup.mkdir(parents=True)
        self.config = b'{"memory":{"provider":"plur1bus"},"plugins":{"enabled":["plur1bus"],"disabled":[]}}'
        self.files = {'config.yaml': (self.config, self.config), 'plugins/plur1bus/__init__.py': (b'version = "old"', b'version = "new"')}
        for relative, (before, after) in self.files.items():
            destination = self.home / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(after)
            original = self.backup / 'before' / relative
            original.parent.mkdir(parents=True, exist_ok=True)
            original.write_bytes(before)

    def journal(self, applied, pending):
        document = {'home': str(self.home), 'status': 'install-failed-recovery-required', 'pipChanged': False,
                    'files': {name: {'before': installer.digest(before), 'after': installer.digest(after)}
                              for name, (before, after) in self.files.items()},
                    'pmSelections': [{'profile': 'default', 'beforeEnabled': ['plur1bus'], 'beforeDisabled': [], 'applied': applied}]}
        if pending:
            document['pendingPmProfile'] = 'default'
        (self.backup / 'journal.json').write_text(json.dumps(document))

    def rollback(self):
        review = installer.rollback(self.home, self.backup.name)
        return installer.rollback(self.home, self.backup.name, review['confirmation'], True)

    def test_applied_or_pending_admission_rebuilds_old_packages_even_when_config_is_identical(self):
        def readmit(home, profile, enabled, disabled, expected_config):
            self.assertEqual(home, self.home)
            self.assertEqual(profile, self.home)
            self.assertEqual((home / 'plugins/plur1bus/__init__.py').read_bytes(), b'version = "old"')
            self.assertEqual((home / 'config.yaml').read_bytes(), self.config)
            self.assertEqual(expected_config, installer.digest(self.config))
        for applied, pending in ((True, False), (False, True)):
            with self.subTest(applied=applied, pending=pending):
                self.journal(applied, pending)
                with patch.object(installer, 'run_pm_selection', side_effect=readmit) as admit:
                    result = self.rollback()
                admit.assert_called_once()
                self.assertTrue(result['restored'])
                self.assertIn('original-generation-identity-unverified', result['pmGenerationRecovery'])
                document = json.loads((self.backup / 'journal.json').read_text())
                self.assertEqual(document['status'], 'files-restored-pm-selection-admitted')
                self.assertNotIn('runtimeRecovery', document)

    def test_failed_readmission_requires_repair_and_never_claims_safe_restart(self):
        self.journal(True, False)
        with patch.object(installer, 'run_pm_selection', side_effect=ValueError('private diagnostic')) as admit:
            result = self.rollback()
        admit.assert_called_once()
        self.assertTrue(result['repairRequired'])
        document = json.loads((self.backup / 'journal.json').read_text())
        self.assertEqual(document['status'], 'files-restored-pm-repair-required')
        self.assertNotIn('private diagnostic', json.dumps(document))
        self.assertNotIn('runtimeRecovery', document)
