"""Fail-safe deterministic critical-memory classification."""

from __future__ import annotations

import re
from typing import Any

from .critical_review import keyword_eligible


CRITICAL_TYPES = frozenset({
    "person",
    "beziehung",
    "geburtstag",
    "geld_konto",
    "gesundheit",
    "zugang_passwort",
})
NON_CRITICAL_TYPE = "note"


def is_confirmed(value: Any) -> bool:
    """Return whether a card uses one of the supported confirmed values."""
    if value is True or value == 1:
        return True
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1"}
    return False


_CRITICAL_PATTERNS = (
    r"\b(never forget|nie vergessen|unbedingt merken)\b",
    r"\b(emergency|notfall|lebenswichtig|critical|kritisch)\b",
    r"\b(password|passwort|api[- ]?key|token|secret)\b",
)


def classify_critical(
    text: str,
    metadata: dict[str, Any],
    source_role: str = "user",
) -> dict[str, Any]:
    """Classify critical-push eligibility without exposing secret-like content.

    Ein bloßer Schlüsselwort-Treffer zählt nur für geeignete Quellen (``user``,
    ``correction``, ``obsidian``, ``note`` …). Assistentenantworten wie
    „Dein API-Key ist nicht konfiguriert." werden weiterhin gespeichert, lösen
    aber keinen Critical-Push aus — ``neverForget`` und echte Importance-Signale
    bleiben unabhängig von der Quelle wirksam.
    """
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
    keyword_signal = bool(matched) and keyword_eligible(source_role)
    eligible = never_forget or importance >= 0.9 or keyword_signal
    reason = (
        "never_forget"
        if never_forget
        else "high_importance"
        if importance >= 0.9
        else "explicit_critical_language"
        if keyword_signal
        else "not_critical"
    )
    return {
        "eligible": eligible,
        "reason": reason,
        "importance": importance,
        "requiresReview": eligible,
        "suppressContent": secret_like,
        "sourceRole": str(source_role or ""),
    }
