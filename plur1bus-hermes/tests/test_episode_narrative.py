import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from plur1bus_hermes.episode_narrative import group_turns, enrich, enrichment_key
from plur1bus_hermes.runtime import Plur1busRuntime


class EpisodeNarrativeTests(unittest.TestCase):
    def turns(self, count=6):
        return [{"id": str(index), "sessionId": "s", "role": "user",
                 "content": f"fact {index}", "createdAt": (
                     datetime(2026, 9, 1, tzinfo=timezone.utc) + timedelta(minutes=index)
                 ).isoformat()} for index in range(count)]

    @staticmethod
    def completion(_purpose, _system, payload):
        return {"title": "Discussion", "summary": "Tentative narrative.",
                "narrativeArc": "exploration", "turningPoint": "",
                "evidenceTurnIds": [row["id"] for row in json.loads(payload)]}

    def test_group_gap_size_and_session_boundaries(self):
        self.assertEqual([len(group) for group in group_turns(self.turns(51))], [50, 1])
        turns = self.turns()
        turns[-1]["sessionId"] = "separate"
        self.assertEqual([len(group) for group in group_turns(turns)], [5, 1])
        turns = self.turns()
        turns[-1]["createdAt"] = "2026-09-02T00:00:00+00:00"
        self.assertEqual([len(group) for group in group_turns(turns)], [5, 1])

    def test_short_unknown_evidence_and_changed_content(self):
        self.assertIsNone(enrich(self.turns(4), lambda *_: self.fail("short group used LLM")))
        def forged(*args):
            return {**self.completion(*args), "evidenceTurnIds": ["foreign"]}
        self.assertIsNone(enrich(self.turns(), forged))
        turns = self.turns()
        before = enrichment_key(turns)
        turns[0]["content"] = "changed"
        self.assertNotEqual(before, enrichment_key(turns))

    def test_native_journal_is_scoped_idempotent_and_preserves_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Plur1busRuntime(Path(directory), {"episodes": {"llmNarrative": True}}, "main")
            try:
                domain = runtime._domain
                domain._llm_backend = SimpleNamespace(available=lambda: True, complete_json=self.completion)
                for index in range(3):
                    domain.on_turn(f"user fact {index}", f"assistant claim {index}", "session")
                domain._append_jsonl(domain.neo_dir / "turn-journal.jsonl", {
                    **self.turns()[0], "agentId": "other", "scopeKey": "foreign", "content": "secret",
                })
                first = domain.run_episode_narratives()
                self.assertTrue(first["executed"])
                self.assertFalse(domain.run_episode_narratives()["executed"])
                records = domain._read_jsonl(domain.neo_dir / "episode-narratives.jsonl")
                self.assertEqual(len(records), 1)
                self.assertEqual(len(records[0]["evidenceTurnIds"]), 6)
                self.assertFalse(records[0]["visibility"]["recallable"])
                self.assertEqual(len(domain._read_jsonl(domain.neo_dir / "episodes.jsonl")), 3)
                domain.on_turn("next user", "next assistant", "session")
                def unavailable(*_args):
                    raise TimeoutError("offline")
                domain._llm_backend.complete_json = unavailable
                self.assertFalse(domain.run_episode_narratives()["executed"])
                self.assertEqual(len(domain._read_jsonl(domain.neo_dir / "episode-narratives.jsonl")), 1)
            finally:
                runtime.shutdown()
