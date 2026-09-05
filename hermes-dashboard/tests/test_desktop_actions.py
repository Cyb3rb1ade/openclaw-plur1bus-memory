"""Native transport cannot reuse browser cookies or bypass reviewed actions."""
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_plur1bus_dashboard import _load_api


class DesktopActionsTests(unittest.TestCase):
    def test_native_confirmation_requires_token_scope_revision_and_single_use_nonce(self):
        api = _load_api()
        view = SimpleNamespace(profile="default", hermes_home=Path("/safe/home"))
        runtime = SimpleNamespace(agent_id="default", scope_key="own",
                                  _writer_route=SimpleNamespace(name="default", path="/safe/db"))
        revision = "a" * 64
        calls = []

        class Workshop:
            def __init__(self, _runtime):
                pass

            def inspect(self, identifier):
                return {"id": identifier, "revision": revision, "title": "Test", "instructions": "Review this"}

            def approve(self, identifier, rev):
                calls.append((identifier, rev))
                return {"ok": True}

            def publish(self, identifier, rev, home):
                calls.append((identifier, rev, home))
                return {"ok": True}

        @contextmanager
        def lease():
            yield runtime, view

        app = FastAPI()
        app.include_router(api.router)
        headers = {"X-Hermes-Session-Token": "test-host-token"}
        with patch("hermes_cli.web_server._SESSION_TOKEN", "test-host-token"), patch.object(
            api, "_runtime_lease", lease
        ), patch.object(api, "SkillWorkshop", Workshop), TestClient(app) as client:
            self.assertFalse(client.get("/desktop/capabilities").json()["workshopActions"])
            self.assertTrue(client.get("/desktop/capabilities", headers=headers).json()["workshopActions"])
            for verb in ("approve", "publish"):
                preview = client.get(f"/workshop/{verb}/preview/id?revision={revision}", headers=headers).json()
                body = {"proposal_id": "id", "revision": revision, "confirmation": verb, "nonce": preview["nonce"]}
                url = f"/desktop/workshop/{verb}"
                self.assertEqual(client.post(url, json=body).status_code, 401)
                for extra in ({"Origin": "http://testserver"}, {"Origin": "http://evil.invalid"}, {"Sec-Fetch-Site": "same-origin"}):
                    self.assertEqual(client.post(url, json=body, headers={**headers, **extra}).status_code, 403)
                self.assertEqual(client.post(url, json={**body, "confirmation": "wrong"}, headers=headers).status_code, 403)
                self.assertEqual(client.post(url, json={**body, "nonce": "wrong"}, headers=headers).status_code, 409)
                self.assertEqual(client.post(url, json=body, headers=headers).status_code, 200)
                self.assertEqual(client.post(url, json=body, headers=headers).status_code, 409)
            self.assertEqual(len(calls), 2)
            nonce = client.get(f"/workshop/approve/preview/id?revision={revision}", headers=headers).json()["nonce"]
            runtime.scope_key = "different"
            self.assertEqual(client.post("/desktop/workshop/approve", headers=headers, json={
                "proposal_id": "id", "revision": revision, "confirmation": "approve", "nonce": nonce
            }).status_code, 409)
            self.assertEqual(len(calls), 2)

    def test_oauth_cookie_identity_alone_is_not_native_authority(self):
        api = _load_api()
        from starlette.requests import Request
        def request(headers):
            r = Request({"type": "http", "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]})
            r.state.session = SimpleNamespace(user_id="u", provider="oauth", access_token="verified")
            return r
        with self.assertRaises(api.HTTPException):
            api._desktop_actor(request({}))
        with self.assertRaises(api.HTTPException):
            api._desktop_actor(request({"Authorization": "Bearer different"}))
        self.assertTrue(api._desktop_actor(request({"Authorization": "Bearer verified"})).startswith("oauth:"))

    def test_memory_http_bounds_and_server_owned_scope(self):
        api = _load_api()
        app = FastAPI()
        app.include_router(api.router)
        with TestClient(app) as client:
            self.assertEqual(client.get("/memories").status_code, 401)
        with patch.object(api, "_actor", return_value="authenticated"), patch.object(api, "_active_runtime_view", return_value="server-scope"), patch.object(
            api, "browse_runtime_memories", return_value={"items": []}
        ) as browse, TestClient(app) as client:
            for query in ("limit=51", "offset=-1", "status=oops", "query=" + "x" * 201):
                self.assertEqual(client.get("/memories?" + query).status_code, 422)
            browse.assert_not_called()
            self.assertEqual(client.get("/memories?agent=foreign&path=/elsewhere").status_code, 200)
            self.assertEqual(browse.call_args.args, ("server-scope",))


if __name__ == "__main__":
    unittest.main()
