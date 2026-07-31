import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.code_index import query_code_index, rebuild_code_index


class CodeIndexTests(unittest.TestCase):
    def test_indexes_supported_sources_and_excludes_dependency_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            (workspace / "src").mkdir()
            (workspace / "src/app.py").write_text(
                "class MemoryAgent:\n    def recall(self):\n        pass\n",
                encoding="utf-8",
            )
            (workspace / "node_modules").mkdir()
            (workspace / "node_modules/ignored.js").write_text(
                "function hidden() {}",
                encoding="utf-8",
            )

            index = rebuild_code_index(workspace)
            results = query_code_index(workspace, "MemoryAgent recall")

            self.assertEqual(index["fileCount"], 1)
            self.assertEqual(results[0]["path"], "src/app.py")
            self.assertIn("MemoryAgent", results[0]["symbols"])
            self.assertIn("recall", results[0]["symbols"])


if __name__ == "__main__":
    unittest.main()
