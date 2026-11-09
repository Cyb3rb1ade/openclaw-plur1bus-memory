"""Bi-temporal and expiry helpers for memory records.

Validity describes when a claim held in the real world.  It is deliberately
independent from ``createdAt`` (the time PLUR1BUS wrote the record).
"""

from __future__ import annotations

from datetime import datetime, timezone
import math
from typing import Any


# datetime's UTC renderer supports through 9999-12-31; keep every accepted
# timestamp renderable for the recall label.
_MAX_TIMESTAMP_MS = 253_402_300_799_999
_MIN_TIMESTAMP_MS = -62_135_596_800_000


def normalize_timestamp(value: Any) -> int:
    """Return an absolute epoch-ms timestamp, or 0 for unknown/unparseable.

    This is intentionally best-effort metadata from an LLM-facing tool.  It
    never interprets relative dates and never turns a bad value into ``now``.
    """
    if value is None or value == "" or value == "unknown" or isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return 0
        candidate = int(value)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return 0
        try:
            candidate = int(text)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return 0
            if parsed.tzinfo is None:
                # Match the upstream Date.parse contract for ISO date-only
                # inputs (midnight UTC), while refusing ambiguous local
                # date-times with no offset.
                if len(text) == 10 and text[4] == "-" and text[7] == "-":
                    parsed = parsed.replace(tzinfo=timezone.utc)
                else:
                    return 0
            candidate = int(parsed.astimezone(timezone.utc).timestamp() * 1000)
    else:
        return 0
    return candidate if candidate != 0 and _MIN_TIMESTAMP_MS <= candidate <= _MAX_TIMESTAMP_MS else 0


def normalize_validity_window(valid_from: Any = None, valid_until: Any = None) -> tuple[int, int]:
    """Normalize one atomic validity window; invalid intervals become unknown."""
    start = normalize_timestamp(valid_from)
    end = normalize_timestamp(valid_until)
    if start and end and start >= end:
        return 0, 0
    return start, end


def is_entry_valid_at(entry: dict[str, Any], valid_at: int | None) -> bool:
    """Apply the left-inclusive/right-exclusive validity predicate."""
    if valid_at is None:
        return True
    point = normalize_timestamp(valid_at)
    if not point:
        return False
    start = normalize_timestamp(entry.get("validFrom"))
    end = normalize_timestamp(entry.get("validUntil"))
    return (not start or start <= point) and (not end or point < end)


def is_entry_live(entry: dict[str, Any], now_ms: int) -> bool:
    """Return false only for a passed hard TTL; 0 means no expiry."""
    expiry = normalize_timestamp(entry.get("expiresAt"))
    return not expiry or now_ms < expiry


def has_disjoint_validity_windows(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Whether known bounds prove two windows do not overlap."""
    a_from, a_until = normalize_validity_window(a.get("validFrom"), a.get("validUntil"))
    b_from, b_until = normalize_validity_window(b.get("validFrom"), b.get("validUntil"))
    if not (a_from or a_until) or not (b_from or b_until):
        return False
    return bool((a_until and b_from and a_until <= b_from) or (b_until and a_from and b_until <= a_from))


def validity_where_clause(valid_at: int) -> str:
    """Lance predicate which preserves the zero/NULL unknown-bound sentinel."""
    return (
        f"(validFrom IS NULL OR validFrom = 0 OR validFrom <= {valid_at}) "
        f"AND (validUntil IS NULL OR validUntil = 0 OR validUntil > {valid_at})"
    )


def is_missing_validity_column_error(error: Exception) -> bool:
    """Recognise only legacy-schema failures eligible for the one retry."""
    text = str(error).lower()
    mentions_column = "validfrom" in text or "validuntil" in text
    return mentions_column and any(token in text for token in (
        "not found", "does not exist", "no such column", "unknown column", "missing column",
    ))


def validity_label(entry: dict[str, Any]) -> str:
    """Return a compact display label without exposing unknown bounds as epoch."""
    start = normalize_timestamp(entry.get("validFrom"))
    end = normalize_timestamp(entry.get("validUntil"))
    if not start and not end:
        return ""
    def render(value: int) -> str:
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc).date().isoformat()
    return f"[valid: {render(start) if start else '?'} – {render(end) if end else '?'}]"
