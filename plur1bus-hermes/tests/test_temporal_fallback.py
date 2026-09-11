"""Regression coverage for ACL-safe heuristic temporal recall fallback."""

from __future__ import annotations

import re
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import patch

from plur1bus_hermes.runtime import Plur1busRuntime


_FIXED_RANGE = {
    "start": "2026-08-01T00:00:00+00:00",
    "end": "2026-09-01T00:00:00+00:00",
    "source": "last-month",
}


class _Query:
    def __init__(self, table: "_Table") -> None:
        self.table = table
        self.clause = ""

    def where(self, clause: str) -> "_Query":
        self.table.where_calls.append(clause)
        self.clause = clause
        if self.table.error is not None:
            raise self.table.error
        return self

    def limit(self, limit: int) -> "_Query":
        self.table.limits.append(limit)
        return self

    def to_list(self) -> list[dict[str, Any]]:
        rows = self.table.rows
        lower = re.search(r"createdAt >= '([^']+)'", self.clause)
        upper = re.search(r"createdAt < '([^']+)'", self.clause)
        if lower and upper:
            rows = [
                row for row in rows
                if lower.group(1) <= str(row.get("createdAt") or "") < upper.group(1)
            ]
        return [dict(row) for row in rows]


class _Table:
    def __init__(
        self,
        rows: list[dict[str, Any]],
        *,
        error: Exception | None = None,
    ) -> None:
        self.rows = rows
        self.error = error
        self.where_calls: list[str] = []
        self.limits: list[int] = []

    def search(self, _vector: list[float]) -> _Query:
        return _Query(self)


