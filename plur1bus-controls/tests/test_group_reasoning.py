from types import SimpleNamespace
from plur1bus_controls.hooks import HookCollector


def event(text, kind="group"):
    return SimpleNamespace(text=text, source=SimpleNamespace(chat_type=kind))


def test_reasoning_skips_before_callback():
    seen = []
    collector = HookCollector(lambda *args: seen.append(args))
    for text in ("🧠 Thinking", "[Other]: <think>reason", "Other: reasoning: draft"):
        assert collector._capture_gateway(event=event(text))["action"] == "skip"
    assert not seen


def test_private_ordinary_and_disabled_messages_are_allowed():
    collector = HookCollector()
    assert collector._capture_gateway(event=event("🧠 idea", "private"))["action"] == "allow"
    assert collector._capture_gateway(event=event("hello"))["action"] == "allow"
    disabled = HookCollector(config={"groupReasoningFilter": {"enabled": False}})
    assert disabled._capture_gateway(event=event("🧠 Thinking"))["action"] == "allow"
