"""Kanonischer Tombstone-Vertrag (OpenClaw-Parität) für den Hermes-Adapter.

`forget` entfernt eine Erinnerung nicht physisch, sondern soft-deleted die Zeile
(`status="deleted"`) und persistiert einen dauerhaften, versionierten Tombstone in
einer append-only Registry. Der Tombstone speichert nur Fingerprints, keinen
Klartext, und blockiert eine gleichlautende Neuerfassung im selben Scope.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import copy
import os
from .file_io import sync_parent
import re
import stat
import uuid
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from . import file_lock as fcntl

TOMBSTONE_SCHEMA_VERSION = 1

HEX_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SCOPE_KEY_RE = re.compile(r"^[0-9a-f]{64}$")


def normalize_content_for_fingerprint(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def content_fingerprint(text: Any) -> str:
    return hashlib.sha256(normalize_content_for_fingerprint(text).encode("utf-8")).hexdigest()


def _assert_no_symlink(path: Path, root: Path) -> None:
    """Reject symlink components while resolving an archive below ``root``."""
    current = root
    for component in path.relative_to(root).parts:
        current /= component
        try:
            if stat.S_ISLNK(os.lstat(current).st_mode):
                raise ValueError(f"symlink archive component: {current}")
        except FileNotFoundError:
            continue


def archive_path_for(base_dir: Path, agent_id: str, scope_key: str, memory_id: str) -> Path:
    """Return the canonical, agent- and scope-partitioned archive path."""
    from .validation import resolve_inside, safe_agent_id, safe_memory_id

    safe_agent = safe_agent_id(agent_id)
    safe_id = safe_memory_id(memory_id)
    normalized_scope = str(scope_key or "").strip()
    if not SCOPE_KEY_RE.fullmatch(normalized_scope):
        raise ValueError("scopeKey must be the canonical 64-character digest")
    root = Path(base_dir).expanduser().resolve()
    lexical_path = root / "archives" / safe_agent / normalized_scope / f"{safe_id}.json"
    _assert_no_symlink(lexical_path, root)
    path = resolve_inside(str(root), "archives", safe_agent, normalized_scope, f"{safe_id}.json")
    _assert_no_symlink(path, root)
    return path


def archive_card_atomically(path: Path, card: dict[str, Any]) -> None:
    """Write one archive exactly once, with fsync and no symlink following."""
    root = path.parents[3] if len(path.parents) > 3 else path.parent
    _assert_no_symlink(path, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    _assert_no_symlink(path, root)
    payload = (json.dumps(card, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if path.exists():
        if path.is_symlink():
            raise ValueError(f"archive is a symlink: {path}")
        if path.read_bytes() != payload:
            raise ValueError(f"archive collision: {path}")
        return
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        fd = os.open(temporary, flags, 0o600)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            fd = -1
        finally:
            if fd >= 0:
                os.close(fd)
        try:
            os.link(temporary, path)
        except FileExistsError:
            if path.is_symlink() or path.read_bytes() != payload:
                raise ValueError(f"archive collision: {path}")
        os.unlink(temporary)
        sync_parent(path)
    except Exception:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def build_tombstone(
    *,
    card: dict[str, Any],
    agent_id: str,
    actor: str = "",
    actor_type: str = "human",
    reason: str = "",
    source_op: str = "forget",
    archive_ref: str = "",
    archive_path: str = "",
    scope_key: str = "",
    acl_bindings: dict[str, Any] | None = None,
    tombstone_id: str | None = None,
    previous_version: str = "",
    deleted_at: str | None = None,
) -> dict[str, Any]:
    from .validation import safe_memory_id

    memory_id = safe_memory_id(str(card.get("id") or ""))
    content = str(card.get("content") or card.get("text") or "")
    deleted_at = deleted_at or _utcnow()
    resolved_scope_key = str(scope_key or card.get("scopeKey") or "")
    resolved_acl = dict(acl_bindings or card.get("aclBindings") or {})
    scope = str(card.get("scope") or card.get("scopeType") or "agent-private")
    return {
        "schemaVersion": TOMBSTONE_SCHEMA_VERSION,
        "tombstoneId": str(tombstone_id or uuid.uuid4()),
        "memoryId": memory_id,
        "canonicalOriginId": str(card.get("canonicalOriginId") or card.get("id") or memory_id),
        "agentId": agent_id,
        "scope": scope,
        "workspaceId": str(
            card.get("workspaceId")
            or card.get("workspaceKey")
            or card.get("workspaceIdentity")
            or resolved_acl.get("workspaceIdentity")
            or resolved_acl.get("workspace")
            or ""
        ),
        "workspaceKey": str(
            card.get("workspaceKey")
            or card.get("workspaceIdentity")
            or resolved_acl.get("workspaceIdentity")
            or resolved_acl.get("workspace")
            or ""
        ),
        "ownerPlatform": str(
            card.get("ownerPlatform")
            or card.get("platform")
            or resolved_acl.get("platform")
            or ""
        ),
        "ownerUserId": str(
            card.get("ownerUserId")
            or card.get("ownerUser")
            or resolved_acl.get("userId")
            or resolved_acl.get("user")
            or ""
        ),
        "chatId": str(
            card.get("chatId")
            or card.get("chatScope")
            or resolved_acl.get("chatId")
            or resolved_acl.get("chat")
            or ""
        ),
        "storedBy": str(card.get("storedBy") or ""),
        "deletedAt": deleted_at,
        "actor": str(actor or ""),
        "actorType": str(actor_type or "human"),
        "reason": str(reason or "")[:500],
        "sourceOp": source_op,
        "archiveRef": str(archive_ref or ""),
        "archivePath": str(archive_path or archive_ref or ""),
        "scopeKey": resolved_scope_key,
        "aclBindings": resolved_acl,
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
        tomb_platform = tombstone.get("ownerPlatform") or _acl_value(
            tombstone, "platform"
        )
        ctx_platform = ctx.get("platform") or ""
        return (
            bool(tomb_user)
            and tomb_user == ctx_user
            and bool(tomb_platform)
            and tomb_platform == ctx_platform
        )
    if scope == "chat":
        if ctx_scope != "chat":
            return False
        tomb_platform = tombstone.get("ownerPlatform") or _acl_value(
            tombstone, "platform"
        )
        tomb_chat = tombstone.get("chatId") or _acl_value(
            tombstone, "chatId", "chat"
        )
        return (
            bool(tomb_platform)
            and tomb_platform == str(ctx.get("platform") or "")
            and bool(tomb_chat)
            and tomb_chat == str(ctx.get("chatId") or ctx.get("chat") or "")
        )
    return False


def _acl_value(tombstone: dict[str, Any], *names: str) -> str:
    acl = tombstone.get("aclBindings")
    if not isinstance(acl, dict):
        return ""
    for name in names:
        value = acl.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def tombstone_registry_dir(base_dir: Path) -> Path:
    return base_dir / "_tombstones"


def _registry_file(base_dir: Path, agent_id: str) -> Path:
    from .validation import safe_agent_id

    return tombstone_registry_dir(base_dir) / f"{safe_agent_id(agent_id)}.jsonl"


@contextmanager
def _registry_lock(lock_path: Path):
    """Hold the per-agent registry lock across repair and append operations."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(fcntl.open_lock(lock_path), "r+b") as handle:
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
    if not is_valid_tombstone(tombstone, agent_id):
        raise ValueError("refusing to append an invalid or foreign tombstone")
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


