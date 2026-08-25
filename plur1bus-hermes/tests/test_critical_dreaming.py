import unittest

from plur1bus_hermes.critical import classify_critical
from plur1bus_hermes.dreaming import build_rem_dream


class CriticalDreamingTests(unittest.TestCase):
    def test_critical_classifier_requires_review_and_suppresses_secret_content(self):
        result = classify_critical(
            "Never forget this API key: sk-live-example-123456",
            {"importance": 0.4, "neverForget": False},
        )

        self.assertTrue(result["eligible"])
        self.assertTrue(result["requiresReview"])
        self.assertTrue(result["suppressContent"])

    def test_secret_words_without_a_secret_value_are_not_critical(self):
        for text in (
            "Bitte mein Passwort nicht im Text nennen.",
            "Der API-Key ist noch nicht konfiguriert.",
            "Wir sollten später einen neuen Token anlegen.",
            "The password is required.",
            "The token is optional.",
            "API_KEY=<redacted>",
            "password=********",
            "token=${TOKEN}",
            "password=YOUR_PASSWORD_HERE",
            "The API key is stored in 1Password.",
            "The password is wrong.",
            "The token is generated at runtime.",
            "Das Passwort ist abgelaufen.",
            "Der Token ist ungültig.",
        ):
            with self.subTest(text=text):
                result = classify_critical(
                    text,
                    {"importance": 0.4, "neverForget": False},
                    source_role="user",
                )
                self.assertFalse(result["eligible"])
                self.assertFalse(result["suppressContent"])

    def test_concrete_secret_assignments_remain_critical(self):
        for text in (
            "Mein Passwort lautet: Tr0ub4dor!42",
            "API_KEY=sk-live-example-123456",
            "Der Zugangscode ist 847291.",
            "API key: actual-value-1234",
            "password = secret-value-123",
            "token is missing; password=secret-value-123",
            "Authorization: Bearer bearer/value+with=punctuation",
            "postgresql://alice:S3cret-pass@example.com/database",
            'The password is "correct horse battery staple".',
            "The token is AbCdEfGhIjKlMnOp.",
        ):
            with self.subTest(text=text):
                result = classify_critical(
                    text,
                    {"importance": 0.4, "neverForget": False},
                    source_role="user",
                )
                self.assertTrue(result["eligible"])
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
