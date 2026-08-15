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
    workspace_id: str = ""
    scope_type: str = ""
    account: str = ""
    thread_id: str = ""

    def as_scope(self, scope_type: str | None = None) -> dict[str, str]:
        """Return the normalized fields consumed by the Hermes scope binder."""
        return {
            "scopeType": scope_type or self.scope_type or "agent-private",
            "workspace": self.workspace_id,
            "platform": self.platform,
            "user": self.user_id,
            "chat": self.chat_id,
            "account": self.account,
        }


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
    def source_value(*names: str) -> str:
        for name in names:
            value = getattr(source, name, None)
            if value not in (None, ""):
                return str(value)
        return ""

    identity = RequestIdentity(
        platform=str(platform or source_value("platform")),
        user_id=source_value("user_id", "userId"),
        chat_id=source_value("chat_id", "chatId"),
        chat_type=source_value("chat_type", "chatType"),
        profile=source_value("profile", "agent_id", "agentId"),
        role_authorized=bool(getattr(source, "role_authorized", False)),
        workspace_id=source_value(
            "workspace_id", "workspaceId", "workspaceIdentity", "workspace", "workspace_identity"
        ),
        scope_type=source_value("scope_type", "scopeType", "scope"),
        account=source_value("account", "account_id", "accountId"),
        thread_id=source_value("thread_id", "threadId"),
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
