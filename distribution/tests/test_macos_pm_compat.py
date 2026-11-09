import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import macos_pm_compat as compat


class MacOSPMCompatibilityTests(unittest.TestCase):
    def test_compatibility_requires_the_complete_approved_pm_source(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            pm = project / "pm"
            pm.mkdir()
            contents = {name: name.encode() for name in compat.STOCK_PM_SHA256}
            for name, data in contents.items():
                (pm / name).write_bytes(data)
            digests = {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}
            with patch.object(compat, "STOCK_PM_SHA256", digests):
                self.assertEqual(compat.approved_sources(project), contents)
                (pm / "worker.py").write_bytes(b"worker source changed")
                self.assertIsNone(compat.approved_sources(project))
                with self.assertRaisesRegex(ValueError, "Hermes PM source changed"):
                    compat.enable_volume_sync(project, required=True)

    def test_worker_entry_keeps_pms_launcher_and_requires_its_verified_script(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            worker = root / "Hermes" / "pm" / "worker.py"
            expected = [sys.executable, "-I", "-B", str(worker)]
            helper = root / "installer" / "macos_pm_compat.py"
            with patch.object(compat, "__file__", str(helper)):
                command = compat.volume_sync_worker(lambda *_: expected)(None, {}, worker, {})
                self.assertEqual(command, expected[:-1] + [str(helper), "worker", str(worker)])
                with self.assertRaisesRegex(ValueError, "unexpected Hermes PM worker command"):
                    compat.volume_sync_worker(lambda *_: expected + ["other"])(None, {}, worker, {})
