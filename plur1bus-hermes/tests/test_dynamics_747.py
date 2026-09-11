"""7.12.47 native bounded and scope-safe dynamics coverage."""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import lancedb

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.namespaces import (
    binding_from_scope,
    legacy_agent_private_scope_key,
)


class Dynamics747Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.owner = binding_from_scope("main", {"scopeType": "workspace", "workspace": "owner"})
        self.foreign = binding_from_scope("main", {"scopeType": "workspace", "workspace": "foreign"})
        self.now = 1_800_000_000_000

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _row(self, memory_id: str, binding, **metadata_changes):
        metadata = {
            "scopeKey": binding.scope_key,
            "aclBindings": binding.as_dict(),
            "status": "active",
            "memoryStrength": 1.0,
            "halfLifeDays": 30,
            "lastDynamicsAt": self.now - 86_400_000,
            "privateIrrelevantWorkspace": "must-not-grant-authority",
            "escapeText": "O'Brien\\path\nGrüße",
            **metadata_changes,
        }
        return {
            "id": memory_id,
            "agentId": "main",
            "scopeKey": binding.scope_key,
            "opaqueColumn": f"opaque-{memory_id}",
            "metadataJson": json.dumps(metadata, sort_keys=True),
        }

    def _create(self, rows):
        return lancedb.connect(str(self.root / "lancedb" / "main")).create_table(
            "metadata", data=rows
        )

    def _all(self):
        return lancedb.connect(str(self.root / "lancedb" / "main")).open_table(
            "metadata"
        ).to_arrow().to_pylist()

    def _all_at(self, path: Path):
        return lancedb.connect(str(path)).open_table("metadata").to_arrow().to_pylist()

    def test_legacy_private_rows_are_decay_eligible_and_keep_legacy_cas_key(self):
        """Pre-Hermes private rows remain writable during compatibility reads."""
        memory_id = str(uuid.uuid4())
        legacy_key = legacy_agent_private_scope_key()
        row = {
            "id": memory_id,
            "agentId": "main",
            "scopeKey": legacy_key,
            "opaqueColumn": "legacy-private",
            "metadataJson": json.dumps({
                "scopeKey": legacy_key,
                "status": "active",
                "memoryStrength": 1.0,
                "halfLifeDays": 30,
                "lastDynamicsAt": self.now - 86_400_000,
                "escapeText": "legacy private",
            }, sort_keys=True),
        }
        self._create([row])
        domain = Plur1busDomain(self.root, "main")
        with patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            result = domain.run_dynamics()
        self.assertEqual(result["changed"], 1)
        updated = self._all()[0]
        self.assertEqual(updated["scopeKey"], legacy_key)
        self.assertNotEqual(updated["metadataJson"], row["metadataJson"])

    def test_dynamics_uses_configured_writer_namespace_metadata_path(self):
        """Dynamics must mutate the resolved writer namespace, not the legacy default path."""
        writer_path = self.root / "lancedb-namespaces" / "writer" / "main"
        writer_path.parent.mkdir(parents=True)
        row = self._row(str(uuid.uuid4()), self.owner)
        lancedb.connect(str(writer_path)).create_table("metadata", data=[row])
        config = {
            "namespaces": {
                "activeWriteNamespace": "writer",
                "activeRecallNamespaces": ["writer"],
            },
            "dailyConsolidation": {"dynamicsDecayMaxRows": 3, "decayMode": "batch"},
        }
        domain = Plur1busDomain(self.root, "main", config, metadata_path=writer_path)
        with patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            result = domain.run_dynamics(acl_bindings=self.owner.as_dict())
        self.assertEqual(result["changed"], 1)
        self.assertNotEqual(self._all_at(writer_path)[0]["metadataJson"], row["metadataJson"])
        self.assertFalse((self.root / "lancedb" / "main").exists())

    def test_real_batch_is_one_commit_bounded_resumable_and_preserves_foreign_full_rows(self):
        owned_ids = sorted(str(uuid.uuid4()) for _ in range(3))
        foreign_id = str(uuid.uuid4())
        table = self._create([
            *(self._row(memory_id, self.owner) for memory_id in owned_ids),
            self._row(foreign_id, self.foreign),
        ])
        foreign_before = next(row for row in self._all() if row["id"] == foreign_id)
        version_before = table.version
        domain = Plur1busDomain(self.root, "main", {
            "dailyConsolidation": {"dynamicsDecayMaxRows": 2, "decayMode": "batch"}
        })

        with patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            first = domain.run_dynamics(acl_bindings=self.owner.as_dict())
        version_after_first = lancedb.connect(
            str(self.root / "lancedb" / "main")
        ).open_table("metadata").version
        with patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            second = domain.run_dynamics(acl_bindings=self.owner.as_dict())

        self.assertEqual(first["mode"], "batch")
        self.assertEqual(first["changed"], 2)
        self.assertFalse(first["complete"])
        self.assertTrue(first["truncated"])
        self.assertEqual(version_after_first - version_before, 1, "one page must be one Lance commit")
        self.assertEqual(second["changed"], 1)
        self.assertTrue(second["complete"])
        self.assertIsNone(second["nextCursor"])
        self.assertEqual(next(row for row in self._all() if row["id"] == foreign_id), foreign_before)
        self.assertTrue(all(row["opaqueColumn"] == f"opaque-{row['id']}" for row in self._all()))
        for memory_id in owned_ids:
            metadata = json.loads(next(row for row in self._all() if row["id"] == memory_id)["metadataJson"])
            self.assertEqual(metadata["escapeText"], "O'Brien\\path\nGrüße")

    def test_core_inactive_invalidated_and_foreign_embedded_binding_are_never_mutated(self):
        ids = [str(uuid.uuid4()) for _ in range(5)]
        rows = [
            self._row(ids[0], self.owner, memoryClass="core"),
            self._row(ids[1], self.owner, neverForget=True),
            self._row(ids[2], self.owner, status="archived"),
            self._row(ids[3], self.owner, epistemicStatus="invalidated"),
            self._row(ids[4], self.owner, aclBindings=self.foreign.as_dict()),
        ]
        self._create(rows)
        before = {row["id"]: row for row in self._all()}
        result = Plur1busDomain(self.root, "main").run_dynamics(
            acl_bindings=self.owner.as_dict()
        )
        after = {row["id"]: row for row in self._all()}
        self.assertEqual(after, before)
        self.assertEqual(result["changed"], 0)
        self.assertEqual(result["skipped"], 5)

    def test_rows_mode_preserves_progress_after_partial_row_failure(self):
        owned_ids = sorted(str(uuid.uuid4()) for _ in range(3))
        self._create([self._row(memory_id, self.owner) for memory_id in owned_ids])
        domain = Plur1busDomain(self.root, "main", {
            "dailyConsolidation": {"dynamicsDecayMaxRows": 3, "decayMode": "rows"}
        })
        table = domain._metadata_table()
        original_update = table.update
        calls = 0

        def fail_second(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("injected row failure")
            return original_update(*args, **kwargs)

        table.update = fail_second
        domain._metadata_table = lambda: table
        with patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            result = domain.run_dynamics(acl_bindings=self.owner.as_dict())
        self.assertFalse(result["complete"])
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["changed"], 1)
        self.assertEqual(result["nextCursor"], owned_ids[0])

    def test_after_commit_exception_is_reconciled_without_replaying_the_page(self):
        ids = sorted(str(uuid.uuid4()) for _ in range(2))
        self._create([self._row(memory_id, self.owner) for memory_id in ids])
        domain = Plur1busDomain(self.root, "main")
        table = domain._metadata_table()
        original_merge = table.merge_insert

        class LateFailureBuilder:
            def __init__(self, inner):
                self.inner = inner

            def when_matched_update_all(self, **kwargs):
                self.inner = self.inner.when_matched_update_all(**kwargs)
                return self

            def execute(self, rows):
                self.inner.execute(rows)
                raise RuntimeError("injected after-commit failure")

        table.merge_insert = lambda columns: LateFailureBuilder(original_merge(columns))
        domain._metadata_table = lambda: table
        with patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            failed = domain.run_dynamics(acl_bindings=self.owner.as_dict())
        prepared = domain._scope_state_dir(domain._scope_selector(
            acl_bindings=self.owner.as_dict()
        )) / "job-cursors/dynamics-decay-prepared.json"
        self.assertEqual(failed["reason"], "batch-write-failed")
        self.assertTrue(prepared.is_file())

        with patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            recovered = Plur1busDomain(self.root, "main").run_dynamics(
                acl_bindings=self.owner.as_dict()
            )
        self.assertEqual(recovered["reason"], "prepared-commit-reconciled")
        self.assertTrue(recovered["complete"])
        self.assertFalse(prepared.exists())

    def test_real_partial_cas_count_is_incomplete_and_restart_refuses_mixed_state(self):
        ids = sorted(str(uuid.uuid4()) for _ in range(2))
        self._create([self._row(memory_id, self.owner) for memory_id in ids])
        domain = Plur1busDomain(self.root, "main")
        table = domain._metadata_table()
        original_merge = table.merge_insert
        observed_counts = []

        class ConflictBuilder:
            def __init__(self, inner):
                self.inner = inner

            def when_matched_update_all(self, **kwargs):
                self.inner = self.inner.when_matched_update_all(**kwargs)
                return self

            def execute(self, rows):
                external = lancedb.connect(str(self_root / "lancedb" / "main")).open_table("metadata")
                external.update(where=f"id = '{ids[1]}'", values={"metadataJson": "{\"external\":true}"})
                merge_result = self.inner.execute(rows)
                observed_counts.append(merge_result.num_updated_rows)
                return merge_result

        self_root = self.root
        table.merge_insert = lambda columns: ConflictBuilder(original_merge(columns))
        domain._metadata_table = lambda: table
        with patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            partial = domain.run_dynamics(acl_bindings=self.owner.as_dict())
        self.assertEqual(observed_counts, [1])
        self.assertEqual(partial["reason"], "batch-cas-conflict")
        self.assertFalse(partial["complete"])

        with patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            restart = Plur1busDomain(self.root, "main").run_dynamics(
                acl_bindings=self.owner.as_dict()
            )
        self.assertEqual(restart["reason"], "prepared-state-uncertain")
        self.assertFalse(restart["complete"])

    def test_corrupt_cursor_and_deadline_fail_closed_before_mutation(self):
        memory_id = str(uuid.uuid4())
        table = self._create([self._row(memory_id, self.owner)])
        domain = Plur1busDomain(self.root, "main")
        state = domain._scope_state_dir(domain._scope_selector(
            acl_bindings=self.owner.as_dict()
        )) / "job-cursors"
        state.mkdir(parents=True)
        (state / "dynamics-decay.json").write_text("not-json", encoding="utf-8")
        before = table.version
        invalid = domain.run_dynamics(acl_bindings=self.owner.as_dict())
        self.assertEqual(invalid["reason"], "invalid-dynamics-state")
        self.assertEqual(table.version, before)

        (state / "dynamics-decay.json").unlink()
        deadline_domain = Plur1busDomain(self.root, "main", {
            "dailyConsolidation": {"dynamicsDecayDeadlineMs": 1}
        })
        clock_calls = 0

        def fake_monotonic():
            nonlocal clock_calls
            clock_calls += 1
            return 0.0 if clock_calls == 1 else 1.0

        with patch("plur1bus_hermes.domain.time.monotonic", side_effect=fake_monotonic), \
                patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            deadline = deadline_domain.run_dynamics(acl_bindings=self.owner.as_dict())
        self.assertTrue(deadline["deadlineHit"])
        self.assertEqual(lancedb.connect(str(self.root / "lancedb/main")).open_table("metadata").version, before)


if __name__ == "__main__":
    unittest.main()
