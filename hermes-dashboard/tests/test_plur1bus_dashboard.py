"""Contract tests for the read-only PLUR1BUS dashboard artifact."""

from __future__ import annotations

import importlib.util
import json
import shutil
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1] / "plur1bus" / "dashboard"


def _load_api():
    spec = importlib.util.spec_from_file_location("plur1bus_dashboard_test", ROOT / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class Plur1busDashboardTests(unittest.TestCase):
    def test_status_view_uses_verified_generation_embedding_config(self) -> None:
        api = _load_api()
        config = {"dataDir": "plur1bus", "embedding": {"model": "old"}}
        effective = {**config, "embedding": {"model": "new", "dimensions": 2}}
        with tempfile.TemporaryDirectory() as directory, patch(
            "hermes_constants.get_hermes_home", return_value=Path(directory)
        ), patch("hermes_cli.profiles.get_active_profile_name", return_value="default"), patch.object(
            api.Plur1busMemoryProvider, "_runtime_config", return_value=config
        ), patch("plur1bus_hermes.generation.effective_generation_config", return_value=effective) as generation:
            view = api._active_runtime_view()
            self.assertEqual(view.config["embedding"]["model"], "new")
            generation.assert_called_once_with(Path(directory) / "plur1bus", "default", config)

    def test_manifest_declares_relative_read_only_api(self) -> None:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "plur1bus")
        self.assertIn("reviewed Skill Workshop actions", manifest["description"])
        self.assertEqual(manifest["api"], "plugin_api.py")
        self.assertFalse(Path(manifest["api"]).is_absolute())
        self.assertTrue((ROOT / manifest["entry"]).is_file())

    def test_status_endpoint_passes_only_server_derived_runtime(self) -> None:
        api = _load_api()
        expected = {"schemaVersion": 1, "configured": True}
        runtime = object()
        with patch.object(api, "_active_runtime_view", return_value=runtime) as active, patch.object(
            api, "read_operator_status", return_value=expected
        ) as status:
            self.assertEqual(api.get_status(), expected)
        active.assert_called_once_with()
        status.assert_called_once_with(runtime)

    def test_runtime_view_reads_server_profile_without_starting_provider(self) -> None:
        api = _load_api()
        config = {"agentId": "memory-agent", "dataDir": "plur1bus", "embedding": {}}
        with tempfile.TemporaryDirectory() as directory, patch(
            "hermes_constants.get_hermes_home", return_value=Path(directory)
        ), patch("hermes_cli.profiles.get_active_profile_name", return_value="active"), patch.object(
            api.Plur1busMemoryProvider, "_runtime_config", return_value=config
        ) as runtime_config:
            view = api._active_runtime_view()
        runtime_config.assert_called_once_with("active")
        self.assertEqual(view.agent_id, "active")
        self.assertEqual(view.data_dir, Path(directory) / "plur1bus")

    def test_default_profile_is_passed_to_provider_without_nested_fallback(self) -> None:
        api = _load_api()
        config = {"agentId": "main", "dataDir": "plur1bus", "embedding": {}}
        with tempfile.TemporaryDirectory() as directory, patch(
            "hermes_constants.get_hermes_home", return_value=Path(directory)
        ), patch("hermes_cli.profiles.get_active_profile_name", return_value="default"), patch.object(
            api.Plur1busMemoryProvider, "_runtime_config", return_value=config
        ) as runtime_config:
            view = api._active_runtime_view()
        runtime_config.assert_called_once_with("default")
        self.assertEqual(view.agent_id, "default")

    def test_discovery_accepts_the_manifest_and_mount_contract(self) -> None:
        from hermes_cli.web_server_dashboard import _dashboard_plugin_entry, _safe_plugin_api_relpath

        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            dashboard = Path(directory) / "dashboard"
            dashboard.mkdir()
            (dashboard / "plugin_api.py").write_text("router = object()\n", encoding="utf-8")
            entry = _dashboard_plugin_entry(manifest, "plur1bus", dashboard, "user")
            self.assertEqual(entry["_api_file"], "plugin_api.py")
            self.assertTrue(entry["has_api"])
            self.assertEqual(_safe_plugin_api_relpath("../plugin_api.py", dashboard_dir=dashboard), None)

    def test_host_mounts_enabled_user_api_under_plugin_prefix(self) -> None:
        from fastapi import FastAPI
        from hermes_cli import web_server, web_server_dashboard

        plugin = {
            "name": "plur1bus",
            "source": "user",
            "_api_file": "plugin_api.py",
            "_dir": str(ROOT),
        }
        app = FastAPI()
        with patch.object(web_server, "_get_dashboard_plugins", return_value=[plugin]), patch.object(
            web_server, "app", app
        ), patch("hermes_cli.plugins_cmd._get_enabled_set", return_value={"plur1bus"}), patch(
            "hermes_cli.plugins_cmd._get_disabled_set", return_value=set()
        ):
            web_server_dashboard._mount_plugin_api_routes()
        self.assertIn("/api/plugins/plur1bus/status", {route.path for route in app.routes})

    def test_real_host_discovery_finds_installed_plugin_under_plugins_root(self) -> None:
        from hermes_cli import web_server_dashboard

        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            destination = home / "plugins" / "plur1bus" / "dashboard"
            destination.parent.mkdir(parents=True)
            shutil.copytree(ROOT, destination)
            with patch.object(web_server_dashboard, "get_process_hermes_home", return_value=home), patch(
                "hermes_constants.get_default_hermes_root", return_value=home
            ), patch("hermes_cli.plugins.get_bundled_plugins_dir", return_value=home / "bundled"):
                plugins = web_server_dashboard._discover_dashboard_plugins()
        entry = next(plugin for plugin in plugins if plugin["name"] == "plur1bus")
        self.assertEqual(Path(entry["_dir"]), destination)
        self.assertTrue(entry["has_api"])

    def test_workshop_actions_are_session_bound_reviewed_and_one_use(self) -> None:
        """Exercise host-shaped HTTP action defenses without a live daemon."""
        from fastapi import FastAPI, Request
        from fastapi.testclient import TestClient

        api = _load_api()
        proposal_id = "00000000-0000-4000-8000-000000000001"
        revision = "a" * 64
        calls: list[str] = []
        view = SimpleNamespace(profile="profile-a", hermes_home=Path("/safe/home"))
        runtime = SimpleNamespace(
            agent_id="agent-a", scope_key="scope-a",
            _writer_route=SimpleNamespace(name="writer-a", path="/safe/data/writer-a"),
        )

        class Workshop:
            def __init__(self, _runtime):
                pass

            def list(self):
                return [{"id": proposal_id, "revision": revision, "title": "Scoped"}]

            def inspect(self, identifier):
                if identifier not in {proposal_id, "00000000-0000-4000-8000-000000000002"}:
                    raise ValueError("not found")
                return {
                    "id": identifier, "revision": revision, "skillName": "scoped-skill",
                    "title": "Scoped", "description": "Reviewed", "instructions": "Read carefully",
                    "evidence": [{"id": "card"}], "status": "pending",
                }

            def approve(self, identifier, approved_revision):
                if identifier.endswith("2"):
                    raise ValueError("evidence changed")
                self.inspect(identifier)
                if approved_revision != revision:
                    raise ValueError("revision")
                calls.append(identifier)
                return {"approved": True}

            def publish(self, identifier, approved_revision, _home):
                self.approve(identifier, approved_revision)
                return {"published": True}

        @contextmanager
        def lease():
            yield runtime, view

        app = FastAPI()

        @app.middleware("http")
        async def verified_session(request: Request, call_next):
            request.state.session = SimpleNamespace(
                provider="oauth", user_id="operator", access_token=request.app.state.access_token
            )
            return await call_next(request)

        app.state.access_token = "first-verified-session"
        app.include_router(api.router, prefix="/api/plugins/plur1bus")
        api._nonces.clear()
        anonymous = FastAPI()
        anonymous.include_router(api.router, prefix="/api/plugins/plur1bus")
        with TestClient(anonymous) as client:
            self.assertEqual(
                client.get(f"/api/plugins/plur1bus/workshop/approve/preview/{proposal_id}?revision={revision}").status_code,
                401,
            )
        with patch.object(api, "SkillWorkshop", Workshop), patch.object(api, "_runtime_lease", lease), TestClient(app) as client:
            self.assertEqual(client.get("/api/plugins/plur1bus/workshop/proposals").status_code, 200)
            self.assertEqual(client.get(f"/api/plugins/plur1bus/workshop/proposals/{proposal_id}").status_code, 200)
            preview = client.get(f"/api/plugins/plur1bus/workshop/approve/preview/{proposal_id}?revision={revision}")
            self.assertEqual(preview.status_code, 200)
            nonce = preview.json()["nonce"]
            headers = {"Origin": "http://testserver", "X-Plur1bus-Confirm": "approve"}
            # A hostile origin cannot use an otherwise authenticated cookie session.
            self.assertEqual(client.post("/api/plugins/plur1bus/workshop/approve", json={"proposal_id": proposal_id, "revision": revision}, headers={**headers, "Origin": "http://evil.invalid", "X-Plur1bus-Action-Nonce": nonce}).status_code, 403)
            # A nonce is mandatory and the failed cross-origin attempt did not consume it.
            self.assertEqual(client.post("/api/plugins/plur1bus/workshop/approve", json={"proposal_id": proposal_id, "revision": revision}, headers=headers).status_code, 409)
            accepted = client.post("/api/plugins/plur1bus/workshop/approve", json={"proposal_id": proposal_id, "revision": revision}, headers={**headers, "X-Plur1bus-Action-Nonce": nonce})
            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(calls, [proposal_id])
            self.assertEqual(client.post("/api/plugins/plur1bus/workshop/approve", json={"proposal_id": proposal_id, "revision": revision}, headers={**headers, "X-Plur1bus-Action-Nonce": nonce}).status_code, 409)
            # A preview becomes stale if the server-selected profile changes.
            fresh = client.get(f"/api/plugins/plur1bus/workshop/approve/preview/{proposal_id}?revision={revision}").json()["nonce"]
            view.profile = "profile-b"
            self.assertEqual(client.post("/api/plugins/plur1bus/workshop/approve", json={"proposal_id": proposal_id, "revision": revision}, headers={**headers, "X-Plur1bus-Action-Nonce": fresh}).status_code, 409)
            view.profile = "profile-a"
            # A second verified browser session for the same user cannot replay
            # the first session's approval nonce.
            session_nonce = client.get(f"/api/plugins/plur1bus/workshop/approve/preview/{proposal_id}?revision={revision}").json()["nonce"]
            app.state.access_token = "second-verified-session"
            self.assertEqual(client.post("/api/plugins/plur1bus/workshop/approve", json={"proposal_id": proposal_id, "revision": revision}, headers={**headers, "X-Plur1bus-Action-Nonce": session_nonce}).status_code, 409)
            app.state.access_token = "first-verified-session"
            # Backend evidence revalidation rejects forged/stale evidence even with a valid review.
            forged = "00000000-0000-4000-8000-000000000002"
            forged_nonce = client.get(f"/api/plugins/plur1bus/workshop/approve/preview/{forged}?revision={revision}").json()["nonce"]
            self.assertEqual(client.post("/api/plugins/plur1bus/workshop/approve", json={"proposal_id": forged, "revision": revision}, headers={**headers, "X-Plur1bus-Action-Nonce": forged_nonce}).status_code, 409)
