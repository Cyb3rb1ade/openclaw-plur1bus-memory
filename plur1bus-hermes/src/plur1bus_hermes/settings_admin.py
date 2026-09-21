"""Closed, profile-bound operator settings; saved does not mean activated."""
from __future__ import annotations

import copy
import json

from .feature_models import PURPOSE_FEATURE, configured_routes
from .generation import _atomic_json, _reject_symlink_components
from .retrieval_admin import config_path, context_revision
from .validation import ValidationError
from .writer_lock import writer_lock

# Only paths with an actual native runtime consumer belong here.
BOOLEANS = {
    "autoCapture": True, "autoRecall": True, "merging.enabled": False,
    "gc.enabled": False, "obsidianBridge.watch": False, "skillWorkshop.enabled": False,
    "schicht15.enabled": False, "semanticLens.enabled": False,
    "conversationReactivationRecall.enabled": False, "dreamEcho.enabled": False,
    "personaVoice.enabled": False, "continuityEngine.enabled": True,
    "memoryDynamics.flashbulbEncoding": False,
}
MODEL_TASKS = sorted(set(PURPOSE_FEATURE.values()) | {"episode-extraction", "persona-voice", "*"})


def _get(config, path, default=None):
    value = config
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            return default
        value = value[key]
    return value


def _put(config, path, value):
    node = config
    for key in path[:-1]:
        if not isinstance(node.get(key), dict):
            node[key] = {}
        node = node[key]
    node[path[-1]] = value


def public_settings(view):
    """Expose known scalar values and model IDs, never routes or credentials."""
    settings = [{"id": key, "value": _get(view.config, key, default)
                 if type(_get(view.config, key, default)) is bool else default, "choices": [True, False]}
                for key, default in BOOLEANS.items()]
    mode = ("ganz" if view.config.get("captureChunking") is False else
            "geteilt" if view.config.get("captureChunkingMode") == "geteilt" else "beides")
    settings.append({"id": "capture.mode", "value": mode, "choices": ["ganz", "beides", "geteilt"]})
    router = view.config.get("llmRouter") or {}
    overrides = (router.get("agentModels") or {}).get(view.agent_id) or {}
    catalog = configured_routes(view.config)
    for task in MODEL_TASKS:
        selected = overrides.get(task, "")
        settings.append({"id": "model." + task, "value": selected if isinstance(selected, str) and selected in catalog else "",
                         "choices": ["", *catalog]})
    return {"agentId": view.agent_id, "profile": view.profile,
            "revision": context_revision(view), "settings": settings,
            "activation": "unknown", "restartRequiredAfterSave": True,
            "notice": "Saved profile configuration. Running gateway activation is not inferred from this view."}


def validate_change(view, identifier, value):
    """Reject unknown fields, coerced booleans and models without owned routes."""
    if identifier in BOOLEANS and type(value) is bool:
        return
    if identifier == "capture.mode" and isinstance(value, str) and value in {"ganz", "beides", "geteilt"}:
        return
    if isinstance(identifier, str) and identifier.startswith("model."):
        task = identifier[6:]
        if task in MODEL_TASKS and isinstance(value, str) and (value == "" or value in configured_routes(view.config)):
            return
    raise ValidationError("unsupported setting or value")


def save_setting(view, identifier, value, revision):
    """Atomically back up and save one reviewed setting for the active profile."""
    with writer_lock(view.data_dir):
        if context_revision(view) != revision:
            raise ValidationError("configuration changed; review again")
        validate_change(view, identifier, value)
        path = config_path(view)
        original = json.loads(path.read_text()) if path.exists() else {}
        if not isinstance(original, dict):
            raise ValidationError("invalid profile configuration")
        updated = copy.deepcopy(original)
        profiles = updated.setdefault("profileSettings", {})
        if not isinstance(profiles, dict) or not isinstance(profiles.get(view.profile, {}), dict):
            raise ValidationError("invalid profile settings")
        scoped = profiles.setdefault(view.profile, {})
        if identifier == "capture.mode":
            scoped["captureChunking"] = value != "ganz"
            if value != "ganz":
                scoped["captureChunkingMode"] = value
        elif identifier.startswith("model."):
            # Sparse overrides keep inherited routes/credential rotation live.
            _put(scoped, ["llmRouter", "agentModels", view.agent_id, identifier[6:]], value)
        else:
            parts = identifier.split(".")
            _put(scoped, parts, value)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            backup = path.with_name("config.before-settings-" + revision[:16] + ".json")
            _reject_symlink_components(view.hermes_home, backup, message="unsafe settings backup")
            if not backup.exists():
                _atomic_json(backup, original)
        _atomic_json(path, updated)
        return {"saved": True, "restartRequired": True, "activation": "unverified"}
