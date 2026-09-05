"""Trusted host message-ID binding for automatic critical-review outcomes."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from plur1bus_controls.plugin import Plur1busControlsPlugin
from plur1bus_controls.request_context import RequestIdentity
from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.namespaces import ScopeBinding


class _Domain:
    def __init__(self, root: Path, binding: ScopeBinding) -> None:
        self.root, self.binding = root, binding
        self.reviewed, self.feedback = [], []

    def _scope_selector(self, **_kwargs):
        return object()

    def _scope_state_dir(self, _selector):
        return self.root

    def _read_jsonl(self, path):
        try:
            return [json.loads(line) for line in Path(path).read_text().splitlines() if line]
        except FileNotFoundError:
            return []

    def _append_jsonl(self, path, item):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with Path(path).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(item) + "\n")

    def review_critical(self, memory_id, action, **_kwargs):
        self.reviewed.append((memory_id, action))
        self._append_jsonl(self.root / "critical-push.jsonl", {
            "id": memory_id, "agentId": self.binding.agent_id,
            "scopeKey": self.binding.scope_key,
            "status": "accepted" if action == "accept" else "rejected",
        })
        return {"updated": True, "id": memory_id}

    def record_feedback(self, memory_id, feedback, **kwargs):
        self.feedback.append((memory_id, feedback, kwargs))
        return {"ok": True}


def _runtime(root: Path, binding: ScopeBinding, domain: _Domain):
    return SimpleNamespace(
        agent_id=binding.agent_id, scope_key=binding.scope_key, scope_binding=binding,
        _domain=domain, config={}, shutdown=lambda: None,
    )


class CriticalHostWiringTests(unittest.TestCase):
    def test_real_domain_notification_transition_survives_host_binding(self) -> None:
        """The host route is appended after—not instead of—the domain notification."""
        with tempfile.TemporaryDirectory() as directory:
            binding = ScopeBinding("main")
            domain = Plur1busDomain(Path(directory), "main")
            memory_id = "11111111-1111-4111-8111-111111111111"
            pending = {
                "id": memory_id, "status": "pending_review", "reason": "test",
                "agentId": "main", "scopeKey": binding.scope_key,
                "aclBindings": binding.as_dict(),
            }
            # The notification state transition itself is the real domain method;
            # only the card query is isolated from LanceDB for this unit test.
            domain.critical_items = lambda *_args, **_kwargs: [pending]
            runtime = SimpleNamespace(
                agent_id="main", scope_key=binding.scope_key, scope_binding=binding,
            )
            scope_kwargs = {"acl_bindings": binding.as_dict()}
            domain.mark_criticals_notified([memory_id], **scope_kwargs)
            Plur1busControlsPlugin()._record_critical_delivery(
                domain, runtime, [pending],
                SimpleNamespace(platform="telegram", chat_id="chat", thread_id=None),
                "host-outbound-1",
            )
            selector = domain._scope_selector(**scope_kwargs)
            entries = domain._read_jsonl(domain._scope_state_dir(selector) / "critical-push.jsonl")
            self.assertEqual(len(entries), 2)
            self.assertTrue(entries[-1].get("notifiedAt"))
            self.assertEqual(entries[-1]["deliveryMessageId"], "host-outbound-1")

    def test_delivery_records_actual_host_message_id_in_scoped_critical_ledger(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binding = ScopeBinding("main")
            root = Path(directory)
            domain = _Domain(root, binding)
            runtime = _runtime(root, binding, domain)
            Plur1busControlsPlugin()._record_critical_delivery(
                domain, runtime,
                [{"id": "11111111-1111-4111-8111-111111111111", "status": "pending_review"}],
                SimpleNamespace(platform="telegram", chat_id="chat", thread_id=None), "host-outbound-1",
            )
            entry = domain._read_jsonl(root / "critical-push.jsonl")[0]
            self.assertEqual(entry["deliveryMessageId"], "host-outbound-1")
            self.assertEqual(entry["scopeKey"], binding.scope_key)

    def test_only_verified_reply_message_id_and_route_can_apply_outcome(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binding = ScopeBinding("main")
            root = Path(directory)
            domain = _Domain(root, binding)
            memory_id = "11111111-1111-4111-8111-111111111111"
            (root / "critical-push.jsonl").write_text(json.dumps({
                "id": memory_id, "agentId": "main", "scopeKey": binding.scope_key,
                "status": "pending_review", "deliveryMessageId": "host-outbound-1",
                "deliveryPlatform": "telegram", "deliveryChatId": "chat", "deliveryThreadId": "",
            }) + "\n", encoding="utf-8")
            runtime = _runtime(root, binding, domain)
            plugin = Plur1busControlsPlugin()
            event = SimpleNamespace(
                text="accept", reply_to_message_id="host-outbound-1", reply_to_is_own_message=True,
                source=SimpleNamespace(platform="telegram", chat_id="chat", thread_id=None),
            )

            plugin._apply_trusted_critical_reply(
                event, runtime, RequestIdentity("telegram", "user", "chat", "private", "main", True)
            )
            # The accepted transition is now the latest state for this ID, so an
            # identical host replay cannot create another review or feedback row.
            plugin._apply_trusted_critical_reply(
                event, runtime, RequestIdentity("telegram", "user", "chat", "private", "main", True)
            )

            self.assertEqual(domain.reviewed, [(memory_id, "accept")])
            self.assertEqual(len(domain.feedback), 1)
            self.assertEqual(domain.feedback[0][0:2], (memory_id, "useful"))
            self.assertEqual(domain.feedback[0][2]["query"], "trusted-critical-reply:host-outbound-1")

    def test_missing_own_reply_proof_or_route_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binding = ScopeBinding("main")
            root = Path(directory)
            domain = _Domain(root, binding)
            (root / "critical-push.jsonl").write_text(json.dumps({
                "id": "11111111-1111-4111-8111-111111111111", "agentId": "main",
                "scopeKey": binding.scope_key, "status": "pending_review",
                "deliveryMessageId": "host-outbound-1", "deliveryPlatform": "telegram",
                "deliveryChatId": "chat", "deliveryThreadId": "",
            }) + "\n", encoding="utf-8")
            runtime = _runtime(root, binding, domain)
            plugin = Plur1busControlsPlugin()
            for own, chat in ((False, "chat"), (True, "other")):
                plugin._apply_trusted_critical_reply(
                    SimpleNamespace(
                        text="accept", reply_to_message_id="host-outbound-1", reply_to_is_own_message=own,
                        source=SimpleNamespace(platform="telegram", chat_id=chat, thread_id=None),
                    ), runtime, RequestIdentity("telegram", "user", chat, "private", "main", True),
                )
            self.assertEqual(domain.reviewed, [])
            self.assertEqual(domain.feedback, [])

    def test_unauthorized_gateway_reply_never_reaches_host_action(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binding = ScopeBinding("main")
            domain = _Domain(Path(directory), binding)
            runtime = _runtime(Path(directory), binding, domain)
            runtime.config = {"controls": {"allowedUserIds": ["other"]}}
            plugin = Plur1busControlsPlugin({"agentId": "main"})
            event = SimpleNamespace(
                text="accept", reply_to_message_id="host-outbound-1", reply_to_is_own_message=True,
                source=SimpleNamespace(platform="telegram", chat_id="chat", thread_id=None),
            )
            identity = RequestIdentity("telegram", "user", "chat", "private", "main", True)
            with patch.object(plugin, "_runtime", return_value=runtime):
                plugin._on_gateway_dispatch(event, SimpleNamespace(), identity)
            self.assertEqual(domain.reviewed, [])


if __name__ == "__main__":
    unittest.main()
