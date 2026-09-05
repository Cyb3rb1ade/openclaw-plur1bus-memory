"""Regression tests for the native, exact-runtime operator helpers."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from plur1bus_hermes.namespaces import binding_from_scope, resolve_namespace_routes
from plur1bus_hermes.operator_status import optimize_runtime_table, read_operator_status


class _Table:
    def __init__(self) -> None:
        self.optimized = 0
        self.filter = None

    def count_rows(self, filter: str | None = None) -> int:
        self.filter = filter
        return 4

    def optimize(self) -> dict[str, int]:
        self.optimized += 1
        return {"fragments_removed": 7, "fragments_added": 2, "secret": 99}


class _Database:
    def __init__(self, table: _Table) -> None:
        self.table = table

    def open_table(self, name: str) -> _Table:
        if name != "memories":
            raise AssertionError(name)
        return self.table


class OperatorStatusTests(unittest.TestCase):
    def _runtime(self, root: Path, table: _Table):
        config = {"embedding": {"provider": "local-transformers", "model": "intfloat/e5", "dimensions": 384}}
        agent = "main"
        route, _ = resolve_namespace_routes(root, agent, config)
        route.path.mkdir(parents=True)
        return SimpleNamespace(
            agent_id=agent,
            data_dir=root,
            config=config,
            _writer_route=route,
            scope_binding=binding_from_scope(agent),
        ), lambda path: _Database(table)

    def test_status_opens_only_exact_existing_runtime_table_and_redacts_unsafe_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime, connect = self._runtime(Path(temporary), _Table())
            runtime.config["embedding"]["model"] = "https://token@example.invalid/model"
            status = read_operator_status(runtime, connect=connect)
        self.assertEqual(status["storage"], {"status": "ready", "cards": 4})
        self.assertIsNone(status["embedding"]["model"])
        self.assertFalse(status["configured"])
        self.assertNotIn(str(temporary), repr(status))

    def test_missing_runtime_directory_never_calls_connector_or_creates_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = {"embedding": {"provider": "local-transformers", "model": "e5"}}
            route, _ = resolve_namespace_routes(root, "main", config)
            runtime = SimpleNamespace(agent_id="main", data_dir=root, config=config, _writer_route=route)
            status = read_operator_status(runtime, connect=lambda _: self.fail("must not connect"))
            self.assertFalse(route.path.exists())
        self.assertEqual(status["storage"]["code"], "table_unavailable")

    def test_status_counts_only_the_current_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            table = _Table()
            runtime, connect = self._runtime(Path(temporary), table)
            runtime.scope_binding = binding_from_scope(
                "main", {"scopeType": "chat", "platform": "telegram", "chat": "room-1"}
            )
            status = read_operator_status(runtime, connect=connect)
        self.assertEqual(status["storage"]["cards"], 4)
        self.assertIn("scopeKey", table.filter)
        self.assertIn("agentId", table.filter)

    def test_optimize_requires_authorization_and_projects_only_safe_counts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            table = _Table()
            runtime, connect = self._runtime(Path(temporary), table)
            self.assertEqual(optimize_runtime_table(runtime, authorized=False, connect=connect), {"ok": False, "code": "unauthorized"})
            result = optimize_runtime_table(runtime, authorized=True, connect=connect)
        self.assertEqual(table.optimized, 1)
        self.assertEqual(result, {"ok": True, "code": "optimized", "stats": {"fragmentsRemoved": 7, "fragmentsAdded": 2}})

    def test_route_substitution_is_not_a_foreign_partition_probe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime, connect = self._runtime(root, _Table())
            runtime._writer_route = SimpleNamespace(name="default", path=root / "lancedb" / "other-agent")
            status = read_operator_status(runtime, connect=lambda _: self.fail("must not connect"))
        self.assertEqual(status["storage"]["code"], "table_unavailable")

    def test_symlinked_ancestor_is_rejected_before_opening_the_table(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outside = root / "outside"
            outside.mkdir()
            config = {"embedding": {"provider": "local-transformers", "model": "e5"}}
            route, _ = resolve_namespace_routes(root, "main", config)
            route.path.parent.symlink_to(outside, target_is_directory=True)
            (outside / "main").mkdir()
            runtime = SimpleNamespace(
                agent_id="main", data_dir=root, config=config, _writer_route=route,
                scope_binding=binding_from_scope("main"),
            )
            status = read_operator_status(runtime, connect=lambda _: self.fail("must not connect"))
        self.assertEqual(status["storage"]["code"], "table_unavailable")

    def test_real_lancedb_optimize_preserves_scoped_rows(self) -> None:
        import lancedb

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = {"embedding": {"provider": "local-transformers", "model": "e5"}}
            route, _ = resolve_namespace_routes(root, "main", config)
            route.path.mkdir(parents=True)
            binding = binding_from_scope("main")
            table = lancedb.connect(str(route.path)).create_table(
                "memories",
                data=[
                    {"id": "private", "agentId": "main", "scopeKey": binding.scope_key, "content": "keep", "vector": [0.1, 0.2]},
                    {"id": "other", "agentId": "main", "scopeKey": "other-scope", "content": "not counted", "vector": [0.3, 0.4]},
                ],
            )
            runtime = SimpleNamespace(
                agent_id="main", data_dir=root, config=config, _writer_route=route, scope_binding=binding
            )
            result = optimize_runtime_table(runtime, authorized=True)
            status = read_operator_status(runtime)
            self.assertEqual(table.count_rows(), 2)
        self.assertTrue(result["ok"])
        self.assertEqual(result["stats"], {})
        self.assertEqual(status["storage"]["cards"], 1)
