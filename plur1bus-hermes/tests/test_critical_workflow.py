import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain


class CriticalWorkflowTests(unittest.TestCase):
    def _domain_with_cards(self, cards):
        temporary = tempfile.TemporaryDirectory()
        domain = Plur1busDomain(Path(temporary.name), "main")
        selector = domain._scope_selector()
        normalized = []
        for card in cards:
            normalized.append({
                "agentId": "main",
                "scopeKey": selector.scope_key,
                "aclBindings": selector.acl_bindings,
                "status": "active",
                "confirmed": False,
                "createdAt": "2026-07-01T00:00:00+00:00",
                "type": "person",
                **card,
            })
        domain._memory_rows = lambda: normalized
        domain._metadata_rows = lambda: []
        return temporary, domain

    def test_pending_critical_can_be_accepted_append_only(self):
        temporary, domain = self._domain_with_cards([
            {"id": "53628ada-8595-43dc-92da-216fe2c69836"},
        ])
        with temporary:
            domain._append_jsonl(
                domain.state_dir / "critical-push.jsonl",
                {
                    "id": "53628ada-8595-43dc-92da-216fe2c69836",
                    "status": "pending_review",
                    "createdAt": "2026-07-01T00:00:00+00:00",
                },
            )

            result = domain.review_critical(
                "53628ada-8595-43dc-92da-216fe2c69836",
                "accept",
            )

            self.assertTrue(result["updated"])
            self.assertEqual(result["status"], "accepted")
            self.assertEqual(domain.critical_items(), [])
            self.assertEqual(len(domain.critical_items(None)), 1)

    def test_review_by_short_reference_accepts_pending(self):
        temporary, domain = self._domain_with_cards([
            {"id": "a4563cc9-7611-4528-992a-075f8889a018"},
        ])
        with temporary:
            domain._append_jsonl(
                domain.state_dir / "critical-push.jsonl",
                {
                    "id": "a4563cc9-7611-4528-992a-075f8889a018",
                    "status": "pending_review",
                    "createdAt": "2026-07-01T00:00:00+00:00",
                },
            )

            self.assertEqual(
                domain.critical_reference_map()["a4563cc9-7611-4528-992a-075f8889a018"],
                "9a018",
            )
            result = domain.review_critical_by_reference("9a018", "reject")

            self.assertTrue(result["updated"])
            self.assertEqual(result["status"], "rejected")
            self.assertEqual(domain.critical_items("pending_review"), [])

    def test_review_by_unknown_reference_changes_nothing(self):
        temporary, domain = self._domain_with_cards([
            {"id": "a4563cc9-7611-4528-992a-075f8889a018"},
        ])
        with temporary:
            domain._append_jsonl(
                domain.state_dir / "critical-push.jsonl",
                {
                    "id": "a4563cc9-7611-4528-992a-075f8889a018",
                    "status": "pending_review",
                    "createdAt": "2026-07-01T00:00:00+00:00",
                },
            )

            result = domain.review_critical_by_reference("fffff", "accept")

            self.assertFalse(result["updated"])
            self.assertEqual(result["reason"], "not_found")
            self.assertEqual(len(domain.critical_items("pending_review")), 1)

    def test_note_or_confirmed_card_is_not_pending_even_with_ledger_entry(self):
        temporary, domain = self._domain_with_cards([
            {"id": "53628ada-8595-43dc-92da-216fe2c69836", "type": "note"},
            {"id": "a4563cc9-7611-4528-992a-075f8889a018", "confirmed": True},
        ])
        with temporary:
            for memory_id in (
                "53628ada-8595-43dc-92da-216fe2c69836",
                "a4563cc9-7611-4528-992a-075f8889a018",
            ):
                domain._append_jsonl(
                    domain.state_dir / "critical-push.jsonl",
                    {"id": memory_id, "status": "pending_review"},
                )
            self.assertEqual(domain.critical_items(), [])

    def test_foreign_scope_prefix_cannot_consume_page(self):
        temporary, domain = self._domain_with_cards([
            {
                "id": "00000000-0000-4000-8000-000000000001",
                "scopeKey": "foreign-scope",
                "aclBindings": {"agentId": "main", "scopeKey": "foreign-scope"},
            },
            {"id": "00000000-0000-4000-8000-000000000002"},
        ])
        with temporary:
            page = domain.critical_review_page(limit=1)
            self.assertEqual([item["id"] for item in page["items"]], [
                "00000000-0000-4000-8000-000000000002",
            ])

    def test_filtered_candidates_do_not_starve_behind_prefix(self):
        temporary, domain = self._domain_with_cards([
            {"id": "00000000-0000-4000-8000-000000000001", "confirmed": True},
            {"id": "00000000-0000-4000-8000-000000000002", "type": "note"},
            {"id": "00000000-0000-4000-8000-000000000003"},
        ])
        with temporary:
            page = domain.critical_review_page(limit=1)
            self.assertEqual([item["id"] for item in page["items"]], [
                "00000000-0000-4000-8000-000000000003",
            ])

    def test_cursor_is_deterministic_and_owner_bound(self):
        temporary, domain = self._domain_with_cards([
            {"id": "00000000-0000-4000-8000-000000000001"},
            {"id": "00000000-0000-4000-8000-000000000002"},
        ])
        with temporary:
            first = domain.critical_review_page(limit=1)
            second = domain.critical_review_page(limit=1, cursor=first["nextCursor"])
            self.assertEqual(second["items"][0]["id"], "00000000-0000-4000-8000-000000000002")
            with self.assertRaises(ValueError):
                domain.critical_review_page(
                    limit=1,
                    cursor=first["nextCursor"],
                    scope_key="another-owner",
                )

    def test_age_filter_uses_card_created_at(self):
        temporary, domain = self._domain_with_cards([
            {
                "id": "00000000-0000-4000-8000-000000000001",
                "createdAt": "2026-07-01T00:00:00+00:00",
            },
            {
                "id": "00000000-0000-4000-8000-000000000002",
                "createdAt": "2026-08-14T00:00:00+00:00",
            },
        ])
        with temporary:
            page = domain.critical_review_page(
                older_than_ms=1_784_000_000_000,
            )
            self.assertEqual([item["id"] for item in page["items"]], [
                "00000000-0000-4000-8000-000000000001",
            ])


if __name__ == "__main__":
    unittest.main()
