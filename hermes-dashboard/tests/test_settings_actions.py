"""New settings require session authority, same origin, exact review and revision."""
import json
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_plur1bus_dashboard import _load_api
from plur1bus_hermes.namespaces import binding_from_scope


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
    with patch("hermes_cli.web_server._SESSION_TOKEN", "test-token"), patch.object(api, "_active_runtime_view", return_value=view), TestClient(app) as client:
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
