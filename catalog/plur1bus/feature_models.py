"""Agent-scoped internal model selection with explicit transport ownership.

An override selects a registered route, never substitutes a provider-qualified
name into another provider's endpoint with that provider's credentials.
"""
from __future__ import annotations

import copy
import re
from typing import Any

MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}\Z")
FEATURE_PATHS = {
    "merging": ("merging",), "capture-summary": (), "recall-query-summary": (),
    "memory-compaction": (), "conflict-resolution": (), "rem-pattern-analysis": (),
    "conversation-insights": (), "dream-narrative": (), "dream-echo": (),
    "episode-extraction": (), "afterthought": ("afterthought",),
    "persona-voice": ("personaVoice",), "wiki": (),
    "continuity-overlay": ("continuityEngine", "overlays"),
    "overlay-audit-contradiction": (), "memory-text-contradiction": (),
    "emotionT3": ("emotion", "t3"), "emotion-encoding": ("emotion", "t3"),
    "schicht15": ("schicht15",), "skillMiner": ("skillMiner",),
    "criticalPush": ("criticalPush",),
}
PURPOSE_FEATURE = {
    "merge-decision": "merging", "query-refinement": "recall-query-summary",
    "memory-encoding": "emotion-encoding", "emotion-classification": "emotionT3",
    "skill-workshop-mining": "skillMiner", "skill-workshop-benefit-backfill": "skillMiner",
    "light-dream": "rem-pattern-analysis", "meta-reflection": "conversation-insights",
    "reminder-extraction": "conversation-insights",
}
ROUTE_FIELDS = frozenset({"provider", "model", "baseUrl", "apiKey", "apiKeyEnv", "timeoutSeconds", "requestExtra"})


def _object(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _model(value: Any) -> str | None:
    return value if isinstance(value, str) and MODEL_ID.fullmatch(value) else None


def configured_routes(config: dict) -> dict[str, dict]:
    """Return an internal catalogue; never expose these credential-bearing values."""
    base = _object(config.get("llm"))
    result = {}
    if _model(base.get("model")):
        result[base["model"]] = copy.deepcopy(base)
    for name, route in _object(_object(config.get("llmRouter")).get("modelRoutes")).items():
        if not _model(name) or not isinstance(route, dict) or not _model(route.get("model")):
            continue
        # A named route is self-contained. In particular, never inherit the
        # default endpoint's secret into a different endpoint.
        if not route.get("baseUrl") and route.get("provider") != "omlx":
            continue
        result[name] = copy.deepcopy({key: value for key, value in route.items() if key in ROUTE_FIELDS})
    return result


def resolve_feature_route(config: dict, base: dict, agent_id: str, purpose: str) -> dict:
    """Resolve task > agent default > feature-local route > shared native route."""
    feature = PURPOSE_FEATURE.get(purpose, purpose)
    if feature not in FEATURE_PATHS:
        return copy.deepcopy(base)
    router = _object(config.get("llmRouter"))
    overrides = _object(_object(router.get("agentModels")).get(agent_id))
    selected = _model(overrides.get(feature)) or _model(overrides.get("*"))
    if selected:
        catalog = configured_routes(config)
        if selected not in catalog:
            raise ValueError("selected internal model has no registered transport")
        return catalog[selected]
    local = config
    for part in FEATURE_PATHS[feature]:
        local = _object(local.get(part))
    if FEATURE_PATHS[feature] and _model(local.get("model")):
        # Model-only local settings can select a registered catalogue entry.
        if local.get("baseUrl"):
            return copy.deepcopy({key: value for key, value in local.items() if key in ROUTE_FIELDS})
        catalog = configured_routes(config)
        if local["model"] in catalog:
            return catalog[local["model"]]
        raise ValueError("feature-local internal model has no registered transport")
    return copy.deepcopy(base)
