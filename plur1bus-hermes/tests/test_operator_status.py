"""Regression tests for the native, exact-runtime operator helpers."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from plur1bus_hermes.namespaces import binding_from_scope, resolve_namespace_routes
from plur1bus_hermes.operator_status import browse_runtime_memories, optimize_runtime_table, read_operator_status


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
    def test_retry_budget_and_generation_revalidation_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            table = _Table()
            runtime, connect = self._runtime(Path(temporary), table)
            with patch.object(table, 'optimize', side_effect=RuntimeError('retryable commit conflict')) as optimize, \
                 patch('plur1bus_hermes.operator_status.time.sleep') as sleep:
                result = optimize_runtime_table(runtime, authorized=True, connect=connect, retry_budget_seconds=1)
                self.assertFalse(result['ok'])
                self.assertEqual(optimize.call_count, 1)
                sleep.assert_not_called()
            with patch.object(table, 'optimize', side_effect=RuntimeError('retryable commit conflict')) as optimize, \
                 patch('plur1bus_hermes.operator_status._open_exact_table', side_effect=[table, RuntimeError('generation changed')]) as opened:
                result = optimize_runtime_table(runtime, authorized=True, retry_delay_seconds=0)
                self.assertFalse(result['ok'])
                self.assertEqual(opened.call_count, 2)
                self.assertEqual(optimize.call_count, 1)
            self.assertEqual(optimize_runtime_table(runtime, authorized=True, max_attempts=True)['code'], 'invalid_retry_options')

    def test_primary_agent_cards_are_current_profile_only_and_unknown_is_not_zero(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime, connect = self._runtime(Path(temporary), _Table())
            runtime.profile = 'Coder'
            result = read_operator_status(runtime, connect=connect)
            self.assertEqual(result['cards']['byPrimaryAgent'], [{'id': 'main', 'profile': 'Coder', 'cards': 4}])
            failed = read_operator_status(runtime, connect=lambda _: (_ for _ in ()).throw(OSError('private path')))
            self.assertEqual(failed['cards']['byPrimaryAgent'], [{'id': 'main', 'profile': 'Coder', 'cards': None}])
            runtime.scope_binding = binding_from_scope('main', {'scopeType': 'chat', 'platform': 'telegram', 'chat': 'room'})
            self.assertEqual(read_operator_status(runtime, connect=connect)['cards']['byPrimaryAgent'], [])

    def test_optimize_retries_only_conflicts_and_does_not_change_data_route(self):
        with tempfile.TemporaryDirectory() as temporary:
            table = _Table()
            runtime, connect = self._runtime(Path(temporary), table)
            with patch.object(table, 'optimize', side_effect=[RuntimeError('preempted by concurrent transaction Update'),
                                                            {'fragments_removed': 7}]) as optimize:
                result = optimize_runtime_table(runtime, authorized=True, connect=connect, retry_delay_seconds=0)
                self.assertTrue(result['ok'])
                self.assertEqual(result['attempts'], 2)
                self.assertEqual(optimize.call_count, 2)
            with patch.object(table, 'optimize', side_effect=RuntimeError('permission denied')) as optimize:
                self.assertFalse(optimize_runtime_table(runtime, authorized=True, connect=connect)['ok'])
                self.assertEqual(optimize.call_count, 1)
            with patch.object(table, 'optimize', side_effect=RuntimeError('retryable commit conflict')) as optimize:
                self.assertFalse(optimize_runtime_table(runtime, authorized=True, connect=connect,
                                                       max_attempts=2, retry_delay_seconds=0)['ok'])
                self.assertEqual(optimize.call_count, 2)

    def test_memory_browser_real_lance_scope_literal_search_and_paging(self):
        import lancedb
        with tempfile.TemporaryDirectory() as temporary:
            runtime, _ = self._runtime(Path(temporary), _Table())
            rows = [{"id": str(i), "agentId": "main", "scopeKey": runtime.scope_binding.scope_key,
                     "content": "Owner's 100% _ literal", "status": "active", "vector": [0.1, 0.2],
                     "internalSecret": "not exported"} for i in range(3)]
            rows += [{**rows[0], "id": "foreign", "scopeKey": "foreign"},
                     {**rows[0], "id": "foreign-agent", "agentId": "other"},
                     {**rows[0], "id": "archived", "status": "archived"}]
            table = lancedb.connect(str(runtime._writer_route.path)).create_table("memories", data=rows)
            page = browse_runtime_memories(runtime, query="Owner's 100% _", limit=2)
            self.assertEqual(len(page["items"]), 2)
            self.assertTrue(page["hasMore"])
            last = browse_runtime_memories(runtime, offset=2, limit=2)
            self.assertEqual(len(last["items"]), 1)
            self.assertFalse(last["hasMore"])
            self.assertEqual(browse_runtime_memories(runtime, query="' OR 1=1 --")["items"], [])
            self.assertEqual(browse_runtime_memories(runtime, status="archived")["items"][0]["id"], "archived")
            self.assertNotIn("vector", repr(page))
            self.assertNotIn("internalSecret", repr(page))
            self.assertEqual(table.count_rows(), 6)
            for args in ({"query": "x" * 201}, {"query": "\x00"}, {"offset": -1}, {"limit": 51}, {"status": "bad"}):
                with self.subTest(args=args), self.assertRaises(ValueError):
                    browse_runtime_memories(runtime, **args)

    def test_local_onnx_credentials_are_not_reported_as_missing_remote_key(self):
        from plur1bus_hermes.operator_status import _credential_state
        self.assertEqual(_credential_state({"provider": "local-onnx"}, "local-onnx", reranker=False), "not_required")

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
        self.assertEqual(result, {"ok": True, "code": "optimized", "stats": {"fragmentsRemoved": 7, "fragmentsAdded": 2}, "attempts": 1})

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
