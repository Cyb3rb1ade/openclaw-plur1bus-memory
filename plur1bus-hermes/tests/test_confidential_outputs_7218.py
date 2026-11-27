from pathlib import Path

from plur1bus_hermes.dream_diary import append_dream_diary_entry
from plur1bus_hermes.encoding import refine_patch
from plur1bus_hermes.knowledge import is_eligible


def test_confidential_legacy_memory_does_not_enter_knowledge():
    candidate = {"type": "fact", "text": "The account number is associated with the household.", "importance": 0.9}
    assert not is_eligible(candidate, {"factQuality": 0.9}, 0.7)


def test_confidential_dream_does_not_create_prompt_file(tmp_path: Path):
    result = append_dream_diary_entry(workspace_dir=tmp_path, agent_id="main",
                                      narrative="I dreamed my passport number was on the wall.")
    assert result == {"written": False, "code": "confidential_narrative"}
    assert not (tmp_path / "DREAMS.md").exists()


def test_model_cannot_downgrade_a_confidential_rule_result():
    patch = refine_patch({"sensitivity": "confidential", "sensitivitySource": "rules"},
                         {"importance": 0.7, "sensitivity": "banal"}, 1)
    assert "sensitivity" not in patch
    clean = refine_patch({}, {"importance": 0.7, "sensitivity": "personal"}, 1)
    assert clean["sensitivity"] == "personal"
    assert clean["sensitivitySource"] == "llm"
