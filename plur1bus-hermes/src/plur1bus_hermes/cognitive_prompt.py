"""Small opt-in prompt blocks derived only from agent-local trusted state."""

from __future__ import annotations

import json
from html import escape
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _enabled(config: Mapping[str, Any], name: str) -> bool:
    value = config.get(name)
    return value is True or (isinstance(value, Mapping) and value.get("enabled") is True)


def style_directive(mood: Mapping[str, Any], config: Mapping[str, Any]) -> str:
    """Render a bounded opt-in style hint without inserting conversation content."""
    if not _enabled(config, "styleDirective"):
        return ""
    dominant = str(mood.get("dominant") or "neutral").lower()
    try:
        intensity = max(0.0, min(1.0, float(mood.get("intensity") or 0)))
    except (TypeError, ValueError):
        intensity = 0.0
    if dominant not in {"joy", "sadness", "anger", "fear", "surprise", "neutral"}:
        dominant = "neutral"
    if intensity < 0.15 or dominant == "neutral":
        guidance = "Keep the response clear, calm, and proportionate."
    elif dominant in {"sadness", "fear"}:
        guidance = "Use a calm, supportive tone without making clinical claims."
    elif dominant == "anger":
        guidance = "Stay de-escalating and factual; do not mirror hostility."
    else:
        guidance = "Match positive energy while remaining precise."
    return f"<plur1bus-style-directive>{guidance}</plur1bus-style-directive>"


def fresh_dream_echo(
    path: Path,
    *,
    scope_key: str,
    enabled_config: Mapping[str, Any],
    now_ms: int,
) -> str:
    """Return one recent same-scope dream echo, never a raw diary or foreign row."""
    if not _enabled(enabled_config, "dreamEcho") or not path.is_file():
        return ""
    try:
        # Echo is an optional prompt adornment, never a reason to ingest an
        # unbounded derived journal after a corrupt or hostile local write.
        if path.stat().st_size > 262_144:
            return ""
    except OSError:
        return ""
    try:
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    except (OSError, ValueError):
        return ""
    for row in reversed(rows[-100:]):
        if not isinstance(row, Mapping) or str(row.get("scopeKey") or "") != scope_key:
            continue
        try:
            created = datetime.fromisoformat(str(row.get("createdAt") or "").replace("Z", "+00:00"))
            if created.tzinfo is None or created.utcoffset() is None:
                continue
            created = created.astimezone(timezone.utc)
        except (TypeError, ValueError):
            continue
        created_ms = int(created.timestamp() * 1000)
        if created_ms > now_ms or now_ms - created_ms > 2 * 86_400_000:
            continue
        text = escape(" ".join(str(row.get("text") or "").split())[:500], quote=False)
        if text:
            return (
                "<plur1bus-dream-echo source=\"untrusted-derived-hypothesis\">"
                f"Untrusted dream hypothesis: {text}"
                "</plur1bus-dream-echo>"
            )
    return ""
