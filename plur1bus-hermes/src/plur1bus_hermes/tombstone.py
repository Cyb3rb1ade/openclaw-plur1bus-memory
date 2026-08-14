"""Kanonischer Tombstone-Vertrag (OpenClaw-Parität) für den Hermes-Adapter.

`forget` entfernt eine Erinnerung nicht physisch, sondern soft-deleted die Zeile
(`status="deleted"`) und persistiert einen dauerhaften, versionierten Tombstone in
einer append-only Registry. Der Tombstone speichert nur Fingerprints, keinen
Klartext, und blockiert eine gleichlautende Neuerfassung im selben Scope.
"""

from __future__ import annotations

import hashlib
import json
import copy
import os
import re
import uuid
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import fcntl

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
        "contentFingerprint": content_fingerprint(content),
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
    ctx_scope = str(ctx.get("scope") or "agent-private")
    if scope == "agent-private":
        # Exakte Scope-Typ-Bindung: agent-private blockiert NUR agent-private.
        return ctx_scope == "agent-private"
    if scope == "workspace":
        if ctx_scope != "workspace":
            return False
        tomb_ws = tombstone.get("workspaceId") or tombstone.get("workspaceKey") or ""
        ctx_ws = ctx.get("workspaceIdentity") or ctx.get("workspaceKey") or ""
        return bool(tomb_ws) and tomb_ws == ctx_ws
    if scope == "user":
        if ctx_scope != "user":
            return False
        tomb_user = tombstone.get("ownerUserId") or ""
        ctx_user = ctx.get("ownerUserId") or ctx.get("userPrincipal") or ""
        return bool(tomb_user) and tomb_user == ctx_user
    return True


def tombstone_registry_dir(base_dir: Path) -> Path:
    return base_dir / "_tombstones"


def _registry_file(base_dir: Path, agent_id: str) -> Path:
    from .validation import safe_agent_id

    return tombstone_registry_dir(base_dir) / f"{safe_agent_id(agent_id)}.jsonl"


