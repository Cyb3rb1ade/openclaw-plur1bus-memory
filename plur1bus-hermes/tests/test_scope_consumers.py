from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.dreaming import build_rem_dream
from plur1bus_hermes.jobs import run_jobs


class _Search:
    def __init__(self, rows):
        self.rows = list(rows)
        self.predicate = ""
        self.requested_limit = None

    def where(self, predicate):
        self.predicate = predicate
        return self

    def limit(self, value):
        self.requested_limit = value
        return self

    def to_list(self):
        rows = self.rows
        match = re.search(r"scopeKey = '([^']+)'", self.predicate)
        if match:
            rows = [row for row in rows if row.get("scopeKey") == match.group(1)]
        if self.requested_limit is not None:
            rows = rows[: self.requested_limit]
        return list(rows)


class _Table:
    def __init__(self, rows):
        self.rows = list(rows)
        self.searches = []
        self.updates = []

    def search(self, *_args):
        search = _Search(self.rows)
        self.searches.append(search)
        return search

    def update(self, where, values):
        self.updates.append((where, values))


class ScopeConsumerTests(unittest.TestCase):
    def test_graph_and_reactivation_filter_before_hydration(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            domain._append_jsonl(
                domain.neo_dir / "memory-graph.jsonl",
                {"source": "seed", "target": "foreign", "strength": 0.9, "scopeKey": "scope-foreign"},
            )
            domain._append_jsonl(
                domain.neo_dir / "memory-graph.jsonl",
                {"source": "seed", "target": "bound", "strength": 0.9, "scopeKey": "scope-bound"},
            )
            domain._write_json(
                domain.workspace_dir / ".plur1bus" / "link-index.json",
                {
                    "scopeKey": "scope-bound",
                    "entries": {
                        "seed": {
                            "scopeKey": "scope-bound",
                            "links": [
                                {"id": "bound", "scopeKey": "scope-bound"},
                                {"id": "foreign", "scopeKey": "scope-foreign"},
                            ],
                        }
                    }
                },
            )
            table = _Table([
                {"id": "foreign", "scopeKey": "scope-foreign", "status": "active"},
                {"id": "bound", "scopeKey": "scope-bound", "status": "active"},
            ])

            candidates = domain._graph_neighbor_ids({"seed"}, scope_key="scope-bound")
            reactivated = domain._reactivation_ids({"seed"}, scope_key="scope-bound")
            hydratable = _Table([
                {"id": "619c3d51-1d9d-4736-8bf9-91b38aff8245", "scopeKey": "scope-foreign", "status": "active"},
                {"id": "619c3d51-1d9d-4736-8bf9-91b38aff8246", "scopeKey": "scope-bound", "status": "active"},
            ])
            hydrated = domain._hydrate_ids(
                hydratable,
                {
                    "619c3d51-1d9d-4736-8bf9-91b38aff8245",
                    "619c3d51-1d9d-4736-8bf9-91b38aff8246",
                },
                1,
                scope_key="scope-bound",
            )

            self.assertEqual(candidates, {"bound"})
            self.assertEqual(reactivated, {"bound"})
            self.assertEqual(
                [row["id"] for row in hydrated],
                ["619c3d51-1d9d-4736-8bf9-91b38aff8246"],
            )
            self.assertIn("scopeKey = 'scope-bound'", hydratable.searches[-1].predicate)

    def test_dream_and_consolidation_query_bound_rows_before_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            table = _Table([
                {"id": "foreign", "scopeKey": "scope-foreign", "status": "active", "content": "foreign"},
                {"id": "bound", "scopeKey": "scope-bound", "status": "active", "content": "bound"},
            ])

            dream = domain.run_dreaming(table, max_memories=1, scope_key="scope-bound")
            report = domain.run_consolidation(table, scope_key="scope-bound")

            self.assertEqual(dream["activatedMemoryIds"], ["bound"])
            self.assertEqual(report["cardsScanned"], 1)
            self.assertIn("scopeKey = 'scope-bound'", table.searches[0].predicate)
            self.assertIn("scopeKey = 'scope-bound'", table.searches[1].predicate)

    def test_direct_rem_dream_drops_foreign_rows_and_preserves_binding(self):
        dream = build_rem_dream(
            [
                {"id": "foreign", "scopeKey": "scope-foreign", "content": "foreign memory"},
                {"id": "bound", "scopeKey": "scope-bound", "content": "bound memory"},
            ],
            "main",
            scope_key="scope-bound",
        )

        self.assertEqual(dream["activatedMemoryIds"], ["bound"])
        self.assertEqual(dream["scopeKey"], "scope-bound")

    def test_canonical_acl_binding_filters_prompts_and_dream_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            binding = {
                "scopeType": "workspace",
                "workspaceIdentity": "workspace-a",
            }
            from plur1bus_hermes.namespaces import canonical_scope_binding

            canonical = canonical_scope_binding("main", **binding)
            domain._append_jsonl(
                domain.neo_dir / "open-threads.jsonl",
                {"id": "foreign-thread", "scopeKey": "foreign", "status": "open", "text": "foreign"},
            )
            domain._append_jsonl(
                domain.neo_dir / "open-threads.jsonl",
                {"id": "bound-thread", "scopeKey": canonical.scope_key, "status": "open", "text": "bound"},
            )
            domain._append_jsonl(
                domain.neo_dir / "contradiction-disclosure.jsonl",
                {"newMemoryId": "foreign-memory", "scopeKey": "foreign", "score": 0.9},
            )
            domain._append_jsonl(
                domain.neo_dir / "contradiction-disclosure.jsonl",
                {"newMemoryId": "bound-memory", "scopeKey": canonical.scope_key, "score": 0.8},
            )

            overlay = domain.recall_overlay(
                "Wie geht es weiter?",
                [
                    {"id": "foreign-memory", "scopeKey": "foreign", "_distance": 0.1},
                    {"id": "bound-memory", "scopeKey": canonical.scope_key, "_distance": 0.2},
                ],
                aclBindings=canonical.as_dict(),
                scopeKey=canonical.scope_key,
            )
            dream = build_rem_dream(
                [
                    {"id": "foreign", "scopeKey": "foreign", "content": "foreign"},
                    {"id": "bound", "scopeKey": canonical.scope_key, "content": "bound"},
                ],
                "main",
                aclBindings=canonical.as_dict(),
            )

            payload = json.loads(
                overlay.removeprefix("<memory-meta-cognition>\n").removesuffix(
                    "\n</memory-meta-cognition>"
                )
            )
            self.assertEqual(payload["recalledMemoryIds"], ["bound-memory"])
            self.assertEqual(payload["openThreads"], ["bound"])
            self.assertEqual(
                payload["contradictionsRequireReview"],
                [{"newMemoryId": "bound-memory", "existingMemoryId": None, "score": 0.8}],
            )
            self.assertEqual(dream["activatedMemoryIds"], ["bound"])
            self.assertEqual(dream["aclBindings"]["scopeKey"], canonical.scope_key)

    def test_missing_required_scope_identity_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            with self.assertRaises(ValueError):
                domain.run_dreaming(
                    _Table([]),
                    acl_bindings={"scopeType": "workspace"},
                )
            with self.assertRaises(ValueError):
                build_rem_dream(
                    [],
                    "main",
                    acl_bindings={"scopeType": "user", "platform": "telegram"},
                )

    def test_periodic_jobs_forward_explicit_scope_to_every_consumer(self):
        class JobDomain:
            def __init__(self):
                self.calls = []

            def _call(self, name, **kwargs):
                self.calls.append((name, kwargs))
                return {}

            def run_dynamics(self, **kwargs): return self._call("run_dynamics", **kwargs)
            def proactive_check(self, **kwargs): return self._call("proactive_check", **kwargs)
            def run_afterthought(self, **kwargs): return self._call("run_afterthought", **kwargs)
            def due_reminders(self, **kwargs): self._call("due_reminders", **kwargs); return []
            def run_meta_reflection(self, **kwargs): return self._call("run_meta_reflection", **kwargs)
            def auto_accept_stale_criticals(self, **kwargs): return self._call("auto_accept_stale_criticals", **kwargs)
            def run_consolidation(self, _table, **kwargs): return self._call("run_consolidation", **kwargs)
            def run_gc(self, _table, **kwargs): return self._call("run_gc", **kwargs)
            def run_dreaming(self, _table, **kwargs): return self._call("run_dreaming", **kwargs)
            def rebuild_indexes(self, _table, **kwargs): return self._call("rebuild_indexes", **kwargs)
            def maintain_obsidian(self, **kwargs): return self._call("maintain_obsidian", **kwargs)
            def rebuild_code_index(self, **kwargs): return self._call("rebuild_code_index", **kwargs)

        class Runtime:
            last = None

            def __init__(self, *_args):
                self._domain = JobDomain()
                Runtime.last = self

            def _table(self, create=False):
                return object(), False

            def shutdown(self, timeout_seconds=5):
                pass

        with tempfile.TemporaryDirectory() as temporary:
            run_jobs(
                Path(temporary),
                {"gc": {"enabled": True}},
                "main",
                "all",
                runtime_factory=Runtime,
                scope_key="scope-bound",
            )

            calls = {name: kwargs for name, kwargs in Runtime.last._domain.calls}
            scoped = {
                "run_dynamics",
                "due_reminders",
                "run_consolidation",
                "run_gc",
                "run_dreaming",
                "rebuild_indexes",
                "maintain_obsidian",
            }
            self.assertEqual(
                {name: kwargs["scope_key"] for name, kwargs in calls.items() if name in scoped},
                {name: "scope-bound" for name in scoped},
            )
            self.assertEqual(
                {name for name, kwargs in calls.items() if "scope_key" in kwargs},
                scoped,
            )


if __name__ == "__main__":
    unittest.main()
