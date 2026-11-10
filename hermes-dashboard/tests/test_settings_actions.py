"""New settings require session authority, same origin, exact review and revision."""
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_plur1bus_dashboard import _load_api
from plur1bus_hermes.namespaces import binding_from_scope


@pytest.mark.parametrize("route", ["/settings", "/desktop/settings"])
@pytest.mark.parametrize("query, label, description, group, automatic", [
    ("", "Automatically save", "Process new conversation content for long-term memory. Manual saving remains available.", "Storage", "Automatic (Jev)"),
    ("?language=en", "Automatically save", "Process new conversation content for long-term memory. Manual saving remains available.", "Storage", "Automatic (Jev)"),
    ("?language=de", "Automatisch speichern", "Neue Gesprächsinhalte automatisch für das Langzeitgedächtnis verarbeiten. Manuelles Speichern bleibt davon unabhängig.", "Speicherung", "Automatisch (Jev)"),
    ("?language=fr", "Automatically save", "Process new conversation content for long-term memory. Manual saving remains available.", "Storage", "Automatic (Jev)"),
], ids=["default", "english", "german", "unsupported"])
def test_settings_routes_default_to_english_and_allow_explicit_german(
    tmp_path, route, query, label, description, group, automatic,
):
    api = _load_api()
    view = SimpleNamespace(hermes_home=tmp_path, data_dir=tmp_path / "data", profile="default",
        agent_id="default", config={}, scope_binding=binding_from_scope("default"),
        _writer_route=SimpleNamespace(path=tmp_path / "data/lancedb/default"))
    app = FastAPI()
    app.include_router(api.router)
    headers = {"X-Hermes-Session-Token": "test-token"}
    with patch.object(api, "_active_runtime_view", return_value=view), TestClient(app, client=("127.0.0.1", 50000)) as client:
        response = client.get(route + query, headers=headers)
    assert response.status_code == 200
    settings = {setting["id"]: setting for setting in response.json()["settings"]}
    assert settings["autoCapture"]["label"] == label
    assert settings["autoCapture"]["description"] == description
    assert settings["autoCapture"]["group"] == group
    assert settings["capture.mode"]["choiceLabels"]["automatisch"] == automatic


def test_numeric_recall_settings_preserve_integer_through_review_and_save(tmp_path):
    api = _load_api()
    path = tmp_path / "plugins/plur1bus/config.json"
    path.parent.mkdir(parents=True)
    path.write_text("{}")
    view = SimpleNamespace(hermes_home=tmp_path, data_dir=tmp_path / "data", profile="default",
        agent_id="default", config={}, scope_binding=binding_from_scope("default"),
        _writer_route=SimpleNamespace(path=tmp_path / "data/lancedb/default"))
    app = FastAPI()
    app.include_router(api.router)
    headers = {"X-Hermes-Session-Token": "test-token"}
    with patch.object(api, "_active_runtime_view", return_value=view), TestClient(app, client=("127.0.0.1", 50000)) as client:
        current = client.get("/desktop/settings", headers=headers).json()
        body = {"identifier": "recall.candidateTopK", "value": 60, "revision": current["revision"]}
        reviewed = client.post("/desktop/settings/preview", json=body, headers=headers)
        assert reviewed.status_code == 200
        assert type(reviewed.json()["value"]) is int
        body["nonce"] = reviewed.json()["nonce"]
        assert client.post("/desktop/settings", json=body, headers=headers).status_code == 200
        stored = json.loads(path.read_text())["profileSettings"]["default"]["recall"]["candidateTopK"]
        assert type(stored) is int and stored == 60


def test_settings_authentication_review_and_replay(tmp_path):
    api = _load_api()
    config = {"llm": {"model": "local", "apiKey": "private-secret"}}
    path = tmp_path / "plugins/plur1bus/config.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(config))
    view = SimpleNamespace(hermes_home=tmp_path, data_dir=tmp_path / "data", profile="default",
        agent_id="default", config=config, scope_binding=binding_from_scope("default"),
        _writer_route=SimpleNamespace(path=tmp_path / "data/lancedb/default"))
    app = FastAPI()
    app.include_router(api.router)
    headers = {"X-Hermes-Session-Token": "test-token", "Origin": "http://testserver"}
    with patch.object(api, "_active_runtime_view", return_value=view), TestClient(app, client=("127.0.0.1", 50000)) as client:
        assert client.get("/settings").status_code == 401
        projection = client.get("/settings", headers=headers)
        assert "private-secret" not in projection.text
        body = {"identifier": "capture.mode", "value": "geteilt", "revision": projection.json()["revision"]}
        assert client.post("/settings/preview", json=body, headers=headers).status_code == 403
        preview_headers = {**headers, "X-Plur1bus-Confirm": "settings-preview"}
        assert client.post("/settings/preview", json=body, headers={**preview_headers, "Origin": "http://evil.invalid"}).status_code == 403
        reviewed = client.post("/settings/preview", json=body, headers=preview_headers)
        assert reviewed.status_code == 200
        body["nonce"] = reviewed.json()["nonce"]
        commit_headers = {**headers, "X-Plur1bus-Confirm": "settings"}
        assert client.post("/settings", json=body, headers=commit_headers).status_code == 200
        assert client.post("/settings", json=body, headers=commit_headers).status_code == 409
        assert json.loads(path.read_text())["profileSettings"]["default"]["captureChunkingMode"] == "geteilt"
        native_headers = {"X-Hermes-Session-Token": "test-token"}
        assert client.get("/desktop/settings", headers=headers).status_code == 403
        current = client.get("/desktop/settings", headers=native_headers).json()
        body = {"identifier": "autoCapture", "value": False, "revision": current["revision"]}
        preview = client.post("/desktop/settings/preview", json=body, headers=native_headers)
        assert preview.status_code == 200
        body["nonce"] = preview.json()["nonce"]
        view.profile = "another-profile"
        assert client.post("/desktop/settings", json=body, headers=native_headers).status_code == 409
