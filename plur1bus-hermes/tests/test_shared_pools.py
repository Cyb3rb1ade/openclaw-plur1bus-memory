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


if __name__ == "__main__":
    unittest.main()
