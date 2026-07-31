"""Bounded REM-dream synthesis with a deterministic local fallback."""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from .cognition import contradiction_score


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tokens(text: str) -> set[str]:
    return {
        word
        for word in re.findall(r"[\wäöüß-]+", text.lower())
        if len(word) >= 4
    }


def build_rem_dream(
    rows: list[dict[str, Any]],
    agent_id: str,
    *,
    max_associations: int = 8,
) -> dict[str, Any]:
    """Build a transparent REM dream from bounded active-memory associations."""
    memories = [
        {
            "id": str(row.get("id") or ""),
            "text": str(row.get("content") or "").strip(),
        }
        for row in rows
        if str(row.get("content") or "").strip()
    ]
    associations = []
    for index, first in enumerate(memories):
        first_tokens = _tokens(first["text"])
        for second in memories[index + 1:]:
            second_tokens = _tokens(second["text"])
            union = first_tokens | second_tokens
            similarity = len(first_tokens & second_tokens) / max(1, len(union))
            contradiction = contradiction_score(first["text"], second["text"])
            if similarity >= 0.08 or contradiction:
                associations.append({
                    "source": first["id"],
                    "target": second["id"],
                    "similarity": round(similarity, 4),
                    "contradiction": contradiction,
                })
    associations.sort(
        key=lambda item: (item["contradiction"], item["similarity"]),
        reverse=True,
    )
    associations = associations[:max_associations]
    activated = [memory["id"] for memory in memories]
    strengthened = []
    for association in associations:
        for memory_id in (association["source"], association["target"]):
            if memory_id and memory_id not in strengthened:
                strengthened.append(memory_id)
    insights = [memory["text"].splitlines()[0][:300] for memory in memories[:6]]
    contradictions = [
        association for association in associations if association["contradiction"] > 0
    ]
    narrative = (
        f"REM synthesis connected {len(associations)} associations across "
        f"{len(memories)} active memories."
    )
    if contradictions:
        narrative += f" {len(contradictions)} possible contradiction(s) require review."
    return {
        "id": str(uuid.uuid4()),
        "type": "rem_dream",
        "agentId": agent_id,
        "createdAt": _utcnow(),
        "phases": ["activation", "association", "synthesis", "integration"],
        "insights": insights,
        "narrative": narrative,
        "associations": associations,
        "contradictions": contradictions,
        "activatedMemoryIds": activated,
        "strengthenedMemoryIds": strengthened[: max(1, len(activated) // 2)],
        "destructiveChanges": False,
        "hasError": False,
        "generator": "deterministic-local-fallback",
    }
