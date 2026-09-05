"""Regression coverage for functional `/plur1bus` command dispatch."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import lancedb

from plur1bus_controls.plugin import Plur1busControlsPlugin
from plur1bus_controls.request_context import RequestIdentity


class ControlsTests(unittest.TestCase):
    def test_bootstrap_registers_command_and_all_documented_hooks(self) -> None:
        commands = []
        hooks = {}

        class Context:
            def register_command(self, name, *, handler, description):
                commands.append((name, handler, description))

            def register_hook(self, name, callback):
                hooks[name] = callback

        plugin = Plur1busControlsPlugin()
        plugin.bootstrap(Context())

        self.assertEqual(commands[0][0], "plur1bus")
        self.assertEqual(
            set(hooks),
            {"on_session_start", "on_session_end", "pre_llm_call", "post_llm_call", "pre_gateway_dispatch"},
        )
        self.assertEqual(hooks["pre_gateway_dispatch"](event=None), {"action": "allow"})

    def test_status_and_doctor_use_real_domain_store(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            plugin_dir = home / "plugins" / "plur1bus"
            plugin_dir.mkdir(parents=True)
            (plugin_dir / "config.json").write_text(json.dumps({
                "dataDir": "data",
                "agentId": "main",
                "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
                "reranker": {"provider": "disabled"},
            }), encoding="utf-8")
            agent_dir = home / "data" / "lancedb" / "main"
            agent_dir.mkdir(parents=True)
            lancedb.connect(str(agent_dir)).create_table("memories", data=[{
                "id": "619c3d51-1d9d-4736-8bf9-91b38aff8246",
                "agentId": "main",
                "scopeKey": "scope",
                "sessionId": "session",
                "content": "Memory",
                "status": "active",
                "type": "observation",
                "sourceRole": "user",
                "createdAt": "now",
                "vector": [1.0, 0.0, 0.0, 0.0],
            }])
            plugin = Plur1busControlsPlugin({"hermesHome": str(home), "agentId": "main"})

            status = json.loads(plugin.handle_command("status"))
            doctor = json.loads(plugin.handle_command("doctor"))
            self.assertEqual(status["status"], "degraded")
            self.assertFalse(status["providerReady"])
            self.assertEqual(status["coverageStatus"], "partial")
            self.assertEqual(doctor["memoryRows"], 1)

    def test_reminder_create_requires_identity_confirmation_and_uses_runtime_scope(self) -> None:
        created = []
        binding = {"scopeType": "chat", "workspace": "workspace", "platform": "telegram", "user": "user", "chat": "chat", "account": ""}

        class Domain:
            def create_reminder(self, memory_id, due_at, *, text=None, acl_bindings=None):
                if not str(due_at).endswith("Z"):
                    raise ValueError("absolute time required")
                created.append((memory_id, due_at, text, acl_bindings))
                return {"created": True, "id": memory_id}

        runtime = SimpleNamespace(
            config={},
            _domain=Domain(),
            scope_binding=SimpleNamespace(as_dict=lambda: dict(binding)),
            _table=lambda create=False: (None, None),
        )
        identity = RequestIdentity("telegram", "user", "chat", "private", "main", True, "workspace", "chat")
        plugin = Plur1busControlsPlugin({"agentId": "main"})
        with patch.object(plugin, "_runtime", return_value=runtime), patch(
            "plur1bus_controls.plugin.current_identity", return_value=identity,
        ):
            first = json.loads(plugin.handle_command(
                "reminders create 11111111-1111-4111-8111-111111111111 2026-12-01T10:00:00Z dentist"
            ))
            self.assertEqual(first["status"], "confirmation_required")
            second = json.loads(plugin.handle_command(
                "reminders create 11111111-1111-4111-8111-111111111111 2026-12-01T10:00:00Z dentist "
                f"--confirm {first['nonce']}"
            ))
            self.assertTrue(second["created"])
            self.assertEqual(created[0][3], binding)

    def test_reminder_create_forwards_invalid_time_to_scoped_domain_rejection(self) -> None:
        class Domain:
            def create_reminder(self, *_args, **_kwargs):
                raise ValueError("absolute time required")

        runtime = SimpleNamespace(
            config={"controls": {"allowMutatingCommands": True}},
            _domain=Domain(),
            scope_binding=SimpleNamespace(as_dict=lambda: {"scopeType": "agent-private"}),
            _table=lambda create=False: (None, None),
        )
        plugin = Plur1busControlsPlugin({"agentId": "main"})
        with patch.object(plugin, "_runtime", return_value=runtime), patch(
            "plur1bus_controls.plugin.current_identity", return_value=None,
        ):
            result = json.loads(plugin.handle_command(
                "reminders create 11111111-1111-4111-8111-111111111111 tomorrow"
            ))
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["errorType"], "ValueError")


if __name__ == "__main__":
    unittest.main()
