"""Unit tests for portable backend selection and the HTTP sidecar contract."""

from __future__ import annotations

import math
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from mtplx_embed.backends import JinaTransformersEmbedder, JinaTransformersReranker, build_embedder, build_reranker
from mtplx_embed.server import ServiceConfig, create_app


class _Embedder:
    reference = "jinaai/jina-embeddings-v5-text-small"
    loaded = False
    dimensions = 1024

    def embed(self, texts, *, instruction=None):
        del instruction
        return [[1.0] + [0.0] * 1023 for _ in texts]

    def unload(self):
        return None


class _Reranker:
    reference = "jinaai/jina-reranker-v3.5"
    loaded = False

    def score(self, query, documents, *, instruction=None):
        del query, instruction
        return [0.1 if "unrelated" in document else 0.9 for document in documents]

    def unload(self):
        return None


class _OfficialJinaEmbedModel:
    def __init__(self) -> None:
        self.calls = []

    def encode(self, **kwargs):
        self.calls.append(kwargs)
        return [[3.0, 4.0]]


class ServiceTests(unittest.TestCase):
    def test_transformers_backend_is_portable_and_lazy(self) -> None:
        self.assertIsInstance(build_embedder("jinaai/jina-embeddings-v5-text-small", backend="transformers"), JinaTransformersEmbedder)
        self.assertIsInstance(build_reranker("jinaai/jina-reranker-v3.5", backend="transformers"), JinaTransformersReranker)

    def test_transformers_jina_encode_uses_official_retrieval_prompt_contract(self) -> None:
        embedder = JinaTransformersEmbedder("jinaai/jina-embeddings-v5-text-small")
        model = _OfficialJinaEmbedModel()
        embedder._model = model

        embedder.embed(["question"], instruction="search")
        embedder.embed(["document"])

        self.assertEqual(model.calls, [
            {"texts": ["question"], "task": "retrieval", "prompt_name": "query"},
            {"texts": ["document"], "task": "retrieval", "prompt_name": "document"},
        ])

    def test_http_contract_has_normalized_1024_embeddings_and_plausible_rerank(self) -> None:
        with patch("mtplx_embed.server.build_embedder", return_value=_Embedder()), patch(
            "mtplx_embed.server.build_reranker", return_value=_Reranker()
        ):
            with TestClient(create_app(ServiceConfig(idle_seconds=0))) as client:
                models = client.get("/v1/models")
                self.assertEqual(models.status_code, 200)
                self.assertEqual(len(models.json()["data"]), 2)
                embedded = client.post("/v1/embeddings", json={"model": "jina-embeddings-v5-text-small", "input": "test"})
                self.assertEqual(embedded.status_code, 200)
                vector = embedded.json()["data"][0]["embedding"]
                self.assertEqual(len(vector), 1024)
                self.assertAlmostEqual(math.sqrt(sum(value * value for value in vector)), 1.0)
                ranked = client.post("/v1/rerank", json={"model": "jina-reranker-v3.5", "query": "Jina", "documents": ["unrelated", "Jina retrieval"]})
                self.assertEqual(ranked.status_code, 200)
                self.assertEqual(ranked.json()["results"][0]["index"], 1)


if __name__ == "__main__":
    unittest.main()
