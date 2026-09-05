"""Injection-marker detection for capture-side trust decisions.

Port of the upstream 7.4.0 ``lib/neo-arch.js`` detection surface
(``isInjectedContextText`` / ``looksLikePromptInjection``, commit 72bbe5e):
runtime inject headers are recognized only as line headers, never as
arbitrary substrings inside a line. Quick markers stay plain substring
checks; the JSON rest markers are evaluated only when a structural hint
substring is present, so detection stays O(n) in the text length.
"""

from __future__ import annotations

import re

# Upstream PROMPT_INJECTION_RE (case-insensitive).
PROMPT_INJECTION_RE = re.compile(
    r"\b(ignore (all )?(previous|prior|above|instructions?)"
    r"|disregard (all )?(prior|previous|instructions?)"
    r"|system prompt|developer message|tool_call|act as"
    r"|pretend (to be|you are)|you are now|new (role|persona|instruction)"
    r"|forget (?:\w+\s+){0,3}(previous|prior|above|instructions?)"
    r"|jailbreak|prompt injection)\b"
    r"|<\/?(?:tool|system|s|assistant|human|prompt)[^>]{0,30}>"
    r"|<\|im_start\||<\|im_end\||#{3,}\s*(system|assistant|user)\b",
    re.IGNORECASE,
)

# Upstream INJECTED_QUICK_MARKERS (matched case-insensitively).
INJECTED_QUICK_MARKERS = (
    "<plur1bus-recall",
    "</plur1bus-recall",
    "<plur1bus-start-notice",
    "</plur1bus-start-notice",
    "plur1bus — make your agent yours",
    "<temporal-context>",
    "</temporal-context>",
    "<relevant-memories",
    "</relevant-memories",
    "<knowledge-update-reminder",
    "</knowledge-update-reminder",
    "<adaptive-learning",
    "</adaptive-learning",
    "recall safety rules",
    "plur1bus internal classify-recent",
    "critical-memory-classifier",
    "tts-status",
    "[cron:",
    "heartbeat_ok",
    "reference utc:",
    "current time:",
    "you are a memory search agent",
    "memory search agent. another model",
    "bounded search query",
    "use only the available memory tools",
    "conversation info (untrusted metadata)",
    "[openclaw heartbeat",
    "write a dream diary entry from these memory fragments",
)

# Upstream INJECTED_JSON_REGEXES (case-insensitive, evaluated only after a hint).
INJECTED_JSON_REGEXES = (
    re.compile(r'capturedBy"\s*:\s*"agent_end_capture', re.IGNORECASE),
    re.compile(r'embeddingStatus"\s*:\s*"pending', re.IGNORECASE),
    re.compile(r'"chat_id"\s*:\s*"telegram:', re.IGNORECASE),
    re.compile(r'"message_id"\s*:\s*"', re.IGNORECASE),
    re.compile(r'"sender_id"\s*:\s*"', re.IGNORECASE),
)

# Upstream JSON_MARKER_HINTS (lowercase substrings).
JSON_MARKER_HINTS = ('capturedby', 'embeddingstatus', '"chat_id"', '"message_id"', '"sender_id"')

# Upstream INJECTED_HEADER_RE: line-header anchors only.
_INJECTED_HEADER_RE = re.compile(
    r"^(?:<<<)?begin_openclaw_internal_context\b"
    r"|^\[subagent context\]"
    r"|^\[inter-session message\]",
    re.IGNORECASE,
)

_TIMESTAMP_PREFIX_RE = re.compile(r"^\[[^\]]{0,80}\]\s+")


def _line_has_injected_header(line: str) -> bool:
    trimmed = line.strip()
    if not trimmed:
        return False
    if _INJECTED_HEADER_RE.search(trimmed):
        return True
    without_timestamp = _TIMESTAMP_PREFIX_RE.sub("", trimmed, count=1)
    return without_timestamp != trimmed and bool(_INJECTED_HEADER_RE.search(without_timestamp))


def is_injected_context_text(text: object) -> bool:
    """Return True for systemically injected context (recall blocks, status
    reminders, cron/heartbeat context) that must never be re-captured.

    Line-header markers match only at a line start (after an optional
    ``[timestamp]`` prefix), not as arbitrary substrings inside a line.
    """
    s = str(text or "")
    if not s:
        return False
    if any(_line_has_injected_header(line) for line in s.split("\n")):
        return True
    lower = s.lower()
    if any(marker in lower for marker in INJECTED_QUICK_MARKERS):
        return True
    if not any(hint in lower for hint in JSON_MARKER_HINTS):
        return False
    return any(regex.search(s) for regex in INJECTED_JSON_REGEXES)


def looks_like_prompt_injection(text: object) -> bool:
    """Return True when the text matches the upstream prompt-injection regex."""
    return bool(PROMPT_INJECTION_RE.search(str(text or "")))
