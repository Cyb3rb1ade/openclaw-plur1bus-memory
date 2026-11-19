"""Exercise simultaneous local embedding and reranking without Torch or models."""

import sys
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
from types import SimpleNamespace

from plur1bus_hermes.runtime import EmbeddingBackend, RerankerBackend


def test_transformer_embedding_and_reranking_share_an_inference_lock(monkeypatch, tmp_path):
    embedding_entered = Event()
    rerank_requested = Event()
    release_embedding = Event()
    overlap = Event()
    counter_lock = Lock()
    active = peak = 0

    def infer(result, *, hold=False):
        nonlocal active, peak
        with counter_lock:
            active += 1
            peak = max(peak, active)
            if active > 1:
                overlap.set()
        try:
            if hold:
                embedding_entered.set()
                assert release_embedding.wait(5)
            return result
        finally:
            with counter_lock:
                active -= 1

    def encode(*args, **kwargs):
        return infer(SimpleNamespace(tolist=lambda: [1.0, 2.0]), hold=True)

    def predict(pairs):
        return infer([0.2, 0.9])

    monkeypatch.setitem(
        sys.modules,
        "sentence_transformers",
        SimpleNamespace(
            SentenceTransformer=lambda *args, **kwargs: SimpleNamespace(encode=encode),
            CrossEncoder=lambda *args, **kwargs: SimpleNamespace(predict=predict),
        ),
    )
    config = {"provider": "local-transformers", "dimensions": 2}
    embedder = EmbeddingBackend(config, tmp_path)
    reranker = RerankerBackend(config, tmp_path)

    def rerank():
        rerank_requested.set()
        return reranker.rerank("query", [{"content": "other"}, {"content": "match"}])

    with ThreadPoolExecutor(max_workers=2) as executor:
        embedding = executor.submit(embedder._embed_local, config, "text", purpose="query")
        try:
            assert embedding_entered.wait(5)
            ranking = executor.submit(rerank)
            assert rerank_requested.wait(5)
            overlap.wait(1)
        finally:
            release_embedding.set()
        assert embedding.result(timeout=5) == [1.0, 2.0]
        assert [row["content"] for row in ranking.result(timeout=5)] == ["match", "other"]

    assert peak == 1, "Torch inference overlapped across the embedder and reranker"