class TemporalFallbackPolicyTests(unittest.TestCase):
    def _runtime(self, directory: str) -> Plur1busRuntime:
        runtime = Plur1busRuntime(Path(directory), {}, "main")
        runtime._embedding.embed = lambda _text, purpose="query": [0.1, 0.2]  # type: ignore[method-assign]
        runtime._reranker.rerank = lambda _query, rows: rows  # type: ignore[method-assign]
        runtime._domain.recall_overlay = lambda *_args, **_kwargs: ""  # type: ignore[method-assign]
        runtime._domain.cognitive_prompt_blocks = lambda **_kwargs: []  # type: ignore[method-assign]
        runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows  # type: ignore[method-assign]
        return runtime

    def test_shared_only_old_row_uses_aggregate_fallback(self) -> None:
        """A missing private table must not make an authorized shared fallback unreachable."""
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: []  # type: ignore[method-assign]
            shared_calls: list[dict[str, Any]] = []

            def shared(_vector, _limit, **kwargs):
                shared_calls.append(dict(kwargs))
                return [{
                    "id": "shared-old",
                    "content": "shared historical project",
                    "status": "active",
                    "createdAt": "2025-01-01T00:00:00+00:00",
                    "expiresAt": 0,
                }]

            runtime._shared_pools.recall_rows = shared  # type: ignore[method-assign]
            try:
                with patch("plur1bus_hermes.runtime.parse_temporal_range", return_value=_FIXED_RANGE):
                    recalled = runtime.recall("project last month")
            finally:
                runtime.shutdown()

        self.assertIn("shared historical project", recalled)
        self.assertEqual(len(shared_calls), 1)

    def test_multiple_namespaces_are_searched_before_one_bounded_fallback(self) -> None:
        """An empty aggregate heuristic retries each configured namespace only once."""
        first = _Table([{
            "id": "first-old", "content": "first historical project",
            "status": "active", "createdAt": "2025-01-01T00:00:00+00:00",
            "expiresAt": 0,
        }])
        second = _Table([{
            "id": "second-old", "content": "second historical project",
            "status": "active", "createdAt": "2025-02-01T00:00:00+00:00",
            "expiresAt": 0,
        }])
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("first", first), ("second", second)]  # type: ignore[method-assign]
            runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: []  # type: ignore[method-assign]
            try:
                with patch("plur1bus_hermes.runtime.parse_temporal_range", return_value=_FIXED_RANGE):
                    recalled = runtime.recall("project last month")
            finally:
                runtime.shutdown()

        self.assertIn("first historical project", recalled)
        self.assertIn("second historical project", recalled)
        for table in (first, second):
            self.assertEqual(len(table.where_calls), 2)
            self.assertIn("createdAt >=", table.where_calls[0])
            self.assertNotIn("createdAt >=", table.where_calls[1])
            self.assertIn("scopeKey", table.where_calls[1])
            self.assertIn("status = 'active'", table.where_calls[1])
            self.assertIn("expiresAt", table.where_calls[1])
            self.assertEqual(table.limits, [15, 15])

    def test_partial_success_suppresses_private_and_shared_fallback_rows(self) -> None:
        """One eligible heuristic row selects the policy for the whole recall."""
        table = _Table([
            {
                "id": "private-current", "content": "August private project",
                "status": "active", "createdAt": "2026-08-10T00:00:00+00:00",
                "expiresAt": 0,
            },
            {
                "id": "private-old", "content": "old private project",
                "status": "active", "createdAt": "2025-01-01T00:00:00+00:00",
                "expiresAt": 0,
            },
        ])
        shared_calls: list[dict[str, Any]] = []
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("private", table)]  # type: ignore[method-assign]

            def shared(_vector, _limit, **kwargs):
                shared_calls.append(dict(kwargs))
                return [{
                    "id": "shared-old", "content": "old shared project",
                    "status": "active", "createdAt": "2025-01-01T00:00:00+00:00",
                    "expiresAt": 0,
                }]

            runtime._shared_pools.recall_rows = shared  # type: ignore[method-assign]
            try:
                with patch("plur1bus_hermes.runtime.parse_temporal_range", return_value=_FIXED_RANGE):
                    recalled = runtime.recall("project last month")
            finally:
                runtime.shutdown()

        self.assertIn("August private project", recalled)
        self.assertNotIn("old private project", recalled)
        self.assertNotIn("old shared project", recalled)
        self.assertEqual(len(table.where_calls), 1)
        self.assertEqual(len(shared_calls), 1)

    def test_ineligible_shared_heuristic_row_cannot_suppress_private_fallback(self) -> None:
        """Lifecycle-invalid shared candidates do not count as aggregate success."""
        table = _Table([{
            "id": "private-old", "content": "private fallback survives",
            "status": "active", "createdAt": "2025-01-01T00:00:00+00:00",
            "expiresAt": 0, "validFrom": 0, "validUntil": 0,
        }])
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("private", table)]  # type: ignore[method-assign]
            runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: [{  # type: ignore[method-assign]
                "id": "shared-invalid", "content": "shared future leak",
                "status": "active", "createdAt": "2026-08-10T00:00:00+00:00",
                "expiresAt": 0, "validFrom": 1_788_220_800_000, "validUntil": 0,
            }]
            try:
                with patch("plur1bus_hermes.runtime.parse_temporal_range", return_value=_FIXED_RANGE):
                    recalled = runtime.recall(
                        "project last month", valid_at="2026-08-01T00:00:00Z"
                    )
            finally:
                runtime.shutdown()

        self.assertIn("private fallback survives", recalled)
        self.assertNotIn("shared future leak", recalled)
        self.assertEqual(len(table.where_calls), 2)
        self.assertIn("validFrom <=", table.where_calls[1])

    def test_shared_epistemic_validity_controls_aggregate_fallback_symmetrically(self) -> None:
        """A valid shared hit suppresses fallback; an invalidated one cannot."""
        def run(shared_status: str) -> tuple[str, _Table]:
            table = _Table([{
                "id": "private-old", "content": "private fallback", "status": "active",
                "createdAt": "2025-01-01T00:00:00+00:00", "expiresAt": 0,
            }])
            with tempfile.TemporaryDirectory() as directory:
                runtime = self._runtime(directory)
                runtime._recall_tables = lambda: [("private", table)]  # type: ignore[method-assign]
                runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: [{  # type: ignore[method-assign]
                    "id": f"shared-{shared_status}", "content": "shared in-range", "status": "active",
                    "createdAt": "2026-08-10T00:00:00+00:00", "expiresAt": 0,
                    "epistemicStatus": shared_status,
                }]
                try:
                    with patch("plur1bus_hermes.runtime.parse_temporal_range", return_value=_FIXED_RANGE):
                        recalled = runtime.recall("project last month")
                finally:
                    runtime.shutdown()
            return recalled, table

        observed, observed_table = run("observed")
        self.assertIn("shared in-range", observed)
        self.assertNotIn("private fallback", observed)
        self.assertEqual(len(observed_table.where_calls), 1)

        invalidated, invalidated_table = run("invalidated")
        self.assertNotIn("shared in-range", invalidated)
        self.assertIn("private fallback", invalidated)
        self.assertEqual(len(invalidated_table.where_calls), 2)
        self.assertNotIn("createdAt >=", invalidated_table.where_calls[1])

    def test_lifecycle_recheck_happens_before_fallback_decision(self) -> None:
        """A deleted heuristic row cannot suppress fallback to a live old row."""
        table = _Table([
            {
                "id": "deleted-current", "content": "deleted August project",
                "status": "deleted", "createdAt": "2026-08-10T00:00:00+00:00",
                "expiresAt": 0,
            },
            {
                "id": "active-old", "content": "live historical project",
                "status": "active", "createdAt": "2025-01-01T00:00:00+00:00",
                "expiresAt": 0,
            },
        ])
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("private", table)]  # type: ignore[method-assign]
            runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: []  # type: ignore[method-assign]
            try:
                with patch("plur1bus_hermes.runtime.parse_temporal_range", return_value=_FIXED_RANGE):
                    recalled = runtime.recall("project last month")
            finally:
                runtime.shutdown()

        self.assertIn("live historical project", recalled)
        self.assertNotIn("deleted August project", recalled)
        self.assertEqual(len(table.where_calls), 2)

    def test_refinement_keeps_a_successful_heuristic_policy(self) -> None:
        """Refined ANN candidates cannot introduce rows outside a selected range."""
        table = _Table([
            {
                "id": "current", "content": "current weak result",
                "status": "active", "createdAt": "2026-08-10T00:00:00+00:00",
                "expiresAt": 0, "_distance": 0.9,
            },
            {
                "id": "old", "content": "old refined leak",
                "status": "active", "createdAt": "2025-01-01T00:00:00+00:00",
                "expiresAt": 0, "_distance": 0.1,
            },
        ])
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("private", table)]  # type: ignore[method-assign]
            runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: []  # type: ignore[method-assign]
            runtime._refine_query = lambda *_args: "refined project"  # type: ignore[method-assign]
            try:
                with patch("plur1bus_hermes.runtime.parse_temporal_range", return_value=_FIXED_RANGE):
                    recalled = runtime.recall("project last month")
            finally:
                runtime.shutdown()

        self.assertIn("current weak result", recalled)
        self.assertNotIn("old refined leak", recalled)
        self.assertEqual(len(table.where_calls), 2)
        self.assertTrue(all("createdAt >=" in clause for clause in table.where_calls))

    def test_refinement_uses_mandatory_predicates_after_fallback(self) -> None:
        """Once fallback is selected, refinement follows that same base policy."""
        table = _Table([{
            "id": "old", "content": "old weak result", "status": "active",
            "createdAt": "2025-01-01T00:00:00+00:00", "expiresAt": 0,
            "_distance": 0.9,
        }])
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("private", table)]  # type: ignore[method-assign]
            runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: []  # type: ignore[method-assign]
            runtime._refine_query = lambda *_args: "refined project"  # type: ignore[method-assign]
            try:
                with patch("plur1bus_hermes.runtime.parse_temporal_range", return_value=_FIXED_RANGE):
                    recalled = runtime.recall("project last month")
            finally:
                runtime.shutdown()

        self.assertIn("old weak result", recalled)
        self.assertEqual(len(table.where_calls), 3)
        self.assertIn("createdAt >=", table.where_calls[0])
        self.assertTrue(all("createdAt >=" not in clause for clause in table.where_calls[1:]))

    def test_malformed_valid_at_is_rejected_before_search(self) -> None:
        """A malformed explicit time must never silently become unrestricted recall."""
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            try:
                with self.assertRaisesRegex(ValueError, "validAt"):
                    runtime.recall("project last month", valid_at="sometime soon")
            finally:
                runtime.shutdown()

    def test_unrelated_search_error_propagates_without_fallback(self) -> None:
        """Only recognized legacy-column errors may enter a search retry path."""
        table = _Table([], error=RuntimeError("storage transport unavailable"))
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._recall_tables = lambda: [("private", table)]  # type: ignore[method-assign]
            runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: []  # type: ignore[method-assign]
            try:
                with patch("plur1bus_hermes.runtime.parse_temporal_range", return_value=_FIXED_RANGE):
                    with self.assertRaisesRegex(RuntimeError, "transport"):
                        runtime.recall("project last month")
            finally:
                runtime.shutdown()

        self.assertEqual(len(table.where_calls), 1)


