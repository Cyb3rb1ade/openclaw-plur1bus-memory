"""Raw storage and reproducible per-row envelope cleanup."""

from pathlib import Path
from unittest.mock import patch

import lancedb
import pytest

from plur1bus_hermes.reembed import reembed
from plur1bus_hermes.reembed_staged import apply_staged_reembed, plan_staged_reembed
from plur1bus_hermes.runtime import Plur1busRuntime


_RAW_OLD = '[Audio transcript (machine-generated)] Alice: Legacy vector input'
_RAW_NEW = '[Audio transcript (machine-generated)] Alice: New vector input'
_CONFIG = {"embedding": {"provider": "test", "model": "fixture-model", "dimensions": 2}}


def _write(runtime, text, inputs):
    runtime._embedding.embed = lambda value, **_kw: inputs.append(value) or [0.1, 0.2]
    runtime._domain.on_memory = lambda *_args, **_kwargs: None
    return runtime._remember(text, "session", "user")


def test_opted_in_writer_adds_mode_without_altering_legacy_text_or_vectors(tmp_path):
    inputs = []
    runtime = Plur1busRuntime(tmp_path, _CONFIG, "default")
    try:
        old_id = _write(runtime, _RAW_OLD, inputs)
        table, _ = runtime._table(create=False)
        original_vector = table.search().limit(1).to_list()[0]["vector"]
        assert "embeddingTextMode" not in table.schema.names
    finally:
        runtime.shutdown()
    config = {"embedding": {**_CONFIG["embedding"], "cleanText": {"enabled": True, "stripSpeaker": True}}}
    runtime = Plur1busRuntime(tmp_path, config, "default")
    try:
        new_id = _write(runtime, _RAW_NEW, inputs)
        table, _ = runtime._table(create=False)
        cards = {row["id"]: row for row in table.to_arrow().to_pylist()}
        assert inputs == [_RAW_OLD, "New vector input"]
        assert cards[old_id]["content"] == _RAW_OLD
        assert cards[old_id]["vector"] == original_vector
        assert cards[old_id]["embeddingTextMode"] == "raw"
        assert cards[new_id]["content"] == _RAW_NEW
        assert cards[new_id]["embeddingTextMode"] == "hermes-envelope-v1-nospeaker"
    finally:
        runtime.shutdown()


@pytest.mark.parametrize("stage", [False, True])
def test_reembedding_uses_stored_mode_even_after_opt_in_is_disabled(tmp_path, stage):
    agent_dir = tmp_path / "lancedb" / "default"
    agent_dir.mkdir(parents=True)
    lancedb.connect(str(agent_dir)).create_table("memories", data=[
        {"id": "a", "content": _RAW_OLD, "embeddingTextMode": None, "vector": [0.0]},
        {"id": "b", "content": _RAW_NEW, "embeddingTextMode": "hermes-envelope-v1-nospeaker", "vector": [0.0]},
    ])
    inputs = []

    class Backend:
        def __init__(self, *_args): pass
        def embed(self, text):
            inputs.append(text)
            return [0.2, 0.3]
        def close(self): pass

    if stage:
        plan = plan_staged_reembed(tmp_path, "default", _CONFIG)
        result = apply_staged_reembed(plan, tmp_path, "default", _CONFIG, backend_factory=Backend)
        target = Path(result["targetRoute"])
    else:
        with patch("plur1bus_hermes.reembed.EmbeddingBackend", Backend):
            reembed(tmp_path, "default", _CONFIG, apply=True)
        target = agent_dir
    rows = lancedb.connect(str(target)).open_table("memories").to_arrow().to_pylist()
    assert sorted(inputs) == sorted([_RAW_OLD, "New vector input"])
    assert {row["content"] for row in rows} == {_RAW_OLD, _RAW_NEW}
    assert {row["embeddingTextMode"] for row in rows} == {None, "hermes-envelope-v1-nospeaker"}



def test_vector_copy_import_retains_source_preprocessing(tmp_path):
    from plur1bus_hermes.migrate import _copy_agent_cards

    snapshot, target = tmp_path / "snapshot", tmp_path / "target"
    source = snapshot / "lancedb-namespaced" / "source"
    source.mkdir(parents=True)
    lancedb.connect(str(source)).create_table("memories", data=[
        {"id": "e00f7fde-2e6b-4ba4-ad45-2833959f49a4", "content": _RAW_OLD,
         "embeddingTextMode": "", "vector": [0.1, 0.2]},
        {"id": "88134e02-2162-495f-8af0-18efe6443894", "content": _RAW_NEW,
         "embeddingTextMode": "clean-v1", "vector": [0.3, 0.4]},
    ])
    _copy_agent_cards(snapshot, target, "source", "default")
    imported = lancedb.connect(str(target / "lancedb" / "default")).open_table("memories").to_arrow().to_pylist()
    assert {row["content"]: row["embeddingTextMode"] for row in imported} == {
        _RAW_OLD: "raw", _RAW_NEW: "clean-v1",
    }


def test_unknown_explicit_embedding_mode_does_not_return_raw_for_regeneration():
    from plur1bus_hermes.embedding_text import prepare_embedding_text
    from plur1bus_hermes.validation import ValidationError

    with pytest.raises(ValidationError, match="unsupported stored embedding text mode"):
        prepare_embedding_text("legacy foreign input", "unknown-format")


@pytest.mark.parametrize(("content", "cleaned"), [
    ("[Audio transcript (machine-generated)]: \"Alice: Ähm, send the draft (lacht).\"", "send the draft."),
    ("User: Talk Mode active. Reply in a concise, spoken tone.\n\nÄhm, der Plan steht.", "der Plan steht."),
    ("Egbert Ehm uses 100 hm, hm.com, ERM-model and [Musik](https://example.org).",
     "Egbert Ehm uses 100 hm, hm.com, ERM-model and [Musik](https://example.org)."),
    ("[Telegram Alice id:1]\n[visible thinking]\nDas Meeting ist um 14 Uhr.", "Das Meeting ist um 14 Uhr."),
    ("Die Funktionen sleep(pause) und Spotify (Musik) bleiben.", "Die Funktionen sleep(pause) und Spotify (Musik) bleiben."),
])
def test_clean_v1_matches_portable_capture_rules_and_keeps_raw_query_content(content, cleaned):
    from plur1bus_hermes.embedding_text import configured_text_mode, prepare_embedding_query, prepare_embedding_text

    config = {"embedding": {"cleanText": {"enabled": True, "mode": "clean-v1", "stripSpeaker": True}}}
    mode = configured_text_mode(config)
    assert mode == "clean-v1-nospeaker"
    assert prepare_embedding_text(content, mode) == (cleaned, mode)
    if "Ähm" in content:
        assert "Ähm" in prepare_embedding_query(content, mode)


def test_explicit_clean_v1_mode_falls_back_when_only_a_host_envelope_remains():
    from plur1bus_hermes.embedding_text import prepare_embedding_text

    assert prepare_embedding_text("[visible thinking]", "clean-v1") == ("[visible thinking]", "raw")
