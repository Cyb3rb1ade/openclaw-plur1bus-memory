"""Current Hermes native and credential-free hosted HTTP admission."""

import json
import os
import shutil
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from plur1bus_hermes.namespaces import binding_from_scope
from test_plur1bus_dashboard import _load_api


def test_status_and_retrieval_use_profile_credentials_with_a_separate_store(tmp_path, monkeypatch):
    from plur1bus_hermes.operator_status import read_operator_status
    from plur1bus_hermes.runtime import Plur1busRuntime

    root = tmp_path / ".hermes"
    profile = root / "profiles" / "beta"
    profile.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("PLUR1BUS_EMBEDDING_API_KEY", "launch-fixture")
    monkeypatch.setenv("PLUR1BUS_RERANKER_API_KEY", "launch-fixture")
    secrets = profile / ".env"
    secrets.write_text("PLUR1BUS_EMBEDDING_API_KEY=beta-embed\nPLUR1BUS_RERANKER_API_KEY=beta-rerank\n")
    config = {
        "hermesHome": str(profile),
        "embedding": {"provider": "openai-compatible", "model": "fixture", "dimensions": 2,
                      "baseUrl": "https://embeddings.example.invalid/v1"},
        "reranker": {"provider": "cohere", "model": "fixture"},
    }
    runtime = Plur1busRuntime(tmp_path / "separate-storage", config, "beta")
    try:
        status = read_operator_status(runtime)
        assert status["embedding"]["credentials"] == "default_environment_configured"
        assert status["reranker"]["credentials"] == "environment_configured"
        assert "beta-embed" not in repr(status) and "beta-rerank" not in repr(status)
        with patch("urllib.request.urlopen", side_effect=[
            BytesIO(b'{"data":[{"embedding":[0.2,0.1]}]}'),
            BytesIO(b'{"results":[{"index":0,"relevance_score":0.7}]}'),
        ]) as call:
            assert runtime._embedding.embed("fixture input") == [0.2, 0.1]
            assert runtime._reranker.rerank("fixture query", [{"content": "fixture row"}])[0]["rerankScore"] == 0.7
            assert [request.args[0].get_header("Authorization") for request in call.call_args_list] == [
                "Bearer beta-embed", "Bearer beta-rerank",
            ]
        secrets.unlink()
        status = read_operator_status(runtime)
        assert status["embedding"]["credentials"] == "environment_missing"
        assert status["reranker"]["credentials"] == "environment_missing"
    finally:
        runtime.shutdown()


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
    with patch("hermes_constants.profile_name_for_home", return_value="beta"), patch(
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
        "hermes_constants.profile_name_for_home", return_value="beta"
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


def test_native_provider_schema_saves_a_profile_scoped_jev_key(tmp_path, monkeypatch):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from gateway.runtime_bootstrap import TicketStore
    from gateway.session_authorities import SessionAuthorities
    from hermes_cli import plugins, web_server
    from tui_gateway import launch_profile_policy

    root = tmp_path / "user" / ".hermes"
    beta = root / "profiles" / "beta"
    source = Path(__file__).resolve().parents[2]
    for home in (root, beta):
        plugin = home / "plugins" / "plur1bus"
        shutil.copytree(source / "plur1bus-hermes/src/plur1bus_hermes", plugin,
                        ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(source / "hermes-dashboard/plur1bus/dashboard", plugin / "dashboard")
        (home / "config.yaml").write_text(json.dumps({
            "memory": {"provider": "plur1bus"},
            "plugins": {"enabled": ["plur1bus"], "isolation": "host"},
        }), encoding="utf-8")
        (plugin / "config.json").write_text('{"autoCapture":true,"unrelated":17}', encoding="utf-8")
    for name, path in (("HOME", root.parent), ("USERPROFILE", root.parent), ("HERMES_HOME", root)):
        monkeypatch.setenv(name, str(path))
    monkeypatch.setenv("PYTHONPATH", os.pathsep.join((
        str(source / "plur1bus-hermes/src"), os.environ.get("PYTHONPATH", ""),
    )))
    authorities = SessionAuthorities(root, multiplexed=True)
    for home in (root, beta):
        authorities.add(home, SimpleNamespace(profile_id=str(home), instance_id="test-daemon"))
    tickets = TicketStore("test-daemon", authorities.profile_ids())
    runner = SimpleNamespace(
        session_authorities=authorities, session_ticket_store=tickets, _draining=False,
        session_runtime_descriptor={"state": "ready", "instance_id": "test-daemon",
                                    "served_profiles": authorities.served_profiles()},
    )
    monkeypatch.setattr(web_server.app.state, "gateway_runner", runner, raising=False)
    monkeypatch.setattr(web_server, "_dashboard_plugins_cache", None)
    monkeypatch.setattr(launch_profile_policy, "_snapshot", None)
    was_multiplexed = is_multiplex_active()

    async def desktop_peer(scope, receive, send):
        await web_server.app({**scope, "hermes.gateway_socket_peer": ("127.0.0.1", 50000)}, receive, send)

    def ticket(home=beta):
        return {"X-Hermes-Gateway-Ticket": tickets.mint(
            profile_id=str(home), subject="desktop", purpose="native-http")}

    settings_path = "/api/plugins/plur1bus/desktop/settings?expectedProfile=beta"
    config_path = "/api/memory/providers/plur1bus/config?surface=declared&profile=beta"
    beta_config = beta / "plugins/plur1bus/config.json"
    root_config = root / "plugins/plur1bus/config.json"
    original = root_config.read_bytes()
    try:
        with TestClient(desktop_peer) as client:
            def get_settings():
                result = client.get(settings_path, headers=ticket())
                assert result.status_code == 200, result.text
                return result.json()

            before_key = get_settings()
            assert before_key["readOnly"] is True and before_key["profile"] == "beta"
            assert before_key["jevCredentials"]["configured"] is False
            schema = client.get(config_path, headers=ticket())
            assert schema.status_code == 200, schema.text
            assert [(field["key"], field["kind"]) for field in schema.json()["fields"]] == [("jevApiKey", "secret")]
            assert client.get(settings_path, headers={"X-Hermes-Session-Token": "forged"}).status_code == 401
            key = "fixture-jev-credential"
            secret = {"values": {"jevApiKey": key}}
            assert client.put(config_path, json=secret).status_code == 401
            assert client.put(config_path, json=secret, headers=ticket(root)).status_code == 403
            assert client.put(config_path, json={"values": {"jevApiKey": "bad key"}},
                              headers=ticket()).status_code == 400
            assert not (beta / ".env").exists()
            saved = client.put(config_path, json=secret, headers=ticket())
            assert saved.status_code == 200 and saved.json()["ok"] is True, saved.text
            assert key not in saved.text
            latest = get_settings()
            assert latest["jevCredentials"] == {
                "configured": True, "source": "default_environment", "editable": True,
            }
            assert key not in json.dumps(latest)
            assert latest["revision"] == before_key["revision"]
            assert {item["id"]: item["value"] for item in latest["settings"]} == {
                item["id"]: item["value"] for item in before_key["settings"]
            }
            assert beta_config.read_bytes() == original
            assert key in (beta / ".env").read_text(encoding="utf-8")
            assert not (root / ".env").exists()
            # Capture runs outside the request and must use the same profile's key.
            from plur1bus_hermes.jev_chunk_decider import decide_storage
            with patch("plur1bus_hermes.jev_chunk_decider.urlopen") as call:
                assert decide_storage("Example text", {"hermesHome": str(root)}) == "both"
                call.assert_not_called()
                call.return_value.__enter__.return_value.read.return_value = b'{"answers":{"structure":{"choice":"independent","confidence":1}}}'
                assert decide_storage("Example text", {"hermesHome": str(beta)}) == "parts"
                assert call.call_args.args[0].get_header("Authorization") == "Bearer " + key
            assert root_config.read_bytes() == original
            assert json.loads(beta_config.read_bytes())["unrelated"] == 17
    finally:
        for home in (root, beta):
            manager = plugins._plugin_managers_by_home.get(home)
            host = getattr(manager, "_plugin_host_instance", None)
            if host is not None:
                host.shutdown()
        set_multiplex_active(was_multiplexed)
