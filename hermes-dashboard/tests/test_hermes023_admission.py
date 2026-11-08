"""Current Hermes native and credential-free hosted HTTP admission."""

import json
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from plur1bus_hermes.namespaces import binding_from_scope
from test_plur1bus_dashboard import _load_api


def _fixture(tmp_path):
    api = _load_api()
    app = FastAPI()
    app.include_router(api.router)
    view = SimpleNamespace(
        hermes_home=tmp_path, data_dir=tmp_path / "data", profile="beta",
        agent_id="beta", config={}, scope_binding=binding_from_scope("beta"),
        _writer_route=SimpleNamespace(path=tmp_path / "data/lancedb/beta"),
    )
    return api, app, view


def test_hosted_transport_reads_only_and_fails_closed_on_wrong_profile(tmp_path):
    from hermes_cli.plugin_host_http_auth import with_hosted_admission

    api, app, view = _fixture(tmp_path)
    with patch("hermes_cli.profiles.get_active_profile_name", return_value="beta"), patch(
        "hermes_cli.config.load_config_readonly", return_value={"memory": {"provider": "plur1bus"}}
    ), patch.object(api, "_active_runtime_view", return_value=view), TestClient(
        with_hosted_admission(app, True)
    ) as client:
        caps = client.get("/desktop/capabilities?expectedProfile=beta").json()
        assert caps["memoryProviderEnabled"] is True and caps["profile"] == "beta"
        assert caps["hostedReadOnly"] is True and caps["retrievalActions"] is False
        assert client.get("/desktop/settings?expectedProfile=alpha").status_code == 409
        settings = client.get("/desktop/settings?expectedProfile=beta").json()
        assert settings["readOnly"] is True
        assert client.get("/desktop/retrieval?expectedProfile=beta").json()["readOnly"] is True
        assert client.post("/desktop/settings/preview?expectedProfile=beta", json={
            "identifier": "autoCapture", "value": False, "revision": settings["revision"],
        }).status_code == 403
        assert client.get("/obsidian/preview?expectedProfile=beta").status_code == 403
    with TestClient(with_hosted_admission(app, False)) as client:
        assert client.get("/desktop/settings?expectedProfile=beta",
                          headers={"X-Hosted-Http-Authenticated": "true"}).status_code == 401


def test_direct_verified_native_subject_can_review_only_its_own_profile(tmp_path):
    api, app, view = _fixture(tmp_path)
    config = tmp_path / "plugins/plur1bus/config.json"
    config.parent.mkdir(parents=True)
    config.write_text("{}", encoding="utf-8")
    subject = "subject-a"
    grant = {"subject": subject, "profile_id": str(tmp_path), "purpose": "native-http"}

    @app.middleware("http")
    async def inject_verified_principal(request, call_next):
        request.state.native_http_principal = dict(grant)
        return await call_next(request)

    with patch("hermes_constants.get_hermes_home", return_value=tmp_path), patch(
        "hermes_cli.profiles.get_active_profile_name", return_value="beta"
    ), patch.object(api, "_active_runtime_view", return_value=view), TestClient(app) as client:
        path = "/desktop/settings?expectedProfile=beta"
        settings = client.get(path).json()
        assert settings["readOnly"] is False
        review = client.post("/desktop/settings/preview?expectedProfile=beta", json={
            "identifier": "autoCapture", "value": False, "revision": settings["revision"],
        })
        assert review.status_code == 200
        body = {"identifier": "autoCapture", "value": False, "revision": settings["revision"],
                "nonce": review.json()["nonce"]}
        grant["subject"] = "subject-b"
        assert client.post(path, json=body).status_code == 409
        assert config.read_text(encoding="utf-8") == "{}"
        grant["subject"] = subject
        review = client.post("/desktop/settings/preview?expectedProfile=beta", json={
            "identifier": "autoCapture", "value": False, "revision": settings["revision"],
        })
        body["nonce"] = review.json()["nonce"]
        assert client.post(path, json=body).status_code == 200
        assert json.loads(config.read_text(encoding="utf-8"))["profileSettings"]["beta"]["autoCapture"] is False
        assert client.get(path, headers={"Origin": "http://other.invalid"}).status_code == 403
        grant["profile_id"] = str(tmp_path / "other")
        assert client.get(path).status_code == 403
