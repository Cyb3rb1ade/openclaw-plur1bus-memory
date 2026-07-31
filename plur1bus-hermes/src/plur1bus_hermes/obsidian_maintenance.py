"""Generate managed Obsidian control-room views without touching user notes."""

from __future__ import annotations

import json
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


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
    control_dir = Path(workspace_dir) / ".plur1bus" / "control-room"
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
    _write(control_dir / "Dashboard.md", "\n".join(dashboard) + "\n")

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
    _write(control_dir / "Memories.base", bases)

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
    _write(control_dir / "Open Threads.md", "\n".join(tasks) + "\n")

    conflicts = ["# Contradictions Requiring Review", ""]
    conflicts.extend(
        "- `{}` vs `{}` (score {})".format(
            item.get("newMemoryId", ""),
            item.get("existingMemoryId", ""),
            item.get("score", ""),
        )
        for item in contradictions[-100:]
    )
    _write(control_dir / "Contradictions.md", "\n".join(conflicts) + "\n")

    weekly = ["# Weekly Memory Synthesis", "", f"Generated: {_utcnow()}", ""]
    weekly.append(f"- Recent episodes: {len(episodes[-50:])}")
    weekly.append(f"- Recent dreams: {len(dreams[-20:])}")
    for dream in dreams[-5:]:
        narrative = str(dream.get("narrative") or "").strip()
        if narrative:
            weekly.append(f"- Dream: {narrative[:500]}")
    _write(control_dir / "Weekly Synthesis.md", "\n".join(weekly) + "\n")
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
    }
