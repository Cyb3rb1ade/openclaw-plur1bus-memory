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


def _second_plugin_copy(name):
    """Import the plugin a second time under another name, as Hermes does for every further profile home
    (``hermes_plugins.plur1bus__home_<digest>``): a module-level lock then exists once per copy."""
    import importlib
    import importlib.util
    from pathlib import Path

    import plur1bus_hermes

    pkg_dir = Path(plur1bus_hermes.__file__).parent
    spec = importlib.util.spec_from_file_location(name, pkg_dir / "__init__.py",
                                                  submodule_search_locations=[str(pkg_dir)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return importlib.import_module(f"{name}.runtime")


def test_every_plugin_copy_in_one_process_shares_the_torch_lock():
    from plur1bus_hermes import runtime

    name = "plur1bus_hermes_second_profile_copy"
    try:
        copy = _second_plugin_copy(name)
        assert copy is not runtime
        assert copy._TORCH_INFERENCE_LOCK is runtime._TORCH_INFERENCE_LOCK, \
            "two profiles' copies of the plugin would run Torch on MPS at the same time"
    finally:
        for key in [k for k in sys.modules if k == name or k.startswith(name + ".")]:
            del sys.modules[key]


def test_loading_a_local_model_holds_the_torch_lock(monkeypatch, tmp_path):
    from plur1bus_hermes.runtime import _TORCH_INFERENCE_LOCK

    held = []

    def construct(result):
        held.append(_TORCH_INFERENCE_LOCK._is_owned())
        return result

    monkeypatch.setitem(
        sys.modules,
        "sentence_transformers",
        SimpleNamespace(
            SentenceTransformer=lambda *a, **k: construct(SimpleNamespace(
                encode=lambda *a, **k: SimpleNamespace(tolist=lambda: [1.0, 2.0]))),
            CrossEncoder=lambda *a, **k: construct(SimpleNamespace(predict=lambda pairs: [0.2, 0.9])),
        ),
    )
    config = {"provider": "local-transformers", "dimensions": 2}
    assert EmbeddingBackend(config, tmp_path)._embed_local(config, "text", purpose="query") == [1.0, 2.0]
    RerankerBackend(config, tmp_path).rerank("query", [{"content": "a"}, {"content": "b"}])
    assert held == [True, True], "a model was loaded onto the device outside the Torch lock"
