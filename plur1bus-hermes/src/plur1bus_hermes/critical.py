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
)

_SECRET_LABEL = (
    r"(?:password|passwort|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|"
    r"token|secret|zugangs?code|wiederherstellungsschl(?:ü|ue)ssel)"
)
_SECRET_ASSIGNMENT_RE = re.compile(
    rf"(?<![\w]){_SECRET_LABEL}(?![\w])\s*"
    rf"(?:(?P<assignment>[:=])\s*|"
    rf"(?P<strong_copula>lautet|equals)\b\s*:?\s*|"
    rf"(?P<weak_copula>ist|is)\b\s*:?\s*)"
    rf"(?P<value>\"[^\"\r\n]{{1,512}}\"|'[^'\r\n]{{1,512}}'|[^\s,;]{{1,512}})",
    re.IGNORECASE,
)
_DIRECT_SECRET_VALUE_RES = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{12,}\b", re.IGNORECASE),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
)
_BEARER_SECRET_RE = re.compile(
    r"\bBearer\s+(?P<value>[A-Za-z0-9_+=./-]{8,})(?=$|[\s,;])",
    re.IGNORECASE,
)
_CONNECTION_SECRET_RE = re.compile(
    r"\b[a-z][a-z0-9+.-]*://[^/\s:@]+:(?P<value>[^@\s/]+)@[^/\s]+",
    re.IGNORECASE,
)
_NON_SECRET_VALUES = frozenset({
    "absent",
    "configured",
    "empty",
    "fehlt",
    "gesetzt",
    "leer",
    "missing",
    "nicht",
    "noch",
    "none",
    "null",
    "optional",
    "required",
    "redacted",
    "masked",
    "hidden",
    "placeholder",
    "provided",
    "set",
    "unset",
    "unavailable",
    "unknown",
    "unbekannt",
})
_SECRET_PLACEHOLDER_RE = re.compile(
    r"^(?:"
    r"<[^>]*>|\[[^\]]*\]|\$\{[^}]+\}|\{\{?[^}]+\}\}?|"
    r"[*xX•._-]{4,}|(?:redacted|masked|hidden|placeholder|tbd|todo)|"
    r"(?:your|my|the)[-_ ]?(?:password|token|secret|api[-_ ]?key)(?:[-_ ]?here)?|"
    r"(?:enter|insert|replace)[-_ ]+(?:password|token|secret|api[-_ ]?key)(?:[-_ ]+here)?"
    r")$",
    re.IGNORECASE,
)


def _has_credible_weak_secret_syntax(value: str) -> bool:
    """Require syntax unlikely to be a free-form copular state description."""
    has_lower = any(char.islower() for char in value)
    has_upper = any(char.isupper() for char in value)
    has_digit = any(char.isdigit() for char in value)
    if value.isdigit():
        return len(value) >= 4
    if has_digit and (has_lower or has_upper):
        return len(value) >= 6
    return has_lower and has_upper and len(value) >= 8


def _is_concrete_secret_value(raw_value: str, *, weak_copula: bool = False) -> bool:
    """Reject state words, masks, and configuration placeholders."""
    raw = raw_value.strip()
    quoted = len(raw) >= 2 and raw[0] in "\"'" and raw[-1] == raw[0]
    value = (raw[1:-1] if quoted else raw).rstrip(".!?")
    if len(value) < 4 or value.casefold() in _NON_SECRET_VALUES:
        return False
    if _SECRET_PLACEHOLDER_RE.fullmatch(value) is not None:
        return False
    return not weak_copula or quoted or _has_credible_weak_secret_syntax(value)


def _contains_concrete_secret(text: str) -> bool:
    """Require a concrete credential value, not a credential-related word."""
    if any(pattern.search(text) for pattern in _DIRECT_SECRET_VALUE_RES):
        return True
    bearer = _BEARER_SECRET_RE.search(text)
    if bearer is not None and _is_concrete_secret_value(bearer.group("value")):
        return True
    connection = _CONNECTION_SECRET_RE.search(text)
    if connection is not None and _is_concrete_secret_value(connection.group("value")):
        return True
    return any(
        _is_concrete_secret_value(
            match.group("value"),
            weak_copula=match.group("weak_copula") is not None,
        )
        for match in _SECRET_ASSIGNMENT_RE.finditer(text)
    )


def classify_critical(
    text: str,
    metadata: dict[str, Any],
    source_role: str = "user",
    *,
    status: str = "active",
) -> dict[str, Any]:
    """Classify critical-push eligibility without exposing secret-like content.

    Ein bloßer Schlüsselwort-Treffer zählt nur für geeignete Quellen (``user``,
    ``correction``, ``obsidian``, ``note`` …). Assistentenantworten wie
    „Dein API-Key ist nicht konfiguriert." werden weiterhin gespeichert, lösen
    aber keinen Critical-Push aus — ``neverForget`` und echte Importance-Signale
    bleiben unabhängig von der Quelle wirksam.
    """
    # Classification may be invoked from an asynchronous capture path.  A
    # non-active record is never eligible for a new critical-review proposal.
    if str(status or "active") != "active":
        return {
            "eligible": False,
            "reason": "not_critical",
            "importance": float(metadata.get("importance") or 0),
            "requiresReview": False,
            "suppressContent": False,
            "sourceRole": str(source_role or ""),
        }
    value = str(text or "")
    importance = float(metadata.get("importance") or 0)
    never_forget = bool(metadata.get("neverForget"))
    matched = [
        pattern
        for pattern in _CRITICAL_PATTERNS
        if re.search(pattern, value, re.IGNORECASE)
    ]
    secret_like = _contains_concrete_secret(value)
    keyword_signal = (bool(matched) or secret_like) and keyword_eligible(source_role)
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
