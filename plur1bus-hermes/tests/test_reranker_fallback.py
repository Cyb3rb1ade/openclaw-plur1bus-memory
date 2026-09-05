"""Regression coverage for the reranker fallback chain (JS fail-open parity)."""

from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from plur1bus_hermes.runtime import RerankerBackend

MISSING_KEY_ENV = "PLUR1BUS_RERANKER_TEST_MISSING_KEY"
SET_KEY_ENV = "PLUR1BUS_RERANKER_TEST_SET_KEY"


def _rows() -> list[dict[str, str]]:
    return [{"content": "low"}, {"content": "mid"}, {"content": "high"}]


class _StubCrossEncoder:
    """Stand-in for sentence_transformers.CrossEncoder without model downloads."""

    instances: list["_StubCrossEncoder"] = []
    fail: bool = False

    def __init__(self, model_name: str, cache_folder: str | None = None) -> None:
        if _StubCrossEncoder.fail:
            raise RuntimeError("local reranker unavailable")
        self.model_name = model_name
        self.cache_folder = cache_folder
        _StubCrossEncoder.instances.append(self)

    def predict(self, pairs: list[tuple[str, str]]) -> list[float]:
        scores = {"low": 0.1, "mid": 0.9, "high": 0.5}
        return [scores[content] for _query, content in pairs]


def _stubbed_sentence_transformers() -> types.ModuleType:
    module = types.ModuleType("sentence_transformers")
    module.CrossEncoder = _StubCrossEncoder  # type: ignore[attr-defined]
    return module


class RerankerFallbackTests(unittest.TestCase):
    def setUp(self) -> None:
        _StubCrossEncoder.instances = []
        _StubCrossEncoder.fail = False
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.home = Path(self._directory.name)

    def _backend(self, config: dict[str, object]) -> RerankerBackend:
        return RerankerBackend(config, self.home)

    def test_cohere_without_api_key_falls_back_to_local_bge(self) -> None:
        config = {
            "provider": "cohere",
            "apiKeyEnv": MISSING_KEY_ENV,
            "fallbackProvider": "local-transformers",
        }
        with mock.patch.dict(os.environ) as env, mock.patch.dict(
            sys.modules, {"sentence_transformers": _stubbed_sentence_transformers()}
        ):
            env.pop(MISSING_KEY_ENV, None)
            result = self._backend(config).rerank("query", _rows())
        self.assertEqual([row["content"] for row in result], ["mid", "high", "low"])
        self.assertEqual([row["rerankScore"] for row in result], [0.9, 0.5, 0.1])
        self.assertEqual(len(_StubCrossEncoder.instances), 1)
        self.assertEqual(_StubCrossEncoder.instances[0].model_name, "BAAI/bge-reranker-v2-m3")

    def test_cohere_http_error_falls_back_to_local_bge(self) -> None:
        config = {
            "provider": "cohere",
            "apiKeyEnv": SET_KEY_ENV,
            "fallbackProvider": "local-transformers",
        }
        with mock.patch.dict(os.environ, {SET_KEY_ENV: "test-key"}), mock.patch.dict(
            sys.modules, {"sentence_transformers": _stubbed_sentence_transformers()}
        ), mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            result = self._backend(config).rerank("query", _rows())
        self.assertEqual([row["content"] for row in result], ["mid", "high", "low"])
        self.assertEqual(len(_StubCrossEncoder.instances), 1)
        self.assertEqual(_StubCrossEncoder.instances[0].model_name, "BAAI/bge-reranker-v2-m3")

    def test_double_failure_returns_unreranked_rows(self) -> None:
        # JS parity (lib/reranker-chained.js): when the primary reranker and the
        # local fallback both fail, recall must continue with unreranked rows
        # instead of propagating the exception.
        config = {
            "provider": "cohere",
            "apiKeyEnv": MISSING_KEY_ENV,
            "fallbackProvider": "local-transformers",
        }
        _StubCrossEncoder.fail = True
        with mock.patch.dict(os.environ) as env, mock.patch.dict(
            sys.modules, {"sentence_transformers": _stubbed_sentence_transformers()}
        ):
            env.pop(MISSING_KEY_ENV, None)
            rows = _rows()
            with self.assertLogs("plur1bus_hermes.runtime", level="WARNING"):
                result = self._backend(config).rerank("query", rows)
        self.assertEqual(result, rows)
        self.assertNotIn("rerankScore", result[0])

    def test_missing_or_disabled_fallback_returns_unreranked_rows(self) -> None:
        for fallback in (None, "disabled"):
            with self.subTest(fallbackProvider=fallback):
                config: dict[str, object] = {
                    "provider": "cohere",
                    "apiKeyEnv": MISSING_KEY_ENV,
                }
                if fallback is not None:
                    config["fallbackProvider"] = fallback
                with mock.patch.dict(os.environ) as env:
                    env.pop(MISSING_KEY_ENV, None)
                    rows = _rows()
                    result = self._backend(config).rerank("query", rows)
                self.assertEqual(result, rows)
                self.assertNotIn("rerankScore", result[0])


if __name__ == "__main__":
    unittest.main()
