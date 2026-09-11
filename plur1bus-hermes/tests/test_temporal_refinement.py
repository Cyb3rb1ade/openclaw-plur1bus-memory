import unittest
from datetime import datetime, timezone

from plur1bus_hermes.cognition import parse_temporal_range
from plur1bus_hermes.query_refinement import refine_query


class TemporalRefinementTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 11, 12, tzinfo=timezone.utc)

    def test_duration_phrases_do_not_become_today_ranges(self):
        for phrase in (
            "bis heute keine Antwort",
            "bis jetzt keine Antwort",
            "bis dato keine Antwort",
            "until today no answer",
            "until now no answer",
            "up to today no answer",
            "up to now no answer",
            "so far no answer",
            "to date no answer",
            "BIS HEUTE keine Antwort",
            "UNTIL TODAY no answer",
        ):
            with self.subTest(phrase=phrase):
                self.assertIsNone(parse_temporal_range(phrase, now=self.now))
        stripped_with_anchor = parse_temporal_range("bis heute: gestern", now=self.now)
        self.assertEqual(stripped_with_anchor["start"], "2026-09-10T00:00:00+00:00")
        evening = parse_temporal_range("bis heute Abend", now=self.now)
        timed_deadline = parse_temporal_range("bis heute 18 Uhr", now=self.now)
        self.assertEqual(evening["start"], "2026-09-11T00:00:00+00:00")
        self.assertEqual(evening["end"], "2026-09-11T12:00:00+00:00")
        self.assertEqual(timed_deadline["start"], "2026-09-11T00:00:00+00:00")
        self.assertEqual(timed_deadline["end"], "2026-09-11T12:00:00+00:00")

    def test_today_yesterday_hours_ago_and_last_week(self):
        today = parse_temporal_range("Was war heute?", now=self.now)
        yesterday = parse_temporal_range("What happened yesterday?", now=self.now)
        hours = parse_temporal_range("vor 3 Stunden", now=self.now)
        english_hours = parse_temporal_range("5 hours ago", now=self.now)
        german_days = parse_temporal_range("vor 2 Tagen", now=self.now)
        week = parse_temporal_range("last week", now=self.now)

        self.assertEqual(today["start"], "2026-09-11T00:00:00+00:00")
        self.assertEqual(today["end"], "2026-09-11T12:00:00+00:00")
        self.assertEqual(yesterday["start"], "2026-09-10T00:00:00+00:00")
        self.assertEqual(yesterday["end"], "2026-09-11T00:00:00+00:00")
        self.assertEqual(hours["start"], "2026-09-11T09:00:00+00:00")
        self.assertEqual(hours["end"], "2026-09-11T12:00:00+00:00")
        self.assertEqual(english_hours["start"], "2026-09-11T07:00:00+00:00")
        self.assertEqual(english_hours["end"], "2026-09-11T12:00:00+00:00")
        self.assertEqual(german_days["start"], "2026-09-09T00:00:00+00:00")
        self.assertEqual(german_days["end"], "2026-09-10T00:00:00+00:00")
        self.assertEqual(week["start"], "2026-09-04T12:00:00+00:00")
        self.assertEqual(week["end"], "2026-09-11T12:00:00+00:00")

    def test_explicit_and_contextual_months_are_bounded_and_unicode_safe(self):
        may_2025 = parse_temporal_range("im Mai 2025", now=self.now)
        march_2024 = parse_temporal_range("im März 2024", now=self.now)
        february_2024 = parse_temporal_range("in February 2024", now=self.now)
        may = parse_temporal_range("im Mai", now=self.now)

        self.assertEqual(may_2025["start"], "2025-05-01T00:00:00+00:00")
        self.assertEqual(may_2025["end"], "2025-06-01T00:00:00+00:00")
        self.assertEqual(march_2024["start"], "2024-03-01T00:00:00+00:00")
        self.assertEqual(march_2024["end"], "2024-04-01T00:00:00+00:00")
        self.assertEqual(february_2024["end"], "2024-03-01T00:00:00+00:00")
        self.assertEqual(may["start"], "2026-05-01T00:00:00+00:00")
        self.assertEqual(may["end"], "2026-06-01T00:00:00+00:00")
        self.assertIsNone(parse_temporal_range("im Dezember", now=self.now))

    def test_previous_weekdays_and_bounded_standalone_years(self):
        monday = parse_temporal_range("am Montag", now=self.now)
        friday = parse_temporal_range("on Friday", now=self.now)
        same_weekday = parse_temporal_range(
            "on Friday", now=datetime(2026, 9, 11, 12, tzinfo=timezone.utc)
        )
        year = parse_temporal_range("Was war 2025?", now=self.now)

        self.assertEqual(monday["start"], "2026-09-07T00:00:00+00:00")
        self.assertEqual(friday["start"], "2026-09-04T00:00:00+00:00")
        self.assertEqual(same_weekday["start"], "2026-09-04T00:00:00+00:00")
        self.assertEqual(year["start"], "2025-01-01T00:00:00+00:00")
        self.assertEqual(year["end"], "2026-01-01T00:00:00+00:00")
        self.assertIsNone(parse_temporal_range("1969", now=self.now))
        self.assertIsNone(parse_temporal_range("3000", now=self.now))

    def test_resolves_last_month_and_quarter(self):
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)

        month = parse_temporal_range("Was war letzten Monat?", now=now)
        quarter = parse_temporal_range("Was geschah in Q2 2026?", now=now)

        self.assertTrue(month["start"].startswith("2026-06-01"))
        self.assertTrue(month["end"].startswith("2026-07-01"))
        self.assertTrue(quarter["start"].startswith("2026-04-01"))
        self.assertTrue(quarter["end"].startswith("2026-07-01"))

    def test_calendar_month_and_quarter_keep_year_rollover_boundaries(self):
        january = datetime(2026, 1, 5, 12, tzinfo=timezone.utc)
        previous_month = parse_temporal_range("letzten Monat", now=january)
        last_quarter = parse_temporal_range("Q4 2025", now=self.now)
        days_ago = parse_temporal_range("2 days ago", now=self.now)

        self.assertEqual(previous_month["start"], "2025-12-01T00:00:00+00:00")
        self.assertEqual(previous_month["end"], "2026-01-01T00:00:00+00:00")
        self.assertEqual(last_quarter["start"], "2025-10-01T00:00:00+00:00")
        self.assertEqual(last_quarter["end"], "2026-01-01T00:00:00+00:00")
        self.assertEqual(days_ago["start"], "2026-09-09T00:00:00+00:00")
        self.assertEqual(days_ago["end"], "2026-09-10T00:00:00+00:00")

    def test_refinement_removes_fillers_and_expands_acronyms(self):
        refined = refine_query("Kannst du mir bitte die LLM API erklären?")

        self.assertIn("large language model", refined)
        self.assertIn("application programming interface", refined)
        self.assertNotIn("kannst", refined)


if __name__ == "__main__":
    unittest.main()
