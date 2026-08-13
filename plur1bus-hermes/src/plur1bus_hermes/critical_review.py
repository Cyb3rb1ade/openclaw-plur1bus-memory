"""Gemeinsamer Critical-Review-Vertrag (OpenClaw-Parität).

Pure, DB-freie Helfer, die den OpenClaw-UX-Vertrag plattformgerecht für die
Hermes-Runtime umsetzen:

  - verständliche Grund-/Typ-/Quellbezeichnungen (keine internen Rohwerte),
  - sichere, begrenzte Vorschauen mit vollständiger Secret-Unterdrückung,
  - Source-Role-/Provenienz-Behandlung (keine Assistant-False-Positives),
  - Kurzreferenzen (kürzestes eindeutiges UUID-Suffix, min. 5 Hex-Zeichen),
  - die Aktionssemantik Accept / Reject (nicht-destruktiv) / Edit.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

SHORT_REF_MIN_LEN = 5

# ─── Verständliche Bezeichnungen ────────────────────────────────────────────

REASON_TEXTS: dict[str, dict[str, str]] = {
    "never_forget": {
        "de": "Diese Information wurde ausdrücklich als dauerhaft wichtig markiert.",
        "en": "This information was explicitly marked as permanently important.",
    },
    "high_importance": {
        "de": "PLUR1BUS hat diese Erinnerung als möglicherweise besonders wichtig eingestuft.",
        "en": "PLUR1BUS rated this memory as possibly especially important.",
    },
    "explicit_critical_language": {
        "de": "Die Formulierung wurde als ausdrücklicher Merkwunsch erkannt.",
        "en": "The wording was recognized as an explicit request to remember.",
    },
}

TYPE_LABELS: dict[str, dict[str, str]] = {
    "person": {"de": "Information über eine Person", "en": "Information about a person"},
    "beziehung": {"de": "Persönliche Beziehung", "en": "Personal relationship"},
    "geburtstag": {"de": "Geburtstag oder Jahrestag", "en": "Birthday or anniversary"},
    "geld_konto": {"de": "Finanz- oder Kontoinformation", "en": "Financial or account information"},
    "gesundheit": {"de": "Gesundheitsinformation", "en": "Health information"},
    "zugang_passwort": {"de": "Möglicherweise sensible Zugangsinformation", "en": "Possibly sensitive access information"},
}

SOURCE_ROLE_LABELS: dict[str, dict[str, str]] = {
    "user": {"de": "Benutzer", "en": "User"},
    "assistant": {"de": "Assistent", "en": "Assistant"},
    "agent": {"de": "Assistent", "en": "Assistant"},
    "correction": {"de": "Korrektur", "en": "Correction"},
}

GENERIC_IMPORTANT = {
    "de": "Möglicherweise besonders wichtige Erinnerung",
    "en": "Possibly important memory",
}


def translate_reason(reason: str | None, type_fallback: str = "", lang: str = "de") -> str:
    """Übersetzt einen internen Grund verständlich; nie den Rohwert anzeigen."""
    entry = REASON_TEXTS.get(str(reason or ""))
    if entry:
        return entry.get(lang, entry["de"])
    if type_fallback:
        return translate_type(type_fallback, lang)
    return GENERIC_IMPORTANT.get(lang, GENERIC_IMPORTANT["de"])


def translate_type(type_: str | None, lang: str = "de") -> str:
    entry = TYPE_LABELS.get(str(type_ or ""))
    if entry:
        return entry.get(lang, entry["de"])
    return GENERIC_IMPORTANT.get(lang, GENERIC_IMPORTANT["de"])


def translate_source_role(role: str | None, lang: str = "de") -> str:
    entry = SOURCE_ROLE_LABELS.get(str(role or "").lower())
    if entry:
        return entry.get(lang, entry["de"])
    return "Unbekannt" if lang == "de" else "Unknown"


# ─── Source-Role / Provenienz ───────────────────────────────────────────────

_ASSISTANT_SOURCES = {"assistant", "agent"}


def is_assistant_source(source_role: str | None) -> bool:
    return str(source_role or "").lower() in _ASSISTANT_SOURCES


def has_explicit_importance_signal(metadata: dict[str, Any] | None) -> bool:
    metadata = metadata or {}
    if bool(metadata.get("neverForget")):
        return True
    importance = _as_float(metadata.get("importance"))
    if importance is not None and importance >= 0.9:
        return True
    core_score = _as_float(metadata.get("coreMemoryScore"))
    return core_score is not None and core_score >= 0.9


def keyword_eligible(source_role: str | None) -> bool:
    """Ein bloßer Schlüsselwort-Treffer zählt nur für geeignete Quellen."""
    return not is_assistant_source(source_role)


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ─── Vorschau- und Datenschutzpolitik ───────────────────────────────────────

_SUPPRESSED_TYPES = {"zugang_passwort", "gesundheit", "geld_konto"}


def is_suppressed_type(type_: str | None) -> bool:
    return str(type_ or "") in _SUPPRESSED_TYPES


_PREVIEW_MAX_LEN = 160


def sanitize_preview(text: str | None, max_len: int = _PREVIEW_MAX_LEN) -> str:
    if not text:
        return ""
    text = str(text)
    text = re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"[`*_\[\]<>#&|]", "", text)
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return text


def build_preview(card: dict[str, Any], lang: str = "de") -> dict[str, Any]:
    type_ = str(card.get("type") or "")
    secret_suppressed = bool(card.get("contentSuppressed"))
    if type_ == "zugang_passwort" or secret_suppressed:
        reason = (
            "Der Inhalt wird ausgeblendet, weil er möglicherweise Zugangsdaten "
            "oder andere sensible Angaben enthält."
        )
        if lang != "de":
            reason = (
                "The content is hidden because it may contain credentials or "
                "other sensitive information."
            )
        return {"suppressed": True, "text": "", "reason": reason}
    if is_suppressed_type(type_):
        reason = (
            "Der Inhalt wird aus Datenschutzgründen ausgeblendet."
            if lang == "de"
            else "The content is hidden for privacy reasons."
        )
        return {"suppressed": True, "text": "", "reason": reason}
    preview = sanitize_preview(
        card.get("text") or card.get("summary") or card.get("content") or card.get("title") or ""
    )
    return {"suppressed": False, "text": preview, "reason": ""}


# ─── Kurzreferenzen ─────────────────────────────────────────────────────────

_HEX_SUFFIX_RE = re.compile(r"^[0-9a-f]+$")
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def _uuid_hex(memory_id: str) -> str:
    return str(memory_id).replace("-", "").lower()


def shortest_unique_suffix(
    memory_id: str, taken: set[str], min_len: int = SHORT_REF_MIN_LEN
) -> str:
    hex_value = _uuid_hex(memory_id)
    if len(hex_value) != 32 or not _HEX_SUFFIX_RE.fullmatch(hex_value):
        base = re.sub(r"[^0-9a-f]", "", hex_value)[-max(1, min_len):] or "mem"
        candidate = base
        n = 0
        while candidate in taken and n < 10000:
            n += 1
            candidate = f"{base}{n:x}"
        return candidate
    for length in range(max(1, min_len), len(hex_value) + 1):
        suffix = hex_value[-length:]
        if suffix not in taken:
            return suffix
    return hex_value


def assign_short_refs(ids: list[str], min_len: int = SHORT_REF_MIN_LEN) -> dict[str, str]:
    result: dict[str, str] = {}
    taken: set[str] = set()
    for memory_id in ids:
        ref = shortest_unique_suffix(memory_id, taken, min_len)
        taken.add(ref)
        result[memory_id] = ref
    return result


def normalize_short_ref(input_: str, min_len: int = SHORT_REF_MIN_LEN) -> dict[str, Any]:
    raw = str(input_ or "").strip().lower()
    if len(raw) == 36 and _UUID_RE.fullmatch(raw):
        return {"ok": True, "value": raw, "kind": "uuid"}
    if len(raw) < min_len or len(raw) > 32:
        return {"ok": False, "error": "invalid_format"}
    if not _HEX_SUFFIX_RE.fullmatch(raw):
        return {"ok": False, "error": "invalid_format"}
    return {"ok": True, "value": raw, "kind": "suffix"}


def _validate_uuid(value: str) -> str | None:
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return None


def resolve_short_ref(
    input_: str,
    pending_reviews: list[dict[str, Any]],
    min_len: int = SHORT_REF_MIN_LEN,
) -> dict[str, Any]:
    normalized = normalize_short_ref(input_, min_len)
    if not normalized["ok"]:
        return {"ok": False, "error": normalized["error"]}

    if normalized["kind"] == "uuid":
        match = any(str(item.get("id") or "").lower() == normalized["value"] for item in pending_reviews)
        if not match:
            return {"ok": False, "error": "not_found"}
        validated = _validate_uuid(normalized["value"])
        if validated is None:
            return {"ok": False, "error": "not_found"}
        return {"ok": True, "id": validated}

    suffix = normalized["value"]
    matches = [
        item
        for item in pending_reviews
        if isinstance(item.get("id"), str) and _uuid_hex(item["id"]).endswith(suffix)
    ]
    if not matches:
        return {"ok": False, "error": "not_found"}
    if len(matches) == 1:
        validated = _validate_uuid(matches[0]["id"])
        if validated is None:
            return {"ok": False, "error": "not_found"}
        return {"ok": True, "id": validated}

    suggestions = []
    for match in matches:
        others = {_uuid_hex(m["id"])[-32:] for m in matches if m["id"] != match["id"]}
        suggestions.append(shortest_unique_suffix(match["id"], others, len(suffix) + 1))
    return {"ok": False, "error": "ambiguous", "suggestions": suggestions}
