"""Engine IPC must be reachable from the normal embedding backend."""

from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

import pytest

from plur1bus_hermes.embedding_ipc import EngineIpcServer
from plur1bus_hermes.runtime import EmbeddingBackend, Plur1busRuntime, validate_native_embedding_config
from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.validation import ValidationError


def test_engine_ipc_passes_batch_and_purpose_and_keeps_cache_namespaced(tmp_path):
    config = {"provider": "engine-ipc", "model": "test-embedder", "dimensions": 2,
              "fingerprintId": "embedding:v1:sha256:" + "a" * 64,
              "stateRoot": str(tmp_path)}
    backend = EmbeddingBackend(config, tmp_path)
    other = EmbeddingBackend({**config, "fingerprintId": "embedding:v1:sha256:" + "b" * 64}, tmp_path)
    try:
        with patch("plur1bus_hermes.embedding_ipc.EngineIpcEmbedding") as create:
            client = create.return_value
            client.embed.return_value = [0.1, 0.2]
            client.embed_many.return_value = [[0.2, 0.3], [0.3, 0.4]]
            assert backend.embed("question", purpose="query") == [0.1, 0.2]
            assert backend.embed_many(["one", "two"]) == [[0.2, 0.3], [0.3, 0.4]]
            create.assert_called_once_with(config)
            client.embed.assert_called_once_with("question", purpose="query")
            client.embed_many.assert_called_once_with(["one", "two"], purpose="passage")
        assert backend._cache.key("question", "query") != other._cache.key("question", "query")
    finally:
        backend.close()
        other.close()


def test_engine_ipc_disallows_mixing_embedding_fallbacks(tmp_path):
    config = {"provider": "engine-ipc", "model": "test-embedder", "dimensions": 2,
              "fingerprintId": "embedding:v1:sha256:" + "a" * 64,
              "stateRoot": str(tmp_path), "fallback": {"provider": "omlx"}}
    with pytest.raises(ValidationError, match="fallback"):
        validate_native_embedding_config(config)


def test_normal_provider_accepts_explicit_engine_ipc_route(tmp_path):
    provider = Plur1busMemoryProvider()
    provider.config = {"embedding": {"provider": "engine-ipc", "model": "test-embedder", "dimensions": 2,
                                     "fingerprintId": "embedding:v1:sha256:" + "a" * 64,
                                     "stateRoot": str(tmp_path)}}
    try:
        provider._validate_runtime_config()
    finally:
        provider.shutdown()


def test_capture_and_recall_use_normal_runtime_over_the_native_endpoint(tmp_path):
    identity = {"model": "test-embedder", "dimensions": 2, "fingerprintId": "embedding:v1:sha256:" + "a" * 64}
    calls = []

    def encode(texts, *, purpose):
        calls.extend((text, purpose) for text in texts)
        return [[0.1, 0.2] for _ in texts]

    # macOS SOCKADDR_UN is bounded, use a short isolated host path.
    with TemporaryDirectory(prefix="p1ip-", dir="/tmp" if sys.platform == "darwin" else None) as directory:
        state_root = Path(directory).resolve()
        with EngineIpcServer(state_root, identity=identity, embed_many=encode):
            runtime = Plur1busRuntime(tmp_path, {"embedding": {
                **identity, "provider": "engine-ipc", "stateRoot": str(state_root),
            }}, "default")
            try:
                runtime._domain.on_memory = lambda *_args, **_kwargs: None
                runtime._remember("The offline test uses one native gateway", "older", "user")
                assert "offline test uses one native gateway" in runtime.recall("native gateway", automatic=True)
                assert ("The offline test uses one native gateway", "passage") in calls
                assert ("native gateway", "query") in calls
            finally:
                runtime.shutdown()
