"""Strict storage namespace routing for one validated Hermes agent."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_NAMESPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SCOPE_TYPES = frozenset({"agent-private", "workspace", "user", "chat"})


def _required(value: Any, name: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{name} identity is required")
    return normalized


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _select_alias(values: Mapping[str, Any], *names: str) -> str:
    selected = ""
    for name in names:
        value = str(values.get(name) or "").strip()
        if not value:
            continue
        if selected and selected != value:
            raise ValueError(f"conflicting values for {names[0]}")
        selected = value
    return selected


def normalize_scope_context(context: Any = None) -> dict[str, str]:
    """Normalize a request context without inventing missing identities."""
    if context is None:
        values: Mapping[str, Any] = {}
    elif isinstance(context, Mapping):
        values = context
    else:
        as_scope = getattr(context, "as_scope", None)
        if callable(as_scope):
            scoped = as_scope()
            values = scoped if isinstance(scoped, Mapping) else {}
        else:
            values = {
                name: getattr(context, name, "")
                for name in (
                    "scopeType", "scope_type", "scope",
                    "workspaceIdentity", "workspace_identity", "workspaceId", "workspace_id", "workspace",
                    "platform",
                    "userId", "user_id", "user", "ownerUser", "owner_user",
                    "chatId", "chat_id", "chat",
                    "account", "accountId", "account_id",
                )
            }
    scope_type = _select_alias(values, "scopeType", "scope_type", "scope")
    return {
        "scopeType": scope_type or "agent-private",
        "workspace": _select_alias(
            values, "workspaceIdentity", "workspace_identity", "workspaceId", "workspace_id", "workspace"
        ),
        "platform": _select_alias(values, "platform"),
        "user": _select_alias(values, "userId", "user_id", "user", "ownerUser", "owner_user"),
        "chat": _select_alias(values, "chatId", "chat_id", "chat"),
        "account": _select_alias(values, "account", "accountId", "account_id"),
    }


@dataclass(frozen=True)
class ScopeBinding:
    """Validated ACL binding and opaque key for one Hermes request scope."""

    agent_id: str
    scope_type: str = "agent-private"
    workspace_identity: str = ""
    platform: str = ""
    user_id: str = ""
    chat_id: str = ""
    account: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "agent_id", _required(self.agent_id, "agent"))
        scope_type = str(self.scope_type or "agent-private").strip().lower()
        if scope_type not in _SCOPE_TYPES:
            raise ValueError(f"unsupported scope type: {scope_type}")
        object.__setattr__(self, "scope_type", scope_type)
        object.__setattr__(self, "workspace_identity", str(self.workspace_identity or "").strip())
        object.__setattr__(self, "platform", str(self.platform or "").strip())
        object.__setattr__(self, "user_id", str(self.user_id or "").strip())
        object.__setattr__(self, "chat_id", str(self.chat_id or "").strip())
        object.__setattr__(self, "account", str(self.account or "").strip())
        if scope_type == "workspace":
            object.__setattr__(self, "workspace_identity", _required(self.workspace_identity, "workspace"))
        elif scope_type == "user":
            object.__setattr__(self, "platform", _required(self.platform, "platform"))
            object.__setattr__(self, "user_id", _required(self.user_id, "user"))
        elif scope_type == "chat":
            object.__setattr__(self, "platform", _required(self.platform, "platform"))
            object.__setattr__(self, "chat_id", _required(self.chat_id, "chat"))

    @property
    def acl_binding(self) -> str:
        """Return the stable, type-separated ACL binding digest."""
        values = {
            "version": "hermes-acl-v1",
            "agentId": self.agent_id,
            "scopeType": self.scope_type,
            "workspaceIdentity": self.workspace_identity if self.scope_type == "workspace" else "",
            "platform": self.platform if self.scope_type in {"user", "chat"} else "",
            "userId": self.user_id if self.scope_type == "user" else "",
            "chatId": self.chat_id if self.scope_type == "chat" else "",
        }
        return _digest(json.dumps(values, ensure_ascii=True, sort_keys=True, separators=(",", ":")))

    @property
    def owner_key(self) -> str:
        """Return the canonical owner/ACL key used by Hermes scope checks."""
        return self.acl_binding

    @property
    def scope_key(self) -> str:
        """Return the stable opaque key persisted on memory rows."""
        values = {
            "version": "hermes-scope-v1",
            "agentId": self.agent_id,
            "scopeType": self.scope_type,
            "workspaceIdentity": self.workspace_identity if self.scope_type == "workspace" else "",
            "platform": self.platform if self.scope_type in {"user", "chat"} else "",
            "userId": self.user_id if self.scope_type == "user" else "",
            "chatId": self.chat_id if self.scope_type == "chat" else "",
        }
        return _digest(json.dumps(values, ensure_ascii=True, sort_keys=True, separators=(",", ":")))

    @property
    def key(self) -> str:
        """Compatibility alias for the canonical scope key."""
        return self.scope_key

    @property
    def workspace(self) -> str:
        """Compatibility alias for the workspace identity."""
        return self.workspace_identity

    @property
    def user(self) -> str:
        """Compatibility alias for the user identity."""
        return self.user_id

    @property
    def chat(self) -> str:
        """Compatibility alias for the chat identity."""
        return self.chat_id

    def as_dict(self) -> dict[str, str]:
        """Return transport fields plus the resolved ACL and scope keys."""
        return {
            "agentId": self.agent_id,
            "scopeType": self.scope_type,
            "workspace": self.workspace_identity,
            "workspaceIdentity": self.workspace_identity,
            "platform": self.platform,
            "user": self.user_id,
            "userId": self.user_id,
            "chat": self.chat_id,
            "chatId": self.chat_id,
            "account": self.account,
            "ownerKey": self.owner_key,
            "scopeKey": self.scope_key,
        }


def canonical_scope_binding(
    agent_id: str,
    *,
    scopeType: str | None = None,
    scope_type: str | None = None,
    workspaceIdentity: str | None = None,
    workspace: str | None = None,
    platform: str | None = None,
    userId: str | None = None,
    user: str | None = None,
    chatId: str | None = None,
    chat: str | None = None,
    account: str | None = None,
) -> ScopeBinding:
    """Build one validated canonical Hermes binding for exactly one scope type."""
    scope_values = {
        "scopeType": scopeType,
        "scope_type": scope_type,
        "workspaceIdentity": workspaceIdentity,
        "workspace": workspace,
        "platform": platform,
        "userId": userId,
        "user": user,
        "chatId": chatId,
        "chat": chat,
        "account": account,
    }
    normalized = normalize_scope_context(scope_values)
    return ScopeBinding(
        agent_id,
        normalized["scopeType"],
        normalized["workspace"],
        normalized["platform"],
        normalized["user"],
        normalized["chat"],
        normalized["account"],
    )


def binding_from_scope(agent_id: str, context: Any = None) -> ScopeBinding:
    """Build a canonical binding from a mapping or request-context object."""
    normalized = normalize_scope_context(context)
    return ScopeBinding(
        agent_id,
        normalized["scopeType"],
        normalized["workspace"],
        normalized["platform"],
        normalized["user"],
        normalized["chat"],
        normalized["account"],
    )


def canonical_scope_key(agent_id: str, **scope: Any) -> str:
    """Return the canonical opaque scope key for one request scope."""
    return canonical_scope_binding(agent_id, **scope).scope_key


def legacy_agent_private_scope_key() -> str:
    """Return the pre-Hermes agent-private key for compatible legacy reads."""
    return uuid.uuid5(
        uuid.NAMESPACE_URL,
        json.dumps({"workspace": "default", "user": "", "chat": ""}, sort_keys=True),
    ).hex


def _sql_literal(value: str) -> str:
    return value.replace("'", "''")


def scope_where_clause(binding: ScopeBinding, *, include_legacy_private: bool = True) -> str:
    """Build a pre-limit LanceDB predicate for one exact agent/scope binding."""
    scope_clause = f"scopeKey = '{_sql_literal(binding.scope_key)}'"
    if include_legacy_private and binding.scope_type == "agent-private":
        scope_clause = (
            f"({scope_clause} OR scopeKey = '{legacy_agent_private_scope_key()}')"
        )
    return f"agentId = '{_sql_literal(binding.agent_id)}' AND {scope_clause}"


@dataclass(frozen=True)
class NamespaceRoute:
    name: str
    path: Path
    writable: bool


def resolve_namespace_routes(
    data_dir: Path,
    agent_id: str,
    config: dict[str, Any],
) -> tuple[NamespaceRoute, list[NamespaceRoute]]:
    """Resolve one writer and bounded read routes without selecting another agent."""
    from .generation import resolve_generation_route
    raw = config.get("namespaces")
    if raw is None:
        route = NamespaceRoute(
            "default", Path(data_dir) / "lancedb" / agent_id, True
        )
        route = resolve_generation_route(data_dir, agent_id, route)
        return route, [route]
    if not isinstance(raw, dict):
        raise ValueError("namespaces must be an object")
    writer = str(raw.get("activeWriteNamespace") or "")
    active = [str(value) for value in raw.get("activeRecallNamespaces") or []]
    legacy = [
        str(value) for value in raw.get("legacyReadOnlyNamespaces") or []
    ]
    for name in [writer, *active, *legacy]:
        if not _NAMESPACE.fullmatch(name):
            raise ValueError(f"invalid namespace identifier: {name!r}")
    if writer not in active:
        raise ValueError("active writer must occur in active recall namespaces")
    if set(active) & set(legacy):
        raise ValueError("active and legacy namespaces must be disjoint")
    root = Path(data_dir) / "lancedb-namespaces"
    writer_route = NamespaceRoute(writer, root / writer / agent_id, True)
    recall_names = list(dict.fromkeys(active))
    if raw.get("crossNamespaceRecall") is True:
        recall_names.extend(
            name for name in legacy if name not in recall_names
        )
    routes = [
        NamespaceRoute(name, root / name / agent_id, name == writer)
        for name in recall_names[:16]
    ]
    active_writer = resolve_generation_route(data_dir, agent_id, writer_route)
    routes = [active_writer if route.writable else route for route in routes]
    return active_writer, routes
