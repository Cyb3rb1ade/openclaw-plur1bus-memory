"""LLM cognition features remain opt-in and store derived records only."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import lancedb

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.namespaces import binding_from_scope


MEMORY_ID = "619c3d51-1d9d-4736-8bf9-91b38aff8246"


class _Backend:
    def available(self):
        return True

    def complete_json(self, purpose, _system, _user):
        if purpose == "light-dream":
            return {"insights": ["A tentative recurring planning theme."]}
        if purpose == "meta-reflection":
            return {"observation": "Feedback coverage is still limited."}
        if purpose == "reminder-extraction":
            return {"reminders": [{"dueAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(), "text": "Review migration"}]}
        return {}


class OptInLlmCognitionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.binding = binding_from_scope("main")
        database = lancedb.connect(str(self.root / "lancedb" / "main"))
        database.create_table("metadata", data=[{
            "id": MEMORY_ID, "agentId": "main", "scopeKey": self.binding.scope_key,
            "metadataJson": json.dumps({"scopeKey": self.binding.scope_key, "aclBindings": self.binding.as_dict(), "text": "Review migration"}),
        }])

    def tearDown(self):
        self.temporary.cleanup()

    def test_light_dream_and_llm_reflection_are_explicit_and_non_memory(self):
        disabled = Plur1busDomain(self.root, "main")
        disabled.set_llm_backend(_Backend())
        self.assertEqual(disabled.run_light_dream()["reason"], "disabled")
        domain = Plur1busDomain(self.root, "main", {"lightDream": {"enabled": True}, "metaCognition": {"enabled": True}})
        domain.set_llm_backend(_Backend())
        path = domain.neo_dir / "episodes.jsonl"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"scopeKey": self.binding.scope_key, "summary": "Plan a safe migration", "emotionalDominant": "trust"}) + "\n", encoding="utf-8")
        self.assertTrue(domain.run_light_dream()["executed"])
        self.assertTrue(domain.run_llm_meta_reflection()["executed"])
        self.assertFalse((domain.neo_dir / "memory-cognition.jsonl").exists())

    def test_extraction_is_pending_then_requires_existing_scoped_card(self):
        domain = Plur1busDomain(self.root, "main", {"reminders": {"autoExtract": True}})
        domain.set_llm_backend(_Backend())
        proposed = domain.extract_reminder_proposals("Please remind me", "Sure", "session-a")
        self.assertEqual(len(proposed["proposed"]), 1)
        result = domain.confirm_reminder_proposal(proposed["proposed"][0]["proposalId"], MEMORY_ID)
        self.assertTrue(result["created"])
        self.assertEqual(domain.extract_reminder_proposals("Please remind me", "Sure", "session-a")["reason"], "duplicate-turn")


if __name__ == "__main__":
    unittest.main()
