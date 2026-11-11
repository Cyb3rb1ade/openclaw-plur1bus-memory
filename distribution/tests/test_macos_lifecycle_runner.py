"""Native subprocess contract: final long progress event arrives before completion."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'macos'

@unittest.skipUnless(sys.platform == 'darwin' and shutil.which('xcrun'), 'requires native Swift')
class LifecycleRunnerTests(unittest.TestCase):
    def test_drains_long_final_event_before_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            probe = root / 'probe.swift'
            probe.write_text('''import Foundation
@main struct Probe {
 static func main() {
  runInstaller(python: CommandLine.arguments[1], arguments: ["-c", "import json,sys; sys.stderr.write(\\"PLUR1BUS_PROGRESS \\" + json.dumps({\\"phase\\":\\"installation-outcome\\",\\"status\\":\\"installed-restart-failed\\",\\"receipt\\":\\"/tmp/receipt\\",\\"recoveryAvailable\\":True,\\"padding\\":\\"x\\"*12000}) + \\"\\\\n\\"); sys.stderr.flush()"], progress: { event in
   print("EVENT:" + (event.status ?? "missing"))
  }, completion: { _, _, _ in print("DONE"); exit(0) })
  dispatchMain()
 }
}''')
            binary = root / 'probe'
            subprocess.run(['xcrun', 'swiftc', str(ROOT / 'InstallerRunner.swift'), str(ROOT / 'Localization.swift'), str(probe), '-o', str(binary)], check=True, capture_output=True)
            result = subprocess.run([str(binary), sys.executable], capture_output=True, text=True, check=True, timeout=15)
            self.assertEqual(result.stdout.splitlines(), ['EVENT:installed-restart-failed', 'DONE'])
