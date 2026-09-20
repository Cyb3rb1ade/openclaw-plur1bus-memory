"""Native segmentation parity and lossless/retry invariants."""
import re
import uuid

import pytest

from plur1bus_hermes.chunking import capture_options, capture_rows, plan_chunks


@pytest.mark.parametrize("text", [
    "Urgent diagnosis applies to all:\n- No.\n- First sufficiently long detail.\n- Yes.\n- Final sufficiently long detail.",
    "\n\n".join(["No.", "One sufficiently long sentence.", "Yes.", "Another sufficiently long sentence."]),
    " ".join(f"Sentence number {i} has content." for i in range(100)),
    "# Context\nShort.\n# First heading\nFirst significant fact.\n# Second heading\nSecond significant fact.\n# Third heading\nLast fact.",
])
def test_split_is_bounded_and_lossless(text):
    parts = plan_chunks(text)
    assert 2 <= len(parts) <= 20
    assert re.sub(r"\s+", "", "".join(parts)) == re.sub(r"\s+", "", text)


def test_short_and_decimal_text_stays_whole():
    text = "Version 3.5 measures 4.2 mmol/l. Still the same topic."
    assert plan_chunks(text) == [text]


def test_modes_and_stable_scoped_identity():
    text = "\n".join(f"- Significant statement number {i}." for i in range(4))
    args = dict(capture_id=str(uuid.uuid4()), agent_id="main", scope_key="scope", role="user")
    opts = capture_options({})
    first = capture_rows(text, options=opts, **args)
    assert first == capture_rows(text, options=opts, **args)
    assert len(first) == 5
    assert first[0]["content"] == text and first[0]["chunkGroupId"] == ""
    assert len({r["chunkGroupId"] for r in first[1:]}) == 1
    assert len({r["id"] for r in first}) == 5
    assert first != capture_rows(text, options=opts, **{**args, "scope_key": "other"})
    assert len(capture_rows(text, options={**opts, "keepWhole": False}, **args)) == 4
    assert len(capture_rows(text, options={**opts, "enabled": False}, **args)) == 1
    for bad in ({}, {**opts, "version": True}, {**opts, "enabled": "yes"}):
        with pytest.raises(ValueError):
            capture_rows(text, options=bad, **args)


def test_upstream_configuration_keys():
    assert capture_options({"captureChunking": False})["enabled"] is False
    assert capture_options({"captureChunkingMode": "geteilt"})["keepWhole"] is False


def test_real_capture_retry_keeps_groups_expiry_and_profile_isolation(tmp_path):
    from plur1bus_hermes.runtime import Plur1busRuntime
    from plur1bus_hermes.turn_identity import mint_capture_identity

    runtime = Plur1busRuntime(tmp_path, {"dataDir": "plur1bus", "agentId": "main",
        "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
        "reranker": {"provider": "disabled"}}, "main")
    class Embedding:
        calls = 0
        failed = False
        def embed(self, text):
            self.calls += 1
            if self.calls == 3 and not self.failed:
                self.failed = True
                raise RuntimeError("partial capture failure")
            return [0.1, 0.2, 0.3, 0.4]
        def close(self):
            pass
    runtime._embedding = Embedding()
    text = "\n".join(f"- Significant statement number {i}." for i in range(4))
    capture_id, captured_at = mint_capture_identity()
    payload = {"chunkingPlan": capture_options(runtime.config)}
    kwargs = dict(capture_id=capture_id, captured_at=captured_at, capture_payload=payload, ttl="short")
    try:
        with pytest.raises(RuntimeError, match="partial capture"):
            runtime._capture_turn(text, "", "session", **kwargs)
        runtime.config["captureChunking"] = False
        runtime._capture_turn(text, "", "session", **kwargs)
        table, _ = runtime._table(create=False)
        rows = table.to_arrow().to_pylist()
        assert len(rows) == 5
        assert len({row["id"] for row in rows}) == 5
        assert len({row["expiresAt"] for row in rows}) == 1
        assert all(row["agentId"] == "main" and row["scopeKey"] == runtime.scope_key for row in rows)
        assert len({row["sourceTurnId"] for row in rows}) == 1
        assert sum(bool(row["chunkGroupId"]) for row in rows) == 4
        runtime._capture_turn(text, "", "session", **kwargs)
        assert table.count_rows() == 5
    finally:
        runtime.shutdown()


def test_parent_trust_and_tombstone_apply_to_every_child(tmp_path):
    from plur1bus_hermes.runtime import Plur1busRuntime
    runtime = Plur1busRuntime(tmp_path, {"embedding": {"provider": "omlx", "model": "x", "dimensions": 4}}, "main")
    runtime._embedding.embed = lambda text: [0.1, 0.2, 0.3, 0.4]
    text = "[Subagent Context]\n" + "\n".join(f"- Independent statement number {i}." for i in range(4))
    try:
        runtime._capture_turn(text, "", "s")
        table, _ = runtime._table(create=False)
        rows = table.to_arrow().to_pylist()
        assert len(rows) >= 5
        assert all(row["epistemicStatus"] == "untrusted" for row in rows)
        whole = next(row for row in rows if not row["chunkGroupId"])
        assert runtime.forget(whole["id"])
        before = table.count_rows()
        runtime.config["captureChunkingMode"] = "geteilt"
        runtime._capture_turn(text, "", "s2")
        assert table.count_rows() == before
    finally:
        runtime.shutdown()
