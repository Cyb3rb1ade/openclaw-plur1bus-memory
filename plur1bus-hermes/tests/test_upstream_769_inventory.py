"""Pin the complete upstream delta and the separately reviewed upstream fix."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
BASE = "039329d0c74525448190b0bd2ec3ef3551ed168f"
TARGET = "784e900541fddb1d13a75104b6570e52051fd82c"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


class Upstream769InventoryTests(unittest.TestCase):
    def test_ancestry_inventory_and_exact_runtime(self):
        subprocess.run(["git", "merge-base", "--is-ancestor", TARGET, "HEAD"], cwd=ROOT, check=True)
        paths = git("diff", "--name-only", BASE, TARGET).splitlines()
        self.assertEqual(len(paths), 76)
        review = (ROOT / "docs/audits/hermes-7.12.69-delta-review.md").read_text(encoding="utf-8")
        for path in paths:
            with self.subTest(path=path):
                self.assertIn("`" + path + "`", review)
                if path == "tests/release-750-compat.test.js":
                    continue
                if path.startswith(("lib/", "tests/", "scripts/")) or path == "index.js":
                    expected = git("show", TARGET + ":" + path)
                    if path == "lib/encoding-llm.js":
                        # PR #165: keep only these reviewed changes, not a broad exemption.
                        expected = expected.replace('    lastDynamicsAt: now,\n', '')
                        expected = expected.replace('    emotionalDominant: encoding.emotion?.emotionalDominant || "neutral",\n',
                            '    emotionalDominant: encoding.emotion?.emotionalDominant || "neutral",\n'
                            '    // Ordinary classification is not reinforcement: moving lastDynamicsAt\n'
                            '    // without applying elapsed decay would rejuvenate the unchanged strength.\n')
                        expected = expected.replace('  if (flash) {',
                            '  // Explicit agent-band protection takes precedence over automatic flashbulb.\n  if (flash && !isAgentBand) {')
                        expected = expected.replace('    patch.lastStrengthenedAt = now;\n',
                            '    patch.lastStrengthenedAt = now;\n    patch.lastDynamicsAt = now;\n')
                    self.assertEqual((ROOT / path).read_text(encoding="utf-8"), expected)