@contextmanager
def _registry_lock(lock_path: Path):
    """Hold the per-agent registry lock across repair and append operations."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _quarantine_file(registry_file: Path) -> Path:
    """Return the non-JSONL quarantine path for an interrupted append."""
    return registry_file.with_suffix(".corrupt.log")


def _invalidate_registry_cache(registry_file: Path) -> None:
    _registry_cache.pop(str(registry_file), None)


def append_tombstone_to_registry(base_dir: Path, agent_id: str, tombstone: dict[str, Any]) -> Path:
    directory = tombstone_registry_dir(base_dir)
    directory.mkdir(parents=True, exist_ok=True)
    file = _registry_file(base_dir, agent_id)
    with _registry_lock(file.with_name(file.name + ".lock")):
        if file.exists():
            _repair_torn_tail_locked(file, agent_id)
        with file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(tombstone, ensure_ascii=True, sort_keys=True, default=str) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        _invalidate_registry_cache(file)
    return file


class TombstoneRegistryReadError(Exception):
    """Registry konnte nicht (sicher) gelesen werden — Capture/Restore blockieren."""


def read_tombstones_from_registry(
    base_dir: Path,
    agent_id: str,
    *,
    repair_torn_tail: bool = True,
) -> list[dict[str, Any]]:
    result = read_tombstone_registry(base_dir, agent_id, repair_torn_tail=repair_torn_tail)
    if not result["ok"]:
        raise TombstoneRegistryReadError(result["readError"])
    if result["corruptLines"] > 0:
        raise TombstoneRegistryReadError(f"corrupt registry lines: {result['corruptLines']}")
    return result["tombstones"]


def read_tombstone_registry(
    base_dir: Path,
    agent_id: str,
    *,
    repair_torn_tail: bool = True,
) -> dict[str, Any]:
    """Read safely, quarantining only a genuinely incomplete final JSONL line."""
    file = _registry_file(base_dir, agent_id)
    if not file.exists():
        return {"ok": True, "tombstones": [], "corruptLines": 0, "readError": None}
    try:
        classified = _classify_registry_cached(file, agent_id)
    except OSError as error:
        return {"ok": False, "tombstones": [], "corruptLines": 0, "readError": str(error)}
    if classified["tornTail"] is None:
        return _registry_result(classified)
    if not repair_torn_tail:
        return {
            "ok": True,
            "tombstones": copy.deepcopy(classified["tombstones"]),
            "corruptLines": classified["corruptLines"] + 1,
            "corruptDetail": {**classified["corruptDetail"], "tornTail": 1},
            "readError": None,
        }
    try:
        with _registry_lock(file.with_name(file.name + ".lock")):
            _repair_torn_tail_locked(file, agent_id)
        repaired = _classify_registry_cached(file, agent_id)
    except OSError as error:
        return {
            "ok": False,
            "tombstones": [],
            "corruptLines": 0,
            "readError": f"torn-tail repair failed: {error}",
        }
    if repaired["tornTail"] is not None:
        return {
            "ok": False,
            "tombstones": [],
            "corruptLines": 0,
            "readError": "torn-tail persisted after repair",
        }
    return _registry_result(repaired)


def _registry_result(classified: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "tombstones": copy.deepcopy(classified["tombstones"]),
        "corruptLines": classified["corruptLines"],
        "corruptDetail": dict(classified["corruptDetail"]),
        "readError": None,
    }


def _classify_registry_cached(file: Path, agent_id: str) -> dict[str, Any]:
    stat = file.stat()
    key = str(file)
    cached = _registry_cache.get(key)
    if cached and cached[:3] == (stat.st_mtime_ns, stat.st_size, agent_id):
        _registry_cache.move_to_end(key)
        return cached[3]
    classified = _classify_registry_text(file.read_text(encoding="utf-8"), agent_id)
    _registry_cache[key] = (stat.st_mtime_ns, stat.st_size, agent_id, classified)
    _registry_cache.move_to_end(key)
    while len(_registry_cache) > _REGISTRY_CACHE_LIMIT:
        _registry_cache.popitem(last=False)
    return classified


def _classify_registry_text(text: str, agent_id: str) -> dict[str, Any]:
    """Classify valid rows, corruption, and at most one incomplete tail."""
    ends_with_newline = text.endswith("\n")
    lines = text.split("\n")
    if ends_with_newline:
        lines.pop()
    tombstones: list[dict[str, Any]] = []
    corrupt_lines = 0
    corrupt_detail = {"unparseable": 0, "invalid": 0}
    torn_tail: dict[str, Any] | None = None
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        is_last = index == len(lines) - 1
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as error:
            if (
                is_last
                and not ends_with_newline
                and corrupt_lines == 0
                and _is_incomplete_json_fragment(line, error)
            ):
                torn_tail = {
                    "fragment": line,
                    "validLength": len(text.encode("utf-8")) - len(line.encode("utf-8")),
                }
                continue
            corrupt_lines += 1
            corrupt_detail["unparseable"] += 1
            continue
        if is_valid_tombstone(parsed, agent_id):
            tombstones.append(parsed)
        else:
            corrupt_lines += 1
            corrupt_detail["invalid"] += 1
    if torn_tail is not None and corrupt_lines > 0:
        torn_tail = None
        corrupt_lines += 1
        corrupt_detail["unparseable"] += 1
    return {
        "tombstones": tombstones,
        "corruptLines": corrupt_lines,
        "corruptDetail": corrupt_detail,
        "tornTail": torn_tail,
    }


def _is_incomplete_json_fragment(line: str, error: json.JSONDecodeError) -> bool:
    """Recognize a truncated JSON value, not an arbitrary corrupt tail."""
    content = line.rstrip()
    if not content:
        return False
    if "Unterminated string" in error.msg:
        return True
    return error.pos >= len(content)


def _repair_torn_tail_locked(file: Path, agent_id: str) -> bool:
    """Quarantine a torn tail and truncate the registry while holding its lock."""
    classified = _classify_registry_text(file.read_text(encoding="utf-8"), agent_id)
    torn_tail = classified["tornTail"]
    if torn_tail is None:
        return False
    quarantine = _quarantine_file(file)
    fragment = str(torn_tail["fragment"])
    existing = quarantine.read_text(encoding="utf-8") if quarantine.exists() else ""
    if not existing.endswith(fragment + "\n"):
        with quarantine.open("a", encoding="utf-8") as handle:
            handle.write(fragment + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    with file.open("r+b") as handle:
        handle.truncate(int(torn_tail["validLength"]))
        handle.flush()
        os.fsync(handle.fileno())
    _invalidate_registry_cache(file)
    return True


_VALID_SCOPES = {"agent-private", "workspace", "user"}
_VALID_STATUSES = {"attempted", "committed", "failed"}
_FINGERPRINT_RE = re.compile(r"^[0-9a-f]{64}$")
_REGISTRY_CACHE_LIMIT = 50
_registry_cache: OrderedDict[str, tuple[int, int, str, dict[str, Any]]] = OrderedDict()


def is_valid_tombstone(parsed: Any, expected_agent_id: str | None = None) -> bool:
    """Vollständige Schema-/Enum-/UUID-/Principal-Validierung einer Tombstone-Zeile."""
    if not isinstance(parsed, dict):
        return False
    if parsed.get("schemaVersion") != TOMBSTONE_SCHEMA_VERSION:
        return False
    memory_id = parsed.get("memoryId")
    if not isinstance(memory_id, str):
        return False
    try:
        uuid.UUID(memory_id)
    except (ValueError, AttributeError):
        return False
    agent_id = parsed.get("agentId")
    if not isinstance(agent_id, str) or not agent_id:
        return False
    from .validation import safe_agent_id

    try:
        safe_agent_id(agent_id)
    except Exception:
        return False
    # Registry-Agent-Bindung: die Zeile gehört exakt zum Agenten der Datei.
    if expected_agent_id is not None and agent_id != expected_agent_id:
        return False
    scope = parsed.get("scope")
    if scope not in _VALID_SCOPES:
        return False
    # Principal-Bindung: getrimmter, nicht leerer STRING (kein Typ-/Whitespace-Bypass).
    if scope == "workspace" and not (
        _non_empty_string(parsed.get("workspaceId"))
        or _non_empty_string(parsed.get("workspaceKey"))
    ):
        return False
    if scope == "user" and not _non_empty_string(parsed.get("ownerUserId")):
        return False
    if parsed.get("status") not in _VALID_STATUSES:
        return False
    fingerprint = parsed.get("contentFingerprint")
    if not isinstance(fingerprint, str) or not _FINGERPRINT_RE.fullmatch(fingerprint):
        return False
    return True


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def find_tombstone_by_fingerprint(base_dir: Path, agent_id: str, fingerprint: str) -> dict[str, Any] | None:
    committed = [t for t in read_tombstones_from_registry(base_dir, agent_id) if t.get("status") == "committed"]
    matches = [t for t in committed if t.get("contentFingerprint") and t["contentFingerprint"] == fingerprint]
    return matches[-1] if matches else None


def find_blocking_tombstone_for_capture(base_dir: Path, opts: dict[str, Any]) -> dict[str, Any] | None:
    text = str(opts.get("text") or "")
    if not text:
        return None
    agent_id = str(opts.get("agentId") or "")
    result = read_tombstone_registry(base_dir, agent_id)
    if not result["ok"]:
        # Fail-closed: Lesefehler → konservativ blockieren (diagnostiziert).
        return {
            "schemaVersion": TOMBSTONE_SCHEMA_VERSION,
            "memoryId": "",
            "canonicalOriginId": "",
            "agentId": agent_id,
            "scope": "agent-private",
            "status": "committed",
            "contentFingerprint": "",
            "_blockReason": "registry_read_error",
            "_diagnostic": result["readError"],
        }
    if result["corruptLines"] > 0:
        return {
            "schemaVersion": TOMBSTONE_SCHEMA_VERSION,
            "memoryId": "",
            "canonicalOriginId": "",
            "agentId": agent_id,
            "scope": "agent-private",
            "status": "committed",
            "contentFingerprint": "",
            "_blockReason": "registry_corrupt_lines",
            "_diagnostic": f"corrupt lines: {result['corruptLines']}",
        }
    fingerprint = content_fingerprint(text)
    matches = [
        t
        for t in result["tombstones"]
        if t.get("status") == "committed" and t.get("contentFingerprint") and t["contentFingerprint"] == fingerprint
    ]
    for tombstone in matches:
        if tombstone_blocks_capture(tombstone, opts):
            return tombstone
    return None


def find_tombstone_by_origin_id(base_dir: Path, agent_id: str, origin_id: str) -> dict[str, Any] | None:
    committed = [t for t in read_tombstones_from_registry(base_dir, agent_id) if t.get("status") == "committed"]
    matches = [t for t in committed if t.get("canonicalOriginId") == origin_id or t.get("memoryId") == origin_id]
    return matches[-1] if matches else None


def backfill_committed_tombstone(
    base_dir: Path, card: dict[str, Any], *, agent_id: str, actor: str = "", actor_type: str = "human",
    reason: str = "", source_op: str = "forget", archive_ref: str = "", previous_version: str = "",
) -> dict[str, Any]:
    existing = find_tombstone_by_origin_id(base_dir, agent_id, str(card.get("id") or ""))
    if existing:
        return {"alreadyCommitted": True, "tombstone": existing}
    tombstone = build_tombstone(
        card=card, agent_id=agent_id, actor=actor, actor_type=actor_type, reason=reason,
        source_op=source_op, archive_ref=archive_ref, previous_version=previous_version,
    )
    append_tombstone_to_registry(base_dir, agent_id, {**tombstone, "status": "committed"})
    return {"alreadyCommitted": False, "tombstone": tombstone}


def _utcnow() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
