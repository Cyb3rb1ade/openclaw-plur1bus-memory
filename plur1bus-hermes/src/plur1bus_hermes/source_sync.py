"""Revision-bound, explicitly consented workspace text import.

Source discovery is read-only. A manifest is not authority: apply recomputes
the exact approved source snapshot and imports into the caller's bound runtime.
Original files and existing memories are never overwritten or removed.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any

from .validation import resolve_inside

SUFFIXES = {".md", ".txt", ".rst"}


def _read_source(source: Path, relative: str) -> bytes:
    """Read only a bounded regular file; never follow a replaced leaf symlink."""
    raw = source / relative
    if raw.is_symlink():
        raise ValueError("source changed to symlink")
    path = resolve_inside(str(source), relative)
    from .file_lock import open_existing
    fd = open_existing(path)
    with os.fdopen(fd, "rb") as handle:
        metadata = os.fstat(handle.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 200_000:
            raise ValueError("source must be a bounded regular text file")
        data = handle.read(200_001)
        if len(data) > 200_000 or len(data) != metadata.st_size:
            raise ValueError("source changed during read")
        return data


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def plan_source_sync(source: Path, *, max_files: int = 100, max_bytes: int = 1_000_000) -> dict[str, Any]:
    """Inspect a bounded non-symlink text tree without reading hidden files."""
    source = source.expanduser().absolute()
    if source.is_symlink() or not source.is_dir() or source == Path(source.anchor):
        raise ValueError("source must be an explicit non-root directory")
    if any(parent.is_symlink() for parent in source.parents):
        raise ValueError("source ancestors must not be symlinks")
    files = []
    total = 0
    for current, directories, names in os.walk(source, followlinks=False):
        directories[:] = sorted(d for d in directories if not d.startswith(".") and not Path(current, d).is_symlink())
        for name in sorted(names):
            path = Path(current, name)
            if name.startswith(".") or path.suffix.lower() not in SUFFIXES or path.is_symlink():
                continue
            relative = path.relative_to(source).as_posix()
            safe = resolve_inside(str(source), relative)
            size = safe.stat().st_size
            if size > 200_000 or len(files) >= max_files or total + size > max_bytes:
                raise ValueError("source exceeds bounded import limits; narrow the source directory")
            data = _read_source(source, relative)
            data.decode("utf-8")
            if len(data) != size:
                raise ValueError("source changed during planning")
            total += size
            files.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest(), "bytes": size})
    if not files:
        raise ValueError("no supported source text files")
    manifest = {"version": 1, "source": str(source), "files": files, "bytes": total}
    return {**manifest, "revision": _digest(manifest), "dryRun": True}


def apply_source_sync(runtime: Any, plan: dict[str, Any], *, approved_revision: str) -> dict[str, Any]:
    """Import only a freshly verified approved revision with stable chunk IDs."""
    if approved_revision != plan.get("revision") or plan_source_sync(Path(plan["source"])) != plan:
        raise ValueError("source revision is stale or unapproved")
    # Source approval is exact; the local operator separately selects the runtime.
    source = Path(plan["source"])
    imported, unchanged = [], []
    for item in plan["files"]:
        data = _read_source(source, item["path"])
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("source changed after approval")
        text = data.decode("utf-8")
        for offset in range(0, len(text), 12000):
            chunk = text[offset:offset + 12000].strip()
            if not chunk:
                continue
            import uuid
            identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, _digest({
                "agent": runtime.agent_id, "scope": runtime.scope_key,
                "source": str(source), "file": item["path"], "hash": item["sha256"], "offset": offset,
            })))
            table, _ = runtime._table(create=False)
            existed = table is not None and bool(table.search().where(f"id = '{identifier}'").limit(1).to_list())
            # Source text is data, never an observed direct user statement.
            stored = runtime._remember(chunk, "workspace-source", "workspace-source", record_id=identifier)
            if stored != identifier:
                raise RuntimeError("source import did not persist; existing records remain intact")
            (unchanged if existed else imported).append(identifier)
    runtime._domain.audit_mutation({"event": "workspace.source_sync", "agentId": runtime.agent_id,
        "scopeKey": runtime.scope_key, "revision": approved_revision,
        "imported": len(imported), "unchanged": len(unchanged)})
    return {"imported": imported, "unchanged": unchanged, "revision": approved_revision,
            "sourceFilesUnchanged": True, "mode": "append-only"}
