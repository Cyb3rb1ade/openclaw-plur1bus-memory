import asyncio
import unittest
from enum import Enum
from types import SimpleNamespace

try:
    from gateway.platforms.base import SendResult
except ModuleNotFoundError as error:
    if error.name not in {"gateway", "gateway.platforms", "gateway.platforms.base"}:
        raise
    # These are host-neutral delivery-result contract tests. Use the real host
    # type when present; an isolated wheel QA environment has no Hermes gateway.
    from dataclasses import dataclass

    @dataclass
    class SendResult:
        success: bool
        error: str | None = None
from plur1bus_controls.plugin import Plur1busControlsPlugin
from plur1bus_controls.request_context import RequestIdentity
from plur1bus_hermes.namespaces import ScopeBinding


class _Platform(Enum):
    TELEGRAM = "telegram"


class _Adapter:
    def __init__(self, result=None):
        self.sent = []
        self.result = result or SendResult(success=True)

    async def send(self, chat_id, text, metadata=None):
        self.sent.append((chat_id, text, metadata))
        return self.result


class _Domain:
    def __init__(self, critical_item=None):
        self.presented = []
        self.notified = []
        self.critical_item = critical_item or {
            "id": "a4563cc9-7611-4528-992a-075f8889a018",
            "type": "person",
            "text": "Bernds bevorzugte Sprache ist Deutsch.",
            "createdAt": "2026-08-15T10:20:00+00:00",
            "reason": "high_importance",
            "sourceRole": "user",
            "contentSuppressed": False,
        }

    def due_reminders(self, **_kwargs):
        return [{"id": "reminder", "text": "Call Bernd"}]

    def critical_items(self, _status, **_kwargs):
        return [dict(self.critical_item)]

    def critical_reference_map(self, **_kwargs):
        return {"a4563cc9-7611-4528-992a-075f8889a018": "9a018"}

    def proactive_messages(self):
        return []

    def update_reminder(self, memory_id, action, **_kwargs):
        self.presented.append((memory_id, action))

    def mark_criticals_notified(self, memory_ids, **_kwargs):
        self.notified.extend(memory_ids)

    def mark_proactive_sent(self, _message_ids):
        pass


