import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from plur1bus_hermes.domain import Plur1busDomain


class _MemoryTable:
    def __init__(self, rows):
        self.rows = rows
        self.updates = []

    def schema(self):
        names = set().union(*(row.keys() for row in self.rows))
        return SimpleNamespace(fields=[SimpleNamespace(name=name) for name in names])

    def update(self, *, where, values):
        self.updates.append((where, values))
        memory_id = where.split("id = '", 1)[1].split("'", 1)[0]
        for row in self.rows:
            if row.get("id") == memory_id:
                row.update(values)
                return
        raise AssertionError("update target missing")


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
        table = _MemoryTable(normalized)
        domain._memory_table = lambda: table
        return temporary, domain, table

    def test_pending_critical_can_be_accepted_append_only(self):
        temporary, domain, table = self._domain_with_cards([
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
        temporary, domain, _table = self._domain_with_cards([
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
        temporary, domain, _table = self._domain_with_cards([
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
        temporary, domain, _table = self._domain_with_cards([
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
        temporary, domain, _table = self._domain_with_cards([
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
        temporary, domain, _table = self._domain_with_cards([
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
        temporary, domain, _table = self._domain_with_cards([
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
        temporary, domain, _table = self._domain_with_cards([
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

    def test_accept_mutates_current_card_before_recording_ledger(self):
        temporary, domain, table = self._domain_with_cards([
            {"id": "53628ada-8595-43dc-92da-216fe2c69836"},
        ])
        with temporary:
            result = domain.review_critical(
                "53628ada-8595-43dc-92da-216fe2c69836", "accept"
            )
            self.assertTrue(result["updated"])
            self.assertTrue(table.rows[0]["confirmed"])
            self.assertEqual(domain._read_jsonl(domain.state_dir / "critical-push.jsonl")[-1]["status"], "accepted")
            self.assertEqual(domain._read_jsonl(domain.state_dir / "destructive-operations.jsonl")[-1]["operation"], "critical-review")

    def test_reject_confirms_and_demotes_without_archiving(self):
        temporary, domain, table = self._domain_with_cards([
            {"id": "53628ada-8595-43dc-92da-216fe2c69836"},
        ])
        with temporary:
            result = domain.review_critical(
                "53628ada-8595-43dc-92da-216fe2c69836", "reject"
            )
            self.assertTrue(result["updated"])
            self.assertTrue(table.rows[0]["confirmed"])
            self.assertEqual(table.rows[0]["type"], "note")
            self.assertEqual(table.rows[0]["status"], "active")
            self.assertEqual(domain._read_jsonl(domain.state_dir / "critical-push.jsonl")[-1]["status"], "rejected")

    def test_changed_card_fails_closed_and_keeps_pending_ledger(self):
        temporary, domain, table = self._domain_with_cards([
            {"id": "53628ada-8595-43dc-92da-216fe2c69836"},
        ])
        with temporary:
            domain._append_jsonl(
                domain.state_dir / "critical-push.jsonl",
                {"id": "53628ada-8595-43dc-92da-216fe2c69836", "status": "pending_review"},
            )
            table.rows[0]["status"] = "deleted"
            table.rows[0]["content"] = "do-not-leak"
            result = domain.review_critical(
                "53628ada-8595-43dc-92da-216fe2c69836", "accept"
            )
            self.assertFalse(result["updated"])
            self.assertNotIn("do-not-leak", str(result))
            self.assertEqual(
                domain._read_jsonl(domain.state_dir / "critical-push.jsonl")[-1]["status"],
                "pending_review",
            )

    def test_foreign_card_fails_closed_without_ledger_transition(self):
        temporary, domain, table = self._domain_with_cards([
            {"id": "53628ada-8595-43dc-92da-216fe2c69836"},
        ])
        with temporary:
            domain._append_jsonl(
                domain.state_dir / "critical-push.jsonl",
                {"id": "53628ada-8595-43dc-92da-216fe2c69836", "status": "pending_review"},
            )
            table.rows[0]["scopeKey"] = "foreign-scope"
            table.rows[0]["aclBindings"] = {"agentId": "main", "scopeKey": "foreign-scope"}
            result = domain.review_critical(
                "53628ada-8595-43dc-92da-216fe2c69836", "reject"
            )
            self.assertFalse(result["updated"])
            self.assertEqual(
                domain._read_jsonl(domain.state_dir / "critical-push.jsonl")[-1]["status"],
                "pending_review",
            )

    def test_batch_reject_reports_partial_result_without_hiding_failure(self):
        temporary, domain, _table = self._domain_with_cards([
            {"id": "00000000-0000-4000-8000-000000000001"},
            {"id": "00000000-0000-4000-8000-000000000002"},
        ])
        with temporary:
            original = domain.review_critical

            def one_fails(memory_id, decision, **kwargs):
                if memory_id.endswith("0002"):
                    return {"updated": False, "reason": "card-changed", "id": memory_id}
                return original(memory_id, decision, **kwargs)

            domain.review_critical = one_fails
            result = domain.review_critical_batch(["00001", "00002"], "reject")
            self.assertEqual(result["updated"], 1)
            self.assertEqual(result["failed"], 1)
            self.assertTrue(result["partial"])
            self.assertEqual(len(result["results"]), 2)

    def test_all_batch_skips_deleted_and_foreign_cards(self):
        temporary, domain, table = self._domain_with_cards([
            {"id": "00000000-0000-4000-8000-000000000001"},
            {"id": "00000000-0000-4000-8000-000000000002", "status": "deleted"},
            {
                "id": "00000000-0000-4000-8000-000000000003",
                "scopeKey": "foreign-scope",
                "aclBindings": {"agentId": "main", "scopeKey": "foreign-scope"},
            },
        ])
        with temporary:
            result = domain.review_critical_batch(None, "accept", all_pending=True)
            self.assertEqual(result["requested"], 1)
            self.assertEqual(result["updated"], 1)
            self.assertTrue(table.rows[0]["confirmed"])
            self.assertFalse(table.rows[1]["confirmed"])
            self.assertFalse(table.rows[2]["confirmed"])

    def test_reference_map_honors_snake_case_acl_binding(self):
        temporary, domain, _table = self._domain_with_cards([])
        with temporary:
            selected = []
            domain._all_pending_critical_items = lambda selector: selected.append(selector) or []
            domain.critical_reference_map(acl_bindings={"agentId": "main", "scopeKey": "foreign-scope"})
            self.assertEqual(selected[0].scope_key, "foreign-scope")

    def test_batch_continues_after_exception_and_deduplicates_resolved_id(self):
        temporary, domain, _table = self._domain_with_cards([
            {"id": "00000000-0000-4000-8000-000000000001"},
            {"id": "00000000-0000-4000-8000-000000000002"},
        ])
        with temporary:
            calls = []

            def review(memory_id, _decision, **_kwargs):
                calls.append(memory_id)
                if memory_id.endswith("0001"):
                    raise RuntimeError("simulated")
                return {"updated": True, "id": memory_id}

            domain.review_critical = review
            result = domain.review_critical_batch([
                "00001", "00000000-0000-4000-8000-000000000001", "00002"
            ], "accept")
            self.assertEqual(calls, [
                "00000000-0000-4000-8000-000000000001",
                "00000000-0000-4000-8000-000000000002",
            ])
            self.assertEqual(result["updated"], 1)
            self.assertEqual(result["failed"], 2)
            self.assertEqual(result["results"][1]["reason"], "duplicate-reference")


if __name__ == "__main__":
    unittest.main()
