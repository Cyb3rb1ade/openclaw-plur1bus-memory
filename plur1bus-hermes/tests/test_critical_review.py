import unittest

from plur1bus_hermes.critical import classify_critical
from plur1bus_hermes.critical_review import (
    assign_short_refs,
    build_preview,
    resolve_short_ref,
    sanitize_preview,
    shortest_unique_suffix,
    translate_reason,
    translate_source_role,
    translate_type,
)

UUID_A = "a4563cc9-7611-4528-992a-075f8889a018"
UUID_B = "b4563cc9-7611-4528-992a-075f8889a019"


class ReasonTranslationTests(unittest.TestCase):
    def test_translates_internal_reasons_understandably(self):
        self.assertIn("dauerhaft wichtig", translate_reason("never_forget", "", "de"))
        self.assertIn("besonders wichtig eingestuft", translate_reason("high_importance", "", "de"))
        self.assertIn("Merkwunsch", translate_reason("explicit_critical_language", "", "de"))

    def test_never_shows_raw_reason(self):
        text = translate_reason("__raw__", "gesundheit", "de")
        self.assertNotEqual(text, "__raw__")
        self.assertIn("Gesundheitsinformation", text)

    def test_type_labels_are_understandable(self):
        self.assertIn("Person", translate_type("person", "de"))
        self.assertNotEqual(translate_type("person", "de"), "person")
        self.assertIn("Zugangsinformation", translate_type("zugang_passwort", "de"))

    def test_source_role_labels(self):
        self.assertEqual(translate_source_role("user", "de"), "Benutzer")
        self.assertEqual(translate_source_role("assistant", "de"), "Assistent")
        self.assertEqual(translate_source_role("correction", "de"), "Korrektur")


class SourceRoleGatingTests(unittest.TestCase):
    def test_assistant_keyword_match_is_not_critical(self):
        result = classify_critical(
            "Dein API-Key ist nicht konfiguriert.",
            {"importance": 0.4, "neverForget": False},
            source_role="assistant",
        )
        self.assertFalse(result["eligible"])
        self.assertEqual(result["reason"], "not_critical")

    def test_user_keyword_match_is_critical(self):
        result = classify_critical(
            "Mein API-Key ist abc123.",
            {"importance": 0.4, "neverForget": False},
            source_role="user",
        )
        self.assertTrue(result["eligible"])
        self.assertEqual(result["reason"], "explicit_critical_language")

    def test_never_forget_stays_effective_for_assistant(self):
        result = classify_critical(
            "Eine wichtige Regel.",
            {"importance": 0.4, "neverForget": True},
            source_role="assistant",
        )
        self.assertTrue(result["eligible"])
        self.assertEqual(result["reason"], "never_forget")

    def test_high_importance_stays_effective_for_assistant(self):
        result = classify_critical(
            "Eine wichtige Regel.",
            {"importance": 0.95, "neverForget": False},
            source_role="assistant",
        )
        self.assertTrue(result["eligible"])
        self.assertEqual(result["reason"], "high_importance")


class PreviewPrivacyTests(unittest.TestCase):
    def test_suppresses_sensitive_types(self):
        for type_ in ("zugang_passwort", "gesundheit", "geld_konto"):
            preview = build_preview({"type": type_, "text": "geheim"}, "de")
            self.assertTrue(preview["suppressed"])
            self.assertEqual(preview["text"], "")

    def test_secret_content_never_leaks(self):
        preview = build_preview({"type": "zugang_passwort", "text": "api-key=supergeheim"}, "de")
        self.assertNotIn("supergeheim", preview["reason"])

    def test_sanitize_neutralizes_injection_and_truncates(self):
        text = sanitize_preview("  Hallo\n*welt* <b>fett</b> \x07 END  ", 40)
        self.assertNotIn("\n", text)
        self.assertNotIn("*", text)
        self.assertNotIn("<", text)
        self.assertLessEqual(len(text), 40)


class ShortReferenceTests(unittest.TestCase):
    def test_shortest_unique_suffix_min_five(self):
        self.assertEqual(shortest_unique_suffix(UUID_A, set(), 5), "9a018")

    def test_collision_lengthens(self):
        taken = {"9a018"}
        ref = shortest_unique_suffix(UUID_A, taken, 5)
        self.assertGreater(len(ref), 5)
        self.assertNotIn(ref, taken)

    def test_assign_short_refs_are_unique(self):
        ids = [
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
        ]
        refs = list(assign_short_refs(ids, 5).values())
        self.assertEqual(len(set(refs)), len(refs))

    def test_resolve_unique_reference(self):
        result = resolve_short_ref("9a018", [{"id": UUID_A}])
        self.assertTrue(result["ok"])
        self.assertEqual(result["id"], UUID_A)

    def test_resolve_unknown_reference(self):
        result = resolve_short_ref("fffff", [{"id": UUID_A}])
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "not_found")

    def test_resolve_collision_is_ambiguous_with_suggestions(self):
        id1 = "00000000-0000-4000-8000-aaaaaaaabcde"
        id2 = "00000000-0000-4000-8000-bbbbbbbabcde"
        result = resolve_short_ref("abcde", [{"id": id1}, {"id": id2}])
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "ambiguous")
        self.assertEqual(len(result["suggestions"]), 2)

    def test_full_uuid_is_compatible_fallback(self):
        result = resolve_short_ref(UUID_A, [{"id": UUID_A}])
        self.assertTrue(result["ok"])
        self.assertEqual(result["id"], UUID_A)

    def test_scope_isolation_foreign_pending_not_resolved(self):
        result = resolve_short_ref("9a018", [{"id": UUID_B}])
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "not_found")

    def test_invalid_reference_rejected(self):
        self.assertFalse(resolve_short_ref("12ab", [{"id": UUID_A}])["ok"])
        self.assertFalse(resolve_short_ref("zzzzz", [{"id": UUID_A}])["ok"])


if __name__ == "__main__":
    unittest.main()
