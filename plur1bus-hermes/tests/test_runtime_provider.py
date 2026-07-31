"""Regression coverage for Hermes runtime identity, scope, backup, and recall."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.validation import ValidationError


class RuntimeProviderTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
