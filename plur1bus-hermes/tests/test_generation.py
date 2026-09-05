"""Activation pointer tests use a real staged 2D LanceDB target."""

from __future__ import annotations

import json
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import lancedb

from plur1bus_hermes.generation import (
    _atomic_json, _generation_dir, _manifest, activate_staged_generation,
    effective_generation_config, read_generation, recover_generation,
    resolve_generation_route,
)
from plur1bus_hermes.operator_cli import main as operator_main
from plur1bus_hermes.namespaces import NamespaceRoute
from plur1bus_hermes.reembed_staged import apply_staged_reembed, plan_staged_reembed
from plur1bus_hermes.runtime_lease import acquire_runtime_lease
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.validation import ValidationError


class _Backend:
    def __init__(self, _config, _home): pass
    def embed(self, text): return [float(len(text)), 1.0]
    def close(self): pass


class GenerationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.agent = "default"
        self.source = self.root / "lancedb" / self.agent
        self.source.mkdir(parents=True)
        lancedb.connect(str(self.source)).create_table("memories", data=[
            {"id": "a", "content": "one", "vector": [0.0], "agentId": self.agent, "scopeKey": "private", "metadataJson": "{\"x\":1}"},
            {"id": "b", "content": "two", "vector": [0.0], "agentId": self.agent, "scopeKey": "private", "metadataJson": "{\"x\":2}"},
        ])
        self.config = {"embedding": {"provider": "test", "model": "target-2d", "dimensions": 2, "apiKeyEnv": "PLUR1BUS_TEST_KEY"}}
        self.plan = plan_staged_reembed(self.root, self.agent, self.config)
        self.assertEqual(apply_staged_reembed(self.plan, self.root, self.agent, self.config, connect=None, backend_factory=_Backend)["completion"], "staged")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_activation_exact_identity_pointer_and_nonsecret_config(self) -> None:
        report = activate_staged_generation(self.plan, self.root, self.agent, self.config, approved_plan_id=self.plan["planId"])
        self.assertTrue(report["activated"])
        manifest = read_generation(self.root, self.agent)
        self.assertEqual(manifest["targetRoute"], self.plan["targetRoute"])
        self.assertNotIn("PLUR1BUS_TEST_KEY=", json.dumps(manifest))
        effective = effective_generation_config(self.root, self.agent, self.config)
        self.assertEqual(effective["embedding"]["apiKeyEnv"], "PLUR1BUS_TEST_KEY")
        route = resolve_generation_route(self.root, self.agent, NamespaceRoute("default", self.source, True))
        self.assertEqual(route.path, Path(self.plan["targetRoute"]))
        self.assertTrue(activate_staged_generation(self.plan, self.root, self.agent, self.config, approved_plan_id=self.plan["planId"])["idempotent"])

    def test_operator_status_and_optimize_use_certified_active_generation(self) -> None:
        from types import SimpleNamespace
        from plur1bus_hermes.namespaces import binding_from_scope, resolve_namespace_routes
        from plur1bus_hermes.operator_status import optimize_runtime_table, read_operator_status

        activate_staged_generation(self.plan, self.root, self.agent, self.config,
                                   approved_plan_id=self.plan["planId"])
        route, _ = resolve_namespace_routes(self.root, self.agent, self.config)
        runtime = SimpleNamespace(agent_id=self.agent, data_dir=self.root.resolve(), config=self.config,
                                  _writer_route=route, scope_binding=binding_from_scope(self.agent))
        self.assertEqual(read_operator_status(runtime)["storage"]["status"], "ready")
        self.assertTrue(optimize_runtime_table(runtime, authorized=True)["ok"])
        self.assertEqual(lancedb.connect(str(route.path)).open_table("memories").count_rows(), 2)
        runtime._writer_route = NamespaceRoute("default", self.source, True)
        self.assertEqual(read_operator_status(runtime)["storage"]["status"], "degraded")

    def test_tampered_target_identity_and_pointer_drift_fail_closed(self) -> None:
        target = lancedb.connect(self.plan["targetRoute"]).open_table("memories")
        target.update(where="id = 'b'", values={"content": "tampered"})
        with self.assertRaisesRegex(ValidationError, "non-vector"):
            activate_staged_generation(self.plan, self.root, self.agent, self.config, approved_plan_id=self.plan["planId"])
        pointer = _generation_dir(self.root, self.agent) / "active.json"
        pointer.parent.mkdir(parents=True)
        pointer.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "agentId|manifest"):
            read_generation(self.root, self.agent)
        pointer.unlink()
        pointer.symlink_to(self.root / "missing")
        with self.assertRaisesRegex(ValidationError, "pointer"):
            read_generation(self.root, self.agent)

    def test_runtime_lease_blocks_and_recovery_resumes_prepared_pointer(self) -> None:
        lease = acquire_runtime_lease(self.root)
        try:
            with self.assertRaisesRegex(RuntimeError, "runtime lease"):
                activate_staged_generation(self.plan, self.root, self.agent, self.config, approved_plan_id=self.plan["planId"])
        finally:
            lease.close()
        source = self.source.resolve()
        target = Path(self.plan["targetRoute"])
        manifest = _manifest(self.plan, source, target, self.agent, self.config)
        journal = _generation_dir(self.root, self.agent) / f"journal-{self.plan['planId']}.json"
        _atomic_json(journal, {"state": "prepared", "plan": self.plan, "manifest": manifest, "oldPointer": None})
        recovered = recover_generation(self.root, self.agent, self.config, approved_plan_id=self.plan["planId"])
        self.assertTrue(recovered["activated"])
        self.assertEqual(read_generation(self.root, self.agent)["planId"], self.plan["planId"])

    def test_direct_credentials_are_rejected_not_silently_stripped(self) -> None:
        insecure = {"embedding": {**self.config["embedding"], "apiKey": "direct-secret"}}
        with self.assertRaisesRegex(ValidationError, "environment"):
            activate_staged_generation(self.plan, self.root, self.agent, insecure, approved_plan_id=self.plan["planId"])
        self.assertFalse((_generation_dir(self.root, self.agent) / "active.json").exists())

    def test_corrupt_or_mismatched_pointer_never_routes_fallback(self) -> None:
        pointer = _generation_dir(self.root, self.agent) / "active.json"
        pointer.parent.mkdir(parents=True)
        pointer.write_text("{bad", encoding="utf-8")
        canonical = NamespaceRoute("default", self.source, True)
        with self.assertRaises(ValidationError):
            resolve_generation_route(self.root, self.agent, canonical)
        pointer.unlink()
        manifest = _manifest(self.plan, self.source.resolve(), Path(self.plan["targetRoute"]), self.agent, self.config)
        manifest["targetRoute"] = str(self.root / "lancedb" / ".wrong")
        manifest["digest"] = __import__("plur1bus_hermes.generation", fromlist=["_digest"])._digest({k: v for k, v in manifest.items() if k != "digest"})
        _atomic_json(pointer, manifest)
        with self.assertRaisesRegex(ValidationError, "route"):
            read_generation(self.root, self.agent)

    def test_forged_journal_does_not_mutate_pointer(self) -> None:
        source, target = self.source.resolve(), Path(self.plan["targetRoute"])
        manifest = _manifest(self.plan, source, target, self.agent, self.config)
        journal = _generation_dir(self.root, self.agent) / f"journal-{self.plan['planId']}.json"
        forged = dict(manifest)
        forged["sourcePin"] = "forged"
        forged["digest"] = __import__("plur1bus_hermes.generation", fromlist=["_digest"])._digest({k: v for k, v in forged.items() if k != "digest"})
        _atomic_json(journal, {"state": "prepared", "plan": self.plan, "manifest": forged, "oldPointer": None})
        with self.assertRaisesRegex(ValidationError, "expected manifest"):
            recover_generation(self.root, self.agent, self.config, approved_plan_id=self.plan["planId"])
        self.assertFalse((_generation_dir(self.root, self.agent) / "active.json").exists())

    def test_pointer_swapped_is_blocked_until_validated_recovery(self) -> None:
        source, target = self.source.resolve(), Path(self.plan["targetRoute"])
        manifest = _manifest(self.plan, source, target, self.agent, self.config)
        pointer = _generation_dir(self.root, self.agent) / "active.json"
        journal = _generation_dir(self.root, self.agent) / f"journal-{self.plan['planId']}.json"
        _atomic_json(pointer, manifest)
        _atomic_json(journal, {"state": "pointer_swapped", "plan": self.plan, "manifest": manifest, "oldPointer": None})
        with self.assertRaisesRegex(ValidationError, "recovery"):
            read_generation(self.root, self.agent)
        self.assertTrue(recover_generation(self.root, self.agent, self.config, approved_plan_id=self.plan["planId"])["recovered"])
        self.assertEqual(read_generation(self.root, self.agent)["digest"], manifest["digest"])

    def test_crash_between_pointer_write_and_journal_ack_is_recoverable(self) -> None:
        manifest = _manifest(self.plan, self.source.resolve(), Path(self.plan["targetRoute"]), self.agent, self.config)
        directory = _generation_dir(self.root, self.agent)
        _atomic_json(directory / "active.json", manifest)
        _atomic_json(directory / f"journal-{self.plan['planId']}.json", {
            "state": "prepared", "plan": self.plan, "manifest": manifest, "oldPointer": None,
        })
        with self.assertRaises(ValidationError):
            read_generation(self.root, self.agent)
        self.assertTrue(recover_generation(self.root, self.agent, self.config,
                                          approved_plan_id=self.plan["planId"])["recovered"])

    def test_runtime_lease_to_generation_switch_preserves_old_source(self) -> None:
        """A live old runtime blocks activation; a new one writes only the target."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "hermes-home"
            (home / "plugins" / "plur1bus").mkdir(parents=True)
            source_config = {"embedding": {"provider": "test", "model": "source-1d", "dimensions": 1}}
            target_config = {"embedding": {"provider": "test", "model": "target-2d", "dimensions": 2, "apiKeyEnv": "TEST_KEY"}}
            (home / "plugins" / "plur1bus" / "config.json").write_text(
                json.dumps({"dataDir": str(root), **source_config}), encoding="utf-8"
            )

            def embed(backend, _text, *, purpose="passage"):
                return [1.0] * int(backend.config["dimensions"])

            with patch("plur1bus_hermes.runtime.EmbeddingBackend.embed", new=embed):
                old = Plur1busRuntime(root, source_config, "default")
                try:
                    old._remember("old source card", "s1", "user")
                    plan = plan_staged_reembed(root, "default", target_config)
                    self.assertEqual(
                        apply_staged_reembed(plan, root, "default", target_config, backend_factory=_Backend)["completion"],
                        "staged",
                    )
                    with self.assertRaisesRegex(RuntimeError, "runtime lease"):
                        activate_staged_generation(plan, root, "default", target_config, approved_plan_id=plan["planId"])
                finally:
                    old.shutdown()

                target_json, saved_plan = root / "target.json", root / "saved-plan.json"
                target_json.write_text(json.dumps(target_config["embedding"]), encoding="utf-8")
                saved_plan.write_text(json.dumps(plan), encoding="utf-8")
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(operator_main([
                        "--hermes-home", str(home), "--agent", "default", "reembed",
                        "--target-embedding", str(target_json), "--plan", str(saved_plan), "--activate",
                        "--approved-plan-id", plan["planId"],
                    ]), 0)
                self.assertTrue(json.loads(output.getvalue())["activated"])
                source = root / "lancedb" / "default"
                source_count = lancedb.connect(str(source)).open_table("memories").count_rows()
                fresh = Plur1busRuntime(root, source_config, "default")
                try:
                    self.assertEqual(fresh.config["embedding"]["dimensions"], 2)
                    self.assertEqual(fresh._writer_route.path, Path(plan["targetRoute"]))
                    fresh._remember("new target card", "s2", "user")
                finally:
                    fresh.shutdown()
                self.assertEqual(lancedb.connect(str(source)).open_table("memories").count_rows(), source_count)
                self.assertEqual(lancedb.connect(plan["targetRoute"]).open_table("memories").count_rows(), source_count + 1)
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(operator_main([
                        "--hermes-home", str(home), "--agent", "default", "reembed",
                        "--target-embedding", str(target_json), "--plan", str(saved_plan), "--activate",
                        "--approved-plan-id", plan["planId"],
                    ]), 0)
                self.assertTrue(json.loads(output.getvalue())["idempotent"])
                self.assertTrue(recover_generation(root, "default", target_config,
                                                  approved_plan_id=plan["planId"])["idempotent"])


if __name__ == "__main__":
    unittest.main()
