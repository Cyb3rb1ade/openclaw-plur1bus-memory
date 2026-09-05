"""Parse only unambiguous replies to a PLUR1BUS Critical Push.

This module deliberately has no Hermes hook integration.  A caller must supply
trusted quoted-message text from a registered host API; untrusted text that
merely contains a reference line must never become a review action.
"""

from __future__ import annotations

import re
from typing import Any

MAX_REPLY_LENGTH = 200
_REF_LINE_RE = re.compile(r"^\s*(?:Referenz|Reference)\s*:\s*([0-9a-f]{5,32})\s*$", re.I | re.M)
_HEADLINES = (
    "plur1bus hat eine erinnerung als möglicherweise besonders wichtig erkannt.",
    "plur1bus recognized a memory as possibly especially important.",
)
_REJECT_RE = re.compile(r"\b(ablehn\w*|abgelehnt|verwerf\w*|verworfen|reject\w*|dismiss\w*|declin\w*)\b|\bnicht\s+hervorheb\w*|\bdon'?t\s+highlight\b", re.I)
_ACCEPT_RE = re.compile(r"\b(akzeptier\w*|annehm\w*|angenommen|bestätig\w*|übernehm\w*|übernommen|hervorheb\w*|accept\w*|approv\w*|confirm\w*|highlight\w*)\b", re.I)
_NEGATED_ACCEPT_RE = re.compile(r"\b(nicht|kein\w*|not|don'?t|no)\b[^.!?\n]{0,24}\b(akzeptier|annehm|bestätig|übernehm|accept|approv|confirm)", re.I)
_ALL_RE = re.compile(r"\b(alle|alles|allesamt|sämtliche|beide|all|both|everything)\b", re.I)
_GERMAN_RE = re.compile(r"\b(akzeptier\w*|annehm\w*|angenommen|bestätig\w*|übernehm\w*|übernommen|hervorheb\w*|ablehn\w*|abgelehnt|verwerf\w*|verworfen|alle|alles|sämtliche|beide|bitte|nicht)\b", re.I)


def _squash(value: Any) -> str:
    return " ".join(str(value or "").split()).casefold()


def looks_like_critical_push(text: Any) -> bool:
    """Return whether text carries the fixed PLUR1BUS Critical-Push headline."""
    haystack = _squash(text)
    return bool(haystack and any(headline in haystack for headline in _HEADLINES))


def extract_critical_refs(text: Any) -> list[str]:
    """Extract unique short references from a rendered Critical Push."""
    seen: set[str] = set()
    refs: list[str] = []
    for match in _REF_LINE_RE.finditer(text if isinstance(text, str) else ""):
        ref = match.group(1).lower()
        if ref not in seen:
            seen.add(ref)
            refs.append(ref)
    return refs


def detect_reply_language(body: Any) -> str:
    """Return German when the reply uses German decision language, else English."""
    return "de" if _GERMAN_RE.search(body if isinstance(body, str) else "") else "en"


def parse_critical_reply_intent(body: Any) -> dict[str, Any] | None:
    """Parse an explicit accept/reject decision, returning ``None`` when unsure."""
    text = body.strip() if isinstance(body, str) else ""
    if not text or len(text) > MAX_REPLY_LENGTH:
        return None
    if _REJECT_RE.search(text):
        return {"action": "reject", "all": bool(_ALL_RE.search(text))}
    if _NEGATED_ACCEPT_RE.search(text):
        return None
    if _ACCEPT_RE.search(text):
        return {"action": "accept", "all": bool(_ALL_RE.search(text))}
    return None


def build_critical_reply_command(*, body: Any = None, reply_to_body: Any = None) -> dict[str, Any] | None:
    """Build a review command only for an unambiguous reply to a real push."""
    if not looks_like_critical_push(reply_to_body):
        return None
    refs = extract_critical_refs(reply_to_body)
    intent = parse_critical_reply_intent(body)
    if not refs or intent is None or (len(refs) > 1 and not intent["all"]):
        return None
    return {
        "action": intent["action"],
        "refs": refs,
        "args": f"critical {intent['action']} {' '.join(refs)}",
        "lang": detect_reply_language(body),
    }
