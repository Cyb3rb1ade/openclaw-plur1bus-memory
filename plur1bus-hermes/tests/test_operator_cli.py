import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from plur1bus_hermes.operator_cli import main, runtime_view


class OperatorCliTests(unittest.TestCase):
    def test_compact_defaults_to_read_only(self):
        with patch("plur1bus_hermes.operator_cli.runtime_view", return_value=SimpleNamespace()), \
             patch("plur1bus_hermes.operator_cli.read_operator_status", return_value={}), \
             patch("plur1bus_hermes.operator_cli.optimize_runtime_table") as optimize, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(["--hermes-home", "/unused", "--agent", "default", "compact"]), 0)
            optimize.assert_not_called()
            self.assertIn('"dryRun": true', output.getvalue())

    def test_explicit_compact_apply(self):
        with patch("plur1bus_hermes.operator_cli.runtime_view", return_value=SimpleNamespace()) as view, \
             patch("plur1bus_hermes.operator_cli.optimize_runtime_table", return_value={}) as optimize, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--hermes-home", "/unused", "--agent", "default", "compact", "--apply"]), 0)
            optimize.assert_called_once_with(view.return_value, authorized=True)

    def test_failure_redacts_exception_message(self):
        with patch("plur1bus_hermes.operator_cli.runtime_view", side_effect=ValueError("secret-key")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(["--hermes-home", "/unused", "--agent", "default", "status"]), 1)
            self.assertNotIn("secret-key", output.getvalue())

    def test_profile_identity_wins_over_config_agent_id_without_alias(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            __import__("plur1bus_hermes.operator_cli", fromlist=["Plur1busMemoryProvider"]).Plur1busMemoryProvider,
            "_runtime_config", return_value={"agentId": "main", "dataDir": "plur1bus"}
        ) as config:
            view = runtime_view(Path(directory), "foo")
        config.assert_called_once_with("foo")
        self.assertEqual(view.agent_id, "foo")

    def test_activate_requires_exact_saved_plan_approval_without_runtime(self):
        plan = {"planId": "a" * 24}
        runtime = SimpleNamespace(data_dir=Path("/data"), agent_id="default", config={"embedding": {}})
        with tempfile.TemporaryDirectory() as directory:
            target, saved = Path(directory) / "target.json", Path(directory) / "plan.json"
            target.write_text(json.dumps({"model": "m", "dimensions": 2}), encoding="utf-8")
            saved.write_text(json.dumps(plan), encoding="utf-8")
            with patch("plur1bus_hermes.operator_cli.runtime_view", return_value=runtime) as view, \
                 patch("plur1bus_hermes.generation.activate_staged_generation", return_value={"activated": True}) as activate, \
                 patch("plur1bus_hermes.runtime.Plur1busRuntime") as runtime_class, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(["--hermes-home", "/unused", "--agent", "default", "reembed",
                                       "--target-embedding", str(target), "--plan", str(saved), "--activate",
                                       "--approved-plan-id", "a" * 24]), 0)
            view.assert_called_once_with(Path("/unused"), "default", apply_generation=False)
            activate.assert_called_once()
            runtime_class.assert_not_called()

    def test_reembed_actions_are_mutually_exclusive_and_redacted(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(["--hermes-home", "/unused", "--agent", "default", "reembed",
                                   "--target-embedding", "/missing", "--apply", "--activate"]), 1)
        self.assertIn('"operator_action_failed"', output.getvalue())

    def test_recover_uses_raw_view_and_exact_approval(self):
        plan = {"planId": "b" * 24}
        runtime = SimpleNamespace(data_dir=Path("/data"), agent_id="default", config={"embedding": {}})
        with tempfile.TemporaryDirectory() as directory:
            target, saved = Path(directory) / "target.json", Path(directory) / "plan.json"
            target.write_text(json.dumps({"model": "m", "dimensions": 2}), encoding="utf-8")
            saved.write_text(json.dumps(plan), encoding="utf-8")
            with patch("plur1bus_hermes.operator_cli.runtime_view", return_value=runtime) as view, \
                 patch("plur1bus_hermes.generation.recover_generation", return_value={"recovered": True}) as recover, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(["--hermes-home", "/unused", "--agent", "default", "reembed",
                                       "--target-embedding", str(target), "--plan", str(saved), "--recover",
                                       "--approved-plan-id", "b" * 24]), 0)
            view.assert_called_once_with(Path("/unused"), "default", apply_generation=False)
            recover.assert_called_once()

    def test_workspace_source_plan_approve_apply_revoke_and_drift(self):
        source = Path("/explicit/source")
        runtime = SimpleNamespace(data_dir=Path("/data"), agent_id="default", config={}, scope_binding=SimpleNamespace(as_dict=lambda: {}))
        plan = {"revision": "consent-revision", "sourceManifest": {"revision": "source-revision"}}
        writer = SimpleNamespace(shutdown=lambda: None)
        with patch("plur1bus_hermes.operator_cli.runtime_view", return_value=runtime), \
             patch("plur1bus_hermes.workspace_consent.plan_workspace_consent", return_value=plan) as make_plan, \
             patch("plur1bus_hermes.workspace_consent.approve_workspace_consent", return_value={"approved": True}) as approve, \
             patch("plur1bus_hermes.runtime.Plur1busRuntime", return_value=writer) as writer_class, \
             patch("plur1bus_hermes.workspace_consent.apply_workspace_consent", return_value={"imported": ["one"]}) as apply, \
             patch("plur1bus_hermes.workspace_consent.revoke_workspace_consent", return_value={"revoked": True}) as revoke, \
             contextlib.redirect_stdout(io.StringIO()):
            base = ["--hermes-home", "/unused", "--agent", "default", "workspace-source"]
            self.assertEqual(main([*base, "plan", "--source", str(source)]), 0)
            self.assertEqual(main([*base, "approve", "--source", str(source), "--approved-revision", "consent-revision"]), 0)
            self.assertEqual(main([*base, "apply", "--source", str(source), "--approved-revision", "consent-revision"]), 0)
            self.assertEqual(main([*base, "revoke", "--source", str(source), "--approved-revision", "consent-revision"]), 0)
        make_plan.assert_called_with(runtime, source)
        approve.assert_called_once_with(runtime, plan, approved_revision="consent-revision")
        writer_class.assert_called_once_with(runtime.data_dir, runtime.config, runtime.agent_id, runtime.scope_binding.as_dict())
        apply.assert_called_once_with(writer, source, approved_revision="consent-revision")
        revoke.assert_called_once_with(runtime, source, approved_revision="consent-revision")

        with patch("plur1bus_hermes.operator_cli.runtime_view", return_value=runtime), \
             patch("plur1bus_hermes.workspace_consent.plan_workspace_consent", side_effect=ValueError("source drift")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(["--hermes-home", "/unused", "--agent", "default", "workspace-source",
                                   "approve", "--source", str(source), "--approved-revision", "consent-revision"]), 1)
        self.assertIn('"operator_action_failed"', output.getvalue())
        self.assertNotIn("source drift", output.getvalue())
