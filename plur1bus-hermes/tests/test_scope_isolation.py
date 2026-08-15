from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.namespaces import canonical_scope_key
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.shared_pools import SharedPrincipal


class ScopeIsolationTests(unittest.TestCase):
    def test_scope_keys_are_stable_and_distinct_for_workspace_user_and_chat(self):
        workspace = {"scopeType": "workspace", "workspace": "workspace-a"}
        self.assertEqual(
            canonical_scope_key("agent", **workspace),
            canonical_scope_key("agent", **workspace),
        )
        self.assertNotEqual(
            canonical_scope_key("agent", **workspace),
            canonical_scope_key("agent", scopeType="workspace", workspace="workspace-b"),
        )

        user = {"scopeType": "user", "platform": "telegram", "user": "owner"}
        self.assertNotEqual(
            canonical_scope_key("agent", **user),
            canonical_scope_key("agent", scopeType="user", platform="signal", user="owner"),
        )
        self.assertNotEqual(
            canonical_scope_key("agent", **user),
            canonical_scope_key("agent", scopeType="user", platform="telegram", user="other"),
        )

        chat = {"scopeType": "chat", "platform": "telegram", "user": "owner", "chat": "chat-a"}
        self.assertNotEqual(
            canonical_scope_key("agent", **chat),
            canonical_scope_key("agent", scopeType="chat", platform="telegram", user="owner", chat="chat-b"),
        )

    def test_runtime_uses_the_canonical_shared_principal_for_provider_recall(self):
        with tempfile.TemporaryDirectory() as temporary:
            owner = Plur1busRuntime(
                Path(temporary),
                {"embedding": {"provider": "omlx", "dimensions": 4}},
                "agent",
                {
                    "scopeType": "user",
                    "workspace": "workspace-a",
                    "platform": "telegram",
                    "user": "owner",
                    "account": "account-a",
                },
            )
            foreign = Plur1busRuntime(
                Path(temporary),
                {"embedding": {"provider": "omlx", "dimensions": 4}},
                "agent",
                {
                    "scopeType": "user",
                    "workspace": "workspace-a",
                    "platform": "signal",
                    "user": "owner",
                    "account": "account-a",
                },
            )
            try:
                expected = SharedPrincipal(
                    workspace="workspace-a",
                    platform="telegram",
                    user="owner",
                    account="account-a",
                ).user_key
                self.assertEqual(owner._shared_pools.principal.user_key, expected)
                owner._shared_pools.copy(
                    {
                        "id": "53628ada-8595-43dc-92da-216fe2c69836",
                        "status": "active",
                        "content": "owner-only shared memory",
                        "vector": [1.0, 0.0],
                    },
                    source_agent="agent",
                    user_scope=True,
                )
                self.assertEqual(
                    [row["content"] for row in owner._shared_pools.recall_rows([1.0, 0.0], 1)],
                    ["owner-only shared memory"],
                )
                self.assertEqual(foreign._shared_pools.recall_rows([1.0, 0.0], 1), [])
            finally:
                foreign.shutdown()
                owner.shutdown()

    def test_workspace_and_user_scopes_fail_closed_without_required_identity(self):
        with self.assertRaises(ValueError):
            canonical_scope_key("agent", scopeType="workspace")
        with self.assertRaises(ValueError):
            canonical_scope_key("agent", scopeType="user", platform="telegram")
        with self.assertRaises(ValueError):
            Plur1busRuntime(
                Path("/tmp/plur1bus-scope-test"),
                {"scopeType": "workspace", "embedding": {"provider": "omlx", "dimensions": 4}},
                "agent",
                {"scopeType": "workspace"},
            )

if __name__ == "__main__":
    unittest.main()
