"""Atomic PLUR1BUS feature profiles and whitelisted config toggles."""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TOGGLES = {
    "vaultSync": ("obsidianBridge", "enabled"),
    "kritischPush": ("criticalPush", "enabled"),
    "dailyConsolidation": ("dailyConsolidation", "enabled"),
    "autoCapture": ("autoCapture",),
    "autoRecall": ("autoRecall",),
    "conversationReactivationRecall": ("conversationReactivationRecall", "enabled"),
    "semanticLens": ("semanticLens", "enabled"),
    "styleDirective": ("styleDirective", "enabled"),
    "dreamEcho": ("dreamEcho", "enabled"),
}


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def profile_choices() -> dict[str, Any]:
    return {
        "safe": {
            "description": "Core capture and recall; advanced mutators remain off.",
            "advancedDefault": False,
        },
        "recommended": {
            "description": "Enable advanced features while retaining safety gates.",
            "advancedDefault": True,
        },
    }


def _write_config(path: Path, config: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        backup = path.with_name(
            path.name + ".bak." + datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        )
        shutil.copy2(path, backup)
        os.chmod(backup, 0o600)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def apply_profile(path: Path, profile: str) -> dict[str, Any]:
    """Apply an explicit profile while preserving authored false opt-outs."""
    if profile not in {"safe", "recommended"}:
        raise ValueError("profile must be safe or recommended")
    config = (
        json.loads(path.read_text(encoding="utf-8"))
        if path.is_file()
        else {}
    )
    advanced = profile == "recommended"
    feature_sections = (
        "criticalPush",
        "dailyConsolidation",
        "merging",
        "afterthought",
        "proactive",
        "codeIndex",
    )
    for section in feature_sections:
        current = config.setdefault(section, {})
        if profile == "safe":
            current["enabled"] = False
        elif "enabled" not in current:
            current["enabled"] = advanced
    obsidian = config.setdefault("obsidianBridge", {})
    if profile == "safe":
        obsidian["enabled"] = False
    elif "enabled" not in obsidian:
        obsidian["enabled"] = True
    obsidian.setdefault("mode", "augment")
    config.setdefault("merging", {})["autoApply"] = False
    config["setupProfile"] = profile
    config["featuresConfirmedAt"] = _utcnow()
    _write_config(path, config)
    return config


def set_feature(path: Path, feature: str, enabled: bool) -> dict[str, Any]:
    """Set one allowlisted feature toggle atomically."""
    if feature not in TOGGLES:
        raise ValueError(
            "feature must be vaultSync, kritischPush, or dailyConsolidation"
        )
    config = (
        json.loads(path.read_text(encoding="utf-8"))
        if path.is_file()
        else {}
    )
    toggle_path = TOGGLES[feature]
    if len(toggle_path) == 1:
        config[toggle_path[0]] = bool(enabled)
    else:
        section, key = toggle_path
        config.setdefault(section, {})[key] = bool(enabled)
    config["featuresUpdatedAt"] = _utcnow()
    _write_config(path, config)
    return {
        "feature": feature,
        "enabled": bool(enabled),
        "restartRequired": True,
    }
