"""Canonical, non-authorizing identities for one admitted capture."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone


_TURN_RECORD_NAMESPACE = uuid.UUID("95fdc2b8-83fe-5f7a-a6a3-9cec994c7dea")
_EPISODE_RECORD_NAMESPACE = uuid.UUID("22877d9c-fb34-5d88-9e91-7b6fa8eb24c0")
_ROLES = frozenset({"user", "assistant"})


def canonical_capture_id(value: str) -> str:
    """Validate and normalize one opaque capture UUID; it grants no authority."""
    try:
        return str(uuid.UUID(str(value)))
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError("capture identity must be a UUID") from error


def canonical_captured_at(value: str) -> str:
    """Validate an absolute UTC timestamp and return its stable ISO spelling."""
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError("capturedAt must be an absolute UTC ISO timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ValueError("capturedAt must be an absolute UTC ISO timestamp")
    return parsed.astimezone(timezone.utc).isoformat()


def mint_capture_identity() -> tuple[str, str]:
    """Create the immutable identity and timestamp at capture admission."""
    return str(uuid.uuid4()), datetime.now(timezone.utc).isoformat()


def _identity_payload(capture_id: str, agent_id: str, scope_key: str,
                      session_id: str, role: str) -> str:
    if role not in _ROLES:
        raise ValueError("turn role must be user or assistant")
    return json.dumps({
        "agentId": str(agent_id),
        "captureId": canonical_capture_id(capture_id),
        "role": role,
        "scopeKey": str(scope_key),
        "sessionId": str(session_id),
    }, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def turn_record_id(capture_id: str, agent_id: str, scope_key: str,
                   session_id: str, role: str) -> str:
    """Return the deterministic journal row UUID for one capture role."""
    return str(uuid.uuid5(
        _TURN_RECORD_NAMESPACE,
        _identity_payload(capture_id, agent_id, scope_key, session_id, role),
    ))


def episode_record_id(capture_id: str, agent_id: str, scope_key: str,
                      session_id: str) -> str:
    """Return the deterministic per-capture episode UUID."""
    return str(uuid.uuid5(
        _EPISODE_RECORD_NAMESPACE,
        _identity_payload(capture_id, agent_id, scope_key, session_id, "user"),
    ))
