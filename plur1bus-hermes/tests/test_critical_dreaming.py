import unittest

from plur1bus_hermes.critical import classify_critical
from plur1bus_hermes.dreaming import build_rem_dream


class CriticalDreamingTests(unittest.TestCase):
    def test_critical_classifier_requires_review_and_suppresses_secret_content(self):
        result = classify_critical(
            "Never forget this API key",
            {"importance": 0.4, "neverForget": False},
        )

        self.assertTrue(result["eligible"])
        self.assertTrue(result["requiresReview"])
        self.assertTrue(result["suppressContent"])

    def test_rem_dream_builds_associations_and_marks_contradictions(self):
        dream = build_rem_dream(
            [
                {"id": "a", "content": "Bernd will morgen nach Berlin fahren"},
                {"id": "b", "content": "Bernd will morgen nicht nach Berlin fahren"},
                {"id": "c", "content": "Berlin hat viele Museen"},
            ],
            "main",
        )

        self.assertEqual(dream["type"], "rem_dream")
        self.assertEqual(
            dream["phases"],
            ["activation", "association", "synthesis", "integration"],
        )
        self.assertTrue(dream["contradictions"])
        self.assertFalse(dream["destructiveChanges"])


if __name__ == "__main__":
    unittest.main()
