"""Regression coverage for model-bound persistent embedding caching."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.cache import EmbeddingCache


class EmbeddingCacheTests(unittest.TestCase):
    def test_persistent_value_survives_reopen_and_model_rotation_misses(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = {
                "provider": "omlx",
                "model": "embed-a",
                "dimensions": 4,
                "_scopeId": "main",
                "cachePersist": True,
            }
            cache = EmbeddingCache(config, root)
            cache.set("same text", [1.0, 0.0, 0.0, 0.0])
            cache.close()

            reopened = EmbeddingCache(config, root)
            self.assertEqual(reopened.get("same   text"), [1.0, 0.0, 0.0, 0.0])
            reopened.close()

            rotated = EmbeddingCache({**config, "model": "embed-b"}, root)
            self.assertIsNone(rotated.get("same text"))
            rotated.close()


if __name__ == "__main__":
    unittest.main()
