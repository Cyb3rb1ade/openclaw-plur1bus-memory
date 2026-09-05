"""Live backend cache contracts without a network or productive profile."""

import json
import asyncio
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from plur1bus_hermes.llm_backend import InternalLlmBackend
from plur1bus_hermes.llm_cache import LlmResultCache
from plur1bus_hermes.cache import EmbeddingCache


class Response:
    def __init__(self, text):
        self.text = text

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps({"choices": [{"message": {"content": self.text}}],
                           "usage": {"total_tokens": 7}}).encode()


class BackendCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = LlmResultCache(Path(self.temp.name), "agent")
        self.addCleanup(self.cache.close)
        self.calls = 0
        self.output = '{"query":"precise query"}'
        self.config = {"llm": {"model": "test", "baseUrl": "http://test.invalid/v1"}}

    def open(self, request, **kwargs):
        self.calls += 1
        return Response(self.output)

    def backend(self, agent="agent"):
        return InternalLlmBackend(self.config, agent, opener=self.open, cache=self.cache)

    def test_live_allowlisted_transform_hits_cache(self):
        backend = self.backend()
        for _ in range(2):
            self.assertEqual(backend.complete_json("query-refinement", "instruction", "query"), {"query": "precise query"})
        self.assertEqual(self.calls, 1)

    def test_unknown_critical_and_dream_purposes_bypass(self):
        backend = self.backend()
        for purpose in ("main-chat", "critical-classification", "dream-narrative", "emotion-tier3"):
            for _ in range(2):
                backend.complete_json(purpose, "instruction", "query")
        self.assertEqual(self.calls, 8)

    def test_effective_payload_agent_and_credentials_partition_cache(self):
        self.backend().complete_json("query-refinement", "s", "u")
        self.backend("other").complete_json("query-refinement", "s", "u")
        self.config["llm"]["requestExtra"] = {"temperature": 0}
        self.backend().complete_json("query-refinement", "s", "u")
        self.config["llm"]["requestExtra"] = {"temperature": 0, "top_p": 0.5}
        self.backend().complete_json("query-refinement", "s", "u")
        self.config["llm"]["apiKey"] = "rotated-secret"
        self.backend().complete_json("query-refinement", "s", "u")
        self.assertEqual(self.calls, 5)

    def test_invalid_live_response_never_cached(self):
        backend = self.backend()
        for output in ("not-json", "[]", '{}', '{"query":""}'):
            self.output = output
            with self.assertRaises(RuntimeError):
                backend.complete_json("query-refinement", "s", "u")
        self.output = '{"query":"good"}'
        self.assertEqual(backend.complete_json("query-refinement", "s", "u"), {"query": "good"})
        self.assertEqual(self.calls, 5)

    def test_broken_cache_read_and_write_do_not_block_live(self):
        def broken(*args, **kwargs):
            raise RuntimeError("synthetic failure")
        backend = self.backend()
        self.cache.get = broken
        self.assertEqual(backend.complete_json("query-refinement", "s", "u"), {"query": "precise query"})
        self.cache.get = lambda *args: None
        self.cache.put = broken
        backend.complete_json("query-refinement", "s", "u")
        self.assertEqual(self.calls, 2)

    def test_synchronous_concurrent_calls_coalesce(self):
        barrier = threading.Barrier(4)
        count_lock = threading.Lock()
        def opener(*args, **kwargs):
            with count_lock:
                self.calls += 1
            time.sleep(0.05)
            return Response(self.output)
        backend = InternalLlmBackend(self.config, "agent", opener=opener, cache=self.cache)
        def call(_):
            barrier.wait()
            return backend.complete_json("query-refinement", "s", "u")
        with ThreadPoolExecutor(max_workers=4) as executor:
            values = list(executor.map(call, range(4)))
        self.assertEqual(self.calls, 1)
        self.assertEqual(len(values), 4)
        self.assertEqual(self.cache.metrics["coalesced"], 3)

    def test_poisoned_cached_object_is_repaired(self):
        backend = self.backend()
        backend.complete_json("query-refinement", "s", "u")
        for key, (expiry, result) in self.cache._memory.items():
            self.cache._memory[key] = (expiry, {**result, "text": "[]"})
        backend.complete_json("query-refinement", "s", "u")
        backend.complete_json("query-refinement", "s", "u")
        self.assertEqual(self.calls, 2)

    def test_async_cache_faults_and_close_do_not_discard_live_result(self):
        async def scenario():
            started, finish = asyncio.Event(), asyncio.Event()
            def broken(*args, **kwargs):
                raise RuntimeError("synthetic cache fault")
            async def compute():
                started.set()
                await finish.wait()
                return '{"query":"good"}', {}
            self.cache.get = broken
            self.cache.put = broken
            task = asyncio.create_task(self.cache.get_or_compute({"purpose": "query-refinement"}, compute))
            await started.wait()
            finish.set()
            await self.cache.aclose()
            self.assertEqual((await task)["text"], '{"query":"good"}')
        asyncio.run(scenario())


class EmbeddingCacheContractTests(unittest.TestCase):
    def test_runtime_upstream_cache_off_overrides_native_sizes(self):
        from plur1bus_hermes.runtime import Plur1busRuntime
        with tempfile.TemporaryDirectory() as directory:
            runtime = Plur1busRuntime(Path(directory), {
                "embedding": {"cacheMaxEntries": 99},
                "llmResultCache": {"maxEntries": 99},
                "runtime": {"embeddingCacheEnabled": False, "llmResultCacheEnabled": False},
            }, "agent")
            try:
                self.assertEqual(runtime._embedding._cache.max_entries, 0)
                self.assertEqual(runtime._llm_cache.max_entries, 0)
            finally:
                runtime.shutdown()

    def test_persistence_opt_in_and_routing_changes_invalidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = {"model": "m", "dimensions": 2, "baseUrl": "http://a"}
            cache = EmbeddingCache(config, root)
            cache.set("text", [1, 0])
            self.assertEqual(cache.get("text"), [1, 0])
            self.assertEqual(list(root.iterdir()), [])
            for key in ("baseUrl", "revision", "queryPrefix", "apiKey"):
                original = cache.key("text")
                config[key] = "changed"
                self.assertNotEqual(original, cache.key("text"))
            cache.close()

    def test_disabled_and_zero_disk_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            disabled = EmbeddingCache({"cacheMaxEntries": 0, "cachePersist": True}, root)
            disabled.set("text", [1])
            self.assertIsNone(disabled.get("text"))
            self.assertEqual(list(root.iterdir()), [])
            limited = EmbeddingCache({"cachePersist": True, "cacheMaxBytes": 0}, root)
            limited.set("text", [1])
            self.assertEqual(limited.metrics["persistSkips"], 1)
            self.assertEqual(limited.metrics["persistWrites"], 0)
            self.assertEqual(limited.get("text"), [1])
            limited.close()


if __name__ == "__main__":
    unittest.main()
