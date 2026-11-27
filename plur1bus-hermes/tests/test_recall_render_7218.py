"""Prompt-only recall adaptations from the 7.21 series."""

from pathlib import Path
import uuid

from plur1bus_hermes.runtime import Plur1busRuntime


def test_automatic_only_turn_merge_keeps_one_prompt_slot(tmp_path):
    runtime = Plur1busRuntime(Path(tmp_path), {"embedding": {"dimensions": 2}}, "default")
    runtime._embedding.embed = lambda *_args, **_kwargs: [0.1, 0.2]
    runtime._domain.on_memory = lambda *_args, **_kwargs: None
    turn = str(uuid.uuid4())
    try:
        runtime._remember("The installer checks archive paths", "older", "assistant", source_turn_id=turn)
        runtime._remember("The installer verifies the checksum", "older", "assistant", source_turn_id=turn)
        runtime._remember("Please review the installation", "older", "user", source_turn_id=turn)

        automatic = runtime.recall("installer", automatic=True)
        manual = runtime.recall("installer")

        assert "The installer checks archive paths\n\nThe installer verifies the checksum" in automatic
        assert "- Please review the installation" in automatic
        assert "- The installer checks archive paths" in manual
        assert "- The installer verifies the checksum" in manual
    finally:
        runtime.shutdown()


def test_turn_merge_respects_origin_and_claim_validity():
    from plur1bus_hermes.recall_origins import merge_turn_parts

    base = {
        "id": "best", "agentId": "agent", "scopeKey": "scope", "_namespace": "test",
        "sessionId": "old", "sourceRole": "user", "sourceTurnId": str(uuid.uuid4()),
        "content": "A whole captured statement", "createdAt": 1_700_000_000_200,
    }
    duplicate = dict(base, id="short", content="captured statement", createdAt=1_700_000_000_000)
    earlier = dict(base, id="earlier", content="Independent detail", createdAt=1_700_000_000_100)
    foreign = dict(base, id="other-scope", scopeKey="foreign", content="Other scope")
    different_session = dict(base, id="other-session", sessionId="new", content="Other session")
    historical = dict(base, id="historical", validUntil=1_600_000_000_000, content="Historical value")
    chunked = dict(base, id="chunk", chunkGroupId="part", content="A chunk")
    rows = [base, foreign, duplicate, earlier, different_session, historical, chunked]

    joined = merge_turn_parts(rows)

    assert joined[0]["id"] == "best"
    assert joined[0]["content"] == "Independent detail\n\nA whole captured statement"
    assert joined[1:] == [foreign, different_session, historical, chunked]
    assert rows[0]["content"] == "A whole captured statement"


def test_state_date_uses_capture_and_only_marks_old_operational_values(tmp_path, monkeypatch):
    runtime = Plur1busRuntime(Path(tmp_path), {"embedding": {"dimensions": 2}}, "default")
    runtime._embedding.embed = lambda *_args, **_kwargs: [0.1, 0.2]
    runtime._domain.on_memory = lambda *_args, **_kwargs: None
    try:
        with monkeypatch.context() as patch:
            patch.setattr("plur1bus_hermes.runtime._utcnow", lambda: "2020-11-12T12:00:00+00:00")
            runtime._remember("Im Gateway läuft 7.12.61", "older", "user")
            runtime._remember('Ein Test zitiert "läuft 7.12.61"', "older", "user")
            runtime._remember("Image example:latest version 7.12.61", "older", "user")
        runtime._remember("Ein neues Gateway läuft 7.21.8", "newer", "user")

        result = runtime.recall("Gateway")

        assert "STATE AS OF:" in result
        assert "Im Gateway läuft [Stand 12.11.2020] 7.12.61" in result
        assert result.count("[Stand 12.11.2020]") == 1
        assert "Ein neues Gateway läuft 7.21.8" in result
        assert "valid-from" not in result
    finally:
        runtime.shutdown()
