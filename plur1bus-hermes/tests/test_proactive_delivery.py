import asyncio
import unittest
from types import SimpleNamespace

from plur1bus_controls.plugin import Plur1busControlsPlugin


class _Adapter:
    def __init__(self):
        self.sent = []

    async def send(self, chat_id, text, metadata=None):
        self.sent.append((chat_id, text, metadata))


class _Domain:
    def __init__(self):
        self.presented = []
        self.notified = []

    def due_reminders(self):
        return [{"id": "reminder", "text": "Call Bernd"}]

    def critical_items(self, _status):
        return [{
            "id": "a4563cc9-7611-4528-992a-075f8889a018",
            "reason": "high_importance",
            "sourceRole": "user",
            "contentSuppressed": False,
        }]

    def critical_reference_map(self):
        return {"a4563cc9-7611-4528-992a-075f8889a018": "9a018"}

    def proactive_messages(self):
        return []

    def update_reminder(self, memory_id, action):
        self.presented.append((memory_id, action))

    def mark_criticals_notified(self, memory_ids):
        self.notified.extend(memory_ids)

    def mark_proactive_sent(self, _message_ids):
        pass


class ProactiveDeliveryTests(unittest.TestCase):
    def test_successful_send_marks_reminders_and_criticals_delivered(self):
        async def scenario():
            plugin = Plur1busControlsPlugin()
            domain = _Domain()
            runtime = SimpleNamespace(_domain=domain)
            adapter = _Adapter()
            gateway = SimpleNamespace(_adapter_for_source=lambda _source: adapter)
            source = SimpleNamespace(chat_id="chat", thread_id="thread")
            event = SimpleNamespace(source=source)

            await plugin._deliver_proactive(event, gateway, runtime)

            self.assertEqual(adapter.sent[0][0], "chat")
            self.assertIn("Call Bernd", adapter.sent[0][1])
            self.assertEqual(domain.presented, [("reminder", "present")])
            self.assertEqual(domain.notified, ["a4563cc9-7611-4528-992a-075f8889a018"])

        asyncio.run(scenario())

    def test_critical_message_uses_understandable_reason_and_short_reference(self):
        async def scenario():
            plugin = Plur1busControlsPlugin()
            domain = _Domain()
            runtime = SimpleNamespace(_domain=domain)
            adapter = _Adapter()
            gateway = SimpleNamespace(_adapter_for_source=lambda _source: adapter)
            source = SimpleNamespace(chat_id="chat")
            event = SimpleNamespace(source=source)

            await plugin._deliver_proactive(event, gateway, runtime)

            text = adapter.sent[0][1]
            self.assertNotIn("reason=", text)
            self.assertIn("möglicherweise besonders wichtig eingestuft", text)
            self.assertIn("9a018", text)
            self.assertIn("/plur1bus critical accept 9a018", text)
            self.assertIn("/plur1bus critical reject 9a018", text)
            self.assertIn("/plur1bus critical edit 9a018", text)
            self.assertNotIn("a4563cc9-7611-4528-992a-075f8889a018", text)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
