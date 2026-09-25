"""Aggregate character budget across injectable context blocks.

Port of the upstream 7.4.0 ``lib/inject-budget.js``: the joined context is
capped at ``max_chars``; droppable blocks are sacrificed from the last one
backwards while non-droppable structural blocks always survive. Memory
content is what yields, never priorities, ordering, or safety markers.
"""

from __future__ import annotations

from typing import Any

_TRIM_MARGIN = 8
TRUNCATION_MARKER = "\n<!-- memory context truncated -->"


def trim_memory_items(items: list[str], max_chars: object) -> str:
    """Keep only complete native memory records; never split text or markup."""
    text = "\n".join(items)
    if type(max_chars) not in (int, float) or not 0 < max_chars < float("inf"):
        return text
    if len(text) <= max_chars:
        return text
    kept = []
    size = len(TRUNCATION_MARKER)
    for item in items:
        needed = len(item) + bool(kept)
        if size + needed > int(max_chars):
            break
        kept.append(item)
        size += needed
    return "\n".join(kept) + TRUNCATION_MARKER if kept else ""


def apply_global_inject_budget(
    *,
    blocks: list[dict[str, Any]] | None = None,
    max_chars: object = None,
) -> str:
    """Join ``blocks`` with blank lines, capped at ``max_chars`` characters.

    Blocks are ``{"name": str, "text": str, "droppable": bool}``. A non-positive
    or non-numeric ``max_chars`` disables the cap (mirrors the upstream guard).
    """
    parts = [
        {
            "name": str((block or {}).get("name") or ""),
            "text": str((block or {}).get("text") or ""),
            "droppable": (block or {}).get("droppable") is True,
            "items": (block or {}).get("items"),
        }
        for block in (blocks or [])
    ]
    parts = [block for block in parts if block["text"]]
    join = lambda items: "\n\n".join(block["text"] for block in items)
    try:
        cap = float(max_chars)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        cap = 0.0
    if cap != cap or cap <= 0 or cap == float("inf"):
        return join(parts)
    cap_int = int(cap)
    current = list(parts)
    while len(join(current)) > cap_int:
        droppable = [index for index, block in enumerate(current) if block["droppable"]]
        if not droppable:
            break
        index = droppable[-1]
        block = current[index]
        overflow = len(join(current)) - cap_int
        if len(block["text"]) <= overflow + _TRIM_MARGIN:
            current.pop(index)
            continue
        allowed = max(0, len(block["text"]) - overflow - _TRIM_MARGIN)
        # Native memories carry complete record boundaries. Structured overlays
        # have no safe partial boundary, so drop the whole block on overflow.
        if isinstance(block["items"], list):
            trimmed = trim_memory_items(block["items"], allowed)
        elif "<" in block["text"]:
            trimmed = ""
        else:
            trimmed = block["text"][:allowed]
        current[index] = {**block, "text": trimmed}
    return join(current)
