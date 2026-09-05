"""End-to-end negative regressions for the Hermes 7.3.1 security follow-up."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.jobs import run_jobs
from plur1bus_hermes.namespaces import binding_from_scope
from plur1bus_hermes.rate_gate import JobRateGate
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.tombstone import (
    append_tombstone_to_registry,
    archive_card_atomically,
    archive_path_for,
    build_tombstone,
    is_valid_tombstone,
    read_tombstones_from_registry,
    repair_tombstones,
    tombstone_blocks_capture,
)


MEMORY_A = "a4563cc9-7611-4528-992a-075f8889a018"
MEMORY_B = "b4563cc9-7611-4528-992a-075f8889a018"


class _Query:
    def __init__(self, table: "_Table") -> None:
        self.table = table
        self.start = 0
        self.maximum = len(table.rows)

    def where(self, clause: str) -> "_Query":
        self.table.where_clauses.append(clause)
        return self

    def offset(self, value: int) -> "_Query":
        self.start = value
        return self

    def limit(self, value: int) -> "_Query":
        self.maximum = value
        return self

    def to_list(self) -> list[dict]:
        return [dict(row) for row in self.table.rows[self.start:self.start + self.maximum]]


class _Table:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.where_clauses: list[str] = []

    def search(self, *_args, **_kwargs) -> _Query:
        return _Query(self)

    def update(self, *, where: str, values: dict):
        self.where_clauses.append(where)
        for row in self.rows:
            row.update(values)
        return None

    def create_index(self, **_kwargs) -> None:
        return None


class TombstoneRepairSecurityTests(unittest.TestCase):
    def test_chat_tombstone_is_valid_and_bound_to_platform_and_chat(self) -> None:
        binding = binding_from_scope(
            "agent-a",
            {"scopeType": "chat", "platform": "telegram", "chatId": "chat-1"},
        )
        card = {
            "id": MEMORY_A,
            "agentId": "agent-a",
            "scopeKey": binding.scope_key,
            "scopeType": "chat",
            "ownerPlatform": "telegram",
            "chatScope": "chat-1",
            "aclBindings": binding.as_dict(),
            "content": "chat secret",
        }
        tombstone = build_tombstone(
            card=card,
            agent_id="agent-a",
            scope_key=binding.scope_key,
            acl_bindings=binding.as_dict(),
        )
        self.assertTrue(is_valid_tombstone(tombstone, "agent-a"))
        self.assertTrue(tombstone_blocks_capture(tombstone, {
            "agentId": "agent-a", "scope": "chat", "platform": "telegram", "chat": "chat-1",
        }))
        self.assertFalse(tombstone_blocks_capture(tombstone, {
            "agentId": "agent-a", "scope": "chat", "platform": "telegram", "chat": "chat-2",
        }))
        self.assertFalse(tombstone_blocks_capture(tombstone, {
            "agentId": "agent-a", "scope": "chat", "platform": "slack", "chat": "chat-1",
        }))

    def test_live_chat_forget_commits_a_readable_registry_sequence(self) -> None:
        class Domain:
            def __init__(self): self.audit = []
            def audit_mutation(self, entry): self.audit.append(entry)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            scope = {
                "scopeType": "chat",
                "platform": "telegram",
                "chatId": "chat-1",
            }
            binding = binding_from_scope("agent-a", scope)
            card = {
                "id": MEMORY_A,
                "agentId": "agent-a",
                "scopeKey": binding.scope_key,
                "scopeType": "chat",
                "ownerKey": binding.owner_key,
                "ownerPlatform": "telegram",
                "chatScope": "chat-1",
                "aclBindings": binding.as_dict(),
                "content": "chat secret",
                "status": "active",
            }
            table = _Table([card])
            runtime = object.__new__(Plur1busRuntime)
            runtime.data_dir = root
            runtime.agent_id = "agent-a"
            runtime.request_scope = {
                "scopeType": "chat", "platform": "telegram", "chat": "chat-1", "user": "u-1"
            }
            runtime.scope_binding = binding
            runtime.scope_key = binding.scope_key
            runtime._domain = Domain()
            runtime._table = lambda create, first_record=None: (table, False)

            self.assertTrue(runtime.forget(MEMORY_A))
            rows = read_tombstones_from_registry(root, "agent-a")
            self.assertEqual(
                [row["status"] for row in rows],
                ["attempted", "attempted", "committed"],
            )
            self.assertEqual(rows[-1]["scope"], "chat")
            self.assertEqual(rows[-1]["ownerPlatform"], "telegram")
            self.assertEqual(rows[-1]["chatId"], "chat-1")
            self.assertEqual(runtime._domain.audit[0]["result"], "committed")

    def test_native_repair_is_dry_run_safe_apply_idempotent_and_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binding = binding_from_scope("agent-a")
            archive_card = {
                "id": MEMORY_A,
                "agentId": "agent-a",
                "scopeKey": binding.scope_key,
                "scopeType": "agent-private",
                "content": "forgotten fact",
                "status": "active",
            }
            current = {**archive_card, "status": "deleted"}
            archive = archive_path_for(root, "agent-a", binding.scope_key, MEMORY_A)
            archive_card_atomically(archive, archive_card)
            attempted = build_tombstone(
                card=archive_card,
                agent_id="agent-a",
                archive_ref=str(archive),
                archive_path=str(archive),
                scope_key=binding.scope_key,
                acl_bindings=binding.as_dict(),
            )
            append_tombstone_to_registry(root, "agent-a", {**attempted, "status": "attempted"})

            dry = repair_tombstones(root, "agent-a", card_lookup=lambda _row: current)
            self.assertTrue(dry["ok"])
            self.assertEqual(dry["planned"], [attempted["tombstoneId"]])
            self.assertEqual(
                [row["status"] for row in read_tombstones_from_registry(root, "agent-a")],
                ["attempted"],
            )

            applied = repair_tombstones(
                root, "agent-a", apply=True, card_lookup=lambda _row: current
            )
            self.assertTrue(applied["ok"])
            self.assertEqual(applied["reconstructed"], [attempted["tombstoneId"]])
            repeated = repair_tombstones(
                root, "agent-a", apply=True, card_lookup=lambda _row: current
            )
            self.assertTrue(repeated["ok"])
            self.assertEqual(repeated["reconstructed"], [])
            self.assertIn(attempted["tombstoneId"], repeated["alreadyCommitted"])

            registry = root / "_tombstones" / "agent-a.jsonl"
            registry.write_text(registry.read_text(encoding="utf-8") + "{broken\n", encoding="utf-8")
            corrupt = repair_tombstones(
                root, "agent-a", apply=True, card_lookup=lambda _row: current
            )
            self.assertFalse(corrupt["ok"])
            self.assertTrue(corrupt["errors"])


class ScopeJobSecurityTests(unittest.TestCase):
    def _row(self, memory_id: str, binding, text: str) -> dict:
        return {
            "id": memory_id,
            "agentId": binding.agent_id,
            "scopeKey": binding.scope_key,
            "scopeType": binding.scope_type,
            "aclBindings": binding.as_dict(),
            "content": text,
            "status": "active",
            "type": "observation",
            "vector": [1.0, 0.0],
        }

    def test_capture_turn_forwards_the_runtime_scope_to_the_journal(self) -> None:
        binding = binding_from_scope(
            "agent-a", {"scopeType": "user", "platform": "telegram", "userId": "u-1"}
        )
        runtime = object.__new__(Plur1busRuntime)
        calls = []
        runtime.scope_binding = binding
        runtime._domain = type("Domain", (), {
            "on_turn": lambda _self, *args, **kwargs: calls.append((args, kwargs)),
        })()
        runtime._remember = lambda *args: None

        runtime._capture_turn("hello", "world", "session")

        self.assertEqual(calls[0][1]["acl_bindings"], binding.as_dict())

    def test_consolidation_paginates_and_commits_cursor_after_success_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binding = binding_from_scope("agent-a")
            domain = Plur1busDomain(
                root, "agent-a", {"maintenance": {"consolidationPageSize": 1}}
            )
            domain.run_dynamics = lambda **_kwargs: {"changed": 0}
            table = _Table([
                self._row(MEMORY_A, binding, "same"),
                self._row(MEMORY_B, binding, "same"),
            ])

            first = domain.run_consolidation(table)
            second = domain.run_consolidation(table)

            self.assertFalse(first["complete"])
            self.assertTrue(second["complete"])
            self.assertEqual(second["cardsScanned"], 2)
            self.assertEqual(second["duplicateGroups"], [[MEMORY_A, MEMORY_B]])
            self.assertTrue(any("OFFSET" not in clause.upper() for clause in table.where_clauses))

            failing = Plur1busDomain(root / "failure", "agent-a")
            failing._append_jsonl = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk"))
            with self.assertRaises(OSError):
                failing.run_dreaming(_Table([self._row(MEMORY_A, binding, "dream")]))
            self.assertFalse(
                (failing.state_dir / "job-cursors" / "rem-dream.json").exists()
            )

    def test_two_user_scopes_have_distinct_dream_outputs_and_job_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = binding_from_scope(
                "agent-a", {"scopeType": "user", "platform": "telegram", "userId": "u-1"}
            )
            second = binding_from_scope(
                "agent-a", {"scopeType": "user", "platform": "telegram", "userId": "u-2"}
            )
            domain = Plur1busDomain(root, "agent-a")
            domain.run_dreaming(_Table([self._row(MEMORY_A, first, "first")]), acl_bindings=first.as_dict())
            domain.run_dreaming(_Table([self._row(MEMORY_B, second, "second")]), acl_bindings=second.as_dict())

            first_neo = domain._scope_neo_dir(domain._scope_selector(acl_bindings=first.as_dict()))
            second_neo = domain._scope_neo_dir(domain._scope_selector(acl_bindings=second.as_dict()))
            self.assertNotEqual(first_neo, second_neo)
            self.assertTrue((first_neo / "dream-diary.jsonl").is_file())
            self.assertTrue((second_neo / "dream-diary.jsonl").is_file())
            self.assertFalse((domain.neo_dir / "dream-diary.jsonl").exists())
            domain.rebuild_indexes(_Table([]), acl_bindings=first.as_dict())
            domain.rebuild_indexes(_Table([]), acl_bindings=second.as_dict())
            first_workspace = domain._scope_workspace_dir(
                domain._scope_selector(acl_bindings=first.as_dict())
            )
            second_workspace = domain._scope_workspace_dir(
                domain._scope_selector(acl_bindings=second.as_dict())
            )
            self.assertTrue((first_workspace / ".plur1bus/link-index.json").is_file())
            self.assertTrue((second_workspace / ".plur1bus/link-index.json").is_file())

    def test_rate_gate_rejects_corrupt_state_and_does_not_commit_partial_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "gate.json"
            partial = JobRateGate(path).run(
                "job", 100, lambda: {"complete": False, "selected": 1}, now=10
            )
            self.assertFalse(partial["complete"])
            self.assertFalse(path.exists())
            path.write_text("{broken", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                JobRateGate(path).run("job", 100, lambda: {}, now=20)

    def test_owner_bound_job_reports_do_not_collide(self) -> None:
        class Domain:
            def run_dynamics(self, **_kwargs): return {"complete": False}
            def proactive_check(self): return {}
            def run_afterthought(self): return {}
            def due_reminders(self, **_kwargs): return []

        class Runtime:
            def __init__(self, *_args): self._domain = Domain()
            def _table(self, create=False): return object(), False
            def shutdown(self, timeout_seconds=5): return None

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = run_jobs(root, {}, "agent-a", "hourly", runtime_factory=Runtime, scope_key="scope-a")
            second = run_jobs(root, {}, "agent-a", "hourly", runtime_factory=Runtime, scope_key="scope-b")
            self.assertEqual(first["status"], "partial")
            self.assertEqual(second["status"], "partial")
            reports = list((root / "state" / "agent-a" / "scopes").glob("*/maintenance-hourly.json"))
            self.assertEqual(len(reports), 2)


class MutationVerificationSecurityTests(unittest.TestCase):
    def _critical_card(self, binding) -> dict:
        return {
            "id": MEMORY_A,
            "agentId": "agent-a",
            "scopeKey": binding.scope_key,
            "scopeType": binding.scope_type,
            "ownerPlatform": binding.platform,
            "ownerUser": binding.user,
            "aclBindings": binding.as_dict(),
            "content": "critical fact",
            "status": "active",
            "type": "person",
            "confirmed": 0,
            "createdAt": 1,
        }

    def test_critical_review_does_not_audit_a_noop_update(self) -> None:
        class Field:
            name = "confirmed"

        class Table:
            def schema(self): return type("Schema", (), {"fields": [Field()]})()
            def update(self, **_kwargs): return None

        with tempfile.TemporaryDirectory() as temporary:
            binding = binding_from_scope(
                "agent-a", {"scopeType": "user", "platform": "telegram", "userId": "u-1"}
            )
            domain = Plur1busDomain(Path(temporary), "agent-a")
            card = self._critical_card(binding)
            domain._memory_rows = lambda: [dict(card)]
            domain._metadata_rows = lambda: []
            domain._memory_table = lambda: Table()
            audited = []
            domain.audit_mutation = audited.append

            result = domain.review_critical(
                MEMORY_A, "accept", acl_bindings=binding.as_dict()
            )

            self.assertFalse(result["updated"])
            self.assertEqual(result["reason"], "card-update-unverified")
            self.assertEqual(audited, [])

    def test_forget_does_not_commit_or_audit_a_noop_soft_delete(self) -> None:
        class NoopTable(_Table):
            def update(self, *, where: str, values: dict):
                self.where_clauses.append(where)
                return None

        class Domain:
            def __init__(self): self.audit = []
            def audit_mutation(self, entry): self.audit.append(entry)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binding = binding_from_scope("agent-a")
            card = {
                "id": MEMORY_A,
                "agentId": "agent-a",
                "scopeKey": binding.scope_key,
                "scopeType": "agent-private",
                "content": "must remain protected",
                "status": "active",
            }
            runtime = object.__new__(Plur1busRuntime)
            runtime.data_dir = root
            runtime.agent_id = "agent-a"
            runtime.request_scope = {}
            runtime.scope_binding = binding
            runtime.scope_key = binding.scope_key
            runtime._domain = Domain()
            runtime._table = lambda create, first_record=None: (NoopTable([card]), False)

            self.assertFalse(runtime.forget(MEMORY_A))
            self.assertEqual(
                [row["status"] for row in read_tombstones_from_registry(root, "agent-a")],
                ["attempted", "failed"],
            )
            self.assertEqual(runtime._domain.audit, [])

    def test_critical_table_uses_the_configured_writer_namespace(self) -> None:
        opened = []

        class Database:
            def table_names(self): return ["memories"]
            def open_table(self, name): return {"name": name}

        fake_lancedb = type("LanceDb", (), {
            "connect": staticmethod(lambda path: opened.append(Path(path)) or Database())
        })
        with tempfile.TemporaryDirectory() as temporary, patch.dict(
            sys.modules, {"lancedb": fake_lancedb}
        ):
            root = Path(temporary)
            domain = Plur1busDomain(root, "agent-a", {
                "namespaces": {
                    "activeWriteNamespace": "current",
                    "activeRecallNamespaces": ["current"],
                    "legacyReadOnlyNamespaces": [],
                }
            })
            self.assertEqual(domain._memory_table(), {"name": "memories"})
            self.assertEqual(
                opened,
                [root / "lancedb-namespaces" / "current" / "agent-a"],
            )

    def test_gc_same_uuid_is_scope_partitioned_and_committed_audit_is_verified(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            domain = Plur1busDomain(root, "agent-a")
            bindings = [
                binding_from_scope(
                    "agent-a", {"scopeType": "user", "platform": "telegram", "userId": user}
                )
                for user in ("u-1", "u-2")
            ]
            archive_paths = []
            for index, binding in enumerate(bindings):
                card = {
                    "id": MEMORY_A,
                    "agentId": "agent-a",
                    "scopeKey": binding.scope_key,
                    "scopeType": "user",
                    "ownerPlatform": "telegram",
                    "ownerUser": binding.user,
                    "aclBindings": binding.as_dict(),
                    "content": f"expired-{index}",
                    "status": "active",
                }
                metadata = {
                    "scopeKey": binding.scope_key,
                    "aclBindings": binding.as_dict(),
                    "expiresAt": 1,
                }
                domain._metadata_rows = lambda metadata=metadata: [{
                    "id": MEMORY_A,
                    "scopeKey": binding.scope_key,
                    "metadataJson": json.dumps(metadata),
                }]
                result = domain.run_gc(
                    _Table([card]), now_ms=2, acl_bindings=binding.as_dict()
                )
                self.assertEqual(result["count"], 1)
                archive_paths.append(
                    archive_path_for(root, "agent-a", binding.scope_key, MEMORY_A)
                )
                selector = domain._scope_selector(acl_bindings=binding.as_dict())
                audit = domain._read_jsonl(
                    domain._scope_state_dir(selector) / "destructive-operations.jsonl"
                )
                self.assertEqual([row["result"] for row in audit], ["attempted", "committed"])
            self.assertNotEqual(archive_paths[0], archive_paths[1])
            self.assertTrue(all(path.is_file() for path in archive_paths))
            self.assertFalse((domain.state_dir / "destructive-operations.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
