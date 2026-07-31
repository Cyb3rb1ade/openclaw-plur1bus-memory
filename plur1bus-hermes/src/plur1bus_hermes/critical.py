"""Fail-safe deterministic critical-memory classification."""

from __future__ import annotations

import re
from typing import Any


_CRITICAL_PATTERNS = (
    r"\b(never forget|nie vergessen|unbedingt merken)\b",
    r"\b(emergency|notfall|lebenswichtig|critical|kritisch)\b",
    r"\b(password|passwort|api[- ]?key|token|secret)\b",
)


def classify_critical(
    text: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    """Classify critical-push eligibility without exposing secret-like content."""
    value = str(text or "")
    importance = float(metadata.get("importance") or 0)
    never_forget = bool(metadata.get("neverForget"))
    matched = [
        pattern
        for pattern in _CRITICAL_PATTERNS
        if re.search(pattern, value, re.IGNORECASE)
    ]
    secret_like = any(
        re.search(pattern, value, re.IGNORECASE)
        for pattern in _CRITICAL_PATTERNS[-1:]
    )
    eligible = never_forget or importance >= 0.9 or bool(matched)
    reason = (
        "never_forget"
        if never_forget
        else "high_importance"
        if importance >= 0.9
        else "explicit_critical_language"
        if matched
        else "not_critical"
    )
    return {
        "eligible": eligible,
        "reason": reason,
        "importance": importance,
        "requiresReview": eligible,
        "suppressContent": secret_like,
    }
