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
import base64
import json
from typing import Any

SHORT_REF_MIN_LEN = 5
CRITICAL_CURSOR_VERSION = "critical-v1"

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


def _shortest_unique_suffix_among(hex_value: str, others: list[str], min_len: int) -> str:
    """Kürzestes Suffix von ``hex_value`` (min. ``min_len``), das von keinem
    Hex-String in ``others`` als Suffix geteilt wird. Damit ist die Referenz
    gegen den gesamten autorisierten Scope eindeutig."""
    for length in range(max(1, min_len), len(hex_value) + 1):
        suffix = hex_value[-length:]
        if not any(other.endswith(suffix) for other in others):
            return suffix
    return hex_value


def assign_short_refs(ids: list[str], min_len: int = SHORT_REF_MIN_LEN) -> dict[str, str]:
    """Weist jeder UUID eine eindeutige Kurzreferenz zu. Deterministisch und
    unabhängig von der Eingabereihenfolge: jede Referenz ist das kürzeste Suffix
    (min. ``min_len`` Hex-Zeichen), das exakt eine der UUIDs trifft."""
    result: dict[str, str] = {}
    entries = [(memory_id, _uuid_hex(memory_id)) for memory_id in ids]
    taken_fallback: set[str] = set()

    for index, (memory_id, hex_value) in enumerate(entries):
        if len(hex_value) == 32 and _HEX_SUFFIX_RE.fullmatch(hex_value):
            others = [
                other_hex
                for other_index, (_, other_hex) in enumerate(entries)
                if other_index != index
                and len(other_hex) == 32
                and _HEX_SUFFIX_RE.fullmatch(other_hex)
            ]
            result[memory_id] = _shortest_unique_suffix_among(hex_value, others, min_len)
        else:
            base = re.sub(r"[^0-9a-f]", "", hex_value)[-max(1, min_len):] or "mem"
            candidate = base
            n = 0
            while candidate in taken_fallback and n < 10000:
                n += 1
                candidate = f"{base}{n:x}"
            taken_fallback.add(candidate)
            result[memory_id] = candidate
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

    # Kollision: automatisch längere, im Scope eindeutige Referenzen vorschlagen.
    match_hexes = [_uuid_hex(m["id"]) for m in matches]
    suggestions = [
        _shortest_unique_suffix_among(
            _uuid_hex(m["id"]),
            [h for h in match_hexes if h != _uuid_hex(m["id"])],
            len(suffix) + 1,
        )
        for m in matches
    ]
    return {"ok": False, "error": "ambiguous", "suggestions": suggestions}


def encode_critical_cursor(owner: dict[str, Any], sort_key: tuple[int, str]) -> str:
    """Encode a deterministic, owner-bound critical-review cursor."""
    payload = {
        "version": CRITICAL_CURSOR_VERSION,
        "owner": owner,
        "createdAt": int(sort_key[0]),
        "id": str(sort_key[1]),
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    return f"{CRITICAL_CURSOR_VERSION}.{encoded}"


def decode_critical_cursor(cursor: str, owner: dict[str, Any]) -> tuple[int, str]:
    """Decode a cursor and fail closed when it belongs to another owner."""
    value = str(cursor or "")
    prefix = f"{CRITICAL_CURSOR_VERSION}."
    if not value.startswith(prefix):
        raise ValueError("invalid critical cursor")
    try:
        encoded = value[len(prefix):]
        encoded += "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(encoded.encode()).decode())
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid critical cursor") from error
    if payload.get("version") != CRITICAL_CURSOR_VERSION or payload.get("owner") != owner:
        raise ValueError("critical cursor owner mismatch")
    try:
        return int(payload["createdAt"]), str(payload["id"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("invalid critical cursor") from error
