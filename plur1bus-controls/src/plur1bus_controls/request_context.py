"""Gateway request identity propagated safely within one async dispatch context."""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RequestIdentity:
    platform: str
    user_id: str
    chat_id: str
    chat_type: str
    profile: str
    role_authorized: bool


_CURRENT_IDENTITY: ContextVar[RequestIdentity | None] = ContextVar(
    "plur1bus_request_identity",
    default=None,
)


def capture_gateway_identity(event: Any) -> RequestIdentity | None:
    """Capture normalized source identity from a Hermes MessageEvent."""
    source = getattr(event, "source", None)
    if source is None:
        _CURRENT_IDENTITY.set(None)
        return None
    platform = getattr(getattr(source, "platform", None), "value", None)
    identity = RequestIdentity(
        platform=str(platform or getattr(source, "platform", "") or ""),
        user_id=str(getattr(source, "user_id", None) or ""),
        chat_id=str(getattr(source, "chat_id", None) or ""),
        chat_type=str(getattr(source, "chat_type", None) or ""),
        profile=str(getattr(source, "profile", None) or ""),
        role_authorized=bool(getattr(source, "role_authorized", False)),
    )
    _CURRENT_IDENTITY.set(identity)
    return identity


def current_identity() -> RequestIdentity | None:
    """Return the identity captured for the current gateway dispatch context."""
    return _CURRENT_IDENTITY.get()


def is_mutation_authorized(
    config: dict[str, Any],
    identity: RequestIdentity | None,
) -> bool:
    """Apply OpenClaw-compatible fail-safe mutation authorization."""
    controls = dict(config.get("controls") or {})
    if identity is None:
        return bool(controls.get("allowMutatingCommands", False))
    allowed_users = {
        str(value)
        for value in (
            controls.get("allowedUserIds")
            or config.get("allowedUserIds")
            or []
        )
    }
    allowed_chats = {
        str(value)
        for value in (
            controls.get("allowedChatIds")
            or config.get("allowedChatIds")
            or []
        )
    }
    if allowed_users or allowed_chats:
        return bool(identity.user_id and identity.user_id in allowed_users)
    return bool(
        identity.user_id
        and identity.chat_id
        and identity.chat_type.lower() in {"dm", "private", "direct"}
    )
