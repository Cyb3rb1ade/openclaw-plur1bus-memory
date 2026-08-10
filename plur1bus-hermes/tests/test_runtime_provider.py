"""Regression coverage for Hermes runtime identity, scope, backup, and recall."""

from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.service import PLUR1BUS_SERVICE
from plur1bus_hermes.validation import ValidationError


class RuntimeProviderTests(unittest.TestCase):
    @staticmethod
    def _write_hermes_yaml(home: Path, text: str, profile: str = "") -> None:
        """Write a root or profile Hermes configuration fixture."""
        path = home / "config.yaml" if not profile else home / "profiles" / profile / "config.yaml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    @staticmethod
    def _provider_for(home: Path) -> Plur1busMemoryProvider:
        """Create a provider bound to the fixture's Hermes home."""
        provider = Plur1busMemoryProvider()
        provider._hermes_home = home
        return provider

    def test_scope_is_agent_wide_across_sessions(self) -> None:
        first = Plur1busRuntime._scope_key({"workspace": "one", "chat": "a"})
        second = Plur1busRuntime._scope_key({"workspace": "two", "chat": "b"})
        self.assertEqual(first, second)

    def test_profile_identity_overrides_default_config_and_backups_include_lancedb(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            provider = Plur1busMemoryProvider({
                "dataDir": "plur1bus",
                "agentId": "default",
                "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
                "reranker": {"provider": "disabled"},
            })
            provider.initialize("session", hermes_home=directory, agent_identity="bernhardine")
            self.assertEqual(provider._runtime.agent_id, "bernhardine")
            self.assertIn(str(Path(directory) / "plur1bus" / "lancedb"), provider.backup_paths())
            provider.shutdown()

    @staticmethod
    def _write_multiplex_home(directory: str) -> Path:
        """Lay out a root plugin config plus one cutover profile config."""
        home = Path(directory)
        embedding = {"provider": "omlx", "model": "embed", "dimensions": 4}
        root = home / "plugins" / "plur1bus" / "config.json"
        root.parent.mkdir(parents=True, exist_ok=True)
        root.write_text(json.dumps({
            "dataDir": "plur1bus",
            "agentId": "default",
            "agentAliases": None,
            "embedding": embedding,
            "reranker": {"provider": "disabled"},
        }), encoding="utf-8")
        for profile, internal in (("bernd", "main"), ("heisenberg", "heisenberg")):
            profile_config = home / "profiles" / profile / "plugins" / "plur1bus" / "config.json"
            profile_config.parent.mkdir(parents=True, exist_ok=True)
            profile_config.write_text(json.dumps({
                "dataDir": "plur1bus",
                "agentId": internal,
                "agentAliases": {profile: internal},
                "embedding": embedding,
                "reranker": {"provider": "disabled"},
            }), encoding="utf-8")
        return home

    def test_multiplex_profile_config_supplies_agent_alias(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = self._write_multiplex_home(directory)
            provider = Plur1busMemoryProvider()
            provider.initialize("session", hermes_home=home, agent_identity="bernd")
            self.assertEqual(provider._runtime.agent_id, "main")
            provider.shutdown()

    def test_reinitialize_does_not_leak_previous_profile_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = self._write_multiplex_home(directory)
            provider = Plur1busMemoryProvider()
            provider.initialize("first", hermes_home=home, agent_identity="bernd")
            self.assertEqual(provider._runtime.agent_id, "main")
            provider.initialize("second", hermes_home=home, agent_identity="heisenberg")
            self.assertEqual(provider._runtime.agent_id, "heisenberg")
            provider.shutdown()

    def test_unsafe_profile_name_never_reaches_the_config_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = self._write_multiplex_home(directory)
            provider = Plur1busMemoryProvider()
            provider._hermes_home = home
            # An unsafe profile name must fall back to the root merge, not join a path.
            self.assertEqual(provider._runtime_config("../bernd"), provider._runtime_config())
            self.assertEqual(provider._runtime_config("../bernd").get("agentId"), "default")
            with self.assertRaises(ValidationError):
                provider.initialize("session", hermes_home=home, agent_identity="../bernd")

    def test_memory_recall_tool_returns_runtime_result_immediately(self) -> None:
        provider = Plur1busMemoryProvider()
        provider._runtime = type("Runtime", (), {"recall": lambda self, query: f"found:{query}"})()
        result = json.loads(provider.handle_tool_call("memory_recall", {"query": "needle"}))
        self.assertEqual(result["context"], "found:needle")

    def test_current_query_recall_is_not_blocked_or_contaminated_by_previous_prefetch(self) -> None:
        release_a = threading.Event()
        started_a = threading.Event()

        def recall(*, query: str, session_id: str) -> str:
            self.assertEqual(session_id, "session")
            if query == "A":
                started_a.set()
                release_a.wait(timeout=2)
                return "context-A"
            self.assertEqual(query, "B")
            return "context-B"

        provider = Plur1busMemoryProvider()
        previous = PLUR1BUS_SERVICE.get("recall")
        PLUR1BUS_SERVICE.set("recall", recall)
        try:
            with patch("plur1bus_hermes.provider._CURRENT_RECALL_WAIT_SECONDS", 0.05):
                self.assertEqual(provider.prefetch("A", session_id="session"), "")
                self.assertTrue(started_a.is_set())
                provider.queue_prefetch("A", session_id="session")

                context_b = provider.prefetch("B", session_id="session")

                self.assertEqual(context_b, "<memory-context>\ncontext-B\n</memory-context>")
                self.assertNotIn("context-A", context_b)
        finally:
            release_a.set()
            provider.shutdown()
            PLUR1BUS_SERVICE.set("recall", previous)

    def test_current_query_timeout_and_failure_are_fail_open(self) -> None:
        release_slow = threading.Event()

        def recall(*, query: str, session_id: str) -> str:
            del session_id
            if query == "slow":
                release_slow.wait(timeout=2)
                return "context-slow"
            raise RuntimeError("recall unavailable")

        provider = Plur1busMemoryProvider()
        previous = PLUR1BUS_SERVICE.get("recall")
        PLUR1BUS_SERVICE.set("recall", recall)
        try:
            with patch("plur1bus_hermes.provider._CURRENT_RECALL_WAIT_SECONDS", 0.05):
                started = time.monotonic()
                self.assertEqual(provider.prefetch("slow", session_id="session"), "")
                self.assertLess(time.monotonic() - started, 0.5)

                release_slow.set()
                self.assertEqual(
                    provider.prefetch("slow", session_id="session"),
                    "<memory-context>\ncontext-slow\n</memory-context>",
                )
                self.assertEqual(provider.prefetch("fails", session_id="session"), "")
        finally:
            release_slow.set()
            provider.shutdown()
            PLUR1BUS_SERVICE.set("recall", previous)

    def test_current_query_wait_is_configurable_but_never_reaches_hermes_timeout(self) -> None:
        provider = Plur1busMemoryProvider({"currentRecallWaitSeconds": 0.25})
        self.assertEqual(provider._current_recall_wait_seconds(), 0.25)
        provider.config["currentRecallWaitSeconds"] = 99
        self.assertEqual(provider._current_recall_wait_seconds(), 7.0)

    def test_chat_only_provider_ignores_stale_plugin_retrieval_routes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config_path = home / "profiles" / "bernd" / "plugins" / "plur1bus" / "config.json"
            config_path.parent.mkdir(parents=True)
            config_path.write_text(json.dumps({
                "embedding": {
                    "provider": "omlx",
                    "baseUrl": "http://127.0.0.1:18085/v1",
                    "model": "stale-embed",
                    "dimensions": 1024,
                },
                "reranker": {
                    "provider": "omlx",
                    "baseUrl": "http://127.0.0.1:18085/v1",
                    "model": "stale-rerank",
                },
            }), encoding="utf-8")
            self._write_hermes_yaml(home, """
model:
  provider: rapidmlx
  default: chat-only-model
  base_url: http://127.0.0.1:18089/v1
providers:
  rapidmlx:
    base_url: http://127.0.0.1:18089/v1
    model: chat-only-model
""")

            config = self._provider_for(home)._runtime_config("bernd")

            self.assertEqual(config["embedding"], {
                "provider": "local-transformers",
                "model": "intfloat/multilingual-e5-base",
                "dimensions": 768,
            })
            self.assertEqual(config["reranker"], {
                "provider": "local-transformers",
                "model": "BAAI/bge-reranker-v2-m3",
            })

    def test_populated_store_preserves_legacy_routes_until_compatible_central_declaration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            plugin_path = home / "profiles" / "bernd" / "plugins" / "plur1bus" / "config.json"
            plugin_path.parent.mkdir(parents=True)
            plugin_path.write_text(json.dumps({
                "dataDir": "plur1bus",
                "embedding": {
                    "provider": "omlx",
                    "baseUrl": "http://127.0.0.1:18087/v1",
                    "model": "legacy-jina-embed",
                    "dimensions": 1024,
                },
                "reranker": {
                    "provider": "omlx",
                    "baseUrl": "http://127.0.0.1:18087/v1",
                    "model": "legacy-jina-rerank",
                },
            }), encoding="utf-8")
            populated = home / "plur1bus" / "lancedb-8b" / "main.lance"
            populated.mkdir(parents=True)
            (populated / "data").write_text("existing", encoding="utf-8")
            provider = self._provider_for(home)

            self._write_hermes_yaml(home, """
model:
  provider: chat-only
providers:
  chat-only:
    base_url: http://127.0.0.1:18089/v1
""")
            legacy = provider._runtime_config("bernd")
            self.assertEqual(legacy["embedding"]["model"], "legacy-jina-embed")
            self.assertEqual(legacy["embedding"]["dimensions"], 1024)
            self.assertEqual(legacy["reranker"]["model"], "legacy-jina-rerank")

            self._write_hermes_yaml(home, """
retrieval:
  embeddings:
    base_url: http://127.0.0.1:18086/v1
    model: incompatible-embed
    dimensions: 768
  rerank:
    base_url: http://127.0.0.1:18086/v1
    model: incompatible-rerank
""")
            incompatible = provider._runtime_config("bernd")
            self.assertEqual(incompatible["embedding"]["model"], "legacy-jina-embed")
            self.assertEqual(incompatible["reranker"]["model"], "legacy-jina-rerank")

            self._write_hermes_yaml(home, """
retrieval:
  embeddings:
    base_url: http://127.0.0.1:18086/v1
    model: same-width-different-model
    dimensions: 1024
  rerank:
    base_url: http://127.0.0.1:18086/v1
    model: same-width-different-rerank
""")
            same_width_different_model = provider._runtime_config("bernd")
            self.assertEqual(same_width_different_model["embedding"]["model"], "legacy-jina-embed")
            self.assertEqual(same_width_different_model["reranker"]["model"], "legacy-jina-rerank")

            self._write_hermes_yaml(home, """
retrieval:
  embeddings:
    base_url: http://127.0.0.1:18086/v1
    model: legacy-jina-embed
    dimensions: 1024
  rerank:
    base_url: http://127.0.0.1:18086/v1
    model: compatible-rerank
""")
            compatible = provider._runtime_config("bernd")
            self.assertEqual(compatible["embedding"]["model"], "legacy-jina-embed")
            self.assertEqual(compatible["embedding"]["dimensions"], 1024)
            self.assertEqual(compatible["reranker"]["model"], "compatible-rerank")

    def test_declared_provider_capabilities_use_own_routes_not_chat_route(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self._write_hermes_yaml(home, """
model:
  provider: jina-router
  default: chat-model
  base_url: http://127.0.0.1:18089/v1
providers:
  jina-router:
    base_url: http://127.0.0.1:18089/v1
    model: chat-model
    retrieval:
      embeddings:
        base_url: http://127.0.0.1:18087/v1
        model: jina-embeddings-v5-text-small
        dimensions: 1024
        api_key: sidecar-local
      rerank:
        base_url: http://127.0.0.1:18087/v1
        model: jina-reranker-v3.5
        api_key: sidecar-local
""")

            config = self._provider_for(home)._runtime_config()

            self.assertEqual(config["embedding"], {
                "provider": "omlx",
                "baseUrl": "http://127.0.0.1:18087/v1",
                "model": "jina-embeddings-v5-text-small",
                "dimensions": 1024,
                "apiKey": "sidecar-local",
            })
            self.assertEqual(config["reranker"], {
                "provider": "omlx",
                "baseUrl": "http://127.0.0.1:18087/v1",
                "model": "jina-reranker-v3.5",
                "apiKey": "sidecar-local",
                "fallbackProvider": "local-transformers",
                "fallbackModel": "BAAI/bge-reranker-v2-m3",
            })

    def test_incomplete_capability_never_inherits_chat_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self._write_hermes_yaml(home, """
model:
  provider: rapidmlx
  default: chat-only-model
  base_url: http://127.0.0.1:18089/v1
providers:
  rapidmlx:
    base_url: http://127.0.0.1:18089/v1
    model: chat-only-model
    retrieval:
      embeddings:
        enabled: true
""")

            config = self._provider_for(home)._runtime_config()

            self.assertEqual(config["embedding"]["provider"], "local-transformers")
            self.assertNotIn("baseUrl", config["embedding"])

    def test_active_profile_provider_capability_overrides_root_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self._write_hermes_yaml(home, """
model:
  provider: root-chat
providers:
  root-chat:
    retrieval:
      embeddings:
        base_url: http://127.0.0.1:18085/v1
        model: root-embedding
        dimensions: 768
""")
            self._write_hermes_yaml(home, """
model:
  provider: profile-jina
providers:
  profile-jina:
    retrieval:
      embeddings:
        base_url: http://127.0.0.1:18087/v1
        model: profile-embedding
        dimensions: 768
      rerank:
        base_url: http://127.0.0.1:18087/v1
        model: profile-reranker
""", profile="bernd")

            config = self._provider_for(home)._runtime_config("bernd")

            self.assertEqual(config["embedding"]["baseUrl"], "http://127.0.0.1:18087/v1")
            self.assertEqual(config["embedding"]["model"], "profile-embedding")
            self.assertEqual(config["reranker"]["model"], "profile-reranker")

    def test_central_retrieval_declaration_wins_over_active_chat_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self._write_hermes_yaml(home, """
model:
  provider: chat-only
providers:
  chat-only:
    base_url: http://127.0.0.1:18089/v1
retrieval:
  embeddings:
    base_url: http://127.0.0.1:18087/v1
    model: jina-embeddings-v5-text-small
    dimensions: 1024
  rerank:
    base_url: http://127.0.0.1:18087/v1
    model: jina-reranker-v3.5
""")

            config = self._provider_for(home)._runtime_config()

            self.assertEqual(config["embedding"]["baseUrl"], "http://127.0.0.1:18087/v1")
            self.assertEqual(config["embedding"]["model"], "jina-embeddings-v5-text-small")
            self.assertEqual(config["reranker"]["model"], "jina-reranker-v3.5")

    def test_explicit_plur1bus_override_keeps_legacy_routes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config_path = home / "plugins" / "plur1bus" / "config.json"
            config_path.parent.mkdir(parents=True)
            config_path.write_text(json.dumps({
                "retrieval": {"mode": "plur1bus"},
                "embedding": {"provider": "omlx", "baseUrl": "http://127.0.0.1:18085/v1", "model": "legacy", "dimensions": 768},
                "reranker": {"provider": "disabled"},
            }), encoding="utf-8")
            self._write_hermes_yaml(home, """
model:
  provider: rapidmlx
  default: chat-only-model
providers:
  rapidmlx:
    base_url: http://127.0.0.1:18089/v1
""")

            config = self._provider_for(home)._runtime_config()

            self.assertEqual(config["embedding"]["baseUrl"], "http://127.0.0.1:18085/v1")
            self.assertEqual(config["reranker"]["provider"], "disabled")

    def test_setup_schema_does_not_prompt_for_models_or_ports(self) -> None:
        self.assertEqual(Plur1busMemoryProvider().get_config_schema(), [])


if __name__ == "__main__":
    unittest.main()
