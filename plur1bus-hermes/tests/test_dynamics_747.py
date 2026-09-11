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
from plur1bus_hermes.namespaces import binding_from_scope


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
        version_after_first = table.version
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


if __name__ == "__main__":
    unittest.main()
