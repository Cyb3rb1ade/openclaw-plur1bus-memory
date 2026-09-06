"""Installer model changes use real LanceDB, fake embeddings, and isolated homes."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import lancedb
from plur1bus_hermes.setup_retrieval import review, execute
from plur1bus_hermes.generation import read_generation
from plur1bus_hermes.runtime import EmbeddingBackend
from plur1bus_hermes.runtime_lease import acquire_runtime_lease


class SetupRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        (self.home / "config.yaml").write_text("memory: {provider: plur1bus}\n")
        self.path = self.home / "plugins/plur1bus/config.json"
        self.path.parent.mkdir(parents=True)
        self.config = {"embedding": {"provider": "local-transformers", "model": "old", "dimensions": 1},
                       "reranker": {"provider": "disabled"}, "retrieval": {"mode": "plur1bus"}, "keep": True}
        self.path.write_text(json.dumps(self.config))
        self.data = self.home / "plur1bus"
        self.source = self.data / "lancedb/default"
        self.source.mkdir(parents=True)
        self.rows = [{"id": "a", "content": "one", "vector": [1.0], "scopeKey": "private", "validUntil": 123},
                     {"id": "b", "content": "two", "vector": [0.0], "scopeKey": "private", "validUntil": 456}]
        lancedb.connect(str(self.source)).create_table("memories", data=self.rows)
        self.target = {"provider": "local-transformers", "model": "new", "dimensions": 2}

    def plan(self):
        return review(self.home, "default", "embedding", self.target)

    def test_plan_has_no_model_calls_and_writes_require_exact_confirmation(self):
        before = sorted(str(p) for p in self.home.rglob("*"))
        with patch.object(EmbeddingBackend, "embed", side_effect=AssertionError("no model calls")):
            plan = self.plan()
        self.assertEqual(before, sorted(str(p) for p in self.home.rglob("*")))
        self.assertEqual(plan["migration"]["sourceCards"], 2)
        with self.assertRaises(ValueError):
            execute(self.home, "default", "embedding", self.target, "stage", confirmation="wrong", stopped=True)
        self.assertFalse((self.data / "state").exists())

    def test_stage_backup_validate_activate_preserves_records_and_original_vectors(self):
        plan = self.plan()
        with patch.object(EmbeddingBackend, "embed", return_value=[0.2, 0.3]):
            result = execute(self.home, "default", "embedding", self.target, "stage", confirmation=plan["confirmation"], stopped=True)
        self.assertTrue(result["backup"])
        self.assertFalse(result["active"])
        self.assertIsNone(read_generation(self.data, "default"))
        self.assertEqual(self.plan()["confirmation"], plan["confirmation"])
        self.assertTrue(execute(self.home, "default", "embedding", self.target, "validate")["validated"])
        self.assertTrue(execute(self.home, "default", "embedding", self.target, "activate", confirmation=plan["confirmation"], stopped=True)["activated"])
        source = lancedb.connect(str(self.source)).open_table("memories").to_arrow().to_pylist()
        target = lancedb.connect(plan["migration"]["targetRoute"]).open_table("memories").to_arrow().to_pylist()
        self.assertEqual(source, self.rows)
        self.assertEqual([{k: v for k, v in row.items() if k != "vector"} for row in source],
                         [{k: v for k, v in row.items() if k != "vector"} for row in target])
        self.assertEqual(json.loads(self.path.read_text()), self.config)

    def test_unbacked_stage_cannot_be_activated_by_installer(self):
        from plur1bus_hermes.reembed_staged import apply_staged_reembed
        plan = self.plan()
        with patch.object(EmbeddingBackend, "embed", return_value=[0.2, 0.3]):
            apply_staged_reembed(plan["migration"], self.data, "default", {**self.config, "embedding": self.target})
        with self.assertRaisesRegex(ValueError, "verified source backup"):
            execute(self.home, "default", "embedding", self.target, "activate", confirmation=plan["confirmation"], stopped=True)
        self.assertIsNone(read_generation(self.data, "default"))

    def test_validation_rejects_changed_nonvector_metadata(self):
        plan = self.plan()
        with patch.object(EmbeddingBackend, "embed", return_value=[0.2, 0.3]):
            execute(self.home, "default", "embedding", self.target, "stage", confirmation=plan["confirmation"], stopped=True)
        target = lancedb.connect(plan["migration"]["targetRoute"]).open_table("memories")
        target.update(where="id = 'a'", values={"validUntil": 999})
        with self.assertRaises(ValueError):
            execute(self.home, "default", "embedding", self.target, "validate")
        self.assertIsNone(read_generation(self.data, "default"))

    def test_stale_config_and_live_runtime_refuse_staging(self):
        plan = self.plan()
        lease = acquire_runtime_lease(self.data)
        try:
            with self.assertRaises(RuntimeError):
                execute(self.home, "default", "embedding", self.target, "stage", confirmation=plan["confirmation"], stopped=True)
        finally:
            lease.close()
        self.path.write_text(json.dumps({**self.config, "keep": False}))
        with self.assertRaises(ValueError):
            execute(self.home, "default", "embedding", self.target, "stage", confirmation=plan["confirmation"], stopped=True)

    def test_model_preparation_probes_without_switching_or_migrating(self):
        plan = self.plan()
        with patch.object(EmbeddingBackend, "embed", return_value=[0.2, 0.3]) as probe:
            result = execute(self.home, "default", "embedding", self.target, "prepare", confirmation=plan["confirmation"], stopped=True)
        self.assertTrue(result["activeConfigurationUnchanged"])
        self.assertEqual(probe.call_args.args, ("PLUR1BUS configuration probe",))
        self.assertEqual(json.loads(self.path.read_text()), self.config)
        self.assertIsNone(read_generation(self.data, "default"))

    def test_native_onnx_reranker_prepare_requires_review_stop_and_never_activates(self):
        target = {
            "provider": "local-onnx", "model": "BAAI/bge-reranker-v2-m3",
            "revision": "6f5ff65298512715a1e669753bc754d2bc8f367b",
            "modelDir": str(self.home / "models/bge"), "localFilesOnly": True,
            "maxTokens": 512, "batchSize": 8,
        }
        plan = review(self.home, "default", "reranker", target)
        with self.assertRaisesRegex(ValueError, "stop affected"):
            execute(self.home, "default", "reranker", target, "prepare", confirmation=plan["confirmation"], stopped=False)
        with patch("plur1bus_hermes.retrieval_admin.prepare_reranker", return_value={
            "prepared": True, "modelProbePassed": True, "activeConfigurationUnchanged": True,
        }) as prepare:
            result = execute(self.home, "default", "reranker", target, "prepare", confirmation=plan["confirmation"], stopped=True)
        self.assertTrue(result["prepared"])
        self.assertTrue(result["modelProbePassed"])
        self.assertTrue(result["activeConfigurationUnchanged"])
        self.assertEqual(prepare.call_args.args[1:], (target, plan["revision"]))
        self.assertEqual(json.loads(self.path.read_text()), self.config)
        self.assertIsNone(read_generation(self.data, "default"))

    def test_reranker_for_new_named_profile_override_never_changes_root(self):
        profile = self.home / "profiles/alpha"
        profile.mkdir(parents=True)
        (profile / "config.yaml").write_text("memory: {provider: plur1bus}\n")
        target = {"provider": "disabled"}
        plan = review(self.home, "alpha", "reranker", target)
        self.assertEqual(plan["configPath"], str(profile / "plugins/plur1bus/config.json"))
        self.assertTrue(execute(self.home, "alpha", "reranker", target, "activate", confirmation=plan["confirmation"], stopped=True)["saved"])
        self.assertEqual(json.loads(self.path.read_text()), self.config)
        self.assertTrue((profile / "plugins/plur1bus/config.json").is_file())

    def test_empty_new_profile_requires_successful_model_probe(self):
        profile = self.home / "profiles/empty"
        profile.mkdir(parents=True)
        (profile / "config.yaml").write_text("memory: {provider: plur1bus}\n")
        plan = review(self.home, "empty", "embedding", self.target)
        self.assertEqual(plan["operation"], "configure-empty-store")
        with patch.object(EmbeddingBackend, "embed", return_value=[0.2]):
            with self.assertRaises(ValueError):
                execute(self.home, "empty", "embedding", self.target, "activate", confirmation=plan["confirmation"], stopped=True)
        self.assertFalse((profile / "plugins/plur1bus/config.json").exists())
        with patch.object(EmbeddingBackend, "embed", return_value=[0.2, 0.3]):
            self.assertTrue(execute(self.home, "empty", "embedding", self.target, "activate", confirmation=plan["confirmation"], stopped=True)["saved"])
        self.assertEqual(json.loads(self.path.read_text()), self.config)
