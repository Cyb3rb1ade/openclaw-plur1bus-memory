"""Versioned, opt-in embedding preprocessing. Stored text is independent."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from .validation import ValidationError


RAW = "raw"
ENVELOPE = "hermes-envelope-v1"
ENVELOPE_NO_SPEAKER = "hermes-envelope-v1-nospeaker"

_TIMESTAMP = re.compile(
    r"^\s*\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?"
    r"(?:Z|[+-]\d{2}:?\d{2}|\s+[A-Z]{2,5})?\]\s*"
)
_TRANSCRIPT = re.compile(
    r"^\s*\[(?:audio transcript|voice transcript|transkript)[^\]\n]{0,160}\]:?\s*", re.I
)
_TRANSPORT_METADATA = re.compile(
    r"^(?:Conversation info|Sender) \(untrusted metadata\):[ \t]*\n"
    r"```(?:json)?[^\n]*\n[\s\S]*?\n```[ \t]*(?:\n|$)", re.I | re.M
)
_SPEAKER = re.compile(r"^[A-ZÄÖÜ][\w. -]{0,30}:[ \t]+")


def configured_text_mode(config: Mapping[str, Any]) -> str:
    """Leave all old profiles raw until explicitly opted in."""
    embedding = config.get("embedding")
    options = embedding.get("cleanText") if isinstance(embedding, Mapping) else None
    if options is True:
        return ENVELOPE
    if isinstance(options, Mapping) and options.get("enabled") is True:
        return ENVELOPE_NO_SPEAKER if options.get("stripSpeaker") is True else ENVELOPE
    return RAW


def prepare_embedding_text(text: str, mode: object) -> tuple[str, str]:
    """Return the versioned model input and fall back to raw if cleanup is empty.

    Absent modes predate this feature. An explicit mode from a different
    implementation must not silently produce different vectors.
    """
    if mode in (None, "", RAW):
        return text, RAW
    if mode not in (ENVELOPE, ENVELOPE_NO_SPEAKER):
        raise ValidationError("unsupported stored embedding text mode")
    cleaned = _TRANSPORT_METADATA.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))
    cleaned = _TRANSCRIPT.sub("", _TIMESTAMP.sub("", cleaned)).strip()
    if mode == ENVELOPE_NO_SPEAKER:
        cleaned = _SPEAKER.sub("", cleaned).strip()
    return (cleaned, str(mode)) if cleaned else (text, RAW)
