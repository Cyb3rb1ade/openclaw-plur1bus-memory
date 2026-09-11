import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from plur1bus_hermes.shared_pools import SharedPoolStore, SharedPrincipal


class _PoolQuery:
    def __init__(self, table):
        self.table = table

    def where(self, clause):
        self.table.where_calls.append(clause)
        if self.table.errors:
            raise self.table.errors.pop(0)
        return self

    def limit(self, _limit):
        return self

    def to_list(self):
        return [dict(row) for row in self.table.rows]


class _PoolTable:
    def __init__(self, rows, errors):
        self.schema = SimpleNamespace(names=("epistemicStatus",))
        self.rows = rows
        self.errors = list(errors)
        self.where_calls = []

    def search(self, _vector):
        return _PoolQuery(self)


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

    def test_invalidated_rows_are_excluded_before_the_shared_pool_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = SharedPoolStore(Path(temporary), SharedPrincipal(workspace="ws"))
            base = {
                "agentId": "main", "scopeKey": "scope", "status": "active",
                "type": "observation", "sourceRole": "user",
            }
            for index, status in enumerate((
                "\tINVALIDATED\n", "\ninvalidated\t", "\u00a0InVaLiDaTeD\u00a0",
                "\u2003invalidated\u2003",
            )):
                store.copy({**base, "id": f"invalid-{index}", "content": f"invalidated-{index}",
                            "vector": [0.0, 0.0], "epistemicStatus": status}, source_agent="main")
            store.copy({**base, "id": "observed", "content": "observed", "vector": [1.0, 0.0],
                        "epistemicStatus": "observed"}, source_agent="main")
            recalled = store.recall_rows([0.0, 0.0], 1)
        self.assertEqual([row["content"] for row in recalled], ["observed"])

    def test_schema_races_keep_shared_lifecycle_retry_ladder(self):
        for first, second, surviving_clause in (
            ("epistemicStatus", "validFrom", "expiresAt"),
            ("validFrom", "epistemicStatus", "expiresAt"),
            ("epistemicStatus", "expiresAt", "status = 'active'"),
            ("expiresAt", "epistemicStatus", "status = 'active'"),
        ):
            with self.subTest(first=first, second=second):
                with tempfile.TemporaryDirectory() as temporary:
                    store = SharedPoolStore(Path(temporary), SharedPrincipal(workspace="ws"))
                    store._path(False).mkdir(parents=True)
                    table = _PoolTable(
                        [{"id": "legacy", "content": "shared race", "status": "active", "expiresAt": 0}],
                        [
                            RuntimeError(f"column {first} does not exist"),
                            RuntimeError(f"column {second} does not exist"),
                        ],
                    )
                    database = SimpleNamespace(open_table=lambda _name: table)
                    with patch.dict("sys.modules", {"lancedb": SimpleNamespace(connect=lambda _path: database)}):
                        recalled = store.recall_rows([0.1, 0.2], 1, valid_at=100, now_ms=10)
                self.assertEqual([row["content"] for row in recalled], ["shared race"])
                self.assertEqual(len(table.where_calls), 3)
                self.assertIn("epistemicStatus", table.where_calls[0])
                self.assertNotIn("epistemicStatus", table.where_calls[-1])
                self.assertIn(surviving_clause, table.where_calls[-1])


if __name__ == "__main__":
    unittest.main()
