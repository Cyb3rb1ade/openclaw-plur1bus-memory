import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.shared_pools import SharedPoolStore, SharedPrincipal


class SharedPoolTests(unittest.TestCase):
    def test_workspace_and_user_copies_are_physically_isolated_and_recallable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = SharedPoolStore(
                root,
                SharedPrincipal(
                    workspace="bernd-workspace",
                    platform="telegram",
                    account="default",
                    user="owner",
                ),
            )
            record = {
                "id": "53628ada-8595-43dc-92da-216fe2c69836",
                "agentId": "main",
                "scopeKey": "scope",
                "status": "active",
                "content": "Bernd remembers the migration",
                "type": "observation",
                "sourceRole": "user",
                "createdAt": "2026-07-26T00:00:00+00:00",
                "vector": [1.0, 0.0],
            }

            workspace = store.copy(record, source_agent="main")
            user = store.copy(record, source_agent="main", user_scope=True)
            recalled = store.recall_rows([1.0, 0.0], 10)

            self.assertNotEqual(workspace["path"], user["path"])
            self.assertEqual(workspace["originId"], record["id"])
            self.assertEqual(len(recalled), 2)
            self.assertEqual(
                {row["_namespace"] for row in recalled},
                {"workspace-shared", "user-shared"},
            )

    def test_user_pool_filters_foreign_rows_before_the_hard_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            owner = SharedPoolStore(
                root,
                SharedPrincipal(workspace="ws", platform="telegram", user="owner"),
            )
            other = SharedPoolStore(
                root,
                SharedPrincipal(workspace="ws", platform="signal", user="other"),
            )
            owner.copy(
                {"id": "53628ada-8595-43dc-92da-216fe2c69836", "status": "active", "content": "owner", "vector": [1.0, 0.0]},
                source_agent="main",
                user_scope=True,
            )
            other.copy(
                {"id": "53628ada-8595-43dc-92da-216fe2c69837", "status": "active", "content": "other", "vector": [1.0, 0.0]},
                source_agent="main",
                user_scope=True,
            )

            recalled = owner.recall_rows([1.0, 0.0], 1)

            self.assertEqual([row["content"] for row in recalled], ["owner"])

    def test_temporal_and_expiry_predicates_apply_before_shared_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = SharedPoolStore(Path(temporary), SharedPrincipal(workspace="ws"))
            base = {
                "agentId": "main", "scopeKey": "scope", "status": "active",
                "type": "observation", "sourceRole": "user", "vector": [1.0, 0.0],
            }
            store.copy({**base, "id": "a", "content": "expired", "expiresAt": 1}, source_agent="main")
            store.copy({**base, "id": "b", "content": "future", "validFrom": 200}, source_agent="main")
            store.copy({**base, "id": "c", "content": "valid", "validFrom": 100, "validUntil": 200}, source_agent="main")
            recalled = store.recall_rows([1.0, 0.0], 1, valid_at=150, now_ms=10_000)
        self.assertEqual([row["content"] for row in recalled], ["valid"])


if __name__ == "__main__":
    unittest.main()
