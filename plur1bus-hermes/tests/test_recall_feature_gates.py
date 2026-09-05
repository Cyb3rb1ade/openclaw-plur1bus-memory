"""Opt-out coverage for additive semantic and continuity recall helpers."""

from __future__ import annotations

import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain, _now_ms


class RecallFeatureGateTests(unittest.TestCase):
    @staticmethod
    def _base() -> list[dict[str, str]]:
        return [{"id": "base", "agentId": "main", "content": "base recall"}]

    def _boost_domain(self, config=None):
        domain = Plur1busDomain(Path("/private/tmp"), "main", config)
        calls: list[str] = []
        domain._graph_neighbor_ids = lambda *_args, **_kwargs: calls.append("graph") or {"graph"}  # type: ignore[method-assign]
        domain._semantic_lens_ids = lambda *_args, **_kwargs: calls.append("lens") or {"lens"}  # type: ignore[method-assign]
        domain._reactivation_ids = lambda *_args, **_kwargs: calls.append("continuity") or {"continuity"}  # type: ignore[method-assign]
        domain._hydrate_ids = lambda _table, ids, *_args, **_kwargs: [  # type: ignore[method-assign]
            {"id": item, "agentId": "main", "content": item} for item in sorted(ids)
        ]
        domain._last_recall_ms = _now_ms() - 46 * 60 * 1000
        return domain, calls

    def test_default_configuration_adds_semantic_and_continuity_candidates(self) -> None:
        domain, calls = self._boost_domain()
        result = domain.boost_recall(self._base(), object(), 4)

        self.assertEqual(calls, ["graph", "lens", "continuity"])
        self.assertEqual({row["id"] for row in result}, {"base", "graph", "lens", "continuity"})

    def test_explicit_optouts_keep_graph_base_but_skip_semantic_and_continuity(self) -> None:
        domain, calls = self._boost_domain({"semanticLens": False, "continuityEngine": {"enabled": False}})
        previous_recall = domain._last_recall_ms
        result = domain.boost_recall(self._base(), object(), 4)

        self.assertEqual(calls, ["graph"])
        self.assertEqual([row["id"] for row in result], ["base", "graph"])
        self.assertEqual(domain._last_recall_ms, previous_recall, "continuity state must not advance while disabled")

    def test_semantic_lens_direct_helper_honors_enabled_false_without_reading_an_index(self) -> None:
        domain = Plur1busDomain(Path("/private/tmp"), "main", {"semanticLens": {"enabled": False}})
        domain._read_json = lambda _path: self.fail("disabled lens must not read its index")  # type: ignore[method-assign]
        self.assertEqual(domain._semantic_lens_ids({"base"}), set())

    def test_continuity_overlay_defaults_on_and_explicit_false_suppresses_it(self) -> None:
        rows = [{"id": "base", "agentId": "main", "content": "base", "_distance": 0.1}]
        self.assertTrue(Plur1busDomain(Path("/private/tmp"), "main").recall_overlay("continue?", rows))
        self.assertEqual(
            Plur1busDomain(Path("/private/tmp"), "main", {"continuityEngine": False}).recall_overlay("continue?", rows),
            "",
        )

    def test_explain_recall_remains_a_scope_filtered_base_recall_explanation(self) -> None:
        domain = Plur1busDomain(Path("/private/tmp"), "main", {"semanticLens": False, "continuityEngine": False})
        explanation = domain.explain_recall([
            {"id": "own", "agentId": "main", "content": "own", "_distance": 0.1},
            {"id": "foreign", "agentId": "other", "content": "foreign", "_distance": 0.1},
        ])
        self.assertIn('"id": "own"', explanation)
        self.assertNotIn('"id": "foreign"', explanation)


if __name__ == "__main__":
    unittest.main()
