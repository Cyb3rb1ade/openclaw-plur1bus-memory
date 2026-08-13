"""Kanonischer Tombstone-Vertrag (OpenClaw-Parität) für den Hermes-Adapter.

`forget` entfernt eine Erinnerung nicht physisch, sondern soft-deleted die Zeile
(`status="deleted"`) und persistiert einen dauerhaften, versionierten Tombstone in
einer append-only Registry. Der Tombstone speichert nur Fingerprints, keinen
Klartext, und blockiert eine gleichlautende Neuerfassung im selben Scope.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Any

TOMBSTONE_SCHEMA_VERSION = 1

HEX_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def normalize_content_for_fingerprint(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def content_fingerprint(text: Any) -> str:
    return hashlib.sha256(normalize_content_for_fingerprint(text).encode("utf-8")).hexdigest()


def build_tombstone(
    *,
    card: dict[str, Any],
    agent_id: str,
    actor: str = "",
    actor_type: str = "human",
    reason: str = "",
    source_op: str = "forget",
    archive_ref: str = "",
    previous_version: str = "",
    deleted_at: str | None = None,
) -> dict[str, Any]:
    from .validation import safe_memory_id

    memory_id = safe_memory_id(str(card.get("id") or ""))
    content = str(card.get("content") or card.get("text") or "")
    deleted_at = deleted_at or _utcnow()
    return {
        "schemaVersion": TOMBSTONE_SCHEMA_VERSION,
        "tombstoneId": str(uuid.uuid4()),
        "memoryId": memory_id,
        "canonicalOriginId": str(card.get("canonicalOriginId") or card.get("id") or memory_id),
        "agentId": agent_id,
        "scope": str(card.get("scope") or "agent-private"),
        "workspaceId": str(card.get("workspaceId") or card.get("workspaceKey") or ""),
        "workspaceKey": str(card.get("workspaceKey") or ""),
        "ownerUserId": str(card.get("ownerUserId") or ""),
        "storedBy": str(card.get("storedBy") or ""),
        "deletedAt": deleted_at,
        "actor": str(actor or ""),
        "actorType": str(actor_type or "human"),
        "reason": str(reason or "")[:500],
        "sourceOp": source_op,
        "archiveRef": str(archive_ref or ""),
        "previousVersion": str(previous_version or ""),
        "contentFingerprint": content_fingerprint(content) if content else "",
        "sourceFingerprint": "",
        "refs": {},
        "status": "committed",
    }


def tombstone_blocks_capture(tombstone: dict[str, Any], ctx: dict[str, Any]) -> bool:
    if not tombstone or tombstone.get("status") == "failed":
        return False
    if str(tombstone.get("agentId") or "") != str(ctx.get("agentId") or ""):
        return False
    scope = str(tombstone.get("scope") or "agent-private")
    if scope == "agent-private":
        return True
    if scope == "workspace":
        tomb_ws = tombstone.get("workspaceId") or tombstone.get("workspaceKey") or ""
        ctx_ws = ctx.get("workspaceIdentity") or ctx.get("workspaceKey") or ""
        return bool(tomb_ws) and tomb_ws == ctx_ws
    if scope == "user":
        tomb_user = tombstone.get("ownerUserId") or ""
        ctx_user = ctx.get("ownerUserId") or ctx.get("userPrincipal") or ""
        return bool(tomb_user) and tomb_user == ctx_user
    return True


def tombstone_registry_dir(base_dir: Path) -> Path:
    return base_dir / "_tombstones"


def _registry_file(base_dir: Path, agent_id: str) -> Path:
    from .validation import safe_agent_id

    return tombstone_registry_dir(base_dir) / f"{safe_agent_id(agent_id)}.jsonl"


def append_tombstone_to_registry(base_dir: Path, agent_id: str, tombstone: dict[str, Any]) -> Path:
    directory = tombstone_registry_dir(base_dir)
    directory.mkdir(parents=True, exist_ok=True)
    file = _registry_file(base_dir, agent_id)
    with file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(tombstone, ensure_ascii=True, sort_keys=True, default=str) + "\n")
    return file


def read_tombstones_from_registry(base_dir: Path, agent_id: str) -> list[dict[str, Any]]:
    file = _registry_file(base_dir, agent_id)
    if not file.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in file.read_text(encoding="utf-8").splitlines():
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if parsed and parsed.get("schemaVersion"):
            out.append(parsed)
    return out


def find_tombstone_by_fingerprint(base_dir: Path, agent_id: str, fingerprint: str) -> dict[str, Any] | None:
    committed = [t for t in read_tombstones_from_registry(base_dir, agent_id) if t.get("status") == "committed"]
    matches = [t for t in committed if t.get("contentFingerprint") and t["contentFingerprint"] == fingerprint]
    return matches[-1] if matches else None


def find_blocking_tombstone_for_capture(base_dir: Path, opts: dict[str, Any]) -> dict[str, Any] | None:
    text = str(opts.get("text") or "")
    if not text:
        return None
    fingerprint = content_fingerprint(text)
    tombstone = find_tombstone_by_fingerprint(base_dir, opts.get("agentId"), fingerprint)
    if not tombstone:
        return None
    return tombstone if tombstone_blocks_capture(tombstone, opts) else None


def _utcnow() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
