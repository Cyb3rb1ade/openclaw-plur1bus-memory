"""Hermes parity for the 7.3.5 REM-dream similarity contract.

The association similarity is a genuinely measured token Jaccard in its own
documented scale — never a monotone transform of an index distance compared
against a similarity-meant threshold (the upstream 7.3.5 defect class).
"""

from __future__ import annotations

import unittest

from plur1bus_hermes.dreaming import build_rem_dream


def _row(memory_id: str, content: str, **extra) -> dict:
    return {"id": memory_id, "content": content, "agentId": "main", **extra}


class RemDreamSimilarityTests(unittest.TestCase):
    def test_identical_texts_associate_with_similarity_one(self) -> None:
        text = "gemeinsames wiederkehrendes muster mit vielen gleichen wörtern"
        dream = build_rem_dream(
            [_row("a", text), _row("b", text)], "main",
        )
        self.assertEqual(len(dream["associations"]), 1)
        self.assertEqual(dream["associations"][0]["similarity"], 1.0)

    def test_disjoint_texts_stay_below_threshold(self) -> None:
        dream = build_rem_dream(
            [
                _row("a", "alpha beta gamma delta epsilon zeta"),
                _row("b", "hund katze maus vogel fisch pferd"),
            ],
            "main",
        )
        self.assertEqual(dream["associations"], [])

    def test_distance_field_does_not_influence_similarity(self) -> None:
        # A deceptive `_distance` payload must not change the measured
        # similarity: the scale comes from the texts, not from any index.
        text = "gemeinsames wiederkehrendes muster mit vielen gleichen wörtern"
        rows = [
            _row("a", text, _distance=99.9),
            _row("b", text, _distance=0.0),
        ]
        dream = build_rem_dream(rows, "main")
        self.assertEqual(len(dream["associations"]), 1)
        self.assertEqual(dream["associations"][0]["similarity"], 1.0)

    def test_partial_overlap_measures_genuine_jaccard(self) -> None:
        first = "alpha beta gamma delta"
        second = "alpha beta gamma omega"
        dream = build_rem_dream([_row("a", first), _row("b", second)], "main")
        self.assertEqual(len(dream["associations"]), 1)
        # tokens: {alpha,beta,gamma,delta} vs {alpha,beta,gamma,omega} → 3/5
        self.assertEqual(dream["associations"][0]["similarity"], 0.6)


class RemDreamVisibilityTests(unittest.TestCase):
    def test_dream_record_carries_scope_binding(self) -> None:
        dream = build_rem_dream(
            [_row("a", "einfaches muster mit genug wörtern drin")], "main",
        )
        self.assertEqual(dream["agentId"], "main")
        self.assertTrue(dream["scopeKey"])
        self.assertIn("aclBindings", dream)
        self.assertEqual(dream["aclBindings"]["agentId"], "main")

    def test_foreign_agent_rows_never_enter_the_dream(self) -> None:
        dream = build_rem_dream(
            [
                _row("a", "gemeinsames wiederkehrendes muster mit vielen wörtern", agentId="main"),
                {**_row("b", "gemeinsames wiederkehrendes muster mit vielen wörtern"), "agentId": "other"},
            ],
            "main",
        )
        self.assertNotIn("b", dream["activatedMemoryIds"])

    def test_unstamped_legacy_rows_are_own_agent_only(self) -> None:
        # Legacy rows without scopeKey/aclBindings fall back to own-agent
        # visibility only (upstream 7.4.0 legacy rule).
        legacy = {"id": "legacy", "content": "alter ungestempelter eintrag mit wörtern"}
        dream = build_rem_dream([legacy], "main")
        self.assertIn("legacy", dream["activatedMemoryIds"])
        # The same unstamped row under a non-private scope stays invisible.
        dream_scoped = build_rem_dream(
            [legacy],
            "main",
            acl_bindings={"agentId": "main", "scopeType": "workspace", "workspaceIdentity": "ws-1"},
        )
        self.assertNotIn("legacy", dream_scoped["activatedMemoryIds"])


if __name__ == "__main__":
    unittest.main()
