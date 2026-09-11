"""Regression coverage for epistemically invalidated recall exclusions."""

from __future__ import annotations

import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from plur1bus_hermes.epistemic import epistemic_recall_where_clause, is_recallable_epistemic
from plur1bus_hermes.runtime import Plur1busRuntime


class _Query:
    def __init__(self, table: "_Table") -> None:
        self.table = table

    def where(self, clause: str) -> "_Query":
        self.table.where_calls.append(clause)
        if self.table.errors:
            raise self.table.errors.pop(0)
        return self

    def limit(self, _limit: int) -> "_Query":
        return self

    def to_list(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.table.rows]


class _Table:
    def __init__(self, rows: list[dict[str, Any]], *, schema_names: tuple[str, ...] = (),
                 errors: list[Exception] | None = None) -> None:
        self.rows = rows
        self.schema = SimpleNamespace(names=schema_names)
        self.errors = list(errors or [])
        self.where_calls: list[str] = []

    def search(self, _vector: list[float]) -> _Query:
        return _Query(self)


class EpistemicRuntimeRecallTests(unittest.TestCase):
    def test_sql_normalization_matches_every_python_whitespace_character(self) -> None:
        import lancedb

        whitespace = [chr(codepoint) for codepoint in range(0x110000) if chr(codepoint).isspace()]
        rows = [
            {"id": str(uuid.uuid4()), "epistemicStatus": f"{character}invalidated{character}"}
            for character in whitespace
        ]
        rows.extend((
            {"id": str(uuid.uuid4()), "epistemicStatus": None},
            {"id": str(uuid.uuid4()), "epistemicStatus": ""},
            {"id": str(uuid.uuid4()), "epistemicStatus": "observed"},
        ))
        with tempfile.TemporaryDirectory() as directory:
            table = lancedb.connect(directory).create_table("statuses", data=rows)
            recalled = table.search().where(epistemic_recall_where_clause()).limit(len(rows)).to_list()
        self.assertEqual(
            sorted(row["epistemicStatus"] for row in recalled if row["epistemicStatus"] is not None),
            ["", "observed"],
        )

    def _runtime(self, directory: str) -> Plur1busRuntime:
        runtime = Plur1busRuntime(Path(directory), {}, "main")
        runtime._embedding.embed = lambda _text, purpose="query": [0.1, 0.2]  # type: ignore[method-assign]
        runtime._reranker.rerank = lambda _query, rows: rows  # type: ignore[method-assign]
        runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: []  # type: ignore[method-assign]
        runtime._domain.recall_overlay = lambda *_args, **_kwargs: ""  # type: ignore[method-assign]
        runtime._domain.cognitive_prompt_blocks = lambda **_kwargs: []  # type: ignore[method-assign]
        return runtime

    def test_literal_helper_preserves_legacy_and_rejects_normalized_invalidated(self) -> None:
        for row in ({}, {"epistemicStatus": None}, {"epistemicStatus": ""},
                    {"epistemicStatus": "observed"}):
            self.assertTrue(is_recallable_epistemic(row))
        self.assertFalse(is_recallable_epistemic({"epistemicStatus": "invalidated"}))
        self.assertFalse(is_recallable_epistemic({"epistemicStatus": " INVALIDATED "}))
        self.assertTrue(is_recallable_epistemic({"epistemicStatus": object()}))

    def test_real_lancedb_invalidated_rows_cannot_starve_an_observed_hit(self) -> None:
        """Real nullable and legacy schemas retain eligible rows before the limit."""
        import lancedb
        import pyarrow as pa

        with tempfile.TemporaryDirectory() as directory:
            runtime = Plur1busRuntime(Path(directory), {"embedding": {"dimensions": 2}}, "main")
            runtime._embedding.embed = lambda _text, purpose="passage": [1.0, 0.0]  # type: ignore[method-assign]
            runtime._domain.on_memory = lambda _record, _table, **_kwargs: None  # type: ignore[method-assign]
            runtime._reranker.rerank = lambda _query, rows: rows  # type: ignore[method-assign]
            runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: []  # type: ignore[method-assign]
            runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows  # type: ignore[method-assign]
            runtime._domain.recall_overlay = lambda *_args, **_kwargs: ""  # type: ignore[method-assign]
            runtime._domain.cognitive_prompt_blocks = lambda **_kwargs: []  # type: ignore[method-assign]
            try:
                runtime._remember("observed eligible memory", "session", "user")
                table, _ = runtime._table(create=False)
                observed = dict(table.search().limit(1).to_list()[0])
                observed.pop("_distance", None)
                nullable_schema = pa.schema([
                    pa.field(field.name, field.type, nullable=True)
                    if field.name == "epistemicStatus" else field
                    for field in table.schema
                ])
                nullable_rows = [
                    {**observed, "id": str(uuid.uuid4()), "content": "observed eligible memory", "vector": [1.0, 0.0]},
                    {**observed, "id": str(uuid.uuid4()), "content": "null legacy memory", "epistemicStatus": None,
                     "vector": [1.0, 0.0]},
                    {**observed, "id": str(uuid.uuid4()), "content": "blank legacy memory", "epistemicStatus": "",
                     "vector": [1.0, 0.0]},
                ]
                invalidated = []
                wrapped_statuses = (
                    "\tINVALIDATED\n",
                    "\ninvalidated\t",
                    "\u00a0InVaLiDaTeD\u00a0",
                    "\u2003invalidated\u2003",
                )
                for number in range(20):
                    invalidated.append({
                        **observed,
                        "id": str(uuid.uuid4()),
                        "content": f"invalidated nearest memory {number}",
                        "epistemicStatus": wrapped_statuses[number % len(wrapped_statuses)],
                        "vector": [0.0, 0.0],
                    })
                nullable_rows.extend(invalidated)
                nullable = lancedb.connect(str(Path(directory) / "nullable")).create_table(
                    "memories", data=pa.Table.from_pylist(nullable_rows, schema=nullable_schema),
                )
                legacy_schema = pa.schema([field for field in nullable_schema if field.name != "epistemicStatus"])
                legacy = lancedb.connect(str(Path(directory) / "legacy")).create_table(
                    "memories",
                    data=pa.Table.from_pylist([{
                        key: value for key, value in observed.items() if key != "epistemicStatus"
                    } | {"id": str(uuid.uuid4()), "content": "absent column legacy memory", "vector": [1.0, 0.0]}],
                    schema=legacy_schema),
                )
                runtime._recall_tables = lambda: [("nullable", nullable), ("legacy", legacy)]  # type: ignore[method-assign]
                runtime._embedding.embed = lambda _text, purpose="query": [0.0, 0.0]  # type: ignore[method-assign]
                recalled = runtime.recall("memory", limit=4)
            finally:
                runtime.shutdown()

        self.assertIn("observed eligible memory", recalled)
        self.assertIn("null legacy memory", recalled)
        self.assertIn("blank legacy memory", recalled)
        self.assertIn("absent column legacy memory", recalled)
        self.assertNotIn("invalidated nearest memory", recalled)

    def test_refined_search_keeps_epistemic_predicate_and_final_gate(self) -> None:
        table = _Table([
            {"id": "observed", "content": "observed weak", "status": "active", "expiresAt": 0,
             "epistemicStatus": "observed", "_distance": 0.9},
            {"id": "invalidated", "content": "invalidated refined", "status": "active", "expiresAt": 0,
             "epistemicStatus": " INVALIDATED ", "_distance": 0.1},
        ], schema_names=("epistemicStatus",))
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("main", table)]  # type: ignore[method-assign]
            runtime._refine_query = lambda *_args: "refined query"  # type: ignore[method-assign]
            runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows  # type: ignore[method-assign]
            try:
                recalled = runtime.recall("original query")
            finally:
                runtime.shutdown()
        self.assertIn("observed weak", recalled)
        self.assertNotIn("invalidated refined", recalled)
        self.assertEqual(len(table.where_calls), 2)
        self.assertTrue(all("regexp_replace" in clause
                            for clause in table.where_calls))

    def test_booster_rows_are_epistemically_rechecked_after_aggregation(self) -> None:
        table = _Table([
            {"id": "observed", "content": "observed primary", "status": "active", "expiresAt": 0,
             "epistemicStatus": "observed"},
        ], schema_names=("epistemicStatus",))
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("main", table)]  # type: ignore[method-assign]
            runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows + [{  # type: ignore[method-assign]
                "id": "booster-invalidated", "content": "invalidated booster", "expiresAt": 0,
                "epistemicStatus": "invalidated",
            }]
            try:
                recalled = runtime.recall("query")
            finally:
                runtime.shutdown()
        self.assertIn("observed primary", recalled)
        self.assertNotIn("invalidated booster", recalled)

    def test_legacy_schema_omits_only_epistemic_predicate_and_final_gate_handles_rows(self) -> None:
        table = _Table([
            {"id": "absent", "content": "legacy absent", "status": "active", "expiresAt": 0},
            {"id": "blank", "content": "legacy blank", "status": "active", "expiresAt": 0,
             "epistemicStatus": ""},
            {"id": "invalidated", "content": "legacy invalidated", "status": "active", "expiresAt": 0,
             "epistemicStatus": "invalidated"},
        ])
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("legacy", table)]  # type: ignore[method-assign]
            runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows  # type: ignore[method-assign]
            try:
                recalled = runtime.recall("query")
            finally:
                runtime.shutdown()
        self.assertIn("legacy absent", recalled)
        self.assertIn("legacy blank", recalled)
        self.assertNotIn("legacy invalidated", recalled)
        self.assertNotIn("epistemicStatus", table.where_calls[0])
        self.assertIn("status = 'active'", table.where_calls[0])
        self.assertIn("expiresAt", table.where_calls[0])

    def test_epistemic_schema_race_retries_once_without_only_that_predicate(self) -> None:
        table = _Table(
            [{"id": "legacy", "content": "race legacy", "status": "active", "expiresAt": 0}],
            schema_names=("epistemicStatus",),
            errors=[RuntimeError("column epistemicStatus does not exist")],
        )
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("race", table)]  # type: ignore[method-assign]
            runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows  # type: ignore[method-assign]
            try:
                recalled = runtime.recall("query", valid_at="2026-01-01T00:00:00Z")
            finally:
                runtime.shutdown()
        self.assertIn("race legacy", recalled)
        self.assertEqual(len(table.where_calls), 2)
        self.assertIn("epistemicStatus", table.where_calls[0])
        self.assertNotIn("epistemicStatus", table.where_calls[1])
        self.assertIn("expiresAt", table.where_calls[1])
        self.assertIn("validFrom <=", table.where_calls[1])

    def test_epistemic_race_and_later_lifecycle_races_preserve_the_retry_ladder(self) -> None:
        for first, second, surviving_clause in (
            ("epistemicStatus", "validFrom", "expiresAt"),
            ("validFrom", "epistemicStatus", "expiresAt"),
            ("epistemicStatus", "expiresAt", "status = 'active'"),
            ("expiresAt", "epistemicStatus", "status = 'active'"),
        ):
            with self.subTest(first=first, second=second):
                table = _Table(
                    [{"id": "legacy", "content": "race legacy", "status": "active", "expiresAt": 0}],
                    schema_names=("epistemicStatus",),
                    errors=[
                        RuntimeError(f"column {first} does not exist"),
                        RuntimeError(f"column {second} does not exist"),
                    ],
                )
                with tempfile.TemporaryDirectory() as directory:
                    runtime = self._runtime(directory)
                    runtime._recall_tables = lambda: [("race", table)]  # type: ignore[method-assign]
                    runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows  # type: ignore[method-assign]
                    try:
                        recalled = runtime.recall("query", valid_at="2026-01-01T00:00:00Z")
                    finally:
                        runtime.shutdown()
                self.assertIn("race legacy", recalled)
                self.assertEqual(len(table.where_calls), 3)
                self.assertIn("epistemicStatus", table.where_calls[0])
                self.assertNotIn("epistemicStatus", table.where_calls[-1])
                self.assertIn(surviving_clause, table.where_calls[-1])

    def test_unrelated_search_errors_propagate_without_epistemic_retry(self) -> None:
        table = _Table([], schema_names=("epistemicStatus",),
                       errors=[RuntimeError("storage transport unavailable")])
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("broken", table)]  # type: ignore[method-assign]
            try:
                with self.assertRaisesRegex(RuntimeError, "transport"):
                    runtime.recall("query")
            finally:
                runtime.shutdown()
        self.assertEqual(len(table.where_calls), 1)

    def test_multi_column_schema_errors_do_not_drop_epistemic_predicate(self) -> None:
        table = _Table([], schema_names=("epistemicStatus",),
                       errors=[RuntimeError("columns epistemicStatus and expiresAt do not exist")])
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("broken", table)]  # type: ignore[method-assign]
            try:
                with self.assertRaisesRegex(RuntimeError, "expiresAt"):
                    runtime.recall("query")
            finally:
                runtime.shutdown()
        self.assertEqual(len(table.where_calls), 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
