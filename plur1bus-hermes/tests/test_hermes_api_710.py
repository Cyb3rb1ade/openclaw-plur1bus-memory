"""Hermes 0.21 provider-contract coverage for the 7.10 port."""

from __future__ import annotations

import json
import unittest
from concurrent.futures import Future
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.namespaces import ScopeBinding
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.service import PLUR1BUS_SERVICE


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

    def test_automatic_capture_and_recall_opt_outs_cover_every_lifecycle_path(self) -> None:
        provider = Plur1busMemoryProvider({"autoCapture": False, "autoRecall": False})
        provider._runtime = type("Runtime", (), {
            "capture_async": lambda *args, **kwargs: self.fail("automatic capture must be disabled"),
            "recall": lambda *args, **kwargs: self.fail("automatic recall must be disabled"),
            "shutdown": lambda _self: None,
        })()

        provider.sync_turn("user", "assistant")
        self.assertEqual(provider.on_pre_compress([{"role": "user", "content": "user"}]), "")
        self.assertEqual(provider.prefetch("query", session_id="session"), "")
        provider.queue_prefetch("query", session_id="session")
        self.assertEqual(provider._prefetch_futures, {})
        provider.shutdown()

    def test_explicit_tools_bypass_automatic_opt_outs_and_forward_public_arguments(self) -> None:
        stored = []
        recalled = []
        provider = Plur1busMemoryProvider({"autoCapture": False, "autoRecall": False})
        provider._session_id = "session"
        provider._runtime = type("Runtime", (), {
            "remember_async": lambda _self, *args, **kwargs: stored.append((args, kwargs)),
            "recall": lambda _self, *args, **kwargs: recalled.append((args, kwargs)) or "found",
            "shutdown": lambda _self: None,
        })()

        store = json.loads(provider.handle_tool_call("memory_store", {
            "text": "fact", "importance": 0.8,
            "validFrom": "2026-01-01T00:00:00Z",
            "validUntil": "2026-02-01T00:00:00Z",
            "expiresAt": "2026-03-01T00:00:00Z",
            "ttl": "short",
        }))
        recall = json.loads(provider.handle_tool_call("memory_recall", {
            "query": "fact", "limit": 7, "validAt": "2026-01-15T00:00:00Z",
            "full_text": True,
        }))

        self.assertTrue(store["ok"])
        self.assertEqual(stored[0][0], ("fact", "session"))
        self.assertEqual(stored[0][1]["source_role"], "tool")
        self.assertEqual(stored[0][1]["expires_at"], "2026-03-01T00:00:00Z")
        self.assertEqual(stored[0][1]["valid_from"], "2026-01-01T00:00:00Z")
        self.assertEqual(stored[0][1]["ttl"], "short")
        self.assertTrue(recall["ok"])
        self.assertEqual(recalled[0][0], ("fact",))
        self.assertEqual(recalled[0][1], {
            "limit": 7, "valid_at": "2026-01-15T00:00:00Z", "full_text": True,
        })
        schemas = {schema["name"]: schema for schema in provider.get_tool_schemas()}
        self.assertIn("expiresAt", schemas["memory_store"]["parameters"]["properties"])
        self.assertEqual(schemas["memory_store"]["parameters"]["properties"]["ttl"]["enum"], ["session", "short"])
        self.assertIn("validAt", schemas["memory_recall"]["parameters"]["properties"])
        self.assertIn("full_text", schemas["memory_recall"]["parameters"]["properties"])
        provider.shutdown()

    def test_explicit_store_preserves_trusted_context_and_rejects_ambiguous_time(self) -> None:
        stored = []
        provider = Plur1busMemoryProvider({"autoCapture": False})
        provider._runtime = type("Runtime", (), {
            "remember_async": lambda _self, *args, **kwargs: stored.append((args, kwargs)),
            "shutdown": lambda _self: None,
        })()

        denied = json.loads(provider.handle_tool_call(
            "memory_store", {"text": "do not store"}, agent_context="cron",
        ))
        invalid = json.loads(provider.handle_tool_call(
            "memory_store", {"text": "bad date", "validFrom": "sometime"},
        ))

        self.assertFalse(denied["ok"])
        self.assertFalse(invalid["ok"])
        self.assertIn("absolute ISO-8601", invalid["error"])
        self.assertEqual(stored, [])
        provider.shutdown()

    def test_reminder_extraction_runs_once_in_admitted_runtime_capture_path(self) -> None:
        extracted = []
        with TemporaryDirectory() as directory:
            binding = ScopeBinding("main")
            domain = Plur1busDomain(
                Path(directory), "main", {"reminders": {"autoExtract": True}}
            )
            domain.extract_reminder_proposals = lambda user, assistant, session_id, *, acl_bindings: (
                extracted.append((user, assistant, session_id, acl_bindings))
                or {"proposed": [{"proposalId": "pending"}]}
            )
            provider = Plur1busMemoryProvider({"autoCapture": True})
            runtime = type("Runtime", (), {
                "_domain": domain, "scope_binding": binding,
                "_remember": lambda *_args, **_kwargs: None,
                "shutdown": lambda _self: None,
            })()

            def capture_async(user, assistant, session_id, *, importance=None):
                Plur1busRuntime._capture_turn(runtime, user, assistant, session_id, importance)

            runtime.capture_async = capture_async
            provider._runtime = runtime

            provider.sync_turn("remind me on 2027-01-01", "I can propose that", session_id="s")
            provider.sync_turn(
                "internal notification", "ignored", session_id="s2",
                messages=[{"role": "user", "content": "internal notification", "display_kind": "internal_notification"}],
            )

            self.assertEqual(extracted, [
                ("remind me on 2027-01-01", "I can propose that", "s", binding.as_dict())
            ])
            provider.shutdown()

    def test_readiness_is_published_only_after_success_and_cleared_after_failure_or_shutdown(self) -> None:
        state = PLUR1BUS_SERVICE.state()
        state.provider_ready = False
        state.active_profiles.clear()
        provider = Plur1busMemoryProvider({
            "dataDir": "plur1bus",
            "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
            "reranker": {"provider": "disabled"},
        })
        runtime = type("Runtime", (), {"scope_key": "scope", "shutdown": lambda _self: None})()
        with TemporaryDirectory() as directory, patch(
            "plur1bus_hermes.provider.Plur1busRuntime", return_value=runtime,
        ):
            provider.initialize("session", hermes_home=directory, agent_identity="agent")
        self.assertTrue(state.provider_ready)
        provider.shutdown()
        self.assertFalse(state.provider_ready)
        self.assertEqual(state.active_profiles, {})

        failed = Plur1busMemoryProvider({
            "dataDir": "plur1bus",
            "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
            "reranker": {"provider": "disabled"},
        })
        with TemporaryDirectory() as directory, patch(
            "plur1bus_hermes.provider.Plur1busRuntime", side_effect=RuntimeError("no runtime"),
        ), self.assertRaises(RuntimeError):
            failed.initialize("session", hermes_home=directory, agent_identity="agent")
        self.assertFalse(state.provider_ready)
        self.assertEqual(state.last_health["status"], "initialization_failed")

    def test_shutdown_clears_readiness_when_runtime_shutdown_raises(self) -> None:
        state = PLUR1BUS_SERVICE.state()
        state.provider_ready = True
        state.active_profiles["agent"] = {"sessionId": "session"}
        provider = Plur1busMemoryProvider()
        provider._active_runtime_agent = "agent"
        provider._runtime = type("Runtime", (), {
            "shutdown": lambda _self: (_ for _ in ()).throw(RuntimeError("shutdown failed")),
        })()

        with self.assertRaises(RuntimeError):
            provider.shutdown()
        self.assertFalse(state.provider_ready)
        self.assertEqual(state.active_profiles, {})
        self.assertEqual(state.last_health["status"], "shutdown")
