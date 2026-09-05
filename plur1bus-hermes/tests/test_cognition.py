import unittest
from datetime import datetime, timezone

from plur1bus_hermes.cognition import (
    analyze_text,
    contradiction_score,
    extract_open_threads,
)


class CognitionTests(unittest.TestCase):
    def test_analyzes_emotion_temporal_quality_and_continuity(self):
        result = analyze_text(
            "Ich freue mich sehr. Morgen machen wir weiter.",
            now=datetime(2026, 7, 26, tzinfo=timezone.utc),
        )

        self.assertEqual(result["emotion"]["dominant"], "joy")
        self.assertEqual(result["emotion"]["valence"], "positive")
        self.assertEqual(result["temporal"][0]["resolvedDate"], "2026-07-27")
        self.assertTrue(result["continuationSignal"])
        self.assertGreater(result["factQuality"], 0)

    def test_extracts_open_questions_and_todos(self):
        threads = extract_open_threads("Wie geht es weiter?\nTODO: Index neu bauen.")

        self.assertEqual(len(threads), 2)
        self.assertTrue(threads[0].endswith("?"))

    def test_contradiction_requires_shared_claim_and_opposite_negation(self):
        score = contradiction_score(
            "Bernd will morgen nach Berlin fahren",
            "Bernd will morgen nicht nach Berlin fahren",
        )

        self.assertGreater(score, 0.7)
        self.assertEqual(
            contradiction_score("Bernd fährt nach Berlin", "Bananen sind gelb"),
            0.0,
        )


if __name__ == "__main__":
    unittest.main()
