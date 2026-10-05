import json
from types import SimpleNamespace
from unittest.mock import patch
import pytest
from plur1bus_hermes.inject_markers import is_injected_context_text
from plur1bus_hermes.jev_chunk_decider import storage_for_answer, decide_storage
from plur1bus_hermes.recall_origins import prefer_whole_rows, recall_text


@pytest.mark.parametrize("text", [
    "[System] Your previous turn was interrupted by a gateway restart",
    "[Queued user message from a previous active turn; preserved as context only.] old text",
    "User: <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> runtime-generated",
    "This content was routed by OpenClaw from another session",
    "Conversation info: ⟦openclaw:ctx⟧",
])
def test_host_notices_remain_ineligible(text):
    assert is_injected_context_text(text)
    assert not is_injected_context_text("Der Gateway wurde heute neu gestartet.")


@pytest.mark.parametrize("choice,confidence,expected", [
    ("coherent", 1, "whole"), ("independent", .85, "parts"),
    ("coherent", .84, "both"), ("mixed", 1, "both"),
    ("independent", float("nan"), "both"),
])
def test_jev_confidence_preserves_uncertain_content(choice, confidence, expected):
    assert storage_for_answer({"choice": choice, "confidence": confidence}) == expected


def test_jev_uses_env_reference_and_fixed_endpoint(monkeypatch):
    monkeypatch.setenv("TEST_JEV_KEY", "fixture-secret")
    response = SimpleNamespace(read=lambda size: json.dumps({"answers": {"structure": {
        "choice": "coherent", "confidence": 1}}}).encode())
    class Context:
        def __enter__(self): return response
        def __exit__(self, *args): pass
    with patch("plur1bus_hermes.jev_chunk_decider.urlopen", return_value=Context()) as call:
        assert decide_storage("a recipe", {"captureChunkingJev": {"apiKeyEnv": "TEST_JEV_KEY"}}) == "whole"
        assert call.call_args.args[0].full_url == "https://api.typesafe.ai/v1/systemone"
        assert call.call_args.kwargs["timeout"] == 5
    monkeypatch.delenv("TEST_JEV_KEY")
    with patch("plur1bus_hermes.jev_chunk_decider.urlopen") as call:
        assert decide_storage("recipe", {"captureChunkingJev": {"apiKeyEnv": "TEST_JEV_KEY"}}) == "both"
        call.assert_not_called()


def test_origin_replaces_children_without_reordering_other_hits():
    part = {"id": "p", "sourceTurnId": "t", "chunkGroupId": "g", "content": "part"}
    whole = {"id": "w", "sourceTurnId": "t", "content": "whole"}
    unrelated = {"id": "u", "content": "other"}
    assert prefer_whole_rows([part, unrelated, whole]) == [whole, unrelated]
    historical = dict(part, validFrom=100, validUntil=200)
    later = dict(whole, validFrom=300, validUntil=400)
    assert prefer_whole_rows([historical, later]) == [historical, later]


def test_full_top_hits_and_explicit_truncation():
    row = {"content": "x" * 4000}
    assert len(recall_text(row, 0)) == 4000
    assert recall_text(row, 3).endswith(" [gekürzt]")
    assert recall_text(row, 3, True) == row["content"]


def test_user_diary_requires_explicit_light_opt_in(tmp_path):
    from plur1bus_hermes.dream_diary import append_dream_diary_entry
    scope = {"scopeType": "user", "platform": "telegram", "user": "fixture"}
    args = dict(workspace_dir=tmp_path, agent_id="main", narrative="A tentative theme.", scope=scope)
    assert not append_dream_diary_entry(**args, mode="light")["written"]
    assert not append_dream_diary_entry(**args, mode="rem", allow_user_chats=True)["written"]
    assert append_dream_diary_entry(**args, mode="light", allow_user_chats=True)["written"]


def test_workspace_review_counts_pending_without_exposing_text(tmp_path):
    from plur1bus_hermes.workspace_review import collect_workspace_status
    (tmp_path / "memory").mkdir()
    (tmp_path / "memory/KNOWLEDGE.md").write_text("secret knowledge")
    (tmp_path / ".adaptive-learning").mkdir()
    (tmp_path / ".adaptive-learning/knowledge-pending.json").write_text(json.dumps({"pending": [{"text": "private"}]}))
    result = collect_workspace_status(tmp_path)
    assert result["knowledge"]["pending"] == 1
    assert "secret" not in json.dumps(result) and "private" not in json.dumps(result)


def test_automatic_retry_reuses_admitted_decision(tmp_path, monkeypatch):
    from plur1bus_hermes.runtime import Plur1busRuntime
    from plur1bus_hermes.namespaces import binding_from_scope
    from plur1bus_hermes.chunking import capture_options
    from plur1bus_hermes.turn_identity import mint_capture_identity
    binding = binding_from_scope("main", None)
    config = {"captureChunkingMode": "automatisch"}
    payload = {"chunkingPlan": capture_options(config)}
    captured = []
    calls = []
    monkeypatch.setattr("plur1bus_hermes.jev_chunk_decider.decide_storage",
                        lambda *args: calls.append(args) or "whole")
    fake = SimpleNamespace(config=config, agent_id="main", scope_key=binding.scope_key,
        scope_binding=binding, data_dir=tmp_path, request_scope={},
        _domain=SimpleNamespace(on_turn=lambda *args, **kwargs: None),
        _epistemic_cutoff={"ok": True}, _log_capture_error=lambda error: None,
        _remember=lambda text, *args, **kwargs: captured.append(text))
    capture_id, captured_at = mint_capture_identity()
    text = "\n".join(f"- Independent significant point number {i}." for i in range(4))
    for _ in range(2):
        Plur1busRuntime._capture_turn(fake, text, "", "s", capture_id=capture_id,
            captured_at=captured_at, capture_payload=payload)
    assert len(calls) == 1
    assert captured.count(text) == 2
    assert payload["chunkingDecisions"]["user"] == "whole"


def test_host_recovery_never_enters_journal_or_store():
    from plur1bus_hermes.runtime import Plur1busRuntime
    # No runtime services exist: any journal, embedding or store access fails.
    Plur1busRuntime._capture_turn(SimpleNamespace(),
        "[System] Your previous turn was interrupted by a gateway restart", "resuming", "s")
