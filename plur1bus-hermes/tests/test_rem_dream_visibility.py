"""Hermes parity for the 7.4.0 derived-record visibility contract (9aeb02d).

New dream records carry an unambiguous visibility/scope binding next to the
physical scope partition; readers stay bound to their own selector scope.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain


class _FakeTable:
    def __init__(self, rows):
        self._rows = rows

    class _Search:
        def __init__(self, rows):
            self._rows = rows

        def where(self, _clause):
            return self

        def limit(self, _count):
            return self

        def to_list(self):
            return list(self._rows)

    def search(self, *_args, **_kwargs):
        return self._Search(self._rows)


def _row(memory_id: str, agent: str = "main") -> dict:
    return {
        "id": memory_id,
        "agentId": agent,
        "scopeKey": "",
        "content": "wiederkehrendes muster mit vielen gleichen wörtern drin",
        "status": "active",
        "type": "observation",
        "sourceRole": "user",
        "createdAt": "2026-08-01T00:00:00+00:00",
        "vector": [0.1, 0.2],
    }


class RunDreamingVisibilityTests(unittest.TestCase):
    def test_dream_record_is_stamped_with_visibility(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            domain = Plur1busDomain(Path(directory), "main")
            dream = domain.run_dreaming(_FakeTable([_row("a")]))

        self.assertIn("visibility", dream)
        self.assertEqual(dream["visibility"]["scope"], "agent-private")
        self.assertEqual(dream["visibility"]["agentId"], "main")
        self.assertIn("workspaceIdentity", dream["visibility"])
        self.assertIn("ownerUserId", dream["visibility"])

    def test_workspace_scoped_dream_stamps_the_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            domain = Plur1busDomain(Path(directory), "main")
            dream = domain.run_dreaming(
                _FakeTable([_row("a")]),
                acl_bindings={
                    "agentId": "main",
                    "scopeType": "workspace",
                    "workspaceIdentity": "ws-1",
                },
            )

        self.assertEqual(dream["visibility"]["scope"], "workspace")
        self.assertEqual(dream["visibility"]["workspaceIdentity"], "ws-1")

    def test_dream_lands_only_in_the_own_scope_partition(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            domain = Plur1busDomain(root, "main")
            domain.run_dreaming(
                _FakeTable([_row("a")]),
                acl_bindings={
                    "agentId": "main",
                    "scopeType": "workspace",
                    "workspaceIdentity": "ws-1",
                },
            )
            private_diary = root / "profiles" / "main" / "workspace" / ".plur1bus" / "neo" / "dream-diary.jsonl"

        self.assertFalse(private_diary.exists())


if __name__ == "__main__":
    unittest.main()
