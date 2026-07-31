"""Regression coverage for Hermes runtime identity, scope, backup, and recall."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.runtime import Plur1busRuntime


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

    def test_memory_recall_tool_returns_runtime_result_immediately(self) -> None:
        provider = Plur1busMemoryProvider()
        provider._runtime = type("Runtime", (), {"recall": lambda self, query: f"found:{query}"})()
        result = json.loads(provider.handle_tool_call("memory_recall", {"query": "needle"}))
        self.assertEqual(result["context"], "found:needle")


if __name__ == "__main__":
    unittest.main()
