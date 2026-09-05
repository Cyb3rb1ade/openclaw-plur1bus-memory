import tempfile
import os
import unittest
from pathlib import Path
from plur1bus_hermes.source_sync import plan_source_sync, apply_source_sync


class SourceSyncTests(unittest.TestCase):
    def test_fifo_cannot_block_a_source_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            os.mkfifo(root / "pipe.md")
            with self.assertRaises(ValueError):
                plan_source_sync(root)

    def test_intermediate_symlink_invalidates_approval(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "source"
            nested = source / "nested"
            nested.mkdir(parents=True)
            (nested / "note.md").write_text("original")
            plan = plan_source_sync(source)
            nested.rename(root / "moved")
            nested.symlink_to(root / "moved", target_is_directory=True)
            with self.assertRaises(ValueError):
                apply_source_sync(None, plan, approved_revision=plan["revision"])

    def test_plan_is_bounded_read_only_and_ignores_hidden_or_symlink_sources(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()
            (root / "note.md").write_text("allowed")
            (root / ".secret.md").write_text("secret")
            (root / "alias.md").symlink_to(root / "note.md")
            plan = plan_source_sync(root)
            self.assertEqual([x["path"] for x in plan["files"]], ["note.md"])
            self.assertTrue(plan["dryRun"])
            with self.assertRaises(ValueError):
                plan_source_sync(root, max_bytes=1)

    def test_changed_revision_rejects_before_any_runtime_write(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()
            (root / "note.md").write_text("original")
            plan = plan_source_sync(root)
            (root / "note.md").write_text("changed")
            with self.assertRaises(ValueError):
                apply_source_sync(None, plan, approved_revision=plan["revision"])

    def test_real_lance_import_is_untrusted_and_idempotent(self):
        from plur1bus_hermes.runtime import Plur1busRuntime
        with tempfile.TemporaryDirectory() as d:
            source = Path(d).resolve() / "source"
            source.mkdir()
            (source / "note.md").write_text("A workspace claim is source data, not a user capture.")
            plan = plan_source_sync(source)
            runtime = Plur1busRuntime(Path(d)/"data", {"embedding":{"dimensions":2}}, "main")
            runtime._embedding.embed = lambda *a, **k: [1.0, 0.0]
            try:
                first = apply_source_sync(runtime, plan, approved_revision=plan["revision"])
                second = apply_source_sync(runtime, plan, approved_revision=plan["revision"])
                self.assertEqual(first["imported"], second["unchanged"])
                table, _ = runtime._table(create=False)
                rows = table.search().limit(10).to_list()
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["epistemicStatus"], "untrusted")
            finally:
                runtime.shutdown()
