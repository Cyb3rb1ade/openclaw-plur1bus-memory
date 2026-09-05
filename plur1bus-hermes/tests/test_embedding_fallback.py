"""Regression coverage for the embedding fallback chain and the local path.

Covers EmbeddingBackend._embed_one_uncached (primary failure -> configured
fallback with a dimension guard) and _embed_local (query/passage prefixes,
normalize_embeddings, dimension guard) plus the cache interaction — all with
a stubbed sentence-transformers module, so no real model or network is used.
"""

from __future__ import annotations

import math
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from typing import Any
from unittest import mock

from plur1bus_hermes.cache import EmbeddingCache
from plur1bus_hermes.runtime import EmbeddingBackend
from plur1bus_hermes.validation import ValidationError

MISSING_KEY_ENV = "PLUR1BUS_TEST_EMBEDDING_KEY_MISSING"


class _StubVector:
    """Stand-in for the numpy array returned by SentenceTransformer.encode."""

    def __init__(self, values: list[float]) -> None:
        self._values = values

    def tolist(self) -> list[float]:
        return list(self._values)


def _stub_transformers_module(dims: int) -> ModuleType:
    """Build a fake sentence_transformers module with a counting stub model.

    The stub returns an already L2-normalized vector (first component 1.0,
    rest 0.0) of ``dims`` dimensions and records every encoded text so tests
    can assert on prefixes and call counts.
    """
    module = ModuleType("sentence_transformers")

    class StubTransformer:
        instances: list["StubTransformer"] = []

        def __init__(self, model_name: str, cache_folder: str | None = None) -> None:
            self.model_name = model_name
            self.cache_folder = cache_folder
            self.encoded: list[str] = []
            StubTransformer.instances.append(self)

        def encode(self, text: str, normalize_embeddings: bool = False) -> _StubVector:
            self.encoded.append(text)
            values = [0.0] * dims
            values[0] = 1.0
            return _StubVector(values)

    module.SentenceTransformer = StubTransformer  # type: ignore[attr-defined]
    return module


class EmbeddingFallbackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self._saved_key = os.environ.pop(MISSING_KEY_ENV, None)

    def tearDown(self) -> None:
        if self._saved_key is not None:
            os.environ[MISSING_KEY_ENV] = self._saved_key
        self.temporary.cleanup()

    def _backend(self, config: dict[str, Any]) -> EmbeddingBackend:
        backend = EmbeddingBackend(config, self.root)
        self.addCleanup(backend.close)
        return backend

    def test_remote_without_key_falls_back_to_local_stub(self) -> None:
        config = {
            "provider": "openai-compatible",
            "model": "remote-embed-large",
            "dimensions": 4,
            "apiKeyEnv": MISSING_KEY_ENV,
            "fallback": {"provider": "local-transformers", "model": "stub-local-e5", "dimensions": 4},
        }
        backend = self._backend(config)
        module = _stub_transformers_module(dims=4)

        with mock.patch.dict(sys.modules, {"sentence_transformers": module}):
            vector = backend.embed("fallback text")

        self.assertEqual(vector, [1.0, 0.0, 0.0, 0.0])
        transformer = module.SentenceTransformer.instances[0]
        self.assertEqual(transformer.model_name, "stub-local-e5")
        self.assertEqual(transformer.encoded, ["passage: fallback text"])

        # Without a configured fallback the primary RuntimeError must propagate.
        bare = self._backend({key: value for key, value in config.items() if key != "fallback"})
        with self.assertRaises(RuntimeError) as raised:
            bare.embed("no fallback text")
        self.assertIn("API key is not configured", str(raised.exception))

    def test_fallback_dimension_mismatch_raises_clear_error(self) -> None:
        config = {
            "provider": "openai-compatible",
            "model": "remote-embed-large",
            "dimensions": 4,
            "apiKeyEnv": MISSING_KEY_ENV,
            # No "dimensions" here on purpose: the fallback model itself is
            # consistent (3-dim), only the primary contract expects 4.
            "fallback": {"provider": "local-transformers", "model": "stub-local-small"},
        }
        backend = self._backend(config)
        module = _stub_transformers_module(dims=3)

        with mock.patch.dict(sys.modules, {"sentence_transformers": module}):
            with self.assertRaises(ValidationError) as raised:
                backend.embed("dimension mismatch text")

        self.assertIn("incompatible dimensions", str(raised.exception))

    def test_local_primary_returns_normalized_vector_and_persists_cache(self) -> None:
        config = {
            "provider": "local-transformers",
            "model": "intfloat/multilingual-e5-base",
            "dimensions": 768,
            "_scopeId": "main",
            "cachePersist": True,
        }
        backend = self._backend(config)
        module = _stub_transformers_module(dims=768)

        with mock.patch.dict(sys.modules, {"sentence_transformers": module}):
            vector = backend.embed("lokaler text", purpose="query")

        self.assertEqual(len(vector), 768)
        norm = math.sqrt(sum(value * value for value in vector))
        self.assertAlmostEqual(norm, 1.0, places=6)
        transformer = module.SentenceTransformer.instances[0]
        self.assertEqual(transformer.encoded, ["query: lokaler text"])

        # The persistent cache layer (cache.py) on the tmp path must hold it.
        self.assertTrue((self.root / "cache" / "embedding-cache-v2.sqlite").is_file())
        reopened = EmbeddingCache(config, self.root)
        try:
            self.assertEqual(reopened.get("lokaler text", "query"), vector)
        finally:
            reopened.close()

    def test_second_embed_of_same_text_hits_cache(self) -> None:
        config = {
            "provider": "local-transformers",
            "model": "stub-e5",
            "dimensions": 768,
            "cachePersist": True,
        }
        backend = self._backend(config)
        module = _stub_transformers_module(dims=768)

        with mock.patch.dict(sys.modules, {"sentence_transformers": module}):
            first = backend.embed("gleicher text")
            second = backend.embed("gleicher text")

        self.assertEqual(first, second)
        transformer = module.SentenceTransformer.instances[0]
        self.assertEqual(transformer.encoded, ["passage: gleicher text"])


if __name__ == "__main__":
    unittest.main()
