import unittest
from datetime import datetime, timezone

from plur1bus_hermes.cognition import parse_temporal_range
from plur1bus_hermes.query_refinement import refine_query


class TemporalRefinementTests(unittest.TestCase):
    def test_resolves_last_month_and_quarter(self):
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)

        month = parse_temporal_range("Was war letzten Monat?", now=now)
        quarter = parse_temporal_range("Was geschah in Q2 2026?", now=now)

        self.assertTrue(month["start"].startswith("2026-06-01"))
        self.assertTrue(month["end"].startswith("2026-07-01"))
        self.assertTrue(quarter["start"].startswith("2026-04-01"))
        self.assertTrue(quarter["end"].startswith("2026-07-01"))

    def test_refinement_removes_fillers_and_expands_acronyms(self):
        refined = refine_query("Kannst du mir bitte die LLM API erklären?")

        self.assertIn("large language model", refined)
        self.assertIn("application programming interface", refined)
        self.assertNotIn("kannst", refined)


if __name__ == "__main__":
    unittest.main()
