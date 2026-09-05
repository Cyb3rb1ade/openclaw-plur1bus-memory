"""Bounded REM-dream synthesis with a deterministic local fallback."""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from .cognition import contradiction_score
from .namespaces import (
    ScopeBinding,
    binding_from_scope,
    canonical_scope_binding,
    legacy_agent_private_scope_key,
)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tokens(text: str) -> set[str]:
    return {
        word
        for word in re.findall(r"[\wäöüß-]+", text.lower())
        if len(word) >= 4
    }


def _selector(
    agent_id: str,
    *,
    acl_bindings: Any = None,
    scope_key: str | None = None,
) -> tuple[str, str, dict[str, str]]:
    """Resolve the exact REM input binding, retaining the private legacy path."""
    binding: ScopeBinding | None = None
    if acl_bindings is not None:
        if isinstance(acl_bindings, ScopeBinding):
            binding = acl_bindings
        elif isinstance(acl_bindings, Mapping):
            provided_agent = str(acl_bindings.get("agentId") or agent_id).strip()
            if provided_agent != agent_id:
                raise ValueError("ACL binding agent does not match dream agent")
            direct_key = str(acl_bindings.get("scopeKey") or "").strip()
            scope_type = str(
                acl_bindings.get("scopeType")
                or acl_bindings.get("scope_type")
                or acl_bindings.get("scope")
                or ""
            ).strip()
            if direct_key and scope_type not in {"agent-private", "workspace", "user", "chat"}:
                binding = None
                resolved_key = direct_key
                resolved_type = "opaque"
            else:
                binding = canonical_scope_binding(
                    agent_id,
                    scopeType=scope_type or None,
                    workspaceIdentity=acl_bindings.get("workspaceIdentity")
                    or acl_bindings.get("workspace"),
                    platform=acl_bindings.get("platform"),
                    userId=acl_bindings.get("userId")
                    or acl_bindings.get("user")
                    or acl_bindings.get("ownerUserId"),
                    chatId=acl_bindings.get("chatId")
                    or acl_bindings.get("chat")
                    or acl_bindings.get("chatScope"),
                    account=acl_bindings.get("account")
                    or acl_bindings.get("accountId"),
                )
                resolved_key = binding.scope_key
                resolved_type = binding.scope_type
        else:
            binding = binding_from_scope(agent_id, acl_bindings)
            resolved_key = binding.scope_key
            resolved_type = binding.scope_type
        if binding is not None:
            resolved_key = binding.scope_key
            resolved_type = binding.scope_type
            normalized = binding.as_dict()
        else:
            normalized = {
                "agentId": agent_id,
                "scopeKey": resolved_key,
                "scopeType": resolved_type,
            }
        if scope_key is not None and str(scope_key).strip() != resolved_key:
            raise ValueError("scopeKey does not match ACL binding")
        return resolved_key, resolved_type, normalized
    if scope_key is not None:
        resolved_key = str(scope_key).strip()
        if not resolved_key:
            raise ValueError("scopeKey is required")
        return resolved_key, "opaque", {"agentId": agent_id, "scopeKey": resolved_key, "scopeType": "opaque"}
    binding = binding_from_scope(agent_id)
    return binding.scope_key, binding.scope_type, binding.as_dict()


def _row_matches(row: Mapping[str, Any], agent_id: str, scope_key: str, scope_type: str) -> bool:
    row_agent = str(row.get("agentId") or "").strip()
    if row_agent and row_agent != agent_id:
        return False
    row_key = str(row.get("scopeKey") or "").strip()
    if not row_key and isinstance(row.get("aclBindings"), Mapping):
        row_key = str(row["aclBindings"].get("scopeKey") or "").strip()
    if not row_key:
        return scope_type == "agent-private"
    return row_key == scope_key or (
        scope_type == "agent-private" and row_key == legacy_agent_private_scope_key()
    )


def build_rem_dream(
    rows: list[dict[str, Any]],
    agent_id: str,
    *,
    max_associations: int = 8,
    acl_bindings: Any = None,
    scope_key: str | None = None,
    aclBindings: Any = None,
    scopeKey: str | None = None,
) -> dict[str, Any]:
    """Build a transparent REM dream from bounded active-memory associations."""
    acl_bindings = aclBindings if aclBindings is not None else acl_bindings
    scope_key = scopeKey if scopeKey is not None else scope_key
    resolved_key, scope_type, normalized_acl = _selector(
        agent_id, acl_bindings=acl_bindings, scope_key=scope_key
    )
    memories = [
        {
            "id": str(row.get("id") or ""),
            "text": str(row.get("content") or "").strip(),
        }
        for row in rows
        if _row_matches(row, agent_id, resolved_key, scope_type)
        if str(row.get("content") or "").strip()
    ]
    associations = []
    for index, first in enumerate(memories):
        first_tokens = _tokens(first["text"])
        for second in memories[index + 1:]:
            second_tokens = _tokens(second["text"])
            union = first_tokens | second_tokens
            similarity = len(first_tokens & second_tokens) / max(1, len(union))
            contradiction = contradiction_score(first["text"], second["text"])
            if similarity >= 0.08 or contradiction:
                associations.append({
                    "source": first["id"],
                    "target": second["id"],
                    "similarity": round(similarity, 4),
                    "contradiction": contradiction,
                })
    associations.sort(
        key=lambda item: (item["contradiction"], item["similarity"]),
        reverse=True,
    )
    associations = associations[:max_associations]
    activated = [memory["id"] for memory in memories]
    strengthened = []
    for association in associations:
        for memory_id in (association["source"], association["target"]):
            if memory_id and memory_id not in strengthened:
                strengthened.append(memory_id)
    insights = [memory["text"].splitlines()[0][:300] for memory in memories[:6]]
    contradictions = [
        association for association in associations if association["contradiction"] > 0
    ]
    narrative = (
        f"REM synthesis connected {len(associations)} associations across "
        f"{len(memories)} active memories."
    )
    if contradictions:
        narrative += f" {len(contradictions)} possible contradiction(s) require review."
    return {
        "id": str(uuid.uuid4()),
        "type": "rem_dream",
        "agentId": agent_id,
        "scopeKey": resolved_key,
        "aclBindings": normalized_acl,
        "createdAt": _utcnow(),
        "phases": ["activation", "association", "synthesis", "integration"],
        "insights": insights,
        "narrative": narrative,
        "associations": associations,
        "contradictions": contradictions,
        "activatedMemoryIds": activated,
        "strengthenedMemoryIds": strengthened[: max(1, len(activated) // 2)],
        "destructiveChanges": False,
        "hasError": False,
        "generator": "deterministic-local-fallback",
    }
