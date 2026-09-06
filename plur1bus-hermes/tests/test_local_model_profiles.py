"""Unit contracts for optional pinned local model profiles (no model download)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from plur1bus_hermes.runtime import EmbeddingBackend
from plur1bus_hermes.validation import ValidationError


_JINA_MODEL = "jinaai/jina-embeddings-v3"


class _Vector(list[float]):
    def tolist(self) -> list[float]:
        return list(self)


class LocalModelProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.backend = EmbeddingBackend({}, Path(self.directory.name))

    def tearDown(self) -> None:
        self.backend.close()
        self.directory.cleanup()

    @staticmethod
    def _jina_config(**overrides: object) -> dict[str, object]:
        return {
            "provider": "local-transformers",
            "model": _JINA_MODEL,
            "dimensions": 32,
            "acceptNonCommercialLicense": True,
            **overrides,
        }

    def test_jina_license_is_checked_before_the_model_module_is_imported(self) -> None:
        with patch.dict(sys.modules, {"sentence_transformers": None}):
            with self.assertRaisesRegex(RuntimeError, "explicit acceptance"):
                self.backend._embed_local(
                    self._jina_config(acceptNonCommercialLicense=False), "private", purpose="query"
                )
        self.assertEqual(self.backend._models, {})

    def test_accepted_jina_still_fails_closed_without_importing_remote_code(self) -> None:
        with patch.dict(sys.modules, {"sentence_transformers": None}):
            with self.assertRaisesRegex(RuntimeError, "separately versioned repository"):
                self.backend._embed_local(self._jina_config(), "needle", purpose="query")
        self.assertEqual(self.backend._models, {})

    def test_jina_rejects_non_matryoshka_width_before_model_import(self) -> None:
        with patch.dict(sys.modules, {"sentence_transformers": None}):
            with self.assertRaisesRegex(ValidationError, "dimensions must be one of"):
                self.backend._embed_local(self._jina_config(dimensions=384), "needle", purpose="query")
        self.assertEqual(self.backend._models, {})

    def test_every_pinned_matryoshka_width_reaches_the_same_fail_closed_boundary(self) -> None:
        for width in (32, 64, 128, 256, 512, 768, 1024):
            with self.assertRaisesRegex(RuntimeError, "local loading is unsupported"):
                self.backend._embed_local(
                    self._jina_config(dimensions=width), "needle", purpose="query"
                )

    def test_e5_path_remains_unchanged(self) -> None:
        model = Mock()
        model.encode.return_value = _Vector([1.0, 2.0])
        factory = Mock(return_value=model)
        module = SimpleNamespace(SentenceTransformer=factory)
        config = {
            "provider": "local-transformers",
            "model": "intfloat/multilingual-e5-base",
            "dimensions": 2,
        }

        with patch.dict(sys.modules, {"sentence_transformers": module}):
            self.assertEqual(self.backend._embed_local(config, "needle", purpose="query"), [1.0, 2.0])

        factory.assert_called_once_with(
            "intfloat/multilingual-e5-base",
            cache_folder=str(Path(self.directory.name) / "plur1bus" / "models"),
        )
        model.encode.assert_called_once_with("query: needle", normalize_embeddings=True)

    def test_explicit_offline_revision_is_honored_and_separates_model_cache(self):
        model = Mock()
        model.encode.return_value = _Vector([1.0, 2.0])
        factory = Mock(return_value=model)
        config = {"provider": "local-transformers", "model": "test", "dimensions": 2,
                  "localFilesOnly": True, "revision": "pinned"}
        with patch.dict(sys.modules, {"sentence_transformers": SimpleNamespace(SentenceTransformer=factory)}):
            self.backend._embed_local(config, "query", purpose="query")
            self.backend._embed_local({**config, "revision": "different"}, "query", purpose="query")
        self.assertEqual(factory.call_count, 2)
        self.assertTrue(factory.call_args.kwargs["local_files_only"])
        self.assertEqual(factory.call_args.kwargs["revision"], "different")

    def test_close_releases_retained_models(self) -> None:
        first = Mock()
        second = Mock()
        self.backend._models = {"first": first, "second": second}
        cache = Mock()
        self.backend._cache = cache

        self.backend.close()

        self.assertEqual(self.backend._models, {})
        first.cpu.assert_not_called()
        second.cpu.assert_not_called()
        cache.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
