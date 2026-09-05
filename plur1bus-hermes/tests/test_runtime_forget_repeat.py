"""Repeat-forget recovery must verify, never overwrite, the active-source archive."""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path

from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.tombstone import archive_path_for


class RepeatForgetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.runtime = Plur1busRuntime(self.root, {"embedding": {"dimensions": 2}}, "main")
        self.runtime._embedding.embed = lambda _text, purpose="passage": [0.1, 0.2]  # type: ignore[method-assign]
        self.runtime._domain.on_memory = lambda _record, _table, **_kwargs: None  # type: ignore[method-assign]

    def tearDown(self) -> None:
        self.runtime.shutdown()
        self.temporary.cleanup()

    def _row(self, identifier: str) -> dict:
        table, _ = self.runtime._table(create=False)
        return table.search().where(f"id = '{identifier}'").limit(1).to_list()[0]

    def test_repeat_forget_backfills_without_archive_collision(self) -> None:
        identifier = self.runtime._remember("repeat-safe memory", "s", "user")
        self.assertTrue(self.runtime.forget(str(identifier)))
        archive = archive_path_for(self.root, "main", self.runtime.scope_key, str(identifier))
        original = json.loads(archive.read_text(encoding="utf-8"))
        self.assertEqual(original["status"], "active")
        self.assertTrue(self.runtime.forget(str(identifier)))
        self.assertEqual(json.loads(archive.read_text(encoding="utf-8")), original)
        self.assertEqual(self._row(str(identifier))["status"], "deleted")

    def test_mismatched_archive_fails_closed_and_foreign_row_is_not_deleted(self) -> None:
        identifier = self.runtime._remember("archive-identity memory", "s", "user")
        self.assertTrue(self.runtime.forget(str(identifier)))
        archive = archive_path_for(self.root, "main", self.runtime.scope_key, str(identifier))
        tampered = json.loads(archive.read_text(encoding="utf-8"))
        tampered["content"] = "different archive content"
        archive.write_text(json.dumps(tampered), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "archive identity/content"):
            self.runtime.forget(str(identifier))
        self.assertEqual(self._row(str(identifier))["status"], "deleted")

        table, _ = self.runtime._table(create=False)
        foreign = dict(self._row(str(identifier)))
        foreign.update({"id": str(uuid.uuid4()), "scopeKey": "foreign-scope", "status": "active", "content": "foreign"})
        table.add([foreign])
        self.assertFalse(self.runtime.forget(foreign["id"]))
        self.assertEqual(self._row(foreign["id"])["status"], "active")

    def test_missing_original_archive_prevents_repeat_recovery(self) -> None:
        identifier = str(self.runtime._remember("archive must stay available", "s", "user"))
        self.assertTrue(self.runtime.forget(identifier))
        self.assertTrue(self.runtime.forget(identifier))
        archive = archive_path_for(self.root, "main", self.runtime.scope_key, identifier)
        archive.unlink()
        with self.assertRaisesRegex(RuntimeError, "archive is missing"):
            self.runtime.forget(identifier)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
