import contextlib
import io
import unittest
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
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as directory, patch.object(
            __import__("plur1bus_hermes.operator_cli", fromlist=["Plur1busMemoryProvider"]).Plur1busMemoryProvider,
            "_runtime_config", return_value={"agentId": "main", "dataDir": "plur1bus"}
        ) as config:
            view = runtime_view(Path(directory), "foo")
        config.assert_called_once_with("foo")
        self.assertEqual(view.agent_id, "foo")