_VALID_SCOPES = {"agent-private", "workspace", "user", "chat"}
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
    if scope == "user":
        if not _non_empty_string(parsed.get("ownerUserId")):
            return False
        if not (
            _non_empty_string(parsed.get("ownerPlatform"))
            or _non_empty_string(_acl_value(parsed, "platform"))
        ):
            return False
    if scope == "chat":
        if not (
            _non_empty_string(parsed.get("ownerPlatform"))
            or _non_empty_string(_acl_value(parsed, "platform"))
        ):
            return False
        if not (
            _non_empty_string(parsed.get("chatId"))
            or _non_empty_string(_acl_value(parsed, "chatId", "chat"))
        ):
            return False
    if parsed.get("status") not in _VALID_STATUSES:
        return False
    fingerprint = parsed.get("contentFingerprint")
    if not isinstance(fingerprint, str) or not _FINGERPRINT_RE.fullmatch(fingerprint):
        return False
    if "scopeKey" in parsed and parsed["scopeKey"] and not SCOPE_KEY_RE.fullmatch(str(parsed["scopeKey"])):
        return False
    if "aclBindings" in parsed and not isinstance(parsed["aclBindings"], dict):
        return False
    if "archivePath" in parsed and parsed["archivePath"] and not isinstance(parsed["archivePath"], str):
        return False
    return True


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def find_tombstone_by_fingerprint(base_dir: Path, agent_id: str, fingerprint: str) -> dict[str, Any] | None:
    committed = [t for t in read_tombstones_from_registry(base_dir, agent_id) if t.get("status") == "committed"]
    matches = [t for t in committed if t.get("contentFingerprint") and t["contentFingerprint"] == fingerprint]
    return matches[-1] if matches else None


