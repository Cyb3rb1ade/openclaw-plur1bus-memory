"""Suppress visible foreign reasoning before Hermes starts a group turn."""
import re

PREFIXES = ("🧠", "💭", "<think>", "<thinking>", "reasoning:", "thinking:")
LABEL = re.compile(r"^\s*(?:\[[^\]\n]{1,80}\]|[^\s:\n][^:\n]{0,60}):\s+")


def foreign_reasoning(event, identity, config=None):
    """Match only known group contexts, with the upstream configurable prefixes."""
    settings = (config or {}).get("groupReasoningFilter") or {}
    if settings.get("enabled") is False:
        return False
    if not (getattr(event, "isGroup", False) is True or
            (identity and identity.chat_type.lower() in {"group", "supergroup", "channel"})):
        return False
    prefixes = settings.get("prefixes")
    prefixes = tuple(str(value or "").strip().lower() for value in prefixes) if isinstance(prefixes, list) and prefixes else PREFIXES
    prefixes = tuple(value for value in prefixes if value)
    for field in ("body", "cleanedBody", "content", "text"):
        text = getattr(event, field, None)
        if isinstance(text, str):
            raw = text.lstrip()
            if any(candidate.lower().startswith(prefixes) for candidate in (raw, LABEL.sub("", raw, count=1))):
                return True
    return False
