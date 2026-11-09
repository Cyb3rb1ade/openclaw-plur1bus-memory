"""Bounded, reviewed sync of the current scope's configured workspace notes."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import uuid
from fnmatch import fnmatchcase
from functools import lru_cache
from itertools import islice
from pathlib import Path
from typing import Any

from .source_sync import _read_source
from .validation import resolve_inside
from .writer_lock import writer_lock

LOGGER = logging.getLogger(__name__)
DEFAULT_NOTE_IMPORT_EXCLUDES = (
    "SOUL.md", "USER.md", "IDENTITY.md", "AGENTS.md", "HEARTBEAT.md", "TOOLS.md",
    "MEMORY.md", "BOOTSTRAP.md", "persona-voice.md", "memory/episodes/**",
    "memory/dream-diary/**", "DREAMS.md", "memory/consolidation/**", "memory/graph/**",
    "reports/routines/**", "**/logbuch.md", "**/gesehen.md",
)
# Control files and generated mirrors are not importable even if defaults are replaced.
NEVER_IMPORT = ("plur1bus/memories/**", "memory/cards/**", "memory/KNOWLEDGE.md", "decisions/**")
SUSPICIOUS_NOTE = re.compile(
    r"ignore\s+(all\s+)?(previous|system|developer|higher-priority)\s+(instructions|messages|rules)"
    r"|\b(system|developer)\s+prompt\b|\bexecute\s+(this\s+)?(shell\s+)?command\b"
    r"|\b(read|print|exfiltrate)\s+(secrets?|env|environment|api[_-]?keys?)\b"
    r"|\brm\s+-rf\b|\bcurl\b[^\n|;&]*\|\s*(sh|bash)\b|\bsudo\b|\bBEGIN[_ -]?SECRET\b",
    re.IGNORECASE,
)


def _matches(parts: tuple[str, ...], pattern: tuple[str, ...]) -> bool:
    @lru_cache(None)
    def match(i: int, j: int) -> bool:
        if j == len(pattern):
            return i == len(parts)
        if pattern[j] == "**":
            return match(i, j + 1) or (i < len(parts) and match(i + 1, j))
        return i < len(parts) and fnmatchcase(parts[i], pattern[j]) and match(i + 1, j + 1)

    return match(0, 0)


def _import_patterns(config: dict) -> tuple[tuple[str, ...], ...]:
    extra = config.get("noteImportExclude", [])
    if not isinstance(extra, list) or len(extra) > 100 or any(
        not isinstance(p, str) or len(p) > 256 or "\\" in p
        or any(part in {"", ".", ".."} for part in p.strip().split("/"))
        for p in extra
    ):
        raise ValueError("invalid noteImportExclude: expected bounded workspace-relative globs")
    defaults = () if config.get("noteImportExcludeReplaceDefaults") is True else DEFAULT_NOTE_IMPORT_EXCLUDES
    return tuple(tuple(p.strip().casefold().split("/")) for p in (*NEVER_IMPORT, *defaults, *extra))


def changed_notes(workspace: Path, previous: dict, limit: int = 100, *,
                  config: dict | None = None) -> list[dict[str, str]]:
    """Read only bounded regular Markdown, excluding generated/hidden trees."""
    if workspace.is_symlink() or any(p.is_symlink() for p in workspace.parents if p != Path("/var")):
        raise ValueError("workspace symlink is not an import source")
    if not workspace.is_dir():
        return []
    patterns = _import_patterns(config or {})
    pending, visited, total, result = [workspace], 0, 0, []
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as scan:
            entries = list(islice(scan, 2001))
        visited += len(entries)
        if visited > 2000:
            raise ValueError("workspace exceeds 2000-entry scan budget; use an explicit narrower source")
        for entry in sorted(entries, key=lambda item: item.name):
            if entry.name.startswith(".") or entry.is_symlink():
                continue
            path = Path(entry.path)
            relative = path.relative_to(workspace)
            parts = tuple(part.casefold() for part in relative.parts)
            if len(parts) > 64:
                raise ValueError("workspace exceeds note import depth budget")
            if any(_matches(parts, pattern) for pattern in patterns):
                continue
            if entry.is_dir(follow_symlinks=False):
                pending.append(path)
            elif entry.is_file(follow_symlinks=False) and path.suffix.lower() == ".md":
                data = _read_source(workspace, relative.as_posix())
                total += len(data)
                if total > 1_000_000:
                    raise ValueError("workspace exceeds 1 MB scan budget; use an explicit narrower source")
                digest = hashlib.sha256(data).hexdigest()
                if previous.get(relative.as_posix()) != digest:
                    result.append({"path": relative.as_posix(), "content": data.decode("utf-8"), "sha256": digest})
                    if len(result) >= max(1, min(limit, 100)):
                        return result
    return result


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def plan_obsidian_sync(runtime: Any) -> dict[str, Any]:
    """Preview exact source hashes and destination; accepts no caller path."""
    selector = runtime._domain._scope_selector(acl_bindings=runtime.scope_binding)
    workspace = runtime._domain._scope_workspace_dir(selector)
    candidates = runtime._domain.obsidian_candidates(acl_bindings=runtime.scope_binding)
    manifest = {"version": 1, "agentId": runtime.agent_id, "scopeKey": runtime.scope_key,
                "workspace": str(workspace.resolve()), "writerRoute": str(runtime._writer_route.path.resolve()),
                "files": [{k: note[k] for k in ("path", "sha256")} for note in candidates],
                "mode": "append-only", "sourceFilesUnchanged": True}
    return {**manifest, "revision": _digest(manifest), "dryRun": True}


def apply_obsidian_sync(runtime: Any, *, approved_revision: str) -> dict[str, Any]:
    """Import synchronously with stable IDs; acknowledge only verified stores."""
    with writer_lock(runtime.data_dir):
        plan = plan_obsidian_sync(runtime)
        if plan["revision"] != approved_revision:
            raise ValueError("Obsidian sync review is stale or belongs to another scope")
        workspace = Path(plan["workspace"])
        imported = []
        for item in plan["files"]:
            imported.extend(_apply_note(runtime, workspace, item))
        runtime._domain.audit_mutation({"event": "obsidian.sync", "agentId": runtime.agent_id,
            "scopeKey": runtime.scope_key, "revision": approved_revision, "imported": len(imported)})
        return {"imported": imported, "files": len(plan["files"]), "revision": approved_revision,
                "mode": "append-only", "sourceFilesUnchanged": True}


def _verified_note(workspace: Path, item: dict) -> str:
    data = _read_source(workspace, item["path"])
    if hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise ValueError("Obsidian note changed after review")
    return data.decode("utf-8")


def _apply_note(runtime: Any, workspace: Path, item: dict) -> list[str]:
    content = _verified_note(workspace, item)
    imported = []
    for offset in range(0, len(content), 12000):
        text = content[offset:offset + 12000].strip()
        if not text:
            continue
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, _digest({
            "agentId": runtime.agent_id, "scopeKey": runtime.scope_key, "workspace": str(workspace),
            "file": item["path"], "sha256": item["sha256"], "offset": offset,
        })))
        if runtime._remember(text, "obsidian-sync", "obsidian", record_id=identifier) != identifier:
            raise RuntimeError("Obsidian import did not persist; note remains unacknowledged")
        imported.append(identifier)
    # Never acknowledge a newer revision after a concurrent edit.
    _verified_note(workspace, item)
    runtime._domain.mark_obsidian_synced([item], acl_bindings=runtime.scope_binding)
    return imported


def _auto_apply_notes(runtime: Any, plan: dict) -> dict[str, int]:
    counts = {"autoApproved": 0, "autoApplied": 0, "autoFailed": 0, "imported": 0}
    workspace = Path(plan["workspace"])
    for item in plan["files"]:
        try:
            content = _verified_note(workspace, item)
            # No cross-scope promotion, knowledge mutation, or model judgment.
            # Longer, empty or suspicious notes stay in the manual queue.
            if not content.strip() or len(content) > 12000 or SUSPICIOUS_NOTE.search(content):
                continue
            approved_hash = _digest({"revision": plan["revision"], "file": item})
            audit = {"agentId": runtime.agent_id, "scopeKey": runtime.scope_key,
                     "revision": plan["revision"], "approvalSource": "auto_low_risk",
                     "approvedPayloadHash": approved_hash}
            runtime._domain.audit_mutation({"event": "obsidian.auto-approved", **audit})
            counts["autoApproved"] += 1
            counts["imported"] += len(_apply_note(runtime, workspace, item))
            counts["autoApplied"] += 1
        except Exception as error:
            counts["autoFailed"] += 1
            LOGGER.warning("Obsidian auto-apply failed (%s); note remains eligible for review",
                           type(error).__name__)
    return counts


def watch_obsidian(runtime: Any) -> dict[str, Any]:
    """Persist the scoped review, optionally importing low-risk private notes."""
    config = runtime.config.get("obsidianBridge") or {}
    if config.get("enabled") is not True or config.get("watch") is not True:
        return {"skipped": True, "reason": "watch-disabled"}
    with writer_lock(runtime.data_dir):
        plan = plan_obsidian_sync(runtime)
        selector = runtime._domain._scope_selector(acl_bindings=runtime.scope_binding)
        state = runtime._domain._scope_state_dir(selector)
        path = resolve_inside(str(runtime.data_dir), str((state / "obsidian-review.json").relative_to(runtime.data_dir)))
        from .generation import _atomic_json
        _atomic_json(path, plan)
        report = {"imported": 0}
        if config.get("autoApplyLowRisk") is True and selector.scope_type == "agent-private" and plan["files"]:
            report.update(_auto_apply_notes(runtime, plan))
            if report["autoApplied"]:
                plan = plan_obsidian_sync(runtime)
                _atomic_json(path, plan)
        return {**report, "pendingFiles": len(plan["files"]), "revision": plan["revision"],
                "requiresReview": bool(plan["files"])}
