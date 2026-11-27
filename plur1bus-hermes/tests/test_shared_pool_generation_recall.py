"""Exercise mixed-width legacy shares through the actual recall path."""

import uuid

from plur1bus_hermes.runtime import Plur1busRuntime


def test_legacy_shared_vectors_do_not_block_private_recall_after_model_change(tmp_path):
    runtime = Plur1busRuntime(tmp_path, {"embedding": {"dimensions": 2}}, "default")
    runtime._embedding.embed = lambda *_args, **_kwargs: [0.1, 0.2]
    runtime._domain.on_memory = lambda *_args, **_kwargs: None
    try:
        runtime._remember("Polaris uses private migration snapshots", "old", "user")
        runtime._shared_pools.copy({
            "id": str(uuid.uuid4()), "status": "active", "content": "Polaris shared deployment checklist",
            "vector": [0.1, 0.2, 0.3],
        }, source_agent="old-writer")

        result = runtime.recall("Polaris deployment")

        assert "Polaris uses private migration snapshots" in result
        assert "Polaris shared deployment checklist" in result
    finally:
        runtime.shutdown()
