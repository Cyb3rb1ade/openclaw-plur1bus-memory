"""Native-only, reviewed, profile-bound retrieval mutation contracts."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from plur1bus_hermes.namespaces import binding_from_scope
from test_plur1bus_dashboard import _load_api


class RetrievalActionsTests(unittest.TestCase):
    def test_review_is_read_only_native_bound_single_use_and_job_is_recoverable(self):
        api = _load_api()
        app = FastAPI()
        app.include_router(api.router)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            view = SimpleNamespace(hermes_home=home, profile="bernhardine", agent_id="bernhardine", data_dir=home / "data",
                config={"embedding": {"provider": "local-onnx", "model": "existing", "dimensions": 768}},
                scope_binding=binding_from_scope("bernhardine"), _writer_route=SimpleNamespace(path=home / "data/lancedb/bernhardine"))
            headers = {"X-Hermes-Session-Token": "test-host-token"}
            with patch("hermes_cli.web_server._SESSION_TOKEN", "test-host-token"), patch.object(
                api, "_active_runtime_view", return_value=view
            ), patch.object(api._retrieval_executor, "submit") as submit, TestClient(app) as client:
                url = "/desktop/retrieval"
                payload = {"kind": "reranker", "target": {"provider": "disabled"}}
                self.assertEqual(client.post(url + "/preview", json=payload).status_code, 401)
                self.assertEqual(client.post(url + "/preview", json=payload, headers={**headers, "Origin": "http://evil"}).status_code, 403)
                self.assertEqual(client.post(url + "/preview", json={**payload, "target": {"provider": "disabled", "apiKey": "secret"}}, headers=headers).status_code, 422)
                preview = client.post(url + "/preview", json=payload, headers=headers).json()
                self.assertEqual(preview["profile"], "bernhardine")
                self.assertEqual(list(home.iterdir()), [], "preview must not write")
                body = {"nonce": preview["nonce"], "confirmation": "reranker"}
                self.assertEqual(client.post(url + "/commit", json={**body, "confirmation": "activate"}, headers=headers).status_code, 409)
                view.profile = "default"
                self.assertEqual(client.post(url + "/commit", json=body, headers=headers).status_code, 409)
                view.profile = "bernhardine"
                committed = client.post(url + "/commit", json=body, headers=headers).json()
                self.assertEqual(client.post(url + "/commit", json=body, headers=headers).status_code, 409)
                submit.assert_called_once()
                identifier = committed["job"]
                self.assertEqual(client.get(url + "/jobs", headers=headers).json()["jobs"][0]["id"], identifier)
                # The actual action is executed once, then polling is read-only.
                api._run_retrieval_job(identifier, view)
                self.assertEqual(client.get(url + "/jobs/" + identifier, headers=headers).json()["status"], "done")
                path = home / "plugins/plur1bus/config.json"
                self.assertEqual(json.loads(path.read_text())["reranker"], {"provider": "disabled"})
                view.profile = "default"
                self.assertEqual(client.get(url + "/jobs/" + identifier, headers=headers).status_code, 404)
                self.assertEqual(client.get(url + "/jobs", headers=headers).json()["jobs"], [])

    def test_background_failure_is_sanitized_and_never_retried(self):
        api = _load_api()
        view = SimpleNamespace(data_dir=Path("/safe"))
        job = {"status": "queued", "kind": "reranker", "target": {}, "revision": "r"}
        api._retrieval_jobs["job"] = job
        with patch("plur1bus_hermes.retrieval_admin.context_revision", return_value="r"), patch(
            "plur1bus_hermes.retrieval_admin.save_reranker", side_effect=RuntimeError("secret endpoint and private memory")
        ) as save:
            api._run_retrieval_job("job", view)
            save.assert_called_once()
        self.assertEqual(job["error"], "retrieval_job_failed")
        self.assertNotIn("secret", json.dumps(job))

    def test_bge_prepare_job_is_reviewed_profile_bound_and_does_not_activate(self):
        api = _load_api()
        app = FastAPI(); app.include_router(api.router)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            profile_home = home / "profiles" / "native"
            view = SimpleNamespace(hermes_home=profile_home, profile="native", agent_id="native", data_dir=home / "data",
                config={"embedding": {"provider": "omlx", "model": "remote", "dimensions": 768}, "reranker": {"provider": "disabled"}},
                scope_binding=binding_from_scope("native"), _writer_route=SimpleNamespace(path=home / "data/lancedb/native"))
            target = {"provider": "local-onnx", "model": "BAAI/bge-reranker-v2-m3",
                      "revision": "6f5ff65298512715a1e669753bc754d2bc8f367b", "modelDir": str(home / "models/bge"),
                      "localFilesOnly": True, "maxTokens": 512, "batchSize": 8}
            headers = {"X-Hermes-Session-Token": "test-host-token"}
            with patch("hermes_cli.web_server._SESSION_TOKEN", "test-host-token"), patch.object(api, "_active_runtime_view", return_value=view), \
                 patch.object(api._retrieval_executor, "submit") as submit, TestClient(app) as client:
                preview = client.post("/desktop/retrieval/preview", json={"kind": "reranker-prepare", "target": target}, headers=headers)
                self.assertEqual(preview.status_code, 200)
                self.assertEqual(list(home.iterdir()), [], "preparation review must not download or write")
                nonce = preview.json()["nonce"]
                committed = client.post("/desktop/retrieval/commit", json={"nonce": nonce, "confirmation": "reranker-prepare"}, headers=headers)
                self.assertEqual(committed.status_code, 200)
                identifier = committed.json()["job"]
                submit.assert_called_once()
                with patch("plur1bus_hermes.retrieval_admin.context_revision", return_value=api._retrieval_jobs[identifier]["revision"]), \
                     patch("plur1bus_hermes.retrieval_admin.prepare_reranker", return_value={"prepared": True, "modelProbePassed": True, "activeConfigurationUnchanged": True}) as prepare:
                    api._run_retrieval_job(identifier, view)
                self.assertEqual(api._retrieval_jobs[identifier]["status"], "done")
                self.assertTrue(api._retrieval_jobs[identifier]["result"]["activeConfigurationUnchanged"])
                self.assertEqual(prepare.call_args.args, (view, target, api._retrieval_jobs[identifier]["revision"]))
                self.assertFalse(profile_home.exists(), "prepare must not reinterpret a profile home as a root or create config")
