"""Validation helpers for Hermes-compatible PLUR1BUS runtime."""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path


AGENT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"

KNOWN_STATUS = {"active", "superseded", "archived", "deleted"}
KNOWN_TYPES = {
    "fact",
    "observation",
    "decision",
    "preference",
    "knowledge",
    "dream",
}


class ValidationError(ValueError):
    """Raised when incoming user input or persisted fields are invalid."""


def safe_agent_id(agent_id: str) -> str:
    """Validate and normalize an agent id."""
    if not isinstance(agent_id, str):
        raise ValidationError("agentId must be a string")
    candidate = agent_id.strip()
    if not candidate:
        raise ValidationError("agentId must not be empty")
    if not candidate[0].isalnum() or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for c in candidate):
        raise ValidationError("agentId violates allowed character set")
    if len(candidate) > 64:
        raise ValidationError("agentId exceeds length limit")
    if len(candidate) < 1:
        raise ValidationError("agentId is too short")
    if not candidate[0].isalnum():
        raise ValidationError("agentId must start with alpha numeric")
    return candidate


def safe_status(status: str) -> str:
    """Validate status enum values used by memory records."""
    if status not in KNOWN_STATUS:
        raise ValidationError(f"invalid status: {status}")
    return status


def safe_type(category: str) -> str:
    """Validate memory category/type enum values."""
    if category not in KNOWN_TYPES:
        raise ValidationError(f"invalid memory type: {category}")
    return category


def safe_memory_id(memory_id: str) -> str:
    """Validate a canonical UUID memory-card identifier."""
    if not isinstance(memory_id, str):
        raise ValidationError("memoryId must be a string")
    try:
        return str(uuid.UUID(memory_id))
    except (ValueError, AttributeError) as error:
        raise ValidationError("memoryId must be a UUID") from error


def resolve_inside(base_dir: str, target: str, *parts: str) -> Path:
    """Resolve and normalize a path under base_dir using the realpath check.

    Raises `ValidationError` when the resulting path escapes base_dir.
    """
    root = Path(base_dir).expanduser().resolve()
    candidate = root.joinpath(target, *parts).resolve()
    if root != candidate and str(candidate).startswith(f"{root}{os.sep}"):
        return candidate
    if candidate == root:
        return candidate
    raise ValidationError("path traversal detected in resolve_inside")


def fingerprint_text(text: str) -> str:
    """Create a stable fingerprint for deterministic caching keys."""
    normalized = (text or "").strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def normalize_text_payload(payload: object) -> dict:
    """Convert mixed snake/camel payloads to normalized in-memory shapes."""
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        raise ValidationError("payload must be a mapping")
    raw = dict(payload)
    alias_map = {
        "created_at": "createdAt",
        "updated_at": "updatedAt",
        "stored_by": "storedBy",
        "source_turn_id": "sourceTurnId",
        "source_message_role": "sourceMessageRole",
        "source_timestamp": "sourceTimestamp",
        "source_url": "sourceUrl",
        "evidence_quote": "evidenceQuote",
        "memory_class": "memoryClass",
    }
    for source_key, target_key in alias_map.items():
        if source_key in raw and target_key not in raw:
            raw[target_key] = raw[source_key]
    return raw


def as_json_lines(records: list[dict]) -> str:
    """Render records as newline-separated JSON for logs and manifests."""
    return "\n".join(json.dumps(r, sort_keys=True, ensure_ascii=False) for r in records)
