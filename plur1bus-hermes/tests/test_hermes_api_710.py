"""Hermes 0.21 provider-contract coverage for the 7.10 port."""

from __future__ import annotations

import unittest
from concurrent.futures import Future
from tempfile import TemporaryDirectory
from unittest.mock import patch

from plur1bus_hermes.provider import Plur1busMemoryProvider


class HermesApi710Tests(unittest.TestCase):
    def test_reinitialize_releases_old_runtime_and_prefetch_state_before_replacement(self) -> None:
        provider = Plur1busMemoryProvider({
            "dataDir": "plur1bus",
            "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
            "reranker": {"provider": "disabled"},
        })
        old_shutdown = []
        old = type("OldRuntime", (), {"shutdown": lambda _self: old_shutdown.append(True)})()
        pending = Future()
        stale_completion = Future()
        stale_completion.set_result("stale recall")
        old_generation = provider._prefetch_generation
        provider._runtime = old
        provider._prefetch_futures["old"] = pending
        provider._prefetch_cache["old"] = "stale"
        provider._last_recall_status = object()
        replacement = type("Replacement", (), {"scope_key": "new", "shutdown": lambda _self: None})()

        def replacement_factory(*_args: object) -> object:
            self.assertEqual(old_shutdown, [True])
            return replacement

        with TemporaryDirectory() as directory, patch(
            "plur1bus_hermes.provider.Plur1busRuntime", side_effect=replacement_factory
        ) as runtime_cls:
            provider.initialize("new-session", hermes_home=directory, agent_identity="agent")

        self.assertEqual(old_shutdown, [True])
        self.assertTrue(pending.cancelled())
        self.assertEqual(provider._prefetch_futures, {})
        self.assertEqual(provider._prefetch_cache, {})
        provider._store_prefetch_result("old", stale_completion, old_generation)
        self.assertEqual(provider._prefetch_cache, {})
        self.assertIsNone(provider.recall_status())
        self.assertIs(provider._runtime, replacement)
        runtime_cls.assert_called_once()
        provider.shutdown()

    def test_prefetch_reports_only_its_current_recall(self) -> None:
        provider = Plur1busMemoryProvider()
        provider._runtime = type("Runtime", (), {
            "recall": lambda _self, _query: "- one\n- two",
            "shutdown": lambda _self: None,
        })()

        self.assertEqual(
            provider.prefetch("query", session_id="session"),
            "<memory-context>\n- one\n- two\n</memory-context>",
        )
        status = provider.recall_status()
        self.assertIsNotNone(status)
        self.assertEqual(status.provider_label, "PLUR1BUS")
        self.assertEqual(status.count, 2)
        provider.shutdown()

    def test_internal_notification_is_not_captured_or_checkpointed(self) -> None:
        provider = Plur1busMemoryProvider()
        runtime = type("Runtime", (), {
            "capture_async": lambda *args, **kwargs: self.fail("must not capture"),
            "shutdown": lambda _self: None,
        })()
        provider._runtime = runtime
        messages = [
            {"role": "user", "content": "background wake", "display_kind": "internal_notification"},
            {"role": "assistant", "content": "done"},
        ]

        provider.sync_turn("background wake", "done", messages=messages)
        self.assertEqual(provider.on_pre_compress(messages), "")
        self.assertEqual(provider._checkpoint_messages(messages), [])
        provider.shutdown()

    def test_non_primary_context_skips_capture(self) -> None:
        provider = Plur1busMemoryProvider()
        provider._agent_context = "cron"
        runtime = type("Runtime", (), {
            "capture_async": lambda *args, **kwargs: self.fail("must not capture"),
            "shutdown": lambda _self: None,
        })()
        provider._runtime = runtime

        provider.sync_turn("internal job", "done")
        provider.shutdown()
