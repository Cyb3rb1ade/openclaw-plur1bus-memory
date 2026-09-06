"""Generate managed Obsidian control-room views without touching user notes."""

from __future__ import annotations

import json
import hashlib
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from .validation import safe_agent_id, resolve_inside
from . import file_lock
from .generation import _atomic_json, _read_json_existing
from .source_sync import _read_source
from .file_io import replace_file, sync_parent
import tempfile


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write(path: Path, content: str) -> bool:
    """Replace only our unchanged managed file; preserve foreign/manual edits."""
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise ValueError("unsafe Obsidian managed path")
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = file_lock.open_lock(path.parent / ".managed.lock")
    try:
        file_lock.flock(lock, file_lock.LOCK_EX)
        manifest_path = path.parent / ".managed.json"
        manifest = _read_json_existing(manifest_path, label="Obsidian ownership") or {}
        if path.exists():
            current = hashlib.sha256(_read_source(path.parent, path.name)).hexdigest()
            if manifest.get(path.name) != current:
                return False
        descriptor, temporary = tempfile.mkstemp(prefix=".managed-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content.encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
            replace_file(temporary, path)
            sync_parent(path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        manifest[path.name] = hashlib.sha256(content.encode("utf-8")).hexdigest()
        _atomic_json(manifest_path, manifest)
        return True
    finally:
        os.close(lock)


def generate_obsidian_control_room(
    workspace_dir: Path,
    agent_id: str,
    *,
    metadata_rows: list[dict[str, Any]],
    episodes: list[dict[str, Any]],
    dreams: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
    open_threads: list[dict[str, Any]],
) -> dict[str, Any]:
    """Write replaceable managed views derived from authoritative stores."""
    agent_id = safe_agent_id(agent_id)
    lexical = Path(workspace_dir) / ".plur1bus" / "control-room"
    if any(parent.is_symlink() for parent in (lexical, *lexical.parents)):
        raise ValueError("unsafe Obsidian managed path")
    control_dir = resolve_inside(str(workspace_dir), ".plur1bus", "control-room")
    conflicts_found = []
    def write(path: Path, content: str) -> None:
        if not _write(path, content):
            conflicts_found.append(str(path))
    metadata = []
    for row in metadata_rows:
        try:
            value = json.loads(str(row.get("metadataJson") or "{}"))
        except (TypeError, ValueError):
            value = {}
        metadata.append(value)
    statuses = Counter(str(item.get("status") or "active") for item in metadata)
    categories = Counter(str(item.get("category") or "other") for item in metadata)
    active_threads = [
        item for item in open_threads if str(item.get("status") or "open") == "open"
    ]
    dashboard = [
        "---",
        "tags:",
        "  - plur1bus/control-room",
        f"plur1bus_agent: {agent_id}",
        "---",
        "",
        f"# PLUR1BUS Control Room: {agent_id}",
        "",
        f"Generated: {_utcnow()}",
        "",
        "## Counts",
        "",
        f"- Memories: {len(metadata)}",
        f"- Episodes: {len(episodes)}",
        f"- Dreams: {len(dreams)}",
        f"- Open threads: {len(active_threads)}",
        f"- Contradictions requiring review: {len(contradictions)}",
        "",
        "## Status",
        "",
    ]
    dashboard.extend(f"- {key}: {value}" for key, value in sorted(statuses.items()))
    dashboard.extend(["", "## Categories", ""])
    dashboard.extend(f"- {key}: {value}" for key, value in sorted(categories.items()))
    write(control_dir / "Dashboard.md", "\n".join(dashboard) + "\n")

    bases = (
        "filters:\n"
        "  and:\n"
        "    - 'file.hasTag(\"plur1bus/memory\")'\n"
        f"    - 'file.hasTag(\"plur1bus/agent/{agent_id}\")'\n"
        "views:\n"
        "  - type: table\n"
        "    name: Active memories\n"
        "    order:\n"
        "      - file.name\n"
        "      - category\n"
        "      - status\n"
    )
    write(control_dir / "Memories.base", bases)

    tasks = [
        "---",
        "tags:",
        "  - plur1bus/control-room",
        "---",
        "",
        "# Open Threads",
        "",
    ]
    tasks.extend(
        f"- [ ] {str(item.get('text') or '').replace(chr(10), ' ')[:500]}"
        for item in active_threads
    )
    write(control_dir / "Open Threads.md", "\n".join(tasks) + "\n")

    conflicts = ["# Contradictions Requiring Review", ""]
    conflicts.extend(
        "- `{}` vs `{}` (score {})".format(
            item.get("newMemoryId", ""),
            item.get("existingMemoryId", ""),
            item.get("score", ""),
        )
        for item in contradictions[-100:]
    )
    write(control_dir / "Contradictions.md", "\n".join(conflicts) + "\n")

    weekly = ["# Weekly Memory Synthesis", "", f"Generated: {_utcnow()}", ""]
    weekly.append(f"- Recent episodes: {len(episodes[-50:])}")
    weekly.append(f"- Recent dreams: {len(dreams[-20:])}")
    for dream in dreams[-5:]:
        narrative = str(dream.get("narrative") or "").strip()
        if narrative:
            weekly.append(f"- Dream: {narrative[:500]}")
    write(control_dir / "Weekly Synthesis.md", "\n".join(weekly) + "\n")
    return {
        "generatedAt": _utcnow(),
        "agentId": agent_id,
        "files": [
            str(control_dir / name)
            for name in (
                "Dashboard.md",
                "Memories.base",
                "Open Threads.md",
                "Contradictions.md",
                "Weekly Synthesis.md",
            )
        ],
        "managedOnly": True,
        "conflicts": conflicts_found,
    }
