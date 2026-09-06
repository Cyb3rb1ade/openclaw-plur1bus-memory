"""Focused H-03 regressions for the live forget/correct mutation path."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.namespaces import binding_from_scope, normalize_scope_context
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.tombstone import read_tombstones_from_registry


MEMORY_ID = "a4563cc9-7611-4528-992a-075f8889a018"


class _Query:
    def __init__(self, table: "_Table") -> None:
        self.table = table

    def where(self, _clause: str) -> "_Query":
        return self

    def limit(self, _limit: int) -> "_Query":
        return self

    def to_list(self) -> list[dict]:
        return [dict(row) for row in self.table.next_rows()]


class _Table:
    def __init__(self, rows: list[dict] | tuple[list[dict], list[dict]]) -> None:
        self.rows = rows
        self.search_count = 0
        self.update_where: str | None = None

    def search(self, *_args, **_kwargs) -> _Query:
        self.search_count += 1
        return _Query(self)

    def next_rows(self) -> list[dict]:
        if isinstance(self.rows, tuple):
            return self.rows[min(self.search_count - 1, len(self.rows) - 1)]
        return self.rows

    def update(self, *, where: str, values: dict) -> None:
        self.update_where = where
        for row in self.next_rows():
            row.update(values)


class _Domain:
    def __init__(self) -> None:
        self.audit: list[dict] = []

    def audit_mutation(self, entry: dict) -> None:
        self.audit.append(entry)


def _runtime(root: Path, agent: str, scope: dict, table: _Table) -> Plur1busRuntime:
    runtime = object.__new__(Plur1busRuntime)
    runtime.data_dir = root
    runtime.agent_id = agent
    runtime.request_scope = normalize_scope_context(scope)
    runtime.scope_binding = binding_from_scope(agent, runtime.request_scope)
    runtime.scope_key = runtime.scope_binding.scope_key
    runtime._domain = _Domain()
    runtime._table = lambda create, first_record=None: (table, False)
    return runtime


def _card(agent: str, binding, *, owner: str = "") -> dict:
    return {
        "id": MEMORY_ID,
        "agentId": agent,
        "scopeKey": binding.scope_key,
        "scopeType": binding.scope_type,
        "ownerKey": binding.owner_key,
        "ownerUser": owner,
        "content": "same UUID, different owner-safe archive",
        "status": "active",
    }


class LiveForgetArchiveTests(unittest.TestCase):
    def test_same_uuid_two_agents_get_distinct_archives_and_complete_audits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first_binding = binding_from_scope("agent-a")
            second_binding = binding_from_scope("agent-b")
            first_table = _Table([_card("agent-a", first_binding)])
            second_table = _Table([_card("agent-b", second_binding)])
            first = _runtime(root, "agent-a", {}, first_table)
            second = _runtime(root, "agent-b", {}, second_table)

            self.assertTrue(first.forget(MEMORY_ID))
            self.assertTrue(second.forget(MEMORY_ID))

            first_audit = first._domain.audit[0]
            second_audit = second._domain.audit[0]
            self.assertNotEqual(first_audit["archivePath"], second_audit["archivePath"])
            self.assertIn("/archives/agent-a/", Path(first_audit["archivePath"]).as_posix())
            self.assertIn("/archives/agent-b/", Path(second_audit["archivePath"]).as_posix())
            self.assertEqual(first_audit["cardIdentity"]["memoryId"], MEMORY_ID)
            self.assertTrue(first_audit["contentFingerprint"])
            self.assertEqual(first_audit["ownership"]["agentId"], "agent-a")
            self.assertEqual(
                read_tombstones_from_registry(root, "agent-a")[-1]["archivePath"],
                first_audit["archivePath"],
            )

    def test_owner_change_before_final_update_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            scope = {"scopeType": "user", "platform": "telegram", "user": "owner-a"}
            binding = binding_from_scope("agent-a", scope)
            original = _card("agent-a", binding, owner="owner-a")
            changed = dict(original, ownerUser="owner-b")
            table = _Table(([original], [changed]))
            runtime = _runtime(root, "agent-a", scope, table)

            self.assertFalse(runtime.forget(MEMORY_ID))
            self.assertIsNone(table.update_where)
            self.assertEqual(table.next_rows()[0]["status"], "active")
            rows = read_tombstones_from_registry(root, "agent-a")
            self.assertEqual([row["status"] for row in rows], ["attempted", "failed"])
            self.assertFalse(runtime._domain.audit)


if __name__ == "__main__":
    unittest.main()
