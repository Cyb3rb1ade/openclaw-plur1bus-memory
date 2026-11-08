"""Cross-namespace provider cap and fail-open ordering."""

from unittest.mock import patch

from plur1bus_hermes.runtime import RerankerBackend


def test_global_provider_cap_prefers_nearer_namespaces_and_dedupes_refined_rows(tmp_path):
    backend = RerankerBackend({"provider": "cohere"}, tmp_path)
    rows = [
        {"id": "a", "_namespace": "private", "_distance": 0.4},
        {"id": "b", "_namespace": "private", "_distance": 0.5},
        {"id": "c", "_namespace": "shared", "_distance": 0.1},
        {"id": "c", "_namespace": "shared", "_distance": 0.15},
        {"id": "d", "_namespace": "shared", "_distance": 0.2},
    ]
    with patch.object(backend, "_rerank_with", side_effect=lambda _, q, selected: selected[::-1]) as call:
        result = backend.rerank("q", rows, candidate_limit=1, minimum=2)
        assert [row["id"] for row in call.call_args.args[2]] == ["c", "d"]
        assert [row["id"] for row in result] == ["d", "c"]
    with patch.object(backend, "_rerank_with", side_effect=RuntimeError("unavailable")):
        assert backend.rerank("q", rows, candidate_limit=1) is rows
