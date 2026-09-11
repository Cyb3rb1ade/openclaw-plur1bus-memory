"""Pure, replay-safe memory-strength transforms for native maintenance."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Iterable, Mapping
from typing import Any


DAY_MS = 86_400_000
MAX_CONSUMED_FEEDBACK_IDS = 10_000
FEEDBACK_ADJUSTMENTS = {
    "positive": 0.1,
    "useful": 0.1,
    "irrelevant": -0.1,
    "negative": -0.25,
    "incorrect": -0.25,
}


def _finite_number(value: Any) -> float | None:
    """Return a finite numeric value, excluding booleans and invalid strings."""
    if isinstance(value, bool):
        return None
    try:
        converted = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return converted if math.isfinite(converted) else None


def _canonical_event(event: Mapping[str, Any]) -> str:
    """Return stable canonical JSON for an untrusted legacy feedback event."""
    return json.dumps(
        dict(event),
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def index_feedback_events(
    events: Iterable[Mapping[str, Any]],
) -> dict[str, list[tuple[str, Mapping[str, Any]]]]:
    """Group feedback by card and derive stable, occurrence-aware identities."""
    grouped: dict[str, list[tuple[str, Mapping[str, Any]]]] = {}
    occurrences: dict[str, int] = {}
    for raw in events:
        event = dict(raw)
        memory_id = str(event.get("memoryId") or "").strip()
        if not memory_id:
            continue
        explicit = next(
            (
                str(event.get(name)).strip()
                for name in ("id", "feedbackId", "eventId")
                if event.get(name) is not None and str(event.get(name)).strip()
            ),
            "",
        )
        if explicit:
            identity_material = f"explicit:{explicit}"
        else:
            canonical = _canonical_event(event)
            occurrence = occurrences.get(canonical, 0)
            occurrences[canonical] = occurrence + 1
            identity_material = f"legacy:{canonical}:{occurrence}"
        identity = "sha256:" + hashlib.sha256(identity_material.encode("utf-8")).hexdigest()
        grouped.setdefault(memory_id, []).append((identity, event))
    return grouped


def transform_metadata(
    metadata: Mapping[str, Any],
    feedback: Iterable[tuple[str, Mapping[str, Any]]],
    *,
    now_ms: int,
) -> dict[str, Any]:
    """Return a new metadata object with decay and unseen feedback applied once."""
    result = dict(metadata)
    raw_strength = _finite_number(metadata.get("memoryStrength"))
    strength = 1.0 if raw_strength is None else max(0.0, min(1.0, raw_strength))
    zero_is_absorbing = strength == 0.0

    raw_half_life = _finite_number(metadata.get("halfLifeDays"))
    half_life_days = 30.0 if raw_half_life is None else max(1.0, raw_half_life)
    timestamp = None
    for name in ("lastDynamicsAt", "updatedAt", "sourceTimestamp"):
        candidate = _finite_number(metadata.get(name))
        if candidate is not None and candidate > 0:
            timestamp = candidate
            break
    if timestamp is None:
        timestamp = float(now_ms)
    elapsed_days = max(0.0, (float(now_ms) - timestamp) / DAY_MS)
    strength *= math.pow(0.5, elapsed_days / half_life_days)

    existing = metadata.get("dynamicsConsumedFeedbackIds")
    consumed: list[str] = []
    seen: set[str] = set()
    if isinstance(existing, list):
        for value in existing:
            identity = str(value)
            if identity and identity not in seen:
                seen.add(identity)
                consumed.append(identity)
    cap_reached = len(consumed) >= MAX_CONSUMED_FEEDBACK_IDS
    applied = 0
    skipped_feedback = 0
    for identity, event in feedback:
        if identity in seen:
            continue
        if cap_reached or len(consumed) >= MAX_CONSUMED_FEEDBACK_IDS:
            cap_reached = True
            skipped_feedback += 1
            continue
        adjustment = FEEDBACK_ADJUSTMENTS.get(str(event.get("feedback") or "").strip().lower())
        if adjustment is None:
            continue
        consumed.append(identity)
        seen.add(identity)
        applied += 1
        if not zero_is_absorbing:
            strength += adjustment

    result["memoryStrength"] = 0.0 if zero_is_absorbing else max(0.0, min(1.0, strength))
    result["lastDynamicsAt"] = int(now_ms)
    if consumed or isinstance(existing, list):
        result["dynamicsConsumedFeedbackIds"] = consumed
    return {
        "metadata": result,
        "appliedFeedback": applied,
        "skippedFeedback": skipped_feedback,
        "feedbackCapReached": cap_reached,
        "changed": result != dict(metadata),
    }
