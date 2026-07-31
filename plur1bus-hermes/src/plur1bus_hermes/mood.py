"""Persistent per-agent mood with configurable temperament presets."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PRESETS = {
    "balanced": {"sensitivity": 1.0, "decay": 0.75, "baseline": {"joy": 0.1, "trust": 0.15}},
    "warm": {"sensitivity": 1.35, "decay": 0.82, "baseline": {"joy": 0.25, "trust": 0.35}},
    "cool": {"sensitivity": 0.75, "decay": 0.65, "baseline": {"joy": 0.05, "trust": 0.1}},
    "fiery": {"sensitivity": 1.6, "decay": 0.88, "baseline": {"joy": 0.15, "trust": 0.1}},
    "stoic": {"sensitivity": 0.45, "decay": 0.55, "baseline": {"joy": 0.05, "trust": 0.15}},
}
ALIASES = {
    "ausgewogen": "balanced",
    "warm": "warm",
    "kühl": "cool",
    "kuehl": "cool",
    "feurig": "fiery",
    "stoisch": "stoic",
}


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class MoodEngine:
    """Update and persist a bounded mood vector without changing agent identity."""

    def __init__(self, workspace_dir: Path) -> None:
        self.workspace_dir = Path(workspace_dir)
        self.state_path = self.workspace_dir / ".emotional-state.json"
        self.text_path = self.workspace_dir / ".current-mood.txt"

    def state(self) -> dict[str, Any]:
        if self.state_path.is_file():
            try:
                value = json.loads(self.state_path.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    return value
            except (OSError, TypeError, ValueError):
                pass
        return {
            "preset": "balanced",
            "scores": dict(PRESETS["balanced"]["baseline"]),
            "dominant": "neutral",
            "intensity": 0.0,
            "updatedAt": _utcnow(),
        }

    def set_preset(self, preset: str) -> dict[str, Any]:
        normalized = ALIASES.get(str(preset or "").strip().lower(), str(preset or "").strip().lower())
        if normalized not in PRESETS:
            raise ValueError(
                "temperament must be ausgewogen, warm, kühl, feurig, or stoisch"
            )
        state = self.state()
        state["preset"] = normalized
        state["scores"] = dict(PRESETS[normalized]["baseline"])
        state["updatedAt"] = _utcnow()
        self._persist(state)
        return state

    def update(self, emotion: dict[str, Any]) -> dict[str, Any]:
        state = self.state()
        preset_name = str(state.get("preset") or "balanced")
        preset = PRESETS.get(preset_name, PRESETS["balanced"])
        scores = {
            key: float(value) * float(preset["decay"])
            for key, value in dict(state.get("scores") or {}).items()
        }
        dominant = str(emotion.get("dominant") or "neutral")
        intensity = max(0.0, min(1.0, float(emotion.get("intensity") or 0)))
        if dominant != "neutral":
            scores[dominant] = min(
                1.0,
                scores.get(dominant, 0.0)
                + intensity * float(preset["sensitivity"]),
            )
        for key, baseline in dict(preset["baseline"]).items():
            scores[key] = max(scores.get(key, 0.0), float(baseline))
        mood_dominant = max(scores, key=scores.get) if scores else "neutral"
        state.update({
            "scores": scores,
            "dominant": mood_dominant,
            "intensity": round(max(scores.values()) if scores else 0.0, 4),
            "valence": str(emotion.get("valence") or "neutral"),
            "updatedAt": _utcnow(),
        })
        self._persist(state)
        return state

    def _persist(self, state: dict[str, Any]) -> None:
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(state, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.state_path)
        text = (
            f"{state.get('dominant', 'neutral')} "
            f"(intensity={state.get('intensity', 0)}, "
            f"temperament={state.get('preset', 'balanced')})\n"
        )
        temporary_text = self.text_path.with_suffix(".txt.tmp")
        temporary_text.write_text(text, encoding="utf-8")
        os.replace(temporary_text, self.text_path)
