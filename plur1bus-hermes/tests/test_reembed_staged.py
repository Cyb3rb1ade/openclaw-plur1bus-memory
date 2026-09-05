from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.reembed_staged import (
    apply_staged_reembed,
    plan_staged_reembed,
    validate_staged_reembed,
)


class _Arrow:
    def __init__(self, rows): self.rows = rows
    def to_pylist(self): return list(self.rows)


class _Table:
    def __init__(self, rows): self.rows = rows
    def to_arrow(self): return _Arrow(self.rows)
    def add(self, rows): self.rows.extend(rows)


class _Database:
    def __init__(self, tables): self.tables = tables
    def open_table(self, name): return self.tables[name]
    def create_table(self, name, data):
        self.tables[name] = _Table(list(data))
        return self.tables[name]


class _Backend:
    calls = 0
    def __init__(self, _config, _home): pass
    def embed(self, text):
        type(self).calls += 1
        return [float(len(text)), 1.0]
    def close(self): pass


class StagedReembedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "lancedb" / "default"
        self.source.mkdir(parents=True)
        self.rows = [
            {"id": "a", "content": "one", "vector": [0.0]},
            {"id": "b", "content": "two", "vector": [0.0]},
        ]
        self.databases = {str(self.source.resolve()): _Database({"memories": _Table(self.rows)})}
        self.config = {"embedding": {"provider": "test", "model": "m", "dimensions": 2}}
        _Backend.calls = 0

    def tearDown(self): self.temp.cleanup()

    def _connect(self, path):
        return self.databases.setdefault(path, _Database({}))

    def test_plan_is_read_only_and_excludes_credential_values(self):
        self.config["embedding"]["apiKey"] = "do-not-leak"
        plan = plan_staged_reembed(self.root, "default", self.config, connect=self._connect)
        self.assertEqual(_Backend.calls, 0)
        self.assertEqual(plan["completion"], "planned")
        self.assertNotIn("apiKey", str(plan))
        self.assertFalse(Path(plan["targetRoute"]).exists())

    def test_empty_source_is_not_reported_as_a_completed_stage(self):
        self.rows.clear()
        with self.assertRaisesRegex(Exception, "empty"):
            plan_staged_reembed(self.root, "default", self.config, connect=self._connect)
        self.assertEqual(_Backend.calls, 0)

    def test_apply_is_bounded_resumable_and_never_active(self):
        plan = plan_staged_reembed(self.root, "default", self.config, connect=self._connect)
        first = apply_staged_reembed(plan, self.root, "default", self.config, batch_size=1, connect=self._connect, backend_factory=_Backend)
        self.assertEqual(first["completion"], "in_progress")
        self.assertFalse(first["active"])
        second = apply_staged_reembed(plan, self.root, "default", self.config, batch_size=1, connect=self._connect, backend_factory=_Backend)
        self.assertEqual(second["completion"], "staged")
        checked = validate_staged_reembed(plan, self.root, "default", self.config, connect=self._connect)
        self.assertTrue(checked["validated"])
        self.assertFalse(checked["active"])

    def test_resume_fails_closed_when_pinned_source_changes(self):
        plan = plan_staged_reembed(self.root, "default", self.config, connect=self._connect)
        self.rows[0]["content"] = "changed"
        with self.assertRaisesRegex(Exception, "source table changed"):
            apply_staged_reembed(plan, self.root, "default", self.config, connect=self._connect, backend_factory=_Backend)

    def test_semantic_target_change_and_fallback_are_not_resumable(self):
        self.config["embedding"]["baseUrl"] = "https://one.invalid"
        plan = plan_staged_reembed(self.root, "default", self.config, connect=self._connect)
        changed = {**self.config, "embedding": {**self.config["embedding"], "baseUrl": "https://two.invalid"}}
        with self.assertRaisesRegex(Exception, "plan does not match"):
            apply_staged_reembed(plan, self.root, "default", changed, connect=self._connect, backend_factory=_Backend)
        with self.assertRaisesRegex(Exception, "does not permit embedding fallbacks"):
            plan_staged_reembed(self.root, "default", {"embedding": {**self.config["embedding"], "fallback": {}}}, connect=self._connect)

    def test_source_change_during_embedding_blocks_target_write_and_validation(self):
        plan = plan_staged_reembed(self.root, "default", self.config, connect=self._connect)

        rows = self.rows
        class ChangingBackend(_Backend):
            def embed(self, text):
                rows[0]["content"] = "changed-during-inference"
                return super().embed(text)

        with self.assertRaisesRegex(Exception, "source table changed"):
            apply_staged_reembed(plan, self.root, "default", self.config, connect=self._connect, backend_factory=ChangingBackend)
        with self.assertRaisesRegex(Exception, "source table changed"):
            validate_staged_reembed(plan, self.root, "default", self.config, connect=self._connect)

    def test_nonfinite_vectors_are_rejected_before_target_write(self):
        class BadBackend(_Backend):
            def embed(self, _text): return [float("nan"), 1.0]
        plan = plan_staged_reembed(self.root, "default", self.config, connect=self._connect)
        with self.assertRaisesRegex(Exception, "non-finite"):
            apply_staged_reembed(plan, self.root, "default", self.config, connect=self._connect, backend_factory=BadBackend)

    def test_tampered_plan_id_or_target_symlink_fails_closed(self):
        plan = plan_staged_reembed(self.root, "default", self.config, connect=self._connect)
        unsafe = dict(plan)
        unsafe["planId"] = "../outside"
        with self.assertRaisesRegex(Exception, "plan id"):
            apply_staged_reembed(unsafe, self.root, "default", self.config, connect=self._connect, backend_factory=_Backend)
        target = Path(plan["targetRoute"])
        target.symlink_to(self.root)
        with self.assertRaisesRegex(Exception, "target is unsafe"):
            apply_staged_reembed(plan, self.root, "default", self.config, connect=self._connect, backend_factory=_Backend)

    def test_real_lancedb_preserves_acl_struct_schema(self):
        import lancedb
        import pyarrow as pa

        root = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        source = root / "lancedb" / "default"
        source.mkdir(parents=True)
        schema = pa.schema([
            pa.field("id", pa.string()), pa.field("content", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), 1)),
            pa.field("aclBindings", pa.struct([pa.field("agentId", pa.string()), pa.field("scopeKey", pa.string())])),
        ])
        data = pa.Table.from_pylist([{"id": "a", "content": "one", "vector": [0.0], "aclBindings": {"agentId": "default", "scopeKey": ""}}], schema=schema)
        lancedb.connect(str(source)).create_table("memories", data=data)
        plan = plan_staged_reembed(root, "default", self.config)
        result = apply_staged_reembed(plan, root, "default", self.config, connect=None, backend_factory=_Backend)
        self.assertEqual(result["completion"], "staged")
        target_table = lancedb.connect(plan["targetRoute"]).open_table("memories")
        self.assertTrue(pa.types.is_struct(target_table.schema.field("aclBindings").type))


if __name__ == "__main__":
    unittest.main()
