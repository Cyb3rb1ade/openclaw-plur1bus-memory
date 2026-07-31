"""Bounded semantic input preparation for long memory commands."""

from __future__ import annotations

import re
from typing import Any


def prepare_semantic_input(
    text: str,
    *,
    compress_after: int = 6_000,
    require_source_after: int = 100_000,
) -> dict[str, Any]:
    """Preserve short input and deterministically compress oversized semantic queries."""
    value = str(text or "").strip()
    if len(value) > require_source_after:
        return {
            "text": "",
            "compressed": False,
            "requiresSource": True,
            "originalLength": len(value),
            "message": "Input exceeds 100k characters; use a workspace or vault source file.",
        }
    if len(value) <= compress_after:
        return {
            "text": value,
            "compressed": False,
            "requiresSource": False,
            "originalLength": len(value),
        }
    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", value)
        if sentence.strip()
    ]
    selected = []
    seen = set()
    for sentence in sentences:
        normalized = re.sub(r"\s+", " ", sentence.lower())
        if normalized in seen:
            continue
        seen.add(normalized)
        selected.append(sentence)
        if sum(len(item) + 1 for item in selected) >= compress_after:
            break
    compressed = "\n".join(selected)[:compress_after]
    return {
        "text": compressed,
        "compressed": True,
        "requiresSource": False,
        "originalLength": len(value),
    }
