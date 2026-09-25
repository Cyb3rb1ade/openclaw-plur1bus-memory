"""Native contracts ported from upstream 7.16.0--7.16.9."""
from contextlib import ExitStack
import tempfile
from types import SimpleNamespace

import pytest

from plur1bus_hermes.critical import classify_critical
from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.inject_budget import trim_memory_items, apply_global_inject_budget
from plur1bus_hermes.settings_admin import validate_change
from test_inject_budget import RuntimeInjectBudgetWiringTests, _FakeRecallTable


@pytest.mark.parametrize("field", ["origin", "memoryClass"])
def test_dream_provenance_overrides_even_explicit_critical_signals(field):
    metadata = {field: "dream", "importance": 1, "neverForget": True}
    assert not classify_critical("Never forget emergency", metadata)["eligible"]
    assert classify_critical("Never forget emergency", {"importance": 1})["eligible"]


@pytest.mark.parametrize("field", ["origin", "memoryClass"])
def test_materialized_dream_does_not_write_classification_or_push(tmp_path, field):
    domain = Plur1busDomain(tmp_path, "main")
    domain._classify_materialized_memory(
        {"id": "dream-1", "content": "never forget", field: "dream"},
        {"importance": 1, "neverForget": True}, domain._scope_selector())
    assert not list(tmp_path.rglob("critical-classification.jsonl"))
    assert not list(tmp_path.rglob("critical-push.jsonl"))


def test_memory_budget_keeps_whole_records_and_marker():
    items = ["- first complete record", "- " + "second" * 30]
    result = trim_memory_items(items, 100)
    assert result.startswith(items[0])
    assert "second" not in result
    assert result.endswith("<!-- memory context truncated -->")
    assert len(result) <= 100
    assert trim_memory_items(items, 3) == ""
    assert trim_memory_items(items, 0) == "\n".join(items)


def test_global_budget_never_splits_structured_overlay_or_memory_record():
    items = ["- " + "a" * 50, "- " + "b" * 150]
    result = apply_global_inject_budget(blocks=[
        {"name": "memories", "text": "\n".join(items), "items": items, "droppable": True},
        {"name": "overlay", "text": "<overlay>" + "x" * 100 + "</overlay>", "droppable": True},
    ], max_chars=110)
    assert items[0] in result
    assert "b" * 20 not in result
    assert "<overlay>" not in result
    assert len(result) <= 110


@pytest.mark.parametrize("candidate,prompt", [(40, 12), (60, 20), (5, 5)])
def test_configured_recall_width_reaches_native_search_and_prompt(candidate, prompt):
    with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
        runtime = RuntimeInjectBudgetWiringTests()._runtime(directory, {
            "recall": {"candidateTopK": candidate, "maxPromptMemories": prompt}})
        resources.callback(runtime.shutdown)
        table = _FakeRecallTable([
            {"id": str(i), "content": f"record-{i:02}", "_distance": 0.1}
            for i in range(30)])
        runtime._recall_tables = lambda: [("default", table)]
        result = runtime.recall("query")
        assert table.limit_count == candidate
        assert result.count("- record-") == prompt


def test_default_inner_budget_and_escaping_are_applied():
    with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
        runtime = RuntimeInjectBudgetWiringTests()._runtime(directory, {})
        resources.callback(runtime.shutdown)
        table = _FakeRecallTable([
            {"id": str(i), "content": f"<record-{i}>" + "x" * 1800, "_distance": 0.1}
            for i in range(12)])
        runtime._recall_tables = lambda: [("default", table)]
        result = runtime.recall("query")
        assert len(result) <= 12000
        assert "<record-" not in result
        assert "&lt;record-0&gt;" in result


@pytest.mark.parametrize("value", [True, "40", 4, 101, 12.5])
def test_numeric_settings_reject_coercion_and_out_of_range(value):
    with pytest.raises(ValueError):
        validate_change(SimpleNamespace(config={}), "recall.candidateTopK", value)


def test_numeric_settings_accept_valid_integer():
    validate_change(SimpleNamespace(config={}), "recall.candidateTopK", 60)
