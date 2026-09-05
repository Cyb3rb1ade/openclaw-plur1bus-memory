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

    def test_skill_approve_requires_identity_bound_confirmation(self) -> None:
        runtime = SimpleNamespace(
            config={}, _domain=SimpleNamespace(),
            scope_binding=SimpleNamespace(as_dict=lambda: {"scopeType": "agent-private"}),
            _table=lambda create=False: (None, None),
        )
        identity = RequestIdentity("telegram", "user", "chat", "private", "main", True)
        plugin = Plur1busControlsPlugin({"agentId": "main"})
        proposal_id = "11111111-1111-4111-8111-111111111111"
        revision = "a" * 64
        with patch.object(plugin, "_runtime", return_value=runtime), patch(
            "plur1bus_controls.plugin.current_identity", return_value=identity,
        ), patch("plur1bus_controls.plugin.SkillWorkshop") as workshop_cls:
            workshop_cls.return_value.approve.return_value = {"approved": True}
            first = json.loads(plugin.handle_command(f"skills approve {proposal_id} {revision}"))
            self.assertEqual(first["status"], "confirmation_required")
            second = json.loads(plugin.handle_command(
                f"skills approve {proposal_id} {revision} --confirm {first['nonce']}"
            ))
        self.assertTrue(second["approved"])
        workshop_cls.return_value.approve.assert_called_once_with(proposal_id, revision)

    def test_merge_apply_requires_revision_bound_confirmation(self) -> None:
        runtime = SimpleNamespace(
            config={}, _domain=SimpleNamespace(),
            scope_binding=SimpleNamespace(as_dict=lambda: {"scopeType": "agent-private"}),
            _table=lambda create=False: (None, None),
            apply_merge_proposal=lambda proposal_id, *, approved_revision: (
                proposal_id == "11111111-1111-4111-8111-111111111111" and approved_revision == "b" * 64
            ),
        )
        identity = RequestIdentity("telegram", "user", "chat", "private", "main", True)
        plugin = Plur1busControlsPlugin({"agentId": "main"})
        with patch.object(plugin, "_runtime", return_value=runtime), patch(
            "plur1bus_controls.plugin.current_identity", return_value=identity,
        ):
            first = json.loads(plugin.handle_command(
                f"merge apply 11111111-1111-4111-8111-111111111111 {'b' * 64}"
            ))
            self.assertEqual(first["status"], "confirmation_required")
            second = json.loads(plugin.handle_command(
                f"merge apply 11111111-1111-4111-8111-111111111111 {'b' * 64} --confirm {first['nonce']}"
            ))
        self.assertTrue(second["applied"])

    def test_knowledge_confirmation_passes_only_runtime_scope(self) -> None:
        captured = []

        class Domain:
            def confirm_knowledge_promotion(self, proposal_id, *, acl_bindings):
                captured.append((proposal_id, acl_bindings))
                return {"confirmed": True}

        binding = {"scopeType": "agent-private", "scopeKey": "private"}
        runtime = SimpleNamespace(
            config={}, _domain=Domain(),
            scope_binding=SimpleNamespace(as_dict=lambda: dict(binding)),
            _table=lambda create=False: (None, None),
        )
        identity = RequestIdentity("telegram", "user", "chat", "private", "main", True)
        plugin = Plur1busControlsPlugin({"agentId": "main"})
        proposal_id = "11111111-1111-4111-8111-111111111111"
        with patch.object(plugin, "_runtime", return_value=runtime), patch(
            "plur1bus_controls.plugin.current_identity", return_value=identity,
        ):
            first = json.loads(plugin.handle_command(f"knowledge confirm {proposal_id}"))
            second = json.loads(plugin.handle_command(
                f"knowledge confirm {proposal_id} --confirm {first['nonce']}"
            ))
        self.assertTrue(second["confirmed"])
        self.assertEqual(captured, [(proposal_id, binding)])

    def test_bare_knowledge_is_read_only_for_unauthorized_identity(self) -> None:
        calls = []

        class Domain:
            def propose_knowledge_promotions(self, **_kwargs):
                calls.append("propose")
                return {"proposed": []}

        runtime = SimpleNamespace(
            config={"controls": {"allowedUserIds": ["other-user"]}},
            _domain=Domain(),
            scope_binding=SimpleNamespace(as_dict=lambda: {"scopeType": "agent-private"}),
            _table=lambda create=False: (None, None),
        )
        identity = RequestIdentity("telegram", "untrusted-user", "chat", "private", "main", True)
        plugin = Plur1busControlsPlugin({"agentId": "main"})
        with patch.object(plugin, "_runtime", return_value=runtime), patch(
            "plur1bus_controls.plugin.current_identity", return_value=identity,
        ):
            result = plugin.handle_command("knowledge")

        self.assertIn("Usage: /plur1bus knowledge", result)
        self.assertEqual(calls, [])


class BackgroundRegistrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_background_route_registers_only_after_authorized_opt_in(self) -> None:
        calls = []

        class Background:
            def register(self, key, tick):
                calls.append(("register", key, tick))
                return True

            def unregister(self, key):
                calls.append(("unregister", key))

        class Runtime:
            config = {"proactiveDelivery": {"background": {"enabled": True}}}

            def __init__(self):
                self.closed = False

            def shutdown(self):
                self.closed = True

        runtime = Runtime()
        identity = RequestIdentity("telegram", "user", "chat", "private", "main", True)
        plugin = Plur1busControlsPlugin({"agentId": "main"})
        plugin._background = Background()
        plugin._runtime = lambda *_args: runtime
        event = SimpleNamespace(text="/plur1bus status", source=SimpleNamespace(
            platform="telegram", chat_id="chat", thread_id=None, profile="main",
        ))

        class Gateway:
            pass

        plugin._on_gateway_dispatch(event, Gateway(), identity)

        self.assertEqual(calls[0][0], "register")
        self.assertTrue(runtime.closed)
        snapshot = calls[0][2].__closure__
        self.assertIsNotNone(snapshot)

    async def test_background_route_is_revoked_when_identity_is_not_authorized(self) -> None:
        calls = []

        class Background:
            def register(self, *_args, **_kwargs):
                self.fail("must not register")

            def unregister(self, key):
                calls.append(key)

        runtime = SimpleNamespace(
            config={"controls": {"allowedUserIds": ["other"]}, "proactiveDelivery": {"background": {"enabled": True}}},
            shutdown=lambda: None,
        )
        plugin = Plur1busControlsPlugin({"agentId": "main"})
        plugin._background = Background()
        plugin._runtime = lambda *_args: runtime
        identity = RequestIdentity("telegram", "user", "chat", "private", "main", True)
        event = SimpleNamespace(source=SimpleNamespace(platform="telegram", chat_id="chat"))

        plugin._on_gateway_dispatch(event, SimpleNamespace(), identity)

        self.assertEqual(calls, ["telegram:chat:main"])


if __name__ == "__main__":
    unittest.main()
