"""Current Hermes native and credential-free hosted HTTP admission."""

import json
import os
import shutil
from pathlib import Path
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


def test_desktop_provider_config_saves_hosted_profile_settings(tmp_path, monkeypatch):
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

            def payload(identifier, value, settings, profile="beta"):
                return {"values": {"reviewedSetting": json.dumps({
                    "identifier": identifier, "value": value, "profile": profile,
                    "revision": settings["revision"],
                })}}

            settings = get_settings()
            assert settings["readOnly"] is True and settings["profile"] == "beta"
            schema = client.get(config_path, headers=ticket())
            assert schema.status_code == 200, schema.text
            assert [(field["key"], field["kind"]) for field in schema.json()["fields"]] == [("reviewedSetting", "json")]
            command = payload("autoCapture", False, settings)
            assert client.put(config_path, json=command).status_code == 401
            assert client.put(config_path, json=command, headers=ticket(root)).status_code == 403
            assert client.put(config_path, json=payload("autoCapture", False, settings, "default"),
                              headers=ticket()).status_code == 400
            assert beta_config.read_bytes() == original
            saved = client.put(config_path, json=command, headers=ticket())
            assert saved.status_code == 200, saved.text
            assert client.put(config_path, json=command, headers=ticket()).status_code == 400
            latest = get_settings()
            saved = client.put(config_path, json=payload("capture.mode", "geteilt", latest), headers=ticket())
            assert saved.status_code == 200, saved.text
            before_key = get_settings()
            current = {item["id"]: item["value"] for item in before_key["settings"]}
            assert current["autoCapture"] is False and current["capture.mode"] == "geteilt"
            env_path = "/api/env?profile=beta"
            key = "fixture-jev-credential"
            secret = {"key": "TYPESAFE_API_KEY", "value": key}
            assert before_key["jevCredentials"]["configured"] is False
            assert client.put(env_path, json=secret).status_code == 401
            assert client.put(env_path, json=secret, headers=ticket(root)).status_code == 403
            assert not (beta / ".env").exists()
            saved = client.put(env_path, json=secret, headers=ticket())
            assert saved.status_code == 200 and saved.json()["ok"] is True
            assert key not in saved.text
            latest = get_settings()
            assert latest["jevCredentials"] == {
                "configured": True, "source": "default_environment", "editable": True,
            }
            assert key not in json.dumps(latest)
            assert latest["revision"] == before_key["revision"]
            assert next(item["value"] for item in latest["settings"] if item["id"] == "capture.mode") == "geteilt"
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
