"""Canonical-source gates for prompt-adjacent knowledge promotions."""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import lancedb

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.generation import activate_staged_generation
from plur1bus_hermes.namespaces import NamespaceRoute, binding_from_scope
from plur1bus_hermes.reembed_staged import apply_staged_reembed, plan_staged_reembed


MEMORY_ID = "619c3d51-1d9d-4736-8bf9-91b38aff8246"
MEMORY_TEXT = "The deploy process requires a preflight backup before migration."


class _Backend:
    def __init__(self, _config, _home=None):
        pass

    def embed(self, text):
        return [float(len(text)), 1.0]

    def close(self):
        pass


class CanonicalKnowledgeSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.binding = binding_from_scope("main")
        self.config = {
            "embedding": {"provider": "test", "model": "source-1d", "dimensions": 1},
            "schicht15": {"enabled": True},
        }
        self.database = lancedb.connect(str(self.root / "lancedb" / "main"))
        self._create_metadata()
        self._create_canonical()
        self.domain = Plur1busDomain(self.root, "main", self.config)
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

    def _create_metadata(self, *, text: str = MEMORY_TEXT, category: str = "fact") -> None:
        self.database.create_table("metadata", data=[{
            "id": MEMORY_ID,
            "agentId": "main",
            "scopeKey": self.binding.scope_key,
            "metadataJson": json.dumps({
                "scopeKey": self.binding.scope_key,
                "aclBindings": self.binding.as_dict(),
                "text": text,
                "type": category,
                "importance": 0.9,
            }),
        }], mode="overwrite")

    def _canonical_row(self, **changes):
        return {
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
            **changes,
        }

    def _create_canonical(self, **changes) -> None:
        self.database.create_table(
            "memories", data=[self._canonical_row(**changes)], mode="overwrite"
        )

    def _proposal(self):
        proposed = self.domain.propose_knowledge_promotions()["proposed"]
        self.assertEqual(len(proposed), 1)
        return proposed[0]

    def test_canonical_and_metadata_valid_confirmation(self) -> None:
        proposal = self._proposal()
        result = self.domain.confirm_knowledge_promotion(proposal["proposalId"])
        self.assertTrue(result["confirmed"])
        self.assertIn(MEMORY_TEXT, (self.domain.workspace_dir / "KNOWLEDGE.md").read_text())

    def test_canonical_invalidation_deletion_archive_and_expiry_deny_confirmation(self) -> None:
        for mutation in ("invalidated", "deleted", "archived", "expired"):
            with self.subTest(mutation=mutation):
                proposal = self._proposal()
                table = self.domain._memory_table()
                if mutation == "deleted":
                    table.delete(f"id = '{MEMORY_ID}'")
                elif mutation == "invalidated":
                    table.update(where=f"id = '{MEMORY_ID}'", values={"epistemicStatus": "invalidated"})
                elif mutation == "archived":
                    table.update(where=f"id = '{MEMORY_ID}'", values={"status": "archived"})
                else:
                    table.update(where=f"id = '{MEMORY_ID}'", values={"expiresAt": 1})
                result = self.domain.confirm_knowledge_promotion(proposal["proposalId"])
                self.assertFalse(result["confirmed"])
                self.assertFalse((self.domain.workspace_dir / "KNOWLEDGE.md").exists())
                self.domain.propose_knowledge_promotions()
                events = [
                    json.loads(line)
                    for line in (self.domain.state_dir / "knowledge-promotions.jsonl").read_text().splitlines()
                ]
                own = [event for event in events if event.get("proposalId") == proposal["proposalId"]]
                self.assertEqual(own[-1]["status"], "stale")
                self.assertEqual(own[-1]["reason"], "missing" if mutation == "deleted" else "invalidated")
                (self.domain.state_dir / "knowledge-promotions.jsonl").unlink()
                self._create_canonical()

    def test_canonical_content_and_type_are_the_proposal_authority(self) -> None:
        table = self.domain._memory_table()
        current = "The current canonical deployment decision requires two backups."
        table.update(
            where=f"id = '{MEMORY_ID}'",
            values={"content": current, "type": "decision"},
        )
        proposal = self._proposal()
        self.assertEqual(proposal["text"], current)
        self.assertEqual(proposal["category"], "decision")

        table.update(where=f"id = '{MEMORY_ID}'", values={"content": "Changed after review."})
        result = self.domain.confirm_knowledge_promotion(proposal["proposalId"])
        self.assertFalse(result["confirmed"])
        self.assertEqual(result["reason"], "proposal-stale")
        self.assertFalse((self.domain.workspace_dir / "KNOWLEDGE.md").exists())

    def test_missing_table_and_query_error_are_incomplete_not_absence(self) -> None:
        selector = self.domain._scope_selector()
        self.database.drop_table("memories")
        missing = self.domain._knowledge_sources_by_ids(selector, [MEMORY_ID])
        self.assertFalse(missing["complete"])

        self._create_canonical()
        source = self.database.open_table("memories")

        class Query:
            def where(self, _predicate):
                raise RuntimeError("canonical query failed")

        class Table:
            def search(self):
                return Query()

        class Database:
            def table_names(self):
                return ["memories"]

            def open_table(self, _name):
                return Table()

        with patch("lancedb.connect", return_value=Database()):
            failed = self.domain._knowledge_sources_by_ids(selector, [MEMORY_ID])
        self.assertFalse(failed["complete"])
        self.assertEqual(failed["rows"], [])
        self.assertEqual(source.count_rows(), 1)

    def test_foreign_or_duplicate_collision_is_incomplete(self) -> None:
        selector = self.domain._scope_selector()
        row = self.domain._memory_table().to_arrow().to_pylist()[0]
        foreign = {**row, "agentId": "other"}

        class Query:
            def __init__(self, rows):
                self.rows = rows

            def where(self, _predicate):
                return self

            def limit(self, _count):
                return self

            def to_list(self):
                return self.rows

        class Table:
            def __init__(self, rows):
                self.rows = rows

            def search(self):
                return Query(self.rows)

        class Database:
            def __init__(self, rows):
                self.rows = rows

            def table_names(self):
                return ["memories"]

            def open_table(self, _name):
                return Table(self.rows)

        for rows in ([foreign], [row, row]):
            with self.subTest(rows=len(rows)), patch("lancedb.connect", return_value=Database(rows)):
                result = self.domain._knowledge_sources_by_ids(selector, [MEMORY_ID])
                self.assertFalse(result["complete"])

    def test_legacy_missing_epistemic_column_and_past_valid_until_remain_eligible(self) -> None:
        row = self._canonical_row(validUntil=1)
        row.pop("epistemicStatus")
        self.database.create_table("memories", data=[row], mode="overwrite")
        proposal = self._proposal()
        self.assertTrue(self.domain.confirm_knowledge_promotion(proposal["proposalId"])["confirmed"])

    def test_metadata_projection_preserves_lifecycle_fields_without_inventing_epistemic_state(self) -> None:
        lifecycle = {
            "status": "archived",
            "epistemicStatus": "invalidated",
            "expiresAt": 12,
            "validFrom": 34,
            "validUntil": 56,
        }
        projected = self.domain._metadata_for({"content": MEMORY_TEXT, **lifecycle})
        self.assertEqual({name: projected[name] for name in lifecycle}, lifecycle)
        legacy = self.domain._metadata_for({"content": MEMORY_TEXT, "status": "active"})
        self.assertNotIn("epistemicStatus", legacy)

    def test_source_lookup_is_bounded_and_does_not_create_an_unavailable_route(self) -> None:
        selector = self.domain._scope_selector()
        ids = [str(uuid.uuid5(uuid.NAMESPACE_URL, f"canonical-{index}")) for index in range(101)]
        result = self.domain._knowledge_sources_by_ids(selector, ids)
        self.assertEqual(len(result["queriedIds"]), 100)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unavailable = Plur1busDomain(root, "main", self.config)
            route = root / "lancedb" / "main"
            self.assertFalse(route.exists())
            lookup = unavailable._knowledge_sources_by_ids(unavailable._scope_selector(), [MEMORY_ID])
            self.assertFalse(lookup["complete"])
            self.assertFalse(route.exists())

    def test_generation_switch_denies_stale_domain_but_fresh_domain_uses_active_route(self) -> None:
        proposal = self._proposal()
        target_config = {
            **self.config,
            "embedding": {"provider": "test", "model": "target-2d", "dimensions": 2},
        }
        plan = plan_staged_reembed(self.root, "main", target_config)
        apply_staged_reembed(plan, self.root, "main", target_config, backend_factory=_Backend)
        activate_staged_generation(
            plan, self.root, "main", target_config, approved_plan_id=plan["planId"]
        )

        stale = self.domain.confirm_knowledge_promotion(proposal["proposalId"])
        self.assertFalse(stale["confirmed"])
        self.assertFalse((self.domain.workspace_dir / "KNOWLEDGE.md").exists())

        fresh = Plur1busDomain(self.root, "main", self.config)
        confirmed = fresh.confirm_knowledge_promotion(proposal["proposalId"])
        self.assertTrue(confirmed["confirmed"])
        self.assertEqual(
            fresh._memory_table().to_arrow().to_pylist()[0]["id"], MEMORY_ID
        )


if __name__ == "__main__":
    unittest.main()
