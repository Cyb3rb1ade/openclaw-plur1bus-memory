import json
import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain


class RecallOverlayTests(unittest.TestCase):
    def test_overlay_is_additive_and_surfaces_open_threads_and_contradictions(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            domain._append_jsonl(
                domain.neo_dir / "open-threads.jsonl",
                {"id": "thread", "text": "Wie geht es weiter?", "status": "open"},
            )
            domain._append_jsonl(
                domain.neo_dir / "contradiction-disclosure.jsonl",
                {
                    "newMemoryId": "memory",
                    "existingMemoryId": "old",
                    "score": 0.9,
                },
            )

            overlay = domain.recall_overlay(
                "Wie geht es weiter?",
                [{"id": "memory", "content": "A fact", "_distance": 0.1}],
            )

            self.assertTrue(overlay.startswith("<memory-meta-cognition>"))
            payload = json.loads(
                overlay.removeprefix("<memory-meta-cognition>\n").removesuffix(
                    "\n</memory-meta-cognition>"
                )
            )
            self.assertTrue(payload["additiveOnly"])
            self.assertEqual(payload["openThreads"], ["Wie geht es weiter?"])
            self.assertEqual(len(payload["contradictionsRequireReview"]), 1)


if __name__ == "__main__":
    unittest.main()