class ProactiveDeliveryTests(unittest.TestCase):
    @staticmethod
    def _identity(thread_id: str = "") -> RequestIdentity:
        return RequestIdentity("telegram", "owner", "chat", "private", "default", True, thread_id=thread_id)

    @staticmethod
    def _runtime(domain):
        return SimpleNamespace(
            _domain=domain, config={}, agent_id="default", scope_binding=ScopeBinding("default")
        )

    def test_successful_send_marks_reminders_and_criticals_delivered(self):
        async def scenario():
            plugin = Plur1busControlsPlugin()
            domain = _Domain()
            runtime = self._runtime(domain)
            adapter = _Adapter()
            gateway = SimpleNamespace(_adapter_for_source=lambda _source: adapter)
            source = SimpleNamespace(platform=_Platform.TELEGRAM, chat_id="chat", thread_id="thread")
            event = SimpleNamespace(source=source)

            await plugin._deliver_proactive(event, gateway, runtime, self._identity("thread"))

            self.assertEqual(adapter.sent[0][0], "chat")
            self.assertIn("Call Bernd", adapter.sent[0][1])
            self.assertEqual(domain.presented, [("reminder", "present")])
            self.assertEqual(domain.notified, ["a4563cc9-7611-4528-992a-075f8889a018"])

        asyncio.run(scenario())

    def test_critical_message_uses_understandable_reason_and_short_reference(self):
        async def scenario():
            plugin = Plur1busControlsPlugin()
            domain = _Domain()
            runtime = self._runtime(domain)
            adapter = _Adapter()
            gateway = SimpleNamespace(_adapter_for_source=lambda _source: adapter)
            source = SimpleNamespace(platform="telegram", chat_id="chat")
            event = SimpleNamespace(source=source)

            await plugin._deliver_proactive(event, gateway, runtime, self._identity())

            text = adapter.sent[0][1]
            self.assertNotIn("reason=", text)
            self.assertIn("möglicherweise besonders wichtig eingestuft", text)
            self.assertIn("Quelle: Benutzer", text)
            self.assertIn("Zeitpunkt: 2026-08-15T10:20:00+00:00", text)
            self.assertIn("Bernds bevorzugte Sprache", text)
            self.assertIn("9a018", text)
            self.assertIn("/plur1bus critical accept 9a018", text)
            self.assertIn("/plur1bus critical reject 9a018", text)
            self.assertIn("/plur1bus critical edit 9a018", text)
            self.assertNotIn("a4563cc9-7611-4528-992a-075f8889a018", text)

        asyncio.run(scenario())

    def test_failed_send_does_not_mark_any_delivery_state(self):
        async def scenario():
            plugin = Plur1busControlsPlugin()
            domain = _Domain()
            runtime = self._runtime(domain)
            adapter = _Adapter(SendResult(success=False, error="forbidden"))
            gateway = SimpleNamespace(_adapter_for_source=lambda _source: adapter)
            event = SimpleNamespace(source=SimpleNamespace(platform="telegram", chat_id="chat", thread_id=None))

            await plugin._deliver_proactive(event, gateway, runtime, self._identity())

            self.assertEqual(len(adapter.sent), 1)
            self.assertEqual(domain.presented, [])
            self.assertEqual(domain.notified, [])

        asyncio.run(scenario())

    def test_sensitive_critical_preview_is_suppressed(self):
        async def scenario():
            plugin = Plur1busControlsPlugin()
            item = {
                "id": "a4563cc9-7611-4528-992a-075f8889a018",
                "type": "gesundheit",
                "text": "Diagnose: streng vertrauliches-geheimnis",
                "createdAt": "2026-08-15T10:20:00+00:00",
                "reason": "high_importance",
                "sourceRole": "user",
            }
            text = plugin._render_critical_message(item, "9a018", hide_types=["gesundheit"])
            self.assertNotIn("streng vertrauliches-geheimnis", text)
            self.assertNotIn("high_importance", text)
            self.assertIn("Datenschutz", text)

        asyncio.run(scenario())

    def test_list_projection_is_content_free_and_contains_provenance(self):
        plugin = Plur1busControlsPlugin()
        item = {
            "id": "a4563cc9-7611-4528-992a-075f8889a018",
            "type": "gesundheit",
            "text": "Diagnose: geheim",
            "createdAt": "2026-08-15T10:20:00+00:00",
            "reason": "high_importance",
            "sourceRole": "user",
        }
        result = plugin._public_critical_item(item, "9a018")
        self.assertEqual(result["ref"], "9a018")
        self.assertEqual(result["source"], "Benutzer")
        self.assertEqual(result["time"], "2026-08-15T10:20:00+00:00")
        self.assertNotIn("preview", result)
        self.assertNotIn("geheim", str(result))
        self.assertNotIn("high_importance", str(result))
        self.assertNotIn(item["id"], str(result))
        self.assertEqual(result["actions"]["edit"], "/plur1bus critical edit 9a018")

    def test_proactive_preview_requires_private_identity_bound_to_route(self):
        async def scenario():
            plugin = Plur1busControlsPlugin()
            domain = _Domain()
            adapter = _Adapter()
            gateway = SimpleNamespace(_adapter_for_source=lambda _source: adapter)
            runtime = self._runtime(domain)
            event = SimpleNamespace(source=SimpleNamespace(platform="telegram", chat_id="wrong"))

            await plugin._deliver_proactive(event, gateway, runtime, self._identity())

            self.assertEqual(len(adapter.sent), 1)
            self.assertIn("Call Bernd", adapter.sent[0][1])
            self.assertNotIn("Bernds bevorzugte Sprache", adapter.sent[0][1])
            self.assertEqual(domain.notified, [])

        asyncio.run(scenario())

    def test_runtime_hide_types_are_used_for_critical_preview(self):
        plugin = Plur1busControlsPlugin()
        runtime = self._runtime(_Domain())
        runtime.config = {"criticalPush": {"hideTypes": ["gesundheit"]}}
        text = plugin._render_critical_message(
            {"type": "gesundheit", "text": "nicht zeigen", "reason": "high_importance"},
            "9a018",
            hide_types=plugin._critical_hide_types(runtime),
        )
        self.assertNotIn("nicht zeigen", text)
        self.assertIn("Datenschutz", text)

    def test_deliver_proactive_health_and_finance_default_visible_but_hide_types_suppresses(self):
        async def scenario():
            item = {
                "id": "a4563cc9-7611-4528-992a-075f8889a018",
                "type": "gesundheit",
                "text": "Eigene Gesundheitsaussage",
                "createdAt": "2026-08-15T10:20:00+00:00",
                "reason": "high_importance",
                "sourceRole": "user",
                "contentSuppressed": False,
            }
            gateway = SimpleNamespace(_adapter_for_source=lambda _source: adapter)
            event = SimpleNamespace(source=SimpleNamespace(platform="telegram", chat_id="chat", thread_id=None))

            for type_ in ("gesundheit", "geld_konto"):
                item["type"] = type_
                domain = _Domain(item)
                runtime = self._runtime(domain)
                adapter = _Adapter()
                await Plur1busControlsPlugin()._deliver_proactive(
                    event, gateway, runtime, self._identity()
                )
                self.assertIn("Eigene Gesundheitsaussage", adapter.sent[0][1])
                self.assertEqual(domain.notified, [item["id"]])

                domain = _Domain(item)
                runtime = self._runtime(domain)
                runtime.config = {"criticalPush": {"hideTypes": [type_]}}
                adapter = _Adapter()
                await Plur1busControlsPlugin()._deliver_proactive(
                    event, gateway, runtime, self._identity()
                )
                self.assertNotIn("Eigene Gesundheitsaussage", adapter.sent[0][1])
                self.assertIn("Datenschutz", adapter.sent[0][1])
                self.assertEqual(domain.notified, [item["id"]])

        asyncio.run(scenario())

    def test_deliver_proactive_content_suppressed_health_never_leaks(self):
        async def scenario():
            secret = "konkreter-geheimer-Gesundheitswert"
            domain = _Domain({
                "id": "a4563cc9-7611-4528-992a-075f8889a018",
                "type": "gesundheit",
                "text": secret,
                "reason": "high_importance",
                "sourceRole": "user",
                "contentSuppressed": True,
            })
            runtime = self._runtime(domain)
            runtime.config = {"criticalPush": {"hideTypes": []}}
            adapter = _Adapter()
            event = SimpleNamespace(source=SimpleNamespace(platform="telegram", chat_id="chat", thread_id=None))
            await Plur1busControlsPlugin()._deliver_proactive(
                event, SimpleNamespace(_adapter_for_source=lambda _source: adapter), runtime, self._identity()
            )
            self.assertNotIn(secret, adapter.sent[0][1])
            self.assertIn("möglicherweise Zugangsdaten", adapter.sent[0][1])
            self.assertEqual(domain.notified, ["a4563cc9-7611-4528-992a-075f8889a018"])

        asyncio.run(scenario())

    def test_deliver_proactive_rejects_all_non_owner_critical_routes_but_keeps_reminders(self):
        async def scenario():
            event = SimpleNamespace(source=SimpleNamespace(platform="telegram", chat_id="chat", thread_id=None))
            cases = (
                ("group", RequestIdentity("telegram", "owner", "chat", "group", "default", True), None),
                ("missing identity", None, None),
                ("wrong thread", self._identity("other-thread"), None),
                ("wrong profile", RequestIdentity("telegram", "owner", "chat", "private", "other", True), None),
                ("denied allowed user", self._identity(), {"controls": {"allowedUserIds": ["other"]}}),
                ("foreign scope", self._identity(), "foreign-scope"),
                ("foreign agent binding", self._identity(), "foreign-agent-binding"),
                ("missing scope type", self._identity(), "missing-scope-type"),
            )
            for name, identity, override in cases:
                with self.subTest(name=name):
                    domain = _Domain()
                    runtime = self._runtime(domain)
                    if isinstance(override, dict):
                        runtime.config = override
                    elif override == "foreign-scope":
                        runtime.scope_binding = ScopeBinding(
                            "default", "user", platform="telegram", user_id="owner"
                        )
                    elif override == "foreign-agent-binding":
                        runtime.scope_binding = ScopeBinding("other")
                    elif override == "missing-scope-type":
                        runtime.scope_binding = SimpleNamespace(agent_id="default")
                    adapter = _Adapter()
                    await Plur1busControlsPlugin()._deliver_proactive(
                        event, SimpleNamespace(_adapter_for_source=lambda _source: adapter), runtime, identity
                    )
                    self.assertEqual(len(adapter.sent), 1)
                    self.assertIn("Call Bernd", adapter.sent[0][1])
                    self.assertNotIn("Bernds bevorzugte Sprache", adapter.sent[0][1])
                    self.assertEqual(domain.notified, [])

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
