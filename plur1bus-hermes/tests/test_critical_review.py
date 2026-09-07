import unittest

from plur1bus_hermes.critical import classify_critical
from plur1bus_hermes.critical_review import (
    assign_short_refs,
    build_preview,
    is_suppressed_type,
    resolve_hidden_types,
    resolve_short_ref,
    sanitize_preview,
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

    def test_nonactive_record_is_never_critical(self):
        result = classify_critical(
            "Never forget this.",
            {"importance": 1.0, "neverForget": True},
            status="deleted",
        )
        self.assertFalse(result["eligible"])
        self.assertFalse(result["requiresReview"])


class PreviewPrivacyTests(unittest.TestCase):
    def test_credentials_are_always_suppressed_but_health_and_finance_default_visible(self):
        credential = build_preview({"type": "zugang_passwort", "text": "geheim"}, "de")
        self.assertTrue(credential["suppressed"])
        self.assertEqual(credential["text"], "")
        for type_ in ("gesundheit", "geld_konto"):
            preview = build_preview({"type": type_, "text": "eigene Aussage"}, "de")
            self.assertFalse(preview["suppressed"])
            self.assertEqual(preview["text"], "eigene Aussage")

    def test_hide_types_extend_but_cannot_remove_credentials(self):
        self.assertEqual(resolve_hidden_types([" gesundheit "]), {"zugang_passwort", "gesundheit"})
        self.assertTrue(is_suppressed_type("gesundheit", ["gesundheit"]))
        self.assertTrue(build_preview({"type": "geld_konto", "text": "secret"}, hide_types=["geld_konto"])["suppressed"])
        self.assertTrue(build_preview({"type": "zugang_passwort", "text": "secret"}, hide_types=[])["suppressed"])

    def test_content_suppressed_is_never_overridden_by_visible_type_policy(self):
        preview = build_preview({"type": "gesundheit", "text": "geheim", "contentSuppressed": True})
        self.assertTrue(preview["suppressed"])
        self.assertEqual(preview["text"], "")

    def test_content_fallback_is_sanitized_and_bounded(self):
        preview = build_preview({"type": "person", "content": "<secret>\n" + "x" * 200})
        self.assertFalse(preview["suppressed"])
        self.assertNotIn("<", preview["text"])
        self.assertLessEqual(len(preview["text"]), 160)

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
        refs = assign_short_refs([UUID_A], 5)
        self.assertEqual(refs[UUID_A], "9a018")

    def test_assign_short_refs_roundtrip_resolves_exactly(self):
        ids = [
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
        ]
        refs = assign_short_refs(ids, 5)
        self.assertEqual(len(set(refs.values())), len(ids))
        pending = [{"id": memory_id} for memory_id in ids]
        for memory_id in ids:
            result = resolve_short_ref(refs[memory_id], pending)
            self.assertTrue(result["ok"])
            self.assertEqual(result["id"], memory_id)

    def test_collision_identical_five_char_ending_resolves(self):
        id1 = "00000000-0000-4000-8000-aaaaaaaabcde"
        id2 = "00000000-0000-4000-8000-bbbbbbbabcde"
        pending = [{"id": id1}, {"id": id2}]
        refs = assign_short_refs([id1, id2], 5)
        self.assertGreaterEqual(len(refs[id1]), 6)
        self.assertGreaterEqual(len(refs[id2]), 6)
        self.assertNotEqual(refs[id1], refs[id2])
        self.assertEqual(resolve_short_ref(refs[id1], pending), {"ok": True, "id": id1})
        self.assertEqual(resolve_short_ref(refs[id2], pending), {"ok": True, "id": id2})

    def test_collision_identical_six_char_ending_resolves(self):
        id1 = "00000000-0000-4000-8000-aaaaaa0abcde"
        id2 = "00000000-0000-4000-8000-bbbbbb0abcde"
        pending = [{"id": id1}, {"id": id2}]
        refs = assign_short_refs([id1, id2], 5)
        for memory_id in (id1, id2):
            self.assertGreaterEqual(len(refs[memory_id]), 7)
            self.assertEqual(resolve_short_ref(refs[memory_id], pending), {"ok": True, "id": memory_id})

    def test_multiple_identical_endings_resolve(self):
        ids = [
            "00000000-0000-4000-8000-aaaaaaaabcde",
            "00000000-0000-4000-8000-bbbbbbbabcde",
            "00000000-0000-4000-8000-cccccccabcde",
        ]
        pending = [{"id": memory_id} for memory_id in ids]
        refs = assign_short_refs(ids, 5)
        self.assertEqual(len(set(refs.values())), len(ids))
        for memory_id in ids:
            self.assertEqual(resolve_short_ref(refs[memory_id], pending), {"ok": True, "id": memory_id})

    def test_order_independence(self):
        ids = [
            "00000000-0000-4000-8000-aaaaaaaabcde",
            "00000000-0000-4000-8000-bbbbbbbabcde",
            "00000000-0000-4000-8000-cccccccabcde",
        ]
        refs_a = assign_short_refs(ids, 5)
        refs_b = assign_short_refs(list(reversed(ids)), 5)
        for memory_id in ids:
            self.assertEqual(refs_a[memory_id], refs_b[memory_id])

    def test_resolve_unique_reference(self):
        result = resolve_short_ref("9a018", [{"id": UUID_A}])
        self.assertTrue(result["ok"])
        self.assertEqual(result["id"], UUID_A)

    def test_resolve_unknown_reference(self):
        result = resolve_short_ref("fffff", [{"id": UUID_A}])
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "not_found")

    def test_resolve_collision_is_ambiguous_with_unique_suggestions(self):
        id1 = "00000000-0000-4000-8000-aaaaaaaabcde"
        id2 = "00000000-0000-4000-8000-bbbbbbbabcde"
        pending = [{"id": id1}, {"id": id2}]
        result = resolve_short_ref("abcde", pending)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "ambiguous")
        self.assertEqual(len(result["suggestions"]), 2)
        self.assertEqual(len(set(result["suggestions"])), 2)
        for suggestion in result["suggestions"]:
            self.assertTrue(resolve_short_ref(suggestion, pending)["ok"])

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