class TemporalFallbackIntegrationTests(unittest.TestCase):
    def test_empty_heuristic_falls_back_without_removing_mandatory_filters(self) -> None:
        """Dropping the createdAt heuristic must retain ACL, status, TTL and validAt."""
        with tempfile.TemporaryDirectory() as directory:
            runtime = Plur1busRuntime(
                Path(directory), {"embedding": {"dimensions": 2}}, "main"
            )
            runtime._embedding.embed = lambda _text, purpose="passage": [0.1, 0.2]  # type: ignore[method-assign]
            runtime._domain.on_memory = lambda _record, _table, **_kwargs: None  # type: ignore[method-assign]
            runtime._reranker.rerank = lambda _query, rows: rows  # type: ignore[method-assign]
            runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: []  # type: ignore[method-assign]
            runtime._domain.boost_recall = lambda rows, _table, _limit, **_kwargs: rows  # type: ignore[method-assign]
            runtime._domain.recall_overlay = lambda *_args, **_kwargs: ""  # type: ignore[method-assign]
            runtime._domain.cognitive_prompt_blocks = lambda **_kwargs: []  # type: ignore[method-assign]
            try:
                runtime._remember("fixture seed", "fixture", "user")
                table, _ = runtime._table(create=False)
                seed = table.search().limit(1).to_list()[0]

                def row(content: str, **updates: object) -> dict[str, object]:
                    candidate: dict[str, object] = dict(seed)
                    candidate.update({
                        "id": str(uuid.uuid4()),
                        "content": content,
                        "createdAt": "2025-01-15T12:00:00+00:00",
                        "status": "active",
                        "validFrom": 0,
                        "validUntil": 0,
                        "expiresAt": 0,
                    })
                    candidate.update(updates)
                    return candidate

                table.add([
                    row(
                        "eligible historical project",
                        validFrom=1_735_689_600_000,
                        validUntil=1_798_761_600_000,
                    ),
                    row("foreign secret", scopeKey="foreign-scope"),
                    row("deleted project", status="deleted"),
                    row("expired project", expiresAt=1),
                    row("future claim", validFrom=1_788_220_800_000),
                ])

                recalled = runtime.recall(
                    "project last month", valid_at="2026-08-01T00:00:00Z"
                )
            finally:
                runtime.shutdown()

        self.assertIn("eligible historical project", recalled)
        for forbidden in (
            "foreign secret",
            "deleted project",
            "expired project",
            "future claim",
        ):
            self.assertNotIn(forbidden, recalled)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
