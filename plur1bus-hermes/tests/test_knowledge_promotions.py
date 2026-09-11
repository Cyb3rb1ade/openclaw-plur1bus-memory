"""Tests for confirmation-gated private Schicht 1.5 promotions."""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path
from datetime import datetime, timedelta, timezone

import lancedb

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes import knowledge
from plur1bus_hermes.namespaces import binding_from_scope


MEMORY_ID = "619c3d51-1d9d-4736-8bf9-91b38aff8246"
MEMORY_TEXT = "The deploy process requires a preflight backup before migration."


class KnowledgePromotionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.binding = binding_from_scope("main")
        database = lancedb.connect(str(self.root / "lancedb" / "main"))
        database.create_table("metadata", data=[{
            "id": MEMORY_ID,
            "agentId": "main",
            "scopeKey": self.binding.scope_key,
            "metadataJson": json.dumps({
                "scopeKey": self.binding.scope_key,
                "aclBindings": self.binding.as_dict(),
                "text": MEMORY_TEXT,
                "type": "fact",
                "importance": 0.9,
            }),
        }])
        database.create_table("memories", data=[{
            "id": MEMORY_ID,
            "agentId": "main",
            "scopeKey": self.binding.scope_key,
            "content": MEMORY_TEXT,
            "type": "fact",
            "status": "active",
            "epistemicStatus": "observed",
            "expiresAt": 0,
            "validFrom": 0,
            "validUntil": 0,
            "vector": [0.0],
        }])
        self.domain = Plur1busDomain(self.root, "main", {"schicht15": {"enabled": True}})
        cognition_path = self.domain.neo_dir / "memory-cognition.jsonl"
        cognition_path.parent.mkdir(parents=True)
        cognition_path.write_text(json.dumps({
            "id": MEMORY_ID,
            "agentId": "main",
            "scopeKey": self.binding.scope_key,
            "factQuality": 0.9,
        }) + "\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_private_promotion_requires_proposal_then_confirmation(self) -> None:
        proposal_result = self.domain.propose_knowledge_promotions()
        self.assertFalse(proposal_result["skipped"])
        proposal = proposal_result["proposed"][0]
        self.assertFalse((self.domain.workspace_dir / "KNOWLEDGE.md").exists())

        confirmed = self.domain.confirm_knowledge_promotion(proposal["proposalId"])
        self.assertTrue(confirmed["confirmed"])
        knowledge = (self.domain.workspace_dir / "KNOWLEDGE.md").read_text(encoding="utf-8")
        self.assertIn("preflight backup", knowledge)
        self.assertIn("plur1bus:knowledge:start", knowledge)
        self.assertEqual(self.domain.propose_knowledge_promotions()["proposed"], [])

    def test_shared_scope_cannot_propose_or_write_prompt_adjacent_file(self) -> None:
        foreign = binding_from_scope("main", {"scopeType": "workspace", "workspace": "shared"})
        result = self.domain.propose_knowledge_promotions(acl_bindings=foreign.as_dict())
        self.assertTrue(result["skipped"])
        self.assertEqual(result["reason"], "private-scope-required")
        self.assertFalse((self.domain._scope_workspace_dir(foreign) / "KNOWLEDGE.md").exists())

    def test_confirmation_revalidates_changed_memory(self) -> None:
        proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
        self.domain._memory_table().update(
            where=f"id = '{MEMORY_ID}'", values={"content": "Changed after review."}
        )
        result = self.domain.confirm_knowledge_promotion(proposal["proposalId"])
        self.assertFalse(result["confirmed"])
        self.assertEqual(result["reason"], "proposal-stale")

    def test_confirmation_revalidates_canonical_invalidation(self) -> None:
        proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
        canonical = self.domain._memory_table()
        canonical.update(where=f"id = '{MEMORY_ID}'", values={"epistemicStatus": "invalidated"})
        result = self.domain.confirm_knowledge_promotion(proposal["proposalId"])
        self.assertFalse(result["confirmed"])
        self.assertFalse((self.domain.workspace_dir / "KNOWLEDGE.md").exists())

    def test_missing_source_retires_pending_without_erasing_history(self) -> None:
        proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
        self.domain._metadata_table().delete(f"id = '{MEMORY_ID}'")
        self.domain.propose_knowledge_promotions()
        ledger = self.domain.state_dir / "knowledge-promotions.jsonl"
        events = [json.loads(line) for line in ledger.read_text().splitlines()]
        own = [row for row in events if row.get("proposalId") == proposal["proposalId"]]
        self.assertGreaterEqual(len(own), 2)
        self.assertEqual(own[-1]["status"], "stale")
        before = ledger.read_bytes()
        self.domain.propose_knowledge_promotions()
        self.assertEqual(ledger.read_bytes(), before)
        self.assertFalse((self.domain.workspace_dir / "KNOWLEDGE.md").exists())

    def test_invalidated_metadata_retires_and_cannot_confirm(self) -> None:
        proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
        table = self.domain._metadata_table()
        metadata = self.domain._metadata_json(table.to_arrow().to_pylist()[0])
        metadata["epistemicStatus"] = "invalidated"
        table.update(where=f"id = '{MEMORY_ID}'", values={"metadataJson": json.dumps(metadata)})

        self.domain.propose_knowledge_promotions()
        events = [json.loads(line) for line in (self.domain.state_dir / "knowledge-promotions.jsonl").read_text().splitlines()]
        own = [row for row in events if row.get("proposalId") == proposal["proposalId"]]
        self.assertEqual(own[-1]["status"], "stale")
        self.assertEqual(own[-1]["reason"], "invalidated")
        self.assertEqual(self.domain.confirm_knowledge_promotion(proposal["proposalId"])["reason"], "proposal-not-found")

    def test_inactive_or_expired_metadata_cannot_repropose(self) -> None:
        for change in ({"status": "archived"}, {"expiresAt": 1}):
            with self.subTest(change=change):
                proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
                table = self.domain._metadata_table()
                metadata = self.domain._metadata_json(table.to_arrow().to_pylist()[0])
                metadata.update(change)
                table.update(
                    where=f"id = '{MEMORY_ID}'",
                    values={"metadataJson": json.dumps(metadata)},
                )
                result = self.domain.propose_knowledge_promotions()
                self.assertEqual(result["proposed"], [])
                events = [json.loads(line) for line in (self.domain.state_dir / "knowledge-promotions.jsonl").read_text().splitlines()]
                own = [row for row in events if row.get("proposalId") == proposal["proposalId"]]
                self.assertEqual(own[-1]["status"], "stale")
                latest = self.domain._latest_knowledge_events(events, self.domain._scope_selector())
                self.assertFalse([
                    event for event in latest.values()
                    if event.get("memoryId") == MEMORY_ID and event.get("status") == "pending"
                ])
                table.update(
                    where=f"id = '{MEMORY_ID}'",
                    values={"metadataJson": json.dumps({
                        "scopeKey": self.binding.scope_key,
                        "aclBindings": self.binding.as_dict(),
                        "text": MEMORY_TEXT,
                        "type": "fact",
                        "importance": 0.9,
                    })},
                )

    def test_unavailable_or_failing_lookup_preserves_pending_evidence(self) -> None:
        for failure in ("unavailable", "query-error"):
            with self.subTest(failure=failure):
                proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
                ledger = self.domain.state_dir / "knowledge-promotions.jsonl"
                before = ledger.read_bytes()
                original = self.domain._metadata_table
                source_table = original()

                class Query:
                    def where(self, predicate):
                        raise RuntimeError("metadata query failed")

                class Table:
                    def search(self):
                        return Query()

                    def to_arrow(self):
                        return source_table.to_arrow()

                self.domain._metadata_table = (lambda: None) if failure == "unavailable" else (lambda: Table())
                try:
                    self.domain.propose_knowledge_promotions()
                finally:
                    self.domain._metadata_table = original
                self.assertEqual(ledger.read_bytes(), before)
                ledger.unlink()

    def test_retirement_queries_at_most_100_unique_safe_pending_ids(self) -> None:
        proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
        ledger = self.domain.state_dir / "knowledge-promotions.jsonl"
        generated_ids = [str(uuid.uuid5(uuid.NAMESPACE_URL, f"pending-{index}")) for index in range(101)]
        for index, memory_id in enumerate(generated_ids):
            self.domain._append_jsonl(ledger, {
                **proposal,
                "proposalId": str(uuid.uuid5(uuid.NAMESPACE_URL, f"proposal-{index}")),
                "memoryId": memory_id,
                "status": "pending",
            })
        self.domain._append_jsonl(ledger, {
            **proposal,
            "proposalId": str(uuid.uuid5(uuid.NAMESPACE_URL, "duplicate")),
            "memoryId": generated_ids[0],
            "status": "pending",
        })
        self.domain._append_jsonl(ledger, {
            **proposal,
            "proposalId": str(uuid.uuid5(uuid.NAMESPACE_URL, "invalid")),
            "memoryId": "not-a-uuid",
            "status": "pending",
        })
        observed: list[list[str]] = []
        original = self.domain._metadata_rows_by_ids
        source_observed: list[list[str]] = []
        original_source = self.domain._knowledge_sources_by_ids

        def tracked_lookup(selector, memory_ids):
            result = original(selector, memory_ids)
            observed.append(result["queriedIds"])
            return result

        def tracked_source_lookup(selector, memory_ids):
            result = original_source(selector, memory_ids)
            source_observed.append(result["queriedIds"])
            return result

        self.domain._metadata_rows_by_ids = tracked_lookup
        self.domain._knowledge_sources_by_ids = tracked_source_lookup
        self.domain.config["schicht15"]["maxPromotionsPerRun"] = 0
        try:
            self.domain.propose_knowledge_promotions()
        finally:
            self.domain._metadata_rows_by_ids = original
            self.domain._knowledge_sources_by_ids = original_source
        self.assertEqual(observed, [[MEMORY_ID, *generated_ids[:99]]])
        self.assertEqual(source_observed, [[MEMORY_ID, *generated_ids[:99]]])
        events = [json.loads(line) for line in ledger.read_text().splitlines()]
        latest = self.domain._latest_knowledge_events(events, self.domain._scope_selector())
        pending_ids = {
            str(event.get("memoryId") or "")
            for event in latest.values() if event.get("status") == "pending"
        }
        self.assertTrue(set(generated_ids[99:]).issubset(pending_ids))
        self.assertIn("not-a-uuid", pending_ids)

    def test_foreign_lookup_row_cannot_retire_pending_evidence(self) -> None:
        proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
        ledger = self.domain.state_dir / "knowledge-promotions.jsonl"
        before = ledger.read_bytes()
        foreign = binding_from_scope("main", {"scopeType": "workspace", "workspace": "foreign"})
        original = self.domain._metadata_table
        source_table = original()
        row = source_table.to_arrow().to_pylist()[0]
        metadata = self.domain._metadata_json(row)
        metadata.update({"scopeKey": foreign.scope_key, "aclBindings": foreign.as_dict()})

        class Query:
            def where(self, predicate):
                return self

            def limit(self, count):
                return self

            def to_list(self):
                return [{**row, "metadataJson": json.dumps(metadata)}]

        class Table:
            def search(self):
                return Query()

            def to_arrow(self):
                return source_table.to_arrow()

        self.domain._metadata_table = lambda: Table()
        try:
            self.domain.propose_knowledge_promotions()
        finally:
            self.domain._metadata_table = original
        self.assertEqual(ledger.read_bytes(), before)

    def test_confirmation_is_idempotent(self) -> None:
        proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
        self.assertTrue(self.domain.confirm_knowledge_promotion(proposal["proposalId"])["confirmed"])
        path = self.domain.workspace_dir / "KNOWLEDGE.md"
        before = path.read_bytes()
        repeated = self.domain.confirm_knowledge_promotion(proposal["proposalId"])
        self.assertEqual(repeated.get("reason"), "already-confirmed")
        self.assertEqual(before, path.read_bytes())

    def test_daily_limit_expires_without_losing_lifetime_dedup(self) -> None:
        proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
        ledger = self.domain.state_dir / "knowledge-promotions.jsonl"
        now = datetime.now(timezone.utc)
        for index in range(3):
            self.domain._append_jsonl(ledger, {**proposal, "proposalId": f"old-{index}",
                "memoryId": f"619c3d51-1d9d-4736-8bf9-91b38aff824{index}", "status": "confirmed",
                "confirmedAt": now.isoformat()})
        result = self.domain.confirm_knowledge_promotion(proposal["proposalId"])
        self.assertFalse(result["confirmed"])
        self.assertEqual(result["reason"], "promotion-window-limit")
        self.assertFalse((self.domain.workspace_dir / "KNOWLEDGE.md").exists())
        rows = [json.loads(line) for line in ledger.read_text().splitlines()]
        for row in rows:
            if row.get("status") == "confirmed":
                row["confirmedAt"] = (now - timedelta(hours=25)).isoformat()
        ledger.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        self.assertTrue(self.domain.confirm_knowledge_promotion(proposal["proposalId"])["confirmed"])

    def test_disabled_feature_rejects_outstanding_confirmation(self) -> None:
        proposal = self.domain.propose_knowledge_promotions()["proposed"][0]
        self.domain.config["schicht15"]["enabled"] = False
        self.assertEqual(self.domain.confirm_knowledge_promotion(proposal["proposalId"])["reason"], "disabled")

    def test_knowledge_writer_rejects_dangling_or_ambiguous_managed_paths(self) -> None:
        target = self.root / "KNOWLEDGE.md"
        target.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError):
            knowledge.write_confirmed_knowledge(target, [{"id": MEMORY_ID, "text": "A durable fact."}])
        target.unlink()
        target.write_text(
            "manual\n<!-- plur1bus:knowledge:start -->\nold\n"
            "<!-- plur1bus:knowledge:end -->\n<!-- plur1bus:knowledge:end -->\n",
            encoding="utf-8",
        )
        original = target.read_text(encoding="utf-8")
        with self.assertRaises(ValueError):
            knowledge.write_confirmed_knowledge(target, [{"id": MEMORY_ID, "text": "A durable fact."}])
        self.assertEqual(target.read_text(encoding="utf-8"), original)

    def test_writer_preserves_manual_content_and_refuses_concurrent_revision(self) -> None:
        target = self.root / "KNOWLEDGE.md"
        target.write_text("# Manual\n\nnotes\n", encoding="utf-8")
        knowledge.write_confirmed_knowledge(target, [{"id": MEMORY_ID, "text": "A durable fact."}])
        self.assertIn("# Manual", target.read_text(encoding="utf-8"))
        original_replace = knowledge._write_unique_replace
        def raced(path, content, expected):
            path.write_text("manual edit", encoding="utf-8")
            return original_replace(path, content, expected)
        knowledge._write_unique_replace = raced
        try:
            with self.assertRaises(RuntimeError):
                knowledge.write_confirmed_knowledge(target, [{"id": MEMORY_ID, "text": "Changed durable fact."}])
        finally:
            knowledge._write_unique_replace = original_replace
        self.assertEqual(target.read_text(encoding="utf-8"), "manual edit")


if __name__ == "__main__":
    unittest.main()