def partition_cards_by_tombstone_guard(
    base_dir: Path,
    agent_id: str,
    cards: list[dict[str, Any]],
    *,
    scope: str,
    workspace_identity: str = "",
    owner_user_id: str = "",
    platform: str = "",
    chat: str = "",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Partition bulk-write cards into ``(allowed, blocked)`` via the canonical
    capture guard.

    Bulk writers (migration, workspace migration) must apply the same
    tombstone/fingerprint contract as a live capture before any ``table.add``:
    a forgotten text bound to the same agent and target scope is never
    revived. The scope binding is exact — foreign-scope tombstones neither
    block nor are ignored; they simply do not match, mirroring
    ``tombstone_blocks_capture``.
    """
    allowed: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    for card in cards:
        blocking = find_blocking_tombstone_for_capture(base_dir, {
            "agentId": agent_id,
            "text": str(card.get("content") or card.get("text") or ""),
            "scope": scope,
            "workspaceIdentity": workspace_identity,
            "userPrincipal": owner_user_id,
            "platform": platform,
            "chat": chat,
        })
        if blocking is not None:
            blocked.append(card)
        else:
            allowed.append(card)
    return allowed, blocked



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


def find_tombstone_by_origin_id(
    base_dir: Path,
    agent_id: str,
    origin_id: str,
    *,
    scope_key: str = "",
) -> dict[str, Any] | None:
    committed = [t for t in read_tombstones_from_registry(base_dir, agent_id) if t.get("status") == "committed"]
    matches = [
        t for t in committed
        if (t.get("canonicalOriginId") == origin_id or t.get("memoryId") == origin_id)
        and (not scope_key or str(t.get("scopeKey") or "") == scope_key)
    ]
    return matches[-1] if matches else None


def backfill_committed_tombstone(
    base_dir: Path, card: dict[str, Any], *, agent_id: str, actor: str = "", actor_type: str = "human",
    reason: str = "", source_op: str = "forget", archive_ref: str = "", previous_version: str = "",
    scope_key: str = "", acl_bindings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    existing = find_tombstone_by_origin_id(
        base_dir, agent_id, str(card.get("id") or ""), scope_key=scope_key,
    )
    if existing:
        return {"alreadyCommitted": True, "tombstone": existing}
    tombstone = build_tombstone(
        card=card, agent_id=agent_id, actor=actor, actor_type=actor_type, reason=reason,
        source_op=source_op, archive_ref=archive_ref, previous_version=previous_version,
        archive_path=archive_ref, scope_key=scope_key, acl_bindings=acl_bindings,
    )
    append_tombstone_to_registry(base_dir, agent_id, {**tombstone, "status": "committed"})
    return {"alreadyCommitted": False, "tombstone": tombstone}


def _archive_card_for_repair(
    base_dir: Path,
    agent_id: str,
    tombstone: dict[str, Any],
) -> dict[str, Any]:
    """Load and fully bind one repair archive to its attempted tombstone."""
    scope_key = str(tombstone.get("scopeKey") or "")
    memory_id = str(tombstone.get("memoryId") or "")
    expected = archive_path_for(base_dir, agent_id, scope_key, memory_id)
    recorded = Path(str(tombstone.get("archivePath") or tombstone.get("archiveRef") or ""))
    if not recorded.is_absolute() or recorded.resolve(strict=False) != expected.resolve(strict=False):
        raise ValueError("archive path does not match the canonical agent/scope target")
    _assert_no_symlink(expected, Path(base_dir).expanduser().resolve())
    if not expected.is_file():
        raise ValueError("archive is missing")
    try:
        card = json.loads(expected.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"archive is unreadable: {error}") from error
    if not isinstance(card, dict):
        raise ValueError("archive payload is not an object")
    if str(card.get("id") or "") != memory_id:
        raise ValueError("archive memory id mismatch")
    if str(card.get("agentId") or "") != agent_id:
        raise ValueError("archive agent mismatch")
    if str(card.get("scopeKey") or "") != scope_key:
        raise ValueError("archive scope mismatch")
    if content_fingerprint(card.get("content") or card.get("text") or "") != str(
        tombstone.get("contentFingerprint") or ""
    ):
        raise ValueError("archive content fingerprint mismatch")
    scope = str(tombstone.get("scope") or "")
    if str(card.get("scopeType") or card.get("scope") or "agent-private") != scope:
        raise ValueError("archive scope type mismatch")
    direct_checks = {
        "workspace": ("workspaceIdentity", tombstone.get("workspaceId") or tombstone.get("workspaceKey")),
        "user": ("ownerUser", tombstone.get("ownerUserId")),
        "chat": ("chatScope", tombstone.get("chatId") or _acl_value(tombstone, "chatId", "chat")),
    }
    if scope in direct_checks:
        field, expected_principal = direct_checks[scope]
        if not expected_principal or str(card.get(field) or "") != str(expected_principal):
            raise ValueError("archive principal mismatch")
    if scope in {"user", "chat"}:
        expected_platform = tombstone.get("ownerPlatform") or _acl_value(
            tombstone, "platform"
        )
        if not expected_platform or str(card.get("ownerPlatform") or "") != str(expected_platform):
            raise ValueError("archive platform mismatch")
    return card


def _memory_store_paths(base_dir: Path, agent_id: str) -> list[Path]:
    """Return bounded candidate Hermes memory stores without following symlinks."""
    from .validation import resolve_inside, safe_agent_id

    root = Path(base_dir).expanduser().resolve()
    safe_agent = safe_agent_id(agent_id)
    candidates = [resolve_inside(str(root), "lancedb", safe_agent)]
    namespaces = root / "lancedb-namespaces"
    if namespaces.is_dir() and not namespaces.is_symlink():
        for child in sorted(namespaces.iterdir())[:64]:
            if not child.is_dir() or child.is_symlink():
                continue
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", child.name):
                continue
            candidates.append(resolve_inside(str(root), "lancedb-namespaces", child.name, safe_agent))
    return candidates


def _lookup_deleted_card(base_dir: Path, agent_id: str, tombstone: dict[str, Any]) -> dict[str, Any] | None:
    """Find exactly one deleted card matching the attempted tombstone."""
    try:
        import lancedb
    except ImportError as error:  # pragma: no cover - package dependency
        raise RuntimeError("PLUR1BUS requires lancedb for tombstone repair") from error
    memory_id = str(tombstone["memoryId"])
    scope_key = str(tombstone.get("scopeKey") or "")
    matches: list[dict[str, Any]] = []
    for store_path in _memory_store_paths(base_dir, agent_id):
        if not store_path.is_dir():
            continue
        database = lancedb.connect(str(store_path))
        if "memories" not in database.table_names():
            continue
        rows = database.open_table("memories").search().where(
            f"id = '{memory_id}' AND agentId = '{agent_id}' AND scopeKey = '{scope_key}'"
        ).limit(2).to_list()
        matches.extend(dict(row) for row in rows)
    if not matches:
        return None
    deleted = [row for row in matches if str(row.get("status") or "") == "deleted"]
    if len(deleted) != len(matches):
        raise ValueError("a matching card is still recallable or has changed lifecycle")
    fingerprints = {
        content_fingerprint(row.get("content") or row.get("text") or "") for row in deleted
    }
    if fingerprints != {str(tombstone.get("contentFingerprint") or "")}:
        raise ValueError("deleted card fingerprint mismatch")
    return deleted[0]


def repair_tombstones(
    base_dir: Path,
    agent_id: str,
    *,
    apply: bool = False,
    card_lookup: Any = None,
) -> dict[str, Any]:
    """Plan or apply fail-closed repair of interrupted Hermes deletions."""
    from .validation import safe_agent_id

    safe_agent = safe_agent_id(agent_id)
    registry = read_tombstone_registry(base_dir, safe_agent, repair_torn_tail=False)
    report: dict[str, Any] = {
        "agentId": safe_agent,
        "apply": bool(apply),
        "planned": [],
        "reconstructed": [],
        "alreadyCommitted": [],
        "conflicts": [],
        "errors": [],
    }
    if not registry["ok"] or registry["corruptLines"]:
        report["errors"].append(
            registry.get("readError")
            or f"registry contains {registry['corruptLines']} corrupt line(s)"
        )
        report["complete"] = False
        report["ok"] = False
        return report
    by_id: dict[str, list[dict[str, Any]]] = {}
    for row in registry["tombstones"]:
        by_id.setdefault(str(row.get("tombstoneId") or ""), []).append(row)
    lookup = card_lookup or (
        lambda attempted: _lookup_deleted_card(Path(base_dir), safe_agent, attempted)
    )
    for tombstone_id, events in by_id.items():
        identity_fields = (
            "memoryId",
            "agentId",
            "scope",
            "scopeKey",
            "workspaceId",
            "workspaceKey",
            "ownerPlatform",
            "ownerUserId",
            "chatId",
            "archivePath",
            "contentFingerprint",
        )
        identities = {
            tuple(str(event.get(field) or "") for field in identity_fields)
            for event in events
        }
        if len(identities) != 1:
            report["conflicts"].append({
                "tombstoneId": tombstone_id,
                "memoryId": str(events[-1].get("memoryId") or ""),
                "reason": "events with the same tombstone id disagree on identity",
            })
            continue
        statuses = {str(event.get("status") or "") for event in events}
        attempted = next(
            (event for event in reversed(events) if event.get("status") == "attempted"),
            None,
        )
        if "committed" in statuses:
            report["alreadyCommitted"].append(tombstone_id)
            continue
        if "failed" in statuses or attempted is None:
            continue
        try:
            archive = _archive_card_for_repair(Path(base_dir), safe_agent, attempted)
            current = lookup(attempted)
            if not isinstance(current, dict):
                raise ValueError("no matching deleted card found")
            for field in ("id", "agentId", "scopeKey"):
                if str(current.get(field) or "") != str(archive.get(field) or ""):
                    raise ValueError(f"deleted card {field} mismatch")
            if str(current.get("status") or "") != "deleted":
                raise ValueError("matching card is not deleted")
            if content_fingerprint(current.get("content") or current.get("text") or "") != str(
                attempted.get("contentFingerprint") or ""
            ):
                raise ValueError("deleted card fingerprint mismatch")
        except Exception as error:
            report["conflicts"].append({
                "tombstoneId": tombstone_id,
                "memoryId": str(attempted.get("memoryId") or ""),
                "reason": str(error),
            })
            continue
        report["planned"].append(tombstone_id)
        if apply:
            try:
                append_tombstone_to_registry(
                    Path(base_dir),
                    safe_agent,
                    {
                        **attempted,
                        "status": "committed",
                        "repairedAt": _utcnow(),
                        "repairSource": "plur1bus-hermes-repair-tombstones",
                    },
                )
            except Exception as error:
                report["errors"].append({
                    "tombstoneId": tombstone_id,
                    "reason": str(error),
                })
            else:
                report["reconstructed"].append(tombstone_id)
    report["complete"] = not report["conflicts"] and not report["errors"]
    report["ok"] = report["complete"]
    return report


def repair_cli_main(argv: list[str] | None = None) -> int:
    """CLI entrypoint for native Hermes tombstone repair."""
    parser = argparse.ArgumentParser(description="Repair interrupted Hermes tombstones")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--apply", action="store_true")
    arguments = parser.parse_args(argv)
    report = repair_tombstones(
        arguments.data_dir,
        arguments.agent,
        apply=arguments.apply,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


def _utcnow() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    raise SystemExit(repair_cli_main())
