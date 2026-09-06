"""Settings validation, profile isolation, backups and real staged migration."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import lancedb
from plur1bus_hermes import retrieval_admin as admin
from plur1bus_hermes.namespaces import binding_from_scope
from plur1bus_hermes.runtime_lease import acquire_runtime_lease
from plur1bus_hermes.reembed_staged import plan_staged_reembed, apply_staged_reembed


class RetrievalAdminTests(unittest.TestCase):
    def test_validation_rejects_secrets_and_unknown_or_unsafe_targets(self):
        target = {"provider": "openai-compatible", "model": "model", "dimensions": 256, "baseUrl": "https://example.com/v1"}
        self.assertEqual(admin.validate_target("embedding", target), target)
        for change in ({"apiKey": "secret"}, {"dimensions": True}, {"dimensions": 0},
                       {"baseUrl": "http://example.com"}, {"baseUrl": "https://u:p@example.com"},
                       {"baseUrl": "https://example.com?key=secret"}, {"apiKeyEnv": "secret-value"},
                       {"provider": "unknown"}, {"fallbackProvider": "omlx"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                admin.validate_target("embedding", {**target, **change})
        self.assertNotIn("apiKey", admin.public_config({**target, "apiKey": "secret"}))
        self.assertNotIn("baseUrl", admin.public_config({**target, "baseUrl": "https://example.com?key=secret"}))

    def test_profile_config_backup_lease_and_staged_real_database(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            path = home / "plugins/plur1bus/config.json"
            path.parent.mkdir(parents=True)
            original = {"unrelated": {"preserve": True}, "embedding": {"provider": "test", "model": "old", "dimensions": 1}}
            path.write_text(json.dumps(original))
            data = home / "plur1bus"
            source = data / "lancedb/default"
            source.mkdir(parents=True)
            lancedb.connect(str(source)).create_table("memories", data=[
                {"id": "a", "content": "private text", "vector": [1.0], "scopeKey": "private", "validUntil": 123}])
            view = SimpleNamespace(hermes_home=home, profile="default", agent_id="default", data_dir=data,
                config=original, scope_binding=binding_from_scope("default"), _writer_route=SimpleNamespace(path=source))
            revision = admin.context_revision(view)
            lease = acquire_runtime_lease(data)
            try:
                with self.assertRaisesRegex(RuntimeError, "runtime lease"):
                    admin.save_reranker(view, {"provider": "disabled"}, revision)
            finally:
                lease.close()
            self.assertEqual(json.loads(path.read_text()), original)
            with patch("plur1bus_hermes.runtime.RerankerBackend._rerank_with", return_value=[{"content": "test"}]):
                with self.assertRaisesRegex(ValueError, "finite score"):
                    admin.save_reranker(view, {"provider": "cohere", "model": "test"}, revision)
            self.assertEqual(json.loads(path.read_text()), original)
            self.assertTrue(admin.save_reranker(view, {"provider": "disabled"}, revision)["saved"])
            self.assertEqual(json.loads(path.read_text())["unrelated"], original["unrelated"])
            self.assertEqual(json.loads(next(path.parent.glob("config.before-reranker-*.json")).read_text()), original)
            with self.assertRaises(ValueError):
                admin.save_reranker(view, {"provider": "disabled"}, revision)
            target = {"provider": "test", "model": "new", "dimensions": 2}
            plan = plan_staged_reembed(data, "default", {**original, "embedding": target})
            class Backend:
                def __init__(self, *_args): pass
                def embed(self, _text): return [0.5, 0.5]
                def close(self): pass
            def apply(*args, **kwargs):
                return apply_staged_reembed(*args, **kwargs, backend_factory=Backend)
            with patch("plur1bus_hermes.reembed_staged.apply_staged_reembed", side_effect=apply):
                result = admin.stage_embedding(view, target, plan, lambda _value: None)
            self.assertTrue(result["validated"])
            self.assertFalse(result["active"])
            self.assertEqual(lancedb.connect(str(source)).open_table("memories").to_arrow().to_pylist()[0]["vector"], [1.0])
            self.assertEqual(lancedb.connect(plan["targetRoute"]).open_table("memories").to_arrow().to_pylist()[0]["validUntil"], 123)
            self.assertTrue(list((data / "state/default/retrieval-backups").glob("*/snapshot.json")))
            path.unlink()
            path.symlink_to(home / "elsewhere")
            with self.assertRaises(ValueError):
                admin.context_revision(view)

    def test_native_prepare_uses_the_bound_named_profile_view_without_config_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile_home = root / "profiles" / "bernhardine"
            data = root / "data"; data.mkdir()
            target = {"provider": "local-onnx", "model": "BAAI/bge-reranker-v2-m3",
                      "revision": "6f5ff65298512715a1e669753bc754d2bc8f367b", "modelDir": str(root / "models/bge"),
                      "localFilesOnly": True, "maxTokens": 512, "batchSize": 8}
            view = SimpleNamespace(hermes_home=profile_home, profile="bernhardine", data_dir=data)
            with patch("plur1bus_hermes.retrieval_admin.context_revision", return_value="reviewed"), \
                 patch("plur1bus_hermes.retrieval_admin.prepare_reranker_model", return_value={"prepared": True}) as prepare, \
                 patch("plur1bus_hermes.runtime.RerankerBackend._rerank_with", return_value=[{"rerankScore": 0.2}]):
                result = admin.prepare_reranker(view, target, "reviewed")
            self.assertTrue(result["modelProbePassed"])
            self.assertEqual(prepare.call_args.args, (target,))
            self.assertFalse(profile_home.exists())
            self.assertFalse((root / "plugins").exists())
