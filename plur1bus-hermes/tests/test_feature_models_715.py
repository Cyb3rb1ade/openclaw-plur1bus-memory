import copy
import json

import pytest

from plur1bus_hermes.feature_models import resolve_feature_route
from plur1bus_hermes.llm_backend import InternalLlmBackend


def config():
    return {"llm": {"model": "base", "baseUrl": "https://base.invalid/v1", "apiKey": "base-secret"},
            "llmRouter": {"modelRoutes": {
                "second/model": {"model": "model", "baseUrl": "https://second.invalid/v1", "apiKey": "second-secret"}},
                "agentModels": {"a": {"*": "base", "emotion-encoding": "second/model"}}}}


def test_task_agent_precedence_and_no_config_mutation():
    settings = config()
    original = copy.deepcopy(settings)
    resolve = lambda agent, purpose: resolve_feature_route(settings, settings["llm"], agent, purpose)
    assert resolve("a", "memory-encoding")["apiKey"] == "second-secret"
    assert resolve("a", "query-refinement")["model"] == "base"
    assert resolve("b", "memory-encoding")["apiKey"] == "base-secret"
    assert resolve("a", "unknown-task")["model"] == "base"
    assert settings == original
    settings["llmRouter"]["agentModels"]["a"]["emotion-encoding"] = "unknown/model"
    with pytest.raises(ValueError, match="registered transport"):
        resolve("a", "memory-encoding")


def test_wire_route_and_credentials_follow_selected_model():
    seen = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self): return b'{"choices":[{"message":{"content":"{}"}}]}'
    def opener(request, **kwargs):
        seen.append((request.full_url, request.get_header("Authorization"), json.loads(request.data)))
        return Response()
    backend = InternalLlmBackend(config(), "a", opener=opener)
    backend.complete_json("memory-encoding", "system", "data")
    backend.complete_json("episode-extraction", "system", "data")
    assert seen[0][0] == "https://second.invalid/v1/chat/completions"
    assert seen[0][1] == "Bearer second-secret"
    assert seen[0][2]["model"] == "model"
    assert seen[1][1] == "Bearer base-secret"
