import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.namespaces import (
    canonical_scope_binding,
    canonical_scope_key,
    legacy_agent_private_scope_key,
    resolve_namespace_routes,
    scope_where_clause,
)


class NamespaceTests(unittest.TestCase):
    def test_canonical_binding_is_stable_distinct_and_owner_bound(self):
        workspace = canonical_scope_binding(
            "agent-a", scopeType="workspace", workspaceIdentity="workspace-a"
        )
        same_workspace = canonical_scope_binding(
            "agent-a", scopeType="workspace", workspaceIdentity="workspace-a"
        )
        other_workspace = canonical_scope_binding(
            "agent-a", scopeType="workspace", workspaceIdentity="workspace-b"
        )
        user = canonical_scope_binding(
            "agent-a", scopeType="user", platform="telegram", userId="owner"
        )
        chat = canonical_scope_binding(
            "agent-a", scopeType="chat", platform="telegram", chatId="chat-a"
        )

        self.assertEqual(workspace.scope_key, same_workspace.scope_key)
        self.assertEqual(workspace.owner_key, same_workspace.owner_key)
        self.assertNotEqual(workspace.scope_key, other_workspace.scope_key)
        self.assertNotEqual(user.scope_key, chat.scope_key)
        self.assertNotEqual(user.owner_key, chat.owner_key)
        self.assertEqual(
            chat.scope_key,
            canonical_scope_key(
                "agent-a",
                scopeType="chat",
                platform="telegram",
                chatId="chat-a",
                userId="different-user",
                account="different-account",
            ),
        )
        self.assertNotEqual(
            canonical_scope_key("agent-a", scopeType="agent-private"),
            workspace.scope_key,
        )
        self.assertEqual(
            user.scope_key,
            canonical_scope_key(
                "agent-a", scopeType="user", platform="telegram", userId="owner"
            ),
        )

    def test_required_scope_identity_fails_closed(self):
        with self.assertRaises(ValueError):
            canonical_scope_binding("agent-a", scopeType="workspace")
        with self.assertRaises(ValueError):
            canonical_scope_binding("agent-a", scopeType="user", platform="telegram")
        with self.assertRaises(ValueError):
            canonical_scope_binding("agent-a", scopeType="user", userId="owner")
        with self.assertRaises(ValueError):
            canonical_scope_binding("agent-a", scopeType="chat", platform="telegram")
        with self.assertRaises(ValueError):
            canonical_scope_binding("agent-a", scopeType="chat", chatId="chat-a")

    def test_agent_private_reads_include_the_legacy_key_without_using_default_for_other_scopes(self):
        binding = canonical_scope_binding("agent-a", scopeType="agent-private")
        clause = scope_where_clause(binding)

        self.assertIn(binding.scope_key, clause)
        self.assertIn(legacy_agent_private_scope_key(), clause)
        workspace_clause = scope_where_clause(
            canonical_scope_binding(
                "agent-a", scopeType="workspace", workspaceIdentity="workspace-a"
            )
        )
        self.assertNotIn(legacy_agent_private_scope_key(), workspace_clause)

    def test_resolves_one_writer_and_read_only_legacy_routes(self):
        with tempfile.TemporaryDirectory() as temporary:
            writer, recall = resolve_namespace_routes(
                Path(temporary),
                "main",
                {
                    "namespaces": {
                        "activeWriteNamespace": "local",
                        "activeRecallNamespaces": ["local"],
                        "legacyReadOnlyNamespaces": ["legacy"],
                        "crossNamespaceRecall": True,
                    }
                },
            )

            self.assertTrue(writer.writable)
            self.assertEqual([route.name for route in recall], ["local", "legacy"])
            self.assertFalse(recall[1].writable)
            self.assertTrue(str(recall[1].path).endswith("legacy/main"))

    def test_rejects_writer_outside_active_recall(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                resolve_namespace_routes(
                    Path(temporary),
                    "main",
                    {
                        "namespaces": {
                            "activeWriteNamespace": "writer",
                            "activeRecallNamespaces": ["other"],
                            "legacyReadOnlyNamespaces": [],
                        }
                    },
                )


if __name__ == "__main__":
    unittest.main()
