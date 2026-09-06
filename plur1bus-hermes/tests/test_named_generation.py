"""Named namespace cutover keeps private/other namespaces and metadata intact."""

import json
from pathlib import Path
from unittest.mock import patch

import lancedb
import pytest

from plur1bus_hermes.generation import (
    activate_staged_generation, recover_generation, read_generation, effective_generation_config,
    _generation_dir, _atomic_json, _manifest,
)
from plur1bus_hermes.namespaces import resolve_namespace_routes
from plur1bus_hermes.reembed_staged import plan_staged_reembed, apply_staged_reembed
from plur1bus_hermes.runtime_lease import acquire_runtime_lease


class Backend:
    def __init__(self, *args):
        pass
    def embed(self, text):
        return [float(len(text)), 1.0]
    def close(self):
        pass


def config(namespace):
    return {"embedding": {"model": "target", "provider": "test", "dimensions": 2},
            "namespaces": {"activeWriteNamespace": namespace, "activeRecallNamespaces": [namespace]}}


@pytest.fixture
def stage(tmp_path):
    for name in ("alpha", "beta"):
        path = tmp_path / "lancedb-namespaces" / name / "a"
        path.mkdir(parents=True)
        lancedb.connect(str(path)).create_table("memories", [{"id": "one", "content": name, "agentId": "a",
            "scopeKey": "scope", "validFrom": 100, "validUntil": 200, "status": "active", "vector": [0.0]}])
    plan = plan_staged_reembed(tmp_path, "a", config("alpha"))
    apply_staged_reembed(plan, tmp_path, "a", config("alpha"), backend_factory=Backend)
    return tmp_path, plan


def test_named_activation_routes_and_second_migration(stage):
    root, plan = stage
    activate_staged_generation(plan, root, "a", config("alpha"), approved_plan_id=plan["planId"])
    writer, routes = resolve_namespace_routes(root, "a", config("alpha"))
    assert str(writer.path) == plan["targetRoute"]
    assert read_generation(root, "a") is None
    assert read_generation(root, "a", "beta") is None
    row, = lancedb.connect(str(writer.path)).open_table("memories").to_arrow().to_pylist()
    assert (row["validFrom"], row["validUntil"], row["scopeKey"]) == (100, 200, "scope")
    assert effective_generation_config(root, "a", config("alpha"))["embedding"]["dimensions"] == 2
    next_config = {**config("alpha"), "embedding": {"model": "target2", "provider": "test", "dimensions": 2}}
    next_plan = plan_staged_reembed(root, "a", next_config)
    assert next_plan["sourceRoute"] == plan["targetRoute"]
    apply_staged_reembed(next_plan, root, "a", next_config, backend_factory=Backend)
    activate_staged_generation(next_plan, root, "a", next_config, approved_plan_id=next_plan["planId"])
    assert read_generation(root, "a", "alpha")["planId"] == next_plan["planId"]
    other, _ = resolve_namespace_routes(root, "a", config("beta"))
    assert other.path == root / "lancedb-namespaces" / "beta" / "a"


def test_namespace_or_agent_substitution_refused_and_live_lease_blocks(stage):
    root, plan = stage
    for agent, namespace in (("a", "beta"), ("other", "alpha")):
        with pytest.raises(ValueError):
            activate_staged_generation(plan, root, agent, config(namespace), approved_plan_id=plan["planId"])
    lease = acquire_runtime_lease(root)
    try:
        with pytest.raises(RuntimeError, match="runtime lease"):
            activate_staged_generation(plan, root, "a", config("alpha"), approved_plan_id=plan["planId"])
    finally:
        lease.close()


def test_named_pointer_crash_recovery_and_mixed_uncertified_recall_refused(stage):
    root, plan = stage
    manifest = _manifest(plan, Path(plan["sourceRoute"]), Path(plan["targetRoute"]), "a", config("alpha"))
    directory = _generation_dir(root, "a", "alpha")
    _atomic_json(directory / f"journal-{plan['planId']}.json", {
        "state": "pointer_swapped", "plan": plan, "manifest": manifest, "oldPointer": None,
    })
    _atomic_json(directory / "active.json", manifest)
    with pytest.raises(ValueError, match="recovery"):
        resolve_namespace_routes(root, "a", config("alpha"))
    assert recover_generation(root, "a", config("alpha"), approved_plan_id=plan["planId"])["activated"]
    mixed = config("alpha")
    mixed["namespaces"]["activeRecallNamespaces"].append("beta")
    with pytest.raises(ValueError, match="uncertified"):
        resolve_namespace_routes(root, "a", mixed)


def test_matching_certified_namespaces_can_be_recalled_together(stage):
    root, plan = stage
    activate_staged_generation(plan, root, "a", config("alpha"), approved_plan_id=plan["planId"])
    beta = plan_staged_reembed(root, "a", config("beta"))
    apply_staged_reembed(beta, root, "a", config("beta"), backend_factory=Backend)
    activate_staged_generation(beta, root, "a", config("beta"), approved_plan_id=beta["planId"])
    mixed = config("alpha")
    mixed["namespaces"]["activeRecallNamespaces"].append("beta")
    writer, routes = resolve_namespace_routes(root, "a", mixed)
    assert [str(route.path) for route in routes] == [plan["targetRoute"], beta["targetRoute"]]
