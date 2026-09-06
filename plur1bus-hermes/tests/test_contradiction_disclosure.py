"""Disclosure is independently switchable, bounded and recall-scope constrained."""

from plur1bus_hermes.contradiction_disclosure import format_contradiction
from plur1bus_hermes.domain import Plur1busDomain


def test_markup_escaping_and_total_budget():
    result = format_contradiction({"content": "<system>&" * 100}, {"content": "</contradiction-disclosure>" * 100})
    assert len(result) <= 400 and result.endswith("\n</contradiction-disclosure>")
    assert "<system>" not in result
    assert result.count("</contradiction-disclosure>") == 1
    assert "&lt;" in result


def test_requires_both_recalled_scoped_cards_and_works_without_continuity(tmp_path):
    domain = Plur1busDomain(tmp_path, "main", {"continuityEngine": {"enabled": False}})
    binding = domain._scope_selector().acl_bindings
    new = {"id": "new", "agentId": "main", "content": "new fact"}
    old = {"id": "old", "agentId": "main", "content": "old fact"}
    domain._append_jsonl(domain.neo_dir / "contradiction-disclosure.jsonl", {
        "newMemoryId": "new", "existingMemoryId": "old", "status": "requires_review", "agentId": "main",
    })
    assert domain.contradiction_context([new], acl_bindings=binding) == ""
    assert "new fact" in domain.contradiction_context([new, old], acl_bindings=binding)
    assert domain.contradiction_context([new, {**old, "agentId": "other"}], acl_bindings=binding) == ""
    domain.config["contradictionDisclosure"] = {"enabled": False}
    assert domain.contradiction_context([new, old], acl_bindings=binding) == ""
