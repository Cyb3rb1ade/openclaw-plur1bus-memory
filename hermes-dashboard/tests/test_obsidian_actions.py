"""HTTP consent is scoped, exact, single-use and requires real host authority."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from test_plur1bus_dashboard import _load_api
from plur1bus_hermes.runtime import Plur1busRuntime


@pytest.fixture
def client_runtime(tmp_path):
    api = _load_api()
    runtime = Plur1busRuntime(tmp_path, {"embedding": {"dimensions": 2}}, "a")
    runtime._embedding.embed = lambda _text, purpose="passage": [0.1, 0.2]
    runtime._domain.on_memory = lambda *args, **kwargs: None
    selector = runtime._domain._scope_selector(acl_bindings=runtime.scope_binding)
    workspace = runtime._domain._scope_workspace_dir(selector)
    workspace.mkdir(parents=True, exist_ok=True)
    note = workspace / "review.md"
    note.write_text("Test evidence")
    view = SimpleNamespace(profile="a")
    @contextmanager
    def lease():
        yield runtime, view
    app = FastAPI()
    app.include_router(api.router)
    with patch("hermes_cli.web_server._SESSION_TOKEN", "test-host-token"), patch.object(api, "_runtime_lease", lease), TestClient(app) as client:
        yield client, runtime, note, view
    runtime.shutdown()


HEADERS = {"X-Hermes-Session-Token": "test-host-token"}


def test_native_confirmation_and_replay(client_runtime):
    client, runtime, note, view = client_runtime
    assert client.get("/obsidian/preview").status_code == 401
    preview = client.get("/obsidian/preview", headers=HEADERS).json()
    assert preview["files"][0]["path"] == "review.md"
    assert "workspace" not in preview
    body = {"revision": preview["revision"], "nonce": preview["nonce"], "confirmation": "obsidian-sync"}
    assert client.post("/desktop/obsidian/sync", json={**body, "source": "/other"}, headers=HEADERS).status_code == 422
    assert client.post("/desktop/obsidian/sync", json=body, headers={**HEADERS, "Origin": "http://evil.invalid"}).status_code == 403
    assert client.post("/desktop/obsidian/sync", json=body, headers=HEADERS).status_code == 200
    assert client.post("/desktop/obsidian/sync", json=body, headers=HEADERS).status_code == 409
    assert runtime._table(False)[0].count_rows() == 1


def test_profile_or_note_change_invalidates_review(client_runtime):
    client, runtime, note, view = client_runtime
    for change in ("profile", "note"):
        preview = client.get("/obsidian/preview", headers=HEADERS).json()
        body = {"revision": preview["revision"], "nonce": preview["nonce"], "confirmation": "obsidian-sync"}
        if change == "profile":
            view.profile = "different"
        else:
            note.write_text("new revision")
        assert client.post("/desktop/obsidian/sync", json=body, headers=HEADERS).status_code == 409
    assert runtime._table(False)[0] is None


def test_browser_requires_same_origin_and_confirmation(client_runtime):
    client, runtime, note, view = client_runtime
    preview = client.get("/obsidian/preview", headers=HEADERS).json()
    body = {"revision": preview["revision"], "nonce": preview["nonce"], "confirmation": "obsidian-sync"}
    assert client.post("/obsidian/sync", json=body, headers=HEADERS).status_code == 403
    headers = {**HEADERS, "Origin": "http://testserver", "X-Plur1bus-Confirm": "obsidian-sync"}
    assert client.post("/obsidian/sync", json=body, headers=headers).status_code == 200
