"""Real SQLite pressure, legacy schema and corrupt-vector regressions."""

import hashlib
import json
import sqlite3

import pytest

from plur1bus_hermes.cache import EmbeddingCache
from plur1bus_hermes.cache_budget import disk_bytes
from plur1bus_hermes.llm_cache import LlmResultCache
from plur1bus_hermes.llm_backend import InternalLlmBackend


def request(index):
    return {"purpose": "emotion-classification", "scopeId": "a", "messages": [str(index)]}


@pytest.mark.parametrize("kind", ["embedding", "llm"])
def test_pressure_reclaims_and_continues_persisting(tmp_path, kind):
    budget = 200_000
    if kind == "embedding":
        cache = EmbeddingCache({"cachePersist": True, "dimensions": 512, "cacheMaxBytes": budget}, tmp_path)
        put = lambda i: cache.set(str(i), [0.123456789] * 512)
        connection, path = cache._database, cache._db_path
    else:
        cache = LlmResultCache(tmp_path, "a", persist=True, max_bytes=budget)
        put = lambda i: cache.put(request(i), "x" * 6000)
        connection, path = cache._connection, cache.db_path
    try:
        assert connection.execute("PRAGMA auto_vacuum").fetchone()[0] == 2
        for index in range(100):
            put(index)
        assert cache.metrics["persistWrites"] == 100
        assert disk_bytes(path) < budget
        cache._memory.clear()
        assert (cache.get("99") if kind == "embedding" else cache.get(request(99))) is not None
        assert connection.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    finally:
        cache.close()


def test_persistent_llm_lru_max_entries_and_schema_upgrade(tmp_path):
    directory = tmp_path / "cache" / "llm-result-cache-v1"
    directory.mkdir(parents=True)
    path = directory / (hashlib.sha256(b"a").hexdigest()[:24] + ".sqlite")
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE results(cache_key TEXT PRIMARY KEY, response_text TEXT NOT NULL, "
                           "usage_json TEXT NOT NULL, expires_at INTEGER NOT NULL)")
    cache = LlmResultCache(tmp_path, "a", persist=True, max_entries=2)
    try:
        cache.put(request(1), "one")
        cache.put(request(2), "two")
        # Force ordered timestamps and a persistent hit on the first result.
        cache._connection.execute("UPDATE results SET accessed_at=1")
        cache._connection.commit()
        cache._memory.clear()
        assert cache.get(request(1))["text"] == "one"
        cache.put(request(3), "three")
        cache._memory.clear()
        assert cache.get(request(1))["text"] == "one"
        assert cache.get(request(2)) is None
        assert cache.get(request(3))["text"] == "three"
        assert cache._connection.execute("SELECT COUNT(*) FROM results").fetchone()[0] == 2
    finally:
        cache.close()


@pytest.mark.parametrize("bad", [[1], [1, float("nan")], {"a": 1, "b": 2}, []])
def test_poisoned_persistent_vector_falls_back_and_repairs(tmp_path, bad):
    cache = EmbeddingCache({"cachePersist": True, "dimensions": 2}, tmp_path)
    try:
        cache.set("text", [1, 0])
        cache._memory.clear()
        cache._database.execute("UPDATE embeddings SET vector=?", (json.dumps(bad),))
        cache._database.commit()
        calls = []
        def live():
            calls.append(1)
            return [0, 1]
        assert cache.get_or_compute("text", live) == [0, 1]
        cache._memory.clear()
        assert cache.get_or_compute("text", live) == [0, 1]
        assert len(calls) == 1
    finally:
        cache.close()


@pytest.mark.parametrize("purpose,expected", [
    ("emotion-classification", 1), ("skill-workshop-mining", 1), ("episode-extraction", 1),
    ("merge-decision", 1), ("light-dream", 2), ("meta-reflection", 2),
    ("critical-classification", 2), ("main-chat", 2), ("unknown", 2),
])
def test_native_consumer_mapping_and_exclusions(tmp_path, purpose, expected):
    calls = []
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self):
            return b'{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}'
    def opener(*args, **kwargs):
        calls.append(1)
        return Response()
    cache = LlmResultCache(tmp_path, "a")
    try:
        backend = InternalLlmBackend({"llm": {"model": "test", "baseUrl": "http://test.invalid/v1"}},
                                     "a", opener=opener, cache=cache)
        for _ in range(2):
            assert backend.complete_json(purpose, "s", "u") == {"ok": True}
        assert len(calls) == expected
    finally:
        cache.close()
