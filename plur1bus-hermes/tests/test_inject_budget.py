"""Hermes parity for the 7.4.0 global inject budget (`recall.globalInjectMaxChars`).

Covers overflow trimming, tiny budgets, Unicode content, the unchanged
under-limit case, non-droppable structural blocks, and the runtime recall
wiring (default 17000, config override, no more hardcoded 12000 cap).
"""

from __future__ import annotations

import tempfile
from contextlib import ExitStack
import unittest
from pathlib import Path

from plur1bus_hermes.inject_budget import apply_global_inject_budget
from plur1bus_hermes.runtime import Plur1busRuntime


def _blocks(memories: str, *, compression: str = "") -> list[dict]:
    return [
        {"name": "memories", "text": memories, "droppable": True},
        {"name": "overlay", "text": "", "droppable": True},
        {"name": "explanation", "text": "", "droppable": True},
        {"name": "compression", "text": compression, "droppable": False},
    ]


class ApplyGlobalInjectBudgetTests(unittest.TestCase):
    def test_under_limit_is_unchanged(self) -> None:
        result = apply_global_inject_budget(
            blocks=[
                {"name": "memories", "text": "- kurz", "droppable": True},
                {"name": "compression", "text": "<x>", "droppable": False},
            ],
            max_chars=17_000,
        )
        self.assertEqual(result, "- kurz\n\n<x>")

    def test_overflow_trims_droppable_memory_content(self) -> None:
        memories = "m" * 5000
        result = apply_global_inject_budget(blocks=_blocks(memories), max_chars=1000)
        self.assertLessEqual(len(result), 1000)
        self.assertTrue(result.startswith("m" * 100))

    def test_last_droppable_block_yields_first(self) -> None:
        result = apply_global_inject_budget(
            blocks=[
                {"name": "memories", "text": "m" * 100, "droppable": True},
                {"name": "explanation", "text": "e" * 100, "droppable": True},
                {"name": "compression", "text": "<x>", "droppable": False},
            ],
            max_chars=120,
        )
        # The explanation is sacrificed before the memory list.
        self.assertNotIn("e" * 100, result)
        self.assertIn("m" * 50, result)
        self.assertTrue(result.endswith("<x>"))

    def test_non_droppable_block_always_survives(self) -> None:
        marker = "<memory-input-compression>original=9 compressed=3</memory-input-compression>"
        result = apply_global_inject_budget(
            blocks=[
                {"name": "memories", "text": "m" * 500, "droppable": True},
                {"name": "compression", "text": marker, "droppable": False},
            ],
            max_chars=len(marker) + 20,
        )
        self.assertIn(marker, result)

    def test_tiny_budget_drops_whole_blocks_but_keeps_markers(self) -> None:
        result = apply_global_inject_budget(
            blocks=[
                {"name": "memories", "text": "m" * 500, "droppable": True},
                {"name": "compression", "text": "<x>", "droppable": False},
            ],
            max_chars=3,
        )
        self.assertEqual(result, "<x>")

    def test_unicode_counts_python_codepoints(self) -> None:
        memories = "🦊" * 100 + "äöü" * 100
        result = apply_global_inject_budget(blocks=_blocks(memories), max_chars=150)
        self.assertLessEqual(len(result), 150)
        self.assertTrue(result.startswith("🦊"))

    def test_invalid_cap_disables_budget(self) -> None:
        text = "m" * 5000
        for cap in (0, -5, None, "not-a-number"):
            with self.subTest(cap=cap):
                result = apply_global_inject_budget(blocks=_blocks(text), max_chars=cap)
                self.assertEqual(result, text)


class _FakeRecallTable:
    def __init__(self, rows):
        self._rows = rows
        self.where_clause = ""

    def search(self, vector):
        self._vector = vector
        return self

    def where(self, clause):
        self.where_clause = clause
        return self

    def limit(self, count):
        return self

    def to_list(self):
        return list(self._rows)


class RuntimeInjectBudgetWiringTests(unittest.TestCase):
    def _runtime(self, directory: str, config: dict) -> Plur1busRuntime:
        runtime = Plur1busRuntime(Path(directory), config, "main")
        runtime._embedding.embed = lambda text, purpose="query": [0.1, 0.2]  # type: ignore[method-assign]
        runtime._reranker.rerank = lambda query, rows: rows  # type: ignore[method-assign]
        runtime._domain.boost_recall = lambda rows, table, limit, **kwargs: rows  # type: ignore[method-assign]
        runtime._domain.recall_overlay = lambda query, rows, **kwargs: ""  # type: ignore[method-assign]
        runtime._shared_pools.recall_rows = lambda vector, limit: []  # type: ignore[method-assign]
        return runtime

    def test_default_budget_allows_more_than_the_old_hard_cap(self) -> None:
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            runtime = self._runtime(directory, {})
            resources.callback(runtime.shutdown)
            rows = [
                {"id": str(index), "content": f"Karte {index} " + "x" * 1800, "_distance": 0.1}
                for index in range(9)
            ]
            table = _FakeRecallTable(rows)
            runtime._recall_tables = lambda: [("default", table)]  # type: ignore[method-assign]
            result = runtime.recall("frage", limit=12)
        # 9 × ~1810 chars ≈ 16.3k — above the old 12000 hard cap, under 17000.
        self.assertGreater(len(result), 12_000)
        self.assertLessEqual(len(result), 17_000)

    def test_configured_small_budget_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            runtime = self._runtime(directory, {"recall": {"globalInjectMaxChars": 500}})
            resources.callback(runtime.shutdown)
            rows = [
                {"id": str(index), "content": f"Karte {index} " + "x" * 1800, "_distance": 0.1}
                for index in range(5)
            ]
            table = _FakeRecallTable(rows)
            runtime._recall_tables = lambda: [("default", table)]  # type: ignore[method-assign]
            result = runtime.recall("frage")
        self.assertLessEqual(len(result), 500)

    def test_recall_where_clause_keeps_lifecycle_filter(self) -> None:
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            runtime = self._runtime(directory, {})
            resources.callback(runtime.shutdown)
            table = _FakeRecallTable([])
            runtime._recall_tables = lambda: [("default", table)]  # type: ignore[method-assign]
            runtime.recall("frage")
        # `demoted` (and any non-active status) stays out of recall; `conflict`
        # is never a hard filter — there is no conflict predicate at all.
        self.assertIn("status = 'active'", table.where_clause)
        self.assertNotIn("conflict", table.where_clause)
        self.assertNotIn("demoted", table.where_clause)


if __name__ == "__main__":
    unittest.main()
