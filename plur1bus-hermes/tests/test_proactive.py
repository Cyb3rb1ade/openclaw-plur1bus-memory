import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from plur1bus_hermes.proactive import ProactiveEngine


def _append(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value) + "\n")


class ProactiveTests(unittest.TestCase):
    def test_pattern_nudge_is_persistent_and_governed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            engine = ProactiveEngine(root / "state", root / "neo", root / "workspace")
            for index in range(3):
                _append(
                    root / "neo/turn-journal.jsonl",
                    {
                        "id": str(index),
                        "role": "user",
                        "content": "Die Hermes Migration soll vollständig weiterlaufen",
                    },
                )

            first = engine.proactive_check(
                now=datetime(2026, 7, 26, tzinfo=timezone.utc)
            )
            second = engine.proactive_check(
                now=datetime(2026, 7, 26, 1, tzinfo=timezone.utc)
            )

            self.assertFalse(first["skipped"])
            self.assertTrue(second["skipped"])
            self.assertEqual(len(engine.pending_messages()), 1)

    def test_afterthought_respects_time_window_and_meta_reflects_feedback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            engine = ProactiveEngine(root / "state", root / "neo", root / "workspace")
            now = datetime(2026, 7, 26, 12, tzinfo=timezone.utc)
            _append(
                root / "neo/episodes.jsonl",
                {"endTime": (now - timedelta(minutes=45)).isoformat()},
            )
            _append(
                root / "neo/open-threads.jsonl",
                {"id": "thread", "text": "Wie geht es weiter?", "status": "open"},
            )
            for value in ("useful", "useful", "incorrect"):
                _append(
                    root / "workspace/.adaptive-learning/feedback-log.jsonl",
                    {"feedback": value},
                )

            afterthought = engine.afterthought(now=now)
            reflection = engine.meta_reflect()

            self.assertFalse(afterthought["skipped"])
            self.assertEqual(reflection["feedbackCount"], 3)
            self.assertGreater(reflection["f1"], 0)


if __name__ == "__main__":
    unittest.main()
