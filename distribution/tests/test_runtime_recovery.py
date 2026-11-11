"""Checked receipt retry against real temporary installer transactions."""
from pathlib import Path
import json
import unittest
from unittest.mock import patch
from distribution.tests.test_installer_runtime import RuntimeInstallerTests, installer


class RecoveryTests(RuntimeInstallerTests):
    def failed_restart(self):
        self.fail_resume = True
        with self.assertRaises(ValueError):
            self.apply()
        self.fail_resume = False
        return next((self.fixture.home / 'plur1bus-install-backups').iterdir())

    def retry(self, receipt):
        return installer.restore_runtimes(self.fixture.bundle, self.fixture.home, receipt.name, self.events.append)

    def test_completed_install_retry_is_idempotent(self):
        receipt = self.failed_restart()
        self.retry(receipt)
        self.assertEqual(self.journal()['status'], 'installed-restored')
        resumed = self.actions.count('resume')
        self.retry(receipt)
        self.assertEqual(self.actions.count('resume'), resumed)
        self.assertEqual(self.events[-1]['phase'], 'installation-outcome')

    def test_changed_installed_file_prevents_retry(self):
        receipt = self.failed_restart()
        (self.fixture.home / 'desktop-plugins/plur1bus/plugin.js').write_text('changed')
        before = list(self.actions)
        with self.assertRaisesRegex(ValueError, 'changed|verification'):
            self.retry(receipt)
        self.assertEqual(before, self.actions)

    def test_active_lock_is_not_removed_by_recovery(self):
        receipt = self.failed_restart()
        lock = self.fixture.home / '.plur1bus-install-lock'
        lock.mkdir()
        with self.assertRaises(FileExistsError):
            self.retry(receipt)
        self.assertTrue(lock.is_dir())

    def test_partial_installation_has_no_blind_restart(self):
        receipt = self.failed_restart()
        path = receipt / 'journal.json'
        journal = json.loads(path.read_text())
        journal['status'] = 'install-failed-recovery-required'
        path.write_text(json.dumps(journal))
        before = list(self.actions)
        with self.assertRaisesRegex(ValueError, 'partial|safe'):
            self.retry(receipt)
        self.assertEqual(before, self.actions)

    def test_receipt_path_traversal_and_foreign_bundle_refused(self):
        receipt = self.failed_restart()
        with self.assertRaises(ValueError):
            installer.restore_runtimes(self.fixture.bundle, self.fixture.home, '../' + receipt.name)
        self.fixture.write_bundle('7.12.0-hermes.3')
        with self.assertRaisesRegex(ValueError, 'bundle'):
            self.retry(receipt)

    def test_prewrite_refusal_can_retry_restoration(self):
        original = installer.verify_bundle
        def verify(bundle):
            if 'stop' in self.actions:
                raise ValueError('prewrite fixture refusal')
            return original(bundle)
        self.fail_resume = True
        with patch.object(installer, 'verify_bundle', side_effect=verify), self.assertRaises(ValueError):
            self.apply()
        self.fail_resume = False
        receipt = next((self.fixture.home / 'plur1bus-install-backups').iterdir())
        self.assertEqual(self.journal()['status'], 'refused-recovery-required')
        self.retry(receipt)
        self.assertEqual(self.journal()['status'], 'refused-restored')

    def test_verified_file_rollback_enables_receipt_recovery(self):
        receipt = self.failed_restart()
        plan = installer.rollback(self.fixture.home, receipt.name)
        installer.rollback(self.fixture.home, receipt.name, plan['confirmation'], True)
        self.retry(receipt)
        self.assertEqual(self.journal()['status'], 'rollback-restored')
