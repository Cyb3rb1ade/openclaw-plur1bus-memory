"""Regression coverage for native validity-window and TTL runtime behavior."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.runtime_scheduler import AdmissionRejected
from plur1bus_hermes.valid_time import (
    has_disjoint_validity_windows,
    is_entry_live,
    is_entry_valid_at,
    normalize_validity_window,
)


class ValidTimeHelpersTests(unittest.TestCase):
    def test_captured_window_never_guesses_or_inverts(self) -> None:
        self.assertEqual(normalize_validity_window("last Tuesday", "tomorrow"), (0, 0))
        self.assertEqual(
            normalize_validity_window("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"),
            (0, 0),
        )

    def test_left_inclusive_right_exclusive_and_ttl_are_distinct(self) -> None:
        row = {"validFrom": 100, "validUntil": 200, "expiresAt": 0}
        self.assertTrue(is_entry_valid_at(row, 100))
        self.assertFalse(is_entry_valid_at(row, 200))
        self.assertTrue(is_entry_live(row, 10_000))
        self.assertFalse(is_entry_live({**row, "expiresAt": 10}, 10))

    def test_dedupe_can_retain_proven_disjoint_history(self) -> None:
        self.assertTrue(has_disjoint_validity_windows(
            {"validFrom": 100, "validUntil": 200},
            {"validFrom": 200, "validUntil": 300},
        ))
        self.assertFalse(has_disjoint_validity_windows(
            {"validFrom": 0, "validUntil": 200},
            {"validFrom": 0, "validUntil": 300},
        ))


class _Query:
    def __init__(self, table: "_Table") -> None:
        self.table = table

    def where(self, clause: str) -> "_Query":
        self.table.where_calls.append(clause)
        if self.table.fail_first and len(self.table.where_calls) == 1:
            raise RuntimeError("column validFrom does not exist")
        return self

    def limit(self, _limit: int) -> "_Query":
        return self

    def to_list(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.table.rows]


class _Table:
    def __init__(self, rows: list[dict[str, Any]], *, fail_first: bool = False) -> None:
        self.rows = rows
        self.fail_first = fail_first
        self.where_calls: list[str] = []

    def search(self, _vector: list[float]) -> _Query:
        return _Query(self)


class RuntimeValidTimeRecallTests(unittest.TestCase):
    def _runtime(self, directory: str) -> Plur1busRuntime:
        runtime = Plur1busRuntime(Path(directory), {}, "main")
        runtime._embedding.embed = lambda _text, purpose="query": [0.1, 0.2]  # type: ignore[method-assign]
        runtime._reranker.rerank = lambda _query, rows: rows  # type: ignore[method-assign]
        runtime._shared_pools.recall_rows = lambda _vector, _limit: []  # type: ignore[method-assign]
        runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows  # type: ignore[method-assign]
        runtime._domain.recall_overlay = lambda _query, _rows: ""  # type: ignore[method-assign]
        runtime._domain.cognitive_prompt_blocks = lambda **_kwargs: []  # type: ignore[method-assign]
        return runtime

    def test_valid_at_is_pushed_before_limit_then_ttl_and_window_postfilter(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            table = _Table([
                {"id": "a", "content": "historical", "validFrom": 100, "validUntil": 200, "expiresAt": 0},
                {"id": "b", "content": "future", "validFrom": 201, "validUntil": 0, "expiresAt": 0},
                {"id": "c", "content": "expired", "validFrom": 0, "validUntil": 0, "expiresAt": 1},
            ])
            runtime._recall_tables = lambda: [("main", table)]  # type: ignore[method-assign]
            recalled = runtime.recall("where", valid_at=150)
        self.assertIn("historical", recalled)
        self.assertNotIn("future", recalled)
        self.assertNotIn("expired", recalled)
        self.assertIn("validFrom <= 150", table.where_calls[0])
        self.assertIn("[valid:", recalled)

    def test_legacy_missing_validity_column_retries_once_without_predicate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            table = _Table([{"id": "a", "content": "legacy", "expiresAt": 0}], fail_first=True)
            runtime._recall_tables = lambda: [("main", table)]  # type: ignore[method-assign]
            self.assertIn("legacy", runtime.recall("where", valid_at=150))
        self.assertEqual(len(table.where_calls), 2)
        self.assertIn("validFrom", table.where_calls[0])
        self.assertNotIn("validFrom", table.where_calls[1])

    def test_full_text_removes_per_memory_cap_but_not_global_budget(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime.config["recall"] = {"globalInjectMaxChars": 10_000}
            body = "x" * 2500
            table = _Table([{"id": "a", "content": body, "expiresAt": 0}])
            runtime._recall_tables = lambda: [("main", table)]  # type: ignore[method-assign]
            self.assertLess(len(runtime.recall("where")), len(body) + 3)
            self.assertIn(body, runtime.recall("where", full_text=True))

    def test_expired_rows_added_by_a_booster_cannot_leak(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            table = _Table([{"id": "a", "content": "live", "expiresAt": 0}])
            runtime._recall_tables = lambda: [("main", table)]  # type: ignore[method-assign]
            runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows + [{  # type: ignore[method-assign]
                "id": "stale", "content": "booster-expired", "expiresAt": 1,
            }]
            result = runtime.recall("where")
        self.assertIn("live", result)
        self.assertNotIn("booster-expired", result)


class ValidTimeSchemaMigrationTests(unittest.TestCase):
    def test_legacy_lance_table_gets_idempotent_zero_defaults(self) -> None:
        import lancedb

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = Plur1busRuntime(root, {"embedding": {"dimensions": 2}}, "main")
            agent_dir = root / "lancedb" / "main"
            agent_dir.mkdir(parents=True)
            table = lancedb.connect(str(agent_dir)).create_table("memories", data=[{
                "id": "legacy", "agentId": "main", "content": "old", "vector": [0.1, 0.2],
            }])
            runtime._ensure_capture_columns(table)
            runtime._ensure_capture_columns(table)
            row = lancedb.connect(str(agent_dir)).open_table("memories").search().limit(1).to_list()[0]
        self.assertEqual({name: row.get(name) for name in ("validFrom", "validUntil", "expiresAt")}, {
            "validFrom": 0, "validUntil": 0, "expiresAt": 0,
        })

    def test_real_lance_legacy_schema_preserves_vectors_and_filters_boundaries(self) -> None:
        import lancedb

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = Plur1busRuntime(root, {"embedding": {"dimensions": 2}}, "main")
            agent_dir = root / "lancedb" / "main"
            agent_dir.mkdir(parents=True)
            binding = runtime.scope_binding
            table = lancedb.connect(str(agent_dir)).create_table("memories", data=[{
                "id": "legacy", "agentId": "main", "scopeKey": runtime.scope_key,
                "scopeType": binding.scope_type, "ownerKey": binding.owner_key,
                "workspaceIdentity": binding.workspace, "ownerPlatform": binding.platform,
                "ownerUser": binding.user, "chatScope": binding.chat,
                "aclBindings": binding.as_dict(), "sessionId": "legacy",
                "content": "legacy row", "status": "active", "type": "observation",
                "sourceRole": "user", "createdAt": "2025-01-01T00:00:00+00:00",
                "epistemicStatus": "observed", "vector": [0.1, 0.2],
            }])
            runtime._ensure_capture_columns(table)
            runtime._embedding.embed = lambda _text, purpose="passage": [0.1, 0.2]  # type: ignore[method-assign]
            runtime._domain.on_memory = lambda _record, _table, **_kwargs: None  # type: ignore[method-assign]
            runtime._remember(
                "dated row", "s", "user", valid_from="2026-01-01",
                valid_until="2026-02-01T00:00:00Z", expires_at="2099-01-01T00:00:00Z",
            )
            reopened = lancedb.connect(str(agent_dir)).open_table("memories")
            stored = reopened.search().limit(10).to_list()
            dated = next(row for row in stored if row["content"] == "dated row")
            self.assertEqual(len(dated["vector"]), 2)
            self.assertGreater(dated["validFrom"], 0)
            self.assertGreater(dated["validUntil"], dated["validFrom"])
            self.assertGreater(dated["expiresAt"], dated["validUntil"])
            runtime._reranker.rerank = lambda _query, rows: rows  # type: ignore[method-assign]
            runtime._shared_pools.recall_rows = lambda _vector, _limit: []  # type: ignore[method-assign]
            runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows  # type: ignore[method-assign]
            runtime._domain.recall_overlay = lambda _query, _rows: ""  # type: ignore[method-assign]
            runtime._domain.cognitive_prompt_blocks = lambda **_kwargs: []  # type: ignore[method-assign]
            runtime._recall_tables = lambda: [("main", reopened)]  # type: ignore[method-assign]
            at_start = runtime.recall("dated", valid_at="2026-01-01")
            at_end = runtime.recall("dated", valid_at="2026-02-01")
        self.assertIn("dated row", at_start)
        self.assertNotIn("dated row", at_end)


class CorrectionPersistenceTests(unittest.TestCase):
    def _runtime_with_source(self, directory: str) -> tuple[Plur1busRuntime, str]:
        runtime = Plur1busRuntime(Path(directory), {"embedding": {"dimensions": 2}}, "main")
        runtime._embedding.embed = lambda _text, purpose="passage": [0.1, 0.2]  # type: ignore[method-assign]
        runtime._domain.on_memory = lambda _record, _table, **_kwargs: None  # type: ignore[method-assign]
        source_id = runtime._remember(
            "original", "s", "user", valid_from="1960-01-01",
            valid_until="1961-01-01", expires_at="2099-01-01",
        )
        self.assertIsNotNone(source_id)
        return runtime, str(source_id)

    def test_empty_or_tombstone_blocked_replacement_keeps_source_active(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime, source_id = self._runtime_with_source(directory)
            self.assertFalse(runtime.correct_async(source_id, "   ", "s2"))
            table, _ = runtime._table(create=False)
            source = table.search().where(f"id = '{source_id}'").limit(1).to_list()[0]
            self.assertEqual(source["status"], "active")
            # A tombstone for the proposed replacement is a no-write outcome,
            # never authority to archive the unrelated source.
            blocked_id = runtime._remember("blocked replacement", "s", "user")
            self.assertIsNotNone(blocked_id)
            self.assertTrue(runtime.forget(str(blocked_id)))
            self.assertFalse(runtime.correct_async(source_id, "blocked replacement", "s2"))
            source = table.search().where(f"id = '{source_id}'").limit(1).to_list()[0]
            self.assertEqual(source["status"], "active")

    def test_queue_rejection_keeps_source_active(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime, source_id = self._runtime_with_source(directory)
            runtime._executor = type("Rejected", (), {
                "submit": lambda _self, *_args, **_kwargs: (_ for _ in ()).throw(AdmissionRejected("full")),
            })()
            self.assertFalse(runtime.correct_async(source_id, "replacement", "s2"))
            table, _ = runtime._table(create=False)
            self.assertEqual(table.search().where(f"id = '{source_id}'").limit(1).to_list()[0]["status"], "active")

    def test_verified_correction_preserves_temporal_fields_before_source_archive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime, source_id = self._runtime_with_source(directory)
            self.assertTrue(runtime.correct_async(source_id, "replacement", "s2"))
            table, _ = runtime._table(create=False)
            rows = table.search().limit(10).to_list()
            source = next(row for row in rows if row["id"] == source_id)
            replacement = next(row for row in rows if row["content"] == "replacement")
        self.assertEqual(source["status"], "deleted")
        self.assertEqual(
            (replacement["validFrom"], replacement["validUntil"], replacement["expiresAt"]),
            (source["validFrom"], source["validUntil"], source["expiresAt"]),
        )

    def test_failed_source_revalidation_archives_replacement_instead_of_leaving_duplicate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime, source_id = self._runtime_with_source(directory)
            runtime._same_correction_source = lambda _expected, _current: False  # type: ignore[method-assign]
            self.assertFalse(runtime.correct_async(source_id, "replacement", "s2"))
            table, _ = runtime._table(create=False)
            rows = table.search().limit(10).to_list()
            source = next(row for row in rows if row["id"] == source_id)
            replacement = next(row for row in rows if row["content"] == "replacement")
        self.assertEqual(source["status"], "active")
        self.assertEqual(replacement["status"], "archived")


if __name__ == "__main__":
    unittest.main()
