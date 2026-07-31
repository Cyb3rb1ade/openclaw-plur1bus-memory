import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.mood import MoodEngine


class MoodTests(unittest.TestCase):
    def test_temperament_and_mood_persist_in_machine_and_human_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            engine = MoodEngine(workspace)
            engine.set_preset("warm")
            state = engine.update(
                {"dominant": "joy", "intensity": 0.8, "valence": "positive"}
            )

            reopened = MoodEngine(workspace).state()

            self.assertEqual(state["preset"], "warm")
            self.assertEqual(reopened["dominant"], "joy")
            self.assertTrue((workspace / ".emotional-state.json").is_file())
            self.assertIn(
                "temperament=warm",
                (workspace / ".current-mood.txt").read_text(encoding="utf-8"),
            )


if __name__ == "__main__":
    unittest.main()
