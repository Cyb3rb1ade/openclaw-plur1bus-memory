"""Tests for confirmation-gated private Schicht 1.5 promotions."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import lancedb

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes import knowledge
from plur1bus_hermes.namespaces import binding_from_scope


MEMORY_ID = "619c3d51-1d9d-4736-8bf9-91b38aff8246"


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
                "text": "The deploy process requires a preflight backup before migration.",
                "type": "fact",
                "importance": 0.9,
            }),
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
        table = self.domain._metadata_table()
        metadata = self.domain._metadata_json(table.to_arrow().to_pylist()[0])
        metadata["text"] = "Changed after review."
        table.update(where=f"id = '{MEMORY_ID}'", values={"metadataJson": json.dumps(metadata)})
        result = self.domain.confirm_knowledge_promotion(proposal["proposalId"])
        self.assertFalse(result["confirmed"])
        self.assertEqual(result["reason"], "proposal-stale")

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
