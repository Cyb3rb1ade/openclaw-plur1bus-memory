"""Lossless, bounded native capture segmentation; no extra model call.

Version one is retained for durable retry plans. Unlike the upstream splitter,
prefixes and short fragments are bundled rather than discarded in parts-only
mode. Original rows and children deliberately have distinct recall group keys.
"""

from __future__ import annotations

import math
import re
import uuid
from typing import Any

_LIST = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")
_HEADING = re.compile(r"^\s*#{1,6}\s+")
_END = re.compile(r"(?<!\d)[.!?…]+(?!\d)(?:\s|$)")
_BOUNDARY = re.compile(r"(?<=[.!?…])\s+(?!\d)")
MAX_PARTS = 20


def _bundle_short(parts: list[str]) -> list[str]:
    result: list[str] = []
    pending = ""
    for part in parts:
        part = (pending + "\n" + part).strip() if pending else part.strip()
        if len(part) < 8:
            pending = part
        else:
            result.append(part)
            pending = ""
    if pending:
        if result:
            result[-1] += "\n" + pending
        else:
            result.append(pending)
    return result


def _structured(text: str, pattern: re.Pattern[str]) -> list[str]:
    # Retain the original marker and prefix: both can carry semantics.
    groups: list[list[str]] = [[]]
    hits = 0
    for line in text.splitlines():
        if pattern.match(line):
            hits += 1
            if groups[-1]:
                groups.append([])
        groups[-1].append(line)
    return _bundle_short(["\n".join(group) for group in groups]) if hits >= 2 else []


def plan_chunks(text: str) -> list[str]:
    """Return at most twenty ordered parts, preserving every non-whitespace token."""
    value = text.strip()
    paragraphs = [p for p in re.split(r"\n\s*\n", value) if p.strip()]
    sentences = max(sum(max(1, len(_END.findall(p))) for p in paragraphs),
                    sum(bool(_LIST.match(line) or _HEADING.match(line)) for line in value.splitlines()))
    if sentences < 4:
        return [value]
    parts = _structured(value, _LIST)
    if len(parts) < 2:
        parts = _structured(value, _HEADING)
    if len(parts) < 2:
        parts = _bundle_short(paragraphs)
    if len(parts) < 2 and sentences >= 8:
        # Match the upstream decimal/version boundary exclusion without a
        # variable-width Python lookbehind.
        parts = []
        for line in value.splitlines():
            start = 0
            for match in _BOUNDARY.finditer(line):
                pos = match.start()
                if pos >= 2 and line[pos - 2].isdigit():
                    continue
                parts.append(line[start:pos])
                start = match.end()
            parts.append(line[start:])
        parts = _bundle_short(parts)
    if len(parts) < 2:
        return [value]
    step = max(1, math.ceil(len(parts) / MAX_PARTS))
    return ["\n".join(parts[i:i + step]) for i in range(0, len(parts), step)]


def capture_options(config: dict[str, Any]) -> dict[str, Any]:
    """Snapshot the splitting mode at admission, not when a delayed retry runs."""
    return {"version": 1, "enabled": config.get("captureChunking") is not False,
            "keepWhole": config.get("captureChunkingMode") != "geteilt"}


def capture_rows(text: str, *, capture_id: str, agent_id: str, scope_key: str,
                 role: str, options: dict[str, Any]) -> list[dict[str, str]]:
    """Derive stable child identities using a validated versioned retry mode."""
    if (not isinstance(options, dict) or set(options) != {"version", "enabled", "keepWhole"}
            or type(options["version"]) is not int or options["version"] != 1
            or type(options["enabled"]) is not bool or type(options["keepWhole"]) is not bool):
        raise ValueError("invalid capture chunking plan")
    namespace = uuid.UUID(capture_id)
    origin = str(uuid.uuid5(namespace, f"{agent_id}:{scope_key}:{role}"))
    parts = plan_chunks(text) if options["enabled"] else [text.strip()]
    if len(parts) < 2:
        return [{"content": text.strip(), "sourceTurnId": origin, "chunkGroupId": "", "id": ""}]
    rows = []
    if options["keepWhole"]:
        rows.append({"content": text.strip(), "id": str(uuid.uuid5(namespace, origin + ":whole")),
                     "sourceTurnId": origin, "chunkGroupId": ""})
    group = str(uuid.uuid5(namespace, origin + ":chunks-v1"))
    for index, part in enumerate(parts):
        rows.append({"content": part, "id": str(uuid.uuid5(namespace, f"{origin}:part-v1:{index}")),
                     "sourceTurnId": origin, "chunkGroupId": group})
    return rows
