"""Bounded, reviewed sync of the current scope's configured workspace notes."""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from itertools import islice
from pathlib import Path
from typing import Any

from .source_sync import _read_source
from .validation import resolve_inside
from .writer_lock import writer_lock


def changed_notes(workspace: Path, previous: dict, limit: int = 100) -> list[dict[str, str]]:
    """Read only bounded regular Markdown, excluding generated/hidden trees."""
    if workspace.is_symlink() or any(p.is_symlink() for p in workspace.parents if p != Path("/var")):
        raise ValueError("workspace symlink is not an import source")
    if not workspace.is_dir():
        return []
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
            if relative.parts[:2] == ("plur1bus", "memories"):
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
            data = _read_source(workspace, item["path"])
            if hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise ValueError("Obsidian note changed after review")
            content = data.decode("utf-8")
            for offset in range(0, len(content), 12000):
                text = content[offset:offset + 12000].strip()
                if not text:
                    continue
                identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, _digest({
                    "agentId": runtime.agent_id, "scopeKey": runtime.scope_key, "workspace": str(workspace),
                    "file": item["path"], "sha256": item["sha256"], "offset": offset,
                })))
                stored = runtime._remember(text, "obsidian-sync", "obsidian", record_id=identifier)
                if stored != identifier:
                    raise RuntimeError("Obsidian import did not persist; note remains unacknowledged")
                imported.append(identifier)
            # A concurrent editor must never get an acknowledgement for a newer
            # revision. The old imported text remains a recoverable observation.
            if hashlib.sha256(_read_source(workspace, item["path"])).hexdigest() != item["sha256"]:
                raise ValueError("Obsidian note changed during import; review its new revision")
            runtime._domain.mark_obsidian_synced([item], acl_bindings=runtime.scope_binding)
        runtime._domain.audit_mutation({"event": "obsidian.sync", "agentId": runtime.agent_id,
            "scopeKey": runtime.scope_key, "revision": approved_revision, "imported": len(imported)})
        return {"imported": imported, "files": len(plan["files"]), "revision": approved_revision,
                "mode": "append-only", "sourceFilesUnchanged": True}


def watch_obsidian(runtime: Any) -> dict[str, Any]:
    """Persist a change review, never consent or automatic import of new text."""
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
        return {"pendingFiles": len(plan["files"]), "revision": plan["revision"], "imported": 0,
                "requiresReview": bool(plan["files"])}
