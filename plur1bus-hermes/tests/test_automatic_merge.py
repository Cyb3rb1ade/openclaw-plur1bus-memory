"""Opt-in store path, real LanceDB lineage and crash/repair acceptance."""

import json
from unittest.mock import Mock, patch

import pytest

from plur1bus_hermes.runtime import Plur1busRuntime


@pytest.fixture
def runtime(tmp_path):
    runtime = Plur1busRuntime(tmp_path, {"merging": {"enabled": True}, "embedding": {"dimensions": 2}}, "main")
    runtime._embedding.embed = lambda _text, purpose="passage": [0.1, 0.2]
    runtime._domain.on_memory = Mock()
    runtime._internal_llm.available = lambda: True
    runtime._internal_llm.complete_json = Mock(return_value={"merge": True, "sameTopic": True, "contradiction": False})
    yield runtime
    runtime.shutdown()


def active(runtime):
    table, _ = runtime._table(False)
    return table.search().where("status = 'active'").limit(20).to_list()


def test_automatic_merge_requires_separate_opt_in(runtime):
    runtime._remember("alpha facts", "s", "user")
    runtime._remember("beta facts", "s", "user")
    assert len(active(runtime)) == 2
    runtime._internal_llm.complete_json.assert_not_called()


def test_lossless_merge_preserves_windows_lineage_and_idempotent_retry(runtime):
    source = runtime._remember("alpha facts", "s", "user", valid_from=100, valid_until=300)
    runtime.config["merging"]["autoApply"] = True
    replacement = runtime._remember("beta facts", "s", "user", valid_from=200, valid_until=400)
    assert replacement != source
    assert runtime._remember("beta facts", "s", "user", valid_from=200, valid_until=400) == replacement
    row, = active(runtime)
    assert row["content"] == "alpha facts\nbeta facts"
    assert (row["validFrom"], row["validUntil"]) == (100, 400)
    assert row["epistemicStatus"] == "untrusted"
    assert json.loads(row["mergedFrom"]) == [source, "valid-time:100:300"]
    assert runtime._internal_llm.complete_json.call_count == 1


@pytest.mark.parametrize("case", ["disjoint", "expiry", "assistant", "importance", "orthogonal", "contradiction", "malformed", "llm-error"])
def test_ineligible_or_uncertain_input_stays_separate(runtime, case):
    runtime._remember("alpha facts", "s", "user", valid_from=100, valid_until=200)
    runtime.config["merging"]["autoApply"] = True
    kwargs = {"valid_from": 150, "valid_until": 300}
    role = "user"
    if case == "disjoint":
        kwargs["valid_from"] = 200
    elif case == "expiry":
        kwargs["expires_at"] = 9999999999999
    elif case == "assistant":
        role = "assistant"
    elif case == "importance":
        kwargs["importance"] = 0.9
    elif case == "orthogonal":
        runtime._embedding.embed = lambda _text, purpose="passage": [-0.2, 0.1]
    elif case == "contradiction":
        runtime._internal_llm.complete_json.return_value = {"merge": True, "sameTopic": True, "contradiction": True}
    elif case == "malformed":
        runtime._internal_llm.complete_json.return_value = {"merge": "true", "sameTopic": True, "contradiction": False}
    elif case == "llm-error":
        runtime._internal_llm.complete_json.side_effect = RuntimeError("offline")
    assert runtime._remember("beta facts", "s", role, **kwargs)
    assert len(active(runtime)) == 2


def test_failed_materialization_retains_source_and_does_not_insert_again(runtime):
    runtime._remember("alpha facts", "s", "user")
    runtime.config["merging"]["autoApply"] = True
    with patch.object(runtime._domain, "on_memory", side_effect=RuntimeError("crash")):
        with pytest.raises(RuntimeError):
            runtime._remember("beta facts", "s", "user")
    with pytest.raises(RuntimeError, match="unresolved"):
        runtime._remember("beta facts", "s", "user")
    assert len(active(runtime)) == 2  # original + one not-yet-materialized replacement
    proposal, = runtime.list_merge_proposals()
    assert proposal["state"] == "repair_required"
    assert runtime.repair_merge_proposal(proposal["proposalId"], approved_revision=proposal["revision"])
    assert runtime._remember("beta facts", "s", "user") == proposal["replacementId"]
    assert len(active(runtime)) == 1


def test_changed_source_after_llm_never_retires_it(runtime):
    source = runtime._remember("alpha facts", "s", "user")
    runtime.config["merging"]["autoApply"] = True
    def changed(*args):
        table, _ = runtime._table(False)
        table.update(where=f"id = '{source}'", values={"content": "manual edit"})
        return {"merge": True, "sameTopic": True, "contradiction": False}
    runtime._internal_llm.complete_json.side_effect = changed
    with pytest.raises(RuntimeError, match="unresolved"):
        runtime._remember("beta facts", "s", "user")
    row, = active(runtime)
    assert row["id"] == source and row["content"] == "manual edit"
