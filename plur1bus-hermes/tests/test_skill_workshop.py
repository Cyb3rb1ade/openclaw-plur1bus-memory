"""Security regressions for native Hermes Skill Workshop publication."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from plur1bus_hermes.namespaces import ScopeBinding
from plur1bus_hermes.skill_workshop import SkillWorkshop
from plur1bus_hermes.validation import ValidationError


class _Query:
    def __init__(self, rows):
        self.rows = rows

    def where(self, _clause):
        return self

    def limit(self, _limit):
        return self

    def to_list(self):
        return list(self.rows)


class _Table:
    def __init__(self, rows):
        self.rows = rows

    def search(self):
        return _Query(self.rows)


class _Backend:
    def __init__(self, candidates):
        self.candidates = candidates

    def available(self):
        return True

    def complete_json(self, *_args):
        return {"candidates": self.candidates}


def _runtime(root: Path, binding: ScopeBinding, rows: list[dict], candidates=None):
    return SimpleNamespace(
        agent_id=binding.agent_id, scope_binding=binding, data_dir=root,
        _table=lambda create=False: (_Table(rows), False),
        config={"skillWorkshop": {"enabled": True}},
        _domain=SimpleNamespace(_llm_backend=_Backend(candidates or [])),
    )


def _row(binding, identifier, kind="fact", content=None, **extra):
    return {
        "id": identifier, "type": kind, "content": content or f"evidence {identifier}",
        "status": "active", "sourceRole": "user", "agentId": binding.agent_id,
        "scopeKey": binding.scope_key, **extra,
    }


def _candidate(title="Use the scoped procedure", evidence=("a", "b")):
    return [{
        "title": title, "description": "A bounded procedure supported by the selected evidence.",
        "instructions": "Verify current facts before using this procedure.",
        "evidenceIds": list(evidence),
    }]


class SkillWorkshopTests(unittest.TestCase):
    def test_mining_is_scope_bound_and_never_publishes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binding = ScopeBinding("main")
            workshop = SkillWorkshop(_runtime(root, binding, [
                _row(binding, "a", "decision"), _row(binding, "b", "decision"),
                _row(binding, "ignored", "decision", status="archived"),
            ], _candidate()))
            result = workshop.mine()
            self.assertEqual(result["created"], 1)
            proposal = workshop.inspect(result["proposals"][0]["id"])
            self.assertEqual(proposal["scopeKey"], binding.scope_key)
            self.assertEqual([item["id"] for item in proposal["evidence"]], ["a", "b"])
            self.assertEqual(proposal["status"], "pending_review")
            self.assertFalse((root / "skills").exists())

    def test_approval_and_publish_require_exact_revision_and_are_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binding = ScopeBinding("main")
            workshop = SkillWorkshop(_runtime(root / "data", binding, [
                _row(binding, "a"), _row(binding, "b"),
            ], _candidate()))
            proposal = workshop.mine()["proposals"][0]
            with self.assertRaises(ValidationError):
                workshop.publish(proposal["id"], proposal["revision"], root / "hermes")
            with self.assertRaises(ValidationError):
                workshop.approve(proposal["id"], "0" * 64)
            self.assertTrue(workshop.approve(proposal["id"], proposal["revision"])["approved"])
            published = workshop.publish(proposal["id"], proposal["revision"], root / "hermes")
            self.assertTrue(published["published"])
            path = root / "hermes" / "skills" / "plur1bus-main-use-the-scoped-procedure" / "SKILL.md"
            self.assertTrue(path.is_file())
            self.assertIn(proposal["revision"], path.read_text(encoding="utf-8"))

    def test_shared_scope_cannot_publish_to_global_hermes_skills(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binding = ScopeBinding("main", "chat", platform="telegram", chat_id="room")
            workshop = SkillWorkshop(_runtime(root / "data", binding, [
                _row(binding, "a"), _row(binding, "b"),
            ], _candidate()))
            proposal = workshop.mine()["proposals"][0]
            workshop.approve(proposal["id"], proposal["revision"])
            with self.assertRaisesRegex(ValidationError, "unavailable for shared"):
                workshop.publish(proposal["id"], proposal["revision"], root / "hermes")

    def test_tool_generated_records_are_not_skill_mining_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binding = ScopeBinding("main")
            workshop = SkillWorkshop(_runtime(Path(directory), binding, [
                _row(binding, "a", sourceRole="tool"), _row(binding, "b", sourceRole="merge"),
            ], _candidate()))
            self.assertEqual(workshop.mine(), {"created": 0, "proposals": []})

    def test_invalid_backend_candidate_does_not_fall_back_to_generic_type_skill(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binding = ScopeBinding("main")
            workshop = SkillWorkshop(_runtime(Path(directory), binding, [
                _row(binding, "a"), _row(binding, "b"),
            ], _candidate(evidence=("a", "missing"))))
            self.assertEqual(workshop.mine(), {"created": 0, "proposals": []})

    def test_evidence_change_or_deletion_invalidates_approval(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binding = ScopeBinding("main")
            rows = [_row(binding, "a"), _row(binding, "b")]
            workshop = SkillWorkshop(_runtime(Path(directory), binding, rows, _candidate()))
            proposal = workshop.mine()["proposals"][0]
            rows[0]["content"] = "changed evidence"
            with self.assertRaisesRegex(ValidationError, "evidence changed"):
                workshop.approve(proposal["id"], proposal["revision"])
            rows[0]["content"] = "evidence a"
            rows.pop()
            with self.assertRaisesRegex(ValidationError, "evidence changed"):
                workshop.approve(proposal["id"], proposal["revision"])

    def test_publish_refuses_manual_target_and_detects_changed_published_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binding = ScopeBinding("main")
            workshop = SkillWorkshop(_runtime(root / "data", binding, [_row(binding, "a"), _row(binding, "b")], _candidate()))
            proposal = workshop.mine()["proposals"][0]
            workshop.approve(proposal["id"], proposal["revision"])
            target = root / "hermes" / "skills" / "plur1bus-main-use-the-scoped-procedure" / "SKILL.md"
            target.parent.mkdir(parents=True)
            target.write_text("manual skill", encoding="utf-8")
            with self.assertRaisesRegex(ValidationError, "manual content"):
                workshop.publish(proposal["id"], proposal["revision"], root / "hermes")
            target.unlink()
            workshop.publish(proposal["id"], proposal["revision"], root / "hermes")
            target.write_text("changed after publish", encoding="utf-8")
            with self.assertRaisesRegex(ValidationError, "missing or was changed"):
                workshop.publish(proposal["id"], proposal["revision"], root / "hermes")


if __name__ == "__main__":
    unittest.main()
