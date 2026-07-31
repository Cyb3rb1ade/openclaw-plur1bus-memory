import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.namespaces import resolve_namespace_routes


class NamespaceTests(unittest.TestCase):
    def test_resolves_one_writer_and_read_only_legacy_routes(self):
        with tempfile.TemporaryDirectory() as temporary:
            writer, recall = resolve_namespace_routes(
                Path(temporary),
                "main",
                {
                    "namespaces": {
                        "activeWriteNamespace": "local",
                        "activeRecallNamespaces": ["local"],
                        "legacyReadOnlyNamespaces": ["legacy"],
                        "crossNamespaceRecall": True,
                    }
                },
            )

            self.assertTrue(writer.writable)
            self.assertEqual([route.name for route in recall], ["local", "legacy"])
            self.assertFalse(recall[1].writable)
            self.assertTrue(str(recall[1].path).endswith("legacy/main"))

    def test_rejects_writer_outside_active_recall(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                resolve_namespace_routes(
                    Path(temporary),
                    "main",
                    {
                        "namespaces": {
                            "activeWriteNamespace": "writer",
                            "activeRecallNamespaces": ["other"],
                            "legacyReadOnlyNamespaces": [],
                        }
                    },
                )


if __name__ == "__main__":
    unittest.main()
