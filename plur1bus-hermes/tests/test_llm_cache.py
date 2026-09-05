import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.llm_cache import LlmResultCache


def _request(**updates):
    request = {
        "purpose": "categorize",
        "scopeId": "main",
        "endpoint": "http://127.0.0.1:8000/v1",
        "credential": "secret-key",
        "model": "gemma",
        "messages": [{"role": "user", "content": "private prompt"}],
        "maxTokens": 100,
        "temperature": 0,
        "jsonMode": True,
        "disableThinking": True,
        "headers": {"Authorization": "Bearer secret-key"},
    }
    request.update(updates)
    return request


class LlmResultCacheTests(unittest.TestCase):
    def test_persistent_cache_hashes_prompts_credentials_and_headers(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = LlmResultCache(Path(temporary), "main", persist=True)
            request = _request()
            self.assertTrue(cache.put(request, '{"category":"fact"}', {"total_tokens": 9}))
            db_path = cache.db_path
            cache.close()

            raw = db_path.read_bytes()
            self.assertNotIn(b"private prompt", raw)
            self.assertNotIn(b"secret-key", raw)

            reopened = LlmResultCache(Path(temporary), "main", persist=True)
            self.assertEqual(reopened.get(request)["text"], '{"category":"fact"}')
            self.assertIsNone(reopened.get(_request(model="other-model")))
            self.assertIsNone(reopened.get(_request(credential="rotated")))
            reopened.close()

    def test_unknown_purpose_and_invalid_json_are_not_cached(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = LlmResultCache(Path(temporary), "main")
            self.assertFalse(cache.put(_request(purpose="main-chat"), '{"ok":true}'))
            self.assertFalse(cache.put(_request(), "not-json"))
            self.assertIsNone(cache.get(_request()))

    def test_identical_inflight_calls_are_coalesced(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as temporary:
                cache = LlmResultCache(Path(temporary), "main")
                calls = 0

                async def compute():
                    nonlocal calls
                    calls += 1
                    await asyncio.sleep(0.01)
                    return '{"category":"fact"}', {"total_tokens": 3}

                first, second = await asyncio.gather(
                    cache.get_or_compute(_request(), compute),
                    cache.get_or_compute(_request(), compute),
                )
                self.assertEqual(calls, 1)
                self.assertEqual(first["text"], second["text"])
                self.assertEqual(cache.metrics["coalesced"], 1)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
