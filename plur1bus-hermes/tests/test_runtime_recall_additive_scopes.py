"""Regression: booster scope failures must not erase authorized recall rows."""

from __future__ import annotations

import tempfile
import unittest
import uuid
from pathlib import Path

from plur1bus_hermes.namespaces import legacy_agent_private_scope_key
from plur1bus_hermes.runtime import Plur1busRuntime


class RuntimeRecallAdditiveScopeTests(unittest.TestCase):
    def test_legacy_modern_and_authorized_shared_rows_survive_empty_booster(self) -> None:
        """A mixed legacy/default table must remain additive even when boosting yields []."""
        with tempfile.TemporaryDirectory() as directory:
            runtime = Plur1busRuntime(Path(directory), {"embedding": {"dimensions": 2}}, "main")
            runtime._embedding.embed = lambda _text, purpose="passage": [0.1, 0.2]  # type: ignore[method-assign]
            runtime._domain.on_memory = lambda _record, _table, **_kwargs: None  # type: ignore[method-assign]
            runtime._reranker.rerank = lambda _query, rows: rows  # type: ignore[method-assign]
            runtime._domain.recall_overlay = lambda *_args, **_kwargs: ""  # type: ignore[method-assign]
            runtime._domain.explain_recall = lambda *_args, **_kwargs: ""  # type: ignore[method-assign]
            runtime._domain.cognitive_prompt_blocks = lambda **_kwargs: []  # type: ignore[method-assign]
            try:
                runtime._remember("modern private memory", "s", "user")
                table, _ = runtime._table(create=False)
                modern = table.search().limit(1).to_list()[0]
                legacy = dict(modern)
                legacy.update({
                    "id": str(uuid.uuid4()), "content": "legacy private memory",
                    "scopeKey": legacy_agent_private_scope_key(), "sessionId": "legacy",
                })
                foreign = dict(modern)
                foreign.update({
                    "id": str(uuid.uuid4()), "content": "foreign private memory",
                    "scopeKey": "foreign-scope", "sessionId": "foreign",
                })
                table.add([legacy, foreign])

                shared = dict(modern)
                shared.update({"id": str(uuid.uuid4()), "content": "authorized shared memory", "_distance": 0.01})
                runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: [shared]  # type: ignore[method-assign]
                # This models the former mixed-scope booster result: it returns
                # no safe booster rows, but must never replace base/shared rows.
                runtime._domain.boost_recall = lambda _rows, _table, _limit, **_kwargs: []  # type: ignore[method-assign]

                recalled = runtime.recall("memory", explain=True)
            finally:
                runtime.shutdown()

        self.assertIn("modern private memory", recalled)
        self.assertIn("legacy private memory", recalled)
        self.assertIn("authorized shared memory", recalled)
        self.assertNotIn("foreign private memory", recalled)

    def test_real_domain_booster_gets_explicit_scope_for_mixed_legacy_private_rows(self) -> None:
        """Exercise the real domain path behind the legacy/default mixed-scope bug."""
        with tempfile.TemporaryDirectory() as directory:
            runtime = Plur1busRuntime(Path(directory), {"embedding": {"dimensions": 2}}, "main")
            runtime._embedding.embed = lambda _text, purpose="passage": [0.1, 0.2]  # type: ignore[method-assign]
            runtime._domain.on_memory = lambda _record, _table, **_kwargs: None  # type: ignore[method-assign]
            runtime._reranker.rerank = lambda _query, rows: rows  # type: ignore[method-assign]
            runtime._shared_pools.recall_rows = lambda *_args, **_kwargs: []  # type: ignore[method-assign]
            runtime._domain.recall_overlay = lambda *_args, **_kwargs: ""  # type: ignore[method-assign]
            runtime._domain.cognitive_prompt_blocks = lambda **_kwargs: []  # type: ignore[method-assign]
            observed: list[dict[str, object]] = []
            original_boost = runtime._domain.boost_recall

            def observe_boost(rows, table, limit, **kwargs):
                observed.append(dict(kwargs))
                return original_boost(rows, table, limit, **kwargs)

            runtime._domain.boost_recall = observe_boost  # type: ignore[method-assign]
            try:
                runtime._remember("modern real booster memory", "s", "user")
                table, _ = runtime._table(create=False)
                modern = table.search().limit(1).to_list()[0]
                legacy = dict(modern)
                legacy.update({
                    "id": str(uuid.uuid4()), "content": "legacy real booster memory",
                    "scopeKey": legacy_agent_private_scope_key(), "sessionId": "legacy",
                })
                table.add([legacy])
                recalled = runtime.recall("booster")
            finally:
                runtime.shutdown()

        self.assertEqual(observed, [{"acl_bindings": runtime.scope_binding.as_dict()}])
        self.assertIn("modern real booster memory", recalled)
        self.assertIn("legacy real booster memory", recalled)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
