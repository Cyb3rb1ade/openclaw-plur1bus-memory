"""Aggregate character budget across injectable context blocks.

Port of the upstream 7.4.0 ``lib/inject-budget.js``: the joined context is
capped at ``max_chars``; droppable blocks are sacrificed from the last one
backwards while non-droppable structural blocks always survive. Memory
content is what yields, never priorities, ordering, or safety markers.
"""

from __future__ import annotations

from typing import Any

_TRIM_MARGIN = 8


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
        current[index] = {**block, "text": block["text"][: max(0, len(block["text"]) - overflow - _TRIM_MARGIN)]}
    return join(current)
