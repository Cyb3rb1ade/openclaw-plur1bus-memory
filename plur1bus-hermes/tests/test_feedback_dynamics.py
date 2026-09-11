"""Feedback idempotence and zero-strength dynamics regressions."""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import lancedb

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.dynamics import MAX_CONSUMED_FEEDBACK_IDS, transform_metadata
from plur1bus_hermes.namespaces import binding_from_scope


class FeedbackDynamicsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.binding = binding_from_scope("main")
        self.now = 1_800_000_000_000
        self.ids = [str(uuid.uuid4()) for _ in range(3)]
        rows = [
            self._row(self.ids[0], strength=0.5),
            self._row(self.ids[1], strength=0.0),
            self._row(self.ids[2], strength=0.8),
        ]
        database = lancedb.connect(str(self.root / "lancedb" / "main"))
        database.create_table("metadata", data=rows)
        workspace = self.root / "profiles/main/workspace/.adaptive-learning"
        workspace.mkdir(parents=True)
        events = [
            self._feedback(self.ids[0], "useful", event_id="event-positive"),
            self._feedback(self.ids[1], "useful", event_id="event-zero"),
            self._feedback(self.ids[2], "incorrect"),
            self._feedback(self.ids[2], "incorrect"),
        ]
        (workspace / "feedback-log.jsonl").write_text(
            "".join(json.dumps(event, sort_keys=True) + "\n" for event in events),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _row(self, memory_id: str, *, strength: float) -> dict[str, object]:
        metadata = {
            "scopeKey": self.binding.scope_key,
            "aclBindings": self.binding.as_dict(),
            "status": "active",
            "memoryStrength": strength,
            "halfLifeDays": 30,
            "lastDynamicsAt": self.now,
            "unrelated": {"must": "survive"},
        }
        return {
            "id": memory_id,
            "agentId": "main",
            "scopeKey": self.binding.scope_key,
            "sourceAgent": "main",
            "originalId": memory_id,
            "legacyStatus": "",
            "metadataJson": json.dumps(metadata, sort_keys=True),
        }

    def _feedback(self, memory_id: str, value: str, *, event_id: str | None = None) -> dict[str, object]:
        event = {
            "memoryId": memory_id,
            "feedback": value,
            "agentId": "main",
            "scopeKey": self.binding.scope_key,
            "createdAt": "2026-09-11T00:00:00+00:00",
        }
        if event_id is not None:
            event["id"] = event_id
        return event

    def _metadata(self, memory_id: str) -> dict[str, object]:
        table = lancedb.connect(str(self.root / "lancedb" / "main")).open_table("metadata")
        row = table.search().where(f"id = '{memory_id}'").limit(1).to_list()[0]
        return json.loads(row["metadataJson"])

    def test_feedback_is_once_only_across_repeat_and_restart_and_zero_is_absorbing(self) -> None:
        with patch("plur1bus_hermes.domain._now_ms", return_value=self.now):
            first_result = Plur1busDomain(self.root, "main").run_dynamics()
            first = {memory_id: self._metadata(memory_id) for memory_id in self.ids}
            second_result = Plur1busDomain(self.root, "main").run_dynamics()
            second = {memory_id: self._metadata(memory_id) for memory_id in self.ids}

        self.assertTrue(first_result["complete"])
        self.assertTrue(second_result["complete"])
        self.assertAlmostEqual(first[self.ids[0]]["memoryStrength"], 0.6)
        self.assertEqual(first[self.ids[1]]["memoryStrength"], 0.0)
        self.assertAlmostEqual(first[self.ids[2]]["memoryStrength"], 0.3)
        self.assertEqual(second, first)
        self.assertEqual(len(first[self.ids[2]]["dynamicsConsumedFeedbackIds"]), 2)
        self.assertEqual(first[self.ids[0]]["unrelated"], {"must": "survive"})

    def test_feedback_identity_cap_never_trims_and_replays_old_entries(self) -> None:
        consumed = [f"event-{index}" for index in range(MAX_CONSUMED_FEEDBACK_IDS)]
        transformed = transform_metadata(
            {"memoryStrength": 0.5, "lastDynamicsAt": self.now,
             "dynamicsConsumedFeedbackIds": consumed},
            [("new-event", {"feedback": "positive"})],
            now_ms=self.now,
        )
        self.assertEqual(transformed["metadata"]["dynamicsConsumedFeedbackIds"], consumed)
        self.assertEqual(transformed["metadata"]["memoryStrength"], 0.5)
        self.assertTrue(transformed["feedbackCapReached"])
        self.assertEqual(transformed["skippedFeedback"], 1)


if __name__ == "__main__":
    unittest.main()
